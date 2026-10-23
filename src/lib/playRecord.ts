// Your record at the Play table, kept on this phone across games: hands,
// wins, deal-ins, 台 won, your best hand, how you fare against each
// opponent, and the first time you won with each big pattern. Updated at
// the end of every hand you play (alone or online).

import { HUMAN } from "@mjwaits/shared/engine/game";
import type { ResultView, ScoreView } from "@mjwaits/shared/engine/view";

export const PLAY_RECORD_KEY = "mjwaits.playRecord";

// A pattern worth a "first time" at this many 台 or more - but not 底,
// which every win has.
export const MILESTONE_TAI = 5;
const EVERY_WIN = new Set(["base-tai"]);

export interface VsRecord {
  name: string;
  hands: number;
  theirWins: number; // hands they won
  youDealtIn: number; // you threw their winning tile
  theyDealtIn: number; // they threw yours
}

export interface PlayRecord {
  hands: number;
  wins: number;
  selfDraws: number;
  dealIns: number;
  draws: number; // 流局
  taiWon: number;
  best: { tai: number; patterns: string[]; at: number } | null;
  vs: Record<string, VsRecord>;
  firsts: Record<string, { name: string; tai: number; at: number }>;
}

export const emptyRecord = (): PlayRecord => ({ hands: 0, wins: 0, selfDraws: 0, dealIns: 0, draws: 0, taiWon: 0, best: null, vs: {}, firsts: {} });

export function loadRecord(): PlayRecord {
  try {
    const raw = localStorage.getItem(PLAY_RECORD_KEY);
    return raw ? { ...emptyRecord(), ...(JSON.parse(raw) as Partial<PlayRecord>) } : emptyRecord();
  } catch {
    return emptyRecord();
  }
}

export function saveRecord(r: PlayRecord) {
  try {
    localStorage.setItem(PLAY_RECORD_KEY, JSON.stringify(r));
  } catch {
    // Private mode: the record lasts this visit.
  }
}

// Who sat where this hand (seats 1-3): a key to tally them by - a bot's
// personality, or "people" for anyone real online - and a name to show.
export interface Opponent {
  seat: number;
  key: string;
  name: string;
}

// The score you won with, if you won this hand.
function myScore(r: ResultView): ScoreView | null | undefined {
  if (r.winner === HUMAN) return r.score;
  return r.alsoWon?.find((w) => w.winner === HUMAN)?.score;
}

const won = (r: ResultView, seat: number) => r.winner === seat || !!r.alsoWon?.some((w) => w.winner === seat);

// The record with this hand added, and the patterns won with for the first time.
export function addHand(rec: PlayRecord, r: ResultView, opponents: Opponent[], at = Date.now()): { record: PlayRecord; firsts: string[] } {
  const next: PlayRecord = { ...rec, vs: { ...rec.vs }, firsts: { ...rec.firsts } };
  const firsts: string[] = [];
  next.hands++;
  if (r.winner === null) next.draws++;
  const mine = won(r, HUMAN) ? myScore(r) : undefined;
  if (won(r, HUMAN)) {
    next.wins++;
    if (r.from === null) next.selfDraws++;
    const tai = mine?.total ?? 0;
    next.taiWon += tai;
    if (mine && (!next.best || tai > next.best.tai)) next.best = { tai, patterns: mine.patterns.map((p) => p.name), at };
    for (const p of mine?.patterns ?? []) {
      if (p.tai < MILESTONE_TAI || EVERY_WIN.has(p.id) || next.firsts[p.id]) continue;
      next.firsts[p.id] = { name: p.name, tai: p.tai, at };
      firsts.push(p.name);
    }
  } else if (r.winner !== null && r.from === HUMAN) next.dealIns++;
  for (const o of opponents) {
    const v = { ...(next.vs[o.key] ?? { name: o.name, hands: 0, theirWins: 0, youDealtIn: 0, theyDealtIn: 0 }), name: o.name };
    v.hands++;
    if (won(r, o.seat)) {
      v.theirWins++;
      if (r.from === HUMAN) v.youDealtIn++;
    }
    if (won(r, HUMAN) && r.from === o.seat) v.theyDealtIn++;
    next.vs[o.key] = v;
  }
  return { record: next, firsts };
}
