// Analytics for the Scores tab, read off ledger.ts's replay: one game's
// per-player stats (the 統計 card), the running-totals series (走勢), career
// stats across games, head-to-head and pattern counts.

import { replay, type HandResult, type ReplayState, type ScoreGame } from "./ledger";

export interface AtHand {
  value: number;
  hand: number; // 第N局
  when?: string; // across games (career): which game, by its day
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
  // 做莊 - as dealer: hands dealt, their net, and the longest run of the deal (連莊).
  dealerHands: number;
  dealerNet: number;
  longestDealerRun: number;
  selfDrawShare: number | null; // 自摸比例 - of their wins, the share by 自摸
  avgWinGain: number | null; // 每次食糊平均贏 - points per hand won
  avgDealInLoss: number | null; // 每次出銃平均輸 - points per deal-in (negative)
  lahNet: number; // 拉踢淨額 - what 拉 and 踢 add-ons made them, less what they paid
  // 對手 - net against each other player this game (every payment between
  // the two: hands, 反雪, 獎罰, 詐胡), best first.
  opponents: { player: string; net: number }[];
  // 走勢 - read off the running total after each hand they sat in (from 0).
  peak: AtHand | null; // 最高位
  trough: AtHand | null; // 最低位
  maxDrawdown: Swing | null; // 最大回落 - a high to a later low (negative)
  maxRunUp: Swing | null; // 最大升幅 - a low to a later high
  recovery: number; // 谷底反彈 - won back since the lowest point
  longestLosingRun: number; // 最長連跌 - hands in a row losing points
  recent: { hands: number; net: number }; // 近況 - the last RECENT_HANDS hands
  avgSwing: number | null; // 平均波幅 - points moved per hand, either way
}

export interface Swing {
  value: number;
  from: number; // 第N局 it started from (0: the start)
  to: number;
  fromWhen?: string; // across games (career): which games, by their day
  toWhen?: string;
}

// 近況 looks back this many hands.
export const RECENT_HANDS = 8;

// Which way is good, for the 👍 (best at the table) and 👎 (lowest) marks.
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
  dealerNet: "high",
  longestDealerRun: "high",
  selfDrawShare: "high",
  avgWinGain: "high",
  avgDealInLoss: "high", // negative: closer to 0 is better
  lahNet: "high",
  // Records: bigger is better, and a smaller worst hand (closer to 0) too.
  maxTai: "high",
  avgWinTai: "high",
  avgDealInTai: "low",
  bestHand: "high",
  worstHand: "high",
  maxPull: "high",
  dealerHands: "high",
  peak: "high",
  trough: "high", // a shallower low is better
  maxDrawdown: "high", // negative: a smaller drop is better
  maxRunUp: "high",
  recovery: "high",
  longestLosingRun: "low",
  recent: "high",
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
      ...dealing(hands, player),
      selfDrawShare: rate(won.filter((h) => h.selfDraw).length, won.length),
      avgWinGain: rate(sum(won), won.length),
      avgDealInLoss: rate(sum(dealtIn), dealtIn.length),
      lahNet:
        pairsAsWinner.reduce((t, p) => t + (p.lahKind ? p.lah : 0), 0) - pairsAsPayer.reduce((t, p) => t + (p.lahKind ? p.lah : 0), 0),
      ...trendOf(seated, player),
      opponents: state.players
        .filter((q) => q !== player)
        .map((q) => ({ player: q, net: (state.paid[`${q}>${player}`] ?? 0) - (state.paid[`${player}>${q}`] ?? 0) }))
        .filter((o) => o.net !== 0)
        .sort((a, b) => b.net - a.net),
    };
  });
}

// 走勢 for one player: the running total after each hand they sat in,
// starting from 0, and what it did - its high and low, the deepest fall and
// biggest climb, how much came back since the low, the longest losing run,
// recent form and how much it moved per hand.
function trendOf(seated: HandResult[], player: string) {
  return curve([{ hand: 0, v: 0 }, ...seated.map((h) => ({ hand: h.hand, v: h.totalsAfter[player] ?? 0 }))]);
}

