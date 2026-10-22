import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, newGame, replay, type ScoreEvent, type ScoreGame } from "./ledger";
import { changeKind, provisionalEast, sheetRows } from "./scoreViews";

const PLAIN = { ...DEFAULT_SETTINGS, dealerTai: 0, streakTai: 0, jackpot: false };
const game = (events: ScoreEvent[], seats = ["A", "B", "C", "D"]): ScoreGame => ({ ...newGame(seats, 0, PLAIN), events });
const win = (seat: number, tai: number, from: number | null): ScoreEvent => ({ t: "win", at: 0, winners: [{ seat, tai }], from, source: "quick" });
const bonus = (seat: number, amount: number): ScoreEvent => ({ t: "bonus", at: 0, seat, amount, kind: "獎" });

describe("sheetRows", () => {
  const g = game([bonus(2, 1), win(0, 10, 1), { t: "draw", at: 0 }, bonus(3, 2)]);
  const state = replay(g);

  it("detailed: 獎罰 rows of their own, in order", () => {
    const rows = sheetRows(g, state, false);
    expect(rows.map((r) => r.kind)).toEqual(["bonus", "hand", "hand", "bonus"]);
    expect(rows[0]).toMatchObject({ label: "獎", deltas: { C: 3, A: -1 } });
    expect(rows[1]).toMatchObject({ bonuses: 0, deltas: { A: 10, B: -10 } });
  });

  it("simple: 獎罰 fold into the next hand, the rest wait at the foot", () => {
    const rows = sheetRows(g, state, true);
    expect(rows.map((r) => r.key)).toEqual(["h1", "h2", "b-pending"]);
    expect(rows[0]).toMatchObject({ bonuses: 1, deltas: { A: 9, B: -11, C: 3, D: -1 } });
    expect(rows[2]).toMatchObject({ kind: "bonus", label: "獎罰", deltas: { D: 6 } });
  });
});

describe("provisionalEast", () => {
  it("is 莊 before anyone wins", () => {
    expect(provisionalEast(replay(game([{ t: "draw", at: 0 }])))).toBe(0);
  });

  it("is the last winner", () => {
    expect(provisionalEast(replay(game([win(0, 3, 1), win(2, 3, 1)])))).toBe(2);
  });

  it("of a 雙響, the winner first round from that hand's 莊", () => {
    // 莊 is A (seat 0); D and B win off C: B comes first from A.
    const st = replay(game([{ t: "win", at: 0, winners: [{ seat: 3, tai: 3 }, { seat: 1, tai: 3 }], from: 2, source: "quick" }]));
    expect(provisionalEast(st)).toBe(1);
  });
});

describe("changeKind", () => {
  const a = win(0, 3, 1);
  const b = win(1, 3, 0);
  const s: ScoreEvent = { t: "surrender", at: 0, holder: "A", pulled: "B" };

  it("tells added, undone and fixed apart", () => {
    expect(changeKind([a], [a, b])).toEqual({ kind: "added", surrenders: false });
    expect(changeKind([], [a])).toEqual({ kind: "added", surrenders: false });
    expect(changeKind([a, b], [a])).toEqual({ kind: "undone", surrenders: false });
    expect(changeKind([a, b], [{ ...a }, b])).toEqual({ kind: "fixed", surrenders: false });
  });

  it("flags entries that are all 投降", () => {
    expect(changeKind([a], [a, s, s])).toEqual({ kind: "added", surrenders: true });
    expect(changeKind([a], [a, s, b]).surrenders).toBe(false);
  });
});
