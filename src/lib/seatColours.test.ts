import { describe, expect, it } from "vitest";
import { BOT_PROFILES, LEARNED_PREFIX, MYSTERY_PREFIX, type BotProfile } from "@mjwaits/shared/engine/bots";
import { apart, seatColours, YOUR_COLOUR } from "./seatColours";

// WCAG contrast of a colour against the felt (#1a5639).
const lum = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const onFelt = (hex: string) => (lum(hex) + 0.05) / (lum("#1a5639") + 0.05);

describe("seat colours at the Play table", () => {
  const kinds: BotProfile[] = [
    ...BOT_PROFILES,
    ...BOT_PROFILES.map((p) => ({ ...p, id: `${MYSTERY_PREFIX}${p.id}` })),
    ...BOT_PROFILES.map((p) => ({ ...p, id: `${LEARNED_PREFIX}${p.id}` })),
  ];
  it("are four told apart, each easy to see on the felt - whichever three bots sit down", () => {
    for (const a of kinds)
      for (const b of kinds)
        for (const c of kinds) {
          const cs = seatColours([null, a, b, c], 0);
          expect(cs[0]).toEqual(YOUR_COLOUR);
          const felt = cs.map((x) => x.felt);
          for (let i = 0; i < 4; i++) {
            expect(onFelt(felt[i])).toBeGreaterThan(3);
            for (let j = i + 1; j < 4; j++) expect(apart(felt[i], felt[j]), `${a.id} ${b.id} ${c.id}: ${felt}`).toBe(true);
          }
        }
  });
  it("tell apart other people online too", () => {
    const felt = seatColours([null, null, null, null], 0).map((x) => x.felt);
    for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) expect(apart(felt[i], felt[j])).toBe(true);
  });
  it("keep a bot's own colour when it's free", () => {
    const vet = BOT_PROFILES.find((p) => p.id === "veteran")!;
    expect(seatColours([null, vet, null, null], 0)[1].plaque).toBe("#2f6fb5");
  });
});
