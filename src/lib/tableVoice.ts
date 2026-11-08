// The online table's walkie-talkie: hold to talk, one person at a time.
//
// Holding the button opens the microphone and asks the table for the floor
// (worker/src/table.ts); once it's granted, 100 ms frames go up the table's
// own connection and the table passes them to everyone else, stored nowhere.
// The microphone is on only while the button is down.

import { VOICE_FRAME_SAMPLES, VOICE_MAX_MS, VOICE_QUIET_MS, VOICE_SAMPLE_RATE } from "@mjwaits/shared/protocol/limits";
import type { TableClientMessage } from "@mjwaits/shared/protocol/table";
import { decodeAdpcm, encodeAdpcm, fromBase64, newAdpcmState, toBase64 } from "./adpcm";
import { madeAudio, wakeAudio } from "./sound";

// ---- The sums ---------------------------------------------------------------------

// Takes the microphone's samples, at whatever rate the phone runs, down to
// whole frames at the wire's rate (each output sample the average of the
// inputs it covers).
export class Downsampler {
  private readonly stride: number;
  private readonly onFrame: (frame: Int16Array) => void;
  private at = 0;
  private sum = 0;
  private count = 0;
  private frame = new Int16Array(VOICE_FRAME_SAMPLES);
  private filled = 0;

  constructor(rate: number, onFrame: (frame: Int16Array) => void) {
    this.stride = rate / VOICE_SAMPLE_RATE;
    this.onFrame = onFrame;
  }

  push(input: Float32Array) {
    for (const x of input) {
      this.sum += x;
      this.count++;
      this.at += 1;
      if (this.at < this.stride) continue;
      this.at -= this.stride;
      const v = Math.max(-1, Math.min(1, this.sum / this.count));
      this.sum = 0;
      this.count = 0;
      this.frame[this.filled++] = Math.round(v * 32767);
      if (this.filled === this.frame.length) {
        this.onFrame(this.frame);
        this.frame = new Int16Array(VOICE_FRAME_SAMPLES);
        this.filled = 0;
      }
    }
  }
}

// Takes frames back up to the speaker's rate, joining each to the last so
// the seams between frames don't tick.
export class Upsampler {
  private readonly stride: number;
  private last = 0;
  private at = 0;

  constructor(rate: number) {
    this.stride = VOICE_SAMPLE_RATE / rate;
  }

  push(input: Int16Array): Float32Array {
    // (One spare: adding up the fractions can land a sample either side.)
    const out = new Float32Array(Math.ceil((input.length - this.at) / this.stride) + 1);
    let n = 0;
    let p = this.at;
    for (; p < input.length; p += this.stride) {
      const i = Math.floor(p);
      const a = i === 0 ? this.last : input[i - 1];
      out[n++] = (a + (input[i] - a) * (p - i)) / 32768;
    }
    this.at = p - input.length;
    if (input.length) this.last = input[input.length - 1];
    return out.subarray(0, n);
  }
}

// ---- The speaker -------------------------------------------------------------------

// A little kept in hand so a late frame doesn't leave a gap; too far behind
// and frames are skipped to catch up.
const LEAD_S = 0.2;
const MAX_BEHIND_S = 1;

export interface VoicePlayer {
  play(frame: Int16Array): void;
  reset(): void;
}

class WebAudioPlayer implements VoicePlayer {
  private nextAt = 0;
  private up: Upsampler | null = null;

  reset() {
    this.nextAt = 0;
    this.up = null;
  }

  play(frame: Int16Array) {
    const ctx = madeAudio();
    if (!ctx) return;
    if (ctx.state !== "running") {
      void ctx.resume();
      return;
    }
    const now = ctx.currentTime;
    if (this.nextAt < now + 0.02) this.nextAt = now + LEAD_S;
    else if (this.nextAt > now + MAX_BEHIND_S) return;
    this.up ??= new Upsampler(ctx.sampleRate);
    const samples = this.up.push(frame);
    if (!samples.length) return;
    const buffer = ctx.createBuffer(1, samples.length, ctx.sampleRate);
    buffer.copyToChannel(new Float32Array(samples), 0);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    source.start(this.nextAt);
    this.nextAt += buffer.duration;
  }
}

// ---- The microphone ----------------------------------------------------------------

export interface Mic {
  stop(): void;
}
export type OpenMic = (onSamples: (samples: Float32Array, rate: number) => void) => Promise<Mic>;

