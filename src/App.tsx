import { useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import "./App.css";
import {
  COMPLETE_SIZE,
  ParseError,
  allTileKinds,
  analyzeDiscardChoices,
  analyzeDiscardEfficiency,
  decomposeHand,
  formatHand,
  getWaitsWithJokers,
  isCheckpointSize,
  isCompleteCheckpointSize,
  meldsForCompleteSize,
  meldsForSize,
  parseHand,
  shanten,
  sortTiles,
  tileCount,
  tileGlyph,
  tileLabel,
} from "./lib/mahjong";
import type { DiscardChoice, DiscardEfficiency, JokerWaitResult, Suit, Tile } from "./lib/mahjong";

// A stable id per tile instance, so sorting for display never loses track
// of which underlying tile is which (needed to revert Sort cleanly, and to
// remove the right instance when several tiles share a suit/rank).
interface HandTile extends Tile {
  id: number;
}

const JOKER_TILE: Tile = { suit: "j", rank: 1 };
const SUIT_ORDER: Suit[] = ["m", "t", "s", "z"];
// Both kinds of checkpoint interleaved: 3n+1 (waits/shanten/discard-analysis
// sizes) and 3n+2 (one tile past that - already-complete/discard-choice
// sizes). Sizes of the form 3n are never a checkpoint (mid-meld).
const CHECKPOINTS = [1, 2, 4, 5, 7, 8, 10, 11, 13, 14, 16, 17];

type BreakdownMode = "off" | "on" | "sorted";
const BREAKDOWN_CYCLE: BreakdownMode[] = ["off", "on", "sorted"];
const BREAKDOWN_LABEL: Record<BreakdownMode, string> = { off: "Off", on: "On", sorted: "Sorted" };
const BREAKDOWN_TITLE: Record<BreakdownMode, string> = {
  off: "Breakdown: off — shows just the waiting tiles",
  on: "Breakdown: on — shows the meld/pair split for each wait, pair first",
  sorted: "Breakdown: sorted — shows the meld/pair split in tile order, not pair-first",
};

function nextCheckpoint(size: number): number | undefined {
  return CHECKPOINTS.find((c) => c > size);
}

// iOS Safari's native touch->click pipeline gets unreliable under fast
// successive taps on different elements - under load, its target
// resolution for the synthesized click can lag behind and fire on the
// PREVIOUS element's tap instead of the current one, which is what caused
// rapid tile taps to duplicate an earlier tile. Pointer events sidestep
// this: a touch pointer has implicit capture, so pointerup always fires on
// the exact element that got pointerdown, with no separate "which element
// was this click for" resolution step to get wrong. Mouse and keyboard
// still go through the plain onClick path (calling preventDefault on
// pointerdown only suppresses the browser's compatibility click for
// touch/pen, not a real mouse click).
//
// That compatibility click isn't always fully suppressed, though - and
// unlike pointerup, it's dispatched via ordinary hit-testing at its
// coordinates, not routed back to the original element. If our own tap
// handler already removed a tile and the list reflowed before that
// trailing click arrives, whatever tile shifted into the tapped tile's old
// screen position (i.e. the next one) receives it and gets removed too -
// reported as "tapping the Nth tile also removes the N+1th". A per-element
// suppression flag can't catch this, since the stray click lands on a
// DIFFERENT element than the one that was actually tapped. Instead, a
// single capture-phase listener on the document blocks any click that
// arrives within a short window of a real touch tap, regardless of which
// element it targets.
let lastTouchTapAt = 0;
if (typeof document !== "undefined") {
  document.addEventListener(
    "click",
    (e) => {
      if (performance.now() - lastTouchTapAt < 500) {
        e.preventDefault();
        e.stopPropagation();
      }
    },
    true
  );
}

function useTap(onTap: () => void, disabled?: boolean) {
  const startRef = useRef<{ x: number; y: number } | null>(null);

  const onPointerDown = (e: ReactPointerEvent) => {
    if (disabled) return;
    startRef.current = { x: e.clientX, y: e.clientY };
    if (e.pointerType !== "mouse") e.preventDefault();
  };

  const onPointerUp = (e: ReactPointerEvent) => {
    if (disabled || e.pointerType === "mouse") return;
    const start = startRef.current;
    startRef.current = null;
    if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 10) return; // a drag/scroll, not a tap
    lastTouchTapAt = performance.now();
    onTap();
  };

  const onPointerCancel = () => {
    startRef.current = null;
  };

  const onClick = () => {
    // The global listener above already blocks any click that follows a
    // real touch tap, so a click reaching here only ever means a genuine
    // mouse click or keyboard activation (Enter/Space) - both legitimate.
    if (disabled) return;
    onTap();
  };

  return { onPointerDown, onPointerUp, onPointerCancel, onClick };
}

