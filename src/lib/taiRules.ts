// Reading, comparing and diffing a TaiRules (the Scoring tab's 設定 sheet);
// named sets, files and share links are in taiRuleSets.ts. The engine side - what each attribute does to a score - lives in
// scoring.ts; the classification in taiCatalog.ts.

import { LADDERS, pairOf, PATTERN_CATALOG, SITUATION_CHOICE, type OpenConcealedPair } from "./taiCatalog";
import {
  CHICKEN_PATTERN_IDS,
  DEFAULT_TAI_RULES,
  effectiveReplaces,
  eligibleShapes,
  HAND_SHAPES,
  PATTERNS,
  type HandShape,
  type PatternRule,
  type TaiRules,
} from "./scoring";

// Where the first release saved its one ruleset - read once, to move it into
// a named set (loadRuleSets in taiRuleSets.ts).
export const TAI_RULES_KEY = "mjwaits.taiRules";

const KNOWN_IDS = new Set(PATTERNS.map((p) => p.id));
const NAME_BY_ID = new Map(PATTERNS.map((p) => [p.id, p.name]));
const LADDER_BY_ID = new Map(LADDERS.map((l) => [l.id, l]));
// What a pattern's ladder already replaces for it - never stored as its own edge.
const LADDER_BELOW = new Map(LADDERS.filter((l) => l.kind !== "windows").flatMap((l) => l.rungs.flatMap((rung, i) => rung.map((id) => [id, new Set(l.rungs.slice(0, i).flat())] as const))));

/** "清一色 (One numbered suit, no honors)" -> "清一色" */
export function shortName(id: string): string {
  const name = NAME_BY_ID.get(id) ?? id;
  const at = name.indexOf(" (");
  return at === -1 ? name : name.slice(0, at);
}

/** A 明/暗 pair's shared name, from its 明 pattern: "明清龍 (Pure straight,
 *  open)" -> ["清龍", "Pure straight"]. */
export function pairName(pair: OpenConcealedPair): [string, string] {
  const name = NAME_BY_ID.get(pair.open) ?? pair.id;
  const at = name.indexOf(" (");
  const zh = (at === -1 ? name : name.slice(0, at)).replace(/^明/, "");
  const en = at === -1 ? "" : name.slice(at + 2, -1).replace(/,? ?open$/i, "").trim();
  return [zh, en];
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

// One saved pattern rule over its default: anything missing or malformed
// keeps the default, shapes stay within what the pattern can count on, and
// replaces drops unknown ids, itself, and what its ladder already covers.
// Reads the first release's `chickenIgnores` (the inverse of blocksChicken).
function normalizeRule(id: string, saved: unknown): PatternRule {
  const base = DEFAULT_TAI_RULES.patterns[id];
  if (!saved || typeof saved !== "object") return structuredClone(base);
  const s = saved as Partial<Record<keyof PatternRule | "chickenIgnores", unknown>>;
  const below = LADDER_BELOW.get(id);
  const blocks = typeof s.blocksChicken === "boolean" ? s.blocksChicken : typeof s.chickenIgnores === "boolean" ? !s.chickenIgnores : base.blocksChicken;
  const rule: PatternRule = {
    enabled: typeof s.enabled === "boolean" ? s.enabled : base.enabled,
    tai: isNum(s.tai) ? Math.round(s.tai) : base.tai,
    replaces: Array.isArray(s.replaces)
      ? [...new Set(s.replaces.filter((r): r is string => typeof r === "string" && KNOWN_IDS.has(r) && r !== id && !below?.has(r)))]
      : [...base.replaces],
    shapes: Array.isArray(s.shapes) ? eligibleShapes(id).filter((shape) => (s.shapes as unknown[]).includes(shape)) : [...base.shapes],
    blocksChicken: CHICKEN_PATTERN_IDS.has(id) ? base.blocksChicken : blocks,
  };
  if (base.table) {
    rule.table = Array.isArray(s.table) && s.table.length === base.table.length && s.table.every(isNum) ? s.table.map((v) => Math.round(v as number)) : [...base.table];
    rule.table[0] = 0;
  }
  if (base.first !== undefined) rule.first = isNum(s.first) ? Math.round(s.first) : base.first;
  // 0 = off: a rule switched off (an older save, or a share link) becomes a
  // value of 0, so the sheet has one thing to show - the number.
  if (!rule.enabled) return switchedOff(rule);
  return rule;
}

/** A rule with every value at 0 - off, the one way 設定 shows it. */
export function switchedOff(rule: PatternRule): PatternRule {
  return { ...rule, enabled: true, tai: 0, ...(rule.table ? { table: rule.table.map(() => 0) } : {}), ...(rule.first !== undefined ? { first: 0 } : {}) };
}

/** Whether a rule counts for anything: on, and some value above 0. */
export function isRuleOn(rule: PatternRule): boolean {
  if (!rule.enabled) return false;
  if (rule.table) return rule.table.some((v) => v > 0);
  return rule.tai > 0 || (rule.first ?? 0) > 0;
}

/** A saved ruleset (anything - it came from storage or a link) merged over
 *  the defaults: patterns and ladders added since get their defaults,
 *  unknown ones drop. `corrupt` when it wasn't even an object. */
export function normalizeRules(saved: unknown): { rules: TaiRules; corrupt: boolean } {
  if (saved === null || saved === undefined) return { rules: structuredClone(DEFAULT_TAI_RULES), corrupt: false };
  if (typeof saved !== "object" || Array.isArray(saved)) return { rules: structuredClone(DEFAULT_TAI_RULES), corrupt: true };
  const s = saved as { engine?: unknown; patterns?: unknown; ladders?: unknown };
  const patterns = s.patterns && typeof s.patterns === "object" ? (s.patterns as Record<string, unknown>) : {};
  const ladders = s.ladders && typeof s.ladders === "object" ? (s.ladders as Record<string, { exclusive?: unknown }>) : {};
  return {
    rules: {
      engine: s.engine === "legacy" ? "legacy" : "custom",
      patterns: Object.fromEntries(PATTERNS.map((p) => [p.id, normalizeRule(p.id, patterns[p.id])])),
      ladders: Object.fromEntries(LADDERS.map((l) => [l.id, { exclusive: typeof ladders[l.id]?.exclusive === "boolean" ? (ladders[l.id].exclusive as boolean) : true }])),
    },
    corrupt: false,
  };
}

/** The rules a pattern's example is shown and checked under: the house
 *  list, with that one pattern worth 1 if the house leaves it at 0 (正圈風,
 *  the longer 連刻 tiers…) - an example is about showing it counting at all.
 *  Only that one pattern: switching every 0 pattern on at once can change
 *  how a hand is best read, and the example would then show something else. */
const exampleRulesCache = new Map<string, TaiRules>();
export function exampleRulesFor(id: string): TaiRules {
  const rule = DEFAULT_TAI_RULES.patterns[id];
  if (!rule || rule.tai !== 0 || rule.table) return DEFAULT_TAI_RULES;
  let rules = exampleRulesCache.get(id);
  if (!rules) {
    rules = structuredClone(DEFAULT_TAI_RULES);
    rules.patterns[id].tai = 1;
    exampleRulesCache.set(id, rules);
  }
  return rules;
}

// ---- Comparing with the house list ----

const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x) => b.includes(x));

