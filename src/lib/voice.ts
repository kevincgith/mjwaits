// The bots' table talk: how much of it (枱邊講嘢 - chatty, quiet or off) and
// whether it's said aloud (講出聲) - in a Cantonese voice from the device
// itself (speechSynthesis, nothing to load), each personality at its own
// pitch and pace. Both remembered on this phone; aloud is off by default,
// and never while the sound's off (see sound.ts) or with no Cantonese voice
// to say it in (a Mandarin one would read the lines all wrong).

import { isMuted } from "./sound";

export type Talk = "chatty" | "quiet" | "off";

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
  if (t === "off") quiet();
}

let aloud = read(VOICE_KEY) === "1";
export const isAloud = () => aloud;
export function setAloud(on: boolean) {
  aloud = on;
  write(VOICE_KEY, on ? "1" : "0");
  if (!on) quiet();
}

const synth = (): SpeechSynthesis | null => (typeof window !== "undefined" && "speechSynthesis" in window ? window.speechSynthesis : null);

// A Cantonese voice on this device, if there is one (the list can come late).
function cantonese(): SpeechSynthesisVoice | null {
  const voices = synth()?.getVoices() ?? [];
  return voices.find((v) => /^(zh[-_]HK|yue)/i.test(v.lang)) ?? voices.find((v) => /cantonese|粵|廣東/i.test(v.name)) ?? null;
}
export const canSpeak = () => cantonese() !== null;
// Calls back once the device's voices are in (or straight away if they are).
export function onVoices(cb: () => void): () => void {
  const s = synth();
  if (!s) return () => {};
  s.addEventListener("voiceschanged", cb);
  return () => s.removeEventListener("voiceschanged", cb);
}

// Each personality's pitch and pace.
const STYLE: Record<string, { pitch: number; rate: number }> = {
  grandmaster: { pitch: 0.75, rate: 0.85 },
  veteran: { pitch: 0.9, rate: 0.95 },
  speedster: { pitch: 1.15, rate: 1.45 },
  hunter: { pitch: 0.85, rate: 1.0 },
  wall: { pitch: 0.95, rate: 0.8 },
  gambler: { pitch: 1.05, rate: 1.2 },
  casual: { pitch: 1.3, rate: 1.05 },
  mystery: { pitch: 1.0, rate: 1.0 },
};

// Say a line aloud - unless something's already waiting to be said (lines
// are short; a queue of them would run on long after the moment).
export function speak(text: string, style: string) {
  const s = synth();
  const voice = cantonese();
  if (!s || !voice || !aloud || isMuted() || talk === "off" || s.pending) return;
  // A voice that won't take the line is no reason to lose the bubble.
  try {
    const u = new SpeechSynthesisUtterance(text.replace(/[…]+/g, "，").replace(/[～~]/g, ""));
    u.voice = voice;
    u.lang = voice.lang;
    const { pitch, rate } = STYLE[style] ?? STYLE.mystery;
    u.pitch = pitch;
    u.rate = rate;
    s.speak(u);
  } catch {
    // Said nothing.
  }
}

function quiet() {
  synth()?.cancel();
}
