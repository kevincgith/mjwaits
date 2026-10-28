import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, newGame, replay, type ScoreEvent, type ScoreGame } from "@mjwaits/shared/engine/ledger";
import { careerPlayerStats, careerStats, careerTrend, smoothed, headToHead, marks, patternCounts, playerStats, rankedBy, trend, trendSummary } from "./scoreStats";

const PLAIN = { ...DEFAULT_SETTINGS, dealerTai: 0, streakTai: 0, jackpot: false };
const game = (events: ScoreEvent[], seats = ["A", "B", "C", "D"]): ScoreGame => ({ ...newGame(seats, 0, PLAIN), events });
const win = (seat: number, tai: number, from: number | null): ScoreEvent => ({ t: "win", at: 0, winners: [{ seat, tai }], from, source: "quick" });

// A wins off B twice (a 拉 of 2), B 踢s back, C self-draws, a draw, then a
// 雙響 off D (A 8, B 5) and D's 反雪 自摸.
const EVENTS: ScoreEvent[] = [
  win(0, 10, 1), // A +10, B -10
  win(0, 4, 1), // 拉: 4 + 5 = 9
  win(1, 6, 0), // 踢: 6 + ceil(19/2) = 16
  win(2, 3, null), // C 自摸 3 each
  { t: "draw", at: 0 },
  { t: "win", at: 0, winners: [{ seat: 0, tai: 8, patterns: [{ id: "x", name: "清一色", tai: 8 }] }, { seat: 1, tai: 5 }], from: 3, source: "scoring" },
  win(3, 2, null),
  { t: "bonus", at: 0, seat: 2, amount: 1, kind: "獎" },
];

