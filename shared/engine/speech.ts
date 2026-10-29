// Speech bubbles: what the bots say at the table, shown by their name. On
// a call, a win, a self-draw, 叮, dealing in and 投降, someone thinking too
// long, a run of 番子 thrown, a poor (or fine) deal, a dig at someone and the
// answer back, a discard called, a kong robbed, 連莊, a new round, 追, 嗌錯,
// flowers and dice paying, your own streaks - and the table talk
// between, which turns on how their game is going (ahead or behind, on a run
// or out of luck, under someone's 叮, the wall running out) and how a hand
// ends for them (a big win, a comeback, someone else's win, 流局).
//
// Each personality's lines are in lines/<id>.ts - hundreds each, so a long
// day at the table doesn't loop - and a bot works through them as a
// counter (LineCounter): the line it has said least, never one just said.

import { CASUAL } from "./lines/casual";
import { GAMBLER } from "./lines/gambler";
import { GRANDMASTER } from "./lines/grandmaster";
import { HUNTER } from "./lines/hunter";
import { MYSTERY } from "./lines/mystery";
import { SPEEDSTER } from "./lines/speedster";
import { VETERAN } from "./lines/veteran";
import { WALL } from "./lines/wall";

export interface Speech {
  call: string[];
  win: string[];
  selfDraw: string[];
  riichi: string[];
  dealIn: string[];
  surrender: string[];
  idle: string[]; // nothing in particular - small talk while the tiles go round
  handStart: string[]; // a fresh deal
  ahead: string[]; // leading the table
  behind: string[]; // at the bottom of it
  hot: string[]; // won lately, more than once
  cold: string[]; // nothing's gone in for a while
  pressure: string[]; // someone else has declared 叮
  late: string[]; // the wall's nearly gone
  bigWin: string[]; // a win worth a lot of 台
  comeback: string[]; // a win from the bottom of the table
  othersWin: string[]; // somebody else won (and not off them)
  drawGame: string[]; // 流局
  slow: string[]; // someone else is taking their time over a move
  honours: string[]; // throwing 番子 (winds, dragons) one after another
  honoursSeen: string[]; // someone else doing that
  badHand: string[]; // dealt a poor hand - or a fine one, played down
  goodHand: string[]; // dealt a fine one - or a poor one, bluffed up
  taunt: string[]; // a dig at someone, or the table - any time
  dealInTaunt: string[]; // a dig at someone who just dealt in
  retort: string[]; // answering a dig
  claimedFrom: string[]; // someone called this bot's discard
  robKong: string[]; // won by robbing a kong (搶槓)
  robbed: string[]; // its kong robbed
  dealerStay: string[]; // dealing again (連莊)
  dealerStaySeen: string[]; // someone else dealing again
  roundChange: string[]; // a new round wind
  chased: string[]; // threw a tile the next three all threw too, and pays for it (追)
  chaseSeen: string[]; // someone else caught by 追
  wrongCallSeen: string[]; // someone took a call back, and paid (嗌錯)
  flowers: string[]; // paid for its flowers (花, 八仙過海, 7搶1 ...)
  flowersSeen: string[]; // someone else paid for theirs
  dice: string[]; // the dice paid out before the first discard (圍骰, 蛇骰)
  youCold: string[]; // you (the one playing) dealing in again and again
  youHot: string[]; // you winning again and again
}

export const SPEECH: Record<string, Speech> = {
  grandmaster: GRANDMASTER,
  veteran: VETERAN,
  speedster: SPEEDSTER,
  hunter: HUNTER,
  wall: WALL,
  gambler: GAMBLER,
  casual: CASUAL,
};
// A mystery bot's: in nobody's character, giving nothing away.
export const MYSTERY_SPEECH = MYSTERY;

// How readily each speaks, 0-1: the quiet ones let most moments pass.
export const CHATTINESS: Record<string, number> = {
  grandmaster: 0.35,
  veteran: 0.65,
  speedster: 0.7,
  hunter: 0.6,
  wall: 0.25,
  gambler: 0.85,
  casual: 0.9,
};
export const MYSTERY_CHATTINESS = 0.45;

export type CallKind = "chow" | "pung" | "kong";

// The call a line names out loud, if any: "碰！" is a pung, "上啦。" a chow
// (上 leading the line - "大牌路上" isn't one).
const NAMES: Record<CallKind, RegExp> = {
  chow: /^[…\s]*上/,
  pung: /碰/,
  kong: /槓|杠/,
};

// The lines for this call: those that name it, or no call at all - never
// a 碰 shouted over a chow. From the call lines, or another kind's (a
// discard called - claimedFrom).
export function callLines(speech: Speech, kind: CallKind, lines: string[] = speech.call): string[] {
  const fits = lines.filter((line) => (Object.keys(NAMES) as CallKind[]).every((k) => k === kind || !NAMES[k].test(line)));
  return fits.length ? fits : lines;
}

// ---- What to talk about ------------------------------------------------------------

// How a hand went for one seat.
export type Outcome = "win" | "dealIn" | "none";

// A line aimed at someone may name them - "{name}" - where they have a name
// to use (online, a person's nickname); elsewhere those lines are left out.
export const NAME = "{name}";
export function named(lines: string[], name: string | null): string[] {
  return name === null ? lines.filter((l) => !l.includes(NAME)) : lines;
}

// ---- Said aloud --------------------------------------------------------------------

// What of a line is said aloud: a name it'd use left out (a clip can't say
// it), and for a call, a win or 叮, the call itself - the bot's call clip
// has just said that (see voice.ts). "" if nothing's left.
const CALL_WORD = /^(碰|上|槓|叮|搶槓|自摸|食糊|糊)[！!，。、…～\s]+/;
const CALLED: (keyof Speech)[] = ["call", "riichi", "robKong", "selfDraw", "win", "bigWin"];
export function spokenText(kind: keyof Speech, line: string): string {
  let text = line.replace(/\{name\}[，,…\s]*/g, "");
  if (CALLED.includes(kind)) text = text.replace(CALL_WORD, "");
  return /[\p{L}\p{N}]/u.test(text) ? text : "";
}

