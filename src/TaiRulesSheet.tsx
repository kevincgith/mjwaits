// The Scoring tab's 設定 sheet: every pattern's tai, its ladder, what else it
// replaces, which hand shapes it counts on and whether it blocks 大雞/大鴨 -
// the house's tai rules as data (TaiRules in lib/scoring.ts, the
// classification in lib/taiCatalog.ts). Edits a draft, previewed live on the
// hand in the tab; nothing applies until Save.

import qrcode from "qrcode-generator";
import { useEffect, useMemo, useState } from "react";
import { NumberField, Sheet, Toggle } from "./ScoresPanel";
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
  changedCount,
  describeChanges,
  isLadderChanged,
  isRuleChanged,
  ladderOf,
  replaceCycles,
  replacedBy,
  ruleChanges,
  rulesUrl,
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

export function TaiRulesSheet({
  rules,
  incoming,
  corrupt,
  previewTotal,
  onSave,
  onClose,
}: {
  rules: TaiRules;
  /** Rules from a shared link: the sheet opens on them, to review. */
  incoming: TaiRules | null;
  /** The saved rules couldn't be read and were reset to the house list. */
  corrupt: boolean;
  /** The tab's current hand scored under some rules - null if it can't be. */
  previewTotal: (rules: TaiRules) => number | null;
  onSave: (rules: TaiRules) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<TaiRules>(() => structuredClone(incoming ?? rules));
  const [query, setQuery] = useState("");
  const [changedOnly, setChangedOnly] = useState(false);
  const [openFamilies, setOpenFamilies] = useState<Set<PatternFamily>>(() => new Set());
  const [expanded, setExpanded] = useState<string | null>(null);
  const [reveal, setReveal] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);

  const setRule = (id: string, patch: Partial<PatternRule>) =>
    setDraft((prev) => ({ ...prev, patterns: { ...prev.patterns, [id]: { ...prev.patterns[id], ...patch } } }));
  const resetRule = (id: string) => setRule(id, structuredClone(DEFAULT_TAI_RULES.patterns[id]));
  const setLadder = (id: string, exclusive: boolean) => setDraft((prev) => ({ ...prev, ladders: { ...prev.ladders, [id]: { exclusive } } }));

  const cycles = useMemo(() => replaceCycles(draft), [draft]);
  const changes = useMemo(() => describeChanges(draft), [draft]);
  const changed = changedCount(draft);
  const legacy = draft.engine === "legacy";

  // Live preview: the hand in the tab, under the saved rules and the draft.
  const savedTotal = useMemo(() => previewTotal(rules), [previewTotal, rules]);
  const draftTotal = useMemo(() => previewTotal(draft), [previewTotal, draft]);

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
    else setDraft((prev) => ({ ...prev, engine: "custom" }));
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

  return (
    <>
      <Sheet
        title="設定 · 台數規則"
        subtitle={incoming ? "Shared with you · review, then Save to use" : changed === 0 ? "House rules" : `Custom · ${changed} change${changed === 1 ? "" : "s"}`}
        onClose={onClose}
        actions={
          <>
            <button type="button" className="sc-secondary" onClick={() => setDraft({ ...structuredClone(DEFAULT_TAI_RULES), engine: draft.engine })} disabled={changed === 0}>
              House rules
            </button>
            <button type="button" className="sc-primary" onClick={() => onSave(draft)}>
              {incoming ? "Use these rules" : "Save"}
            </button>
          </>
        }
      >
        {corrupt && !incoming && <div className="tr-notice">Your saved rules couldn't be read, so these are the house rules.</div>}
        {legacy && (
          <div className="tr-notice is-warning">
            Scoring with the original built-in rules (a developer setting) - these edits apply once it's switched back.
          </div>
        )}

        <div className={`tr-preview${savedTotal !== null && draftTotal !== null && savedTotal !== draftTotal ? " is-changed" : ""}`} aria-live="polite">
          {savedTotal === null || draftTotal === null ? (
            <span className="tr-preview-empty">Enter a complete hand to see its total change as you edit.</span>
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

        {changes.length > 0 && (
          <div className="sc-settings-group">
            <div className="tr-changes-head">
              <span className="sc-settings-title">Changes from the house list</span>
              <button type="button" className="tr-link" onClick={() => setSharing(true)}>
                Share
              </button>
            </div>
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
          </div>
        )}

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
      {sharing && <ShareRulesSheet rules={draft} count={changed} onClose={() => setSharing(false)} />}
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

// A link (and its QR code) that opens these rules on another phone, for
// everyone at the table to score the same way. The receiver reviews them
// in this sheet before they replace their own.
function ShareRulesSheet({ rules, count, onClose }: { rules: TaiRules; count: number; onClose: () => void }) {
  const url = useMemo(() => rulesUrl(rules), [rules]);
  const svg = useMemo(() => {
    const qr = qrcode(0, "L");
    qr.addData(url);
    qr.make();
    return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  }, [url]);
  const [copied, setCopied] = useState(false);
  return (
    <Sheet
      title="Share these rules"
      subtitle={`${count} change${count === 1 ? "" : "s"} from the house list`}
      onClose={onClose}
      actions={
        <>
          <button
            type="button"
            className="sc-secondary"
            onClick={async () => {
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
              onClick={async () => {
                try {
                  await navigator.share({ title: "MJWaits tai rules", url });
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
      <div className="sc-qr" dangerouslySetInnerHTML={{ __html: svg }} role="img" aria-label="QR code for the rules link" />
      <p className="sc-help sc-help-block">Scan on another phone to open these rules in its 設定, ready to review and use. Unsaved edits are included.</p>
    </Sheet>
  );
}
