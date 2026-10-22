import { it } from "vitest";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { parseScoringHand, PATTERNS, scoreParsedHand, type BonusTile, type GameContext } from "../src/lib/scoring";
import { exampleRulesFor } from "../src/lib/taiRules";
import type { PatternExample } from "../src/lib/patternExamples";
import { PATTERN_CATALOG } from "../src/lib/taiCatalog";
import { TEST_HAND_BASE_CONTEXT, TEST_HANDS } from "../src/lib/testHands";

// Regenerates src/lib/patternExamples.ts - 設定's example per pattern -
// picked from the scoring tests' own hands (testHands.ts) plus EXTRA below:
// for each pattern, the hand where it counts alongside the fewest other
// patterns, with the least situation set. Run after adding patterns or test
// hands (src/lib/patternExamples.test.ts checks every example still counts):
//   UPDATE_EXAMPLES=1 npx vitest run scripts/pick-pattern-examples.test.ts

// Each pattern's example is picked under exampleRulesFor it: the house list,
// with that pattern worth 1 if the house leaves it at 0.
const ZERO_IDS = PATTERNS.map((p) => p.id).filter((id) => exampleRulesFor(id) !== exampleRulesFor("base-tai"));

// Hands for patterns no test hand shows on its own - mostly situations and
// bonus tiles, which the tests check on hands busy with other patterns.
const PLAIN = "(123m)222b234t567t789b22z"; // 大雞: nothing else counts
const CONCEALED = "123m222b234t567t789b22z";
const f = (rank: 1 | 2 | 3 | 4): BonusTile => ({ kind: "flower", rank });
const s = (rank: 1 | 2 | 3 | 4): BonusTile => ({ kind: "season", rank });
const EXTRA: PatternExample[] = [
  { hand: PLAIN },
  { hand: PLAIN, ctx: { selfDraw: true } },
  { hand: PLAIN, bonus: [f(1)] },
  { hand: PLAIN, bonus: [f(2)] },
  { hand: "(123m)222b234t567t789b55m", bonus: [f(1)] },
  { hand: "123m234m456t789b111z55z", bonus: [f(1), s(1)] },
  { hand: "123m456t789b111z555z22m", bonus: [f(1), s(1)] },
  { hand: "111m222t333b444m555t66b", ctx: { selfDraw: true } },
  { hand: "(345m)456m44m111t222b789t" },
  { hand: "(123m)123m123m456t789b55z" },
  { hand: "(123m)123m123m123m789b55z" },
  { hand: "(123m)345m567m789t11z111b" },
  { hand: PLAIN, ctx: { earlyWin: "ten" } },
  { hand: CONCEALED, ctx: { heavenlyWin: "man" } },
  { hand: PLAIN, ctx: { lastTileWin: "river-bottom" } },
  { hand: PLAIN, ctx: { selfDraw: true, lastTileWin: "sea-bottom" } },
  { hand: "(123m)222b123t567t789b22z", ctx: { selfDraw: true, lastTileWin: "sea-bottom", winningTile: { suit: "t", rank: 1 } } },
  { hand: PLAIN, ctx: { selfDraw: true, flowerDraw: 1 }, bonus: [f(1)] },
  { hand: "(1111m)222b234t567t789b22z", ctx: { selfDraw: true, kongDraw: 1 } },
  { hand: PLAIN, ctx: { robKong: 1 } },
  { hand: PLAIN, ctx: { dealerStreak: 2 } },
  // Exact 連刻 shapes with declared triplets, so they can't be re-read as runs.
  { hand: "(222m)(333m)789t456b123b11z" },
  { hand: "(222m)(333m)(444m)789t456b11z" },
  { hand: "(333m)(444m)22m123t789b456b" },
  { hand: "(333m)(444m)(555m)22m123t789b" },
  { hand: "(222m)(333m)(444m)(555m)789t11z" },
  // The longer 連刻 tiers and 雙連刻.
  { hand: "22m333m444m555m123t789b" },
  { hand: "222m333m444m555m789t11z" },
  { hand: "22m333m444m555m666m789t" },
  { hand: "111m222m333m444m555m99t" },
  { hand: "11m222m333m444m555m666m" },
  { hand: "222m333m777m888m456t11z" },
  { hand: "(123m)(222b)(234t)(567t)(789b)22z", ctx: { selfDraw: true } },
  { hand: "147m258t369b12345677z", ctx: { winningTile: { suit: "z", rank: 7 } } },
];

