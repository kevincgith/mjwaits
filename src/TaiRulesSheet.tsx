// The Scoring tab's 設定 sheet: every pattern's tai, its ladder, what else it
// replaces, which hand shapes it counts on and whether it blocks 大雞/大鴨 -
// the house's tai rules as data (TaiRules in lib/scoring.ts, the
// classification in lib/taiCatalog.ts). Edits a draft, previewed live on the
// hand in the tab; nothing applies until Save.

import qrcode from "qrcode-generator";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { PatternExampleView } from "./PatternExample";
import { RulesReference } from "./RulesReference";
import { PATTERN_ALIASES } from "./lib/patternGuide";
import { PATTERN_PARTNERS } from "./lib/patternPartners";
import { situationLinkRows } from "./lib/situationLinks";
import { NumberField, Segmented, Sheet, Toggle } from "./ScoresPanel";
import {
  CHICKEN_PATTERN_IDS,
  DEFAULT_TAI_RULES,
  effectiveReplaces,
  eligibleShapes,
  HAND_SHAPES,
  PATTERNS,
  type PatternRule,
  type TaiRules,
} from "./lib/scoring";
import { LADDERS, pairOf, PATTERN_CATALOG, PATTERN_FAMILIES, type Ladder, type OpenConcealedPair, type PatternFamily } from "./lib/taiCatalog";
import {
  activeSet,
  diffOf,
  exportFile,
  exportFileName,
  HOUSE_RULES_NAME,
  newSetId,
  parseImport,
  rulesLink,
  rulesOfSet,
  uniqueName,
  type RuleSet,
  type RuleSetStore,
} from "./lib/taiRuleSets";
import {
  CHICKEN_GROUPS,
  changedCount,
  chickenIgnores,
  describeChanges,
  isChickenListChanged,
  isRowChanged,
  isRuleOn,
  pairName,
  isLadderChanged,
  ladderOf,
  replaceCycles,
  replacedBy,
  shortName,
  type RuleChange,
} from "./lib/taiRules";

const NAME_BY_ID = new Map(PATTERNS.map((p) => [p.id, p.name]));
// "清一色 (One numbered suit, no honors)" -> ["清一色", "One numbered suit, no honors"]
function splitName(id: string): [string, string] {
  const name = NAME_BY_ID.get(id) ?? id;
  const at = name.indexOf(" (");
  return at === -1 ? [name, ""] : [name.slice(0, at), name.slice(at + 2, -1)];
}

const SHAPE_LABEL = new Map(HAND_SHAPES.map((s) => [s.id, s.label]));

// A ladder shows under the family of its top rung; its patterns show only
// there (無花 sits on the 無字/無花 ladder, under 字 Suit purity).
const ladderFamily = (l: Ladder): PatternFamily => PATTERN_CATALOG[l.rungs[l.rungs.length - 1][0]].family;
const familyOfPattern = (id: string): PatternFamily => {
  const l = ladderOf(id);
  return l ? ladderFamily(l) : PATTERN_CATALOG[id].family;
};
const ON_LADDER = new Set(LADDERS.flatMap((l) => l.rungs.flat()));

// A 明/暗 pair is one row in the sheet, keyed by its stem; anything else by
// its own id.
const rowKey = (id: string) => pairOf(id)?.id ?? id;

// Patterns that can count on the same hand as `id`, for the "Replaces"
// picker: seen together in the scoring tests' hands (patternPartners.ts),
// plus every situation (declared, so possible with any hand). A situation's
// own likely partners are the state and wait patterns it might replace
// (天胡 over 自摸, 門前清…); a special-hand pattern's, those that can count on
// the same special hand.
const SITUATION_IDS = PATTERNS.map((p) => p.id).filter((id) => PATTERN_CATALOG[id].family === "situation");
function likelyPartners(id: string): Set<string> {
  const family = PATTERN_CATALOG[id].family;
  if (family === "special") {
    const shapes: string[] = eligibleShapes(id).filter((shape) => shape !== "normal");
    return new Set(PATTERNS.map((p) => p.id).filter((other) => eligibleShapes(other).some((shape) => shapes.includes(shape))));
  }
  if (family === "situation") {
    return new Set(PATTERNS.map((p) => p.id).filter((other) => ["situation", "foundation", "completion"].includes(PATTERN_CATALOG[other].family)));
  }
  return new Set([...(PATTERN_PARTNERS[id] ?? []), ...SITUATION_IDS]);
}

// A pattern's other names (patternGuide.ts), by its own id or its pair's.
const aliasesOf = (id: string): string[] => PATTERN_ALIASES[id] ?? PATTERN_ALIASES[pairOf(id)?.id ?? ""] ?? [];
// Its English name, then "aka …" when it has other names.
const subName = (en: string, id: string) => [en, aliasesOf(id).length > 0 ? `aka ${aliasesOf(id).join("、")}` : ""].filter(Boolean).join(" · ");

function valueSummary(id: string, rule: PatternRule): string {
  if (!isRuleOn(rule)) return "off";
  const value = PATTERN_CATALOG[id].value;
  if (value.kind === "table") return (rule.table ?? []).slice(1).join("/");
  if (value.kind === "streak") return `${rule.first ?? value.first}, +${rule.tai} each 連莊`;
  return String(rule.tai);
}

// Sets as comparable text: keys sorted, save times left out - so "would
// Save change anything" doesn't trip on key order or a fresh timestamp.
function canonical(sets: readonly RuleSet[]): string {
  const sorted = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sorted)
      : v && typeof v === "object"
        ? Object.fromEntries(Object.keys(v).filter((k) => k !== "updated").sort().map((k) => [k, sorted((v as Record<string, unknown>)[k])]))
        : v;
  return JSON.stringify(sorted(sets));
}

// Which set the sheet is editing: the house list (read-only - editing it
// starts a new set) or one of the saved sets.
type Selected = string | null;

