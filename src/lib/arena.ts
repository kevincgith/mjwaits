// The bot arena: four bots play hand after hand headless and every result
// is tallied per bot. Each wall is dealt four times with the bots rotated a
// seat each time ("duplicate" style), so every bot plays every seat on the
// same tiles and the luck of the deal largely cancels out.

import { botClaim, botTurnMove, applyTurnMove, dealHand, fullWall, resolveClaims, SEATS, type Claim, type GameState, type TurnMove, type WallTile } from "./game";
import { botClaimFor, botTurnMoveFor, profileById, seededRng, type BotProfile, type Rng } from "./bots";

// The original single-minded bot, kept as a yardstick.
export const BASELINE: BotProfile = { ...profileById("veteran"), id: "basic", name: "基本 Basic", blurb: "The original bot: tile efficiency only, no defence." };

export interface BotStats {
  id: string;
  name: string;
  hands: number;
  wins: number;
  selfDraws: number;
  dealIns: number;
  // Tai won and lost, and the net.
  taiWon: number;
  taiLost: number;
  dealInTai: number;
  // Discards made before winning, summed (for the average win speed).
  winTurns: number;
  calls: number;
  // Hands in which it declared 叮.
  riichis: number;
  biggestWin: number;
}

export interface ArenaResult {
  hands: number;
  draws: number;
  stats: BotStats[];
  ms: number;
}

function shuffledWall(rng: Rng): WallTile[] {
  const w = fullWall();
  for (let i = w.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [w[i], w[j]] = [w[j], w[i]];
  }
  return w;
}

function turnMove(s: GameState, profile: BotProfile, rng: Rng): TurnMove {
  return profile.id === "basic" ? botTurnMove(s) : botTurnMoveFor(s, profile, rng);
}

function claim(s: GameState, seat: number, profile: BotProfile, rng: Rng): Claim | null {
  return profile.id === "basic" ? botClaim(s, seat) : botClaimFor(s, seat, profile, rng);
}

// Plays one hand to the end; `seats[i]` is the profile at seat i.
// For calibrating threat(): called on every turn with the state, so the
// caller can compare what each seat shows against whether it's really ready.
export type Observer = (s: GameState) => void;

export function playHand(wall: WallTile[], dealer: number, seats: BotProfile[], rng: Rng, observe?: Observer): { end: GameState; calls: number[] } {
  let s = dealHand({ dealer, roundWind: 1, dealerStreak: 0 }, wall.slice());
  const calls = [0, 0, 0, 0];
  for (let steps = 0; s.phase.kind !== "over" && steps < 2000; steps++) {
    if (s.phase.kind === "turn") {
      observe?.(s);
      s = applyTurnMove(s, turnMove(s, seats[s.phase.seat], rng));
    } else {
      const decisions = Array.from({ length: SEATS }, (_, i) => claim(s, i, seats[i], rng));
      for (let i = 0; i < SEATS; i++) if (decisions[i] && decisions[i]!.kind !== "win") calls[i]++;
      s = resolveClaims(s, decisions);
    }
  }
  return { end: s, calls };
}

export function emptyStats(p: BotProfile): BotStats {
  return { id: p.id, name: p.name, hands: 0, wins: 0, selfDraws: 0, dealIns: 0, taiWon: 0, taiLost: 0, dealInTai: 0, winTurns: 0, calls: 0, riichis: 0, biggestWin: 0 };
}

