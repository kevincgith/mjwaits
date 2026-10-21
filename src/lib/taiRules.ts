// Saving, loading and checking a TaiRules (the Scoring tab's 設定 sheet).
// The engine side - what each attribute does to a score - lives in
// scoring.ts; the classification in taiCatalog.ts.

import { SITUATION_CHOICE } from "./taiCatalog";
import { CHICKEN_PATTERN_IDS, DEFAULT_TAI_RULES, eligibleShapes, PATTERNS, type HandShape, type PatternRule, type TaiRules } from "./scoring";

export const TAI_RULES_KEY = "mjwaits.taiRules";

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

// One saved pattern rule over its default: anything missing or malformed
// keeps the default, shapes are kept within what the pattern can count on,
// and replaces drops unknown ids and itself.
function normalizeRule(id: string, saved: unknown): PatternRule {
  const base = DEFAULT_TAI_RULES.patterns[id];
  if (!saved || typeof saved !== "object") return structuredClone(base);
  const s = saved as Partial<Record<keyof PatternRule, unknown>>;
  const eligible = eligibleShapes(id);
  const known = new Set(PATTERNS.map((p) => p.id));
  const rule: PatternRule = {
    enabled: typeof s.enabled === "boolean" ? s.enabled : base.enabled,
    tai: isNum(s.tai) ? Math.round(s.tai) : base.tai,
    replaces: Array.isArray(s.replaces) ? [...new Set(s.replaces.filter((r): r is string => typeof r === "string" && known.has(r) && r !== id))] : [...base.replaces],
    shapes: Array.isArray(s.shapes) ? eligible.filter((shape) => (s.shapes as unknown[]).includes(shape)) : [...base.shapes],
    chickenIgnores: CHICKEN_PATTERN_IDS.has(id) ? base.chickenIgnores : typeof s.chickenIgnores === "boolean" ? s.chickenIgnores : base.chickenIgnores,
  };
  if (base.table) {
    rule.table =
      Array.isArray(s.table) && s.table.length === base.table.length && s.table.every(isNum) ? s.table.map((v) => Math.round(v as number)) : [...base.table];
    rule.table[0] = 0;
  }
  if (base.first !== undefined) rule.first = isNum(s.first) ? Math.round(s.first) : base.first;
  return rule;
}

/** A saved ruleset (anything - it came from storage) merged over the
 *  defaults: patterns added since get their defaults, unknown ones drop.
 *  `corrupt` when it wasn't even an object - the sheet says it was reset. */
export function normalizeRules(saved: unknown): { rules: TaiRules; corrupt: boolean } {
  if (saved === null || saved === undefined) return { rules: structuredClone(DEFAULT_TAI_RULES), corrupt: false };
  if (typeof saved !== "object" || Array.isArray(saved)) return { rules: structuredClone(DEFAULT_TAI_RULES), corrupt: true };
  const s = saved as { engine?: unknown; patterns?: unknown };
  const patterns = s.patterns && typeof s.patterns === "object" ? (s.patterns as Record<string, unknown>) : {};
  return {
    rules: {
      engine: s.engine === "legacy" ? "legacy" : "custom",
      patterns: Object.fromEntries(PATTERNS.map((p) => [p.id, normalizeRule(p.id, patterns[p.id])])),
    },
    corrupt: false,
  };
}

export function loadTaiRules(): { rules: TaiRules; corrupt: boolean } {
  try {
    const raw = window.localStorage.getItem(TAI_RULES_KEY);
    if (raw === null) return normalizeRules(null);
    return normalizeRules(JSON.parse(raw));
  } catch {
    return { rules: structuredClone(DEFAULT_TAI_RULES), corrupt: true };
  }
}

export function saveTaiRules(rules: TaiRules): void {
  try {
    if (isDefaultRules(rules)) window.localStorage.removeItem(TAI_RULES_KEY);
    else window.localStorage.setItem(TAI_RULES_KEY, JSON.stringify(rules));
  } catch {
    // Private window / storage blocked: the rules still apply this session.
  }
}

const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x) => b.includes(x));

/** Which parts of one pattern's rule differ from the house list. */
export function ruleChanges(id: string, rule: PatternRule): { value: boolean; enabled: boolean; replaces: boolean; shapes: boolean; chicken: boolean } {
  const base = DEFAULT_TAI_RULES.patterns[id];
  return {
    enabled: rule.enabled !== base.enabled,
    value: rule.tai !== base.tai || rule.first !== base.first || (rule.table ?? []).join() !== (base.table ?? []).join(),
    replaces: !sameSet(rule.replaces, base.replaces),
    shapes: !sameSet(rule.shapes, base.shapes),
    chicken: rule.chickenIgnores !== base.chickenIgnores,
  };
}

export function isRuleChanged(id: string, rule: PatternRule): boolean {
  return Object.values(ruleChanges(id, rule)).some(Boolean);
}

/** How many patterns differ from the house list (the engine choice aside). */
export function changedCount(rules: TaiRules): number {
  return PATTERNS.filter((p) => isRuleChanged(p.id, rules.patterns[p.id])).length;
}

export function isDefaultRules(rules: TaiRules): boolean {
  return rules.engine === "custom" && changedCount(rules) === 0;
}

/** Whether scoring under these rules can differ from the house list. */
export function rulesAffectScoring(rules: TaiRules | undefined): boolean {
  return !!rules && rules.engine === "custom" && changedCount(rules) > 0;
}

// Two patterns tied to different answers of the same situation choice
// (叮 vs 天叮) can never both fire.
function canFireTogether(a: string, b: string): boolean {
  const ca = SITUATION_CHOICE[a];
  const cb = SITUATION_CHOICE[b];
  return !(ca && cb && ca.choice === cb.choice && ca.value !== cb.value);
}

/** Pattern pairs that replace each other (A replaces B and B replaces A,
 *  directly or round a longer loop): when both fire, both are dropped, which
 *  is almost never what a house means. Keyed by every id on such a loop.
 *  Edges between patterns that can never fire together are skipped. */
export function replaceCycles(rules: TaiRules): Map<string, string[]> {
  const edges = (id: string) => (rules.patterns[id]?.replaces ?? []).filter((next) => canFireTogether(id, next));
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

/** Patterns whose `replaces` list includes `id` - the sheet's read-only
 *  "Replaced by" view. */
export function replacedBy(rules: TaiRules, id: string): string[] {
  return PATTERNS.filter((p) => rules.patterns[p.id]?.replaces.includes(id)).map((p) => p.id);
}

export type { HandShape };