function TileGlyphSpan({ tile, large, highlight }: { tile: Tile; large?: boolean; highlight?: boolean }) {
  const classes = ["tile-glyph", large && "large", highlight && "wait-highlight"].filter(Boolean).join(" ");
  return (
    <span className={classes} data-suit={tile.suit} data-rank={tile.rank}>
      {tileGlyph(tile)}
    </span>
  );
}

function TileButton({ tile, onClick, disabled }: { tile: Tile; onClick: () => void; disabled?: boolean }) {
  const tap = useTap(onClick, disabled);
  return (
    <button type="button" className="tile-button" disabled={disabled} title={tileLabel(tile)} {...tap}>
      <TileGlyphSpan tile={tile} />
    </button>
  );
}

function HandTileButton({ tile, onClick }: { tile: Tile; onClick: () => void }) {
  const tap = useTap(onClick);
  return (
    <button type="button" className="hand-tile-button" title={`Remove ${tileLabel(tile)}`} {...tap}>
      <TileGlyphSpan tile={tile} large />
    </button>
  );
}

function RemainingCountBadge({ count }: { count: number }) {
  return (
    <span className="remaining-count" title={`${count} of this tile left (4 total, minus what's in your hand)`}>
      ×{count}
    </span>
  );
}

function WaitResultTile({
  result,
  remainingCount,
}: {
  result: JokerWaitResult;
  remainingCount: number | null;
}) {
  return (
    <span className="wait-result">
      <TileGlyphSpan tile={result.wait} large />
      {remainingCount !== null && <RemainingCountBadge count={remainingCount} />}
      {result.jokers.length > 0 && (
        <span className="joker-hint" title="What the joker(s) resolve to for this wait">
          <TileGlyphSpan tile={JOKER_TILE} />=
          {result.jokers.map((j, i) => (
            <TileGlyphSpan key={i} tile={j} />
          ))}
        </span>
      )}
    </span>
  );
}

// Shared by WaitBreakdownRow and CompleteHandBreakdown: the pair-first (or,
// in sorted mode, tile-order) arrangement of a decomposed hand's groups.
function orderBreakdownGroups<T extends { tiles: Tile[] }>(groups: T[], sorted: boolean): T[] {
  return sorted
    ? [...groups].sort((a, b) => {
        const [ta, tb] = [a.tiles[0], b.tiles[0]];
        return SUIT_ORDER.indexOf(ta.suit) - SUIT_ORDER.indexOf(tb.suit) || ta.rank - tb.rank;
      })
    : groups;
}

