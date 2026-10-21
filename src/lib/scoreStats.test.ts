import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, newGame, replay, type ScoreEvent, type ScoreGame } from "./ledger";
import { careerStats, headToHead, marks, patternCounts, playerStats, trend } from "./scoreStats";

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

  it("nets head-to-head both ways", () => {
    const h = headToHead([g1, g2]);
    expect(h.A.B).toBe(-h.B.A);
  });
});
