// The bots' table talk: how much of it (枱邊講嘢 - chatty, quiet or off) and
// whether it's said aloud (講出聲) - each personality's calls (碰, 上, 槓, 食糊,
// 自摸, 叮, 搶槓) and lines in a natural Cantonese voice, clips made ahead of
// time (scripts/voices.ts) into public/voices/<personality>/. Off by
// default. They play through the same audio as the table's sounds, so never while
// the sound's off (see sound.ts). Both settings remembered on this phone.

import { lineId, spokenText, type Speech } from "@mjwaits/shared/engine/speech";
import { awakeAudio, isMuted, madeAudio } from "./sound";

export type Talk = "chatty" | "quiet" | "off";
export type VoiceCall = "pung" | "chow" | "kong" | "win" | "selfDraw" | "riichi" | "robKong";

const TALK_KEY = "mjwaits.talk";
const VOICE_KEY = "mjwaits.voice";

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Private mode: just this visit.
  }
}

let talk: Talk = ((t) => (t === "quiet" || t === "off" ? t : "chatty"))(read(TALK_KEY));
export const getTalk = () => talk;
export function setTalk(t: Talk) {
  talk = t;
  write(TALK_KEY, t);
}

// Off unless turned on.
let aloud = read(VOICE_KEY) === "1";
export const isAloud = () => aloud;
export function setAloud(on: boolean) {
  aloud = on;
  write(VOICE_KEY, on ? "1" : "0");
}

// Each clip, fetched and decoded the first time it's wanted, then kept.
const clips = new Map<string, Promise<AudioBuffer | null>>();
function clip(a: AudioContext, url: string): Promise<AudioBuffer | null> {
  let c = clips.get(url);
  if (!c) {
    c = fetch(url)
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status)))))
      .then((b) => a.decodeAudioData(b))
      .catch(() => null);
    clips.set(url, c);
  }
  return c;
}

// Each personality's pace - and with it, a little, its pitch: two that
// share a voice (the Grandmaster and the Hunter, say) sound apart.
const PACE: Record<string, number> = { grandmaster: 0.88, veteran: 0.96, speedster: 1.12, hunter: 1.04, wall: 0.9, gambler: 1.08, casual: 1.04, mystery: 1 };
const url = (style: string, name: string) => `${import.meta.env.BASE_URL}voices/${style}/${name}.mp3`;

// When the line being said ends: one line at a time (a call cuts in).
let saying = 0;
function playClip(a: AudioContext, style: string, name: string, line: boolean) {
  void clip(a, url(style, name)).then((buffer) => {
    if (!buffer || (line && a.currentTime < saying)) return;
    const src = a.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = PACE[style] ?? 1;
    src.connect(a.destination);
    src.start();
    if (line) saying = a.currentTime + buffer.duration / src.playbackRate.value;
  });
}
const live = () => {
  const a = awakeAudio();
  return a && aloud && !isMuted() && talk !== "off" ? a : null;
};

// A bot's call, aloud ("mystery" for a mystery bot - its voice is no one's).
export function sayAloud(style: string, call: VoiceCall) {
  const a = live();
  if (a) playClip(a, style, call, false);
}

// A bot's line, aloud - what's left of it to say (see spokenText); a line
// with no clip made is just shown.
export function sayLineAloud(style: string, kind: keyof Speech, line: string) {
  const a = live();
  const text = spokenText(kind, line);
  if (a && text) playClip(a, style, lineId(text), true);
}

// Fetched ahead, so the first call isn't late (once a tap has made the audio).
export function warmVoices(styles: string[]) {
  const a = madeAudio();
  if (!a) return;
  const calls: VoiceCall[] = ["pung", "chow", "kong", "win", "selfDraw", "riichi", "robKong"];
  for (const s of styles) for (const c of calls) void clip(a, url(s, c));
}