function WaitBreakdownRow({
  result,
  nonJokerHand,
  meldsRequired,
  sorted,
  remainingCount,
}: {
  result: JokerWaitResult;
  nonJokerHand: Tile[];
  meldsRequired: number;
  sorted: boolean;
  remainingCount: number | null;
}) {
  const complete = [...nonJokerHand, ...result.jokers, result.wait];
  const breakdown = decomposeHand(complete, meldsRequired);

  if (!breakdown) {
    // Special hands (Thirteen Orphans, Eight Pairs, Sixteen Unrelated Tiles)
    // don't decompose into melds + pair - fall back to the plain wait display.
    return (
      <div className="breakdown-row">
        <WaitResultTile result={result} remainingCount={remainingCount} />
      </div>
    );
  }

  const groups = [
    { tiles: breakdown.pair, key: "pair" },
    ...breakdown.melds.map((tiles, i) => ({ tiles, key: `meld-${i}` })),
  ];
  const ordered = orderBreakdownGroups(groups, sorted);

  let waitPlaced = false;
  const renderGroup = ({ tiles, key }: (typeof groups)[number]) => (
    <span className="breakdown-group" key={key}>
      {tiles.map((t, i) => {
        const isWait = !waitPlaced && t.suit === result.wait.suit && t.rank === result.wait.rank;
        if (isWait) waitPlaced = true;
        return <TileGlyphSpan key={i} tile={t} large highlight={isWait} />;
      })}
    </span>
  );

  return (
    <div className="breakdown-row">
      <TileGlyphSpan tile={result.wait} large />
      {remainingCount !== null && <RemainingCountBadge count={remainingCount} />}
      <span className="discard-arrow">→</span>
      <span className="breakdown-groups">{ordered.map(renderGroup)}</span>
    </div>
  );
}

// Meld/pair breakdown for a hand that's already complete (no wait tile to
// highlight, since nothing's missing).
function CompleteHandBreakdown({
  hand,
  meldsRequired,
  sorted,
}: {
  hand: Tile[];
  meldsRequired: number;
  sorted: boolean;
}) {
  const breakdown = decomposeHand(hand, meldsRequired);
  if (!breakdown) {
    // Special hands (Thirteen Orphans, Eight Pairs, Sixteen Unrelated Tiles)
    // don't decompose into melds + pair.
    return null;
  }

  const groups = [
    { tiles: breakdown.pair, key: "pair" },
    ...breakdown.melds.map((tiles, i) => ({ tiles, key: `meld-${i}` })),
  ];
  const ordered = orderBreakdownGroups(groups, sorted);

  return (
    <span className="breakdown-groups">
      {ordered.map(({ tiles, key }) => (
        <span className="breakdown-group" key={key}>
          {tiles.map((t, i) => (
            <TileGlyphSpan key={i} tile={t} large />
          ))}
        </span>
      ))}
    </span>
  );
}

function DiscardEfficiencyRow({ option }: { option: DiscardEfficiency }) {
  return (
    <div className="discard-row discard-efficiency-row">
      <div className="discard-efficiency-header">
        <TileGlyphSpan tile={option.discard} />
        <span className="discard-arrow">→</span>
        <span
          className="efficiency-score"
          title="Sum over each useful draw of (copies of that draw left) × (remaining tiles in the wait it leads to). Higher means more likely to reach a win."
        >
          {option.score} pt{option.score === 1 ? "" : "s"}
        </span>
      </div>
      {option.draws.length > 0 ? (
        <div className="discard-efficiency-draws">
          {option.draws.map((d) => (
            <div className="draw-detail-row" key={tileLabel(d.draw)}>
              <TileGlyphSpan tile={d.draw} />
              <RemainingCountBadge count={d.drawRemaining} />
              <span className="discard-arrow">→</span>
              {d.resultingWaits.map((w) => (
                <TileGlyphSpan key={tileLabel(w)} tile={w} />
              ))}
              <span className="hint">
                ({d.resultingWaitsTotal} tile{d.resultingWaitsTotal === 1 ? "" : "s"})
              </span>
            </div>
          ))}
        </div>
      ) : (
        <span className="hint">no draw reaches tenpai</span>
      )}
    </div>
  );
}

