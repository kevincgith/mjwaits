import { describe, expect, it, vi } from "vitest";
import { CHAT_HISTORY, VOICE_FRAME_MAX_CHARS, VOICE_FRAME_SAMPLES, VOICE_MAX_MS, VOICE_QUIET_MS } from "@mjwaits/shared/protocol/limits";
import { mergeChat } from "./onlineTable";
import { decodeAdpcm, encodeAdpcm, fromBase64, newAdpcmState, toBase64 } from "./adpcm";
import { Downsampler, TableVoice, Upsampler, type VoiceLink, type VoicePlayer } from "./tableVoice";

const sine = (n: number, at = 0) => Int16Array.from({ length: n }, (_, i) => Math.round(12000 * Math.sin(((i + at) * 2 * Math.PI * 300) / 16000)));

describe("ADPCM", () => {
  it("keeps speech-like sound close, frame after frame", () => {
    const state = newAdpcmState();
    const first = encodeAdpcm(sine(VOICE_FRAME_SAMPLES), state);
    const input = sine(VOICE_FRAME_SAMPLES, VOICE_FRAME_SAMPLES);
    const output = decodeAdpcm(encodeAdpcm(input, state));
    expect(first.length).toBe(803);
    expect(output.length).toBe(VOICE_FRAME_SAMPLES);
    const worst = Math.max(...output.map((v, i) => Math.abs(v - input[i])));
    expect(worst).toBeLessThan(600);
  });

  it("fits the wire and survives base64", () => {
    const frame = encodeAdpcm(sine(VOICE_FRAME_SAMPLES), newAdpcmState());
    const text = toBase64(frame);
    expect(text.length).toBe(VOICE_FRAME_MAX_CHARS);
    expect([...fromBase64(text)]).toEqual([...frame]);
  });

  it("makes something harmless of a bad frame", () => {
    expect(decodeAdpcm(new Uint8Array(2)).length).toBe(0);
    expect(decodeAdpcm(new Uint8Array([255, 255, 255, 255, 255])).length).toBe(4);
  });
});

describe("resampling", () => {
  it.each([48000, 44100, 16000])("turns %i Hz into whole frames at the wire's rate", (rate) => {
    const frames: Int16Array[] = [];
    const down = new Downsampler(rate, (f) => frames.push(f));
    down.push(new Float32Array(Math.ceil(rate * 0.25)).fill(0.5));
    expect(frames.length).toBe(2);
    expect(frames[0].length).toBe(VOICE_FRAME_SAMPLES);
    expect(frames[1][0]).toBe(Math.round(0.5 * 32767));
  });

  it.each([48000, 44100])("plays a frame for its full 100 ms at %i Hz, with no jump at the seam", (rate) => {
    const up = new Upsampler(rate);
    const a = up.push(new Int16Array(VOICE_FRAME_SAMPLES).fill(16384));
    const b = up.push(new Int16Array(VOICE_FRAME_SAMPLES).fill(16384));
    expect(Math.abs(a.length - rate / 10)).toBeLessThanOrEqual(1);
    expect(a[a.length - 1]).toBeCloseTo(0.5, 2);
    expect(b[0]).toBeCloseTo(0.5, 2);
  });
});

// A phone at seat 1, with a microphone that's opened by hand.
function phone() {
  const sent: { t: string; on?: boolean; a?: string }[] = [];
  const views: TableVoice["view"][] = [];
  const problems: string[] = [];
  const stop = vi.fn();
  let opened: (() => void) | null = null;
  let fail: ((e: unknown) => void) | null = null;
  let feed: ((s: Float32Array, rate: number) => void) | null = null;
  const played: Int16Array[] = [];
  const player: VoicePlayer = { play: (f) => played.push(f), reset: () => {} };
  const link: VoiceLink = {
    code: "ABCDE",
    send: (m) => (sent.push(m), "1"),
    backlog: () => 0,
    seat: () => 1,
    person: (s) => `p${s}`,
  };
  const voice = new TableVoice(link, (v) => views.push(v), (p) => problems.push(p), {
    player,
    openMic: (onSamples) =>
      new Promise((resolve, reject) => {
        feed = onSamples;
        fail = reject;
        opened = () => resolve({ stop });
      }),
  });
  const mic = async () => {
    opened!();
    await Promise.resolve();
    await Promise.resolve();
  };
  const speak = (ms: number) => feed!(new Float32Array(Math.round(16 * ms)).fill(0.2), 16000);
  return { voice, sent, views, problems, stop, played, mic, speak, fail: (e: unknown) => fail!(e) };
}