// `walls` deals, each played under 4 rotations: 4 x walls hands in all.
export function runArena(bots: BotProfile[], walls: number, seed = 1, observe?: Observer): ArenaResult {
  if (bots.length !== SEATS) throw new Error("The arena needs four bots");
  const t0 = Date.now();
  const rng = seededRng(seed);
  const stats = bots.map(emptyStats);
  let hands = 0;
  let draws = 0;
  for (let w = 0; w < walls; w++) {
    const wall = shuffledWall(rng);
    const dealer = w % SEATS;
    for (let rot = 0; rot < SEATS; rot++) {
      // Bot b sits at seat (b + rot) % 4.
      const seats = Array.from({ length: SEATS }, (_, seat) => bots[(seat - rot + SEATS) % SEATS]);
      const botAt = (seat: number) => (seat - rot + SEATS) % SEATS;
      const { end, calls } = playHand(wall, dealer, seats, rng, observe);
      hands++;
      for (let seat = 0; seat < SEATS; seat++) {
        const st = stats[botAt(seat)];
        st.hands++;
        st.calls += calls[seat];
        if (end.players[seat].riichi) st.riichis++;
      }
      if (end.phase.kind !== "over") continue;
      const r = end.phase.result;
      if (r.winner === null) {
        draws++;
        continue;
      }
      const win = stats[botAt(r.winner)];
      win.wins++;
      if (r.from === null) win.selfDraws++;
      win.winTurns += end.players[r.winner].discards.length;
      win.biggestWin = Math.max(win.biggestWin, r.score?.total ?? 0);
      for (let seat = 0; seat < SEATS; seat++) {
        const d = r.deltas[seat];
        const st = stats[botAt(seat)];
        if (d > 0) st.taiWon += d;
        if (d < 0) st.taiLost -= d;
      }
      if (r.from !== null) {
        const loser = stats[botAt(r.from)];
        loser.dealIns++;
        loser.dealInTai -= r.deltas[r.from];
      }
    }
  }
  return { hands, draws, stats, ms: Date.now() - t0 };
}

export function mergeResults(parts: ArenaResult[]): ArenaResult {
  const out: ArenaResult = { hands: 0, draws: 0, stats: parts[0].stats.map((s) => ({ ...s, hands: 0, wins: 0, selfDraws: 0, dealIns: 0, taiWon: 0, taiLost: 0, dealInTai: 0, winTurns: 0, calls: 0, riichis: 0, biggestWin: 0 })), ms: 0 };
  for (const p of parts) {
    out.hands += p.hands;
    out.draws += p.draws;
    out.ms = Math.max(out.ms, p.ms);
    p.stats.forEach((s, i) => {
      const o = out.stats[i];
      for (const k of ["hands", "wins", "selfDraws", "dealIns", "taiWon", "taiLost", "dealInTai", "winTurns", "calls", "riichis"] as const) o[k] += s[k];
      o.biggestWin = Math.max(o.biggestWin, s.biggestWin);
    });
  }
  return out;
}

const pct = (n: number, d: number) => (d ? `${((100 * n) / d).toFixed(1)}%` : "-");
const avg = (n: number, d: number) => (d ? (n / d).toFixed(1) : "-");

// A plain-text table, best net tai first.
export function formatArena(r: ArenaResult): string {
  const rows = r.stats
    .map((s) => ({ s, net: s.taiWon - s.taiLost }))
    .sort((a, b) => b.net - a.net)
    .map(({ s, net }) => [
      s.name,
      (net / s.hands).toFixed(2),
      pct(s.wins, s.hands),
      pct(s.selfDraws, s.wins),
      pct(s.dealIns, s.hands),
      avg(s.taiWon, s.wins),
      avg(s.dealInTai, s.dealIns),
      avg(s.winTurns, s.wins),
      avg(s.calls, s.hands),
      pct(s.riichis, s.hands),
      String(s.biggestWin),
    ]);
  const head = ["Bot", "Net/hand", "Win", "Tsumo", "Deal-in", "Avg win", "Avg loss", "Win turn", "Calls/hand", "叮", "Best"];
  const table = [head, ...rows];
  const widths = head.map((_, c) => Math.max(...table.map((row) => [...row[c]].length + (c === 0 ? 2 : 0))));
  const line = (row: string[]) => row.map((cell, c) => (c === 0 ? cell.padEnd(widths[c]) : cell.padStart(widths[c]))).join("  ");
  return [
    `${r.hands} hands (${r.hands / 4} walls x 4 seatings), ${pct(r.draws, r.hands)} drawn, ${(r.ms / 1000).toFixed(1)}s`,
    line(head),
    ...rows.map(line),
  ].join("\n");
}
