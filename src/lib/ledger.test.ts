import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  newGame,
  replay,
  settle,
  undoEvent,
  withEvent,
  type ScoreEvent,
  type ScoreGame,
  type ScoreSettings,
} from "./ledger";

// No 莊 / Jackpot noise unless a test asks for it: A, B, C, D at seats 0-3, A deals.
const PLAIN: ScoreSettings = { ...DEFAULT_SETTINGS, dealerTai: 0, streakTai: 0, jackpot: false };

function game(events: ScoreEvent[], settings: Partial<ScoreSettings> = {}): ScoreGame {
  return { ...newGame(["A", "B", "C", "D"], 0, { ...PLAIN, ...settings }), events };
}

const win = (seat: number, tai: number, from: number | null, extra: Partial<Extract<ScoreEvent, { t: "win" }>> = {}): ScoreEvent => ({
  t: "win",
  at: 0,
  winners: [{ seat, tai }],
  from,
  source: "quick",
  ...extra,
});
const multi = (from: number, ...winners: [number, number][]): ScoreEvent => ({
  t: "win",
  at: 0,
  winners: winners.map(([seat, tai]) => ({ seat, tai })),
  from,
  source: "quick",
});
const draw: ScoreEvent = { t: "draw", at: 0 };

const sumsToZero = (s: ReturnType<typeof replay>) =>
  expect(Object.values(s.totals).reduce((a, b) => a + b, 0) + s.pot).toBeCloseTo(0);

describe("拉 / 踢", () => {
  it("builds a 拉 by half each time: 11, then 20 is worth 26 (拉 37), then 15 is worth 34", () => {
    const s = replay(game([win(0, 11, 1), win(0, 20, 1), win(0, 15, 1)]));
    expect(s.hands.map((h) => h.pairs[0].worth)).toEqual([11, 26, 34]);
    expect(s.hands[1].pairs[0]).toMatchObject({ lahKind: "拉", lah: 6, lahBefore: 11 });
    expect(s.lahs).toEqual([{ holder: "A", pulled: "B", value: 37 + 34, count: 3 }]);
    expect(s.totals).toMatchObject({ A: 71, B: -71 });
  });

  it("踢: 拉 29, then the pulled player wins 20 back - worth 35, and their new 拉 is 20", () => {
    const s = replay(game([win(0, 29, 1), win(1, 20, 0)]));
    expect(s.hands[1].pairs[0]).toMatchObject({ winner: "B", payer: "A", lahKind: "踢", lah: 15, worth: 35 });
    expect(s.lahs).toEqual([{ holder: "B", pulled: "A", value: 20, count: 1 }]);
  });

  it("rounds the half down when asked, and keeps it exact outside 整數模式", () => {
    expect(replay(game([win(0, 11, 1), win(0, 20, 1)], { lahRound: "down" })).hands[1].pairs[0].worth).toBe(25);
    expect(replay(game([win(0, 11, 1), win(0, 20, 1)], { integerMode: false })).hands[1].pairs[0].worth).toBe(25.5);
  });

  it("自摸 counts per payer: an existing 拉 grows, the others start fresh", () => {
    const s = replay(game([win(0, 10, 1), win(0, 4, null)]));
    const worth = Object.fromEntries(s.hands[1].pairs.map((p) => [p.payer, p.worth]));
    expect(worth).toEqual({ B: 9, C: 4, D: 4 });
    expect(s.lahs.find((l) => l.pulled === "B")).toMatchObject({ value: 19, count: 2 });
  });

  it("a draw keeps every 拉; another player's win ends it; 投降 ends it", () => {
    expect(replay(game([win(0, 10, 1), draw, win(0, 10, 1)])).hands[2].pairs[0].worth).toBe(15);
    expect(replay(game([win(0, 10, 1), win(2, 3, 3), win(0, 10, 1)])).hands[2].pairs[0].worth).toBe(10);
    const s = replay(game([win(0, 10, 1), { t: "surrender", at: 0, holder: "A", pulled: "B" }, win(0, 10, 1)]));
    expect(s.hands[1].pairs[0].worth).toBe(10);
  });

  it("the holder keeps a 拉 while winning off someone else", () => {
    const s = replay(game([win(0, 10, 1), win(0, 6, 2), win(0, 10, 1)]));
    expect(s.hands[2].pairs[0].worth).toBe(15);
  });
});

describe("一炮多響 and 反雪", () => {
  it("雙響: the discarder pays each winner, each pair on its own", () => {
    const s = replay(game([multi(3, [0, 8], [1, 5])]));
    expect(s.hands[0]).toMatchObject({ multi: 2, from: "D" });
    expect(s.totals).toMatchObject({ A: 8, B: 5, C: 0, D: -13 });
  });

  it("反雪: the 雙響 victim's 自摸 next hand takes back what each winner took", () => {
    const s = replay(game([multi(3, [0, 8], [1, 5]), win(3, 2, null)]));
    expect(s.hands[1].fanXue).toEqual([
      { from: "A", to: "D", amount: 8 },
      { from: "B", to: "D", amount: 5 },
    ]);
    // The 自摸 is also a 踢 on each winner's 拉: A pays 2 + ceil(8/2), B 2 + ceil(5/2),
    // C a plain 2 - then 13 back on top.
    expect(s.hands[1].pairs.map((p) => [p.payer, p.worth])).toEqual([["A", 6], ["B", 5], ["C", 2]]);
    expect(s.hands[1].deltas.D).toBe(6 + 5 + 2 + 13);
    sumsToZero(s);
  });

  it("no 反雪 when a hand comes between, or when it's off", () => {
    expect(replay(game([multi(3, [0, 8], [1, 5]), draw, win(3, 2, null)])).hands[2].fanXue).toEqual([]);
    expect(replay(game([multi(3, [0, 8], [1, 5]), win(3, 2, null)], { fanXue: false })).hands[1].fanXue).toEqual([]);
  });
});

