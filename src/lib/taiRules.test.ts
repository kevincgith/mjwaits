import { describe, expect, it } from "vitest";
import { CHAIN_TIERS, DEFAULT_TAI_RULES, PATTERNS, scoreHand, type GameContext, type PatternRule, type TaiRules } from "./scoring";
import { PATTERN_CATALOG } from "./taiCatalog";
import {
  changedCount,
  chickenIgnores,
  describeChanges,
  isRowChanged,
  isDefaultRules,
  normalizeRules,
  replaceCycles,
  replacedBy,
  rulesDiff,
  rulesFingerprint,
  rulesFromDiff,
} from "./taiRules";
import { LADDERS, OPEN_CONCEALED_PAIRS } from "./taiCatalog";
import { TEST_HAND_BASE_CONTEXT } from "./testHands";

// Default rules with some patterns' rules patched.
function withRules(patches: Record<string, Partial<PatternRule>>, engine: TaiRules["engine"] = "custom"): TaiRules {
  const rules = structuredClone(DEFAULT_TAI_RULES);
  rules.engine = engine;
  for (const [id, patch] of Object.entries(patches)) rules.patterns[id] = { ...rules.patterns[id], ...patch };
  return rules;
}
const ctx = (rules?: TaiRules, overrides: Partial<GameContext> = {}): GameContext => ({ ...TEST_HAND_BASE_CONTEXT, ...overrides, rules });
const tai = (result: ReturnType<typeof scoreHand>, id: string) => result.matched.find((m) => m.pattern.id === id)?.tai ?? 0;

const KONG_HAND = "(1111m)(2222t)345m678b999b11z"; // 2 declared kongs
const DRAGONS_HAND = "(555z)(666z)(777z)123456t22b"; // 大三元
const ORPHANS_HAND = "112349m19t19b1234567z"; // 十三么, no flowers
const BORING_HAND = "(123m)222b234t567t789b22z"; // 大雞
const PLAIN_HAND = "123456789m111z234t22b";

describe("the classification", () => {
  it("covers every pattern exactly once", () => {
    expect(new Set(Object.keys(PATTERN_CATALOG))).toEqual(new Set(PATTERNS.map((p) => p.id)));
  });

  it("puts each pattern on at most one ladder, and ladders name only real patterns", () => {
    const ids = new Set(PATTERNS.map((p) => p.id));
    const seen = new Set<string>();
    for (const id of LADDERS.flatMap((l) => l.rungs.flat())) {
      expect(ids.has(id), id).toBe(true);
      expect(seen.has(id), id).toBe(false);
      seen.add(id);
    }
  });

  it("every score() returns a count, not a tai value", () => {
    // Values live in the catalog only: no pattern scores more than a
    // handful of instances on a real hand.
    const result = scoreHand(DRAGONS_HAND, ctx(undefined, { dealerStreak: 3, kongDraw: 2 }));
    for (const m of result.matched) expect(m.pattern.score(result.hand, ctx(undefined, { dealerStreak: 3, kongDraw: 2 }))).toBeLessThanOrEqual(5);
  });

  it("default rules replace only known patterns, never themselves, with no loops", () => {
    const ids = new Set(PATTERNS.map((p) => p.id));
    for (const [id, rule] of Object.entries(DEFAULT_TAI_RULES.patterns)) {
      for (const r of rule.replaces) {
        expect(ids.has(r), `${id} replaces ${r}`).toBe(true);
        expect(r).not.toBe(id);
      }
    }
    expect(replaceCycles(DEFAULT_TAI_RULES).size).toBe(0);
  });

  it("pairs every 明 pattern with its 暗 partner, and the other way round", () => {
    const ids = PATTERNS.map((p) => p.id);
    expect(OPEN_CONCEALED_PAIRS).toHaveLength(17);
    for (const pair of OPEN_CONCEALED_PAIRS) expect(ids, pair.concealed).toContain(pair.concealed);
    for (const id of ids.filter((x) => x.endsWith("-hidden"))) expect(OPEN_CONCEALED_PAIRS.some((p) => p.concealed === id), id).toBe(true);
  });

  it("names a 明/暗 half in the changes list by its pair and side", () => {
    const texts = describeChanges(withRules({ "identical-sequences-hidden": { tai: 10 } })).map((c) => c.text);
    expect(texts).toEqual(["般高 暗 8 each → 10 each"]);
  });

  it("the defaults are the house list", () => {
    expect(isDefaultRules(DEFAULT_TAI_RULES)).toBe(true);
    expect(changedCount(DEFAULT_TAI_RULES)).toBe(0);
  });
});

