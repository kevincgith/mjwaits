import { describe, expect, it } from "vitest";
import type { ResultView } from "@mjwaits/shared/engine/view";
import { addHand, emptyRecord, MILESTONE_TAI, type Opponent } from "./playRecord";

const opponents: Opponent[] = [
  { seat: 1, key: "veteran", name: "Veteran" },
  { seat: 2, key: "hunter", name: "Hunter" },
  { seat: 3, key: "speedster", name: "Speedster" },
];

const result = (r: Partial<ResultView>): ResultView =>
  ({ winner: null, from: null, tile: null, deltas: [0, 0, 0, 0], score: null, ...r }) as unknown as ResultView;

describe("play record", () => {
  it("counts a win, its 台, the best hand and first big patterns", () => {
    const r = result({
      winner: 0,
      from: 2,
      score: { total: 12, patterns: [{ id: "base-tai", name: "底", tai: 5 }, { id: "flush", name: "清一色", tai: 7 }, { id: "dealer", name: "莊", tai: 1 }] },
    });
    const { record, firsts } = addHand(emptyRecord(), r, opponents, 1);
    expect(record).toMatchObject({ hands: 1, wins: 1, selfDraws: 0, dealIns: 0, taiWon: 12, best: { tai: 12 } });
    expect(firsts).toEqual(["清一色"]);
    expect(record.vs.hunter).toMatchObject({ hands: 1, theirWins: 0, theyDealtIn: 1 });
    // The same patterns again aren't "first" any more.
    expect(addHand(record, r, opponents, 2).firsts).toEqual([]);
    expect(MILESTONE_TAI).toBe(5);
  });

  it("counts a deal-in against the winner, and a draw", () => {
    const dealIn = addHand(emptyRecord(), result({ winner: 1, from: 0, score: { total: 8, patterns: [] } }), opponents).record;
    expect(dealIn).toMatchObject({ hands: 1, wins: 0, dealIns: 1 });
    expect(dealIn.vs.veteran).toMatchObject({ theirWins: 1, youDealtIn: 1 });
    expect(dealIn.vs.hunter).toMatchObject({ hands: 1, theirWins: 0 });
    const draw = addHand(dealIn, result({}), opponents).record;
    expect(draw).toMatchObject({ hands: 2, draws: 1, dealIns: 1 });
  });

  it("counts a self-draw", () => {
    const { record } = addHand(emptyRecord(), result({ winner: 0, from: null, score: { total: 6, patterns: [] } }), opponents);
    expect(record).toMatchObject({ wins: 1, selfDraws: 1 });
  });
});
