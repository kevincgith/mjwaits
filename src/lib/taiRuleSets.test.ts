import { afterEach, beforeEach, describe, expect, it } from "vitest";
import qrcode from "qrcode-generator";
import { DEFAULT_TAI_RULES, PATTERNS, type TaiRules } from "./scoring";
import { normalizeRules, TAI_RULES_KEY } from "./taiRules";
import {
  diffOf,
  ENGINE_KEY,
  exportFile,
  exportFileName,
  loadEngine,
  loadRuleSets,
  parseImport,
  readRulesLink,
  RULE_SETS_KEY,
  rulesLink,
  rulesOfSet,
  saveRuleSets,
  uniqueName,
  type RuleSet,
} from "./taiRuleSets";

const BASE = "https://kevincgith.github.io/mjwaits/";
const withKong = (tai: number): TaiRules => {
  const rules = structuredClone(DEFAULT_TAI_RULES);
  rules.patterns.kong.tai = tai;
  return rules;
};
const set = (id: string, name: string, rules = withKong(3)): RuleSet => ({ id, name, diff: diffOf(rules), updated: 1 });

// A minimal localStorage for the load/save functions.
let memory: Map<string, string>;
beforeEach(() => {
  memory = new Map();
  (globalThis as { window?: unknown }).window = {
    localStorage: {
      getItem: (k: string) => memory.get(k) ?? null,
      setItem: (k: string, v: string) => void memory.set(k, v),
      removeItem: (k: string) => void memory.delete(k),
    },
  };
});
afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe("rule sets in storage", () => {
  it("starts with just the house rules", () => {
    expect(loadRuleSets()).toEqual({ store: { v: 1, active: null, sets: [] }, corrupt: false });
  });

  it("saves and loads sets, and which one is in use", () => {
    const store = { v: 1 as const, active: "a", sets: [set("a", "Kevin's table"), set("b", "Office", withKong(4))] };
    saveRuleSets(store);
    const loaded = loadRuleSets().store;
    expect(loaded.active).toBe("a");
    expect(loaded.sets.map((s) => s.name)).toEqual(["Kevin's table", "Office"]);
    expect(rulesOfSet(loaded.sets[1]).patterns.kong.tai).toBe(4);
  });

  it("moves the first release's single saved ruleset into a set called My rules, in use", () => {
    memory.set(TAI_RULES_KEY, JSON.stringify({ ...withKong(3), engine: "legacy" }));
    const { store } = loadRuleSets();
    expect(store.sets.map((s) => s.name)).toEqual(["My rules"]);
    expect(store.active).toBe(store.sets[0].id);
    expect(rulesOfSet(store.sets[0]).patterns.kong.tai).toBe(3);
    expect(memory.has(TAI_RULES_KEY)).toBe(false);
    expect(memory.has(RULE_SETS_KEY)).toBe(true);
    // The engine is a device setting now, not part of the set.
    expect(memory.get(ENGINE_KEY)).toBe("legacy");
    expect(loadEngine()).toBe("legacy");
  });

  it("reports unreadable storage and falls back to the house rules", () => {
    memory.set(RULE_SETS_KEY, "not json");
    expect(loadRuleSets()).toEqual({ store: { v: 1, active: null, sets: [] }, corrupt: true });
  });

  it("drops a missing active set back to the house rules", () => {
    memory.set(RULE_SETS_KEY, JSON.stringify({ v: 1, active: "gone", sets: [set("a", "A")] }));
    expect(loadRuleSets().store.active).toBeNull();
  });

  it("names a set uniquely", () => {
    const sets = [set("a", "My rules"), set("b", "My rules 2")];
    expect(uniqueName(sets, "My rules")).toBe("My rules 3");
    expect(uniqueName(sets, "Office")).toBe("Office");
    expect(uniqueName(sets, "My rules", "a")).toBe("My rules");
    expect(uniqueName(sets, "  ")).toBe("My rules 3");
  });
});

describe("export and import", () => {
  it("round-trips one set or several through a file", () => {
    const text = exportFile([set("a", "Kevin's table"), set("b", "Office", withKong(4))]);
    const result = parseImport(text);
    if ("error" in result) throw new Error(result.error);
    expect(result.sets.map((s) => s.name)).toEqual(["Kevin's table", "Office"]);
    expect(rulesOfSet({ id: "x", updated: 0, ...result.sets[1] }).patterns.kong.tai).toBe(4);
  });

  it("explains a file it can't use", () => {
    expect(parseImport("nope")).toEqual({ error: "That file isn't a rules file (it isn't JSON)." });
    expect(parseImport(JSON.stringify({ hello: 1 }))).toEqual({ error: "That file isn't an MJWaits rules file." });
    expect(parseImport(JSON.stringify({ app: "mjwaits", kind: "tai-rules", v: 1, sets: [] }))).toEqual({ error: "There are no rule sets in that file." });
  });

  it("makes a safe file name", () => {
    expect(exportFileName("Kevin's table!")).toBe("mjwaits-rules-kevin-s-table.json");
    expect(exportFileName("港式 規則")).toBe("mjwaits-rules-港式-規則.json");
    expect(exportFileName(null)).toBe("mjwaits-rules-all.json");
  });
});

describe("share links", () => {
  it("round-trips the rules and the name", async () => {
    const url = await rulesLink("Kevin's table", withKong(3), BASE);
    expect(url.startsWith(`${BASE}#r=z`)).toBe(true);
    const shared = await readRulesLink(url.slice(url.indexOf("#")));
    expect(shared?.name).toBe("Kevin's table");
    expect(shared?.rules).toEqual(withKong(3));
  });

  it("still opens the first release's uncompressed links", async () => {
    const old = `#r=${btoa(JSON.stringify({ v: 1, p: { kong: { tai: 3 } } }))}`;
    expect((await readRulesLink(old))?.rules.patterns.kong.tai).toBe(3);
  });

  it("ignores other hashes and broken links", async () => {
    expect(await readRulesLink("#s=abc")).toBeNull();
    expect(await readRulesLink("#r=z!!!")).toBeNull();
  });

  it("fits a QR code even with every pattern changed", async () => {
    const rules = structuredClone(DEFAULT_TAI_RULES);
    for (const p of PATTERNS) {
      rules.patterns[p.id].tai += 1;
      rules.patterns[p.id].enabled = false;
    }
    const url = await rulesLink("Everything changed", rules, BASE);
    const qr = qrcode(0, "L");
    qr.addData(url);
    expect(() => qr.make()).not.toThrow();
    // Switched off comes back as 0 = off.
    expect((await readRulesLink(url.slice(url.indexOf("#"))))?.rules).toEqual(normalizeRules(rules).rules);
  });
});