describe("values", () => {
  it("rescales a per-instance pattern: 槓 at 3 gives 6 for 2 kongs", () => {
    expect(tai(scoreHand(KONG_HAND, ctx()), "kong")).toBe(4);
    expect(tai(scoreHand(KONG_HAND, ctx(withRules({ kong: { tai: 3 } }))), "kong")).toBe(6);
  });

  it("changes a flat pattern's value, 底 included", () => {
    const result = scoreHand(PLAIN_HAND, ctx(withRules({ "base-tai": { tai: 10 } })));
    expect(tai(result, "base-tai")).toBe(10);
    expect(result.total).toBe(scoreHand(PLAIN_HAND, ctx()).total + 5);
  });

  it("reads an edited table: 搶槓 ×2", () => {
    expect(tai(scoreHand(PLAIN_HAND, ctx(undefined, { robKong: 2 })), "rob-kong")).toBe(25);
    const table = [0, 5, 30, 125, 250, 250];
    expect(tai(scoreHand(PLAIN_HAND, ctx(withRules({ "rob-kong": { table } }), { robKong: 2 })), "rob-kong")).toBe(30);
  });

  it("values 莊 as first + each 連莊", () => {
    expect(tai(scoreHand(PLAIN_HAND, ctx(undefined, { dealerStreak: 3 })), "dealer-streak")).toBe(5);
    expect(tai(scoreHand(PLAIN_HAND, ctx(withRules({ "dealer-streak": { first: 2, tai: 3 } }), { dealerStreak: 3 })), "dealer-streak")).toBe(8);
  });

  it("lets 正圈風 be worth something (0 in the house list)", () => {
    expect(tai(scoreHand(PLAIN_HAND, ctx()), "correct-round-wind")).toBe(0);
    expect(tai(scoreHand(PLAIN_HAND, ctx(withRules({ "correct-round-wind": { tai: 2 } }))), "correct-round-wind")).toBe(2);
  });
});

describe("on/off and exclusion", () => {
  it("disabling a pattern removes it and the patterns it replaced come back", () => {
    const result = scoreHand(DRAGONS_HAND, ctx(withRules({ "big-three-dragons": { enabled: false } })));
    expect(tai(result, "big-three-dragons")).toBe(0);
    expect(tai(result, "dragon-tile")).toBe(6);
  });

  it("switching a ladder off makes its tiers stack", () => {
    const rules = withRules({});
    rules.ladders.dragons = { exclusive: false };
    const result = scoreHand(DRAGONS_HAND, ctx(rules));
    expect(tai(result, "big-three-dragons")).toBe(80);
    expect(tai(result, "dragon-tile")).toBe(6);
  });

  it("removing an explicit replaces edge makes both count", () => {
    // 五槓子 replaces 槓 by its own edge (they're not on one ladder).
    const FIVE_KONGS = "(1111m)(2222m)(3333t)(4444t)(5555b)11z";
    expect(tai(scoreHand(FIVE_KONGS, ctx()), "kong")).toBe(0);
    const rules = withRules({ "five-kongs": { replaces: DEFAULT_TAI_RULES.patterns["five-kongs"].replaces.filter((r) => r !== "kong") } });
    expect(tai(scoreHand(FIVE_KONGS, ctx(rules)), "kong")).toBe(10);
  });

  it("adding a replaces edge drops the other pattern", () => {
    const result = scoreHand(KONG_HAND, ctx(withRules({ kong: { replaces: ["base-tai"] } })));
    expect(tai(result, "base-tai")).toBe(0);
    expect(tai(result, "kong")).toBe(4);
  });

  // Edges the sheet doesn't offer but a hand-edited file could hold. Both
  // are ignored when scoring and dropped when a set is loaded, so the set
  // scores the same before and after it's saved or shared (found by
  // rulesFuzz.test.ts).
  it("ignores a pattern replacing itself", () => {
    const rules = withRules({ kong: { replaces: ["kong"] } });
    expect(tai(scoreHand(KONG_HAND, ctx(rules)), "kong")).toBe(4);
    expect(normalizeRules(rules).rules.patterns.kong.replaces).toEqual([]);
  });

  it("ignores an edge to a lower tier of its own family - the family's switch decides", () => {
    const rules = withRules({ "big-three-dragons": { replaces: ["dragon-tile"] } });
    rules.ladders.dragons = { exclusive: false };
    expect(tai(scoreHand(DRAGONS_HAND, ctx(rules)), "dragon-tile")).toBe(6);
    expect(normalizeRules(rules).rules.patterns["big-three-dragons"].replaces).toEqual([]);
  });

  it("flags a replace loop - when both fire, neither counts", () => {
    const rules = withRules({ "dragon-tile": { replaces: ["big-three-dragons"] } });
    // 小三元 replaces 三元牌 too, so it's on the loop as well.
    expect([...replaceCycles(rules).keys()].sort()).toEqual(["big-three-dragons", "dragon-tile", "small-three-dragons"]);
    const result = scoreHand(DRAGONS_HAND, ctx(rules));
    expect(tai(result, "big-three-dragons")).toBe(0);
    expect(tai(result, "dragon-tile")).toBe(0);
  });

  it("lists what replaces a pattern", () => {
    expect(replacedBy(DEFAULT_TAI_RULES, "small-three-dragons")).toEqual(["big-three-dragons"]);
  });
});