// (From a string, so it needs nothing from the build or the service worker.)
const CAPTURE_WORKLET = `
class MjVoiceCapture extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(1024); this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) for (let i = 0; i < ch.length; i++) {
      this.buf[this.n++] = ch[i];
      if (this.n === this.buf.length) { this.port.postMessage(this.buf.slice()); this.n = 0; }
    }
    return true;
  }
}
registerProcessor("mj-voice-capture", MjVoiceCapture);
`;

const workletReady = new WeakMap<AudioContext, Promise<void>>();
function loadWorklet(ctx: AudioContext): Promise<void> {
  let ready = workletReady.get(ctx);
  if (!ready) {
    const url = URL.createObjectURL(new Blob([CAPTURE_WORKLET], { type: "application/javascript" }));
    ready = ctx.audioWorklet.addModule(url).finally(() => URL.revokeObjectURL(url));
    workletReady.set(ctx, ready);
  }
  return ready;
}

const openPhoneMic: OpenMic = async (onSamples) => {
  const ctx = madeAudio();
  if (!ctx) throw new Error("no audio");
  if (!navigator.mediaDevices?.getUserMedia) throw new DOMException("no microphone here", "NotSupportedError");
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  const closeStream = () => stream.getTracks().forEach((t) => t.stop());
  try {
    await loadWorklet(ctx);
    if (ctx.state !== "running") await ctx.resume();
  } catch (e) {
    closeStream();
    throw e;
  }
  const source = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, "mj-voice-capture", { numberOfOutputs: 1, outputChannelCount: [1] });
  // (Joined to the output, silently, so the browser keeps it running.)
  const silent = ctx.createGain();
  silent.gain.value = 0;
  node.port.onmessage = (e: MessageEvent<Float32Array>) => onSamples(e.data, ctx.sampleRate);
  source.connect(node);
  node.connect(silent);
  silent.connect(ctx.destination);
  return {
    stop() {
      node.port.onmessage = null;
      source.disconnect();
      node.disconnect();
      silent.disconnect();
      closeStream();
      // An iPhone can leave the audio stopped when the microphone closes.
      if (ctx.state !== "running") void ctx.resume();
    },
  };
};

function micProblem(e: unknown): string {
  const name = e instanceof DOMException ? e.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") return "Microphone is blocked - allow it in your phone's Settings";
  if (name === "NotSupportedError") return "Voice isn't available on this page";
  if (name === "NotFoundError") return "No microphone found";
  return "Couldn't open the microphone";
}

// ---- Who's talking -----------------------------------------------------------------

export type MicState = "idle" | "opening" | "waiting" | "live";

export interface VoiceView {
  mine: MicState;
  talking: number | null; // the table seat with the floor
  muted: string[]; // the people this phone won't play
}

// What the voice needs of the table's connection.
export interface VoiceLink {
  code: string;
  send(msg: Extract<TableClientMessage, { t: "talk" | "voice" }>): string | false;
  backlog(): number; // bytes still waiting to go
  seat(): number | null; // this phone's seat
  person(seat: number): string | null; // who's in a seat
}

const MUTED_KEY = "mjwaits.voiceMuted";
// Frames held while the table answers (a second of them).
const MAX_QUEUED = 10;
// A connection this far behind drops frames rather than falling further back.
const MAX_BACKLOG = 32 * 1024;

function loadMuted(code: string): Set<string> {
  try {
    const saved = JSON.parse(localStorage.getItem(MUTED_KEY) ?? "null") as { code: string; ids: string[] } | null;
    return new Set(saved?.code === code ? saved.ids : []);
  } catch {
    return new Set();
  }
}

export class TableVoice {
  private readonly link: VoiceLink;
  private readonly onChange: (view: VoiceView) => void;
  private readonly onProblem: (text: string) => void;
  private readonly openMic: OpenMic;
  private readonly player: VoicePlayer;
  private readonly muted: Set<string>;
  private mine: MicState = "idle";
  private talking: number | null = null;
  private mic: Mic | null = null;
  private attempt = 0; // a new one each press and release: an answer for an old one is dropped
  private queued: string[] = [];
  private limit: ReturnType<typeof setTimeout> | null = null;
  private quiet: ReturnType<typeof setTimeout> | null = null;

  constructor(link: VoiceLink, onChange: (view: VoiceView) => void, onProblem: (text: string) => void, parts: { openMic?: OpenMic; player?: VoicePlayer } = {}) {
    this.link = link;
    this.onChange = onChange;
    this.onProblem = onProblem;
    this.openMic = parts.openMic ?? openPhoneMic;
    this.player = parts.player ?? new WebAudioPlayer();
    this.muted = loadMuted(link.code);
  }

