import { describe, expect, it } from "vitest";
import { deleteEvent, replaceEvent, undoEvent, withEvent, type ScoreEvent, type ScoreGame } from "../engine/ledger";
import { describeChange, diffGames, entryAuthors, stableJson, type AuditEntry } from "./audit";
import { sampleGame } from "./sampleGame";

const draw: ScoreEvent = { t: "draw", at: 1 };
const win: ScoreEvent = { t: "win", at: 2, winners: [{ seat: 0, tai: 9 }], from: 1, source: "quick" };

describe("diffGames", () => {
  // 12 entries, each its own action (sampleGame records them as one batch,
  // which 還原 takes back together).
  const g: ScoreGame = { ...sampleGame(), events: sampleGame().events.map(({ batch: _, ...e }) => e as ScoreEvent) };
  it("calls the first update sharing the game", () => {
    expect(diffGames(null, g)).toMatchObject({ kind: "share", from: 0, removed: 0, added: 12 });
  });
  it("sees an entry added at the end - a new hand, or a redo", () => {
    expect(diffGames(g, withEvent(g, draw))).toEqual({ kind: "add", from: 12, removed: 0, added: 1, t: ["draw"] });
  });
  it("sees the last entry taken back - an undo - or a whole batch", () => {
    expect(diffGames(g, undoEvent(g))).toEqual({ kind: "remove", from: 11, removed: 1, added: 0, t: [] });
    const batched = sampleGame();
    expect(diffGames(batched, undoEvent(batched))).toEqual({ kind: "remove", from: 0, removed: 12, added: 0, t: [] });
  });
  it("sees an older entry deleted or fixed in place", () => {
    expect(diffGames(g, deleteEvent(g, 3))).toEqual({ kind: "remove", from: 3, removed: 1, added: 0, t: [] });
    expect(diffGames(g, replaceEvent(g, 1, win))).toEqual({ kind: "edit", from: 1, removed: 1, added: 1, t: ["win"] });
  });
  it("sees a change to the game's details only", () => {
    expect(diffGames(g, { ...g, name: "Saturday" })).toMatchObject({ kind: "other", removed: 0, added: 0 });
  });
  it("isn't fooled by the same entry written with its keys in another order", () => {
    const shuffledKeys = { ...g, events: g.events.map((e) => Object.fromEntries(Object.entries(e).reverse()) as ScoreEvent) };
    expect(diffGames(g, shuffledKeys).kind).toBe("other");
    expect(stableJson({ b: 1, a: [2, { d: 3, c: undefined }] })).toBe('{"a":[2,{"d":3}],"b":1}');
  });
});

describe("entryAuthors", () => {
  const log = (entries: Omit<AuditEntry, "v" | "at">[]): AuditEntry[] => entries.map((e, i) => ({ ...e, v: i + 1, at: i }));
  it("follows who put in and who changed each entry", () => {
    const g0: ScoreGame = { ...sampleGame(), events: [draw, draw, draw] };
    const g1 = withEvent(g0, win); // Amy adds a hand
    const g2 = replaceEvent(g1, 1, win); // Ben fixes the second
    const g3 = deleteEvent(g2, 0); // Kevin deletes the first
    const g4 = withEvent(g3, draw); // Amy adds another
    const audit = log([
      { by: "Kevin", ...diffGames(null, g0) },
      { by: "Amy", ...diffGames(g0, g1) },
      { by: "Ben", ...diffGames(g1, g2) },
      { by: "Kevin", ...diffGames(g2, g3) },
      { by: "Amy", ...diffGames(g3, g4) },
    ]);
    expect(entryAuthors(audit)).toEqual([{ by: "Kevin", editedBy: "Ben" }, { by: "Kevin" }, { by: "Amy" }, { by: "Amy" }]);
    expect(audit.map(describeChange)).toEqual([
      "shared the game (3 entries)",
      "added 食胡 (entry 4)",
      "changed entry 2 (食胡)",
      "took back entry 1",
      "added 流局 (entry 4)",
    ]);
  });
});
