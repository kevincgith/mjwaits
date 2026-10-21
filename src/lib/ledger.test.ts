import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  canRedo,
  deleteEvent,
  exportScores,
  mergeScores,
  newGame,
  parseBackup,
  previewFanXue,
  redoEvent,
  replaceEvent,
  replay,
  chipMoves,
  evenShares,
  CHIP_POT,
  settle,
  undoEvent,
  withEvent,
  type ScoreEvent,
  type ScoreGame,
  type ScoreSettings,
  type ScoreStore,
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

  it("反雪: the 雙響 victim's 自摸 next hand - each winner pays back 5", () => {
    const s = replay(game([multi(3, [0, 8], [1, 5]), win(3, 2, null)]));
    expect(s.hands[1].fanXue).toEqual([
      { from: "A", to: "D", amount: 5 },
      { from: "B", to: "D", amount: 5 },
    ]);
    // The 自摸 is also a 踢 on each winner's 拉: A pays 2 + ceil(8/2), B 2 + ceil(5/2),
    // C a plain 2 - then 5 back from each of A and B on top.
    expect(s.hands[1].pairs.map((p) => [p.payer, p.worth])).toEqual([["A", 6], ["B", 5], ["C", 2]]);
    expect(s.hands[1].deltas.D).toBe(6 + 5 + 2 + 10);
    sumsToZero(s);
  });

  it("反雪 after a 三響 is 10 from each winner, and both amounts are settings", () => {
    const triple = multi(3, [0, 4], [1, 4], [2, 4]);
    expect(replay(game([triple, win(3, 1, null)])).hands[1].fanXue.map((f) => f.amount)).toEqual([10, 10, 10]);
    expect(replay(game([triple, win(3, 1, null)], { fanXueTriple: 7 })).hands[1].fanXue.map((f) => f.amount)).toEqual([7, 7, 7]);
    expect(replay(game([multi(3, [0, 8], [1, 5]), win(3, 2, null)], { fanXueDouble: 3 })).hands[1].fanXue[0].amount).toBe(3);
  });

  it("the 食胡 sheet's preview shows the 反雪 the next hand would pay", () => {
    const s = replay(game([multi(3, [0, 8], [1, 5])]));
    expect(s.fanXueDue).toEqual({ loser: "D", winners: ["A", "B"] });
    expect(previewFanXue(s, [{ seat: 3 }], null)).toEqual([
      { from: "A", to: "D", amount: 5 },
      { from: "B", to: "D", amount: 5 },
    ]);
    // Only D's 自摸 does it.
    expect(previewFanXue(s, [{ seat: 3 }], 0)).toEqual([]);
    expect(previewFanXue(s, [{ seat: 2 }], null)).toEqual([]);
  });

  it("a 流局 in between keeps the 反雪", () => {
    expect(replay(game([multi(3, [0, 8], [1, 5]), draw, win(3, 2, null)])).hands[2].fanXue).toEqual([
      { from: "A", to: "D", amount: 5 },
      { from: "B", to: "D", amount: 5 },
    ]);
    expect(replay(game([multi(3, [0, 8], [1, 5]), draw, draw])).fanXueDue).toEqual({ loser: "D", winners: ["A", "B"] });
  });

  it("so do 特別獎罰, 投降 and Jackpot entries in between", () => {
    const between: ScoreEvent[] = [
      { t: "bonus", at: 0, seat: 2, amount: 5, kind: "獎" },
      { t: "surrender", at: 0, holder: "A", pulled: "D" },
      { t: "jackpotIn", at: 0, shares: [{ player: "C", amount: 5 }] },
    ];
    const s = replay(game([multi(3, [0, 8], [1, 5]), ...between, win(3, 2, null)]));
    expect(s.hands[1].fanXue.map((f) => f.from)).toEqual(["A", "B"]);
  });

  it("no 反雪 when a won hand comes between, or when it's off", () => {
    expect(replay(game([multi(3, [0, 8], [1, 5]), win(2, 3, 0), win(3, 2, null)])).hands[2].fanXue).toEqual([]);
    expect(replay(game([multi(3, [0, 8], [1, 5]), win(3, 2, null)], { fanXue: false })).hands[1].fanXue).toEqual([]);
  });
});