  get view(): VoiceView {
    return { mine: this.mine, talking: this.talking, muted: [...this.muted] };
  }

  private emit() {
    this.onChange(this.view);
  }

  private setMine(mine: MicState) {
    this.mine = mine;
    this.emit();
  }

  // The button went down. (From the tap itself: an iPhone only wakes audio then.)
  press() {
    wakeAudio();
    const me = this.link.seat();
    if (me === null || this.mine !== "idle" || (this.talking !== null && this.talking !== me)) return;
    const attempt = ++this.attempt;
    this.setMine("opening");
    void this.open(attempt);
  }

  private async open(attempt: number) {
    let down: Downsampler | null = null;
    const coder = newAdpcmState();
    const onFrame = (frame: Int16Array) => this.frame(toBase64(encodeAdpcm(frame, coder)));
    let mic: Mic;
    try {
      mic = await this.openMic((samples, rate) => {
        down ??= new Downsampler(rate, onFrame);
        down.push(samples);
      });
    } catch (e) {
      if (attempt !== this.attempt) return;
      this.onProblem(micProblem(e));
      this.setMine("idle");
      return;
    }
    // Let go while it was opening (the first time, asking permission): nothing goes out.
    if (attempt !== this.attempt) return mic.stop();
    this.mic = mic;
    if (this.link.send({ t: "talk", on: true }) === false) {
      this.onProblem("Not connected - wait a moment");
      this.finish(false);
      return;
    }
    this.setMine("waiting");
  }

  private frame(a: string) {
    if (this.mine === "waiting") {
      if (this.queued.length < MAX_QUEUED) this.queued.push(a);
    } else if (this.mine === "live") this.transmit(a);
  }

  private transmit(a: string) {
    if (this.link.backlog() <= MAX_BACKLOG) this.link.send({ t: "voice", a });
  }

  // The button came up (or something else ended the turn).
  release() {
    if (this.mine !== "idle") this.finish(this.mine === "waiting" || this.mine === "live");
  }

  private finish(tellTable: boolean) {
    this.attempt++;
    if (this.limit) clearTimeout(this.limit);
    this.limit = null;
    this.mic?.stop();
    this.mic = null;
    this.queued = [];
    if (tellTable) this.link.send({ t: "talk", on: false });
    this.setMine("idle");
  }

  // The table says who has the floor now.
  onTalking(seat: number | null) {
    if (seat !== this.talking) this.player.reset();
    this.talking = seat;
    if (seat !== null && seat === this.link.seat()) {
      if (this.mine === "waiting") {
        const queued = this.queued;
        this.queued = [];
        this.mine = "live";
        queued.forEach((a) => this.transmit(a));
        this.limit = setTimeout(() => this.release(), VOICE_MAX_MS);
      }
    } else if (this.mine === "waiting" || this.mine === "live") {
      // Someone else got there first, or this turn has been ended for us.
      this.finish(false);
    }
    this.watch();
    this.emit();
  }

  // Sound from whoever has the floor.
  onVoice(seat: number, a: string) {
    if (seat === this.link.seat()) return;
    if (seat !== this.talking) {
      this.player.reset();
      this.talking = seat;
      this.emit();
    }
    this.watch();
    const person = this.link.person(seat);
    if (person && this.muted.has(person)) return;
    try {
      this.player.play(decodeAdpcm(fromBase64(a)));
    } catch {
      // Not base64: nothing to play.
    }
  }

  // A talker whose phone has gone quiet doesn't stay "talking" here for good.
  private watch() {
    if (this.quiet) clearTimeout(this.quiet);
    this.quiet = null;
    if (this.talking === null || this.mine === "live") return;
    this.quiet = setTimeout(() => {
      this.quiet = null;
      this.talking = null;
      this.player.reset();
      this.emit();
    }, VOICE_QUIET_MS);
  }

  toggleMute(person: string) {
    if (!this.muted.delete(person)) this.muted.add(person);
    try {
      localStorage.setItem(MUTED_KEY, JSON.stringify({ code: this.link.code, ids: [...this.muted] }));
    } catch {
      // Private mode: just this visit.
    }
    this.emit();
  }

  dispose() {
    this.release();
    if (this.quiet) clearTimeout(this.quiet);
    this.quiet = null;
  }
}
