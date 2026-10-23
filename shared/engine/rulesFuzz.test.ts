import { describe, expect, it } from "vitest";
import {
  DEFAULT_TAI_RULES,
  effectiveReplaces,
  eligibleShapes,
  parseScoringHand,
  PATTERNS,
  scoreParsedHand,
  scoreParsedHandWithRules,
  type GameContext,
  type HandShape,
  type MatchedPattern,
  type ParsedScoringHand,
  type ScoreResult,
  type TaiRules,
} from "./scoring";
import { scoreParsedHand as scoreParsedHandLegacy } from "./scoringLegacy";
import { FUZZ_SCALE, HAND_KINDS, randomBonus, randomContext, rng, type Rng } from "./randomHands";
import { isRuleOn, normalizeRules, rulesDiff, rulesFromDiff, switchedOff } from "./taiRules";
import { LADDERS } from "./taiCatalog";
import { TEST_HAND_BASE_CONTEXT } from "./testHands";

// The configurable engine under random rule sets - something the hard-coded
// engine can't be compared against, so these check properties any rule set
// must keep instead:
//  - the breakdown is consistent: total = the rows, no row worth 0, no row
//    switched off or replaced by another row, no row twice, and it never
//    throws;
//  - doubling every value doubles the total and keeps the same rows;
//  - "Original built-in" ignores the rules entirely;
//  - a set survives its share link / storage round trip unchanged;
//  - switching one counted pattern off removes it and costs at most its own
//    tai; leaving it no hand shapes is the same as switching it off;
//  - dropping every replace edge, and letting every tier stack, never lowers
//    a total.
// Seeded: a failure prints the hand, situation and the rule changes.

