// Analytics for the Scores tab, read off ledger.ts's replay: one game's
// per-player stats (the 統計 card), the running-totals series (走勢), career
// stats across games, head-to-head and pattern counts.

import { replay, type HandResult, type ReplayState, type ScoreGame } from "./ledger";

export interface AtHand {
  value: number;
  hand: number; // 第N局
}

export interface PlayerStats {
  player: string;
  net: number;
  hands: number; // 局 they sat in
  wins: number; // 食胡 - off a discard
  selfDraws: number; // 自摸
  dealIns: number; // 出銃
  bonus: number; // 獎罰 net
  jackpot: number; // 彩池 won
  maxTai: AtHand | null; // 最高番數
  avgWinTai: number | null; // 平均食胡番
  avgDealInTai: number | null; // 平均出銃番
  pulls: number; // 拉人
  pulled: number; // 被拉
  kicks: number; // 踢人
  kicked: number; // 被踢
  maxPull: { count: number; times: number } | null; // 最高拉數 - longest chain
  maxPulled: { count: number; times: number } | null; // 最高被拉
  maxKicks: { count: number; times: number } | null; // 最高踢數 - most in one hand
  maxKicked: { count: number; times: number } | null; // 最高被踢
  multiWins: number; // 多響 - won as one of several off one discard
  fanXue: number; // 反雪
  bestHand: AtHand | null; // 最高得分
  worstHand: AtHand | null; // 最高失分
  selfDrawGain: number; // 總自摸得分
  selfDrawLoss: number; // 總自摸失分 - paying on others' 自摸
  discardGain: number; // 總出銃得分 - winning off a discard
  discardLoss: number; // 總出銃失分 - dealing in
  winStreak: number; // 連勝
  assists: number; // 助攻 - paying on someone else's 自摸
  assistRate: number | null; // 助攻率
  positiveRate: number | null; // 正分率 - hands ending with a running total above 0
  firstRate: number | null; // 首名率 - hands ending in first place (ties count)
  winRate: number | null; // hands won (食胡 or 自摸), of those sat in
  dealInRate: number | null; // hands dealt in, of those sat in
  perHand: number | null; // net per hand sat in
}

// Which way is good, for the 👑 (best at the table) and 💀 (worst) marks.
export const STAT_DIRECTION: Partial<Record<keyof PlayerStats, "high" | "low">> = {
  net: "high",
  wins: "high",
  selfDraws: "high",
  dealIns: "low",
  bonus: "high",
  jackpot: "high",
  pulls: "high",
  pulled: "low",
  kicks: "high",
  kicked: "low",
  multiWins: "high",
  fanXue: "high",
  selfDrawGain: "high",
  selfDrawLoss: "high", // losses are negative: closer to 0 is better
  discardGain: "high",
  discardLoss: "high",
  winStreak: "high",
  assists: "low",
  assistRate: "low",
  positiveRate: "high",
  firstRate: "high",
  winRate: "high",
  dealInRate: "low",
  perHand: "high",
};

const rate = (n: number, of: number) => (of > 0 ? n / of : null);

function chainStat(chains: number[]): { count: number; times: number } | null {
  if (chains.length === 0) return null;
  const max = Math.max(...chains);
  return { count: max, times: chains.filter((c) => c === max).length };
}

// The final length of each 拉 chain a player held (or was on the end of):
// every time a chain stops growing, its last count is one entry.
function chainLengths(hands: HandResult[]): { held: Map<string, number[]>; suffered: Map<string, number[]> } {
  const held = new Map<string, number[]>();
  const suffered = new Map<string, number[]>();
  const live = new Map<string, { holder: string; pulled: string; count: number }>();
  const close = (key: string) => {
    const c = live.get(key);
    if (!c) return;
    held.set(c.holder, [...(held.get(c.holder) ?? []), c.count]);
    suffered.set(c.pulled, [...(suffered.get(c.pulled) ?? []), c.count]);
    live.delete(key);
  };
  for (const h of hands) {
    if (h.kind !== "win") continue;
    const touched = new Set<string>();
    for (const p of h.pairs) {
      const key = `${p.winner}>${p.payer}`;
      touched.add(key);
      if (p.lahKind === "拉") live.set(key, { holder: p.winner, pulled: p.payer, count: (live.get(key)?.count ?? 1) + 1 });
      else {
        close(`${p.payer}>${p.winner}`);
        close(key);
        live.set(key, { holder: p.winner, pulled: p.payer, count: 1 });
      }
    }
    const winners = new Set(h.winners.map((w) => w.player));
    for (const [key, c] of [...live]) if (!touched.has(key) && !winners.has(c.holder)) close(key);
  }
  for (const key of [...live.keys()]) close(key);
  // A "chain" of one hand isn't a 拉 yet.
  for (const m of [held, suffered]) for (const [k, v] of m) m.set(k, v.filter((n) => n >= 2));
  return { held, suffered };
}