const CANDIDATES: PatternExample[] = [
  ...TEST_HANDS.map((t): PatternExample => ({ hand: t.hand, ...(Object.keys(t.ctx).length > 0 ? { ctx: t.ctx } : {}) })),
  ...EXTRA,
];

function countedIn(example: PatternExample, ruleId = "base-tai"): string[] | null {
  try {
    const parsed = { ...parseScoringHand(example.hand), bonusTiles: example.bonus ?? [] };
    const result = scoreParsedHand(parsed, { ...TEST_HAND_BASE_CONTEXT, ...example.ctx, rules: exampleRulesFor(ruleId) } as GameContext);
    // A pattern counted several times (二連刻 ×2) is listed once per time,
    // so the ranking below prefers a hand where it counts exactly once.
    const rules = exampleRulesFor(ruleId);
    return [...result.matched, ...(result.second?.matched ?? [])].flatMap((m) => {
      const each = rules.patterns[m.pattern.id]?.tai;
      const times = PATTERN_CATALOG[m.pattern.id]?.value.kind === "per" && each > 0 ? Math.round(m.tai / each) : 1;
      return Array.from({ length: Math.max(1, times) }, () => m.pattern.id);
    });
  } catch {
    return null;
  }
}

const SPECIAL_SHAPES = new Set(["thirteen-orphans", "sixteen-unrelated", "sixteen-unrelated-flying", "eight-pairs", "eight-pairs-flying"]);

function pick(): Record<string, PatternExample> {
  const best = new Map<string, { rank: number; example: PatternExample }>();
  // Each candidate under the house list, and under each 0-valued pattern's
  // own rules (where only that pattern can newly count).
  const readings = CANDIDATES.flatMap((example) => [
    { example, ids: countedIn(example), only: null as string | null },
    ...ZERO_IDS.map((id) => ({ example, ids: countedIn(example, id), only: id })),
  ]);
  for (const { example, ids: all, only } of readings) {
    if (!all) continue;
    const ids = all;
    // Fewest other patterns first, then the least situation / bonus set up.
    // An ordinary pattern is shown on an ordinary hand where it can be (a
    // special hand counts so little else that it would otherwise always win).
    const special = ids.some((id) => SPECIAL_SHAPES.has(id));
    const rank = ids.length * 100 + Object.keys(example.ctx ?? {}).length * 10 + (example.bonus?.length ?? 0);
    const manual = example.ctx?.manualVisibleTripleWin || example.ctx?.manualVisibleExhaustedMultiWait;
    for (const id of new Set(ids)) {
      // Under a 0-valued pattern's rules, only that pattern is being picked.
      if (only !== null ? id !== only : ZERO_IDS.includes(id)) continue;
      // A manual 明絕/絕絕 flag would show up as noise on any other pattern's example.
      if (manual && !id.startsWith("visible-")) continue;
      const penalty = special && PATTERN_CATALOG[id].family !== "special" ? 10_000 : 0;
      const cur = best.get(id);
      if (!cur || rank + penalty < cur.rank) best.set(id, { rank: rank + penalty, example });
    }
  }
  return Object.fromEntries(PATTERNS.filter((p) => best.has(p.id)).map((p) => [p.id, best.get(p.id)!.example]));
}

it.runIf(process.env.UPDATE_EXAMPLES)("regenerates src/lib/patternExamples.ts", () => {
  const picked = pick();
  const body = Object.entries(picked)
    .map(([id, ex]) => `  ${/^[a-z]+$/.test(id) ? id : JSON.stringify(id)}: ${JSON.stringify(ex)},`)
    .join("\n");
  const file = `// Generated by scripts/pick-pattern-examples.test.ts - don't edit by hand. 設定's
// example hand for each pattern: the simplest hand (from the scoring tests,
// plus a few written for situations and bonus tiles) where it counts.

import type { BonusTile, GameContext } from "./scoring";

export interface PatternExample {
  /** Scoring notation - "(123m)" declared, "[1111z]" 暗槓, the rest concealed. */
  hand: string;
  /** The situation, over the defaults (TEST_HAND_BASE_CONTEXT). */
  ctx?: Partial<GameContext>;
  bonus?: BonusTile[];
}

export const PATTERN_EXAMPLES: Record<string, PatternExample> = {
${body}
};
`;
  writeFileSync(path.join(import.meta.dirname, "../src/lib/patternExamples.ts"), file);
});
