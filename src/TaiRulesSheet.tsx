// The Scoring tab's 設定 sheet: every pattern's tai, its ladder, what else it
// replaces, which hand shapes it counts on and whether it blocks 大雞/大鴨 -
// the house's tai rules as data (TaiRules in lib/scoring.ts, the
// classification in lib/taiCatalog.ts). Edits a draft, previewed live on the
// hand in the tab; nothing applies until Save.

import qrcode from "qrcode-generator";
import { useEffect, useMemo, useRef, useState } from "react";
import { PatternExampleView } from "./PatternExample";
import { RulesReference } from "./RulesReference";
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
import { LADDERS, PATTERN_CATALOG, PATTERN_FAMILIES, type Ladder, type PatternFamily } from "./lib/taiCatalog";
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
  changedCount,
  chickenIgnores,
  describeChanges,
  isChickenListChanged,
  isRowChanged,
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

function valueSummary(id: string, rule: PatternRule): string {
  const value = PATTERN_CATALOG[id].value;
  if (value.kind === "table") return (rule.table ?? []).slice(1).join("/");
  if (value.kind === "streak") return `${rule.first ?? value.first} +${rule.tai}`;
  return String(rule.tai);
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
  const [printing, setPrinting] = useState(false);
  const importRef = useRef<HTMLInputElement>(null);

  const selectedSet = sets.find((s) => s.id === selected);
  const draft = useMemo<TaiRules>(
    () => (selected === null ? DEFAULT_TAI_RULES : (drafts[selected] ?? rulesOfSet(selectedSet))),
    [selected, drafts, selectedSet],
  );
  const name = selectedSet?.name ?? HOUSE_RULES_NAME;

  // Editing the house list starts a new set from it ("My rules"), selected.
  const edit = (update: (prev: TaiRules) => TaiRules) => {
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
  const setRule = (id: string, patch: Partial<PatternRule>) =>
    edit((prev) => ({ ...prev, patterns: { ...prev.patterns, [id]: { ...prev.patterns[id], ...patch } } }));
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
    setExpanded(id);
    setReveal(id);
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
  const matches = (id: string) =>
    (!changedOnly || isRowChanged(id, draft.patterns[id])) && (q === "" || (NAME_BY_ID.get(id) ?? "").toLowerCase().includes(q) || id.includes(q));
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
        onClose={onClose}
        actions={
          <>
            <button type="button" className="sc-secondary" onClick={() => setDrafts((prev) => (selected === null ? prev : { ...prev, [selected]: structuredClone(DEFAULT_TAI_RULES) }))} disabled={changed === 0}>
              Reset
            </button>
            <button type="button" className="sc-primary" onClick={() => onSave({ v: 1, active: selected, sets: finalSets() }, draftEngine)}>
              {selected === store.active && !incoming ? "Save" : "Save & use"}
            </button>
          </>
        }
      >
        {corrupt && !incoming && <div className="tr-notice">Your saved rule sets couldn't be read, so these are the house rules.</div>}
        <div className="sc-settings-group">
          <div className="sc-settings-title">Scoring engine</div>
          <div className="tr-engine">
            <Segmented
              value={draftEngine}
              onChange={setDraftEngine}
              options={[
                { value: "custom", label: "Rule sets" },
                { value: "legacy", label: "Original built-in" },
              ]}
            />
            <span className="sc-help">
              {legacy
                ? "Scores with the engine as it was before rules were editable - the house rules only. Your rule sets are kept for switching back."
                : "Scores with the rule set below. The original engine is a fallback: it also takes over by itself if this one ever fails."}
            </span>
          </div>
        </div>

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
              {selectedSet && (
                <button type="button" className="tr-chip" onClick={exportSelected}>
                  Export
                </button>
              )}
              {sets.length > 1 && (
                <button type="button" className="tr-chip" onClick={exportAll}>
                  Export all
                </button>
              )}
              <button type="button" className="tr-chip" onClick={() => importRef.current?.click()}>
                Import
              </button>
              <button type="button" className="tr-chip" onClick={() => setPrinting(true)}>
                Export PDF
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

        <div className={`tr-preview${savedTotal !== null && draftTotal !== null && savedTotal !== draftTotal ? " is-changed" : ""}`} aria-live="polite">
          {savedTotal === null || draftTotal === null ? (
            <span className="tr-preview-empty">Enter a complete hand to see its total under this set.</span>
          ) : (
            <>
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
            </>
          )}
        </div>

        <div className="sc-settings-group">
          <div className="tr-changes-head">
            <span className="sc-settings-title">{changes.length > 0 ? "Changes from the house rules" : "Same as the house rules"}</span>
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

        <div className="tr-body">
          <div className="tr-filter">
            <input className="sc-input tr-search" type="search" placeholder="Search 清一色, flush…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search patterns" />
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
                    {g.ids.length}
                  </span>
                </button>
                {open && (
                  <>
                    {g.id === "meta" && (
                      <ChickenIgnoreBlock
                        ignored={chickenIgnores(draft)}
                        onChange={(id, ignored) => setRule(id, { blocksChicken: !ignored })}
                      />
                    )}
                    {g.ladders.map((l) => (
                      <LadderBlock key={l.id} ladder={l} exclusive={draft.ladders[l.id]?.exclusive !== false} onExclusive={(v) => setLadder(l.id, v)}>
                        {[...l.rungs].reverse().map((rung, i) => (
                          <div key={i} className="tr-rung">
                            {rung.map((id) => (
                              <PatternRow key={id} {...rowProps(id)} />
                            ))}
                          </div>
                        ))}
                      </LadderBlock>
                    ))}
                    {g.singles.length > 0 && (
                      <div className="sc-list">
                        {g.singles.map((id) => (
                          <PatternRow key={id} {...rowProps(id)} />
                        ))}
                      </div>
                    )}
                  </>
                )}
              </div>
            );
          })}
        </div>
        </div>
      </Sheet>
      {printing && <RulesReference name={name} rules={{ ...draft, engine: draftEngine }} onClose={() => setPrinting(false)} />}
      {sharing && <ShareRulesSheet name={selectedSet ? name : null} rules={draft} count={changed} onClose={() => setSharing(false)} />}
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
    <div className={`tr-pattern${rule.enabled ? "" : " is-disabled"}${expanded ? " is-expanded" : ""}`} data-reveal={id}>
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
          {en && <span className="sc-help">{en}</span>}
        </button>
        <span className="tr-pattern-end">
          {flatOrPer ? (
            <span className="tr-value">
              <NumberField value={rule.tai} onChange={(tai) => onChange({ tai })} label={`${zh} tai`} pill disabled={!rule.enabled} />
              {value.kind === "per" && <span className="tr-unit">each</span>}
            </span>
          ) : (
            <button type="button" className="tr-value-summary" onClick={onExpand} disabled={!rule.enabled}>
              {valueSummary(id, rule)}
            </button>
          )}
          <Toggle checked={rule.enabled} onChange={(enabled) => onChange({ enabled })} label={`Count ${zh}`} />
        </span>
      </div>
      {expanded && <PatternDetails id={id} rule={rule} draft={draft} changed={changed} onChange={onChange} onReset={onReset} />}
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
  const sameFamily = candidates.filter((other) => PATTERN_CATALOG[other].family === family);
  const otherFamilies = candidates.filter((other) => PATTERN_CATALOG[other].family !== family);

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
            <span key={other} className="tr-chip is-static is-ladder" title="Lower on its ladder - change with the ladder's switch">
              {shortName(other)}
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
              <optgroup label="Same family">
                {sameFamily.map((other) => (
                  <option key={other} value={other}>
                    {NAME_BY_ID.get(other)}
                  </option>
                ))}
              </optgroup>
            )}
            <optgroup label="Other families">
              {otherFamilies.map((other) => (
                <option key={other} value={other}>
                  {NAME_BY_ID.get(other)}
                </option>
              ))}
            </optgroup>
          </select>
        </div>
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
function ShareRulesSheet({ name, rules, count, onClose }: { name: string | null; rules: TaiRules; count: number; onClose: () => void }) {
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
      title={name ? `Share "${name}"` : "Share these rules"}
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
    </Sheet>
  );
}