/** Which parts of one pattern's rule differ from the house list. */
export function ruleChanges(id: string, rule: PatternRule): { value: boolean; enabled: boolean; replaces: boolean; shapes: boolean; chicken: boolean } {
  const base = DEFAULT_TAI_RULES.patterns[id];
  const on = isRuleOn(rule);
  const sameValue = rule.tai === base.tai && rule.first === base.first && (rule.table ?? []).join() === (base.table ?? []).join();
  return {
    // Off (0, or an older save's switch) shows as a value change: "槓 2 → off".
    enabled: false,
    value: on !== isRuleOn(base) || (on && !sameValue),
    replaces: !sameSet(rule.replaces, base.replaces),
    shapes: !sameSet(rule.shapes, base.shapes),
    chicken: rule.blocksChicken !== base.blocksChicken,
  };
}

export function isRuleChanged(id: string, rule: PatternRule): boolean {
  return Object.values(ruleChanges(id, rule)).some(Boolean);
}

/** Changed in a way its own row in 設定 shows - everything but the 大雞/大鴨
 *  ignore list, which has its own setting. */
export function isRowChanged(id: string, rule: PatternRule): boolean {
  const { chicken: _chicken, ...rest } = ruleChanges(id, rule);
  return Object.values(rest).some(Boolean);
}

/** The patterns 大雞/大鴨 ignore (don't count against them), in PATTERNS order. */
export function chickenIgnores(rules: TaiRules): string[] {
  return PATTERNS.filter((p) => !CHICKEN_PATTERN_IDS.has(p.id) && rules.patterns[p.id]?.blocksChicken === false).map((p) => p.id);
}

/** 大雞/大鴨's ignore list in two plain groups - the 設定 switches. 底 is
 *  always ignored and in neither group. "situations" is everything the house
 *  list ignores that's declared rather than seen in the tiles. */