const IDS = PATTERNS.map((p) => p.id);
const int = (r: Rng, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
const chance = (r: Rng, p: number) => r() < p;

// Edges the sheet wouldn't offer but a hand-edited file could hold - itself,
// a lower tier of its own family - turn up often, alongside any pattern.
const LOWER_TIERS = new Map(LADDERS.filter((l) => l.kind !== "windows").flatMap((l) => l.rungs.flatMap((rung, i) => rung.map((id) => [id, l.rungs.slice(0, i).flat()] as const))));
function randomEdge(r: Rng, id: string): string {
  const lower = LOWER_TIERS.get(id) ?? [];
  const roll = r();
  if (roll < 0.15) return id;
  if (roll < 0.4 && lower.length) return lower[int(r, 0, lower.length - 1)];
  return IDS[int(r, 0, IDS.length - 1)];
}

function randomRules(r: Rng): TaiRules {
  const rules = structuredClone(DEFAULT_TAI_RULES);
  for (const id of IDS) {
    const rule = rules.patterns[id];
    if (chance(r, 0.2)) {
      // A new value, 0 (off) about a fifth of the time.
      const v = () => (chance(r, 0.2) ? 0 : int(r, 1, 12));
      if (rule.table) rule.table = rule.table.map((x, i) => (i === 0 ? x : v()));
      else rule.tai = v();
      if (rule.first !== undefined) rule.first = v();
    }
    if (chance(r, 0.02)) rule.enabled = false; // a set saved before 0 = off
    if (chance(r, 0.06)) rule.replaces = chance(r, 0.4) ? [] : [...rule.replaces, randomEdge(r, id)];
    if (chance(r, 0.06)) rule.shapes = eligibleShapes(id).filter(() => chance(r, 0.5));
    if (chance(r, 0.06)) rule.blocksChicken = !rule.blocksChicken;
  }
  for (const id of Object.keys(rules.ladders)) if (chance(r, 0.25)) rules.ladders[id].exclusive = false;
  return rules;
}

const rows = (res: ScoreResult) => [res.matched, ...(res.second ? [res.second.matched] : [])];
const summary = (res: ScoreResult) => ({ total: res.total, rows: rows(res).map((list) => list.map((m) => `${m.pattern.id} ${m.tai}`)) });
const taiOf = (res: ScoreResult, id: string) => rows(res).flat().filter((m) => m.pattern.id === id).reduce((n, m) => n + m.tai, 0);
const score = (parsed: ParsedScoringHand, ctx: GameContext, rules: TaiRules) => scoreParsedHandWithRules(parsed, { ...ctx, rules });

function scaled(rules: TaiRules, k: number): TaiRules {
  const out = structuredClone(rules);
  for (const rule of Object.values(out.patterns)) {
    rule.tai *= k;
    if (rule.table) rule.table = rule.table.map((x) => x * k);
    if (rule.first !== undefined) rule.first *= k;
  }
  return out;
}

function withRule(rules: TaiRules, id: string, change: (rule: TaiRules["patterns"][string]) => TaiRules["patterns"][string]): TaiRules {
  const out = structuredClone(rules);
  out.patterns[id] = change(out.patterns[id]);
  return out;
}

/** What makes a breakdown wrong under any rules - empty when it's fine. */
function breakdownProblems(res: ScoreResult, rules: TaiRules): string[] {
  const problems: string[] = [];
  const sum = rows(res).flat().reduce((n, m) => n + m.tai, 0);
  if (sum !== res.total) problems.push(`total ${res.total} but rows add to ${sum}`);
  for (const list of rows(res)) {
    const ids = list.map((m: MatchedPattern) => m.pattern.id);
    if (new Set(ids).size !== ids.length) problems.push(`a row twice: ${ids.join(" ")}`);
    for (const m of list) {
      const rule = rules.patterns[m.pattern.id];
      if (m.tai <= 0) problems.push(`${m.pattern.id} counted at ${m.tai}`);
      if (!isRuleOn(rule)) problems.push(`${m.pattern.id} is off but counted`);
      if (rule.shapes.length === 0) problems.push(`${m.pattern.id} counts on no shape but counted`);
      for (const other of list) {
        if (effectiveReplaces(rules, m.pattern.id).includes(other.pattern.id)) problems.push(`${m.pattern.id} replaces ${other.pattern.id} but both counted`);
      }
    }
  }
  return problems;
}

const changesOf = (rules: TaiRules) => rulesDiff(rules).p ?? {};

interface Case {
  hand: string;
  parsed: ParsedScoringHand;
  ctx: GameContext;
  rules: TaiRules;
}

function cases(seed: number, count: number): Case[] {
  const r = rng(seed);
  const kinds = Object.keys(HAND_KINDS) as (keyof typeof HAND_KINDS)[];
  return Array.from({ length: count }, (_, i) => {
    const kind = i % 4 === 0 ? kinds[1 + (i / 4) % 3] : "normal";
    const { hand, free } = HAND_KINDS[kind](r);
    const ctx = randomContext(r, TEST_HAND_BASE_CONTEXT, free);
    return { hand, parsed: { ...parseScoringHand(hand), bonusTiles: randomBonus(r) }, ctx, rules: randomRules(r) };
  });
}

// Runs `check` on every case, collecting failures with what reproduces them.
function eachCase(seed: number, count: number, check: (c: Case) => string | null) {
  const failures: unknown[] = [];
  for (const c of cases(seed, count)) {
    let problem: string | null;
    try {
      problem = check(c);
    } catch (e) {
      problem = `threw: ${e instanceof Error ? e.stack : String(e)}`;
    }
    if (problem) failures.push({ hand: c.hand, bonus: c.parsed.bonusTiles, ctx: c.ctx, changes: changesOf(c.rules), problem });
  }
  expect(failures.slice(0, 3)).toEqual([]);
}

const SHAPE_COUNT = 150 * FUZZ_SCALE;
const T = { timeout: 120_000 * FUZZ_SCALE };

describe("configurable engine under random rule sets", () => {
  it("never throws, and every breakdown is consistent", T, () => {
    eachCase(11, 600 * FUZZ_SCALE, ({ parsed, ctx, rules }) => {
      const problems = breakdownProblems(score(parsed, ctx, rules), rules);
      return problems.length ? problems.join("; ") : null;
    });
  });

  it("doubling every value doubles the total and keeps the same rows", T, () => {
    eachCase(12, SHAPE_COUNT, ({ parsed, ctx, rules }) => {
      const once = summary(score(parsed, ctx, rules));
      const twice = summary(score(parsed, ctx, scaled(rules, 2)));
      const expected = { total: once.total * 2, rows: once.rows.map((list) => list.map((row) => row.replace(/ (\d+)$/, (_, n) => ` ${Number(n) * 2}`))) };
      return JSON.stringify(twice) === JSON.stringify(expected) ? null : `once ${JSON.stringify(once)}, doubled ${JSON.stringify(twice)}`;
    });
  });

  it("Original built-in ignores the rules", T, () => {
    eachCase(13, SHAPE_COUNT, ({ parsed, ctx, rules }) => {
      const legacy = JSON.stringify(summary(scoreParsedHandLegacy(parsed, ctx) as ScoreResult));
      // Through the public entry point, as the app scores.
      const viaSetting = JSON.stringify(summary(scoreParsedHand(parsed, { ...ctx, rules: { ...rules, engine: "legacy" } })));
      return viaSetting === legacy ? null : `legacy ${legacy}, with the setting ${viaSetting}`;
    });
  });

  it("a set scores the same after its share link and storage round trips", T, () => {
    eachCase(14, SHAPE_COUNT, ({ parsed, ctx, rules }) => {
      const want = JSON.stringify(summary(score(parsed, ctx, rules)));
      const viaLink = rulesFromDiff(JSON.parse(JSON.stringify(rulesDiff(rules))));
      if (!viaLink) return "link didn't decode";
      const viaStorage = normalizeRules(JSON.parse(JSON.stringify(rules))).rules;
      const link = JSON.stringify(summary(score(parsed, ctx, viaLink)));
      const storage = JSON.stringify(summary(score(parsed, ctx, viaStorage)));
      if (link !== want) return `link: ${link} vs ${want}`;
      if (storage !== want) return `storage: ${storage} vs ${want}`;
      return null;
    });
  });

  it("switching a counted pattern off removes it and costs at most its own tai", T, () => {
    eachCase(15, SHAPE_COUNT, ({ parsed, ctx, rules }) => {
      const before = score(parsed, ctx, rules);
      for (const id of new Set(rows(before).flat().map((m) => m.pattern.id))) {
        const after = score(parsed, ctx, withRule(rules, id, switchedOff));
        if (taiOf(after, id) > 0) return `${id} still counted when off`;
        if (after.total < before.total - taiOf(before, id)) return `${id} off: ${before.total} → ${after.total}, more than its ${taiOf(before, id)}`;
      }
      return null;
    });
  });

  it("a pattern with no hand shapes scores as if switched off", T, () => {
    eachCase(16, SHAPE_COUNT, ({ parsed, ctx, rules }) => {
      const before = score(parsed, ctx, rules);
      for (const id of new Set(rows(before).flat().map((m) => m.pattern.id))) {
        const noShapes = JSON.stringify(summary(score(parsed, ctx, withRule(rules, id, (rule) => ({ ...rule, shapes: [] as HandShape[] })))));
        const off = JSON.stringify(summary(score(parsed, ctx, withRule(rules, id, switchedOff))));
        if (noShapes !== off) return `${id}: no shapes ${noShapes}, off ${off}`;
      }
      return null;
    });
  });

  it("dropping every replace edge and stacking every tier never lowers a total", T, () => {
    eachCase(17, SHAPE_COUNT, ({ parsed, ctx, rules }) => {
      const loose = structuredClone(rules);
      for (const rule of Object.values(loose.patterns)) rule.replaces = [];
      for (const ladder of Object.values(loose.ladders)) ladder.exclusive = false;
      const before = score(parsed, ctx, rules).total;
      const after = score(parsed, ctx, loose).total;
      return after >= before ? null : `${before} → ${after}`;
    });
  });
});