// 大雞/大鴨's one setting: which patterns they ignore - patterns that can
// count and still leave 大雞/大鴨 standing (house list: 底, the bonus tiles,
// and declared state that says nothing about the hand's shape, like 莊 and
// 叮). Everything else that counts stops them.
function ChickenIgnoreBlock({ ignored, onChange }: { ignored: string[]; onChange: (id: string, ignored: boolean) => void }) {
  const houseIgnored = new Set(PATTERNS.filter((p) => !CHICKEN_PATTERN_IDS.has(p.id) && !DEFAULT_TAI_RULES.patterns[p.id].blocksChicken).map((p) => p.id));
  const changed = ignored.length !== houseIgnored.size || ignored.some((id) => !houseIgnored.has(id));
  const addable = PATTERNS.map((p) => p.id).filter((id) => !CHICKEN_PATTERN_IDS.has(id) && !ignored.includes(id));
  return (
    <div className="tr-chicken" data-reveal="chicken">
      <div className="tr-chicken-head">
        <span className="sc-row-main sc-row-stack">
          <span className="tr-ladder-title">
            What 大雞/大鴨 ignore
            {changed && <span className="tr-dot" aria-label="changed" />}
          </span>
          <span className="sc-help">大雞/大鴨 count only when nothing else does - these can count alongside them.</span>
        </span>
      </div>
      <div className="tr-chips">
        {ignored.map((id) => (
          <span key={id} className="tr-chip is-static">
            {shortName(id)}
            <button type="button" aria-label={`Stop ignoring ${shortName(id)}`} onClick={() => onChange(id, false)}>
              ×
            </button>
          </span>
        ))}
        <select className="tr-add" value="" aria-label="Add a pattern 大雞/大鴨 ignore" onChange={(e) => e.target.value && onChange(e.target.value, true)}>
          <option value="">+ Add</option>
          {addable.map((id) => (
            <option key={id} value={id}>
              {NAME_BY_ID.get(id)}
            </option>
          ))}
        </select>
        {changed && (
          <button
            type="button"
            className="tr-link"
            onClick={() => {
              for (const id of PATTERNS.map((p) => p.id)) if (!CHICKEN_PATTERN_IDS.has(id) && ignored.includes(id) !== houseIgnored.has(id)) onChange(id, houseIgnored.has(id));
            }}
          >
            Reset
          </button>
        )}
      </div>
    </div>
  );
}
