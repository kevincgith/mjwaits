// Named tai rule sets: several saved in localStorage, one in use, each
// exported to a file or shared as a link. A set holds only its differences
// from the house list (a RulesDiff - see taiRules.ts), so it stays small and
// follows the house list wherever it doesn't differ. The house list itself
// is always there, built in, and can't be edited or deleted.

import { DEFAULT_TAI_RULES, type TaiRules } from "@mjwaits/shared/engine/scoring";
import { normalizeRules, rulesDiff, rulesFromDiff, TAI_RULES_KEY, type RulesDiff } from "@mjwaits/shared/engine/taiRules";

export const RULE_SETS_KEY = "mjwaits.taiRuleSets";
// The developer sheet's frozen-engine switch - a device setting, not part of
// any set.
export const ENGINE_KEY = "mjwaits.taiEngine";

export const HOUSE_RULES_NAME = "港式台牌 House rules";

export interface RuleSet {
  id: string;
  name: string;
  diff: RulesDiff;
  updated: number;
}

export interface RuleSetStore {
  v: 1;
  /** The set in use; null = the house list. */
  active: string | null;
  sets: RuleSet[];
}

export const EMPTY_STORE: RuleSetStore = { v: 1, active: null, sets: [] };

export const newSetId = () => `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** `name`, or "name 2", "name 3"… if another set already has it. */
export function uniqueName(sets: readonly RuleSet[], name: string, exceptId?: string): string {
  const base = name.trim().slice(0, 60) || "My rules";
  const taken = new Set(sets.filter((s) => s.id !== exceptId).map((s) => s.name));
  if (!taken.has(base) && base !== HOUSE_RULES_NAME) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base} ${n}`)) return `${base} ${n}`;
}

/** A set's rules (always the configurable engine - see loadEngine). */
export function rulesOfSet(set: RuleSet | undefined): TaiRules {
  return set ? (rulesFromDiff(set.diff) ?? structuredClone(DEFAULT_TAI_RULES)) : structuredClone(DEFAULT_TAI_RULES);
}

/** What a set stores: the differences, never the engine. */
export function diffOf(rules: TaiRules): RulesDiff {
  const { e: _engine, ...diff } = rulesDiff(rules);
  return diff;
}

export function activeSet(store: RuleSetStore): RuleSet | undefined {
  return store.sets.find((s) => s.id === store.active);
}

function normalizeStore(raw: unknown): RuleSetStore | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as { active?: unknown; sets?: unknown };
  if (!Array.isArray(r.sets)) return null;
  const sets: RuleSet[] = [];
  for (const s of r.sets as Partial<RuleSet>[]) {
    if (!s || typeof s.id !== "string" || typeof s.name !== "string" || !s.diff || (s.diff as RulesDiff).v !== 1) continue;
    sets.push({ id: s.id, name: s.name, diff: s.diff as RulesDiff, updated: typeof s.updated === "number" ? s.updated : 0 });
  }
  const active = typeof r.active === "string" && sets.some((s) => s.id === r.active) ? r.active : null;
  return { v: 1, active, sets };
}

/** The saved sets. The first release's single saved ruleset
 *  (mjwaits.taiRules) becomes a set called "My rules", in use. `corrupt`
 *  when what was saved couldn't be read. */
export function loadRuleSets(): { store: RuleSetStore; corrupt: boolean } {
  try {
    const raw = window.localStorage.getItem(RULE_SETS_KEY);
    if (raw !== null) {
      const store = normalizeStore(JSON.parse(raw));
      return store ? { store, corrupt: false } : { store: EMPTY_STORE, corrupt: true };
    }
    const old = window.localStorage.getItem(TAI_RULES_KEY);
    if (old === null) return { store: EMPTY_STORE, corrupt: false };
    const { rules, corrupt } = normalizeRules(JSON.parse(old));
    if (rules.engine === "legacy") saveEngine("legacy");
    const diff = diffOf(rules);
    const store: RuleSetStore =
      Object.keys(diff).length > 1 ? { v: 1, active: "migrated", sets: [{ id: "migrated", name: "My rules", diff, updated: Date.now() }] } : EMPTY_STORE;
    saveRuleSets(store);
    window.localStorage.removeItem(TAI_RULES_KEY);
    return { store, corrupt };
  } catch {
    return { store: EMPTY_STORE, corrupt: true };
  }
}

