// Speech bubbles: what the bots say at the table, shown by their name. On
// a call, a win, a self-draw, 叮, dealing in and 投降 - and the table talk
// between, which turns on how their game is going (ahead or behind, on a run
// or out of luck, under someone's 叮, the wall running out) and how a hand
// ends for them (a big win, a comeback, someone else's win, 流局).
//
// Each personality's lines are in lines/<id>.ts - hundreds each, so a long
// day at the table doesn't loop - and a bot works through them as a
// shuffled deck (LineDecks), so it says every line before it says one again.

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
// a 碰 shouted over a chow.
export function callLines(speech: Speech, kind: CallKind): string[] {
  const fits = speech.call.filter((line) => (Object.keys(NAMES) as CallKind[]).every((k) => k === kind || !NAMES[k].test(line)));
  return fits.length ? fits : speech.call;
}

// ---- What to talk about ------------------------------------------------------------

// How a hand went for one seat.
export type Outcome = "win" | "dealIn" | "none";

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

// Each bot works through a shuffled deck of each kind of line, and only
// shuffles again once it's said them all - never starting the new deck with
// the line it just said. So a line comes back only after all the others.
export class LineDecks {
  private decks = new Map<string, string[]>();
  private last = new Map<string, string>();
  private rand: () => number;
  constructor(rand: () => number = Math.random) {
    this.rand = rand;
  }

  next(key: string, lines: string[]): string {
    if (lines.length === 0) return "";
    let deck = this.decks.get(key);
    // A deck for a different set of lines (a call's own pool) starts afresh.
    if (!deck || deck.some((l) => !lines.includes(l))) deck = [];
    if (deck.length === 0) {
      deck = lines.slice();
      for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(this.rand() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
      }
      const last = this.last.get(key);
      if (deck.length > 1 && deck[deck.length - 1] === last) [deck[0], deck[deck.length - 1]] = [deck[deck.length - 1], deck[0]];
    }
    const line = deck.pop()!;
    this.decks.set(key, deck);
    this.last.set(key, line);
    return line;
  }
}
