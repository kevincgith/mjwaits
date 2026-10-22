import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, type ScoreStore } from "@mjwaits/shared/engine/ledger";
import { loadScores, saveScores, unreadableScores } from "./scoreStore";

describe("Saved scores", () => {
  const store = (over: Partial<ScoreStore>): ScoreStore => ({ active: null, history: [], roster: [], settings: DEFAULT_SETTINGS, ...over });

  it("keeps saved scores it can't read, rather than saving over them", () => {
    const mem = new Map<string, string>([["mjwaits.scores", "{not json"]]);
    const was = (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = {
      localStorage: { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) },
    };
    try {
      expect(loadScores().active).toBeNull();
      expect(unreadableScores()).toBe("{not json");
      // A save after that (the app's first) leaves the copy alone.
      expect(saveScores(store({}))).toBe(true);
      expect(mem.get("mjwaits.scores.unreadable")).toBe("{not json");
    } finally {
      (globalThis as { window?: unknown }).window = was;
    }
  });

  it("says when it couldn't save", () => {
    const was = (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = { localStorage: { setItem: () => { throw new Error("QuotaExceededError"); } } };
    try {
      expect(saveScores(store({}))).toBe(false);
    } finally {
      (globalThis as { window?: unknown }).window = was;
    }
  });
});