// What a running total did, point by point from its start: one game's, or a
// whole career's laid end to end (when: which game each point is in).
type CurvePoint = { hand: number; v: number; when?: string };
function curve(points: CurvePoint[]) {
  const deltas = points.slice(1).map((p, i) => p.v - points[i].v);
  let peak: AtHand | null = null;
  let trough: AtHand | null = null;
  let maxDrawdown: Swing | null = null;
  let maxRunUp: Swing | null = null;
  let hi = points[0];
  let lo = points[0];
  for (const p of points.slice(1)) {
    if (!peak || p.v > peak.value) peak = { value: p.v, hand: p.hand, ...(p.when ? { when: p.when } : {}) };
    if (!trough || p.v < trough.value) trough = { value: p.v, hand: p.hand, ...(p.when ? { when: p.when } : {}) };
    const span = (a: CurvePoint, b: CurvePoint) => ({ from: a.hand, to: b.hand, ...(b.when ? { fromWhen: a.when, toWhen: b.when } : {}) });
    if (p.v - hi.v < (maxDrawdown?.value ?? 0)) maxDrawdown = { value: p.v - hi.v, ...span(hi, p) };
    if (p.v - lo.v > (maxRunUp?.value ?? 0)) maxRunUp = { value: p.v - lo.v, ...span(lo, p) };
    if (p.v > hi.v) hi = p;
    if (p.v < lo.v) lo = p;
  }
  let run = 0;
  let longestLosingRun = 0;
  for (const d of deltas) {
    run = d < 0 ? run + 1 : 0;
    longestLosingRun = Math.max(longestLosingRun, run);
  }
  const last = points[points.length - 1].v;
  const low = Math.min(0, ...points.map((p) => p.v));
  const recentFrom = points[Math.max(0, points.length - 1 - RECENT_HANDS)].v;
  return {
    peak,
    trough,
    maxDrawdown,
    maxRunUp,
    recovery: last - low,
    longestLosingRun,
    recent: { hands: Math.min(RECENT_HANDS, points.length - 1), net: last - recentFrom },
    avgSwing: deltas.length ? deltas.reduce((t, d) => t + Math.abs(d), 0) / deltas.length : null,
  };
}

// The game's 走勢 in a few facts: how often the lead changed hands, who led
// for the most hands, and the biggest comeback (from a player's low to where
// they finished).
export function trendSummary(state: ReplayState): {
  leadChanges: number;
  mostLed: { player: string; hands: number } | null;
  comeback: { player: string; from: number; to: number } | null;
} {
  let leader: string | null = null;
  let leadChanges = 0;
  const led = new Map<string, number>();
  for (const h of state.hands) {
    const top = Math.max(...h.seatsAfter.map((p) => h.totalsAfter[p] ?? 0));
    const leaders = h.seatsAfter.filter((p) => (h.totalsAfter[p] ?? 0) === top);
    for (const p of leaders) led.set(p, (led.get(p) ?? 0) + 1);
    // A change is a new sole leader; a tie holds whoever had it.
    if (leaders.length === 1 && leaders[0] !== leader) {
      if (leader !== null) leadChanges++;
      leader = leaders[0];
    }
  }
  const mostLed = [...led].sort((a, b) => b[1] - a[1])[0];
  let comeback: { player: string; from: number; to: number } | null = null;
  for (const player of state.players) {
    const totals = state.hands.filter((h) => player in h.totalsAfter).map((h) => h.totalsAfter[player]);
    if (totals.length === 0) continue;
    const low = Math.min(0, ...totals);
    const end = state.totals[player] ?? 0;
    if (low < 0 && end - low > (comeback ? comeback.to - comeback.from : 0)) comeback = { player, from: low, to: end };
  }
  return { leadChanges, mostLed: mostLed && mostLed[1] > 0 ? { player: mostLed[0], hands: mostLed[1] } : null, comeback };
}

// 做莊: the hands a player dealt, what they made from them, and the most
// hands they dealt in a row - a hand dealt at 連N is the (N+1)th running.
function dealing(hands: HandResult[], player: string) {
  const mine = hands.filter((h) => h.dealer === player);
  return {
    dealerHands: mine.length,
    dealerNet: mine.reduce((t, h) => t + (h.deltas[player] ?? 0), 0),
    longestDealerRun: Math.max(0, ...mine.map((h) => h.streak + 1)),
  };
}

// 👍 / 👎 for one stat across the table: the best and worst players, or
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

