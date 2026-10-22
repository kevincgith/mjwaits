// The printable rules reference (設定 → Export PDF): a human-readable summary
// of a rule set - not the settings themselves. A full-screen preview with a
// "Print / Save as PDF" button; in print only the document shows (see the
// .rr-* print styles in App.css). Page 1 is every pattern at a glance -
// name, value, type; page 2 how scoring works; then each family, its tiers,
// and each pattern with an example hand.

import { Fragment, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { PatternExampleView } from "./PatternExample";
import { rasterizeTileArt, TileArtRemapContext, TileStyleContext } from "./tileArt";
import { FAMILY_GUIDE, GENERAL_RULES, PAIR_GUIDE, PATTERN_GUIDE } from "./lib/patternGuide";
import { DEFAULT_TAI_RULES, effectiveReplaces, HAND_SHAPES, PATTERNS, type PatternRule, type TaiRules } from "./lib/scoring";
import { LADDERS, pairOf, PATTERN_CATALOG, PATTERN_FAMILIES, type Ladder, type OpenConcealedPair, type PatternFamily } from "./lib/taiCatalog";
import { chickenIgnores, describeChanges, isLadderChanged, isRowChanged, pairName, ruleChanges, shortName } from "./lib/taiRules";

const NAME_BY_ID = new Map(PATTERNS.map((p) => [p.id, p.name]));
const english = (id: string) => {
  const name = NAME_BY_ID.get(id) ?? "";
  const at = name.indexOf(" (");
  return at === -1 ? "" : name.slice(at + 2, -1);
};
const SHAPE_LABEL = new Map(HAND_SHAPES.map((s) => [s.id, s.label]));

// Same grouping as the sheet: a ladder sits under the family of its top rung.
const ladderFamily = (l: Ladder): PatternFamily => PATTERN_CATALOG[l.rungs[l.rungs.length - 1][0]].family;
const ON_LADDER = new Set(LADDERS.flatMap((l) => l.rungs.flat()));
const GROUPS = PATTERN_FAMILIES.map((f) => {
  const ladders = LADDERS.filter((l) => ladderFamily(l) === f.id);
  const singles = PATTERNS.map((p) => p.id).filter((id) => PATTERN_CATALOG[id].family === f.id && !ON_LADDER.has(id));
  // Ladder patterns top rung first, then the rest in list order.
  const ids = [...ladders.flatMap((l) => [...l.rungs].reverse().flat()), ...singles];
  return { ...f, ladders, ids };
}).filter((g) => g.ids.length > 0);

// Page 1's four columns, split here rather than by CSS multi-column, which
// Safari's engine doesn't keep when printing (everything falls into one long
// column over several pages). A family can run on into the next column,
// which then repeats its heading marked "cont."; a heading never ends a
// column on its own.
type SummaryLine = { kind: "family"; group: (typeof GROUPS)[number]; cont: boolean } | { kind: "row"; id: string };
const SUMMARY_COLUMNS: SummaryLine[][] = (() => {
  // A 明/暗 pair is one line, carried by its 明 half.
  const lines: SummaryLine[] = GROUPS.flatMap((g) => [
    { kind: "family" as const, group: g, cont: false },
    ...g.ids.filter((id) => pairOf(id)?.concealed !== id).map((id) => ({ kind: "row" as const, id })),
  ]);
  const perColumn = Math.ceil(lines.length / 4);
  const columns: SummaryLine[][] = [[]];
  let group = GROUPS[0];
  for (const line of lines) {
    let column = columns[columns.length - 1];
    const full = column.length >= perColumn - (line.kind === "family" ? 1 : 0);
    if (full && columns.length < 4) {
      column = [];
      columns.push(column);
      if (line.kind === "row") column.push({ kind: "family", group, cont: true });
    }
    if (line.kind === "family") group = line.group;
    column.push(line);
  }
  return columns;
})();

function SummaryRow({ id, rules, legacy }: { id: string; rules: TaiRules; legacy: boolean }) {
  const pair = pairOf(id);
  const rule = rules.patterns[id];
  // A 明/暗 pair: one line, "5 / 8" (明 / 暗).
  const partner = pair ? rules.patterns[pair.concealed] : undefined;
  const enabled = rule.enabled || !!partner?.enabled;
  const changed = !legacy && (isRowChanged(id, rule) || (!!pair && isRowChanged(pair.concealed, partner!)));
  const v = valueOf(id, rule);
  const value = pair
    ? `${rule.enabled ? rule.tai : "–"} / ${partner!.enabled ? partner!.tai : "–"}`
    : v.value;
  return (
    <div className={`rr-sum-row${enabled ? "" : " is-off"}`}>
      <span className="rr-sum-name">
        {pair ? pairName(pair)[0] : shortName(id)}
        {changed && <span className="rr-mark" aria-label="changed from the house rules" />}
      </span>
      <span className="rr-sum-value">{enabled ? value : "off"}</span>
      <span className="rr-sum-type">{enabled ? v.type : ""}</span>
    </div>
  );
}

/** A pattern's value in words: "5", "2 each", "5 · 25 · 125…", "1, +2 per 連莊". */
function valueOf(id: string, rule: PatternRule): { value: string; type: string; long: string } {
  const v = PATTERN_CATALOG[id].value;
  if (v.kind === "table") {
    const t = (rule.table ?? []).slice(1);
    // The summary shows the range; the details, every step.
    return { value: `${Math.min(...t)}–${Math.max(...t)}`, type: "×n", long: t.map((n, i) => `×${i + 1} ${n}`).join(" · ") };
  }
  if (v.kind === "streak") {
    const first = rule.first ?? v.first;
    return { value: `${first} +${rule.tai}`, type: "連莊", long: `${first} tai as dealer, +${rule.tai} per 連莊` };
  }
  if (v.kind === "per") return { value: String(rule.tai), type: "each", long: `${rule.tai} tai each` };
  return { value: String(rule.tai), type: "", long: `${rule.tai} tai` };
}

export function RulesReference({ name, rules, onClose }: { name: string; rules: TaiRules; onClose: () => void }) {
  // Every tile kind as one shared PNG for printing (see TileArtRemapContext);
  // 120 px tall is several times the printed size, so they stay sharp.
  const [pngs, setPngs] = useState<Map<string, string> | null>(null);
  useEffect(() => {
    let live = true;
    let made: Map<string, string> | null = null;
    void rasterizeTileArt(120).then((map) => {
      made = map;
      if (live) setPngs(map);
      else for (const url of map.values()) URL.revokeObjectURL(url);
    });
    return () => {
      live = false;
      if (made) for (const url of made.values()) URL.revokeObjectURL(url);
    };
  }, []);
  const legacy = rules.engine === "legacy";
  // Under the original engine the house list is what scores.
  const shown = legacy ? DEFAULT_TAI_RULES : rules;
  const changes = legacy ? [] : describeChanges(rules);
  const ignored = chickenIgnores(shown);
  const date = new Date().toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
  const title = legacy ? "港式台牌 House rules" : name;

  return createPortal(
    <TileStyleContext.Provider value="art">
      <TileArtRemapContext.Provider value={pngs}>
      <div className="rr-overlay" role="dialog" aria-modal="true" aria-label="Rules reference">
        <div className="rr-toolbar">
          <button type="button" className="sc-secondary" onClick={onClose}>
            Close
          </button>
          <span className="rr-toolbar-hint">A4 · choose "Save as PDF" in the print dialog</span>
          <button type="button" className="sc-primary" onClick={() => window.print()} disabled={!pngs}>
            {pngs ? "Print / Save as PDF" : "Preparing…"}
          </button>
        </div>

        <article className="rr-doc">
          {/* ---- Page 1: everything at a glance ---- */}
          <section className="rr-page rr-summary">
            <header className="rr-head">
              <div className="rr-kicker">MJWaits · 台數規則 Tai rules reference</div>
              <h1 className="rr-title">{title}</h1>
              <div className="rr-sub">
                {date}
                {legacy
                  ? " · scored with the original built-in engine"
                  : changes.length > 0
                    ? ` · ${changes.length} change${changes.length === 1 ? "" : "s"} from the house rules`
                    : " · the house rules"}
              </div>
            </header>

            <div className="rr-columns">
              {SUMMARY_COLUMNS.map((column, ci) => (
                <div key={ci} className="rr-col">
                  {column.map((line) =>
                    line.kind === "family" ? (
                      <div key={`${line.group.id}${line.cont ? "+" : ""}`} className="rr-sum-family">
                        {/* Continued: just the Chinese name, so the heading stays on one line. */}
                        {line.cont ? line.group.label.split(" ")[0] : line.group.label}
                        {line.cont && <span className="rr-sum-cont">cont.</span>}
                        {/* A tier that stacks in this set, rather than only its highest counting. */}
                        {!line.cont && !legacy && line.group.ladders.some((l) => isLadderChanged(rules, l.id)) && (
                          <span className="rr-mark" aria-label="tier changed" />
                        )}
                      </div>
                    ) : (
                      <SummaryRow key={line.id} id={line.id} rules={shown} legacy={legacy} />
                    ),
                  )}
                </div>
              ))}
            </div>

            <footer className="rr-legend">
              <span>
                <b>5 / 8</b> 明 open / 暗 concealed
              </span>
              <span>
                <b>each</b> per meld or instance
              </span>
              <span>
                <b>×n</b> by how many in a row
              </span>
              <span>
                <b>連莊</b> as dealer, plus each repeat
              </span>
              <span>
                <span className="rr-mark" /> changed from the house rules
              </span>
              <span>Within a tier, only the highest that applies counts.</span>
            </footer>
          </section>

          {/* ---- Page 2: how scoring works, before the patterns that rely on it ---- */}
          <section className="rr-general">
            <h2 className="rr-family-title">How scoring works</h2>
            <div className="rr-rules-grid">
              {GENERAL_RULES.map((r) => (
                <div key={r.title} className="rr-rule">
                  <h3>{r.title}</h3>
                  <p>{r.text}</p>
                </div>
              ))}
              <div className="rr-rule">
                <h3>What 大雞/大鴨 ignore</h3>
                <p>大雞 and 大鴨 count only when nothing else does - except these, which can count alongside them: {ignored.map(shortName).join("、")}.</p>
              </div>
            </div>
            {changes.length > 0 && (
              <>
                <h3 className="rr-changes-title">Changes from the house rules</h3>
                <ul className="rr-changes">
                  {changes.map((c, i) => (
                    <li key={i}>{c.text}</li>
                  ))}
                </ul>
              </>
            )}
          </section>
          {/* ---- The details: one section per family ---- */}
          {GROUPS.map((g, gi) => (
            <section key={g.id} className={`rr-family${gi === 0 ? " is-first" : ""}`}>
              <h2 className="rr-family-title">{g.label}</h2>
              <p className="rr-family-guide">{FAMILY_GUIDE[g.id]}</p>

              {g.ladders.map((l) => {
                const exclusive = shown.ladders[l.id]?.exclusive !== false;
                return (
                  <div key={l.id} className="rr-ladder">
                    <span className="rr-ladder-label">
                      {l.kind === "windows"
                        ? "Tier · the longest with a value counts; one worth 0 counts as overlapping shorter ones"
                        : exclusive
                          ? "Tier · only the highest counts"
                          : "Tier · every level counts"}
                    </span>
                    <span className="rr-ladder-rungs">
                      {[...l.rungs].reverse().map((rung, i) => (
                        <span key={i} className="rr-ladder-rung">
                          {i > 0 && <span className="rr-ladder-sep">{exclusive || l.kind === "windows" ? "›" : "+"}</span>}
                          {rung.map(shortName).join(" / ")}
                        </span>
                      ))}
                    </span>
                    {!legacy && isLadderChanged(rules, l.id) && <span className="rr-mark" aria-label="changed" />}
                  </div>
                );
              })}

              <div className="rr-cards">
                {g.ids.map((id) => {
                  const pair = pairOf(id);
                  if (!pair) return <PatternCard key={id} id={id} rules={shown} changedFromHouse={!legacy} />;
                  if (pair.concealed === id) return null;
                  return <PairCard key={pair.id} pair={pair} rules={shown} changedFromHouse={!legacy} />;
                })}
              </div>
            </section>
          ))}

        </article>
      </div>
      </TileArtRemapContext.Provider>
    </TileStyleContext.Provider>,
    document.body,
  );
}

function PatternCard({ id, rules, changedFromHouse }: { id: string; rules: TaiRules; changedFromHouse: boolean }) {
  const rule = rules.patterns[id];
  const base = DEFAULT_TAI_RULES.patterns[id];
  const v = valueOf(id, rule);
  const c = ruleChanges(id, rule);
  const replaces = effectiveReplaces(rules, id);
  // Where it counts - worth saying only when this set has changed it.
  const shapes = c.shapes ? rule.shapes : null;
  return (
    <div className={`rr-card${rule.enabled ? "" : " is-off"}`}>
      <div className="rr-card-head">
        <span className="rr-card-name">
          <span className="rr-card-zh">{shortName(id)}</span>
          <span className="rr-card-en">{english(id)}</span>
        </span>
        <span className="rr-card-value">{rule.enabled ? v.long : "Not counted"}</span>
      </div>
      <p className="rr-card-text">{PATTERN_GUIDE[id]}</p>
      {rule.enabled && <PatternExampleView id={id} rules={rules} />}
      <dl className="rr-card-meta">
        {replaces.length > 0 && (
          <>
            <dt>Replaces</dt>
            <dd>{replaces.map(shortName).join("、")}</dd>
          </>
        )}
        {shapes && (
          <>
            <dt>Counts on</dt>
            <dd>{shapes.length === 0 ? "No hand shape" : shapes.map((s) => SHAPE_LABEL.get(s)).join("、")}</dd>
          </>
        )}
        {changedFromHouse && (c.value || c.enabled) && (
          <>
            <dt>House rule</dt>
            <dd>{base.enabled ? valueOf(id, base).long : "Not counted"}</dd>
          </>
        )}
      </dl>
    </div>
  );
}

// A 明/暗 pair's card: one name and description, a value for each side,
// each side's example, and what each replaces (once, if the same).
function PairCard({ pair, rules, changedFromHouse }: { pair: OpenConcealedPair; rules: TaiRules; changedFromHouse: boolean }) {
  const [zh, en] = pairName(pair);
  const sides = [
    { id: pair.open, label: "明", rule: rules.patterns[pair.open] },
    { id: pair.concealed, label: "暗", rule: rules.patterns[pair.concealed] },
  ];
  const enabled = sides.some((side) => side.rule.enabled);
  const replaces = sides.map((side) => effectiveReplaces(rules, side.id).map(shortName).join("、"));
  return (
    <div className={`rr-card${enabled ? "" : " is-off"}`}>
      <div className="rr-card-head">
        <span className="rr-card-name">
          <span className="rr-card-zh">{zh}</span>
          <span className="rr-card-en">{en}</span>
        </span>
        <span className="rr-card-value">
          {sides.map((side) => `${side.label} ${side.rule.enabled ? valueOf(side.id, side.rule).long : "off"}`).join(" · ")}
        </span>
      </div>
      <p className="rr-card-text">{PAIR_GUIDE[pair.id]}</p>
      {sides.map(
        (side) =>
          side.rule.enabled && (
            <div key={side.id} className="rr-pair-example">
              <span className="rr-pair-side">{side.label}</span>
              <PatternExampleView id={side.id} rules={rules} />
            </div>
          ),
      )}
      <dl className="rr-card-meta">
        {replaces[0] === replaces[1]
          ? replaces[0] && (
              <>
                <dt>Replaces</dt>
                <dd>{replaces[0]}</dd>
              </>
            )
          : sides.map(
              (side, i) =>
                replaces[i] && (
                  <Fragment key={side.id}>
                    <dt>{side.label} replaces</dt>
                    <dd>{replaces[i]}</dd>
                  </Fragment>
                ),
            )}
        {changedFromHouse &&
          sides.map((side) => {
            const c = ruleChanges(side.id, side.rule);
            const base = DEFAULT_TAI_RULES.patterns[side.id];
            return (
              (c.value || c.enabled) && (
                <Fragment key={`h${side.id}`}>
                  <dt>House {side.label}</dt>
                  <dd>{base.enabled ? valueOf(side.id, base).long : "Not counted"}</dd>
                </Fragment>
              )
            );
          })}
      </dl>
    </div>
  );
}
