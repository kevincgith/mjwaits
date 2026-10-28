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

// The five Cantonese voices, and each personality's - its own, and for
// some a second one, so a table's three bots can each sound like no one
// else there (scripts/voices.ts makes the clips: public/voices/<style>/ in
// its own voice, <style>-<voice>/ in its second, you-<voice>/ for the calls of
// the people at the table).
export type Voice = "wl" | "ys" | "hg" | "hm" | "xm";
const MALE: Voice[] = ["wl", "ys"];
const FEMALE: Voice[] = ["hm", "hg", "xm"];
export const OWN_VOICE: Record<string, Voice> = { grandmaster: "wl", veteran: "ys", speedster: "hg", hunter: "wl", wall: "xm", gambler: "ys", casual: "hm", mystery: "xm" };
export const SECOND_VOICE: Partial<Record<string, Voice>> = { speedster: "hm", hunter: "xm", wall: "hg", gambler: "hg", mystery: "hg" };

// Each personality's pace - and with it, a little, its pitch.
const PACE: Record<string, number> = { grandmaster: 0.88, veteran: 0.96, speedster: 1.12, hunter: 1.04, wall: 0.9, gambler: 1.08, casual: 1.04, mystery: 1 };

// Who's speaking: the clips' folder, and the pace they're played at.
export interface Speaker {
  dir: string;
  pace: number;
}

// Your own calls in a man's voice or a woman's - a man's unless you choose.
const YOU_KEY = "mjwaits.yourVoice";
export type YourVoice = "male" | "female";
let yours: YourVoice = read(YOU_KEY) === "female" ? "female" : "male";
export const getYourVoice = () => yours;
export function setYourVoice(v: YourVoice) {
  yours = v;
  write(YOU_KEY, v);
}

// A voice for each seat: the bots' (a personality's style; null for a
// person) all different where their voices allow - each its own voice if it
// can, else its second - and the people one the bots aren't using: you in
// the kind you chose (`me`, your seat), anyone else whatever's left.
export function tableVoices(styles: (string | null)[], me: number | null): (Speaker | null)[] {
  const bots = styles.map((s, i) => (s ? i : -1)).filter((i) => i >= 0);
  const options = (s: string): Voice[] => [OWN_VOICE[s] ?? "xm", ...(SECOND_VOICE[s] ? [SECOND_VOICE[s]!] : [])];
  // Every way of giving the bots their voices: the most different, then the
  // fewest second voices.
  let best: Voice[] = bots.map((i) => options(styles[i]!)[0]);
  let bestScore = -Infinity;
  const walk = (k: number, picked: Voice[], seconds: number) => {
    if (k === bots.length) {
      const score = new Set(picked).size * 10 - seconds;
      if (score > bestScore) [bestScore, best] = [score, picked];
      return;
    }
    options(styles[bots[k]]!).forEach((v, j) => walk(k + 1, [...picked, v], seconds + j));
  };
  walk(0, [], 0);
  const out: (Speaker | null)[] = styles.map(() => null);
  const used = new Set<Voice>();
  bots.forEach((i, k) => {
    const s = styles[i]!;
    const v = best[k];
    used.add(v);
    out[i] = { dir: v === OWN_VOICE[s] ? s : `${s}-${v}`, pace: PACE[s] ?? 1 };
  });
  // The people: you first, then anyone else.
  const people = styles.map((s, i) => (s ? -1 : i)).filter((i) => i >= 0).sort((a, b) => (a === me ? -1 : b === me ? 1 : a - b));
  for (const i of people) {
    const kind = i === me ? (yours === "female" ? FEMALE : MALE) : [...MALE, ...FEMALE];
    const v = kind.find((x) => !used.has(x)) ?? [...MALE, ...FEMALE].find((x) => !used.has(x)) ?? kind[0];
    used.add(v);
    out[i] = { dir: `you-${v}`, pace: 1 };
  }
  return out;
}

const url = (dir: string, name: string) => `${import.meta.env.BASE_URL}voices/${dir}/${name}.mp3`;

// When the line being said ends: one line at a time (a call cuts in).
let saying = 0;
function playClip(a: AudioContext, who: Speaker, name: string, line: boolean) {
  void clip(a, url(who.dir, name)).then((buffer) => {
    if (!buffer || (line && a.currentTime < saying)) return;
    const src = a.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = who.pace;
    src.connect(a.destination);
    src.start();
    if (line) saying = a.currentTime + buffer.duration / who.pace;
  });
}
const live = () => {
  const a = awakeAudio();
  return a && aloud && !isMuted() && talk !== "off" ? a : null;
};

// A call, aloud - a bot's or a person's.
export function sayAloud(who: Speaker, call: VoiceCall) {
  const a = live();
  if (a) playClip(a, who, call, false);
}

// A bot's line, aloud - what's left of it to say (see spokenText); a line
// with no clip made is just shown.
export function sayLineAloud(who: Speaker, kind: keyof Speech, line: string) {
  const a = live();
  const text = spokenText(kind, line);
  if (a && text) playClip(a, who, lineId(text), true);
}

// Fetched ahead, so the first call isn't late (once a tap has made the audio).
export function warmVoices(dirs: string[]) {
  const a = madeAudio();
  if (!a) return;
  const calls: VoiceCall[] = ["pung", "chow", "kong", "win", "selfDraw", "riichi", "robKong"];
  for (const d of dirs) for (const c of calls) void clip(a, url(d, c));
}
