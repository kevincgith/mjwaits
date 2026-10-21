import { describe, expect, it } from "vitest";
import { FAMILY_GUIDE, PATTERN_GUIDE } from "./patternGuide";
import { PATTERNS } from "./scoring";
import { PATTERN_FAMILIES } from "./taiCatalog";

// The printable rules reference describes every pattern and family.
describe("the rules reference's descriptions", () => {
  it("cover every pattern, and nothing else", () => {
    expect(new Set(Object.keys(PATTERN_GUIDE))).toEqual(new Set(PATTERNS.map((p) => p.id)));
  });

  it("cover every family", () => {
    expect(PATTERN_FAMILIES.filter((f) => !FAMILY_GUIDE[f.id]).map((f) => f.id)).toEqual([]);
  });

  it("read as plain sentences, without code", () => {
    for (const [id, text] of Object.entries(PATTERN_GUIDE)) {
      expect(text, id).not.toMatch(/[`=]|ctx\.|GameContext/);
      expect(text.trim().endsWith("."), id).toBe(true);
    }
  });
});