export function TaiRulesSheet({
  store,
  engine,
  incoming,
  corrupt,
  previewTotal,
  onSave,
  onClose,
}: {
  store: RuleSetStore;
  /** Which engine scores - a phone-wide setting, not part of any set:
   *  "legacy" is the frozen original engine and ignores every set. */
  engine: TaiRules["engine"];
  /** Rules from a shared link: they open as a new set, to review. */
  incoming: { name: string | null; rules: TaiRules } | null;
  /** The saved sets couldn't be read and were reset. */
  corrupt: boolean;
  /** The tab's current hand scored under some rules - null if it can't be. */
  previewTotal: (rules: TaiRules) => number | null;
  /** Every set (renamed, added, deleted, edited) with the selected one in
   *  use, and the engine. */
  onSave: (store: RuleSetStore, engine: TaiRules["engine"]) => void;
  onClose: () => void;
}) {
  // The whole sheet is a draft: the sets and each one's edited rules. A
  // shared link's rules arrive as a new set, selected.
  const [initial] = useState(() => {
    const sets = [...store.sets];
    const drafts: Record<string, TaiRules> = {};
    let selected: Selected = store.active;
    if (incoming) {
      const id = newSetId();
      sets.push({ id, name: uniqueName(sets, incoming.name ?? "Shared rules"), diff: diffOf(incoming.rules), updated: Date.now() });
      drafts[id] = incoming.rules;
      selected = id;
    }
    return { sets, drafts, selected };
  });
  const [sets, setSets] = useState<RuleSet[]>(initial.sets);
  const [drafts, setDrafts] = useState<Record<string, TaiRules>>(initial.drafts);
  const [selected, setSelected] = useState<Selected>(initial.selected);
  const [query, setQuery] = useState("");
  const [changedOnly, setChangedOnly] = useState(false);
  const [openFamilies, setOpenFamilies] = useState<Set<PatternFamily>>(() => new Set());
  const [expanded, setExpanded] = useState<string | null>(null);
  const [reveal, setReveal] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);
  const [notice, setNotice] = useState<{ text: string; bad?: boolean } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [advanced, setAdvanced] = useState(engine === "legacy");
  const importRef = useRef<HTMLInputElement>(null);

  const selectedSet = sets.find((s) => s.id === selected);
  const draft = useMemo<TaiRules>(
    () => (selected === null ? DEFAULT_TAI_RULES : (drafts[selected] ?? rulesOfSet(selectedSet))),
    [selected, drafts, selectedSet],
  );
  const name = selectedSet?.name ?? HOUSE_RULES_NAME;

  // Editing the house list starts a new set from it ("My rules"), selected.
  const edit = (update: (prev: TaiRules) => TaiRules) => {
    setConfirmReset(false);
    setConfirmClose(false);
    if (selected === null) {
      const id = newSetId();
      setSets((prev) => [...prev, { id, name: uniqueName(prev, "My rules"), diff: { v: 1 }, updated: Date.now() }]);
      setDrafts((prev) => ({ ...prev, [id]: update(structuredClone(DEFAULT_TAI_RULES)) }));
      setSelected(id);
      setNotice({ text: "Editing a copy of the house rules - it's saved as a new set." });
      return;
    }
    const id = selected;
    setDrafts((prev) => ({ ...prev, [id]: update(prev[id] ?? rulesOfSet(selectedSet)) }));
  };
  // Editing a value is the only on/off there is: 0 = off. (enabled stays
  // true; an older save's switched-off rule is loaded as 0 - see
  // normalizeRules.)
  const setRule = (id: string, patch: Partial<PatternRule>) =>
    edit((prev) => ({ ...prev, patterns: { ...prev.patterns, [id]: { ...prev.patterns[id], ...patch } } }));
  // Several patterns in one edit - so editing the house list starts one new
  // set, not one per pattern.
  const setRules = (patches: Record<string, Partial<PatternRule>>) =>
    edit((prev) => ({
      ...prev,
      patterns: { ...prev.patterns, ...Object.fromEntries(Object.entries(patches).map(([id, patch]) => [id, { ...prev.patterns[id], ...patch }])) },
    }));
  const resetRule = (id: string) => setRule(id, structuredClone(DEFAULT_TAI_RULES.patterns[id]));
  const setLadder = (id: string, exclusive: boolean) => edit((prev) => ({ ...prev, ladders: { ...prev.ladders, [id]: { exclusive } } }));

  const cycles = useMemo(() => replaceCycles(draft), [draft]);
  const changes = useMemo(() => describeChanges(draft), [draft]);
  const changed = changedCount(draft);
  const [draftEngine, setDraftEngine] = useState(engine);
  const legacy = draftEngine === "legacy";

  // Live preview: the hand in the tab under the rules in use and this set.
  const inUse = useMemo(() => rulesOfSet(activeSet(store)), [store]);
  const savedTotal = useMemo(() => previewTotal(inUse), [previewTotal, inUse]);
  const draftTotal = useMemo(() => previewTotal(draft), [previewTotal, draft]);

  // ---- Sets ----
  const pick = (id: Selected) => {
    setSelected(id);
    setConfirmDelete(false);
    setConfirmReset(false);
    setNotice(null);
  };
  const addSet = (setName: string, rules: TaiRules) => {
    const id = newSetId();
    setSets((prev) => [...prev, { id, name: uniqueName(prev, setName), diff: diffOf(rules), updated: Date.now() }]);
    setDrafts((prev) => ({ ...prev, [id]: rules }));
    pick(id);
  };
  const rename = (next: string) => {
    if (selected === null) return;
    setSets((prev) => prev.map((s) => (s.id === selected ? { ...s, name: next.slice(0, 60) } : s)));
  };
  const remove = () => {
    if (selected === null) return;
    setSets((prev) => prev.filter((s) => s.id !== selected));
    pick(null);
    setNotice({ text: `Deleted "${name}" - Save to make it final.` });
  };
  // The sets as they'd be saved now: each one's edits folded into its diff,
  // and blank names given back.
  const finalSets = (): RuleSet[] =>
    sets.map((s) => {
      const rules = drafts[s.id];
      const named = s.name.trim() ? s.name.trim() : uniqueName(sets, "My rules", s.id);
      return rules ? { ...s, name: named, diff: diffOf(rules), updated: Date.now() } : { ...s, name: named };
    });
  // Anything Save would change: an edited, added, renamed or deleted set, or
  // the engine. Picking another set isn't a change (Save & use switches).
  const unsaved = () => draftEngine !== engine || !!incoming || canonical(finalSets()) !== canonical(store.sets);
  // Closing (✕, Escape, a tap outside) asks first rather than silently
  // dropping edits.
  const close = () => (unsaved() ? setConfirmClose(true) : onClose());
  const download = (fileSets: RuleSet[], fileName: string) => {
    const url = URL.createObjectURL(new Blob([exportFile(fileSets)], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const exportSelected = () => {
    const set = finalSets().find((s) => s.id === selected);
    if (set) download([set], exportFileName(set.name));
  };
  const exportAll = () => download(finalSets(), exportFileName(null));
  const importFile = async (file: File) => {
    const result = parseImport(await file.text());
    if ("error" in result) return setNotice({ text: result.error, bad: true });
    const next = [...sets];
    for (const s of result.sets) next.push({ id: newSetId() + next.length, name: uniqueName(next, s.name), diff: s.diff, updated: Date.now() });
    setSets(next);
    pick(next[sets.length].id);
    setNotice({ text: `Imported ${result.sets.length} rule set${result.sets.length === 1 ? "" : "s"} - Save to keep ${result.sets.length === 1 ? "it" : "them"}.` });
  };

  // Jump to a pattern from the changes list: open its family, expand it,
  // scroll it into view once it's rendered.
  const revealPattern = (id: string) => {
    setQuery("");
    setChangedOnly(false);
    setOpenFamilies((prev) => new Set(prev).add(familyOfPattern(id)));
    setExpanded(rowKey(id));
    setReveal(rowKey(id));
  };
  const revealLadder = (id: string) => {
    const l = LADDERS.find((x) => x.id === id)!;
    setQuery("");
    setChangedOnly(false);
    setOpenFamilies((prev) => new Set(prev).add(ladderFamily(l)));
    setReveal(`ladder:${id}`);
  };
  const revealChicken = () => {
    setQuery("");
    setChangedOnly(false);
    setOpenFamilies((prev) => new Set(prev).add("meta"));
    setReveal("chicken");
  };
  useEffect(() => {
    if (!reveal) return;
    document.querySelector(`[data-reveal="${reveal}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" });
    setReveal(null);
  }, [reveal]);

  const undo = (c: RuleChange) => {
    if (c.chicken && c.target.kind === "pattern") setRule(c.target.id, { blocksChicken: DEFAULT_TAI_RULES.patterns[c.target.id].blocksChicken });
    else if (c.target.kind === "pattern") resetRule(c.target.id);
    else if (c.target.kind === "ladder") setLadder(c.target.id, true);
  };

  // Filtering opens every family with a match, so results aren't hidden
  // behind a closed header. A ladder shows whole when any rung matches.
  const filtering = query.trim() !== "" || changedOnly;
  const q = query.trim().toLowerCase();
  const matchesOne = (id: string) =>
    (!changedOnly || isRowChanged(id, draft.patterns[id])) &&
    (q === "" || (NAME_BY_ID.get(id) ?? "").toLowerCase().includes(q) || id.includes(q) || aliasesOf(id).some((a) => a.includes(q)));
  // A 明/暗 pair shows (as one row) when either half matches.
  const matches = (id: string) => {
    const pair = pairOf(id);
    return pair ? matchesOne(pair.open) || matchesOne(pair.concealed) : matchesOne(id);
  };
  const groups = PATTERN_FAMILIES.map((f) => {
    const ladders = LADDERS.filter(
      (l) => ladderFamily(l) === f.id && (l.rungs.flat().some(matches) || (changedOnly && q === "" && isLadderChanged(draft, l.id))),
    );
    const chickenChanged = f.id === "meta" && changedOnly && q === "" && isChickenListChanged(draft);
    const singles = PATTERNS.map((p) => p.id).filter(
      (id) => PATTERN_CATALOG[id].family === f.id && !ON_LADDER.has(id) && (matches(id) || chickenChanged),
    );
    const ids = [...ladders.flatMap((l) => l.rungs.flat()), ...singles];
    return { ...f, ladders, singles, ids };
  }).filter((g) => g.ids.length > 0);

  const toggleFamily = (id: PatternFamily) =>
    setOpenFamilies((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const rowProps = (id: string) => ({
    id,
    rule: draft.patterns[id],
    draft,
    inCycle: cycles.has(id),
    expanded: expanded === id,
    onExpand: () => setExpanded((cur) => (cur === id ? null : id)),
    onChange: (patch: Partial<PatternRule>) => setRule(id, patch),
    onReset: () => resetRule(id),
  });

  // One row per pattern - a 明/暗 pair as one row, drawn at its 明 half.
  const renderRow = (id: string) => {
    const pair = pairOf(id);
    if (!pair) return <PatternRow key={id} {...rowProps(id)} />;
    if (id !== pair.open) return null;
    return (
      <PairRow
        key={pair.id}
        pair={pair}
        draft={draft}
        inCycle={cycles.has(pair.open) || cycles.has(pair.concealed)}
        expanded={expanded === pair.id}
        onExpand={() => setExpanded((cur) => (cur === pair.id ? null : pair.id))}
        onChange={setRule}
        onReset={resetRule}
      />
    );
  };

  const inUseName = activeSet(store)?.name ?? HOUSE_RULES_NAME;
  return (
    <>
      <Sheet
        title="設定 · 台數規則"
        subtitle={
          incoming
            ? "Shared with you · review, then use"
            : engine === "legacy"
              ? "In use: the original built-in engine"
              : selected === store.active
                ? `In use: ${inUseName}`
                : `In use: ${inUseName} · Save to switch`
        }
        onClose={close}
        actions={
          confirmClose ? (
            <>
              <button type="button" className="sc-secondary" onClick={() => setConfirmClose(false)}>
                Keep editing
              </button>
              <button type="button" className="sc-danger" onClick={onClose}>
                Discard changes
              </button>
            </>
          ) : (
            <>
              {/* Resets the whole set to the house list - so it asks first. */}
              <button
                type="button"
                className={confirmReset ? "sc-danger" : "sc-secondary"}
                disabled={changed === 0}
                onClick={() => {
                  if (!confirmReset) return setConfirmReset(true);
                  setDrafts((prev) => (selected === null ? prev : { ...prev, [selected]: structuredClone(DEFAULT_TAI_RULES) }));
                  setConfirmReset(false);
                }}
              >
                {confirmReset ? `Reset ${changed} change${changed === 1 ? "" : "s"}?` : "Reset all"}
              </button>
              <button type="button" className="sc-primary" onClick={() => onSave({ v: 1, active: selected, sets: finalSets() }, draftEngine)}>
                {selected === store.active && !incoming ? "Save" : "Save & use"}
              </button>
            </>
          )
        }
      >
        {confirmClose && <div className="tr-notice is-warning">These changes aren't saved yet. Keep editing to save them, or discard them.</div>}
        {corrupt && !incoming && <div className="tr-notice">Your saved rule sets couldn't be read, so these are the house rules.</div>}
        {legacy && (
          <div className="tr-notice is-warning">Scoring with the original built-in engine, so rule sets don't apply. Switch back under Advanced, at the bottom.</div>
        )}

        <div className={`tr-rules${legacy ? " is-off" : ""}`} inert={legacy || undefined}>
        <div className="sc-settings-group">
          <div className="sc-settings-title">Rule set</div>
          <div className="tr-sets">
            <select className="sc-input tr-set-select" value={selected ?? ""} onChange={(e) => pick(e.target.value || null)} aria-label="Rule set">
              <option value="">{HOUSE_RULES_NAME}</option>
              {sets.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name || "(no name)"}
                  {s.id === store.active ? " · in use" : ""}
                </option>
              ))}
            </select>
            {selectedSet && (
              <input
                className="sc-input tr-set-name"
                value={selectedSet.name}
                onChange={(e) => rename(e.target.value)}
                onBlur={() => !selectedSet.name.trim() && rename(uniqueName(sets, "My rules", selectedSet.id))}
                placeholder="Name this rule set"
                aria-label="Rule set name"
                maxLength={60}
              />
            )}
            <div className="tr-set-actions">
              <button type="button" className="tr-chip" onClick={() => addSet("My rules", structuredClone(DEFAULT_TAI_RULES))}>
                New
              </button>
              <button type="button" className="tr-chip" onClick={() => addSet(`${name} copy`.replace(`${HOUSE_RULES_NAME} copy`, "My rules"), structuredClone(draft))}>
                Duplicate
              </button>
              {selectedSet &&
                (confirmDelete ? (
                  <button type="button" className="tr-chip is-danger" onClick={remove}>
                    Delete "{name}"?
                  </button>
                ) : (
                  <button type="button" className="tr-chip" onClick={() => setConfirmDelete(true)}>
                    Delete
                  </button>
                ))}
              <button type="button" className="tr-chip" onClick={() => setSharing(true)}>
                Share &amp; files…
              </button>
              <input
                ref={importRef}
                type="file"
                accept=".json,application/json"
                hidden
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (file) void importFile(file);
                }}
              />
            </div>
          </div>
          {notice && <div className={`tr-notice${notice.bad ? " is-warning" : ""}`}>{notice.text}</div>}
        </div>

        {/* Only with a hand to score - an empty box is just in the way. */}
        {savedTotal !== null && draftTotal !== null && (
        <div className={`tr-preview${savedTotal !== draftTotal ? " is-changed" : ""}`} aria-live="polite">
          <span className="tr-preview-label">This hand</span>
              <span className="tr-preview-totals">
                {savedTotal !== draftTotal && (
                  <>
                    <span className="tr-preview-was">{savedTotal}</span>
                    <span aria-hidden="true">→</span>
                  </>
                )}
                <strong>{draftTotal}</strong> tai
              </span>
        </div>
        )}

        {(changes.length > 0 || selectedSet) && (
        <div className="sc-settings-group">
          <div className="tr-changes-head">
            <span className="sc-settings-title">{changes.length > 0 ? "Changes from the house rules" : "No changes from the house rules yet"}</span>
            {changes.length > 0 && (
              <button type="button" className="tr-link" onClick={() => setSharing(true)}>
                Share
              </button>
            )}
          </div>
          {changes.length > 0 && (
            <div className="sc-list tr-changes">
              {changes.map((c, i) => (
                <div key={i} className="tr-change">
                  <button
                    type="button"
                    className="tr-change-text"
                    onClick={() =>
                      c.chicken ? revealChicken() : c.target.kind === "pattern" ? revealPattern(c.target.id) : c.target.kind === "ladder" ? revealLadder(c.target.id) : undefined
                    }
                  >
                    {c.text}
                  </button>
                  <button type="button" className="tr-link" onClick={() => undo(c)} aria-label={`Undo: ${c.text}`}>
                    Undo
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
        )}

        <div className="tr-body">
          <div className="tr-filter">
            <input className="sc-input tr-search" type="search" placeholder="Search 清一色, flush, 一般高…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search patterns" />
            <button type="button" className={`tr-chip${changedOnly ? " is-on" : ""}`} aria-pressed={changedOnly} onClick={() => setChangedOnly((v) => !v)}>
              Changed
            </button>
          </div>

          {cycles.size > 0 && (
            <div className="tr-notice is-warning">
              Some patterns replace each other in a loop, so when they all fire, none of them count: {[...cycles.keys()].map(shortName).join(", ")}.
            </div>
          )}

          {groups.length === 0 && <div className="tr-empty">No patterns match.</div>}

          {groups.map((g) => {
            const open = filtering || openFamilies.has(g.id);
            const familyChanged =
              g.ids.filter((id) => isRowChanged(id, draft.patterns[id])).length +
              g.ladders.filter((l) => isLadderChanged(draft, l.id)).length +
              (g.id === "meta" && isChickenListChanged(draft) ? 1 : 0);
            return (
              <div key={g.id} className="sc-settings-group">
                <button type="button" className="tr-family" aria-expanded={open} onClick={() => toggleFamily(g.id)} disabled={filtering}>
                  <span className="tr-family-chevron" aria-hidden="true">
                    {open ? "▾" : "▸"}
                  </span>
                  <span className="tr-family-label">{g.label}</span>
                  <span className="tr-family-count">
                    {familyChanged > 0 && <span className="tr-dot" aria-label={`${familyChanged} changed`} />}
                    {new Set(g.ids.map(rowKey)).size}
                  </span>
                </button>
                {open && (
                  <>
                    {g.id === "meta" && (
                      <ChickenIgnoreBlock
                        ignored={chickenIgnores(draft)}
                        onChange={(byId) => setRules(Object.fromEntries(Object.entries(byId).map(([id, ignored]) => [id, { blocksChicken: !ignored }])))}
                      />
                    )}
                    {g.ladders.map((l) => (
                      <LadderBlock key={l.id} ladder={l} exclusive={draft.ladders[l.id]?.exclusive !== false} onExclusive={(v) => setLadder(l.id, v)}>
                        {[...l.rungs].reverse().map((rung, i) => (
                          <div key={i} className="tr-rung">
                            {rung.map(renderRow)}
                          </div>
                        ))}
                      </LadderBlock>
                    ))}
                    {g.singles.length > 0 && (
                      <div className="sc-list">
                        {g.singles.map(renderRow)}
                      </div>
                    )}
                  </>
                )}
              </div>
            );
          })}
        </div>
        </div>

        <div className="sc-settings-group tr-advanced">
          <button type="button" className="tr-family" aria-expanded={advanced} onClick={() => setAdvanced((v) => !v)}>
            <span className="tr-family-chevron" aria-hidden="true">
              {advanced ? "▾" : "▸"}
            </span>
            <span className="tr-family-label">Advanced</span>
            <span className="tr-family-count">{legacy && <span className="tr-dot" aria-label="original engine in use" />}</span>
          </button>
          {advanced && (
            <div className="tr-engine">
              <span className="sc-row-main sc-row-stack">
                Scoring engine
                <span className="sc-help">
                  {legacy
                    ? "The engine as it was before rules were editable - the house rules only. Your rule sets are kept for switching back."
                    : "Rule sets score as set above. The original engine is a fallback: it also takes over by itself if this one ever fails."}
                </span>
              </span>
              <Segmented
                value={draftEngine}
                onChange={setDraftEngine}
                options={[
                  { value: "custom", label: "Rule sets" },
                  { value: "legacy", label: "Original built-in" },
                ]}
              />
            </div>
          )}
        </div>
      </Sheet>
      {printing && <RulesReference name={name} rules={{ ...draft, engine: draftEngine }} onClose={() => setPrinting(false)} />}
      {sharing && (
        <ShareRulesSheet
          name={selectedSet ? name : null}
          rules={draft}
          count={changed}
          onClose={() => setSharing(false)}
          files={{
            exportSet: selectedSet ? exportSelected : null,
            exportAll: sets.length > 1 ? exportAll : null,
            importFile: () => importRef.current?.click(),
            print: () => {
              setSharing(false);
              setPrinting(true);
            },
          }}
        />
      )}
    </>
  );
}

// A ladder: its rungs top-down, highest first, with one switch for whether
// only the highest rung that fires counts (the house list) or every rung
// stacks.
function LadderBlock({ ladder, exclusive, onExclusive, children }: { ladder: Ladder; exclusive: boolean; onExclusive: (v: boolean) => void; children: React.ReactNode }) {
  // A windows family (連刻) has no stacking switch: giving its longer tiers a
  // value is the switch - see Ladder in taiCatalog.ts.
  const windows = ladder.kind === "windows";
  const changed = !windows && !exclusive;
  const help = windows
    ? "The longest that has a value counts. A longer one worth 0 counts as overlapping shorter ones."
    : exclusive
      ? "Only the highest that applies counts"
      : "Every tier that applies counts";
  const head = (
    <>
      <span className="sc-row-main sc-row-stack">
        <span className="tr-ladder-title">
          {ladder.label}
          {changed && <span className="tr-dot" aria-label="changed" />}
        </span>
        <span className="sc-help">{help}</span>
      </span>
      {!windows && <Toggle checked={exclusive} onChange={onExclusive} label={`${ladder.label}: only the highest counts`} />}
    </>
  );
  return (
    <div className={`tr-ladder${exclusive || windows ? "" : " is-stacking"}${windows ? " is-windows" : ""}`} data-reveal={`ladder:${ladder.id}`}>
      {windows ? <div className="tr-ladder-head">{head}</div> : <label className="tr-ladder-head">{head}</label>}
      <div className="tr-ladder-rungs">{children}</div>
    </div>
  );
}

function PatternRow({
  id,
  rule,
  draft,
  inCycle,
  expanded,
  onExpand,
  onChange,
  onReset,
}: {
  id: string;
  rule: PatternRule;
  draft: TaiRules;
  inCycle: boolean;
  expanded: boolean;
  onExpand: () => void;
  onChange: (patch: Partial<PatternRule>) => void;
  onReset: () => void;
}) {
  const [zh, en] = splitName(id);
  const value = PATTERN_CATALOG[id].value;
  const changed = isRowChanged(id, rule);
  const flatOrPer = value.kind === "flat" || value.kind === "per";
  return (
    <div className={`tr-pattern${isRuleOn(rule) ? "" : " is-disabled"}${expanded ? " is-expanded" : ""}`} data-reveal={id}>
      <div className="sc-row">
        <button type="button" className="tr-pattern-name" aria-expanded={expanded} onClick={onExpand}>
          <span className="tr-pattern-zh">
            {zh}
            {changed && <span className="tr-dot" aria-label="changed" />}
            {inCycle && (
              <span className="tr-warn" title="Part of a replace loop" aria-label="replace loop">
                !
              </span>
            )}
          </span>
          {(en || aliasesOf(id).length > 0) && <span className="sc-help">{subName(en, id)}</span>}
        </button>
        <span className="tr-pattern-end">
          {flatOrPer ? (
            <span className="tr-value">
              <NumberField value={rule.tai} onChange={(tai) => onChange({ tai, enabled: true })} label={`${zh} tai (0 = off)`} pill />
              <span className="tr-unit">{rule.tai === 0 ? "off" : value.kind === "per" ? "each" : ""}</span>
            </span>
          ) : (
            <span className="tr-value">
              <button type="button" className="tr-value-summary" onClick={onExpand} aria-label={`${zh}: ${valueSummary(id, rule)} - edit`}>
                {valueSummary(id, rule)}
                <span className="tr-value-more" aria-hidden="true">
                  ›
                </span>
              </button>
              <span className="tr-unit" />
            </span>
          )}
        </span>
      </div>
      {expanded && <PatternDetails id={id} rule={rule} draft={draft} changed={changed} onChange={onChange} onReset={onReset} />}
    </div>
  );
}

// A 明/暗 pair as one row: its shared name, a value for each side, and one
// switch for both. Expanded, each side's example and rules in turn.
function PairRow({
  pair,
  draft,
  inCycle,
  expanded,
  onExpand,
  onChange,
  onReset,
}: {
  pair: OpenConcealedPair;
  draft: TaiRules;
  inCycle: boolean;
  expanded: boolean;
  onExpand: () => void;
  onChange: (id: string, patch: Partial<PatternRule>) => void;
  onReset: (id: string) => void;
}) {
  const [zh, en] = pairName(pair);
  const open = draft.patterns[pair.open];
  const concealed = draft.patterns[pair.concealed];
  const enabled = isRuleOn(open) || isRuleOn(concealed);
  const changed = isRowChanged(pair.open, open) || isRowChanged(pair.concealed, concealed);
  const per = PATTERN_CATALOG[pair.open].value.kind === "per";
  const sides = [
    { id: pair.open, rule: open, label: "明", long: "明 · open (any meld called, or completed by a claimed tile)" },
    { id: pair.concealed, rule: concealed, label: "暗", long: "暗 · concealed (every meld self-formed)" },
  ];
  return (
    <div className={`tr-pattern tr-pair${enabled ? "" : " is-disabled"}${expanded ? " is-expanded" : ""}`} data-reveal={pair.id}>
      <div className="sc-row">
        <button type="button" className="tr-pattern-name" aria-expanded={expanded} onClick={onExpand}>
          <span className="tr-pattern-zh">
            {zh}
            {changed && <span className="tr-dot" aria-label="changed" />}
            {inCycle && (
              <span className="tr-warn" title="Part of a replace loop" aria-label="replace loop">
                !
              </span>
            )}
          </span>
          {(en || aliasesOf(pair.open).length > 0) && <span className="sc-help">{subName(en, pair.open)}</span>}
        </button>
        <span className="tr-pattern-end">
          <span className="tr-pair-values">
            {sides.map((side) => (
              <span key={side.id} className="tr-value tr-pair-value">
                <span className="tr-pair-side">{side.label}</span>
                <NumberField
                  value={side.rule.tai}
                  onChange={(tai) => onChange(side.id, { tai, enabled: true })}
                  label={`${zh} ${side.label} tai (0 = off)`}
                  pill
                />
              </span>
            ))}
            <span className="tr-unit">{!enabled ? "off" : per ? "each" : ""}</span>
          </span>

        </span>
      </div>
      {expanded && (
        <div className="tr-pair-details">
          {sides.map((side) => (
            <div key={side.id} className="tr-pair-section">
              <div className="tr-pair-heading">{side.long}</div>
              <PatternDetails
                id={side.id}
                rule={side.rule}
                draft={draft}
                changed={isRowChanged(side.id, side.rule)}
                onChange={(patch) => onChange(side.id, patch)}
                onReset={() => onReset(side.id)}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function PatternDetails({
  id,
  rule,
  draft,
  changed,
  onChange,
  onReset,
}: {
  id: string;
  rule: PatternRule;
  draft: TaiRules;
  changed: boolean;
  onChange: (patch: Partial<PatternRule>) => void;
  onReset: () => void;
}) {
  const value = PATTERN_CATALOG[id].value;
  const family = PATTERN_CATALOG[id].family;
  const shapes = eligibleShapes(id);
  const by = replacedBy(draft, id);
  // What its ladder replaces for it: shown, but changed with the ladder's switch.
  const viaLadder = effectiveReplaces(draft, id).filter((r) => !rule.replaces.includes(r));
  const taken = new Set([id, ...rule.replaces, ...viaLadder]);
  // The add-a-replace picker: this family first, then the rest.
  const candidates = PATTERNS.map((p) => p.id).filter((other) => !taken.has(other));
  // Likely partners first - patterns that can count on the same hand - so the
  // useful choices aren't lost among all 160.
  const likely = likelyPartners(id);
  const sameFamily = candidates.filter((other) => likely.has(other) || PATTERN_CATALOG[other].family === family);
  const otherFamilies = candidates.filter((other) => !sameFamily.includes(other));
  const linkRows = situationLinkRows(id, shortName);

  return (
    <div className="tr-details">
      <PatternExampleView id={id} rules={draft} />
      {value.kind === "table" && (
        <div className="tr-detail">
          <div className="tr-detail-label">Tai by count</div>
          <div className="tr-table">
            {(rule.table ?? []).slice(1).map((v, i) => (
              <label key={i} className="tr-table-cell">
                <span>×{i + 1}</span>
                <NumberField value={v} onChange={(n) => onChange({ table: (rule.table ?? []).map((old, j) => (j === i + 1 ? n : old)) })} label={`Tai at ${i + 1}`} pill />
              </label>
            ))}
          </div>
        </div>
      )}
      {value.kind === "streak" && (
        <div className="tr-detail tr-streak">
          <label className="tr-table-cell">
            <span>莊</span>
            <NumberField value={rule.first ?? value.first} onChange={(first) => onChange({ first })} label="Tai as dealer" pill />
          </label>
          <label className="tr-table-cell">
            <span>+ each 連莊</span>
            <NumberField value={rule.tai} onChange={(tai) => onChange({ tai })} label="Tai per 連莊" pill />
          </label>
        </div>
      )}

      <div className="tr-detail">
        <div className="tr-detail-label">Replaces · when both apply, these don't count</div>
        <div className="tr-chips">
          {viaLadder.length === 0 && rule.replaces.length === 0 && <span className="tr-none">Nothing - stacks with everything</span>}
          {viaLadder.map((other) => (
            <span key={other} className="tr-chip is-static is-ladder">
              {shortName(other)}
              <span className="tr-chip-tag">tier</span>
            </span>
          ))}
          {rule.replaces.map((other) => (
            <span key={other} className="tr-chip is-static">
              {shortName(other)}
              <button type="button" aria-label={`Stop replacing ${shortName(other)}`} onClick={() => onChange({ replaces: rule.replaces.filter((r) => r !== other) })}>
                ×
              </button>
            </span>
          ))}
          <select className="tr-add" value="" aria-label="Add a pattern this replaces" onChange={(e) => e.target.value && onChange({ replaces: [...rule.replaces, e.target.value] })}>
            <option value="">+ Add</option>
            {sameFamily.length > 0 && (
              <optgroup label="Likely to count together">
                {sameFamily.map((other) => (
                  <option key={other} value={other}>
                    {NAME_BY_ID.get(other)}
                  </option>
                ))}
              </optgroup>
            )}
            <optgroup label="All other patterns">
              {otherFamilies.map((other) => (
                <option key={other} value={other}>
                  {NAME_BY_ID.get(other)}
                </option>
              ))}
            </optgroup>
          </select>
        </div>
        {viaLadder.length > 0 && <div className="tr-chips-note">"tier": a lower tier of its family - it follows the family's "only the highest counts" switch, not this list.</div>}
      </div>

      <div className="tr-detail">
        <div className="tr-detail-label">Replaced by</div>
        <div className="tr-chips">
          {by.length === 0 ? (
            <span className="tr-none">Nothing</span>
          ) : (
            by.map((other) => (
              <span key={other} className="tr-chip is-static">
                {shortName(other)}
              </span>
            ))
          )}
        </div>
      </div>

      {linkRows.length > 0 && (
        <div className="tr-detail">
          <div className="tr-detail-label">情況 button · how it links (the app's, not part of the set)</div>
          <dl className="tr-links">
            {linkRows.map((row) => (
              <Fragment key={row.label}>
                <dt>{row.label}</dt>
                <dd>{row.text}</dd>
              </Fragment>
            ))}
          </dl>
        </div>
      )}

      {shapes.length > 1 && (
      <div className="tr-detail">
        <div className="tr-detail-label">Counts on</div>
        <div className="tr-chips">
          {shapes.map((shape) => {
            const on = rule.shapes.includes(shape);
            return (
              <button
                key={shape}
                type="button"
                className={`tr-chip${on ? " is-on" : ""}`}
                aria-pressed={on}
                onClick={() => onChange({ shapes: on ? rule.shapes.filter((s) => s !== shape) : shapes.filter((s) => s === shape || rule.shapes.includes(s)) })}
              >
                {SHAPE_LABEL.get(shape)}
              </button>
            );
          })}
        </div>
      </div>
      )}

      {changed && (
        <button type="button" className="sc-secondary tr-reset" onClick={onReset}>
          Reset {shortName(id)} to the house rule
        </button>
      )}
    </div>
  );
}

// A link (and its QR code) that opens a rule set on another phone, for
// everyone at the table to score the same way. The receiver reviews it in
// this sheet, as a new set, before using it. The link is compressed (see
// rulesLink) so even a heavily changed set fits a QR code; if one ever
// doesn't, the link is still there to copy or share.
// Everything that takes a set elsewhere, in one place: a link and its QR code
// for another phone, files to keep or move (one set, or all), importing one,
// and the printable reference.
function ShareRulesSheet({
  name,
  rules,
  count,
  onClose,
  files,
}: {
  name: string | null;
  rules: TaiRules;
  count: number;
  onClose: () => void;
  files: { exportSet: (() => void) | null; exportAll: (() => void) | null; importFile: () => void; print: () => void };
}) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void rulesLink(name, rules).then((link) => live && setUrl(link));
    return () => {
      live = false;
    };
  }, [name, rules]);
  const svg = useMemo(() => {
    if (!url) return null;
    try {
      const qr = qrcode(0, "L");
      qr.addData(url);
      qr.make();
      return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
    } catch {
      return null; // Too long for a QR code.
    }
  }, [url]);
  const [copied, setCopied] = useState(false);
  return (
    <Sheet
      title={name ? `Share & files · ${name}` : "Share & files"}
      subtitle={`${count} change${count === 1 ? "" : "s"} from the house rules`}
      onClose={onClose}
      actions={
        <>
          <button
            type="button"
            className="sc-secondary"
            disabled={!url}
            onClick={async () => {
              if (!url) return;
              try {
                await navigator.clipboard.writeText(url);
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1500);
              } catch {
                window.prompt("Copy the link", url);
              }
            }}
          >
            {copied ? "Copied ✓" : "Copy link"}
          </button>
          {"share" in navigator && (
            <button
              type="button"
              className="sc-primary"
              disabled={!url}
              onClick={async () => {
                if (!url) return;
                try {
                  await navigator.share({ title: name ? `MJWaits rules: ${name}` : "MJWaits tai rules", url });
                } catch {
                  // Dismissed.
                }
              }}
            >
              Share link…
            </button>
          )}
        </>
      }
    >
      {svg ? (
        <div className="sc-qr" dangerouslySetInnerHTML={{ __html: svg }} role="img" aria-label="QR code for the rules link" />
      ) : (
        url && <div className="tr-notice is-warning">Too many changes for a QR code - copy or share the link instead.</div>
      )}
      <p className="sc-help sc-help-block">Scan or open on another phone: the rules arrive in its 設定 as a new set, ready to review and use. Unsaved edits are included.</p>
      <div className="sc-settings-group">
        <div className="sc-settings-title">Files</div>
        <div className="sc-list tr-files">
          {files.exportSet && (
            <button type="button" className="tr-file-row" onClick={files.exportSet}>
              <span>Export this set</span>
              <span className="sc-help">a .json file to keep or send</span>
            </button>
          )}
          {files.exportAll && (
            <button type="button" className="tr-file-row" onClick={files.exportAll}>
              <span>Export all sets</span>
              <span className="sc-help">every saved set in one file</span>
            </button>
          )}
          <button type="button" className="tr-file-row" onClick={files.importFile}>
            <span>Import…</span>
            <span className="sc-help">add sets from a file</span>
          </button>
          <button type="button" className="tr-file-row" onClick={files.print}>
            <span>Print reference (PDF)</span>
            <span className="sc-help">every pattern, its value and an example</span>
          </button>
        </div>
      </div>
    </Sheet>
  );
}

// 大雞/大鴨's setting: what they ignore - patterns that can count and still
// leave 大雞/大鴨 standing. Two plain switches (situations, flowers), and the
// full list under "Fine-tune" for anything more particular.
// onChange takes every change at once ({ id: ignored }) - one edit, so editing
// the house list starts one new set.
function ChickenIgnoreBlock({ ignored, onChange }: { ignored: string[]; onChange: (byId: Record<string, boolean>) => void }) {
  const [fineTune, setFineTune] = useState(false);
  const houseIgnored = new Set(PATTERNS.filter((p) => !CHICKEN_PATTERN_IDS.has(p.id) && !DEFAULT_TAI_RULES.patterns[p.id].blocksChicken).map((p) => p.id));
  const changed = ignored.length !== houseIgnored.size || ignored.some((id) => !houseIgnored.has(id));
  const addable = PATTERNS.map((p) => p.id).filter((id) => !CHICKEN_PATTERN_IDS.has(id) && !ignored.includes(id));
  const set = (ids: string[], value: boolean) => onChange(Object.fromEntries(ids.map((id) => [id, value])));
  const reset = () =>
    onChange(Object.fromEntries(PATTERNS.map((p) => p.id).filter((id) => !CHICKEN_PATTERN_IDS.has(id)).map((id) => [id, houseIgnored.has(id)])));
  return (
    <div className="tr-chicken" data-reveal="chicken">
      <div className="tr-chicken-head">
        <span className="sc-row-main sc-row-stack">
          <span className="tr-ladder-title">
            大雞/大鴨
            {changed && <span className="tr-dot" aria-label="changed" />}
          </span>
          <span className="sc-help">They count only when nothing else does. 底 never stops them.</span>
        </span>
      </div>
      {CHICKEN_GROUPS.map((group) => {
        const all = group.ids.every((id) => ignored.includes(id));
        const some = !all && group.ids.some((id) => ignored.includes(id));
        return (
          <label key={group.id} className="sc-row tr-chicken-group">
            <span className="sc-row-main sc-row-stack">
              <span>
                {group.label}
                {some && <span className="tr-mixed"> · partly (see Fine-tune)</span>}
              </span>
              <span className="sc-help">{group.help}</span>
            </span>
            <Toggle checked={all} onChange={(on) => set(group.ids, on)} label={group.label} />
          </label>
        );
      })}
      <div className="tr-chicken-foot">
        <button type="button" className="tr-link" aria-expanded={fineTune} onClick={() => setFineTune((v) => !v)}>
          {fineTune ? "Hide fine-tune" : "Fine-tune…"}
        </button>
        {changed && (
          <button type="button" className="tr-link" onClick={reset}>
            Reset
          </button>
        )}
      </div>
      {fineTune && (
        <div className="tr-chips">
          {ignored.map((id) => (
            <span key={id} className="tr-chip is-static">
              {shortName(id)}
              <button type="button" aria-label={`Let ${shortName(id)} stop 大雞/大鴨`} onClick={() => set([id], false)}>
                ×
              </button>
            </span>
          ))}
          <select className="tr-add" value="" aria-label="Add a pattern 大雞/大鴨 ignore" onChange={(e) => e.target.value && set([e.target.value], true)}>
            <option value="">+ Add</option>
            {addable.map((id) => (
              <option key={id} value={id}>
                {NAME_BY_ID.get(id)}
              </option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}