export const CHICKEN_GROUPS: { id: string; label: string; help: string; ids: string[] }[] = (() => {
  const flowers = ["no-flowers", "correct-flower", "wrong-flower"];
  const houseIgnored = PATTERNS.map((p) => p.id).filter((id) => !CHICKEN_PATTERN_IDS.has(id) && !DEFAULT_TAI_RULES.patterns[id].blocksChicken);
  return [
    {
      id: "situations",
      label: "Situations don't stop them",
      help: "莊, 叮, 天胡, 搶槓, 雙響, 海底… - declared on the 情況 buttons, not seen in the tiles.",
      ids: houseIgnored.filter((id) => id !== "base-tai" && !flowers.includes(id)),
    },
    { id: "flowers", label: "Flowers don't stop them", help: "無花, 正花, 爛花 - with at most one flower either way.", ids: flowers },
  ];
})();

export function isChickenListChanged(rules: TaiRules): boolean {
  return PATTERNS.some((p) => ruleChanges(p.id, rules.patterns[p.id]).chicken);
}

// Only a count family can be switched to stacking (see Ladder in taiCatalog.ts).
export const isLadderChanged = (rules: TaiRules, ladderId: string) =>
  LADDER_BY_ID.get(ladderId)?.kind !== "windows" && rules.ladders[ladderId]?.exclusive === false;

/** How many patterns and ladders differ from the house list. */
export function changedCount(rules: TaiRules): number {
  return PATTERNS.filter((p) => isRuleChanged(p.id, rules.patterns[p.id])).length + LADDERS.filter((l) => isLadderChanged(rules, l.id)).length;
}

export function isDefaultRules(rules: TaiRules): boolean {
  return rules.engine === "custom" && changedCount(rules) === 0;
}

/** Whether scoring under these rules can differ from the house list. */
export function rulesAffectScoring(rules: TaiRules | undefined): boolean {
  return !!rules && rules.engine === "custom" && changedCount(rules) > 0;
}

function valueText(id: string, rule: PatternRule): string {
  if (!isRuleOn(rule)) return "off";
  const value = PATTERN_CATALOG[id].value;
  if (value.kind === "table") return (rule.table ?? []).slice(1).join("/");
  if (value.kind === "streak") return `${rule.first ?? value.first} +${rule.tai}`;
  return value.kind === "per" ? `${rule.tai} each` : String(rule.tai);
}

const shapeLabel = (shape: HandShape) => HAND_SHAPES.find((s) => s.id === shape)?.label ?? shape;

export type RuleChange = {
  target: { kind: "pattern" | "ladder"; id: string } | { kind: "engine" };
  text: string;
  /** Set for a change to the 大雞/大鴨 ignore list (one pattern's blocksChicken). */
  chicken?: boolean;
};

/** Every difference from the house list, in words - the sheet's summary. */
export function describeChanges(rules: TaiRules): RuleChange[] {
  const out: RuleChange[] = [];
  if (rules.engine === "legacy") out.push({ target: { kind: "engine" }, text: "Scoring with the original built-in rules" });
  for (const l of LADDERS)
    if (isLadderChanged(rules, l.id)) out.push({ target: { kind: "ladder", id: l.id }, text: `${l.label}: every tier counts (stacks)` });
  for (const p of PATTERNS) {
    const rule = rules.patterns[p.id];
    const base = DEFAULT_TAI_RULES.patterns[p.id];
    const c = ruleChanges(p.id, rule);
    const target = { kind: "pattern" as const, id: p.id };
    // A 明/暗 half is named by its pair and side: "般高 暗".
    const pair = pairOf(p.id);
    const name = pair ? `${pairName(pair)[0]} ${pair.open === p.id ? "明" : "暗"}` : shortName(p.id);
    if (c.enabled) out.push({ target, text: rule.enabled ? `${name} on` : `${name} off` });
    if (c.value) out.push({ target, text: `${name} ${valueText(p.id, base)} → ${valueText(p.id, rule)}` });
    for (const r of rule.replaces) if (!base.replaces.includes(r)) out.push({ target, text: `${name} replaces ${shortName(r)}` });
    for (const r of base.replaces) if (!rule.replaces.includes(r)) out.push({ target, text: `${name} stacks with ${shortName(r)}` });
    for (const s of base.shapes) if (!rule.shapes.includes(s)) out.push({ target, text: `${name} not on ${shapeLabel(s)}` });
    for (const s of rule.shapes) if (!base.shapes.includes(s)) out.push({ target, text: `${name} on ${shapeLabel(s)}` });
    if (c.chicken) out.push({ target, text: rule.blocksChicken ? `大雞/大鴨 no longer ignore ${name}` : `大雞/大鴨 ignore ${name}`, chicken: true });
  }
  return out;
}

// ---- Loops and reverse edges ----

