// The Play table's sounds, made on the spot with Web Audio (no files to
// load): a tile's clack for a draw or a discard, a deeper knock for a call,
// a bell for 叮 and a little chime for a win or a bonus - with a short
// buzz on phones that allow it (Android; an iPhone page can't vibrate).
// iPhones only let a page make sound after a tap, so the first tap on the
// page wakes the audio up. Muting is remembered on this phone.

export type Sound = "draw" | "discard" | "call" | "riichi" | "win" | "bonus";

const MUTE_KEY = "mjwaits.soundOff";

let ctx: AudioContext | null = null;
let muted = (() => {
  try {
    return localStorage.getItem(MUTE_KEY) === "1";
  } catch {
    return false;
  }
})();

export const isMuted = () => muted;

export function setMuted(m: boolean) {
  muted = m;
  try {
    localStorage.setItem(MUTE_KEY, m ? "1" : "0");
  } catch {
    // Private mode: just this visit.
  }
}

// Called on the first tap (see wakeAudio): the audio context, made and
// resumed inside a user gesture as iOS requires.
function audio(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) return null;
  ctx ??= new AC();
  if (ctx.state === "suspended") void ctx.resume();
  return ctx;
}

export function wakeAudio() {
  audio();
}

// The audio context once a tap has woken it (null before), for other
// sounds to play through - the bots' voices (see voice.ts).
export const awakeAudio = (): AudioContext | null => (ctx && ctx.state === "running" ? ctx : null);
// The audio context if a tap has made it, woken yet or not (clips can be
// decoded ahead while it wakes).
export const madeAudio = (): AudioContext | null => ctx;

// A short burst of filtered noise: the click of tile on tile. Each kind's
// noise is made once and reused.
const noises = new Map<string, AudioBuffer>();
function noise(a: AudioContext, freq: number, length: number): AudioBuffer {
  const key = `${freq}/${length}`;
  let buffer = noises.get(key);
  if (buffer && buffer.sampleRate === a.sampleRate) return buffer;
  buffer = a.createBuffer(1, Math.ceil(a.sampleRate * length), a.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length) ** 3;
  noises.set(key, buffer);
  return buffer;
}
function clack(a: AudioContext, at: number, { freq, q, length, gain }: { freq: number; q: number; length: number; gain: number }) {
  const buffer = noise(a, freq, length);
  const src = a.createBufferSource();
  src.buffer = buffer;
  const band = a.createBiquadFilter();
  band.type = "bandpass";
  band.frequency.value = freq;
  band.Q.value = q;
  const g = a.createGain();
  g.gain.value = gain;
  src.connect(band).connect(g).connect(a.destination);
  src.start(at);
}

// A soft sine note with a quick attack and a ringing tail.
function tone(a: AudioContext, at: number, freq: number, length: number, gain: number) {
  const osc = a.createOscillator();
  osc.type = "sine";
  osc.frequency.value = freq;
  const g = a.createGain();
  g.gain.setValueAtTime(0, at);
  g.gain.linearRampToValueAtTime(gain, at + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, at + length);
  osc.connect(g).connect(a.destination);
  osc.start(at);
  osc.stop(at + length + 0.05);
}

const BUZZ: Record<Sound, number | number[]> = {
  draw: 0,
  discard: 8,
  call: 25,
  riichi: [15, 40, 15],
  win: [30, 50, 60],
  bonus: 12,
};

export function play(sound: Sound) {
  if (muted) return;
  const buzz = BUZZ[sound];
  if (buzz && "vibrate" in navigator) navigator.vibrate(buzz);
  if (!ctx || ctx.state !== "running") return; // not woken by a tap yet
  const a = ctx;
  const t = a.currentTime + 0.005;
  switch (sound) {
    case "draw":
      clack(a, t, { freq: 2600, q: 2.5, length: 0.05, gain: 0.35 });
      break;
    case "discard":
      clack(a, t, { freq: 1900, q: 1.8, length: 0.09, gain: 0.8 });
      clack(a, t + 0.035, { freq: 2400, q: 3, length: 0.05, gain: 0.3 });
      break;
    case "call":
      clack(a, t, { freq: 900, q: 1.4, length: 0.12, gain: 1 });
      clack(a, t + 0.06, { freq: 1300, q: 2, length: 0.1, gain: 0.7 });
      break;
    case "riichi":
      tone(a, t, 1318.5, 0.9, 0.18);
      tone(a, t, 2637, 0.5, 0.05);
      break;
    case "win":
      [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => tone(a, t + i * 0.09, f, 0.7, 0.16));
      break;
    case "bonus":
      tone(a, t, 987.77, 0.35, 0.12);
      tone(a, t + 0.07, 1318.5, 0.4, 0.1);
      break;
  }
}