describe("inclusion on special hands", () => {
  it("switching 無花 off for 十三么 leaves it on normal hands", () => {
    const shapes = DEFAULT_TAI_RULES.patterns["no-flowers"].shapes.filter((s) => s !== "thirteen-orphans");
    const rules = withRules({ "no-flowers": { shapes } });
    expect(scoreHand(ORPHANS_HAND, ctx()).total).toBe(167);
    expect(tai(scoreHand(ORPHANS_HAND, ctx(rules)), "no-flowers")).toBe(0);
    expect(scoreHand(ORPHANS_HAND, ctx(rules)).total).toBe(165);
    expect(tai(scoreHand(PLAIN_HAND, ctx(rules)), "no-flowers")).toBe(2);
  });
});

describe("大雞/大鴨's ignore list", () => {
  it("莊 is ignored by default, so 大雞 still counts", () => {
    expect(tai(scoreHand(BORING_HAND, ctx(undefined, { dealerStreak: 1 })), "big-chicken")).toBe(30);
  });

  it("taking 莊 off the list stops 大雞", () => {
    const rules = withRules({ "dealer-streak": { blocksChicken: true } });
    expect(tai(scoreHand(BORING_HAND, ctx(rules, { dealerStreak: 1 })), "big-chicken")).toBe(0);
  });

  it("a disabled pattern doesn't stop 大雞", () => {
    // Switch off whatever stops 大雞 on a plain hand, and 大雞 appears.
    const plain = scoreHand(PLAIN_HAND, ctx());
    expect(tai(plain, "big-chicken")).toBe(0);
    const fired = plain.matched.map((m) => m.pattern.id).filter((id) => DEFAULT_TAI_RULES.patterns[id].blocksChicken && id !== "base-tai");
    const rules = withRules(Object.fromEntries(fired.map((id) => [id, { enabled: false }])));
    expect(tai(scoreHand(PLAIN_HAND, ctx(rules)), "big-chicken")).toBe(30);
  });

  it("doesn't recurse when 自摸 is switched off on a self-drawn boring hand", () => {
    const rules = withRules({ "self-draw": { enabled: false }, "concealed-self-draw": { enabled: false } });
    const result = scoreHand(BORING_HAND, ctx(rules, { selfDraw: true }));
    expect(tai(result, "big-duck")).toBe(15);
  });
});

