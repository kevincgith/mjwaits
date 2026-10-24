import { describe, expect, it } from "vitest";
import { seededRng } from "./bots";
import { callLines, isComeback, LineDecks, MYSTERY_SPEECH, pickSituation, situations, SPEECH, type CallKind, type Outcome } from "./speech";

describe("call bubbles", () => {
  const all = [...Object.values(SPEECH), MYSTERY_SPEECH];

  it("never name a different call", () => {
    for (const v of all) {
      for (const line of callLines(v, "chow")) expect(line).not.toMatch(/碰|槓|杠/);
      for (const line of callLines(v, "pung")) expect(line).not.toMatch(/^[…\s]*上|槓|杠/);
      for (const line of callLines(v, "kong")) expect(line).not.toMatch(/碰|^[…\s]*上/);
    }
  });

  it("keep the lines naming the call made, and the ones naming none", () => {
    const casual = SPEECH.casual;
    expect(callLines(casual, "pung")).toContain("碰碰碰！");
    expect(callLines(casual, "chow")).toContain("上，上。");
    expect(callLines(SPEECH.hunter, "chow")).toContain("大牌路上。");
    for (const v of all) for (const k of ["chow", "pung", "kong"] as CallKind[]) expect(callLines(v, k).length).toBeGreaterThan(3);
  });
});

describe("speech bubbles", () => {
  const all = { ...SPEECH, mystery: MYSTERY_SPEECH };

  it("give every bot at least 200 lines, none twice in one moment", () => {
    for (const [id, speech] of Object.entries(all)) {
      const lines = Object.values(speech).flat();
      expect(lines.length, id).toBeGreaterThanOrEqual(200);
      for (const [kind, list] of Object.entries(speech)) {
        expect(list.length, `${id}.${kind}`).toBeGreaterThan(2);
        expect(new Set(list).size, `${id}.${kind}`).toBe(list.length);
      }
    }
  });

  it("say every line of a kind before any comes round again", () => {
    const decks = new LineDecks(seededRng(7));
    const lines = SPEECH.veteran.idle;
    for (let round = 0; round < 3; round++) {
      const said = Array.from({ length: lines.length }, () => decks.next("v:idle", lines));
      expect(new Set(said).size).toBe(lines.length);
    }
  });

  it("never say the same line twice running, even across a reshuffle", () => {
    const decks = new LineDecks(seededRng(3));
    const lines = ["a", "b", "c"];
    let last = "";
    for (let i = 0; i < 300; i++) {
      const line = decks.next("k", lines);
      expect(line).not.toBe(last);
      last = line;
    }
  });
});

describe("what a bot talks about", () => {
  const base = { seat: 1, totals: [0, 0, 0, 0], history: [] as Outcome[], riichi: [false, false, false, false], liveLeft: 60 };

  it("knows where it stands", () => {
    expect(situations(base)).toEqual([]);
    expect(situations({ ...base, totals: [-5, 20, 0, -15] })).toContain("ahead");
    expect(situations({ ...base, totals: [10, -20, 5, 5] })).toContain("behind");
    expect(situations({ ...base, history: ["win", "none", "win"] })).toContain("hot");
    expect(situations({ ...base, history: ["none", "none", "dealIn", "none", "none"] })).toContain("cold");
    expect(situations({ ...base, history: ["win", "dealIn", "dealIn"] })).toContain("cold");
    expect(situations({ ...base, riichi: [true, false, false, false] })).toContain("pressure");
    expect(situations({ ...base, riichi: [true, true, false, false] })).not.toContain("pressure");
    expect(situations({ ...base, liveLeft: 10 })).toContain("late");
  });

  it("mostly talks about what's going on, sometimes just small talk", () => {
    const rng = seededRng(11);
    const picks = Array.from({ length: 2000 }, () => pickSituation({ ...base, riichi: [true, false, false, false] }, rng));
    const pressure = picks.filter((p) => p === "pressure").length / picks.length;
    expect(pressure).toBeGreaterThan(0.6);
    expect(picks).toContain("idle");
    expect(Array.from({ length: 50 }, () => pickSituation(base, rng)).every((p) => p === "idle")).toBe(true);
  });

  it("spots a win from the bottom of the table", () => {
    expect(isComeback([10, -5, -8, 3], [24, -8, -8, -8], 0)).toBe(true);
    expect(isComeback([40, -15, -13, -12], [24, -8, -8, -8], 0)).toBe(false);
  });
});
