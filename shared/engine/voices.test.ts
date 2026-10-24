import { describe, expect, it } from "vitest";
import { callLines, MYSTERY_VOICE, VOICES, type CallKind } from "./voices";

describe("call lines", () => {
  const voices = [...Object.values(VOICES), MYSTERY_VOICE];

  it("never name a different call", () => {
    for (const v of voices) {
      for (const line of callLines(v, "chow")) expect(line).not.toMatch(/碰|槓|杠/);
      for (const line of callLines(v, "pung")) expect(line).not.toMatch(/^[…\s]*上|槓|杠/);
      for (const line of callLines(v, "kong")) expect(line).not.toMatch(/碰|^[…\s]*上/);
    }
  });

  it("keep the lines naming the call made, and the ones naming none", () => {
    const casual = VOICES.casual;
    expect(callLines(casual, "pung")).toContain("碰碰碰！");
    expect(callLines(casual, "chow")).toContain("上，上。");
    expect(callLines(VOICES.hunter, "chow")).toContain("大牌路上。");
    for (const v of voices) for (const k of ["chow", "pung", "kong"] as CallKind[]) expect(callLines(v, k).length).toBeGreaterThan(3);
  });
});
