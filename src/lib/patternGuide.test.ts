import { describe, expect, it } from "vitest";
import { FAMILY_GUIDE, PAIR_GUIDE, PATTERN_ALIASES, PATTERN_GUIDE } from "./patternGuide";
import { PATTERNS } from "./scoring";
import { OPEN_CONCEALED_PAIRS, pairOf, PATTERN_FAMILIES } from "./taiCatalog";

// The printable rules reference describes every pattern and family.
describe("the rules reference's descriptions", () => {
  it("cover every pattern once - a 明/暗 pair by one description - and nothing else", () => {
    const unpaired = PATTERNS.map((p) => p.id).filter((id) => !pairOf(id));
    expect(new Set(Object.keys(PATTERN_GUIDE))).toEqual(new Set(unpaired));
    expect(new Set(Object.keys(PAIR_GUIDE))).toEqual(new Set(OPEN_CONCEALED_PAIRS.map((p) => p.id)));
  });

  it("cover every family", () => {
    expect(PATTERN_FAMILIES.filter((f) => !FAMILY_GUIDE[f.id]).map((f) => f.id)).toEqual([]);
  });

  it("read as plain sentences, without code", () => {
    for (const [id, text] of [...Object.entries(PATTERN_GUIDE), ...Object.entries(PAIR_GUIDE)]) {
      expect(text, id).not.toMatch(/[`=]|ctx\.|GameContext/);
      expect(text.trim().endsWith("."), id).toBe(true);
    }
  });
});

describe("pattern aliases", () => {
  it("are keyed by real patterns or 明/暗 pairs, and never repeat the pattern's own name", () => {
    const names = new Map(PATTERNS.map((p) => [p.id, p.name.split(" (")[0]]));
    for (const [key, aliases] of Object.entries(PATTERN_ALIASES)) {
      const pair = OPEN_CONCEALED_PAIRS.find((p) => p.id === key);
      expect(names.has(key) || !!pair, key).toBe(true);
      const own = pair ? names.get(pair.open)!.replace(/^明/, "") : names.get(key)!;
      for (const alias of aliases) expect(alias, key).not.toBe(own);
    }
  });
});