describe("the walkie-talkie", () => {
  it("asks for the floor once the mic is open, then sends what it heard meanwhile", async () => {
    const p = phone();
    p.voice.press();
    expect(p.voice.view.mine).toBe("opening");
    expect(p.sent).toEqual([]);
    await p.mic();
    expect(p.sent).toEqual([{ t: "talk", on: true }]);
    p.speak(200);
    expect(p.sent.length).toBe(1);
    p.voice.onTalking(1);
    expect(p.voice.view.mine).toBe("live");
    expect(p.sent.filter((m) => m.t === "voice").length).toBe(2);
    p.speak(100);
    expect(p.sent.filter((m) => m.t === "voice").length).toBe(3);
    p.voice.release();
    expect(p.sent.at(-1)).toEqual({ t: "talk", on: false });
    expect(p.stop).toHaveBeenCalledOnce();
    expect(p.voice.view.mine).toBe("idle");
  });

  it("lets go cleanly if the button comes up while the mic is still opening", async () => {
    const p = phone();
    p.voice.press();
    p.voice.release();
    await p.mic();
    expect(p.sent).toEqual([]);
    expect(p.stop).toHaveBeenCalledOnce();
    expect(p.voice.view.mine).toBe("idle");
  });

  it("stands down when someone else has the floor", async () => {
    const p = phone();
    p.voice.press();
    await p.mic();
    p.voice.onTalking(2);
    expect(p.voice.view).toMatchObject({ mine: "idle", talking: 2 });
    expect(p.stop).toHaveBeenCalledOnce();
    // Busy: pressing does nothing until they've finished.
    p.voice.press();
    expect(p.voice.view.mine).toBe("idle");
    p.voice.onTalking(null);
    p.voice.press();
    expect(p.voice.view.mine).toBe("opening");
  });

  it("says why when the microphone is refused", async () => {
    const p = phone();
    p.voice.press();
    p.fail(new DOMException("no", "NotAllowedError"));
    await Promise.resolve();
    await Promise.resolve();
    expect(p.problems[0]).toMatch(/blocked/);
    expect(p.voice.view.mine).toBe("idle");
  });

  it("ends a turn at the limit", async () => {
    vi.useFakeTimers();
    try {
      const p = phone();
      p.voice.press();
      await p.mic();
      p.voice.onTalking(1);
      vi.advanceTimersByTime(VOICE_MAX_MS);
      expect(p.voice.view.mine).toBe("idle");
      expect(p.sent.at(-1)).toEqual({ t: "talk", on: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it("plays others unless muted, and forgets a talker who's gone quiet", () => {
    vi.useFakeTimers();
    try {
      const p = phone();
      const a = toBase64(encodeAdpcm(sine(VOICE_FRAME_SAMPLES), newAdpcmState()));
      p.voice.onTalking(2);
      p.voice.onVoice(2, a);
      expect(p.played.length).toBe(1);
      p.voice.toggleMute("p2");
      p.voice.onVoice(2, a);
      expect(p.played.length).toBe(1);
      p.voice.toggleMute("p2");
      p.voice.onVoice(2, "@@ not base64 @@");
      expect(p.played.length).toBe(1);
      vi.advanceTimersByTime(VOICE_QUIET_MS);
      expect(p.voice.view.talking).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("chat lines", () => {
  const line = (k: string, at: number) => ({ k, id: "a", name: "Amy", seat: 0, text: k, at });
  it("are kept once each, in order, the last few only", () => {
    expect(mergeChat([line("b", 2)], [line("a", 1), line("b", 2), line("c", 3)]).map((m) => m.k)).toEqual(["a", "b", "c"]);
    const many = Array.from({ length: CHAT_HISTORY + 5 }, (_, i) => line(`m${i}`, i));
    const kept = mergeChat([], many);
    expect(kept.length).toBe(CHAT_HISTORY);
    expect(kept[0].k).toBe("m5");
  });
});