// The table ranked on one stat, best first - 1 is best whichever way is good
// for it, ties share a place (two firsts, then third). Players with no value
// for it (a rate with nothing to rate) come last, unranked.
export function rankedBy(stats: PlayerStats[], key: keyof PlayerStats): { player: string; rank: number | null }[] {
  const dir = STAT_DIRECTION[key] ?? "high";
  const num = (s: PlayerStats): number | null => {
    const v = s[key] as unknown;
    if (typeof v === "number") return v;
    if (v && typeof v === "object" && "value" in v) return (v as { value: number }).value;
    if (v && typeof v === "object" && "count" in v) return (v as { count: number }).count;
    if (v && typeof v === "object" && "net" in v) return (v as { net: number }).net;
    return null;
  };
  const scored = stats.filter((s) => s.hands > 0).map((s) => ({ player: s.player, v: num(s) }));
  const better = (a: number, b: number) => (dir === "high" ? a > b : a < b);
  return scored
    .map((x) => ({ player: x.player, v: x.v, rank: x.v === null ? null : 1 + scored.filter((y) => y.v !== null && better(y.v, x.v!)).length }))
    .sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity))
    .map(({ player, rank }) => ({ player, rank }));
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
  // As in a game's 玩家 card, across every game.
  dealerHands: number;
  dealerNet: number;
  longestDealerRun: number;
  selfDrawShare: number | null;
  avgWinGain: number | null;
  avgDealInLoss: number | null;
  lahNet: number;
  firstRate: number | null; // 領先 - hands spent in 1st, of all hands sat in
}

export function careerStats(games: ScoreGame[]): CareerStats[] {
  const by = new Map<string, CareerStats>();
  // Running sums for the averages: points won, points lost dealing in, and
  // hands spent in 1st.
  const totals = new Map<string, { won: number; dealtIn: number; inFirst: number }>();
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
        dealerHands: 0,
        dealerNet: 0,
        longestDealerRun: 0,
        selfDrawShare: null,
        avgWinGain: null,
        avgDealInLoss: null,
        lahNet: 0,
        firstRate: null,
      };
      const t = totals.get(s.player) ?? { won: 0, dealtIn: 0, inFirst: 0 };
      c.games++;
      c.hands += s.hands;
      c.net += s.net;
      c.firsts += s.net === top ? 1 : 0;
      c.wins += s.wins;
      c.selfDraws += s.selfDraws;
      c.dealIns += s.dealIns;
      if (s.bestHand && (c.bestHand === null || s.bestHand.value > c.bestHand)) c.bestHand = s.bestHand.value;
      c.dealerHands += s.dealerHands;
      c.dealerNet += s.dealerNet;
      c.longestDealerRun = Math.max(c.longestDealerRun, s.longestDealerRun);
      c.lahNet += s.lahNet;
      t.won += s.selfDrawGain + s.discardGain;
      t.dealtIn += s.discardLoss;
      t.inFirst += (s.firstRate ?? 0) * s.hands;
      totals.set(s.player, t);
      by.set(s.player, c);
    }
  }
  return [...by.values()]
    .map((c) => {
      const t = totals.get(c.player) ?? { won: 0, dealtIn: 0, inFirst: 0 };
      return {
        ...c,
        avgNet: c.net / c.games,
        winRate: rate(c.wins + c.selfDraws, c.hands),
        dealInRate: rate(c.dealIns, c.hands),
        selfDrawShare: rate(c.selfDraws, c.wins + c.selfDraws),
        avgWinGain: rate(t.won, c.wins + c.selfDraws),
        avgDealInLoss: rate(t.dealtIn, c.dealIns),
        firstRate: rate(Math.round(t.inFirst), c.hands),
      };
    })
    .sort((a, b) => b.net - a.net);
}