describe("圈 and 東", () => {
  const dealer = (seat: number, resetRound = false): ScoreEvent => ({ t: "dealer", at: 0, seat, streak: 0, resetRound });

  it("a 莊家 change before the first hand is who deals first: the 圈 starts there", () => {
    const s = replay(game([dealer(3), win(3, 2, null)]));
    expect(s.hands[0].label).toBe("東風東局");
    expect(s.roundStartDealer).toBe(3);
  });

  it("counts 第幾圈 and 第幾個東 as the deal goes round", () => {
    // Four non-dealer wins pass the deal once round: 東風 → 南風.
    const round = [win(1, 1, 0), win(2, 1, 0), win(3, 1, 0), win(0, 1, 1)];
    expect(replay(game([])).circle).toBe(1);
    expect(replay(game(round))).toMatchObject({ circle: 2, east: 1, label: "南風東局" });
    const s = replay(game([...round, ...round, ...round, ...round]));
    expect(s).toMatchObject({ circle: 5, east: 2, label: "東風東局" });
  });

  it("a 莊家 change can set any 風局", () => {
    const set = (seat: number, wind: number, hand: number): ScoreEvent => ({ t: "dealer", at: 0, seat, streak: 0, resetRound: false, round: { wind, hand } });
    // B deals 南風西局: the 圈 started two seats back, at D.
    const s = replay(game([set(1, 1, 2)]));
    expect(s).toMatchObject({ label: "南風西局", roundWind: 1, roundStartDealer: 3, circle: 1, east: 1 });
    // From there the deal goes on as usual: C deals 南風北局, then D starts 西風.
    expect(replay(game([set(1, 1, 2), win(2, 1, 1)])).label).toBe("南風北局");
    expect(replay(game([set(1, 1, 2), win(2, 1, 1), win(3, 1, 2)])).label).toBe("西風東局");
    // After hands, a new wind starts a new 圈 - and a new 東 if it lands on 東風.
    expect(replay(game([win(1, 1, 0), set(2, 1, 0)]))).toMatchObject({ circle: 2, east: 1, label: "南風東局" });
    const back = replay(game([win(1, 1, 0), set(2, 1, 0), win(3, 1, 2), set(0, 0, 0)]));
    expect(back).toMatchObject({ circle: 3, east: 2, label: "東風東局" });
    // The same wind is just a relabel - e.g. 莊 moving seat and keeping the round.
    expect(replay(game([win(1, 1, 0), set(3, 0, 1)]))).toMatchObject({ circle: 1, east: 1, label: "東風南局" });
  });

  it("a reset back to 東風東局 starts a new 圈 and 東 only after hands were played", () => {
    expect(replay(game([dealer(2, true)]))).toMatchObject({ circle: 1, east: 1 });
    expect(replay(game([win(1, 1, 0), dealer(2, true)]))).toMatchObject({ circle: 2, east: 2, label: "東風東局" });
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

  it("moves the round wind after a full lap of dealers", () => {
    const s = replay(game([win(1, 1, 0), win(2, 1, 0), win(3, 1, 0)]));
    expect(s.label).toBe("東風北局");
    const lap = replay(game([win(1, 1, 0), win(2, 1, 0), win(3, 1, 0), win(1, 1, 0)]));
    expect(lap.label).toBe("南風東局");
    expect(lap.seatChangeDue).toBe(false);
  });

  it("flags 執位 only after 北風北局, until the next hand", () => {
    // Each non-dealer win passes the deal: 4 hands a wind, 16 a 圈.
    const pass = (n: number) => Array.from({ length: n }, (_, i) => win((i + 1) % 4, 1, i % 4));
    for (const n of [4, 8, 12]) expect(replay(game(pass(n))).seatChangeDue).toBe(false);
    expect(replay(game(pass(15))).label).toBe("北風北局");
    const full = game(pass(16));
    expect(replay(full).label).toBe("東風東局");
    expect(replay(full).seatChangeDue).toBe(true);
    expect(replay(withEvent(full, draw)).seatChangeDue).toBe(false);
    expect(replay(game(pass(16), { seatReminder: false })).seatChangeDue).toBe(false);
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

  it("詐胡 pays each player their own amount, and leaves the deal alone", () => {
    const s = replay(game([{ t: "zhaHu", at: 0, seat: 1, pays: [{ player: "A", amount: 40 }, { player: "C", amount: 20 }, { player: "D", amount: 40 }] }]));
    expect(s.totals).toEqual({ A: 40, B: -100, C: 20, D: 40 });
    expect(s.hands).toHaveLength(0);
    expect(s.dealer).toBe(0);
    sumsToZero(s);
  });

  it("詐胡 ends the caller's 拉, each pulled player paid its 踢 half", () => {
    // A won 7 off B, so A pulls B for 7.
    const pays = (n: number) => ["B", "C", "D"].map((player) => ({ player, amount: n }));
    const t = replay(game([win(0, 7, 1), { t: "zhaHu", at: 0, seat: 0, pays: pays(40) }]));
    expect(t.lahs).toHaveLength(0);
    // B: −7 for the hand, then +40 and +4 (half of 7, 0.5進1).
    expect(t.totals).toEqual({ A: 7 - 120 - 4, B: -7 + 44, C: 40, D: 40 });
    sumsToZero(t);
  });

  it("特別獎罰 to or from one player", () => {
    // 獎 from C only: C pays B.
    expect(replay(game([{ t: "bonus", at: 0, seat: 1, amount: 5, kind: "獎", other: 2 }])).totals).toEqual({ A: 0, B: 5, C: -5, D: 0 });
    // 罰 to D only: B pays D.
    expect(replay(game([{ t: "bonus", at: 0, seat: 1, amount: 5, kind: "罰", other: 3 }])).totals).toEqual({ A: 0, B: -5, C: 0, D: 5 });
  });

  it("換人 keeps totals per player, and a substitute starts at 0", () => {
    const s = replay(game([win(0, 10, 1), { t: "swap", at: 0, seats: ["A", "E", "C", "D"] }, win(1, 4, 0)]));
    expect(s.totals).toMatchObject({ A: 6, B: -10, E: 4 });
    expect(s.players).toEqual(["A", "B", "C", "D", "E"]);
  });

  it("重做 brings back what 還原 took, in order; a new entry clears it", () => {
    const g = game([win(0, 10, 1), win(2, 4, 3)]);
    const twice = undoEvent(undoEvent(g));
    expect(twice.events).toHaveLength(0);
    expect(canRedo(twice)).toBe(true);
    const back = redoEvent(redoEvent(twice));
    expect(back.events).toEqual(g.events);
    expect(canRedo(back)).toBe(false);
    const branched = withEvent(undoEvent(g), draw);
    expect(canRedo(branched)).toBe(false);
    expect(redoEvent(branched)).toBe(branched);
  });

  it("還原 drops the last event; totals always sum to zero", () => {
    const g = game([win(0, 10, 1), multi(2, [0, 3], [1, 4]), win(3, 2, null)]);
    sumsToZero(replay(g));
    expect(replay(undoEvent(g)).hands).toHaveLength(2);
  });
});

describe("籌碼 - chips change hands when a 拉 ends", () => {
  const after = (events: ScoreEvent[], settings: Partial<ScoreSettings> = {}) => replay(game(events, settings));
  const moves = (events: ScoreEvent[], extra: ScoreEvent, settings: Partial<ScoreSettings> = {}) =>
    chipMoves(after(events, settings), after([...events, extra], settings));
  const sorted = (m: { from: string; to: string; amount: number }[]) => m.slice().sort((x, y) => x.from.localeCompare(y.from));

  it("A's 自摸 of 10 starts a 拉 on everyone - no chips yet", () => {
    expect(moves([], win(0, 10, null))).toEqual([]);
  });

  it("B then wins 20 off C: A's 拉 end, everyone pays A 10; C's 20 rides in B's 拉", () => {
    expect(sorted(moves([win(0, 10, null)], win(1, 20, 2)))).toEqual([
      { from: "B", to: "A", amount: 10 },
      { from: "C", to: "A", amount: 10 },
      { from: "D", to: "A", amount: 10 },
    ]);
  });

  it("B wins 20 off A instead (a 踢): C and D pay A 10, B only 5", () => {
    expect(sorted(moves([win(0, 10, null)], win(1, 20, 0)))).toEqual([
      { from: "B", to: "A", amount: 5 },
      { from: "C", to: "A", amount: 10 },
      { from: "D", to: "A", amount: 10 },
    ]);
  });

  it("投降 hands over the whole 拉; 特別獎罰 is paid on the spot", () => {
    expect(moves([win(0, 7, 1)], { t: "surrender", at: 0, holder: "A", pulled: "B" })).toEqual([{ from: "B", to: "A", amount: 7 }]);
    expect(sorted(moves([], { t: "bonus", at: 0, seat: 1, amount: 3, kind: "獎" }))).toEqual([
      { from: "A", to: "B", amount: 3 },
      { from: "C", to: "B", amount: 3 },
      { from: "D", to: "B", amount: 3 },
    ]);
  });

  // 雙響 / 三響: each winner's 拉 on the discarder rides; the 拉 they end are
  // paid, less a half for each winner who 踢s.
  const many = (winners: [number, number][], from: number): ScoreEvent => ({ t: "win", at: 0, winners: winners.map(([seat, tai]) => ({ seat, tai })), from, source: "quick" });

  it("雙響 off D after A's 自摸: A's 拉 end, everyone pays A 10", () => {
    expect(sorted(moves([win(0, 10, null)], many([[1, 20], [2, 20]], 3)))).toEqual([
      { from: "B", to: "A", amount: 10 },
      { from: "C", to: "A", amount: 10 },
      { from: "D", to: "A", amount: 10 },
    ]);
  });

  it("雙響 / 三響 off A: each winner 踢s, paying A only half", () => {
    expect(sorted(moves([win(0, 10, null)], many([[1, 20], [2, 20]], 0)))).toEqual([
      { from: "B", to: "A", amount: 5 },
      { from: "C", to: "A", amount: 5 },
      { from: "D", to: "A", amount: 10 },
    ]);
    expect(sorted(moves([win(0, 10, null)], many([[1, 20], [2, 20], [3, 20]], 0)))).toEqual([
      { from: "B", to: "A", amount: 5 },
      { from: "C", to: "A", amount: 5 },
      { from: "D", to: "A", amount: 5 },
    ]);
  });

  it("a 雙響 the holder is part of keeps their 拉 - no chips", () => {
    expect(moves([win(0, 10, null)], many([[0, 20], [1, 20]], 3))).toEqual([]);
  });

  it("the 雙響's loser self-draws: each winner's 拉 ends with a 踢, less the 反雪 they pay back", () => {
    expect(sorted(moves([many([[1, 20], [2, 20]], 3)], win(3, 10, null), { fanXue: true, fanXueDouble: 5 }))).toEqual([
      { from: "D", to: "B", amount: 5 },
      { from: "D", to: "C", amount: 5 },
    ]);
  });

  it("pair by pair, never netted: A pulls B C D, B and D pull C, then C self-draws", () => {
    // A 自摸 10, then A + B + D 三響 off C for 4 each: A still pulls B and D
    // (10) and C (10 + 4 + 5 拉半 = 19); B and D each pull C 4.
    // (反雪 off - C's 自摸 after the 三響 would add each winner's pay-back.)
    const before = [win(0, 10, null), many([[0, 4], [1, 4], [3, 4]], 2)];
    const noFanXue = { fanXue: false };
    expect(after(before, noFanXue).lahs.map((l) => `${l.holder}>${l.pulled} ${l.value}`).sort()).toEqual(["A>B 10", "A>C 19", "A>D 10", "B>C 4", "D>C 4"]);
    // Every 拉 ends. B and D hand A theirs whole; C 踢s all three, handing
    // each their 拉 less the half kicked back.
    expect(sorted(moves(before, win(2, 2, null), noFanXue))).toEqual([
      { from: "B", to: "A", amount: 10 },
      { from: "C", to: "A", amount: 9 },
      { from: "C", to: "B", amount: 2 },
      { from: "C", to: "D", amount: 2 },
      { from: "D", to: "A", amount: 10 },
    ]);
  });

  it("a 流局 feeds the Jackpot pile", () => {
    expect(moves([], draw, { jackpot: true, jackpotPerDraw: 5 }).every((m) => m.to === CHIP_POT && m.amount === 5)).toBe(true);
  });
});

describe("Jackpot split evenly", () => {
  it("spreads what won't divide one each, from the 起莊 seat on", () => {
    expect(evenShares(11, 0, true)).toEqual([3, 3, 3, 2]);
    expect(evenShares(11, 2, true)).toEqual([3, 2, 3, 3]);
    expect(evenShares(20, 1, true)).toEqual([5, 5, 5, 5]);
    expect(evenShares(2, 3, true)).toEqual([1, 0, 0, 1]);
  });

  it("goes to 0.1 off 整數模式", () => {
    expect(evenShares(11, 0, false)).toEqual([2.8, 2.8, 2.7, 2.7]);
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

describe("封頂 is an input limit only", () => {
  it("never changes what's paid - hands, 拉 and 特別獎罰 go through in full", () => {
    expect(replay(game([win(0, 1200, 1)])).totals).toMatchObject({ A: 1200, B: -1200 });
    // 900, then 200 + ceil(900/2): the 拉 isn't limited by the cap either.
    const s = replay(game([win(0, 900, 1), win(0, 800, 1)]));
    expect(s.hands[1].pairs[0].worth).toBe(800 + 450);
    expect(replay(game([{ t: "bonus", at: 0, seat: 1, amount: 1200, kind: "獎", other: 2 }])).totals).toMatchObject({ B: 1200, C: -1200 });
  });
});

describe("Backup", () => {
  const g = (id: string, startedAt: number, events: ScoreEvent[]): ScoreGame => ({ ...game(events), id, startedAt });
  const store = (over: Partial<ScoreStore>): ScoreStore => ({ active: null, history: [], roster: [], settings: PLAIN, ...over });

  it("round-trips a store through a backup file", () => {
    const s = store({ active: g("a", 3, [win(0, 3, 1)]), history: [g("b", 1, [draw])], roster: [{ name: "A", color: 2 }] });
    expect(parseBackup(exportScores(s))).toEqual(s);
  });

  it("reads a bare store too, and rejects anything else", () => {
    const s = store({ history: [g("b", 1, [draw])] });
    expect(parseBackup(JSON.stringify(s))?.history).toHaveLength(1);
    expect(parseBackup("not json")).toBeNull();
    expect(parseBackup("[1,2]")).toBeNull();
    expect(parseBackup('{"hello":1}')).toBeNull();
  });

  it("fills in settings a backup predates", () => {
    const old = JSON.stringify({ kind: "mjwaits.scores", version: 1, store: { history: [], settings: { base: 2 } } });
    expect(parseBackup(old)?.settings).toEqual({ ...DEFAULT_SETTINGS, base: 2 });
  });

  it("merges by game id, keeping the longer copy and this device's game in progress", () => {
    const here = store({ active: g("live", 5, [draw]), history: [g("x", 2, [draw])], roster: [{ name: "A", color: 0 }] });
    const backup = store({
      active: g("other", 4, [draw]),
      history: [g("x", 2, [draw, draw]), g("y", 1, [])],
      roster: [{ name: "A", color: 5 }, { name: "E", color: 1 }],
      settings: { ...PLAIN, base: 9 },
    });
    const m = mergeScores(here, backup);
    expect(m.active?.id).toBe("live");
    expect(m.history.map((h) => h.id)).toEqual(["other", "x", "y"]);
    expect(m.history[1].events).toHaveLength(2);
    expect(m.roster).toEqual([{ name: "A", color: 0 }, { name: "E", color: 1 }]);
    expect(m.settings).toBe(here.settings);
  });

  it("restores the backup's game in progress onto an empty device", () => {
    const backup = store({ active: g("live", 5, [draw]) });
    expect(mergeScores(store({}), backup).active?.id).toBe("live");
  });
});

describe("Jackpot paid in by hand", () => {
  it("takes it from each payer and adds it to the pot, which a win can then take", () => {
    const payIn: ScoreEvent = { t: "jackpotIn", at: 0, shares: [{ player: "A", amount: 5 }, { player: "C", amount: 10 }] };
    const s = replay(game([payIn], { jackpot: true }));
    expect(s.pot).toBe(15);
    expect(s.totals).toMatchObject({ A: -5, B: 0, C: -10, D: 0 });
    const won = replay(game([payIn, win(1, 3, 0, { jackpotTo: "B" })], { jackpot: true }));
    expect(won.pot).toBe(0);
    expect(won.totals.B).toBe(3 + 15);
  });
});

describe("fixing an older entry", () => {
  it("replacing a hand replays everything after it", () => {
    const g = game([win(1, 5, 0), win(2, 3, 1), win(3, 2, 2)]);
    const fixed = replaceEvent(g, 0, win(1, 8, 0));
    expect(fixed.events[0]).toMatchObject({ winners: [{ seat: 1, tai: 8 }] });
    expect(fixed.events).toHaveLength(3);
    const s = replay(fixed);
    expect(s.hands[0].pairs[0].worth).toBe(8);
    sumsToZero(s);
  });

  it("deleting an entry drops just that one, and clears 重做", () => {
    const g = { ...game([win(1, 5, 0), draw, win(2, 3, 1)]), undone: [draw] };
    const d = deleteEvent(g, 1);
    expect(d.events.map((e) => e.t)).toEqual(["win", "win"]);
    expect(d.undone).toEqual([]);
    expect(replay(d).hands).toHaveLength(2);
  });
});