function DiscardChoiceRow({ choice }: { choice: DiscardChoice }) {
  if (choice.resultingShanten === 0) {
    return (
      <div className="discard-row">
        <TileGlyphSpan tile={choice.discard} />
        <span className="discard-arrow">→</span>
        <span className="tenpai-tag">Tenpai</span>
        {choice.waits.map((w) => (
          <TileGlyphSpan key={tileLabel(w)} tile={w} />
        ))}
        <span className="hint">
          ({choice.waitsTotal} tile{choice.waitsTotal === 1 ? "" : "s"})
        </span>
      </div>
    );
  }

  return (
    <div className="discard-row discard-efficiency-row">
      <div className="discard-efficiency-header">
        <TileGlyphSpan tile={choice.discard} />
        <span className="discard-arrow">→</span>
        <span className="shanten-badge">Shanten {choice.resultingShanten}</span>
      </div>
      {choice.improvingDraws.length > 0 ? (
        <div className="discard-efficiency-draws">
          <div className="draw-detail-row">
            {choice.improvingDraws.map((d) => {
              const isRedraw = d.draw.suit === choice.discard.suit && d.draw.rank === choice.discard.rank;
              return (
                <span
                  className={isRedraw ? "wait-result redraw" : "wait-result"}
                  key={tileLabel(d.draw)}
                  title={isRedraw ? "Drawing this back only helps if you discard something different this time" : undefined}
                >
                  <TileGlyphSpan tile={d.draw} />
                  <RemainingCountBadge count={d.remaining} />
                  {isRedraw && <span className="redraw-mark">↺</span>}
                </span>
              );
            })}
            <span
              className="hint"
              title="Second number excludes draws that only help via a different follow-up discard than the one just made"
            >
              (
              {choice.improvingDrawsTotal === choice.improvingDrawsTotalExcludingRedraw
                ? choice.improvingDrawsTotal
                : `${choice.improvingDrawsTotal} or ${choice.improvingDrawsTotalExcludingRedraw}↺`}
              )
            </span>
          </div>
        </div>
      ) : (
        <span className="hint">no draw improves this further</span>
      )}
    </div>
  );
}