describe("playerStats", () => {
  const g = game(EVENTS);
  const state = replay(g);
  const stats = Object.fromEntries(playerStats(state, g).map((s) => [s.player, s]));

  it("counts wins, 自摸, 出銃 and multi-wins", () => {
    expect(stats.A).toMatchObject({ wins: 3, selfDraws: 0, dealIns: 1, multiWins: 1, hands: 7 });
    expect(stats.C).toMatchObject({ wins: 0, selfDraws: 1, assists: 1 });
    expect(stats.D).toMatchObject({ dealIns: 1, selfDraws: 1, fanXue: 1 });
  });

  it("tracks 拉 and 踢, and the longest chain", () => {
    // Kicked twice: by B in 局3, and by D's 反雪 自摸 in 局7 (A won off D in the 雙響).
    expect(stats.A).toMatchObject({ pulls: 1, kicked: 2, maxPull: { count: 2, times: 1 } });
    expect(stats.B).toMatchObject({ pulled: 1, kicks: 1, maxPulled: { count: 2, times: 1 } });
  });

  it("finds the biggest hand, best and worst results, and the 獎罰 net", () => {
    expect(stats.A.maxTai).toEqual({ value: 10, hand: 1 });
    expect(stats.B.worstHand).toEqual({ value: -10, hand: 1 });
    expect(stats.C.bonus).toBe(3);
    expect(stats.A.bonus).toBe(-1);
  });

  it("works out rates over the hands a player sat in", () => {
    expect(stats.A.winStreak).toBe(2);
    expect(stats.C.assistRate).toBeCloseTo(1 / 7);
    expect(stats.A.positiveRate).toBeGreaterThan(0);
  });

  it("做莊: hands dealt, their net, and the longest run of the deal", () => {
    // A deals 局1-3 (連0, 連1, 連2): +10, +9, -16.
    expect(stats.A).toMatchObject({ dealerHands: 3, dealerNet: 3, longestDealerRun: 3 });
    // C deals 局4 and keeps it through the 流局.
    expect(stats.C).toMatchObject({ dealerHands: 2, longestDealerRun: 2 });
  });

  it("averages per win and per deal-in, and the share of wins by 自摸", () => {
    expect(stats.B.avgDealInLoss).toBe(-9.5);
    expect(stats.D.avgWinGain).toBe(23);
    expect(stats.C.selfDrawShare).toBe(1);
    expect(stats.A.selfDrawShare).toBe(0);
    expect(stats.C.avgDealInLoss).toBeNull();
  });

  it("拉踢淨額: what 拉 and 踢 add-ons made, less what they paid", () => {
    // A: +5 拉 in 局2, then 踢 by B (-10) and by D's 自摸 (-4).
    expect(stats.A.lahNet).toBe(-9);
    expect(stats.D.lahNet).toBe(7);
  });

  it("對手: net against each other player, best first, adding up to the net", () => {
    expect(stats.A.opponents).toEqual([
      { player: "B", net: 3 },
      { player: "D", net: -3 },
      { player: "C", net: -4 },
    ]);
    for (const s of Object.values(stats)) expect(s.opponents.reduce((t, o) => t + o.net, 0)).toBe(s.net);
  });

  it("ranks the table on any stat, best first, ties sharing a place", () => {
    const all = playerStats(state, g);
    // 出銃: fewer is better - C never dealt in.
    expect(rankedBy(all, "dealIns")[0]).toEqual({ player: "C", rank: 1 });
    // C and D each self-drew once: joint first, the rest third.
    const sd = rankedBy(all, "selfDraws");
    expect(sd.slice(0, 2).map((x) => x.rank)).toEqual([1, 1]);
    expect(sd[2].rank).toBe(3);
    // A record ({ value }) ranks by its value; a missing rate comes last, unranked.
    expect(rankedBy(all, "maxTai")[0].player).toBe("A");
    expect(rankedBy(all, "avgDealInTai").at(-1)).toEqual({ player: "C", rank: null });
  });

  it("走勢: high and low, the deepest fall and biggest climb, form and swing", () => {
    // A runs 0, 10, 19, 3, 0, 0, 8, -3 (局7: D's 自摸, its 踢 and 反雪).
    expect(stats.A.peak).toEqual({ value: 19, hand: 2 });
    expect(stats.A.trough).toEqual({ value: -3, hand: 7 });
    expect(stats.A.maxDrawdown).toEqual({ value: -22, from: 2, to: 7 });
    expect(stats.A.maxRunUp).toEqual({ value: 19, from: 0, to: 2 });
    expect(stats.A.recovery).toBe(0);
    expect(stats.A.longestLosingRun).toBe(2);
    expect(stats.A.recent).toEqual({ hands: 7, net: -3 });
    expect(stats.A.avgSwing).toBeCloseTo(57 / 7);
  });

  it("marks the best and worst at the table", () => {
    const all = playerStats(state, g);
    const m = marks(all, "dealIns");
    expect(m.get("C")).toBe("best");
    expect([...m.values()]).toContain("worst");
    expect(marks(all, "hands").size).toBe(0);
  });
});