// Two patterns tied to different answers of the same situation choice
// (叮 vs 天叮) can never both fire.
function canFireTogether(a: string, b: string): boolean {
  const ca = SITUATION_CHOICE[a];
  const cb = SITUATION_CHOICE[b];
  return !(ca && cb && ca.choice === cb.choice && ca.value !== cb.value);
}

/** Patterns that replace each other (A replaces B and B replaces A,
 *  directly or round a longer loop, ladders included): when both fire, both
 *  are dropped, which is almost never what a house means. Keyed by every id
 *  on such a loop. Edges between patterns that can never fire together are
 *  skipped. */
export function replaceCycles(rules: TaiRules): Map<string, string[]> {
  const edges = (id: string) => effectiveReplaces(rules, id).filter((next) => canFireTogether(id, next));
  const out = new Map<string, string[]>();
  for (const start of PATTERNS.map((p) => p.id)) {
    // Depth-first from `start`, looking for a path back to it.
    const stack: string[][] = edges(start).map((next) => [start, next]);
    const seen = new Set<string>();
    while (stack.length > 0) {
      const path = stack.pop()!;
      const last = path[path.length - 1];
      if (last === start) {
        out.set(start, path.slice(1, -1).length > 0 ? path.slice(1, -1) : [start]);
        break;
      }
      if (seen.has(last)) continue;
      seen.add(last);
      for (const next of edges(last)) stack.push([...path, next]);
    }
  }
  return out;
}

/** Patterns that replace `id` (ladders included) - the sheet's read-only
 *  "Replaced by" view. */
export function replacedBy(rules: TaiRules, id: string): string[] {
  return PATTERNS.filter((p) => effectiveReplaces(rules, p.id).includes(id)).map((p) => p.id);
}

/** The ladder a pattern sits on, if any. */
export function ladderOf(id: string) {
  return LADDERS.find((l) => l.rungs.some((rung) => rung.includes(id)));
}

// ---- A compact diff: what sets, files, links and fingerprints hold ----

export interface RulesDiff {
  v: 1;
  e?: "legacy";
  p?: Record<string, Partial<PatternRule>>;
  l?: Record<string, false>;
}

/** Just what differs from the house list, field by field. */
export function rulesDiff(rules: TaiRules): RulesDiff {
  const diff: RulesDiff = { v: 1 };
  if (rules.engine === "legacy") diff.e = "legacy";
  for (const p of PATTERNS) {
    // Off travels as values of 0 (0 = off), never as a separate switch.
    const rule = isRuleOn(rules.patterns[p.id]) ? rules.patterns[p.id] : switchedOff(rules.patterns[p.id]);
    const c = ruleChanges(p.id, rule);
    const part: Partial<PatternRule> = {};
    if (c.enabled) part.enabled = rule.enabled;
    if (c.value) {
      part.tai = rule.tai;
      if (rule.table) part.table = rule.table;
      if (rule.first !== undefined) part.first = rule.first;
    }
    if (c.replaces) part.replaces = rule.replaces;
    if (c.shapes) part.shapes = rule.shapes;
    if (c.chicken) part.blocksChicken = rule.blocksChicken;
    if (Object.keys(part).length > 0) (diff.p ??= {})[p.id] = part;
  }
  for (const l of LADDERS) if (isLadderChanged(rules, l.id)) (diff.l ??= {})[l.id] = false;
  return diff;
}

/** A diff back onto the house list (malformed parts keep their defaults). */
export function rulesFromDiff(diff: unknown): TaiRules | null {
  if (!diff || typeof diff !== "object" || (diff as RulesDiff).v !== 1) return null;
  const d = diff as RulesDiff;
  const patterns: Record<string, unknown> = {};
  for (const p of PATTERNS) patterns[p.id] = { ...DEFAULT_TAI_RULES.patterns[p.id], ...(d.p?.[p.id] ?? {}) };
  const ladders = Object.fromEntries(LADDERS.map((l) => [l.id, { exclusive: d.l?.[l.id] !== false }]));
  return normalizeRules({ engine: d.e === "legacy" ? "legacy" : "custom", patterns, ladders }).rules;
}

/** A short, stable id for a ruleset that scores differently from the house
 *  list - stamped on Recent hands and Scores entries, so a total worked out
 *  under other rules can be told apart. null for the house list (and the
 *  original engine, which scores the same). */
export function rulesFingerprint(rules: TaiRules | undefined): string | null {
  if (!rules || !rulesAffectScoring(rules)) return null;
  const text = JSON.stringify(rulesDiff(rules));
  // FNV-1a, 32-bit.
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
}

export { LADDER_BY_ID };
export type { HandShape };
