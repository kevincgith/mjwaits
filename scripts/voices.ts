// The bots said aloud, in natural Cantonese voices (Azure neural text to
// speech), made ahead of time into public/voices/<personality>/:
//   - <call>.mp3: each personality's 碰, 上, 槓, 食糊, 自摸, 叮 and 搶槓, and
//   - <lineId>.mp3: every line it says (see spokenText, lineId) -
// and some in a second voice (<style>-<voice>/), and the calls alone in
// every voice for the people at the table (you-<voice>/).
// The game plays them (src/lib/voice.ts); a line with no clip is just shown.
//
//   npx tsx scripts/voices.ts             make what's missing
//   npx tsx scripts/voices.ts --limit 80  just the first 80 missing lines
//   npx tsx scripts/voices.ts --calls     make the call clips again too
//
// The key stays on this Mac, in azure-speech.env.local (git-ignored):
// AZURE_SPEECH_KEY and AZURE_SPEECH_REGION. The free tier allows 0.5M
// characters a month (a Chinese character counts as two, markup counts) and
// 20 requests a minute - so lines go 40 to a request with a 3s pause
// between them, and the audio's cut at the pauses (a request whose pieces
// don't come out one a line is done again line by line).

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RIVALS } from "../shared/engine/lines/rivals";
import { lineId, MYSTERY_SPEECH, SPEECH, spokenText, type Speech } from "../shared/engine/speech";

const ROOT = new URL("..", import.meta.url).pathname;
const env = Object.fromEntries(
  readFileSync(join(ROOT, "azure-speech.env.local"), "utf8")
    .split("\n")
    .filter((l) => /^\w+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()])
);
const OUT = join(ROOT, "public/voices");

// The five voices, by the short name the game knows them by (voice.ts).
const VOICE: Record<string, string> = { wl: "zh-HK-WanLungNeural", ys: "yue-CN-YunSongNeural", hg: "zh-HK-HiuGaaiNeural", hm: "zh-HK-HiuMaanNeural", xm: "yue-CN-XiaoMinNeural" };
// Some personalities' second voice - for when another bot at the table has
// the first (see tableVoices) - into public/voices/<style>-<voice>/.
const SECOND: Record<string, string> = { speedster: "hm", hunter: "xm", wall: "hg", gambler: "hg", mystery: "hg" };

// Each personality's voice (its pace is set as it plays - see voice.ts).
const VOICES: Record<string, string> = {
  grandmaster: "zh-HK-WanLungNeural",
  veteran: "yue-CN-YunSongNeural",
  speedster: "zh-HK-HiuGaaiNeural",
  hunter: "zh-HK-WanLungNeural",
  wall: "yue-CN-XiaoMinNeural",
  gambler: "yue-CN-YunSongNeural",
  casual: "zh-HK-HiuMaanNeural",
  mystery: "yue-CN-XiaoMinNeural",
};
const WANLUNG = "zh-HK-WanLungNeural";

// Pronunciation, pinned where the voices guess wrong (Azure's sapi
// Jyutping): 自摸 is zi6 mo1; the call 上 is soeng5, as in 上去 - which
// WanLung won't take pinned, but says right as 想.
const pin = (text: string, ph: string) => `<phoneme alphabet="sapi" ph="${ph}">${text}</phoneme>`;
const escape = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
function ssmlText(text: string, voice: string, call = false): string {
  let t = escape(text).replace(/自摸/g, pin("自摸", "zi 6 mo 1"));
  if (call) t = t.replace(/^上/, voice === WANLUNG ? "想" : pin("上", "soeng 5"));
  return t;
}
const CALLS: Record<string, string> = { pung: "碰！", chow: "上啦！", kong: "槓！", win: "食糊！", selfDraw: "自摸！", riichi: "叮！", robKong: "搶槓！" };

async function synth(voice: string, body: string): Promise<Buffer> {
  for (let tries = 0; ; tries++) {
    // A dropped connection: wait, and try again.
    const res = await fetch(`https://${env.AZURE_SPEECH_REGION}.tts.speech.microsoft.com/cognitiveservices/v1`, {
      method: "POST",
      headers: {
        "Ocp-Apim-Subscription-Key": env.AZURE_SPEECH_KEY,
        "Content-Type": "application/ssml+xml",
        "X-Microsoft-OutputFormat": "audio-24khz-48kbitrate-mono-mp3",
        "User-Agent": "mjwaits-voices",
      },
      body: `<speak version="1.0" xml:lang="${voice.slice(0, 5)}"><voice name="${voice}">${body}</voice></speak>`,
    }).catch((e: unknown) => {
      if (tries >= 5) throw e;
      return null;
    });
    if (!res) {
      await new Promise((r) => setTimeout(r, 10000 * (tries + 1)));
      continue;
    }
    await new Promise((r) => setTimeout(r, 3100)); // 20 a minute
    if (res.ok) return Buffer.from(await res.arrayBuffer());
    if (res.status === 429 && tries < 5) {
      await new Promise((r) => setTimeout(r, 15000 * (tries + 1)));
      continue;
    }
    throw new Error(`${voice}: ${res.status} ${await res.text()}`);
  }
}