describe("the original engine and the fallback", () => {
  it("the original engine ignores edited rules", () => {
    expect(tai(scoreHand(KONG_HAND, ctx(withRules({ kong: { tai: 3 } }, "legacy"))), "kong")).toBe(4);
  });

  it("falls back to the original engine, flagged, when the configurable one throws", () => {
    const broken = { engine: "custom", patterns: null } as unknown as TaiRules;
    const errors: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => errors.push(args);
    try {
      const result = scoreHand(PLAIN_HAND, ctx(broken));
      expect(result.engineFallback).toBe(true);
      expect(result.total).toBe(scoreHand(PLAIN_HAND, ctx()).total);
      expect(errors.length).toBe(1);
    } finally {
      console.error = original;
    }
  });

  it("still reports an incomplete hand as a ScoringError, not a fallback", () => {
    expect(() => scoreHand("123m", ctx())).toThrow(/isn't complete/);
    expect(() => scoreHand("123m", ctx(withRules({}, "legacy")))).toThrow(/isn't complete/);
  });
});

describe("the changes list, fingerprint and diff", () => {
  const custom = () => {
    const rules = withRules({ kong: { tai: 3 }, "no-flowers": { shapes: ["normal"] } });
    rules.ladders.dragons = { exclusive: false };
    return rules;
  };

  it("describes every change in words", () => {
    const texts = describeChanges(custom()).map((c) => c.text);
    expect(texts).toContain("槓 2 each → 3 each");
    expect(texts).toContain("三元 Dragons: every tier counts (stacks)");
    expect(texts.some((t) => t.startsWith("無花 not on"))).toBe(true);
    expect(describeChanges(DEFAULT_TAI_RULES)).toEqual([]);
  });

  it("keeps the 大雞/大鴨 ignore list as one setting", () => {
    expect(chickenIgnores(DEFAULT_TAI_RULES)).toEqual(expect.arrayContaining(["base-tai", "dealer-streak", "riichi"]));
    expect(chickenIgnores(DEFAULT_TAI_RULES)).not.toContain("self-draw");
    const rules = withRules({ "dealer-streak": { blocksChicken: true } });
    expect(chickenIgnores(rules)).not.toContain("dealer-streak");
    const change = describeChanges(rules).find((c) => c.chicken);
    expect(change?.text).toBe("大雞/大鴨 no longer ignore 莊");
    // Its own row doesn't count as changed - the list has its own setting.
    expect(isRowChanged("dealer-streak", rules.patterns["dealer-streak"])).toBe(false);
  });

  it("fingerprints only rules that score differently", () => {
    expect(rulesFingerprint(DEFAULT_TAI_RULES)).toBeNull();
    expect(rulesFingerprint(withRules({ kong: { tai: 3 } }, "legacy"))).toBeNull();
    const a = rulesFingerprint(custom());
    expect(a).toMatch(/^[0-9a-z]+$/);
    expect(rulesFingerprint(custom())).toBe(a);
    expect(rulesFingerprint(withRules({ kong: { tai: 4 } }))).not.toBe(a);
  });

  it("round-trips through a diff", () => {
    expect(rulesFromDiff(rulesDiff(custom()))).toEqual(custom());
    expect(rulesDiff(DEFAULT_TAI_RULES)).toEqual({ v: 1 });
  });
});

describe("normalizeRules", () => {
  it("loads a switched-off rule as 0 = off, and says so in the changes list", () => {
    const { rules } = normalizeRules({ patterns: { kong: { enabled: false } } });
    expect(rules.patterns.kong).toMatchObject({ enabled: true, tai: 0 });
    expect(describeChanges(rules).map((c) => c.text)).toEqual(["槓 2 each → off"]);
    expect(tai(scoreHand(KONG_HAND, ctx(rules)), "kong")).toBe(0);
  });

  it("reads the first release's saves: chickenIgnores, and replaces lists that spelled out ladder edges", () => {
    const { rules } = normalizeRules({
      engine: "custom",
      patterns: {
        "dealer-streak": { chickenIgnores: false },
        "big-three-dragons": { replaces: ["dragon-tile", "small-three-dragons"] },
      },
    });
    expect(rules.patterns["dealer-streak"].blocksChicken).toBe(true);
    expect(rules.patterns["big-three-dragons"].replaces).toEqual([]);
    expect(rules.ladders.dragons.exclusive).toBe(true);
  });

  it("fills missing patterns with defaults and drops unknown ones", () => {
    const { rules, corrupt } = normalizeRules({ engine: "custom", patterns: { kong: { tai: 3 }, "no-such-pattern": { tai: 1 } } });
    expect(corrupt).toBe(false);
    expect(rules.patterns.kong.tai).toBe(3);
    expect(rules.patterns.kong.replaces).toEqual(DEFAULT_TAI_RULES.patterns.kong.replaces);
    expect(rules.patterns["base-tai"]).toEqual(DEFAULT_TAI_RULES.patterns["base-tai"]);
    expect("no-such-pattern" in rules.patterns).toBe(false);
  });

  it("keeps shapes within what a pattern can count on, and replaces to known ids", () => {
    const { rules } = normalizeRules({ patterns: { kong: { shapes: ["normal", "eight-pairs"], replaces: ["base-tai", "kong", "nope"] } } });
    expect(rules.patterns.kong.shapes).toEqual(["normal"]);
    expect(rules.patterns.kong.replaces).toEqual(["base-tai"]);
  });

  it("rejects a malformed table", () => {
    const { rules } = normalizeRules({ patterns: { "rob-kong": { table: [0, 1] } } });
    expect(rules.patterns["rob-kong"].table).toEqual(DEFAULT_TAI_RULES.patterns["rob-kong"].table);
  });

  it("treats garbage as corrupt and loads the defaults", () => {
    expect(normalizeRules("garbage")).toEqual({ rules: DEFAULT_TAI_RULES, corrupt: true });
    expect(normalizeRules(null)).toEqual({ rules: DEFAULT_TAI_RULES, corrupt: false });
  });
});

// 連刻 tiers (CHAIN_TIERS in scoring.ts): the longest tier that's switched on
// wins; a shorter tier counts once per window no longer enabled tier contains.
describe("連刻 tiers", () => {
  it("the detector's tiers match the 連刻 family's rungs, by size", () => {
    const family = LADDERS.find((l) => l.id === "consecutive")!;
    expect(family.kind).toBe("windows");
    family.rungs.forEach((rung, i) => {
      for (const id of rung) expect(CHAIN_TIERS.find((t) => t.id === id)?.size, id).toBe(i + 2);
    });
    expect(CHAIN_TIERS.map((t) => t.id).sort()).toEqual(family.rungs.flat().sort());
  });

  it("暗刻 is a count family: only the highest that fires counts", () => {
    expect(LADDERS.find((l) => l.id === "hidden")?.kind ?? "count").toBe("count");
    const result = scoreHand("111m222t333b444m789t55z", ctx());
    expect(tai(result, "four-hidden-triplets")).toBe(30);
    expect(tai(result, "three-hidden-triplets")).toBe(0);
    expect(tai(result, "two-hidden-triplets")).toBe(0);
  });

  const FIVE_CHAIN = "(111m)(222m)(333m)(444m)(555m)99t";
  const FOUR_CHAIN = "(222m)(333m)(444m)(555m)789t11z";
  const SMALL_FOUR = "(333m)(444m)(555m)22m123t789b";
  const TWO_TWOS = "(222m)(333m)(777m)(888m)456t11z";

  it("with only the house tiers on, a long chain counts as overlapping 大三連刻, as before", () => {
    expect(tai(scoreHand(FIVE_CHAIN, ctx()), "big-three-consecutive-triplets")).toBe(90);
    expect(tai(scoreHand(FOUR_CHAIN, ctx()), "big-three-consecutive-triplets")).toBe(60);
    expect(tai(scoreHand(FIVE_CHAIN, ctx()), "consecutive-triplet-pair")).toBe(0);
  });

  it("a longer tier with a value counts once, and replaces the shorter ones", () => {
    const five = scoreHand(FIVE_CHAIN, ctx(withRules({ "big-five-consecutive-triplets": { tai: 240 } })));
    expect(tai(five, "big-five-consecutive-triplets")).toBe(240);
    expect(tai(five, "big-three-consecutive-triplets")).toBe(0);
    const four = scoreHand(FOUR_CHAIN, ctx(withRules({ "big-four-consecutive-triplets": { tai: 90 } })));
    expect(tai(four, "big-four-consecutive-triplets")).toBe(90);
    expect(tai(four, "big-three-consecutive-triplets")).toBe(0);
  });

  it("an enabled tier shorter than the chain counts once per overlapping window", () => {
    const result = scoreHand(FIVE_CHAIN, ctx(withRules({ "big-four-consecutive-triplets": { tai: 60 } })));
    expect(tai(result, "big-four-consecutive-triplets")).toBe(120);
    expect(tai(result, "big-three-consecutive-triplets")).toBe(0);
  });

  it("small tiers work the same way: 小四連刻 off falls back to 小三 + 大三", () => {
    const off = scoreHand(SMALL_FOUR, ctx());
    expect(tai(off, "small-three-consecutive-triplets")).toBe(15);
    expect(tai(off, "big-three-consecutive-triplets")).toBe(30);
    const on = scoreHand(SMALL_FOUR, ctx(withRules({ "small-four-consecutive-triplets": { tai: 50 } })));
    expect(tai(on, "small-four-consecutive-triplets")).toBe(50);
    expect(tai(on, "small-three-consecutive-triplets")).toBe(0);
    expect(tai(on, "big-three-consecutive-triplets")).toBe(0);
  });

  it("雙連刻: off, two separate 二連刻 count twice; on, it replaces them", () => {
    expect(tai(scoreHand(TWO_TWOS, ctx()), "consecutive-triplet-pair")).toBe(10);
    const on = scoreHand(TWO_TWOS, ctx(withRules({ "twin-consecutive-triplet-pairs": { tai: 20 } })));
    expect(tai(on, "twin-consecutive-triplet-pairs")).toBe(20);
    expect(tai(on, "consecutive-triplet-pair")).toBe(0);
  });

  it("雙連刻 needs two separate 二連刻, not two overlapping ones in a chain", () => {
    const rules = withRules({ "big-three-consecutive-triplets": { tai: 0 }, "twin-consecutive-triplet-pairs": { tai: 20 } });
    const result = scoreHand("(222m)(333m)(444m)456t789b11z", ctx(rules));
    expect(tai(result, "twin-consecutive-triplet-pairs")).toBe(0);
    expect(tai(result, "consecutive-triplet-pair")).toBe(10);
  });
});
