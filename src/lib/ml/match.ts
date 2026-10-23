// Match-day context for the learned bots (encoding v2): what a player knows
// beyond the hand in front of them - the running scoreboard, how far into
// the day it is, what the day is being played for, and how each opponent
// has played so far. A real day is 60-100 hands; a lead late on is played
// differently from the same lead early, and a player who's been reckless
// all day is read differently from one who's only won big.
//
// The goal is a dial from 0 to 1 that the network gets as an input:
//   0   - pure tai: the day is worth its net tai, nothing else.
//   1   - placement weighs most: finishing 1st is worth PLACE_BONUS on top.
// Training plays every setting, so one network can be asked for any of
// them at the table.

import { SEATS, type GameState } from "@mjwaits/shared/engine/game";
import type { Rng } from "../bots";

export interface OppStats {
  hands: number; // hands seen this match
  wins: number;
  dealIns: number;
  calls: number; // chows, pungs and claimed kongs
  winTai: number; // total tai of their wins
  riichis: number; // hands they declared 叮
  bigWins: number; // wins of BIG_WIN tai or more
}

export interface MatchContext {
  totals: number[]; // net tai per seat this match, before the current hand
  hand: number; // hands already played (the current hand's 0-based index)
  length: number; // hands in the match
  goal: number; // 0 pure tai .. 1 placement weighs most
  stats: OppStats[]; // per seat
}

// Finishing 1st .. 4th at goal 1 (scaled by the goal). Per-hand nets swing
// ~30 tai, so a 80-hand day spreads a few hundred tai: these make the
// placing matter about as much as the tai.
export const PLACE_BONUS = [300, 100, -100, -300];
export const BIG_WIN = 60;

const noStats = (): OppStats => ({ hands: 0, wins: 0, dealIns: 0, calls: 0, winTai: 0, riichis: 0, bigWins: 0 });

export function newMatch(length: number, goal: number): MatchContext {
  return { totals: [0, 0, 0, 0], hand: 0, length, goal, stats: Array.from({ length: SEATS }, noStats) };
}

// A match joined part-way: a random point in the day and a plausible
// scoreboard for it (zero-sum, spread growing with the hands played), so
// training sees late, lopsided days far more often than whole days would
// give. Opponent stats start empty - the network knows how much it's seen.
export function randomMatch(rng: Rng, minLength = 60, maxLength = 100): MatchContext {
  const length = minLength + Math.floor(rng() * (maxLength - minLength + 1));
  const goal = Math.round(rng() * 4) / 4;
  const m = newMatch(length, goal);
  if (rng() < 0.5) return m; // half start at the beginning of the day
  m.hand = Math.floor(rng() * length * 0.9);
  const spread = 30 * Math.sqrt(m.hand);
  const raw = Array.from({ length: SEATS }, () => gaussian(rng) * spread);
  const mean = raw.reduce((a, b) => a + b, 0) / SEATS;
  m.totals = raw.map((v) => Math.round(v - mean));
  return m;
}

function gaussian(rng: Rng): number {
  const u = Math.max(rng(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

// Placing bonus for a seat (ties share the places they span).
export function placeBonus(totals: number[], seat: number): number {
  const above = totals.filter((t) => t > totals[seat]).length;
  const tied = totals.filter((t) => t === totals[seat]).length;
  let sum = 0;
  for (let p = above; p < above + tied; p++) sum += PLACE_BONUS[p];
  return sum / tied;
}

// What the day is worth to a seat with these totals, at this goal.
export const matchUtility = (totals: number[], seat: number, goal: number) => totals[seat] + goal * placeBonus(totals, seat);

// The context after a finished hand: totals, hand count, and what every
// seat showed in it.
export function afterHand(m: MatchContext, s: GameState): MatchContext {
  if (s.phase.kind !== "over") return m;
  const r = s.phase.result;
  const stats = m.stats.map((st, seat) => {
    const p = s.players[seat];
    const won = r.winner === seat;
    const tai = won ? (r.score?.total ?? 0) : 0;
    return {
      hands: st.hands + 1,
      wins: st.wins + (won ? 1 : 0),
      dealIns: st.dealIns + (r.from === seat && r.winner !== null ? 1 : 0),
      calls: st.calls + p.melds.filter((x) => x.from !== null).length,
      winTai: st.winTai + tai,
      riichis: st.riichis + (p.riichi ? 1 : 0),
      bigWins: st.bigWins + (won && tai >= BIG_WIN ? 1 : 0),
    };
  });
  return { ...m, totals: m.totals.map((t, i) => t + r.deltas[i]), hand: m.hand + 1, stats };
}

// The match inputs for `seat`, appended to the hand's observation (all
// small non-negative integers, as the rest of it). Opponents in turn order
// after us, as everywhere in the encoding.
export const MATCH_SCALARS = [
  "goal", // x 20
  "handsLeft", // capped 255
  "progress", // hands played / length, x 20
  "rank1", "rank2", "rank3", "rank4", // our place now, one-hot
  "myTotal", // net tai / 10, offset 128
  "opp1Gap", "opp2Gap", "opp3Gap", // their total - ours, / 10, offset 128
  ...[1, 2, 3].flatMap((r) => ["Hands", "WinRate", "DealInRate", "CallsPerHand", "AvgWin", "RiichiRate", "BigWinRate"].map((k) => `opp${r}${k}`)),
] as const;
export const NUM_MATCH_SCALARS = MATCH_SCALARS.length;

export function matchScalars(m: MatchContext, seat: number): number[] {
  const out: number[] = [];
  out.push(m.goal * 20, Math.max(0, m.length - m.hand), (m.hand / Math.max(1, m.length)) * 20);
  const place = m.totals.filter((t) => t > m.totals[seat]).length;
  for (let p = 0; p < SEATS; p++) out.push(place === p ? 1 : 0);
  out.push(m.totals[seat] / 10 + 128);
  for (let r = 1; r < SEATS; r++) out.push((m.totals[(seat + r) % SEATS] - m.totals[seat]) / 10 + 128);
  for (let r = 1; r < SEATS; r++) {
    const st = m.stats[(seat + r) % SEATS];
    const per = (x: number) => (st.hands ? x / st.hands : 0);
    out.push(st.hands, per(st.wins) * 100, per(st.dealIns) * 100, per(st.calls) * 20, st.wins ? st.winTai / st.wins / 2 : 0, per(st.riichis) * 100, per(st.bigWins) * 100);
  }
  return out;
}