function App() {
  // `hand` always holds tiles in true input order - Sort never mutates it,
  // it only changes how `displayHand` (below) is derived for rendering/text.
  const [hand, setHand] = useState<HandTile[]>([]);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sortMode, setSortMode] = useState(true);
  const [breakdownMode, setBreakdownMode] = useState<BreakdownMode>("off");
  const nextId = useRef(0);
  const withIds = (tiles: Tile[]): HandTile[] => tiles.map((t) => ({ ...t, id: nextId.current++ }));
  const forDisplay = (tiles: HandTile[], sorted: boolean) => (sorted ? (sortTiles(tiles) as HandTile[]) : tiles);

  const displayHand = useMemo(() => forDisplay(hand, sortMode), [hand, sortMode]);

  // Mirrors `hand`, but updated synchronously (unlike the state, which only
  // reflects reality once React commits a render). Tapping tiles fast enough
  // that two taps land before a render commits between them would otherwise
  // have both addTile calls read the SAME stale `hand` from their closures
  // and each build their "next hand" from it independently - the second call
  // clobbering the first, which is what caused rapid taps to drop or
  // duplicate tiles. Handlers read/write this ref instead so each one always
  // builds on the one immediately before it, no matter how fast they fire.
  const handRef = useRef<HandTile[]>([]);

  const commitHand = (tiles: HandTile[]) => {
    handRef.current = tiles;
    setHand(tiles);
    setText(formatHand(forDisplay(tiles, sortMode)));
    setError(null);
  };

  const addTile = (tile: Tile) => {
    if (handRef.current.length >= COMPLETE_SIZE) return;
    commitHand([...handRef.current, ...withIds([tile])]);
  };

  const onTextChange = (value: string) => {
    setText(value);
    try {
      const parsed = withIds(parseHand(value));
      handRef.current = parsed;
      setHand(parsed);
      setError(null);
    } catch (e) {
      setError(e instanceof ParseError ? e.message : "Could not parse hand");
    }
  };

  const toggleSortMode = () => {
    const next = !sortMode;
    setSortMode(next);
    setText(formatHand(forDisplay(handRef.current, next)));
  };
  const handleReset = () => commitHand([]);
  const removeTile = (id: number) => commitHand(handRef.current.filter((t) => t.id !== id));

  const canCalculate = isCheckpointSize(hand.length);
  const upcoming = nextCheckpoint(hand.length);
  const hasJokers = useMemo(() => hand.some((t) => t.suit === "j"), [hand]);
  const outcome = useMemo(
    () => (canCalculate && hand.length > 0 ? getWaitsWithJokers(hand, meldsForSize(hand.length)) : null),
    [hand, canCalculate]
  );
  const shantenValue = useMemo(
    () => (canCalculate && hand.length > 0 && !hasJokers ? shanten(hand, meldsForSize(hand.length)) : null),
    [hand, canCalculate, hasJokers]
  );
  const notTenpaiCheckpoint =
    !hasJokers && canCalculate && hand.length > 0 && outcome !== null && !outcome.overflowed && outcome.results.length === 0;
  const discardEfficiency = useMemo(
    () => (notTenpaiCheckpoint ? analyzeDiscardEfficiency(hand, meldsForSize(hand.length)) : null),
    [notTenpaiCheckpoint, hand]
  );
  const atCompleteCheckpoint = isCompleteCheckpointSize(hand.length);
  const discardChoices = useMemo(
    () =>
      !hasJokers && atCompleteCheckpoint ? analyzeDiscardChoices(hand, meldsForCompleteSize(hand.length)) : null,
    [hasJokers, atCompleteCheckpoint, hand]
  );
  const nonJokerHand = useMemo(() => hand.filter((t) => t.suit !== "j"), [hand]);
  const remainingCounts = useMemo(() => {
    if (outcome === null || outcome.overflowed) return null;
    const byKey = new Map<string, number>();
    for (const r of outcome.results) byKey.set(tileLabel(r.wait), 4 - tileCount(nonJokerHand, r.wait));
    return byKey;
  }, [outcome, nonJokerHand]);
  const totalRemaining = useMemo(
    () => (remainingCounts ? Array.from(remainingCounts.values()).reduce((a, b) => a + b, 0) : null),
    [remainingCounts]
  );

  return (
    <div className="page">
      <h1>Mahjong Waits Calculator</h1>

      <section className="panel">
        <div className="tile-picker">
          {SUIT_ORDER.map((suit) => (
            <div className="suit-row" key={suit}>
              {allTileKinds()
                .filter((t) => t.suit === suit)
                .map((t) => (
                  <TileButton
                    key={tileLabel(t)}
                    tile={t}
                    onClick={() => addTile(t)}
                    disabled={hand.length >= COMPLETE_SIZE || tileCount(hand, t) >= 4}
                  />
                ))}
            </div>
          ))}
          <div className="suit-row">
            <TileButton tile={JOKER_TILE} onClick={() => addTile(JOKER_TILE)} disabled={hand.length >= COMPLETE_SIZE} />
          </div>
        </div>

        <div className="algebraic-input">
          <label htmlFor="algebraic">Algebraic notation</label>
          <input
            id="algebraic"
            type="text"
            value={text}
            onChange={(e) => onTextChange(e.target.value)}
            placeholder="e.g. 111222333444m11t22s"
            spellCheck={false}
          />
          {error && <span className="error">{error}</span>}
        </div>

        <div className="panel-header">
          <span className="panel-title">Hand</span>
          <button
            type="button"
            className={sortMode ? "toggle-on" : undefined}
            onClick={toggleSortMode}
            aria-pressed={sortMode}
            title={sortMode ? "Sort: on — new tiles are kept in order" : "Sort: off — new tiles keep input order"}
          >
            Sort: {sortMode ? "On" : "Off"}
          </button>
          <button type="button" onClick={handleReset} disabled={hand.length === 0}>
            Reset
          </button>
          <button
            type="button"
            className={breakdownMode !== "off" ? "toggle-on" : undefined}
            onClick={() =>
              setBreakdownMode((m) => BREAKDOWN_CYCLE[(BREAKDOWN_CYCLE.indexOf(m) + 1) % BREAKDOWN_CYCLE.length])
            }
            aria-pressed={breakdownMode !== "off"}
            title={BREAKDOWN_TITLE[breakdownMode]}
          >
            Breakdown: {BREAKDOWN_LABEL[breakdownMode]}
          </button>
          <span className="tile-count">
            {hand.length} / {COMPLETE_SIZE} tiles
          </span>
          {shantenValue !== null && (
            <span
              className="shanten-badge"
              title="Shanten: minimum discard+draw exchanges from tenpai. Covers the standard shape, Eight Pairs, and Sixteen Unrelated Tiles; doesn't yet account for jokers or Thirteen Orphans."
            >
              Shanten {shantenValue}
            </span>
          )}
        </div>

        <div className="hand-display">
          {hand.length === 0 && <span className="hint">Click tiles above, or type algebraic notation.</span>}
          {displayHand.map((t) => (
            <HandTileButton key={t.id} tile={t} onClick={() => removeTile(t.id)} />
          ))}
        </div>

        {outcome !== null && outcome.overflowed && (
          <div className="waits">
            <span className="waits-label">
              Too many joker possibilities to calculate exactly (~{outcome.estimatedCombinations.toLocaleString()}{" "}
              combinations). Try fewer jokers.
            </span>
          </div>
        )}
        {outcome !== null && !outcome.overflowed && outcome.results.length > 0 && (
          <div className={breakdownMode !== "off" ? "waits breakdown-list" : "waits"}>
            {outcome.results.length === allTileKinds().length && (
              <span className="waits-label universal-wait">Universal wait — any tile completes this hand.</span>
            )}
            <span className="waits-label">
              Waiting for:
              {totalRemaining !== null && ` (${totalRemaining} tile${totalRemaining === 1 ? "" : "s"} total)`}
            </span>
            {breakdownMode !== "off" ? (
              outcome.results.map((r) => (
                <WaitBreakdownRow
                  key={tileLabel(r.wait)}
                  result={r}
                  nonJokerHand={nonJokerHand}
                  meldsRequired={meldsForSize(hand.length)}
                  sorted={breakdownMode === "sorted"}
                  remainingCount={remainingCounts?.get(tileLabel(r.wait)) ?? null}
                />
              ))
            ) : (
              outcome.results.map((r) => (
                <WaitResultTile
                  key={tileLabel(r.wait)}
                  result={r}
                  remainingCount={remainingCounts?.get(tileLabel(r.wait)) ?? null}
                />
              ))
            )}
          </div>
        )}
        {outcome !== null && !outcome.overflowed && outcome.results.length === 0 && !notTenpaiCheckpoint && (
          <div className="waits">
            <span className="waits-label">
              Not tenpai — no winning tile completes this hand{hasJokers ? ", even trying every joker possibility" : ""}.
            </span>
            {hasJokers && <span className="hint">Discard analysis isn't available yet for hands with jokers.</span>}
          </div>
        )}
        {discardEfficiency !== null && (
          <div className="waits discard-analysis">
            <span className="waits-label">Not tenpai — discard options, ranked by efficiency:</span>
            {discardEfficiency.map((o) => (
              <DiscardEfficiencyRow key={tileLabel(o.discard)} option={o} />
            ))}
          </div>
        )}
        {atCompleteCheckpoint && hasJokers && (
          <div className="waits">
            <span className="waits-label">Discard analysis isn't available yet for hands with jokers.</span>
          </div>
        )}
        {discardChoices !== null && discardChoices.alreadyComplete && (
          <div className={breakdownMode !== "off" ? "waits breakdown-list" : "waits"}>
            <span className="waits-label universal-wait">You already have a winning hand!</span>
            {breakdownMode !== "off" && (
              <CompleteHandBreakdown
                hand={nonJokerHand}
                meldsRequired={meldsForCompleteSize(hand.length)}
                sorted={breakdownMode === "sorted"}
              />
            )}
          </div>
        )}
        {discardChoices !== null && !discardChoices.alreadyComplete && (
          <div className="waits discard-analysis">
            <span className="waits-label">Discard options:</span>
            {discardChoices.choices.map((c) => (
              <DiscardChoiceRow key={tileLabel(c.discard)} choice={c} />
            ))}
          </div>
        )}
        {outcome === null && !atCompleteCheckpoint && hand.length > 0 && upcoming !== undefined && (
          <div className="waits">
            <span className="hint">
              Add {upcoming - hand.length} more tile{upcoming - hand.length === 1 ? "" : "s"} to see waits or discard
              options.
            </span>
          </div>
        )}
      </section>
    </div>
  );
}

export default App;
