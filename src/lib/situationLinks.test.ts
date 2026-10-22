import { describe, expect, it } from "vitest";
import { PATTERNS } from "@mjwaits/shared/engine/scoring";
import { SITUATION_LINK_IDS, situationLinks } from "./situationLinks";

// situationLinks.ts mirrors the 情況 buttons' wiring in App.tsx for 設定 and
// the printed reference to show.
describe("situation links", () => {
  it("names only real patterns", () => {
    const ids = new Set(PATTERNS.map((p) => p.id));
    expect(SITUATION_LINK_IDS.filter((id) => !ids.has(id))).toEqual([]);
  });

  it("are two-way: what one clears clears it back, turns-on has a turned-on-by", () => {
    for (const id of SITUATION_LINK_IDS) {
      const links = situationLinks(id)!;
      for (const other of links.clears) {
        const back = situationLinks(other)!;
        expect([...back.clears, ...back.sameButton], `${other} ↔ ${id}`).toContain(id);
      }
      for (const other of links.turnsOn) expect(situationLinks(other)!.turnedOnBy, `${id} → ${other}`).toContain(id);
      for (const other of links.sameButton) expect(situationLinks(other)!.sameButton).toContain(id);
    }
  });

  it("never lists a situation as both turned on and cleared", () => {
    for (const id of SITUATION_LINK_IDS) {
      const links = situationLinks(id)!;
      expect(links.turnsOn.filter((x) => links.clears.includes(x)), id).toEqual([]);
    }
  });

  it("describes 自摸's links in full", () => {
    const self = situationLinks("self-draw")!;
    expect(self.turnedOnBy.sort()).toEqual(["flower-draw", "heavenly-win", "kong-draw", "river-bottom-win", "sea-bottom-win", "sea-bottom-win-one-tong"].sort());
    expect(self.clears.sort()).toEqual(["earthly-win", "multi-win-double", "multi-win-triple", "riichi-eat", "rob-kong"].sort());
  });
});