export function playerStats(state: ReplayState, game: ScoreGame): PlayerStats[] {
  const { hands } = state;
  const chains = chainLengths(hands);
  // 獎罰 and 彩池 hand-outs come from events outside hands.
  const bonus = new Map<string, number>();
  const jackpotShares = new Map<string, number>();
  game.events.forEach((ev, i) => {
    const step = state.steps.find((s) => s.eventIndex === i);
    if (!step) return;
    if (ev.t === "bonus" || ev.t === "zhaHu") for (const [p, d] of Object.entries(step.deltas)) bonus.set(p, (bonus.get(p) ?? 0) + d);
    if (ev.t === "jackpot") for (const s of ev.shares) jackpotShares.set(s.player, (jackpotShares.get(s.player) ?? 0) + s.amount);
  });

  return state.players.map((player) => {
    const seated = hands.filter((h) => h.seatsAfter.includes(player));
    const won = hands.filter((h) => h.winners.some((w) => w.player === player));
    const myTai = won.map((h) => ({ value: h.winners.find((w) => w.player === player)!.tai, hand: h.hand }));
    const dealtIn = hands.filter((h) => h.kind === "win" && !h.selfDraw && h.from === player);
    const paidSelfDraw = hands.filter((h) => h.selfDraw && h.winners[0].player !== player && h.seatsAfter.includes(player));
    const pairsAsWinner = hands.flatMap((h) => h.pairs.filter((p) => p.winner === player));
    const pairsAsPayer = hands.flatMap((h) => h.pairs.filter((p) => p.payer === player));
    const kicksPerHand = hands.map((h) => h.pairs.filter((p) => p.winner === player && p.lahKind === "踢").length).filter((n) => n > 0);
    const kickedPerHand = hands.map((h) => h.pairs.filter((p) => p.payer === player && p.lahKind === "踢").length).filter((n) => n > 0);
    const deltas = seated.map((h) => ({ value: h.deltas[player] ?? 0, hand: h.hand }));
    const best = deltas.filter((d) => d.value > 0).sort((a, b) => b.value - a.value || a.hand - b.hand)[0] ?? null;
    const worst = deltas.filter((d) => d.value < 0).sort((a, b) => a.value - b.value || a.hand - b.hand)[0] ?? null;
    const sum = (list: HandResult[]) => list.reduce((s, h) => s + (h.deltas[player] ?? 0), 0);

    let streak = 0;
    let winStreak = 0;
    for (const h of seated) {
      streak = h.winners.some((w) => w.player === player) ? streak + 1 : 0;
      winStreak = Math.max(winStreak, streak);
    }
    const positive = seated.filter((h) => (h.totalsAfter[player] ?? 0) > 0).length;
    const first = seated.filter((h) => {
      const mine = h.totalsAfter[player] ?? 0;
      return h.seatsAfter.every((p) => (h.totalsAfter[p] ?? 0) <= mine);
    }).length;

    return {
      player,
      net: state.totals[player] ?? 0,
      hands: seated.length,
      wins: won.filter((h) => !h.selfDraw).length,
      selfDraws: won.filter((h) => h.selfDraw).length,
      dealIns: dealtIn.length,
      bonus: bonus.get(player) ?? 0,
      jackpot: hands.reduce((s, h) => s + (h.jackpotWon?.player === player ? h.jackpotWon.amount : 0), 0) + (jackpotShares.get(player) ?? 0),
      maxTai: myTai.sort((a, b) => b.value - a.value || a.hand - b.hand)[0] ?? null,
      avgWinTai: myTai.length ? myTai.reduce((s, t) => s + t.value, 0) / myTai.length : null,
      avgDealInTai: dealtIn.length
        ? dealtIn.reduce((s, h) => s + h.winners.reduce((t, w) => t + w.tai, 0), 0) / dealtIn.length
        : null,
      pulls: pairsAsWinner.filter((p) => p.lahKind === "拉").length,
      pulled: pairsAsPayer.filter((p) => p.lahKind === "拉").length,
      kicks: pairsAsWinner.filter((p) => p.lahKind === "踢").length,
      kicked: pairsAsPayer.filter((p) => p.lahKind === "踢").length,
      maxPull: chainStat(chains.held.get(player) ?? []),
      maxPulled: chainStat(chains.suffered.get(player) ?? []),
      maxKicks: chainStat(kicksPerHand),
      maxKicked: chainStat(kickedPerHand),
      multiWins: won.filter((h) => h.multi > 1).length,
      fanXue: hands.filter((h) => h.fanXue.some((f) => f.to === player)).length,
      bestHand: best,
      worstHand: worst,
      selfDrawGain: sum(won.filter((h) => h.selfDraw)),
      selfDrawLoss: sum(paidSelfDraw),
      discardGain: sum(won.filter((h) => !h.selfDraw)),
      discardLoss: sum(dealtIn),
      winStreak,
      assists: paidSelfDraw.length,
      assistRate: rate(paidSelfDraw.length, seated.length),
      positiveRate: rate(positive, seated.length),
      firstRate: rate(first, seated.length),
      winRate: rate(won.length, seated.length),
      dealInRate: rate(dealtIn.length, seated.length),
      perHand: rate(state.totals[player] ?? 0, seated.length),
    };
  });
}