export function saveRuleSets(store: RuleSetStore): void {
  try {
    if (store.sets.length === 0) window.localStorage.removeItem(RULE_SETS_KEY);
    else window.localStorage.setItem(RULE_SETS_KEY, JSON.stringify(store));
  } catch {
    // Private window / storage blocked: the sets still apply this session.
  }
}

export function loadEngine(): TaiRules["engine"] {
  try {
    return window.localStorage.getItem(ENGINE_KEY) === "legacy" ? "legacy" : "custom";
  } catch {
    return "custom";
  }
}

export function saveEngine(engine: TaiRules["engine"]): void {
  try {
    if (engine === "legacy") window.localStorage.setItem(ENGINE_KEY, "legacy");
    else window.localStorage.removeItem(ENGINE_KEY);
  } catch {
    // Storage blocked - applies this session only.
  }
}

// ---- Files ----

interface RulesFile {
  app: "mjwaits";
  kind: "tai-rules";
  v: 1;
  sets: { name: string; rules: RulesDiff }[];
}

/** A file's contents for these sets - one or several. */
export function exportFile(sets: readonly { name: string; diff: RulesDiff }[]): string {
  const file: RulesFile = { app: "mjwaits", kind: "tai-rules", v: 1, sets: sets.map((s) => ({ name: s.name, rules: s.diff })) };
  return JSON.stringify(file, null, 2);
}

/** A safe file name for a set: "mjwaits-rules-kevins-table.json". */
export function exportFileName(name: string | null): string {
  const slug = (name ?? "all")
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return `mjwaits-rules-${slug || "set"}.json`;
}

/** The sets in an exported file - or an error saying why it can't be read.
 *  Each set goes through the same checks as saved rules, so anything
 *  malformed inside falls back to the house list. */
export function parseImport(text: string): { sets: { name: string; diff: RulesDiff }[] } | { error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { error: "That file isn't a rules file (it isn't JSON)." };
  }
  const f = raw as Partial<RulesFile>;
  if (!f || f.app !== "mjwaits" || f.kind !== "tai-rules" || !Array.isArray(f.sets)) return { error: "That file isn't an MJWaits rules file." };
  const sets: { name: string; diff: RulesDiff }[] = [];
  for (const s of f.sets) {
    const rules = rulesFromDiff(s?.rules);
    if (!rules) continue;
    sets.push({ name: typeof s.name === "string" && s.name.trim() ? s.name.trim().slice(0, 60) : "Imported rules", diff: diffOf(rules) });
  }
  return sets.length > 0 ? { sets } : { error: "There are no rule sets in that file." };
}

// ---- Share links ----

// A link is "#r=z" + base64url(deflate-raw(JSON)): compressed, a set with
// every pattern changed still fits a QR code (~1.5k characters). The first
// release's uncompressed links ("#r=" + base64url(JSON)) still open.
export const RULES_HASH = "#r=";

const toBase64Url = (bytes: Uint8Array) => {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const fromBase64Url = (code: string) => Uint8Array.from(atob(code.replace(/-/g, "+").replace(/_/g, "/")), (ch) => ch.charCodeAt(0));

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Blob([bytes as BlobPart]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(out).arrayBuffer());
}

export async function rulesLink(name: string | null, rules: TaiRules, base = `${window.location.origin}${window.location.pathname}`): Promise<string> {
  const payload = { ...diffOf(rules), ...(name ? { n: name } : {}) };
  const json = new TextEncoder().encode(JSON.stringify(payload));
  return `${base}${RULES_HASH}z${toBase64Url(await pipe(json, new CompressionStream("deflate-raw")))}`;
}

/** A shared link's rules and name, or null if the hash isn't one (or is broken). */
export async function readRulesLink(hash: string): Promise<{ name: string | null; rules: TaiRules } | null> {
  if (!hash.startsWith(RULES_HASH)) return null;
  const code = hash.slice(RULES_HASH.length);
  try {
    const bytes = code.startsWith("z") ? await pipe(fromBase64Url(code.slice(1)), new DecompressionStream("deflate-raw")) : fromBase64Url(code);
    const payload = JSON.parse(new TextDecoder().decode(bytes)) as RulesDiff & { n?: unknown };
    const rules = rulesFromDiff(payload);
    if (!rules) return null;
    rules.engine = "custom";
    return { name: typeof payload.n === "string" && payload.n.trim() ? payload.n.trim().slice(0, 60) : null, rules };
  } catch {
    return null;
  }
}