// A clip's name for a line said aloud: a short hash of what's said (FNV-1a).
export function lineId(text: string): string {
  let h = 0x811c9dc5;
  for (const ch of text) {
    h ^= ch.codePointAt(0)!;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

// Lines about the size of a win fit only a win that size: no 雞糊 sneered
// at a big hand, no "what a hand" for a small one - nor, from the winner
// (`own`), crowing over a big hand that wasn't.
const SMALL_TALK = /雞糊|咁細|細糊|細牌|番數咁少|食得細|一番|冇大牌|細少少|例外/;
const BIG_TALK = /好大鋪|咁大鋪|咁好牌|好多番|番數爆|幾大|唔細/;
const OWN_BIG_TALK = /大牌|清一色|番數夠|夠晒番|番數|計番計到手軟|唔細|十番|傑作|藝術|傳說|傳奇|歷史|史詩|大嘅|大嘢|大格局/;
export function forWin(lines: string[], tai: number, own = false): string[] {
  const fit = lines.filter(
    (l) => (tai >= BIG_WIN_TAI / 2 ? !SMALL_TALK.test(l) : true) && (tai < BIG_WIN_TAI ? !BIG_TALK.test(l) : true) && (own && tai < BIG_WIN_TAI / 2 ? !OWN_BIG_TALK.test(l) : true)
  );
  return fit.length > 2 ? fit : lines;
}

// What a bot knows of the table when it opens its mouth.
export interface TableMood {
  seat: number;
  totals: number[]; // the game so far, per seat
  history: Outcome[]; // this seat's hands, oldest first
  riichi: boolean[]; // who has declared 叮
  liveLeft: number; // tiles left to draw
}

export type Situation = "idle" | "ahead" | "behind" | "hot" | "cold" | "pressure" | "late";

export const LATE_TILES = 16;
// Ahead or behind by this many 台 or more, before it's worth remarking on.
export const MARGIN = 6;
export const BIG_WIN_TAI = 10;

// Everything that's true of this seat right now, in no order.
export function situations(m: TableMood): Situation[] {
  const out: Situation[] = [];
  const mine = m.totals[m.seat];
  const others = m.totals.filter((_, i) => i !== m.seat);
  if (mine - Math.max(...others) >= MARGIN) out.push("ahead");
  if (Math.min(...others) - mine >= MARGIN) out.push("behind");
  const last3 = m.history.slice(-3);
  if (last3.filter((o) => o === "win").length >= 2) out.push("hot");
  const last5 = m.history.slice(-5);
  if ((last5.length === 5 && !last5.includes("win")) || (m.history.length >= 2 && m.history.slice(-2).every((o) => o === "dealIn"))) out.push("cold");
  if (!m.riichi[m.seat] && m.riichi.some((r, i) => r && i !== m.seat)) out.push("pressure");
  if (m.liveLeft <= LATE_TILES) out.push("late");
  return out;
}

// One situation to talk about: small talk always possible, anything that's
// actually going on more likely - a 叮 across the table most of all.
export function pickSituation(m: TableMood, rand = Math.random): Situation {
  const weighted: [Situation, number][] = [["idle", 1.2], ...situations(m).map((s): [Situation, number] => [s, s === "pressure" ? 3 : 2])];
  const sum = weighted.reduce((t, [, w]) => t + w, 0);
  let r = rand() * sum;
  for (const [s, w] of weighted) if ((r -= w) < 0) return s;
  return "idle";
}

// Was this seat at the bottom of the table before a hand that just paid
// out `deltas`, and isn't any more?
export function isComeback(totalsAfter: number[], deltas: number[], seat: number): boolean {
  const before = totalsAfter.map((t, i) => t - deltas[i]);
  const lowest = Math.min(...before);
  return before[seat] === lowest && before.filter((t) => t === lowest).length === 1 && totalsAfter[seat] > Math.min(...totalsAfter.filter((_, i) => i !== seat));
}

// ---- Not the same thing twice ----------------------------------------------------------

// Every line said is counted - the counts kept on the device, so they hold
// across games and days - and a bot always picks from the lines that fit
// the moment the one it has said least, at random among those. The table's
// last RECENT_LINES lines (anyone's) are held back too, so nobody echoes
// what was just said. A line comes round again only once the others that
// fit have had their turn - and then still can, when it fits.
export const RECENT_LINES = 40;
export class LineCounter {
  private counts: Record<string, number>;
  private recent: string[] = [];
  private rand: () => number;
  constructor(counts: Record<string, number> = {}, rand: () => number = Math.random) {
    this.counts = { ...counts };
    this.rand = rand;
  }

  next(lines: string[]): string {
    if (lines.length === 0) return "";
    const fresh = lines.filter((l) => !this.recent.includes(l));
    const notLast = lines.filter((l) => l !== this.recent[this.recent.length - 1]);
    const pool = fresh.length ? fresh : notLast.length ? notLast : lines;
    const least = Math.min(...pool.map((l) => this.counts[l] ?? 0));
    const picks = pool.filter((l) => (this.counts[l] ?? 0) === least);
    const line = picks[Math.floor(this.rand() * picks.length)];
    this.counts[line] = (this.counts[line] ?? 0) + 1;
    this.recent = [...this.recent, line].slice(-RECENT_LINES);
    return line;
  }

  // Each line's count, for keeping.
  said(): Record<string, number> {
    return { ...this.counts };
  }
}