// 👑 / 💀 for one stat across the table: the best and worst players, or
// nothing when everyone is level.
export function marks(stats: PlayerStats[], key: keyof PlayerStats): Map<string, "best" | "worst"> {
  const dir = STAT_DIRECTION[key];
  const out = new Map<string, "best" | "worst">();
  if (!dir) return out;
  const values = stats
    .filter((s) => s.hands > 0)
    .map((s) => ({ p: s.player, v: s[key] as number | null }))
    .filter((x): x is { p: string; v: number } => typeof x.v === "number");
  if (values.length < 2) return out;
  const hi = Math.max(...values.map((x) => x.v));
  const lo = Math.min(...values.map((x) => x.v));
  if (hi === lo) return out;
  for (const x of values) {
    if (x.v === (dir === "high" ? hi : lo)) out.set(x.p, "best");
    else if (x.v === (dir === "high" ? lo : hi)) out.set(x.p, "worst");
  }
  return out;
}

// 走勢: each player's running total after every 局, from 0.
export function trend(state: ReplayState): { hands: number; series: { player: string; values: (number | null)[] }[] } {
  const series = state.players.map((player) => ({
    player,
    values: [0, ...state.hands.map((h) => (player in h.totalsAfter ? h.totalsAfter[player] : null))],
  }));
  return { hands: state.hands.length, series };
}

export interface CareerStats {
  player: string;
  games: number;
  hands: number;
  net: number;
  avgNet: number;
  firsts: number;
  wins: number;
  selfDraws: number;
  dealIns: number;
  winRate: number | null;
  dealInRate: number | null;
  bestHand: number | null;
}

export function careerStats(games: ScoreGame[]): CareerStats[] {
  const by = new Map<string, CareerStats>();
  for (const g of games) {
    const state = replay(g);
    if (state.hands.length === 0) continue;
    const stats = playerStats(state, g);
    const top = Math.max(...state.players.map((p) => state.totals[p] ?? 0));
    for (const s of stats) {
      if (s.hands === 0) continue;
      const c = by.get(s.player) ?? {
        player: s.player,
        games: 0,
        hands: 0,
        net: 0,
        avgNet: 0,
        firsts: 0,
        wins: 0,
        selfDraws: 0,
        dealIns: 0,
        winRate: null,
        dealInRate: null,
        bestHand: null,
      };
      c.games++;
      c.hands += s.hands;
      c.net += s.net;
      c.firsts += s.net === top ? 1 : 0;
      c.wins += s.wins;
      c.selfDraws += s.selfDraws;
      c.dealIns += s.dealIns;
      if (s.bestHand && (c.bestHand === null || s.bestHand.value > c.bestHand)) c.bestHand = s.bestHand.value;
      by.set(s.player, c);
    }
  }
  return [...by.values()]
    .map((c) => ({
      ...c,
      avgNet: c.net / c.games,
      winRate: rate(c.wins + c.selfDraws, c.hands),
      dealInRate: rate(c.dealIns, c.hands),
    }))
    .sort((a, b) => b.net - a.net);
}

// Net tai each player has taken off each other, across these games:
// result[a][b] > 0 means a is up on b.
export function headToHead(games: ScoreGame[]): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  const add = (a: string, b: string, v: number) => {
    out[a] ??= {};
    out[b] ??= {};
    out[a][b] = (out[a][b] ?? 0) + v;
    out[b][a] = (out[b][a] ?? 0) - v;
  };
  for (const g of games) {
    for (const h of replay(g).hands) {
      for (const p of h.pairs) add(p.winner, p.payer, p.worth);
      for (const f of h.fanXue) add(f.to, f.from, f.amount);
    }
  }
  return out;
}

// How often each pattern came up, in hands sent from the Scoring tab.
export function patternCounts(state: ReplayState): { name: string; count: number; byPlayer: Record<string, number> }[] {
  const by = new Map<string, { name: string; count: number; byPlayer: Record<string, number> }>();
  for (const h of state.hands) {
    for (const w of h.winners) {
      for (const p of w.patterns ?? []) {
        const e = by.get(p.id) ?? { name: p.name, count: 0, byPlayer: {} };
        e.count++;
        e.byPlayer[w.player] = (e.byPlayer[w.player] ?? 0) + 1;
        by.set(p.id, e);
      }
    }
  }
  return [...by.values()].sort((a, b) => b.count - a.count);
}
