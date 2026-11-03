import { describe, expect, it } from "vitest";
import { EMPTY_ENDLESS_STATS, addEndlessStats, parseTrainerStats } from "./trainerStats";

const waitsEntry = { level: 2, flush: false, total: 5, correct: 3, timeTotalMs: 12000 };
const discardsEntry = { level: 3, flush: true, total: 4, correct: 1, timeTotalMs: 9000, regretTotal: 0.25 };

describe("parseTrainerStats", () => {
  it("reads back what was saved", () => {
    const endless = { ...EMPTY_ENDLESS_STATS, hands: 3, turns: 20, optimalCount: 12 };
    const saved = parseTrainerStats(JSON.stringify({ waits: [waitsEntry], discards: [discardsEntry], endless }));
    expect(saved).toEqual({ waits: [waitsEntry], discards: [discardsEntry], endless });
  });

  it("is empty for nothing saved, bad JSON or a non-object", () => {
    const empty = { waits: [], discards: [], endless: EMPTY_ENDLESS_STATS };
    expect(parseTrainerStats(null)).toEqual(empty);
    expect(parseTrainerStats("{not json")).toEqual(empty);
    expect(parseTrainerStats("null")).toEqual(empty);
    expect(parseTrainerStats("42")).toEqual(empty);
  });

  it("drops malformed entries instead of crashing", () => {
    const saved = parseTrainerStats(
      JSON.stringify({
        waits: [null, waitsEntry, 7, { ...waitsEntry, level: "2" }, { ...waitsEntry, total: null }, {}],
        discards: [discardsEntry, waitsEntry, [null], { ...discardsEntry, flush: "yes" }],
      })
    );
    expect(saved.waits).toEqual([waitsEntry]);
    expect(saved.discards).toEqual([discardsEntry]);
  });

  it("keeps only real, non-negative numbers in the Endless stats", () => {
    const saved = parseTrainerStats(
      '{"endless":{"hands":"5","handsWon":2,"turns":-3,"optimalCount":null,"regretTotal":1.5,"looseCount":"x"}}'
    );
    expect(saved.endless).toEqual({ ...EMPTY_ENDLESS_STATS, handsWon: 2, regretTotal: 1.5 });
    // A saved "5" would have made the next +1 read "51".
    expect(addEndlessStats(saved.endless, { ...EMPTY_ENDLESS_STATS, hands: 1 }).hands).toBe(1);
    expect(parseTrainerStats('{"endless":[1,2]}').endless).toEqual(EMPTY_ENDLESS_STATS);
  });
});

describe("addEndlessStats", () => {
  const turn = { ...EMPTY_ENDLESS_STATS, turns: 1, optimalCount: 1, regretTotal: 0.1 };

  it("adds a turn and takes it back", () => {
    const after = addEndlessStats(EMPTY_ENDLESS_STATS, turn);
    expect(after).toEqual(turn);
    expect(addEndlessStats(after, turn, -1)).toEqual(EMPTY_ENDLESS_STATS);
  });

  it("never goes below zero, e.g. an undo of a turn made before a reset", () => {
    const undone = addEndlessStats(EMPTY_ENDLESS_STATS, { ...turn, looseCount: 1, hands: 1 }, -1);
    expect(undone).toEqual(EMPTY_ENDLESS_STATS);
  });
});
