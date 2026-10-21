// The Scoring tab's 設定 sheet: every pattern's tai, its ladder, what else it
// replaces, which hand shapes it counts on and whether it blocks 大雞/大鴨 -
// the house's tai rules as data (TaiRules in lib/scoring.ts, the
// classification in lib/taiCatalog.ts). Edits a draft, previewed live on the
// hand in the tab; nothing applies until Save.

import qrcode from "qrcode-generator";
import { useEffect, useMemo, useRef, useState } from "react";
import { NumberField, Sheet, Toggle } from "./ScoresPanel";
import { BonusGlyphSpan, TileGlyphSpan } from "./TileGlyphs";
import type { Tile } from "./lib/mahjong";
import { PATTERN_EXAMPLES } from "./lib/patternExamples";
import { TEST_HAND_BASE_CONTEXT } from "./lib/testHands";
import {
  CHICKEN_PATTERN_IDS,
  DEFAULT_TAI_RULES,
  effectiveReplaces,
  eligibleShapes,
  HAND_SHAPES,
  parseScoringHand,
  PATTERNS,
  scoreParsedHand,
  type GameContext,
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
  describeChanges,
  isLadderChanged,
  isRuleChanged,
  ladderOf,
  replaceCycles,
  replacedBy,
  ruleChanges,
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
  /** The developer sheet's engine switch: "legacy" ignores every set. */
  engine: TaiRules["engine"];
  /** Rules from a shared link: they open as a new set, to review. */
  incoming: { name: string | null; rules: TaiRules } | null;
  /** The saved sets couldn't be read and were reset. */
  corrupt: boolean;
  /** The tab's current hand scored under some rules - null if it can't be. */
  previewTotal: (rules: TaiRules) => number | null;
  /** Every set (renamed, added, deleted, edited) with the selected one in use. */
  onSave: (store: RuleSetStore) => void;
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
  const legacy = engine === "legacy";

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
  useEffect(() => {
    if (!reveal) return;
    document.querySelector(`[data-reveal="${reveal}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" });
    setReveal(null);
  }, [reveal]);

  const undo = (c: RuleChange) => {
    if (c.target.kind === "pattern") resetRule(c.target.id);
    else if (c.target.kind === "ladder") setLadder(c.target.id, true);
  };

  // Filtering opens every family with a match, so results aren't hidden
  // behind a closed header. A ladder shows whole when any rung matches.
  const filtering = query.trim() !== "" || changedOnly;
  const q = query.trim().toLowerCase();
  const matches = (id: string) =>
    (!changedOnly || isRuleChanged(id, draft.patterns[id])) && (q === "" || (NAME_BY_ID.get(id) ?? "").toLowerCase().includes(q) || id.includes(q));
  const groups = PATTERN_FAMILIES.map((f) => {
    const ladders = LADDERS.filter(
      (l) => ladderFamily(l) === f.id && (l.rungs.flat().some(matches) || (changedOnly && q === "" && isLadderChanged(draft, l.id))),
    );
    const singles = PATTERNS.map((p) => p.id).filter((id) => PATTERN_CATALOG[id].family === f.id && !ON_LADDER.has(id) && matches(id));
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
        subtitle={incoming ? "Shared with you · review, then use" : selected === store.active ? `In use: ${inUseName}` : `In use: ${inUseName} · Save to switch`}
        onClose={onClose}
        actions={
          <>
            <button type="button" className="sc-secondary" onClick={() => setDrafts((prev) => (selected === null ? prev : { ...prev, [selected]: structuredClone(DEFAULT_TAI_RULES) }))} disabled={changed === 0}>
              Reset
            </button>
            <button type="button" className="sc-primary" onClick={() => onSave({ v: 1, active: selected, sets: finalSets() })}>
              {selected === store.active && !incoming ? "Save" : "Save & use"}
            </button>
          </>
        }
      >
        {corrupt && !incoming && <div className="tr-notice">Your saved rule sets couldn't be read, so these are the house rules.</div>}
        {legacy && <div className="tr-notice is-warning">Scoring with the original built-in rules (a developer setting) - sets apply once it's switched back.</div>}

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
                    onClick={() => (c.target.kind === "pattern" ? revealPattern(c.target.id) : c.target.kind === "ladder" ? revealLadder(c.target.id) : undefined)}
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

        <div className={`tr-body${legacy ? " is-off" : ""}`} inert={legacy || undefined}>
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
              g.ids.filter((id) => isRuleChanged(id, draft.patterns[id])).length + g.ladders.filter((l) => isLadderChanged(draft, l.id)).length;
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
      </Sheet>
      {sharing && <ShareRulesSheet name={selectedSet ? name : null} rules={draft} count={changed} onClose={() => setSharing(false)} />}
    </>
  );
}

// A ladder: its rungs top-down, highest first, with one switch for whether
// only the highest rung that fires counts (the house list) or every rung
// stacks.
function LadderBlock({ ladder, exclusive, onExclusive, children }: { ladder: Ladder; exclusive: boolean; onExclusive: (v: boolean) => void; children: React.ReactNode }) {
  const changed = !exclusive;
  return (
    <div className={`tr-ladder${exclusive ? "" : " is-stacking"}`} data-reveal={`ladder:${ladder.id}`}>
      <label className="tr-ladder-head">
        <span className="sc-row-main sc-row-stack">
          <span className="tr-ladder-title">
            {ladder.label}
            {changed && <span className="tr-dot" aria-label="changed" />}
          </span>
          <span className="sc-help">{exclusive ? "Only the highest that applies counts" : "Every tier that applies counts"}</span>
        </span>
        <Toggle checked={exclusive} onChange={onExclusive} label={`${ladder.label}: only the highest counts`} />
      </label>
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
  const changed = Object.values(ruleChanges(id, rule)).some(Boolean);
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

      {!CHICKEN_PATTERN_IDS.has(id) && (
        <label className="sc-row tr-detail">
          <span className="sc-row-main sc-row-stack">
            Blocks 大雞/大鴨
            <span className="sc-help">When this applies, 大雞/大鴨 don't. Off for things that say nothing about the hand's shape, like 莊.</span>
          </span>
          <Toggle checked={rule.blocksChicken} onChange={(blocksChicken) => onChange({ blocksChicken })} label="Blocks 大雞/大鴨" />
        </label>
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

// ---- Examples ----

const WINDS = ["東", "南", "西", "北"];

// The situation an example sets, as 情況 shows it: 自摸, 叮 + 一發, 槓摸×2…
function situationChips(ctx: Partial<GameContext>): string[] {
  const chips: string[] = [];
  if (ctx.seatWind && ctx.seatWind !== 1) chips.push(`門風 ${WINDS[ctx.seatWind - 1]}`);
  if (ctx.roundWind && ctx.roundWind !== 1) chips.push(`圈風 ${WINDS[ctx.roundWind - 1]}`);
  if (ctx.dealerStreak) chips.push(ctx.dealerStreak === 1 ? "莊" : `莊 連${ctx.dealerStreak - 1}`);
  if (ctx.selfDraw) chips.push("自摸");
  if (ctx.riichi && ctx.riichi !== "none") chips.push({ riichi: "叮", "heavenly-riichi": "天叮", "earthly-riichi": "地叮" }[ctx.riichi]);
  if (ctx.instantWin) chips.push("一發");
  if (ctx.eatRiichi) chips.push("食叮");
  if (ctx.earlyWin && ctx.earlyWin !== "none") chips.push({ four: "四子內", seven: "七子內", ten: "十子內" }[ctx.earlyWin]);
  if (ctx.multiWin && ctx.multiWin !== "none") chips.push(ctx.multiWin === "double" ? "雙響" : "三響");
  if (ctx.heavenlyWin && ctx.heavenlyWin !== "none") chips.push({ heaven: "天胡", earth: "地胡", man: "人胡" }[ctx.heavenlyWin]);
  if (ctx.lastTileWin && ctx.lastTileWin !== "none") chips.push(ctx.lastTileWin === "river-bottom" ? "河底撈魚" : "海底撈月");
  if (ctx.flowerDraw) chips.push(`花摸×${ctx.flowerDraw}`);
  if (ctx.kongDraw) chips.push(`槓摸×${ctx.kongDraw}`);
  if (ctx.robKong) chips.push(`搶槓×${ctx.robKong}`);
  if (ctx.manualVisibleExhaustedMultiWait) chips.push("絕絕");
  else if (ctx.manualVisibleTripleWin) chips.push("明絕");
  return chips;
}

// The example's rules: the house list (正圈風 at 2, since at 0 it never
// counts), so the hand reads the way the tests score it.
const EXAMPLE_RULES: TaiRules = (() => {
  const rules = structuredClone(DEFAULT_TAI_RULES);
  rules.patterns["correct-round-wind"].tai = 2;
  return rules;
})();

// One pattern's example, in the expanded rule: the tiles it's about where it
// points at particular melds (三元牌, 般高…), the whole hand where it's about
// the hand's shape (清一色, 平胡, 十三么…), and just the situation where it's
// something declared rather than in the tiles (自摸, 叮, 莊…). Then what it's
// worth there under the set being edited.
function PatternExampleView({ id, rules }: { id: string; rules: TaiRules }) {
  const example = PATTERN_EXAMPLES[id];
  const scored = useMemo(() => {
    if (!example) return null;
    try {
      const parsed = { ...parseScoringHand(example.hand), bonusTiles: example.bonus ?? [] };
      const ctx: GameContext = { ...TEST_HAND_BASE_CONTEXT, ...example.ctx };
      const result = scoreParsedHand(parsed, { ...ctx, rules: EXAMPLE_RULES });
      const reading = result.matched.some((m) => m.pattern.id === id) || !result.second ? result : { ...result, ...result.second };
      return { ctx, hand: reading.hand, declared: parsed.declaredMelds.length };
    } catch {
      return null;
    }
  }, [example, id]);
  // What it's worth on the example under the set being edited.
  const worth = useMemo(() => {
    if (!example) return null;
    try {
      const parsed = { ...parseScoringHand(example.hand), bonusTiles: example.bonus ?? [] };
      const result = scoreParsedHand(parsed, { ...TEST_HAND_BASE_CONTEXT, ...example.ctx, rules });
      return [...result.matched, ...(result.second?.matched ?? [])].find((m) => m.pattern.id === id)?.tai ?? 0;
    } catch {
      return null;
    }
  }, [example, id, rules]);
  if (!example || !scored) return null;

  const pattern = PATTERNS.find((p) => p.id === id)!;
  const family = PATTERN_CATALOG[id].family;
  const situation = family === "situation";
  // 正花/爛花/無花 are about the flowers and seasons (and the seat wind they
  // match), not the hand.
  const bonusOnly = family === "bonus";
  const rows = situation || bonusOnly ? null : pattern.tiles?.(scored.hand, scored.ctx);
  // Wind and flower patterns compare against the winds, so always show them.
  const winds = family === "winds" || bonusOnly ? [`門風 ${WINDS[scored.ctx.seatWind - 1]}`, ...(id === "correct-round-wind" ? [`圈風 ${WINDS[scored.ctx.roundWind - 1]}`] : [])] : [];
  const isWindChip = (c: string) => c.startsWith("門風") || c.startsWith("圈風");
  const chips = [...winds, ...situationChips(example.ctx ?? {}).filter((c) => winds.length === 0 || !isWindChip(c))];
  const winning = scored.ctx.winningTile;
  // The 食胡 tile, highlighted once - its first copy among the tiles shown.
  let winningShown = false;
  const isWinning = (t: Tile) => {
    if (winningShown || !winning || t.suit !== winning.suit || t.rank !== winning.rank) return false;
    winningShown = true;
    return true;
  };
  const group = (tiles: Tile[], key: number, declared = false) => (
    <span key={key} className={`breakdown-group${declared ? " tr-example-declared" : ""}`}>
      {tiles.map((t, k) => (
        <TileGlyphSpan key={k} tile={t} highlight={!declared && isWinning(t)} />
      ))}
    </span>
  );

  return (
    <div className="tr-detail tr-example">
      <div className="tr-detail-label">
        Example · {situation ? "declared, on any winning hand" : bonusOnly ? "the flowers and seasons" : rows && rows.length > 0 ? "the tiles it counts" : "the whole hand"}
      </div>
      {bonusOnly && (
        <div className="breakdown-groups tr-example-tiles">
          {scored.hand.bonusTiles.length === 0 ? (
            <span className="tr-none">No flowers or seasons</span>
          ) : (
            scored.hand.bonusTiles.map((b, i) => (
              <span key={i} className="breakdown-group">
                <BonusGlyphSpan tile={b} />
              </span>
            ))
          )}
        </div>
      )}
      {!situation &&
        !bonusOnly &&
        (rows && rows.length > 0 ? (
          rows.map((row, i) => (
            <div key={i} className="breakdown-groups tr-example-tiles">
              {row.map((tiles, j) => group(tiles, j))}
            </div>
          ))
        ) : (
          <div className="breakdown-groups tr-example-tiles">
            {scored.hand.melds.map((m, i) => group(m.tiles, i, i < scored.declared))}
            {group(scored.hand.pair, scored.hand.melds.length)}
            {scored.hand.bonusTiles.map((b, i) => (
              <span key={`b${i}`} className="breakdown-group">
                <BonusGlyphSpan tile={b} />
              </span>
            ))}
          </div>
        ))}
      {situation && scored.hand.bonusTiles.length > 0 && (
        <div className="breakdown-groups tr-example-tiles">
          {scored.hand.bonusTiles.map((b, i) => (
            <span key={i} className="breakdown-group">
              <BonusGlyphSpan tile={b} />
            </span>
          ))}
        </div>
      )}
      {(chips.length > 0 || winning) && (
        <div className="tr-chips">
          {winning && (
            <span className="tr-chip is-static tr-example-chip">
              食 <TileGlyphSpan tile={winning} />
            </span>
          )}
          {chips.map((c) => (
            <span key={c} className="tr-chip is-static tr-example-chip">
              {c}
            </span>
          ))}
        </div>
      )}
      <div className="tr-example-worth">
        {worth === null ? null : worth > 0 ? (
          <>
            Worth <strong>{worth}</strong> tai here
          </>
        ) : (
          "Doesn't count here under this set"
        )}
      </div>
    </div>
  );
}
