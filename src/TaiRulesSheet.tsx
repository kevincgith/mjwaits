// The Scoring tab's 設定 sheet: every pattern's tai, what it replaces, which
// hand shapes it counts on and whether 大雞/大鴨 ignore it - the house's tai
// rules as data (see TaiRules in lib/scoring.ts and the classification in
// lib/taiCatalog.ts). Edits a draft; nothing applies until Save.

import { useMemo, useState } from "react";
import { NumberField, Segmented, Sheet, Toggle } from "./ScoresPanel";
import { CHICKEN_PATTERN_IDS, DEFAULT_TAI_RULES, eligibleShapes, HAND_SHAPES, PATTERNS, type PatternRule, type TaiRules } from "./lib/scoring";
import { PATTERN_CATALOG, PATTERN_FAMILIES, type PatternFamily } from "./lib/taiCatalog";
import { changedCount, isRuleChanged, replaceCycles, replacedBy, ruleChanges } from "./lib/taiRules";

const NAME_BY_ID = new Map(PATTERNS.map((p) => [p.id, p.name]));
// "清一色 (One numbered suit, no honors)" -> ["清一色", "One numbered suit, no honors"]
function splitName(id: string): [string, string] {
  const name = NAME_BY_ID.get(id) ?? id;
  const at = name.indexOf(" (");
  return at === -1 ? [name, ""] : [name.slice(0, at), name.slice(at + 2, -1)];
}
const shortName = (id: string) => splitName(id)[0];

const SHAPE_LABEL = new Map(HAND_SHAPES.map((s) => [s.id, s.label]));

function valueSummary(id: string, rule: PatternRule): string {
  const value = PATTERN_CATALOG[id].value;
  if (value.kind === "table") return (rule.table ?? []).slice(1).join("/");
  if (value.kind === "streak") return `${rule.first ?? value.first} +${rule.tai}`;
  return String(rule.tai);
}