// The 玩家 card's stats over every game a player sat in, so a career reads
// exactly like one game: counts and points added up, rates and averages
// worked out again from those totals (not averaged), records the best of
// any game (with the game's day), opponents summed, and 走勢 read off one
// running total through the games in the order they were played.
export function careerPlayerStats(games: ScoreGame[], dayOf: (at: number) => string): { stats: PlayerStats[]; series: Map<string, number[]> } {
  const played = games.slice().sort((a, b) => a.startedAt - b.startedAt);
  const per = new Map<string, { s: PlayerStats; game: ScoreGame }[]>();
  const points = new Map<string, CurvePoint[]>();
  // Each player's career total before the game - each game's curve starts there.
  const carried = new Map<string, number>();
  for (const g of played) {
    const state = replay(g);
    if (state.hands.length === 0) continue;
    const when = dayOf(g.startedAt);
    for (const s of playerStats(state, g)) {
      if (s.hands === 0) continue;
      per.set(s.player, [...(per.get(s.player) ?? []), { s, game: g }]);
      const line = points.get(s.player) ?? [{ hand: 0, v: 0 }];
      const base = carried.get(s.player) ?? 0;
      for (const h of state.hands) if (h.seatsAfter.includes(s.player)) line.push({ hand: h.hand, v: base + (h.totalsAfter[s.player] ?? 0), when });
      points.set(s.player, line);
      carried.set(s.player, base + s.net);
    }
  }
  const stats = [...per].map(([player, list]): PlayerStats => {
    const sum = (f: (s: PlayerStats) => number) => list.reduce((t, x) => t + f(x.s), 0);
    const when = (g: ScoreGame) => dayOf(g.startedAt);
    // The best (or worst) record of any game, tagged with that game's day.
    const record = (f: (s: PlayerStats) => AtHand | null, better: (a: number, b: number) => boolean): AtHand | null =>
      list.reduce<AtHand | null>((best, x) => {
        const r = f(x.s);
        return r && (!best || better(r.value, best.value)) ? { ...r, when: when(x.game) } : best;
      }, null);
    const chainMax = (f: (s: PlayerStats) => { count: number; times: number } | null) => {
      const all = list.map((x) => f(x.s)).filter((c): c is { count: number; times: number } => c !== null);
      if (all.length === 0) return null;
      const count = Math.max(...all.map((c) => c.count));
      return { count, times: all.filter((c) => c.count === count).reduce((t, c) => t + c.times, 0) };
    };
    const hands = sum((s) => s.hands);
    const wins = sum((s) => s.wins);
    const selfDraws = sum((s) => s.selfDraws);
    const dealIns = sum((s) => s.dealIns);
    const net = sum((s) => s.net);
    const won = wins + selfDraws;
    const weighted = (f: (s: PlayerStats) => number | null, w: (s: PlayerStats) => number) => {
      const of = sum(w);
      return of > 0 ? list.reduce((t, x) => t + (f(x.s) ?? 0) * w(x.s), 0) / of : null;
    };
    const opp = new Map<string, number>();
    for (const x of list) for (const o of x.s.opponents) opp.set(o.player, (opp.get(o.player) ?? 0) + o.net);
    return {
      player,
      net,
      hands,
      wins,
      selfDraws,
      dealIns,
      bonus: sum((s) => s.bonus),
      jackpot: sum((s) => s.jackpot),
      maxTai: record((s) => s.maxTai, (a, b) => a > b),
      avgWinTai: weighted((s) => s.avgWinTai, (s) => s.wins + s.selfDraws),
      avgDealInTai: weighted((s) => s.avgDealInTai, (s) => s.dealIns),
      pulls: sum((s) => s.pulls),
      pulled: sum((s) => s.pulled),
      kicks: sum((s) => s.kicks),
      kicked: sum((s) => s.kicked),
      maxPull: chainMax((s) => s.maxPull),
      maxPulled: chainMax((s) => s.maxPulled),
      maxKicks: chainMax((s) => s.maxKicks),
      maxKicked: chainMax((s) => s.maxKicked),
      multiWins: sum((s) => s.multiWins),
      fanXue: sum((s) => s.fanXue),
      bestHand: record((s) => s.bestHand, (a, b) => a > b),
      worstHand: record((s) => s.worstHand, (a, b) => a < b),
      selfDrawGain: sum((s) => s.selfDrawGain),
      selfDrawLoss: sum((s) => s.selfDrawLoss),
      discardGain: sum((s) => s.discardGain),
      discardLoss: sum((s) => s.discardLoss),
      winStreak: Math.max(...list.map((x) => x.s.winStreak)),
      assists: sum((s) => s.assists),
      assistRate: rate(sum((s) => s.assists), hands),
      positiveRate: weighted((s) => s.positiveRate, (s) => s.hands),
      firstRate: weighted((s) => s.firstRate, (s) => s.hands),
      winRate: rate(won, hands),
      dealInRate: rate(dealIns, hands),
      perHand: rate(net, hands),
      dealerHands: sum((s) => s.dealerHands),
      dealerNet: sum((s) => s.dealerNet),
      longestDealerRun: Math.max(...list.map((x) => x.s.longestDealerRun)),
      selfDrawShare: rate(selfDraws, won),
      avgWinGain: rate(sum((s) => s.selfDrawGain + s.discardGain), won),
      avgDealInLoss: rate(sum((s) => s.discardLoss), dealIns),
      lahNet: sum((s) => s.lahNet),
      opponents: [...opp].filter(([, v]) => v !== 0).map(([p, v]) => ({ player: p, net: v })).sort((a, b) => b.net - a.net),
      ...curve(points.get(player) ?? [{ hand: 0, v: 0 }]),
    };
  });
  const series = new Map([...points].map(([p, line]) => [p, line.map((x) => x.v)]));
  return { stats: stats.sort((a, b) => b.net - a.net), series };
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