describe("莊 and the deal", () => {
  const withDealer = { dealerTai: 1, streakTai: 2 };

  it("adds 莊 + 連莊 only on payments the dealer is part of", () => {
    // A deals. A wins (莊 1), A wins again (連1: 3), then B self-draws off A at 連2 (5).
    const s = replay(game([win(0, 10, 2), win(0, 10, 3), win(1, 4, null)], withDealer));
    expect(s.hands.map((h) => h.pairs.map((p) => p.dealer))).toEqual([[1], [3], [5, 0, 0]]);
    expect(s.hands[2].streak).toBe(2);
    expect(s.seats[s.dealer]).toBe("B");
    expect(s.streak).toBe(0);
  });

  it("流局留莊 keeps the dealer on a draw, or passes the deal when off", () => {
    expect(replay(game([draw])).streak).toBe(1);
    expect(replay(game([draw], { drawKeepsDealer: false })).dealer).toBe(1);
  });

  it("moves the round wind after a full lap of dealers, and flags 執位", () => {
    const s = replay(game([win(1, 1, 0), win(2, 1, 0), win(3, 1, 0)]));
    expect(s.label).toBe("東風北局");
    const lapGame = game([win(1, 1, 0), win(2, 1, 0), win(3, 1, 0), win(1, 1, 0)]);
    const lap = replay(lapGame);
    expect(lap.label).toBe("南風東局");
    expect(lap.seatChangeDue).toBe(true);
    expect(replay(withEvent(lapGame, draw)).seatChangeDue).toBe(false);
  });

  it("莊家設定 sets dealer and streak, and can restart the round", () => {
    const s = replay(game([win(1, 1, 0), { t: "dealer", at: 0, seat: 3, streak: 2, resetRound: true }]));
    expect(s).toMatchObject({ dealer: 3, streak: 2, roundWind: 0, label: "東風東局" });
  });
});

describe("Jackpot, bonuses, seats, undo", () => {
  it("each draw feeds the pot from every player; a win can take it", () => {
    const s = replay(game([draw, draw, win(2, 3, 0, { jackpotTo: "C" })], { jackpot: true, jackpotPerDraw: 5 }));
    expect(s.hands[0].jackpotFed).toBe(20);
    expect(s.hands[2].jackpotWon).toEqual({ player: "C", amount: 40 });
    expect(s.pot).toBe(0);
    expect(s.totals).toMatchObject({ A: -13, B: -10, C: 33, D: -10 });
    sumsToZero(s);
  });

  it("hands the pot out by hand", () => {
    const s = replay(game([draw, { t: "jackpot", at: 0, shares: [{ player: "A", amount: 12 }, { player: "B", amount: 8 }] }], { jackpot: true }));
    expect(s.pot).toBe(0);
    expect(s.totals).toMatchObject({ A: 7, B: 3, C: -5, D: -5 });
  });

  it("特別獎罰 between the seat's player and each of the others", () => {
    expect(replay(game([{ t: "bonus", at: 0, seat: 1, amount: 3, kind: "獎" }])).totals).toMatchObject({ A: -3, B: 9, C: -3, D: -3 });
    expect(replay(game([{ t: "bonus", at: 0, seat: 1, amount: 3, kind: "罰" }])).totals).toMatchObject({ A: 3, B: -9 });
  });

  it("換人 keeps totals per player, and a substitute starts at 0", () => {
    const s = replay(game([win(0, 10, 1), { t: "swap", at: 0, seats: ["A", "E", "C", "D"] }, win(1, 4, 0)]));
    expect(s.totals).toMatchObject({ A: 6, B: -10, E: 4 });
    expect(s.players).toEqual(["A", "B", "C", "D", "E"]);
  });

  it("還原 drops the last event; totals always sum to zero", () => {
    const g = game([win(0, 10, 1), multi(2, [0, 3], [1, 4]), win(3, 2, null)]);
    sumsToZero(replay(g));
    expect(replay(undoEvent(g)).hands).toHaveLength(2);
  });
});

describe("結帳", () => {
  it("settles in the fewest payments, times 倍數", () => {
    expect(settle({ Ian: 532, Kevin: 80, Ky: 38, Leo: -650 })).toEqual([
      { from: "Leo", to: "Ian", amount: 532 },
      { from: "Leo", to: "Kevin", amount: 80 },
      { from: "Leo", to: "Ky", amount: 38 },
    ]);
    expect(settle({ A: 10, B: -4, C: -6 }, 2)).toEqual([
      { from: "C", to: "A", amount: 12 },
      { from: "B", to: "A", amount: 8 },
    ]);
  });
});