export function TaiRulesSheet({
  rules,
  corrupt,
  onSave,
  onClose,
}: {
  rules: TaiRules;
  /** The saved rules couldn't be read and were reset to the house list. */
  corrupt: boolean;
  onSave: (rules: TaiRules) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<TaiRules>(() => structuredClone(rules));
  const [query, setQuery] = useState("");
  const [changedOnly, setChangedOnly] = useState(false);
  const [openFamilies, setOpenFamilies] = useState<Set<PatternFamily>>(() => new Set());
  const [expanded, setExpanded] = useState<string | null>(null);

  const setRule = (id: string, patch: Partial<PatternRule>) =>
    setDraft((prev) => ({ ...prev, patterns: { ...prev.patterns, [id]: { ...prev.patterns[id], ...patch } } }));
  const resetRule = (id: string) => setRule(id, structuredClone(DEFAULT_TAI_RULES.patterns[id]));

  const cycles = useMemo(() => replaceCycles(draft), [draft]);
  const changed = changedCount(draft);
  const legacy = draft.engine === "legacy";

  // Filtering opens every family with a match, so results aren't hidden
  // behind a closed header.
  const filtering = query.trim() !== "" || changedOnly;
  const q = query.trim().toLowerCase();
  const groups = PATTERN_FAMILIES.map((f) => ({
    ...f,
    ids: PATTERNS.map((p) => p.id).filter(
      (id) =>
        PATTERN_CATALOG[id].family === f.id &&
        (!changedOnly || isRuleChanged(id, draft.patterns[id])) &&
        (q === "" || (NAME_BY_ID.get(id) ?? "").toLowerCase().includes(q) || id.includes(q)),
    ),
  })).filter((g) => g.ids.length > 0);

  const toggleFamily = (id: PatternFamily) =>
    setOpenFamilies((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <Sheet
      title="設定 · 台數規則"
      subtitle={legacy ? "Original hard-coded rules" : changed === 0 ? "House rules" : `Custom · ${changed} change${changed === 1 ? "" : "s"}`}
      onClose={onClose}
      actions={
        <>
          <button type="button" className="sc-secondary" onClick={() => setDraft(structuredClone(DEFAULT_TAI_RULES))} disabled={!legacy && changed === 0}>
            House rules
          </button>
          <button type="button" className="sc-primary" onClick={() => onSave(draft)}>
            Save
          </button>
        </>
      }
    >
      {corrupt && <div className="tr-notice">Your saved rules couldn't be read, so these are the house rules.</div>}

      <div className="sc-settings-group">
        <div className="sc-settings-title">Rules engine</div>
        <div className="sc-row tr-engine">
          <span className="sc-row-main sc-row-stack">
            Score with
            <span className="sc-help">Original uses the built-in list as it was before rules were editable, and ignores everything below.</span>
          </span>
          <Segmented
            value={draft.engine}
            onChange={(engine) => setDraft((prev) => ({ ...prev, engine }))}
            options={[
              { value: "custom", label: "These rules" },
              { value: "legacy", label: "Original" },
            ]}
          />
        </div>
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
            Some patterns replace each other in a loop, so when they all fire, none of them count:{" "}
            {[...cycles.keys()].map(shortName).join(", ")}.
          </div>
        )}

        {groups.length === 0 && <div className="tr-empty">No patterns match.</div>}

        {groups.map((g) => {
          const open = filtering || openFamilies.has(g.id);
          const familyChanged = g.ids.filter((id) => isRuleChanged(id, draft.patterns[id])).length;
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
                <div className="sc-list">
                  {g.ids.map((id) => (
                    <PatternRow
                      key={id}
                      id={id}
                      rule={draft.patterns[id]}
                      draft={draft}
                      inCycle={cycles.has(id)}
                      expanded={expanded === id}
                      onExpand={() => setExpanded((cur) => (cur === id ? null : id))}
                      onChange={(patch) => setRule(id, patch)}
                      onReset={() => resetRule(id)}
                    />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Sheet>
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
  const changes = ruleChanges(id, rule);
  const changed = Object.values(changes).some(Boolean);
  const flatOrPer = value.kind === "flat" || value.kind === "per";
  return (
    <div className={`tr-pattern${rule.enabled ? "" : " is-disabled"}${expanded ? " is-expanded" : ""}`}>
      <div className="sc-row">
        <button type="button" className="tr-pattern-name" aria-expanded={expanded} onClick={onExpand}>
          <span className="tr-pattern-zh">
            {zh}
            {changed && <span className="tr-dot" aria-label="changed" />}
            {inCycle && <span className="tr-warn" title="Part of a replace loop" aria-label="replace loop">!</span>}
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
  // The add-a-replace picker: this family first, then the rest.
  const candidates = PATTERNS.map((p) => p.id).filter((other) => other !== id && !rule.replaces.includes(other));
  const sameFamily = candidates.filter((other) => PATTERN_CATALOG[other].family === family);
  const otherFamilies = candidates.filter((other) => PATTERN_CATALOG[other].family !== family);

  return (
    <div className="tr-details">
      {value.kind === "table" && (
        <div className="tr-detail">
          <div className="tr-detail-label">Tai by count</div>
          <div className="tr-table">
            {(rule.table ?? []).slice(1).map((v, i) => (
              <label key={i} className="tr-table-cell">
                <span>×{i + 1}</span>
                <NumberField
                  value={v}
                  onChange={(n) => onChange({ table: (rule.table ?? []).map((old, j) => (j === i + 1 ? n : old)) })}
                  label={`Tai at ${i + 1}`}
                  pill
                />
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
        <div className="tr-detail-label">Replaces · when both count, these are dropped</div>
        <div className="tr-chips">
          {rule.replaces.length === 0 && <span className="tr-none">Nothing - stacks with everything</span>}
          {rule.replaces.map((other) => (
            <span key={other} className="tr-chip is-static">
              {shortName(other)}
              <button type="button" aria-label={`Stop replacing ${shortName(other)}`} onClick={() => onChange({ replaces: rule.replaces.filter((r) => r !== other) })}>
                ×
              </button>
            </span>
          ))}
          <select
            className="tr-add"
            value=""
            aria-label="Add a pattern this replaces"
            onChange={(e) => e.target.value && onChange({ replaces: [...rule.replaces, e.target.value] })}
          >
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
        <div className="tr-chips">{by.length === 0 ? <span className="tr-none">Nothing</span> : by.map((other) => <span key={other} className="tr-chip is-static">{shortName(other)}</span>)}</div>
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
            大雞/大鴨 ignore this
            <span className="sc-help">On: this can count and 大雞/大鴨 still apply.</span>
          </span>
          <Toggle checked={rule.chickenIgnores} onChange={(chickenIgnores) => onChange({ chickenIgnores })} label="大雞/大鴨 ignore this" />
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