describe("trend, patterns, career and head-to-head", () => {
  const g1 = game(EVENTS);
  const g2 = game([win(1, 20, 0)]);

  it("charts running totals from 0", () => {
    const t = trend(replay(g1));
    expect(t.hands).toBe(7);
    expect(t.series.find((s) => s.player === "A")!.values.slice(0, 3)).toEqual([0, 10, 19]);
  });

  it("counts patterns from Scoring hands", () => {
    expect(patternCounts(replay(g1))).toEqual([{ name: "清一色", count: 1, byPlayer: { A: 1 } }]);
  });

  it("adds up careers across games", () => {
    const c = Object.fromEntries(careerStats([g1, g2]).map((s) => [s.player, s]));
    expect(c.B.games).toBe(2);
    expect(c.B.net).toBe(replay(g1).totals.B + 20);
  });

  it("sums up a game's 走勢: lead changes, who led most, the biggest comeback", () => {
    // A leads; B's 30 off A (a 踢: +5) puts B ahead, A down 25; A takes
    // the lead back with 51 off C.
    const st = replay(game([win(0, 10, 1), win(1, 30, 0), win(0, 51, 2)]));
    expect(trendSummary(st)).toEqual({ leadChanges: 2, mostLed: { player: "A", hands: 2 }, comeback: { player: "A", from: -25, to: 26 } });
    // One hand: nobody came back from anything.
    expect(trendSummary(replay(g2)).comeback).toBeNull();
  });

  it("a one-game career reads exactly like that game", () => {
    const one = Object.fromEntries(playerStats(replay(g1), g1).map((x) => [x.player, x]));
    const career = careerPlayerStats([g1], () => "d").stats;
    for (const c of career) {
      const { maxTai, bestHand, worstHand, peak, trough, maxDrawdown, maxRunUp, ...rest } = c;
      const { maxTai: m1, bestHand: b1, worstHand: w1, peak: p1, trough: t1, maxDrawdown: d1, maxRunUp: r1, ...rest1 } = one[c.player];
      expect(rest).toEqual(rest1);
      expect(maxTai?.value).toBe(m1?.value);
      expect(bestHand?.value).toBe(b1?.value);
      expect(worstHand?.value).toBe(w1?.value);
      expect([peak?.value, trough?.value, maxDrawdown?.value, maxRunUp?.value]).toEqual([p1?.value, t1?.value, d1?.value, r1?.value]);
    }
  });

  it("adds a career up across games, 走勢 running through them in order", () => {
    const later = { ...g2, startedAt: g1.startedAt + 1 };
    const { stats: list, series } = careerPlayerStats([later, g1], (at) => (at === g1.startedAt ? "g1" : "g2"));
    const c = Object.fromEntries(list.map((x) => [x.player, x]));
    expect(c.A).toMatchObject({ hands: 8, net: -24, dealerHands: 4, dealerNet: -17, longestDealerRun: 3 });
    // A's curve: g1's 0 … -3 (its 獎罰 after the last hand makes it -4),
    // then g2 from -4: -24.
    expect(series.get("A")!.at(-1)).toBe(-24);
    expect(c.A.trough).toEqual({ value: -24, hand: 1, when: "g2" });
    expect(c.A.maxDrawdown).toEqual({ value: -43, from: 2, to: 1, fromWhen: "g1", toWhen: "g2" });
    // Records carry the game they came from; opponents add up to the net.
    expect(c.A.maxTai).toEqual({ value: 10, hand: 1, when: "g1" });
    for (const x of list) expect(x.opponents.reduce((t, o) => t + o.net, 0)).toBe(x.net);
  });

  it("head-to-head counts every payment, matching each player's 對手", () => {
    const h = headToHead([g1]);
    for (const x of playerStats(replay(g1), g1)) for (const o of x.opponents) expect(h[x.player][o.player]).toBe(o.net);
  });

  it("nets head-to-head both ways", () => {
    const h = headToHead([g1, g2]);
    expect(h.A.B).toBe(-h.B.A);
  });
});

describe("careerTrend", () => {
  it("everyone's career total hand by hand, flat through hands and games they missed", () => {
    const g1 = { ...game([win(0, 10, 1), win(0, 2, 2)]), id: "g1", startedAt: 1 };
    const g2 = { ...game([win(2, 4, 3)], ["A", "B", "C", "E"]), id: "g2", startedAt: 2 };
    const empty = { ...game([]), id: "g0", startedAt: 0 };
    const t = careerTrend([g2, empty, g1], (at) => `day${at}`);
    expect(t.hands).toBe(3);
    expect(t.labels).toEqual(["Start", "day1 · 第1局", "day1 · 第2局", "day2 · 第1局"]);
    expect(t.starts).toEqual([0, 2]);
    const by = Object.fromEntries(t.series.map((s) => [s.player, s.values]));
    // 局2 is off C: A +2, C -2.
    expect(by.A).toEqual([0, 10, 12, 12]);
    expect(by.C).toEqual([0, 0, -2, 2]);
    expect(by.E).toEqual([0, 0, 0, -4]);
  });
});

describe("smoothed", () => {
  it("averages over a centred window, fewer points at the ends", () => {
    expect(smoothed([0, 3, 6, 9], 1)).toEqual([0, 3, 6, 9]);
    expect(smoothed([0, 3, 6, 9], 3)).toEqual([1.5, 3, 6, 7.5]);
    expect(smoothed([0, null, 6], 3)).toEqual([0, null, 6]);
  });
});