// Small and plenty for speech: 22 kHz mono at 32 kbit/s - the silence
// before and after trimmed, so the voice comes with its bubble.
const TRIM = "silenceremove=start_periods=1:start_threshold=-45dB,areverse,silenceremove=start_periods=1:start_threshold=-45dB,areverse,adelay=40,apad=pad_dur=0.08";
const ENCODE = ["-af", TRIM, "-ac", "1", "-ar", "22050", "-b:a", "32k", "-loglevel", "error", "-y"];
const work = mkdtempSync(join(tmpdir(), "mjwaits-voices-"));
function save(mp3: Buffer, file: string, from?: number, to?: number) {
  const src = join(work, "in.mp3");
  writeFileSync(src, mp3);
  const cut = [...(from !== undefined ? ["-ss", String(Math.max(0, from))] : []), ...(to !== undefined ? ["-to", String(to)] : [])];
  execFileSync("ffmpeg", ["-i", src, ...cut, ...ENCODE, file]);
}
// The pauses in a batch's audio: [start, end] of each silence 2s or longer
// (the lines are 3s apart; a pause within a line is never that long).
function silences(mp3: Buffer): [number, number][] {
  const src = join(work, "batch.mp3");
  writeFileSync(src, mp3);
  const out = execFileSync("sh", ["-c", `ffmpeg -i "${src}" -af silencedetect=noise=-38dB:d=2.0 -f null - 2>&1`], { encoding: "utf8" });
  const starts = [...out.matchAll(/silence_start: ([\d.]+)/g)].map((m) => Number(m[1]));
  const ends = [...out.matchAll(/silence_end: ([\d.]+)/g)].map((m) => Number(m[1]));
  return starts.map((s, i): [number, number] => [s, ends[i] ?? Infinity]).filter(([, e]) => e !== Infinity);
}

// Every line each personality says aloud, once - and whether it's a call's
// line (its 上 is the call).
const ALL: Record<string, Speech> = { ...SPEECH, mystery: MYSTERY_SPEECH };
function linesOf(style: string): { text: string; call: boolean }[] {
  const seen = new Map<string, boolean>();
  for (const [kind, lines] of Object.entries(ALL[style]) as [keyof Speech, string[]][])
    for (const l of lines) {
      const t = spokenText(kind, l);
      if (t) seen.set(t, (seen.get(t) ?? false) || kind === "call");
    }
  for (const lines of Object.values(RIVALS[style] ?? {}))
    for (const l of lines) {
      const t = spokenText("taunt", l);
      if (t && !seen.has(t)) seen.set(t, false);
    }
  return [...seen].map(([text, call]) => ({ text, call }));
}

const arg = (name: string) => process.argv.indexOf(name);
const limit = arg("--limit") > 0 ? Number(process.argv[arg("--limit") + 1]) : Infinity;
const callsAgain = arg("--calls") > 0;
const BATCH = 40;
const billable = (s: string) => [...s].reduce((n, c) => n + (/\p{Script=Han}/u.test(c) ? 2 : 1), 0);
let made = 0;
let chars = 0;
// What to make: each personality in its voice (and some in a second), and
// the calls alone in every voice for the people at the table (you-<voice>/).
const SETS: { dir: string; voice: string; style: string | null }[] = [
  ...Object.entries(VOICES).map(([style, voice]) => ({ dir: style, voice, style })),
  ...Object.entries(SECOND).map(([style, v]) => ({ dir: `${style}-${v}`, voice: VOICE[v], style })),
  ...Object.entries(VOICE).map(([v, voice]) => ({ dir: `you-${v}`, voice, style: null })),
];
for (const { dir, voice, style } of SETS) {
  mkdirSync(join(OUT, dir), { recursive: true });
  for (const [call, text] of Object.entries(CALLS)) {
    const file = join(OUT, dir, `${call}.mp3`);
    if (existsSync(file) && !callsAgain) continue;
    const body = ssmlText(text, voice, true);
    save(await synth(voice, body), file);
    chars += billable(body);
  }
  if (!style) continue;
  const todo = linesOf(style).filter(({ text }) => !existsSync(join(OUT, dir, `${lineId(text)}.mp3`)));
  for (let i = 0; i < todo.length && made < limit; i += BATCH) {
    const batch = todo.slice(i, i + Math.min(BATCH, limit - made));
    const body = batch.map(({ text, call }) => ssmlText(text, voice, call)).join('<break time="3000ms"/>');
    const mp3 = await synth(voice, body);
    chars += billable(body);
    const gaps = silences(mp3);
    if (gaps.length === batch.length - 1) {
      batch.forEach(({ text }, j) => {
        const from = j === 0 ? undefined : gaps[j - 1][1] - 0.08;
        const to = j === batch.length - 1 ? undefined : gaps[j][0] + 0.12;
        save(mp3, join(OUT, dir, `${lineId(text)}.mp3`), from, to);
      });
    } else {
      // The pauses didn't come out one between each line: one at a time.
      console.log(`${dir}: a batch of ${batch.length} cut into ${gaps.length + 1} - line by line`);
      for (const { text, call } of batch) {
        const one = ssmlText(text, voice, call);
        save(await synth(voice, one), join(OUT, dir, `${lineId(text)}.mp3`));
        chars += billable(one);
      }
    }
    made += batch.length;
    console.log(`${dir}: ${Math.min(i + batch.length, todo.length)}/${todo.length} (~${chars} billable characters so far)`);
  }
}
rmSync(work, { recursive: true, force: true });
console.log(`done: ${made} lines, ~${chars} billable characters`);
