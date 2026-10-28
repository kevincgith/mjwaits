import { describe, expect, it } from "vitest";
import { seededRng } from "./bots";
import { RIVALS } from "./lines/rivals";
import { callLines, isComeback, lineId, LineCounter, MYSTERY_SPEECH, named, pickSituation, situations, SPEECH, spokenText, type CallKind, type Outcome } from "./speech";

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

  it("give every bot at least 700 lines, none twice in one moment", () => {
    for (const [id, speech] of Object.entries(all)) {
      const lines = Object.values(speech).flat();
      expect(lines.length, id).toBeGreaterThanOrEqual(700);
      for (const [kind, list] of Object.entries(speech)) {
        expect(list.length, `${id}.${kind}`).toBeGreaterThan(2);
        expect(new Set(list).size, `${id}.${kind}`).toBe(list.length);
      }
    }
  });

  it("say every line of a kind before any comes round again", () => {
    const lines = new LineCounter({}, seededRng(7));
    const idle = SPEECH.veteran.idle;
    for (let round = 0; round < 3; round++) {
      const said = Array.from({ length: idle.length }, () => lines.next(idle));
      expect(new Set(said).size).toBe(idle.length);
    }
  });

  it("pick up where the kept counts left off, and hold back the table's last lines", () => {
    // Said before (another day): those come last.
    const counter = new LineCounter({ a: 3, b: 3 }, seededRng(5));
    expect([counter.next(["a", "b", "c", "d"]), counter.next(["a", "b", "c", "d"])].sort()).toEqual(["c", "d"]);
    expect(counter.said()).toEqual({ a: 3, b: 3, c: 1, d: 1 });
    // Just said by anyone: held back, even from a pool that has it at a lower count.
    const table = new LineCounter({}, seededRng(9));
    const first = table.next(["x", "y"]);
    expect(table.next(["x", "y", "z"])).not.toBe(first);
  });

  it("never say the same line twice running, even across a reshuffle", () => {
    const counter = new LineCounter({}, seededRng(3));
    const lines = ["a", "b", "c"];
    let last = "";
    for (let i = 0; i < 300; i++) {
      const line = counter.next(lines);
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

describe("lines aimed at someone", () => {
  it("name them only where there's a name to use", () => {
    const lines = ["你又出銃。", "{name}，你又出銃。"];
    expect(named(lines, null)).toEqual(["你又出銃。"]);
    expect(named(lines, "Kev")).toEqual(lines);
    // Every kind still has lines left with no name to use.
    for (const speech of [...Object.values(SPEECH), MYSTERY_SPEECH])
      for (const [kind, list] of Object.entries(speech)) expect(named(list, null).length, kind).toBeGreaterThan(2);
  });

  it("have something from each personality for each other one", () => {
    const ids = [...Object.keys(SPEECH), "mystery"];
    expect(Object.keys(RIVALS).sort()).toEqual([...ids].sort());
    for (const [me, them] of Object.entries(RIVALS)) {
      for (const at of ids) if (at !== me) expect(them[at], `${me}->${at}`).toBeDefined();
      for (const [at, lines] of Object.entries(them)) {
        expect(lines.length, `${me}->${at}`).toBeGreaterThanOrEqual(5);
        expect(new Set(lines).size, `${me}->${at}`).toBe(lines.length);
      }
    }
  });
});

describe("lines said aloud", () => {
  it("leave out a name, and the call a call clip has just said", () => {
    expect(spokenText("call", "碰！老嘢眼利。")).toBe("老嘢眼利。");
    expect(spokenText("call", "碰！")).toBe("");
    expect(spokenText("call", "上啦。")).toBe("上啦。");
    expect(spokenText("win", "食糊！推牌推牌。")).toBe("推牌推牌。");
    expect(spokenText("youCold", "{name}，你又出銃喎。")).toBe("你又出銃喎。");
    expect(spokenText("idle", "碰！唔係呢度。")).toBe("碰！唔係呢度。");
    expect(spokenText("idle", "……")).toBe("");
  });

  it("name each clip by what it says, the same every time", () => {
    expect(lineId("老嘢眼利。")).toBe(lineId("老嘢眼利。"));
    expect(lineId("老嘢眼利。")).not.toBe(lineId("老嘢眼利！"));
    expect(lineId("老嘢眼利。")).toMatch(/^[0-9a-z]+$/);
  });
});
