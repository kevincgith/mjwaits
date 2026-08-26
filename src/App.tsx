import {
  forwardRef,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import "./App.css";
import {
  COMPLETE_SIZE,
  ParseError,
  allTileKinds,
  analyzeDiscardChoices,
  analyzeDiscardEfficiency,
  decomposeEightPairs,
  decomposeHand,
  decomposeSixteenUnrelated,
  decomposeThirteenOrphans,
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
  tileKey,
  tileLabel,
} from "./lib/mahjong";
import type { DiscardChoice, DiscardEfficiency, JokerWaitResult, Suit, Tile } from "./lib/mahjong";
import {
  MAX_TRAINER_LEVEL,
  MIN_TRAINER_LEVEL,
  generateTrainerQuestion,
  trainerHandSize,
  type TrainerQuestion,
} from "./lib/trainer";
import { classToBonusTile, IMG_SIZE, detectTiles, letterbox, prefetchModel, type ScanProgress } from "./lib/vision";
import {
  groupDeclaredTiles,
  ScoringError,
  scoreParsedHand,
  type BonusTile,
  type GameContext,
  type MeldKind,
  type ParsedScoringHand,
  type ResolvedHand,
  type ScoreResult,
  type Wind,
} from "./lib/scoring";

// A stable id per tile instance, so sorting for display never loses track
// of which underlying tile is which (needed to revert Sort cleanly, and to
// remove the right instance when several tiles share a suit/rank).
interface HandTile extends Tile {
  id: number;
}

const JOKER_TILE: Tile = { suit: "j", rank: 1 };
const SUIT_ORDER: Suit[] = ["m", "t", "b", "z"];
// Both kinds of checkpoint interleaved: 3n+1 (waits/shanten/discard-analysis
// sizes) and 3n+2 (one tile past that - already-complete/discard-choice
// sizes). Sizes of the form 3n are never a checkpoint (mid-meld).
const CHECKPOINTS = [1, 2, 4, 5, 7, 8, 10, 11, 13, 14, 16, 17];

type BreakdownMode = "off" | "on" | "sorted";
type BreakdownOrder = "on" | "sorted";
const BREAKDOWN_ORDER_TITLE: Record<BreakdownOrder, string> = {
  on: "Order: pair first — tap to switch to tile order",
  sorted: "Order: tile order — tap to switch to pair first",
};

function nextCheckpoint(size: number): number | undefined {
  return CHECKPOINTS.find((c) => c > size);
}

function formatMB(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}

function loadImageFile(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Could not read that image"));
    };
    img.src = url;
  });
}

// A detection as shown in the scan review step - same shape as vision.ts's
// Detection, plus a stable id (so React can track a box across re-renders
// as it gets corrected or removed) and confidence carried through for the
// correction panel's header. `tile`/`bonus` are the *current* identity
// (what's actually counted toward the hand) and are mutually exclusive -
// at most one is non-null, both null means "not a tile" (excluded).
// `originalClassName` never changes - it's the model's raw guess, kept for
// display even after a correction.
interface ReviewDetection {
  id: number;
  tile: Tile | null;
  bonus: BonusTile | null;
  originalClassName: string;
  confidence: number;
  box: [number, number, number, number];
}

// One cropped region's scan review state. `imageUrl` and each detection's
// `box` are both already cropped down to just the user's selected region
// (see runScan) - letterbox() pads that region out to a square for the
// model, but showing that padding in the review UI just wastes space, so
// it's cropped back off before anything reaches state. `imageWidth`/
// `imageHeight` (the cropped canvas's own pixel size) size DetectionOverlay's
// viewBox so the boxes still line up with the image at any display size.
interface ScanReviewRegion {
  imageUrl: string;
  imageWidth: number;
  imageHeight: number;
  detections: ReviewDetection[];
}

const sameTile = (a: Tile | null, b: Tile): boolean => a !== null && a.suit === b.suit && a.rank === b.rank;
const sameBonusTile = (a: BonusTile | null, b: BonusTile): boolean => a !== null && a.kind === b.kind && a.rank === b.rank;

// Formats a tile the same way the model's class names do (rank then suit
// letter, e.g. "4t", "4b", "1z") so a corrected box's label stays visually
// consistent with an uncorrected one's raw class name.
function tileClassLabel(t: Tile): string {
  return `${t.rank}${t.suit}`;
}
// Same idea as tileClassLabel, for the "f"/"s" bonus classes (see
// classToBonusTile in vision.ts).
function bonusClassLabel(b: BonusTile): string {
  return `${b.rank}${b.kind === "flower" ? "f" : "s"}`;
}

// All 8 bonus tile kinds (4 flowers then 4 seasons), for the correction
// picker's bonus row - mirrors the Bonus tiles picker in ScoringPanel.
const CORRECTION_BONUS_TILES: BonusTile[] = [
  ...([1, 2, 3, 4] as const).map((rank) => ({ kind: "flower" as const, rank })),
  ...([1, 2, 3, 4] as const).map((rank) => ({ kind: "season" as const, rank })),
];

// Groups the 34 real tile kinds into suit rows for the correction picker,
// promoting the row matching the detection's original guess to the front -
// misclassifications are almost always a same-suit mix-up (e.g. 4t called
// 5t). Every row, including the promoted one, stays in plain ascending
// rank order so the picker reads like the familiar 123456789 layout; the
// model's actual guess is highlighted via `selected` instead of moved to
// the front. A detection that was originally a bonus tile (no suit to
// anchor on) just gets the standard suit order with no promoted row.
function rankedCorrectionRows(original: Tile | null): { suit: Suit; tiles: Tile[] }[] {
  const bySuit = (suit: Suit) => allTileKinds().filter((t) => t.suit === suit);
  const suitsInOrder = original ? [original.suit, ...SUIT_ORDER.filter((s) => s !== original.suit)] : SUIT_ORDER;
  return suitsInOrder.map((suit) => ({ suit, tiles: bySuit(suit) }));
}

// One detected tile's bounding box, rendered as an interactive SVG group in
// the same pixel coordinate space as the (letterbox-padding-cropped) review
// image (see the viewBox on DetectionOverlay's <svg>), so it lines up with
// the image
// beneath it regardless of how large that image is actually displayed.
// Tapping it opens the correction picker for that detection. A separate,
// wider invisible rect beneath the visible outline pads out the tap target
// for boxes that are small relative to a touchscreen fingertip.
function DetectionBox({
  detection,
  editing,
  onSelect,
}: {
  detection: ReviewDetection;
  editing: boolean;
  onSelect: () => void;
}) {
  const tap = useTap(onSelect);
  const [x1, y1, x2, y2] = detection.box;
  const included = detection.tile !== null;
  const label = detection.tile
    ? tileClassLabel(detection.tile)
    : detection.bonus
      ? bonusClassLabel(detection.bonus)
      : detection.originalClassName;
  const labelWidth = label.length * 7.5 + 6;
  const groupClass = ["detection-box", included ? "included" : "bonus", editing && "editing"].filter(Boolean).join(" ");
  return (
    <g className={groupClass} role="button" tabIndex={0} aria-label={`Correct detected tile ${label}`} {...tap}>
      <rect className="detection-hit" x={x1 - 6} y={y1 - 6} width={x2 - x1 + 12} height={y2 - y1 + 12} />
      <rect className="detection-outline" x={x1} y={y1} width={x2 - x1} height={y2 - y1} />
      <rect className="detection-label-bg" x={x1} y={y1} width={labelWidth} height={16} />
      <text className="detection-label" x={x1 + 3} y={y1 + 15}>
        {label}
      </text>
    </g>
  );
}

function DetectionOverlay({
  detections,
  editingId,
  onSelect,
  imageWidth,
  imageHeight,
}: {
  detections: ReviewDetection[];
  editingId: number | null;
  onSelect: (id: number) => void;
  imageWidth: number;
  imageHeight: number;
}) {
  return (
    <svg className="scan-review-boxes" viewBox={`0 0 ${imageWidth} ${imageHeight}`} preserveAspectRatio="none">
      {detections.map((d) => (
        <DetectionBox key={d.id} detection={d} editing={d.id === editingId} onSelect={() => onSelect(d.id)} />
      ))}
    </svg>
  );
}

// The picker shown when a detected tile's box is tapped: lets the user
// replace the model's guess with the right tile, mark it as not a real
// tile (bonus tiles are already excluded from the hand, but the model
// sometimes calls a real tile a bonus one or vice versa), or remove the
// box outright for an outright false-positive detection.
// A correction picked in the panel below: a real tile, a specific bonus
// tile, or null ("not a tile" - an outright false positive).
type Correction = { tile: Tile } | { bonus: BonusTile } | null;

function CorrectionPanel({
  detection,
  onPick,
  onRemove,
  onCancel,
}: {
  detection: ReviewDetection;
  onPick: (correction: Correction) => void;
  onRemove: () => void;
  onCancel: () => void;
}) {
  const rows = useMemo(() => rankedCorrectionRows(detection.tile), [detection.tile]);
  const hasPromotedRow = detection.tile !== null;
  const bonusPromoted = detection.bonus !== null;
  const bonusRow = (
    <div className={`suit-row ${bonusPromoted ? "correction-row-primary" : ""}`}>
      {CORRECTION_BONUS_TILES.map((b) => (
        <BonusTileButton
          key={`${b.kind}${b.rank}`}
          tile={b}
          onClick={() => onPick({ bonus: b })}
          selected={sameBonusTile(detection.bonus, b)}
        />
      ))}
    </div>
  );
  return (
    <div className="correction-panel">
      <div className="correction-panel-header">
        <span>
          Model guessed <strong>{detection.originalClassName}</strong> ({Math.round(detection.confidence * 100)}%) - tap
          the right tile:
        </span>
        <button type="button" className="correction-panel-close" onClick={onCancel} aria-label="Cancel correction">
          ✕
        </button>
      </div>
      <div className="tile-picker correction-picker">
        {bonusPromoted && bonusRow}
        {rows.map(({ suit, tiles }, i) => (
          <div key={suit}>
            {hasPromotedRow && i === 1 && <div className="correction-other-label">Other suits</div>}
            <div className={`suit-row ${hasPromotedRow && i === 0 ? "correction-row-primary" : ""}`}>
              {tiles.map((t) => (
                <TileButton
                  key={tileLabel(t)}
                  tile={t}
                  onClick={() => onPick({ tile: t })}
                  selected={sameTile(detection.tile, t)}
                />
              ))}
            </div>
          </div>
        ))}
        {!bonusPromoted && (
          <div>
            <div className="correction-other-label">Bonus tiles</div>
            {bonusRow}
          </div>
        )}
      </div>
      <div className="correction-panel-actions">
        <button type="button" onClick={() => onPick(null)}>
          Not a tile
        </button>
        <button type="button" className="correction-panel-remove" onClick={onRemove}>
          Remove box
        </button>
      </div>
    </div>
  );
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

const LONG_PRESS_MS = 500;

// Same touch/mouse handling as useTap above, plus a timer-based long-press:
// if the pointer stays down past LONG_PRESS_MS without moving, onLongPress
// fires instead of onTap. Used by ScoringPanel's concealed-hand tiles,
// where a plain tap already means "remove this tile" (see HandTileButton) -
// long-press is the only gesture left for "mark as the 食胡 tile" without
// colliding with that.
function useTapAndLongPress(onTap: () => void, onLongPress: () => void, disabled?: boolean) {
  const startRef = useRef<{ x: number; y: number } | null>(null);
  const longPressFired = useRef(false);
  const timerRef = useRef<number | null>(null);

  const clearTimer = () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  const onPointerDown = (e: ReactPointerEvent) => {
    if (disabled) return;
    startRef.current = { x: e.clientX, y: e.clientY };
    longPressFired.current = false;
    if (e.pointerType !== "mouse") e.preventDefault();
    clearTimer();
    timerRef.current = window.setTimeout(() => {
      longPressFired.current = true;
      onLongPress();
    }, LONG_PRESS_MS);
  };

  const onPointerUp = (e: ReactPointerEvent) => {
    clearTimer();
    if (disabled || e.pointerType === "mouse") return;
    const start = startRef.current;
    startRef.current = null;
    if (longPressFired.current) return; // already handled as a long-press
    if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 10) return; // a drag/scroll, not a tap
    lastTouchTapAt = performance.now();
    onTap();
  };

  const onPointerCancel = () => {
    clearTimer();
    startRef.current = null;
  };

  const onClick = () => {
    if (disabled) return;
    if (longPressFired.current) {
      longPressFired.current = false;
      return;
    }
    onTap();
  };

  return { onPointerDown, onPointerUp, onPointerCancel, onClick };
}

function TileGlyphSpan({
  tile,
  large,
  highlight,
  jokerAssumed,
}: {
  tile: Tile;
  large?: boolean;
  highlight?: boolean;
  jokerAssumed?: boolean;
}) {
  const classes = ["tile-glyph", large && "large", highlight && "wait-highlight", jokerAssumed && "joker-assumed"]
    .filter(Boolean)
    .join(" ");
  return (
    <span className={classes} data-suit={tile.suit} data-rank={tile.rank} title={jokerAssumed ? "Assumed from a joker" : undefined}>
      {tileGlyph(tile)}
    </span>
  );
}

function TileButton({
  tile,
  onClick,
  disabled,
  selected,
  extraClass,
  title,
}: {
  tile: Tile;
  onClick: () => void;
  disabled?: boolean;
  selected?: boolean;
  extraClass?: string;
  title?: string;
}) {
  const tap = useTap(onClick, disabled);
  const classes = ["tile-button", selected && "selected", extraClass].filter(Boolean).join(" ");
  return (
    <button type="button" className={classes} disabled={disabled} title={title ?? tileLabel(tile)} {...tap}>
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

// Scoring tab's concealed-hand tile: tap still removes it (same as
// HandTileButton), long-press toggles it as the 食胡 tile (the tile that
// completed the hand) - highlighted the same amber as a wait's completing
// tile elsewhere in the app, since it's the same idea.
function WinningTileHandButton({
  tile,
  isWinning,
  onRemove,
  onToggleWinning,
}: {
  tile: Tile;
  isWinning: boolean;
  onRemove: () => void;
  onToggleWinning: () => void;
}) {
  const tap = useTapAndLongPress(onRemove, onToggleWinning);
  const title = isWinning
    ? `${tileLabel(tile)} - 食胡 tile (tap to remove, long-press to unmark)`
    : `${tileLabel(tile)} - tap to remove, long-press to mark as the 食胡 tile`;
  return (
    <button type="button" className="hand-tile-button" title={title} {...tap}>
      <TileGlyphSpan tile={tile} large highlight={isWinning} />
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

interface BreakdownGroup {
  tiles: Tile[];
  key: string;
}

interface BreakdownReading {
  // Only meaningful (and only shown) when a hand decomposes more than one
  // way - e.g. 112233m112233b11222z is simultaneously a standard hand
  // (123m123m123b123b + 222z/11z) and Eight Pairs. Most hands only match
  // one shape and get a single, unlabeled reading.
  label: string;
  groups: BreakdownGroup[];
}

// Every way `hand` can be read as a complete hand: the standard melds+pair
// shape, plus any of the three special hands it also happens to satisfy.
// Usually exactly one of these applies, but a hand can genuinely be
// ambiguous (see BreakdownReading), in which case every valid reading is
// returned so the UI can show all of them instead of silently picking one.
function allBreakdownReadings(hand: Tile[], meldsRequired: number): BreakdownReading[] {
  const readings: BreakdownReading[] = [];

  const standard = decomposeHand(hand, meldsRequired);
  if (standard) {
    readings.push({
      label: "Standard hand",
      groups: [
        { tiles: standard.pair, key: "pair" },
        ...standard.melds.map((tiles, i) => ({ tiles, key: `meld-${i}` })),
      ],
    });
  }

  const orphans = decomposeThirteenOrphans(hand);
  if (orphans) {
    readings.push({
      label: "Thirteen Orphans",
      groups: [
        { tiles: orphans.pair, key: "pair" },
        { tiles: orphans.singles, key: "singles" },
        { tiles: orphans.meld, key: "meld" },
      ],
    });
  }

  const eightPairs = decomposeEightPairs(hand);
  if (eightPairs) {
    readings.push({
      label: "Eight Pairs (Liguligu)",
      groups: [
        { tiles: eightPairs.triple, key: "triple" },
        ...eightPairs.pairs.map((tiles, i) => ({ tiles, key: `pair-${i}` })),
      ],
    });
  }

  const sixteenUnrelated = decomposeSixteenUnrelated(hand);
  if (sixteenUnrelated) {
    readings.push({
      label: "Sixteen Unrelated Tiles",
      groups: [
        { tiles: sixteenUnrelated.pair, key: "pair" },
        { tiles: sixteenUnrelated.singles, key: "singles" },
      ],
    });
  }

  return readings;
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
  const readings = allBreakdownReadings(complete, meldsRequired);

  if (readings.length === 0) {
    // Shouldn't happen for any hand that reaches this component with a wait
    // - fall back to the plain wait display just in case.
    return (
      <div className="breakdown-row">
        <WaitResultTile result={result} remainingCount={remainingCount} />
      </div>
    );
  }

  const renderReading = (reading: BreakdownReading) => {
    let waitPlaced = false;
    // Jokers resolve to concrete tiles before decomposeHand ever sees them
    // (see `complete` above), so by the time we have breakdown groups
    // there's no per-tile record of "this one came from a joker" - just
    // counts. Rebuild that by kind: each joker used up one occurrence of
    // its resolved kind, so walking the groups in the same fixed order and
    // consuming one occurrence per joker (after the wait tile claims its
    // own occurrence first) lands on the same tiles a joker search would
    // have used, which is all display needs.
    const jokerBudget = new Map<string, number>();
    for (const j of result.jokers) jokerBudget.set(tileKey(j), (jokerBudget.get(tileKey(j)) ?? 0) + 1);

    const ordered = orderBreakdownGroups(reading.groups, sorted);
    return (
      <span className="breakdown-reading" key={reading.label}>
        <span className="discard-arrow">→</span>
        {readings.length > 1 && <span className="reading-label">{reading.label}</span>}
        <span className="breakdown-groups">
          {ordered.map(({ tiles, key }) => (
            <span className="breakdown-group" key={key}>
              {tiles.map((t, i) => {
                const isWait = !waitPlaced && t.suit === result.wait.suit && t.rank === result.wait.rank;
                if (isWait) waitPlaced = true;
                let isJoker = false;
                if (!isWait) {
                  const tk = tileKey(t);
                  const budget = jokerBudget.get(tk) ?? 0;
                  if (budget > 0) {
                    isJoker = true;
                    jokerBudget.set(tk, budget - 1);
                  }
                }
                return <TileGlyphSpan key={i} tile={t} large highlight={isWait} jokerAssumed={isJoker} />;
              })}
            </span>
          ))}
        </span>
      </span>
    );
  };

  return (
    <div className="breakdown-row">
      <TileGlyphSpan tile={result.wait} large />
      {remainingCount !== null && <RemainingCountBadge count={remainingCount} />}
      <span className="breakdown-readings">{readings.map(renderReading)}</span>
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
  const readings = allBreakdownReadings(hand, meldsRequired);
  if (readings.length === 0) return null;

  return (
    <span className="breakdown-readings">
      {readings.map((reading) => (
        <span className="breakdown-reading" key={reading.label}>
          {readings.length > 1 && <span className="reading-label">{reading.label}</span>}
          <span className="breakdown-groups">
            {orderBreakdownGroups(reading.groups, sorted).map(({ tiles, key }) => (
              <span className="breakdown-group" key={key}>
                {tiles.map((t, i) => (
                  <TileGlyphSpan key={i} tile={t} large />
                ))}
              </span>
            ))}
          </span>
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

// Crop rect in fractions of the source image (0-1), top-left origin. Kept
// in fractions rather than pixels so it's independent of how big the image
// is displayed at vs. its natural resolution.
interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// A hand's tiles are laid out in a row, so a wide, short box centered in
// the frame is a closer starting point than the full image - the user
// mostly needs to nudge/resize it rather than shrink it down from
// scratch. Used both for the lone first region and, offset, for a second.
const REGION_W = 0.6;
const REGION_H = 0.22;
const DEFAULT_CROP: CropRect = { x: (1 - REGION_W) / 2, y: (1 - REGION_H) / 2, w: REGION_W, h: REGION_H };
const MAX_REGIONS = 2;
const MIN_CROP_FRACTION = 0.1;
const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
const rectsOverlap = (a: CropRect, b: CropRect): boolean =>
  a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
const fitsInFrame = (r: CropRect): boolean => r.x >= 0 && r.y >= 0 && r.x + r.w <= 1 && r.y + r.h <= 1;

// Picks a spot for a new w x h region that doesn't overlap `existing` -
// tried directly below, above, right of, then left of it (in that order),
// each centered on `existing` along the other axis. Falls back to the
// bottom-right corner (accepting overlap) only if `existing` leaves no
// clean gap on any side, e.g. because it's been resized to fill the frame.
function nonOverlappingRegion(existing: CropRect, w: number, h: number): CropRect {
  const gap = 0.03;
  const cx = clamp(existing.x + existing.w / 2 - w / 2, 0, 1 - w);
  const cy = clamp(existing.y + existing.h / 2 - h / 2, 0, 1 - h);
  const candidates: CropRect[] = [
    { x: cx, y: existing.y + existing.h + gap, w, h },
    { x: cx, y: existing.y - gap - h, w, h },
    { x: existing.x + existing.w + gap, y: cy, w, h },
    { x: existing.x - gap - w, y: cy, w, h },
  ];
  const clear = candidates.find((c) => fitsInFrame(c) && !rectsOverlap(existing, c));
  if (clear) return clear;
  return { x: clamp(1 - w - 0.02, 0, 1 - w), y: clamp(1 - h - 0.02, 0, 1 - h), w, h };
}

type CropDragMode = "move" | "nw" | "ne" | "sw" | "se";

// Applies a pointer delta (in container-fraction units) to `start`, per
// drag mode. Corner modes keep the opposite edge fixed and clamp so the
// rect never leaves [0,1] or shrinks below MIN_CROP_FRACTION; move slides
// the whole rect without resizing it.
function applyCropDrag(mode: CropDragMode, start: CropRect, dx: number, dy: number): CropRect {
  if (mode === "move") {
    return {
      x: clamp(start.x + dx, 0, 1 - start.w),
      y: clamp(start.y + dy, 0, 1 - start.h),
      w: start.w,
      h: start.h,
    };
  }
  let { x, y, w, h } = start;
  if (mode === "nw" || mode === "sw") {
    const right = start.x + start.w;
    x = clamp(start.x + dx, 0, right - MIN_CROP_FRACTION);
    w = right - x;
  } else {
    w = clamp(start.w + dx, MIN_CROP_FRACTION, 1 - start.x);
  }
  if (mode === "nw" || mode === "ne") {
    const bottom = start.y + start.h;
    y = clamp(start.y + dy, 0, bottom - MIN_CROP_FRACTION);
    h = bottom - y;
  } else {
    h = clamp(start.h + dy, MIN_CROP_FRACTION, 1 - start.y);
  }
  return { x, y, w, h };
}

// Draws the selected fraction of `image` onto a new canvas at native
// resolution - the crop is applied before letterboxing, so anything
// outside it never reaches the detector.
function cropToCanvas(image: HTMLImageElement, rect: CropRect): HTMLCanvasElement {
  const sx = rect.x * image.naturalWidth;
  const sy = rect.y * image.naturalHeight;
  const sw = rect.w * image.naturalWidth;
  const sh = rect.h * image.naturalHeight;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(sw));
  canvas.height = Math.max(1, Math.round(sh));
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(image, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  return canvas;
}

// Redraws `source` rotated a quarter turn clockwise onto a canvas (swapping
// width/height, since a photo shot sideways needs that swap to display
// upright) and loads the result back into a fresh <img> - phone cameras
// don't always agree with the browser on which way is up, and unlike a CSS
// transform, baking the rotation into real pixels means every downstream
// consumer (crop math, the detector) just sees an already-upright image
// and needs no rotation-awareness of its own.
function rotateImageCW(source: HTMLImageElement): Promise<HTMLImageElement> {
  const w = source.naturalWidth;
  const h = source.naturalHeight;
  const canvas = document.createElement("canvas");
  canvas.width = h;
  canvas.height = w;
  const ctx = canvas.getContext("2d")!;
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate(Math.PI / 2);
  ctx.drawImage(source, -w / 2, -h / 2);
  return new Promise((resolve, reject) => {
    const rotated = new Image();
    rotated.onload = () => resolve(rotated);
    rotated.onerror = () => reject(new Error("Could not rotate image"));
    rotated.src = canvas.toDataURL();
  });
}

const CROP_HANDLES: CropDragMode[] = ["nw", "ne", "sw", "se"];

// Lets the user crop down to just the hand (or two, if a single photo has
// two separate hands laid out in it - e.g. two players' hands shot
// together) before it's sent to the detector. Each region gets cropped,
// letterboxed, and detected independently, then the results are merged -
// see runScan. `image` is the already-loaded element from loadImageFile;
// it's inserted into the DOM directly (rather than re-rendered via a new
// <img src>) since its object URL was already revoked once it loaded.
function CropOverlay({
  image,
  regionLabels,
  onConfirm,
  onCancel,
}: {
  image: HTMLImageElement;
  // Badge text for each crop box once a 2nd region is added, e.g. ["Concealed",
  // "Declared"] on the scoring tab where the two regions mean different things -
  // falls back to plain 1-based numbers (the Calculator's case, where both
  // regions are just different crops of the same hand).
  regionLabels?: string[];
  onConfirm: (canvases: HTMLCanvasElement[]) => void;
  onCancel: () => void;
}) {
  const [regions, setRegions] = useState<CropRect[]>([DEFAULT_CROP]);
  // The image actually shown/measured/cropped - starts as the `image` prop
  // but is swapped out (via rotateImageCW) whenever the user rotates, never
  // mutating the prop itself. Rotating changes the aspect ratio for a
  // quarter or three-quarter turn, so any regions drawn against the old
  // orientation would land on the wrong area - see handleRotate.
  const [displayImage, setDisplayImage] = useState(image);
  const [rotating, setRotating] = useState(false);
  const stageRef = useRef<HTMLDivElement>(null);
  const maskId = useId();
  const dragRef = useRef<{
    index: number;
    mode: CropDragMode;
    startX: number;
    startY: number;
    startRect: CropRect;
    w: number;
    h: number;
  } | null>(null);

  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    displayImage.className = "crop-image";
    displayImage.draggable = false;
    displayImage.alt = "Photo to crop before scanning";
    stage.insertBefore(displayImage, stage.firstChild);
    return () => {
      if (displayImage.parentElement === stage) stage.removeChild(displayImage);
    };
  }, [displayImage]);

  const handleRotate = async () => {
    setRotating(true);
    try {
      setDisplayImage(await rotateImageCW(displayImage));
      setRegions([DEFAULT_CROP]);
    } finally {
      setRotating(false);
    }
  };

  const beginDrag = (index: number, mode: CropDragMode) => (e: ReactPointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const bounds = stageRef.current?.getBoundingClientRect();
    if (!bounds) return;
    dragRef.current = { index, mode, startX: e.clientX, startY: e.clientY, startRect: regions[index], w: bounds.width, h: bounds.height };
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  };

  const onDragMove = (e: ReactPointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    const dx = (e.clientX - drag.startX) / drag.w;
    const dy = (e.clientY - drag.startY) / drag.h;
    const nextRect = applyCropDrag(drag.mode, drag.startRect, dx, dy);
    setRegions((prev) => prev.map((r, i) => (i === drag.index ? nextRect : r)));
  };

  const endDrag = () => {
    dragRef.current = null;
  };

  const addRegion = () =>
    setRegions((prev) => (prev.length >= MAX_REGIONS ? prev : [...prev, nonOverlappingRegion(prev[0], REGION_W, REGION_H)]));
  const removeRegion = (index: number) => setRegions((prev) => prev.filter((_, i) => i !== index));
  const resetRegions = () => setRegions([DEFAULT_CROP]);

  return (
    <div className="crop-overlay">
      <span className="hint">
        {regions.length > 1
          ? regionLabels
            ? `Drag each box to cover the ${regionLabels.join(" and ")} tiles, then tap Scan.`
            : "Drag each box to cover one hand, then tap Scan."
          : "Drag to crop out anything that isn't the hand, then tap Scan."}
      </span>
      <div className="crop-actions">
        <div className="crop-actions-left">
          <button type="button" onClick={handleRotate} disabled={rotating} title="Rotate photo 90°">
            ⟳ Rotate
          </button>
          {regions.length < MAX_REGIONS && (
            <button type="button" onClick={addRegion}>
              + Add region
            </button>
          )}
          <button type="button" onClick={resetRegions} disabled={regions.length === 1 && regions[0] === DEFAULT_CROP}>
            Reset
          </button>
        </div>
      </div>
      <div className="crop-stage" ref={stageRef}>
        <svg className="crop-dim" preserveAspectRatio="none">
          <mask id={maskId}>
            <rect x="0" y="0" width="100%" height="100%" fill="#fff" />
            {regions.map((r, i) => (
              <rect key={i} x={`${r.x * 100}%`} y={`${r.y * 100}%`} width={`${r.w * 100}%`} height={`${r.h * 100}%`} fill="#000" />
            ))}
          </mask>
          <rect x="0" y="0" width="100%" height="100%" fill="rgba(0,0,0,0.55)" mask={`url(#${maskId})`} />
        </svg>
        {regions.map((rect, index) => (
          <div
            key={index}
            className={`crop-rect crop-rect-${index}`}
            style={{ left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.w * 100}%`, height: `${rect.h * 100}%` }}
            onPointerDown={beginDrag(index, "move")}
            onPointerMove={onDragMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
          >
            {(regions.length > 1 || regionLabels) && (
              <span className="crop-rect-label">{regionLabels ? regionLabels[index] : index + 1}</span>
            )}
            {regions.length > 1 && (
              <button
                type="button"
                className="crop-rect-remove"
                title={regionLabels ? `Remove ${regionLabels[index]}` : `Remove region ${index + 1}`}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => removeRegion(index)}
              >
                ×
              </button>
            )}
            {CROP_HANDLES.map((corner) => (
              <span
                key={corner}
                className={`crop-handle crop-handle-${corner}`}
                onPointerDown={beginDrag(index, corner)}
                onPointerMove={onDragMove}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
              />
            ))}
          </div>
        ))}
      </div>
      <div className="crop-actions">
        <div className="crop-actions-right">
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" onClick={() => onConfirm(regions.map((r) => cropToCanvas(displayImage, r)))}>
            Scan
          </button>
        </div>
      </div>
    </div>
  );
}

// The scan-a-photo flow shared by the Calculator (one hand, optionally split
// across up to 2 crops of the SAME pile - see CropOverlay's regionLabels doc
// comment) and the Scoring tab (2 crops of DIFFERENT piles - concealed hand
// vs declared melds). This component owns the camera/crop/detect/correct
// machinery only; it hands back each region's corrected detections untouched
// via onConfirm and lets the caller decide what they mean (flatten into one
// tile list, or split by region into concealed/declared/bonus - see
// applyScannedRegions in ScoringPanel for the latter).
// Imperative handle for callers that want their own trigger button placed
// elsewhere in the layout (see ScoringPanel) instead of HandScanner's own
// built-in one - `hideTrigger` suppresses the internal button while this
// still drives the same file-picker/prefetch flow.
export interface HandScannerHandle {
  trigger: () => void;
}

const HandScanner = forwardRef<
  HandScannerHandle,
  {
    regionLabels?: string[];
    // Optional per-region check run against a region's current (corrected)
    // detections - a non-null return is shown next to that region's summary.
    // `blocking: true` also disables the confirm button (used only when
    // there's truly nothing usable to fall back on); otherwise it's shown
    // as an advisory warning and confirming proceeds anyway, e.g.
    // ScoringPanel uses this to flag (but not block on) a Declared-region
    // scan that only partly grouped into whole melds.
    regionIssue?: (detections: ReviewDetection[], regionIndex: number) => { blocking: boolean; message: string } | null;
    onConfirm: (regions: { detections: ReviewDetection[] }[]) => void;
    // When set, the built-in trigger button isn't rendered - the caller
    // drives scanning via the imperative handle's trigger() instead
    // (still through this same file input/model-prefetch flow), and shows
    // its own button using onBusyChange to reflect scanStatus.
    hideTrigger?: boolean;
    triggerLabel?: string;
    // Fires whenever scanStatus moves in or out of "busy" (cropping or
    // loading), so an external trigger button (hideTrigger) can disable
    // itself for the same span the built-in one would have.
    onBusyChange?: (busy: boolean) => void;
  }
>(function HandScanner({ regionLabels, regionIssue, onConfirm, hideTrigger, triggerLabel = "📷 Scan a hand", onBusyChange }, ref) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [scanStatus, setScanStatus] = useState<"idle" | "cropping" | "loading" | "review" | "error">("idle");
  const [scanError, setScanError] = useState<string | null>(null);
  const [scanProgress, setScanProgress] = useState<ScanProgress | null>(null);
  const [scanPreview, setScanPreview] = useState<{ regions: ScanReviewRegion[] } | null>(null);
  const [editingDetectionId, setEditingDetectionId] = useState<number | null>(null);
  const nextDetectionId = useRef(0);
  const [cropImage, setCropImage] = useState<HTMLImageElement | null>(null);

  const triggerScan = () => {
    // Starts the (large) model download as soon as the user shows intent
    // to scan, rather than after they've picked and cropped a photo - by
    // the time runScan needs it, it's often already downloaded or well
    // underway.
    prefetchModel();
    fileInputRef.current?.click();
  };
  useImperativeHandle(ref, () => ({ trigger: triggerScan }));

  const busy = scanStatus === "cropping" || scanStatus === "loading";
  useEffect(() => {
    onBusyChange?.(busy);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy]);

  // Total real (non-bonus) tiles detected across every region, and the
  // per-region validation errors (if a validator was given) - recomputed
  // live as the user corrects or removes detections.
  const totalRealTiles = useMemo(
    () => (scanPreview ? scanPreview.regions.reduce((n, r) => n + r.detections.filter((d) => d.tile !== null).length, 0) : 0),
    [scanPreview]
  );
  const regionIssues = useMemo(
    () => (scanPreview && regionIssue ? scanPreview.regions.map((r, i) => regionIssue(r.detections, i)) : null),
    [scanPreview, regionIssue]
  );
  const hasBlockingError = regionIssues?.some((issue) => issue?.blocking) ?? false;
  const editingDetection = useMemo(() => {
    if (editingDetectionId === null || !scanPreview) return null;
    for (const region of scanPreview.regions) {
      const found = region.detections.find((d) => d.id === editingDetectionId);
      if (found) return found;
    }
    return null;
  }, [editingDetectionId, scanPreview]);

  // Applies `updater` to the single detection with matching id across
  // whichever region it lives in; a null return removes it (used by
  // "Remove box"), leaving the rest of the preview untouched.
  const updateDetection = (id: number, updater: (d: ReviewDetection) => ReviewDetection | null) => {
    setScanPreview((prev) =>
      prev
        ? {
            regions: prev.regions.map((region) => ({
              ...region,
              detections: region.detections.flatMap((d) => {
                if (d.id !== id) return [d];
                const next = updater(d);
                return next ? [next] : [];
              }),
            })),
          }
        : prev
    );
  };
  const correctDetection = (id: number, correction: Correction) => {
    updateDetection(id, (d) => ({
      ...d,
      tile: correction && "tile" in correction ? correction.tile : null,
      bonus: correction && "bonus" in correction ? correction.bonus : null,
    }));
    setEditingDetectionId(null);
  };
  const removeDetection = (id: number) => {
    updateDetection(id, () => null);
    setEditingDetectionId(null);
  };

  const handleScanFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting the same file next time
    if (!file) return;
    setScanError(null);
    try {
      const image = await loadImageFile(file);
      setCropImage(image);
      setScanStatus("cropping");
    } catch (err) {
      setScanError(err instanceof Error ? err.message : "Could not read that image");
      setScanStatus("error");
    }
  };

  // Each region (1 or 2, from CropOverlay) is letterboxed and detected
  // independently. The (cached) model session is only fetched/initialized
  // once regardless of region count.
  const runScan = async (sources: HTMLCanvasElement[]) => {
    setScanStatus("loading");
    setScanError(null);
    setScanProgress({ phase: "downloading-model", loaded: 0, total: null });
    try {
      const regions: ScanReviewRegion[] = [];
      for (const source of sources) {
        const box = letterbox(source);
        const { detections } = await detectTiles(box, setScanProgress);
        // letterbox() centers the (scaled-down) source inside an IMG_SIZE
        // square, padding the rest gray - the model needs that square, but
        // showing the padding in the review UI just wastes space. Crop the
        // padding back off here (same centering math letterbox itself
        // used, run in reverse) and shift each detection's box by the same
        // amount, so everything downstream (the <img>, DetectionOverlay's
        // viewBox, the left-to-right sort in ScoringPanel) just works
        // against the tighter, padding-free coordinate space.
        const scale = Math.min(IMG_SIZE / source.width, IMG_SIZE / source.height);
        const contentW = Math.round(source.width * scale);
        const contentH = Math.round(source.height * scale);
        const padX = (IMG_SIZE - contentW) / 2;
        const padY = (IMG_SIZE - contentH) / 2;
        const displayCanvas = document.createElement("canvas");
        displayCanvas.width = contentW;
        displayCanvas.height = contentH;
        displayCanvas.getContext("2d")!.drawImage(box.canvas, padX, padY, contentW, contentH, 0, 0, contentW, contentH);
        regions.push({
          imageUrl: displayCanvas.toDataURL(),
          imageWidth: contentW,
          imageHeight: contentH,
          detections: detections.map((d) => ({
            id: nextDetectionId.current++,
            tile: d.tile,
            bonus: d.tile ? null : classToBonusTile(d.className),
            originalClassName: d.className,
            confidence: d.confidence,
            box: [d.box[0] - padX, d.box[1] - padY, d.box[2] - padX, d.box[3] - padY],
          })),
        });
      }
      setScanPreview({ regions });
      setScanStatus("review");
    } catch (err) {
      setScanError(err instanceof Error ? err.message : "Could not scan that photo");
      setScanStatus("error");
    } finally {
      setScanProgress(null);
      setCropImage(null);
    }
  };

  const cancelCrop = () => {
    setCropImage(null);
    setScanStatus("idle");
  };

  const scanStatusLabel = (p: ScanProgress | null): string => {
    if (!p) return "Scanning…";
    if (p.phase === "downloading-model") return "Downloading model…";
    if (p.phase === "initializing") return "Preparing detector…";
    return "Detecting tiles…";
  };

  // Byte-level detail shown alongside the progress bar, e.g. "3.2 / 11.5 MB
  // (28%)" once the server has told us the total size, or just "3.2 MB
  // downloaded" before that (content-length is missing on some dev servers,
  // though GitHub Pages always sends it).
  const scanProgressDetail = (p: ScanProgress | null): string | null => {
    if (p?.phase !== "downloading-model") return null;
    if (p.total) {
      const pct = Math.round((p.loaded / p.total) * 100);
      return `${formatMB(p.loaded)} / ${formatMB(p.total)} MB (${pct}%)`;
    }
    return `${formatMB(p.loaded)} MB downloaded`;
  };

  const confirmScan = () => {
    if (!scanPreview) return;
    onConfirm(scanPreview.regions.map((r) => ({ detections: r.detections })));
    setScanStatus("idle");
    setScanPreview(null);
    setEditingDetectionId(null);
  };
  const cancelScan = () => {
    setScanStatus("idle");
    setScanPreview(null);
    setScanError(null);
    setEditingDetectionId(null);
  };

  return (
    <>
      <div className="scan-input">
        <input ref={fileInputRef} type="file" accept="image/*" onChange={handleScanFile} style={{ display: "none" }} />
        {!hideTrigger && (
          <button type="button" onClick={triggerScan} disabled={busy}>
            {scanStatus === "loading" ? scanStatusLabel(scanProgress) : triggerLabel}
          </button>
        )}
        {scanStatus === "loading" && (
          <div className="scan-progress">
            <div
              className="scan-progress-track"
              role="progressbar"
              aria-label={scanStatusLabel(scanProgress)}
              aria-valuenow={
                scanProgress?.phase === "downloading-model" && scanProgress.total
                  ? Math.round((scanProgress.loaded / scanProgress.total) * 100)
                  : undefined
              }
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <div
                className={
                  scanProgress?.phase === "downloading-model" && scanProgress.total
                    ? "scan-progress-fill"
                    : "scan-progress-fill indeterminate"
                }
                style={
                  scanProgress?.phase === "downloading-model" && scanProgress.total
                    ? { width: `${Math.round((scanProgress.loaded / scanProgress.total) * 100)}%` }
                    : undefined
                }
              />
            </div>
            {scanProgressDetail(scanProgress) && <span className="scan-progress-detail">{scanProgressDetail(scanProgress)}</span>}
          </div>
        )}
        {scanStatus === "error" && scanError && <span className="error">{scanError}</span>}
      </div>

      {scanStatus === "cropping" && cropImage && (
        <CropOverlay image={cropImage} regionLabels={regionLabels} onConfirm={runScan} onCancel={cancelCrop} />
      )}

      {scanStatus === "review" && scanPreview && (
        <div className="scan-review">
          <div className="scan-review-images">
            {scanPreview.regions.map((region, i) => (
              <div className="scan-review-region" key={i}>
                {regionLabels && <div className="scan-review-region-title">{regionLabels[i]}</div>}
                <div className="scan-review-region-image">
                  <img
                    src={region.imageUrl}
                    alt={
                      regionLabels
                        ? `Scanned ${regionLabels[i]} region with detected tiles boxed`
                        : scanPreview.regions.length > 1
                          ? `Scanned hand region ${i + 1} with detected tiles boxed`
                          : "Scanned hand with detected tiles boxed"
                    }
                  />
                  <DetectionOverlay
                    detections={region.detections}
                    editingId={editingDetectionId}
                    onSelect={setEditingDetectionId}
                    imageWidth={region.imageWidth}
                    imageHeight={region.imageHeight}
                  />
                </div>
              </div>
            ))}
          </div>

          {editingDetection && (
            <CorrectionPanel
              detection={editingDetection}
              onPick={(correction) => correctDetection(editingDetection.id, correction)}
              onRemove={() => removeDetection(editingDetection.id)}
              onCancel={() => setEditingDetectionId(null)}
            />
          )}

          <div className="scan-review-summary">
            <div className="scan-review-info">
              {regionLabels ? (
                scanPreview.regions.map((region, i) => {
                  const tileCount = region.detections.filter((d) => d.tile !== null).length;
                  const ignoredCount = region.detections.length - tileCount;
                  return (
                    <span key={i} className="scan-review-region-count">
                      <strong>{regionLabels[i]}:</strong> {tileCount} tile{tileCount === 1 ? "" : "s"}
                      {ignoredCount > 0 && ` (+${ignoredCount} flower/season)`}
                      {regionIssues?.[i] && (
                        <span className={regionIssues[i]!.blocking ? "error" : "warning"}> — {regionIssues[i]!.message}</span>
                      )}
                    </span>
                  );
                })
              ) : (
                <span>
                  {totalRealTiles} tile{totalRealTiles === 1 ? "" : "s"} detected
                  {scanPreview.regions.reduce((n, r) => n + r.detections.filter((d) => d.tile === null).length, 0) > 0 &&
                    ` (+${scanPreview.regions.reduce((n, r) => n + r.detections.filter((d) => d.tile === null).length, 0)} flower/season tile(s) ignored)`}
                </span>
              )}
              <span className="scan-review-hint">Tap a boxed tile to correct it</span>
            </div>
            <div className="scan-review-actions">
              <button type="button" onClick={cancelScan}>
                Cancel
              </button>
              <button type="button" onClick={confirmScan} disabled={totalRealTiles === 0 || hasBlockingError}>
                Use this hand
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
});

function Calculator() {
  // `hand` always holds tiles in true input order - Sort never mutates it,
  // it only changes how `displayHand` (below) is derived for rendering/text.
  const [hand, setHand] = useState<HandTile[]>([]);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sortMode, setSortMode] = useState(true);
  // Mirrors `sortMode` for toggleSortMode's own read-then-write, same reason
  // as handRef: a double-tap on Sort fast enough that both taps read the
  // state closure from before either committed would compute the same
  // `next` twice, so the second setSortMode(next) is a no-op (same value)
  // and silently drops what should have been a toggle back.
  const sortModeRef = useRef(true);
  const [breakdownMode, setBreakdownMode] = useState<BreakdownMode>("off");
  const lastBreakdownOrder = useRef<BreakdownOrder>("on");
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
    // Mirrors the picker button's own disabled condition (tileCount(hand, t)
    // >= 4), but checked against handRef instead of the hand state - taps
    // fast enough to land before a render commits would otherwise see a
    // stale (still-enabled) button and add a 5th+ copy of the same tile.
    // Jokers aren't capped (see parseHand), so skip the check for those.
    if (tile.suit !== "j" && tileCount(handRef.current, tile) >= 4) return;
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
    const next = !sortModeRef.current;
    sortModeRef.current = next;
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
            placeholder="e.g. 111222333444m11t22b"
            spellCheck={false}
          />
          {error && <span className="error">{error}</span>}
        </div>

        <HandScanner onConfirm={(regions) => onTextChange(formatHand(regions.flatMap((r) => r.detections.flatMap((d) => (d.tile ? [d.tile] : [])))))} />

        <div className="panel-header">
          <span className="panel-title">Hand</span>
          <button type="button" onClick={handleReset} disabled={hand.length === 0}>
            Reset
          </button>
          <button
            type="button"
            className={sortMode ? "toggle-on" : undefined}
            onClick={toggleSortMode}
            aria-pressed={sortMode}
            title={sortMode ? "Sort: on — new tiles are kept in order" : "Sort: off — new tiles keep input order"}
          >
            Sort
          </button>
          <button
            type="button"
            className={breakdownMode !== "off" ? "toggle-on" : undefined}
            onClick={() => setBreakdownMode((m) => (m === "off" ? lastBreakdownOrder.current : "off"))}
            aria-pressed={breakdownMode !== "off"}
            title={
              breakdownMode !== "off"
                ? "Breakdown: on — shows the meld/pair split for each wait"
                : "Breakdown: off — shows just the waiting tiles"
            }
          >
            Breakdown
          </button>
          {breakdownMode !== "off" && (
            <button
              type="button"
              className="icon-toggle"
              onClick={() =>
                setBreakdownMode((m) => {
                  const next: BreakdownOrder = m === "sorted" ? "on" : "sorted";
                  lastBreakdownOrder.current = next;
                  return next;
                })
              }
              aria-pressed={breakdownMode === "sorted"}
              title={BREAKDOWN_ORDER_TITLE[breakdownMode as BreakdownOrder]}
            >
              ↔
            </button>
          )}
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
        {discardChoices !== null && (
          <div className="waits discard-analysis">
            <span className="waits-label">
              {discardChoices.alreadyComplete ? "If you discarded instead of winning:" : "Discard options:"}
            </span>
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
  );
}

// One tile kind's outcome after the user submits an answer: whether they
// correctly flagged it as a wait, wrongly flagged a non-wait, or missed a
// real wait entirely. `null` covers the (usual) case of a tile that's
// neither a wait nor something the user picked - nothing to call out.
type TrainerTileStatus = "hit" | "false-positive" | "missed" | null;

// Accumulated results for one (level, flush) combination - stats are kept
// separate per combination since difficulty varies a lot between them, and
// lumping e.g. Level 1 and Level 5 together would wash out both.
interface TrainerStatsEntry {
  level: number;
  flush: boolean;
  total: number;
  correct: number;
  timeTotalMs: number;
}

function trainerStatsKey(level: number, flush: boolean): string {
  return `${level}-${flush}`;
}

function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function TrainerPanel({
  stats,
  setStats,
}: {
  stats: Map<string, TrainerStatsEntry>;
  setStats: (updater: (prev: Map<string, TrainerStatsEntry>) => Map<string, TrainerStatsEntry>) => void;
}) {
  const [level, setLevel] = useState(MIN_TRAINER_LEVEL);
  const [flush, setFlush] = useState(false);
  const [question, setQuestion] = useState<TrainerQuestion | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [submitted, setSubmitted] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const questionStartRef = useRef(performance.now());
  // Mirrors `selected`, updated synchronously - a tap-tap-tap-then-Submit
  // sequence fired fast enough that React hasn't re-rendered between them
  // yet would otherwise have handleSubmit's onClick (bound at the last
  // completed render) close over a `selected` from before those taps, and
  // score the answer as whatever it was several taps ago instead of what's
  // actually on screen. Same fix as Calculator's handRef, same failure mode.
  const selectedRef = useRef<Set<string>>(new Set());
  // Mirrors `submitted` for the same reason: handleSubmit's own re-entry
  // guard must see a double-tap's second call as already-submitted even
  // before React has re-rendered from the first, or a fast double-tap on
  // Submit double-records the same question into the stats table.
  const submittedRef = useRef(false);

  const newQuestion = (lvl: number, flushMode: boolean) => {
    setQuestion(generateTrainerQuestion(lvl, flushMode));
    selectedRef.current = new Set();
    setSelected(selectedRef.current);
    submittedRef.current = false;
    setSubmitted(false);
    questionStartRef.current = performance.now();
    setElapsedMs(0);
  };

  // Clears back to the "press New Hand" placeholder - used both on mount
  // (so a question doesn't pop up the instant Trainer opens) and whenever
  // level/flush changes (so the picker never shows a hand that doesn't
  // match the currently-selected level/flush controls; the user presses
  // New Hand again to get a question in the new configuration).
  const clearQuestion = () => {
    setQuestion(null);
    selectedRef.current = new Set();
    setSelected(selectedRef.current);
    submittedRef.current = false;
    setSubmitted(false);
    setElapsedMs(0);
  };

  useEffect(clearQuestion, [level, flush]);

  // Ticks the visible timer while a question is active; stops (freezing the
  // last value) once submitted, and restarts fresh for each new question.
  useEffect(() => {
    if (!question || submitted) return;
    const id = setInterval(() => setElapsedMs(performance.now() - questionStartRef.current), 100);
    return () => clearInterval(id);
  }, [question, submitted]);

  const waitKeys = useMemo(() => new Set((question?.waits ?? []).map(tileKey)), [question]);
  // A wait always completes a group that already has at least one tile
  // present in the question hand (finishing a run/triplet, or pairing up a
  // single) - so only the suits actually in play are ever worth showing,
  // saving real estate especially in Flush mode (always exactly one suit).
  const relevantSuits = useMemo(
    () => SUIT_ORDER.filter((suit) => question?.tiles.some((t) => t.suit === suit)),
    [question]
  );
  const selectedCount = selected.size;
  const isCorrect = submitted && selectedCount === waitKeys.size && [...selected].every((k) => waitKeys.has(k));

  const toggleSelected = (t: Tile) => {
    if (submitted) return;
    const key = tileKey(t);
    const next = new Set(selectedRef.current);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    selectedRef.current = next;
    setSelected(next);
  };

  const handleSubmit = () => {
    if (!question || submittedRef.current) return;
    submittedRef.current = true;
    const current = selectedRef.current;
    const correct = current.size === waitKeys.size && [...current].every((k) => waitKeys.has(k));
    const timeMs = performance.now() - questionStartRef.current;
    const key = trainerStatsKey(level, flush);
    setStats((prev) => {
      const next = new Map(prev);
      const existing = next.get(key) ?? { level, flush, total: 0, correct: 0, timeTotalMs: 0 };
      next.set(key, {
        level,
        flush,
        total: existing.total + 1,
        correct: existing.correct + (correct ? 1 : 0),
        timeTotalMs: existing.timeTotalMs + timeMs,
      });
      return next;
    });
    setElapsedMs(timeMs);
    setSubmitted(true);
  };

  const statsRows = useMemo(
    () => Array.from(stats.values()).sort((a, b) => a.level - b.level || Number(a.flush) - Number(b.flush)),
    [stats]
  );
  const statsTotal = useMemo(
    () =>
      statsRows.reduce(
        (acc, r) => ({ total: acc.total + r.total, correct: acc.correct + r.correct, timeTotalMs: acc.timeTotalMs + r.timeTotalMs }),
        { total: 0, correct: 0, timeTotalMs: 0 }
      ),
    [statsRows]
  );

  const statusFor = (t: Tile): TrainerTileStatus => {
    if (!submitted) return null;
    const key = tileKey(t);
    const isWait = waitKeys.has(key);
    const isSelected = selected.has(key);
    if (isWait && isSelected) return "hit";
    if (isWait && !isSelected) return "missed";
    if (!isWait && isSelected) return "false-positive";
    return null;
  };

  return (
    <section className="panel trainer-panel">
      <div className="panel-header">
        <span className="panel-title">Trainer</span>
        <div className="trainer-levels">
          {Array.from({ length: MAX_TRAINER_LEVEL - MIN_TRAINER_LEVEL + 1 }, (_, i) => MIN_TRAINER_LEVEL + i).map(
            (lvl) => (
              <button
                key={lvl}
                type="button"
                className={lvl === level ? "toggle-on" : undefined}
                aria-pressed={lvl === level}
                onClick={() => setLevel(lvl)}
                title={`Level ${lvl}: ${trainerHandSize(lvl)} tiles`}
              >
                L{lvl}
              </button>
            )
          )}
        </div>
        <button
          type="button"
          className={flush ? "toggle-on" : undefined}
          aria-pressed={flush}
          onClick={() => setFlush((f) => !f)}
          title="Flush mode: every tile comes from the same suit"
        >
          Flush
        </button>
        <button type="button" onClick={() => newQuestion(level, flush)}>
          {submitted ? "Next Question" : "New Hand"}
        </button>
        {question && <span className="tile-count">Time: {formatSeconds(elapsedMs)}</span>}
      </div>

      {!question && (
        <div className="waits">
          <span className="waits-label">Press "New Hand" to start testing your ability!</span>
        </div>
      )}

      {question && (
        <>
          <div className="waits">
            <div className="hand-display trainer-hand">
              {sortTiles(question.tiles).map((t, i) => (
                <TileGlyphSpan key={i} tile={t} large />
              ))}
            </div>
          </div>

          <div className="tile-picker">
            {relevantSuits.map((suit) => (
              <div className="suit-row" key={suit}>
                {allTileKinds()
                  .filter((t) => t.suit === suit)
                  .map((t) => {
                    const status = statusFor(t);
                    return (
                      <TileButton
                        key={tileLabel(t)}
                        tile={t}
                        onClick={() => toggleSelected(t)}
                        selected={selected.has(tileKey(t))}
                        extraClass={status ? `trainer-${status}` : undefined}
                        title={
                          status === "missed"
                            ? `${tileLabel(t)} - you missed this wait`
                            : status === "false-positive"
                              ? `${tileLabel(t)} - not actually a wait`
                              : tileLabel(t)
                        }
                      />
                    );
                  })}
              </div>
            ))}
          </div>

          {!submitted ? (
            <button type="button" className="trainer-submit" onClick={handleSubmit}>
              Submit ({selectedCount} selected)
            </button>
          ) : (
            <>
              <div className={isCorrect ? "waits trainer-result-correct" : "waits trainer-result-incorrect"}>
                <span className="waits-label trainer-result-label">
                  {isCorrect ? "Correct! This hand waits on:" : "Incorrect! This hand waits on:"}
                </span>
                {question.waits.map((w) => (
                  <TileGlyphSpan key={tileLabel(w)} tile={w} large />
                ))}
              </div>
              <div className="waits breakdown-list">
                <span className="waits-label">Breakdown:</span>
                {question.waits.map((w) => (
                  <WaitBreakdownRow
                    key={tileLabel(w)}
                    result={{ wait: w, jokers: [] }}
                    nonJokerHand={question.tiles}
                    meldsRequired={level}
                    sorted={false}
                    remainingCount={null}
                  />
                ))}
              </div>
            </>
          )}
        </>
      )}

      {statsRows.length > 0 && (
        <div className="trainer-stats">
          <div className="panel-header">
            <span className="panel-title">Stats</span>
            <button type="button" onClick={() => setStats(() => new Map())}>
              Reset Stats
            </button>
          </div>
          <div className="trainer-stats-scroll">
            <table className="trainer-stats-table">
              <thead>
                <tr>
                  <th>Level</th>
                  <th>Flush</th>
                  <th>Answered</th>
                  <th>Correct</th>
                  <th>Wrong</th>
                  <th>% Correct</th>
                  <th>Avg Time</th>
                </tr>
              </thead>
              <tbody>
                {statsRows.map((r) => (
                  <tr key={trainerStatsKey(r.level, r.flush)}>
                    <td>L{r.level}</td>
                    <td>{r.flush ? "Yes" : "No"}</td>
                    <td>{r.total}</td>
                    <td>{r.correct}</td>
                    <td>{r.total - r.correct}</td>
                    <td>{Math.round((r.correct / r.total) * 100)}%</td>
                    <td>{formatSeconds(r.timeTotalMs / r.total)}</td>
                  </tr>
                ))}
                <tr className="trainer-stats-total">
                  <td colSpan={2}>All</td>
                  <td>{statsTotal.total}</td>
                  <td>{statsTotal.correct}</td>
                  <td>{statsTotal.total - statsTotal.correct}</td>
                  <td>{statsTotal.total > 0 ? Math.round((statsTotal.correct / statsTotal.total) * 100) : 0}%</td>
                  <td>{statsTotal.total > 0 ? formatSeconds(statsTotal.timeTotalMs / statsTotal.total) : "0.0s"}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}

const WIND_LABELS: Record<Wind, string> = { 1: "East", 2: "South", 3: "West", 4: "North" };
const WIND_SHORT: Record<Wind, string> = { 1: "E", 2: "S", 3: "W", 4: "N" };

function WindPicker({ label, value, onChange }: { label: string; value: Wind; onChange: (w: Wind) => void }) {
  return (
    <div className="wind-picker">
      <span className="wind-picker-label">{label}</span>
      {([1, 2, 3, 4] as Wind[]).map((w) => (
        <button
          key={w}
          type="button"
          className={value === w ? "toggle-on" : undefined}
          aria-pressed={value === w}
          onClick={() => onChange(w)}
          title={WIND_LABELS[w]}
        >
          {WIND_SHORT[w]}
        </button>
      ))}
    </div>
  );
}

// Collapses/expands a tile-picker grid, placed at the end of that section's
// panel-header - the already-picked melds/hand display stays visible
// either way, this only hides the (often multi-row, space-hungry) tap-to-
// add grid once its tiles are already chosen. A plain chevron icon-toggle,
// same idiom as the Calculator tab's Breakdown-order icon-toggle.
function PickerCollapseToggle({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      className="icon-toggle"
      onClick={onToggle}
      aria-expanded={!collapsed}
      title={collapsed ? "Show tile picker" : "Hide tile picker"}
    >
      {collapsed ? "▸" : "▾"}
    </button>
  );
}

// A meld sitting in the 門前牌區 (the melds laid out in front of you on the
// table - called triplets/runs, plus kongs of either kind, since a kong is
// always set apart from your hand even when concealed). `id` is only for
// React keys/removal, same reason HandTile has one.
interface DeclaredMeldTile {
  id: number;
  kind: MeldKind;
  concealed: boolean;
  tiles: Tile[];
}

const MELD_KIND_LABELS: Record<MeldKind, string> = { triplet: "Triplet (碰)", run: "Run (吃)", kong: "Kong (槓)" };

// Whichever suit rows make sense to offer for the currently-selected meld
// kind: runs only exist in numbered suits, so the honor row is dropped
// entirely for run mode. Rank 8/9 stay in the row (unlike honors, hiding
// individual tiles out of an otherwise-populated row reflows the rest of
// that row, which reads as tiles randomly vanishing) - canAddMeldTile
// disables them instead, since a run can't start there (no room for the
// next two ranks within 1-9).
function meldPickerTiles(kind: MeldKind): Tile[] {
  const all = allTileKinds();
  return kind === "run" ? all.filter((t) => t.suit !== "z") : all;
}

// Unicode Mahjong Tiles block, immediately after circles (1F019-1F021) and
// before Joker (1F02A, see mahjong.ts's own tileGlyph) - the 4 flowers
// (Plum/Orchid/Bamboo/Chrysanthemum) then the 4 seasons (Spring/Summer/
// Autumn/Winter), each block's rank order matching the seat wind it's
// conventionally paired with (East/South/West/North).
const FLOWER_CODEPOINTS: Record<1 | 2 | 3 | 4, number> = { 1: 0x1f022, 2: 0x1f023, 3: 0x1f024, 4: 0x1f025 };
const SEASON_CODEPOINTS: Record<1 | 2 | 3 | 4, number> = { 1: 0x1f026, 2: 0x1f027, 3: 0x1f028, 4: 0x1f029 };
const FLOWER_NAMES: Record<1 | 2 | 3 | 4, string> = { 1: "Plum", 2: "Orchid", 3: "Bamboo", 4: "Chrysanthemum" };
const SEASON_NAMES: Record<1 | 2 | 3 | 4, string> = { 1: "Spring", 2: "Summer", 3: "Autumn", 4: "Winter" };
const BONUS_TEXT_PRESENTATION = "︎"; // see mahjong.ts's TEXT_PRESENTATION for why

function bonusTileGlyph(tile: BonusTile): string {
  const codepoint = (tile.kind === "flower" ? FLOWER_CODEPOINTS : SEASON_CODEPOINTS)[tile.rank];
  return String.fromCodePoint(codepoint) + BONUS_TEXT_PRESENTATION;
}
function bonusTileLabel(tile: BonusTile): string {
  return tile.kind === "flower" ? `Flower: ${FLOWER_NAMES[tile.rank]}` : `Season: ${SEASON_NAMES[tile.rank]}`;
}

function BonusTileButton({
  tile,
  onClick,
  disabled,
  selected,
}: {
  tile: BonusTile;
  onClick: () => void;
  disabled?: boolean;
  selected?: boolean;
}) {
  const tap = useTap(onClick, disabled);
  const classes = ["tile-button", selected && "selected"].filter(Boolean).join(" ");
  return (
    <button type="button" className={classes} disabled={disabled} title={bonusTileLabel(tile)} {...tap}>
      <span className="tile-glyph" data-suit="bonus">
        {bonusTileGlyph(tile)}
      </span>
    </button>
  );
}

// Which physical tile instance in the resolved hand the 食胡 tile actually
// is, for highlighting purposes - see the comment in ScoringBreakdown for
// why this searches in priority order (pair, then triplet/kong, then run)
// rather than taking whichever group happens to render first.
function findWinningTileInstance(hand: ResolvedHand, winningTile: Tile | null): Tile | null {
  if (winningTile === null) return null;
  const matches = (t: Tile) => t.suit === winningTile.suit && t.rank === winningTile.rank;
  const pairMatch = hand.pair.find(matches);
  if (pairMatch) return pairMatch;
  for (const kind of ["triplet", "kong"] as const) {
    for (const meld of hand.melds) {
      if (meld.kind !== kind) continue;
      const t = meld.tiles.find(matches);
      if (t) return t;
    }
  }
  for (const meld of hand.melds) {
    if (meld.kind !== "run") continue;
    const t = meld.tiles.find(matches);
    if (t) return t;
  }
  return null;
}

// The patterns list + Declared/Concealed hand-sections for one scored
// reading - factored out so 嚦咕雙食 (see ScoreResult.second) can render a
// second reading identically below the primary one, rather than
// duplicating this whole block.
function ScoringBreakdown({
  matched,
  hand,
  declaredCount,
  winningTile,
}: {
  matched: ScoreResult["matched"];
  hand: ResolvedHand;
  declaredCount: number;
  winningTile: Tile | null;
}) {
  // scoring.ts's Tile (unlike the picker's HandTile) has no id to pin down
  // which physical instance was the 食胡 tile, so this only knows its kind -
  // matching every tile of the same kind would highlight extras whenever
  // that kind appears more than once (e.g. inside a quad). When the kind
  // appears in more than one group, highlighting whichever one renders
  // first (declared-then-concealed array order) doesn't necessarily land on
  // the group the scoring actually cared about - e.g. nine gates
  // (1112345678999m111z) completed by 9m scores 對碰 (shanpon: pair→
  // triplet), which is about the 999m triplet, but 9m also sits at the edge
  // of the 789m run that happens to render first, highlighting the wrong
  // one even though the tai is correct either way. Searching in priority
  // order instead - pair (單騎/tanki) first, then triplet/kong (對碰/暗刻
  // chain/quads), then run (嵌張/邊張/ordinary two-sided) - picks whichever
  // group is the most specific/notable completion role, matching the
  // pattern that's actually likely to have scored.
  const winningInstance = findWinningTileInstance(hand, winningTile);
  const isWinningInstance = (t: Tile): boolean => t === winningInstance;
  return (
    <>
      <div className="waits breakdown-list">
        <span className="waits-label">Patterns:</span>
        {matched.length === 0 ? (
          <span className="hint">No patterns matched yet — this is an early version, more get added over time.</span>
        ) : (
          matched.map(({ pattern, tai }) => (
            <div className="scoring-pattern-row" key={pattern.id}>
              <span>{pattern.name}</span>
              <span className="scoring-pattern-tai">{tai} tai</span>
            </div>
          ))
        )}
      </div>

      <div className="hand-sections">
        <div className="hand-section declared-section">
          <span className="hand-section-label">Declared</span>
          <div className="hand-display breakdown-groups">
            {hand.bonusTiles.length > 0 && (
              <span className="breakdown-group bonus-tile-group" title="Bonus tiles">
                {hand.bonusTiles.map((tile, i) => (
                  <span key={i} className="tile-glyph" data-suit="bonus">
                    {bonusTileGlyph(tile)}
                  </span>
                ))}
              </span>
            )}
            {hand.melds.slice(0, declaredCount).map((meld, i) => (
              <span
                className={meld.concealed ? "breakdown-group concealed-kong-meld" : "breakdown-group"}
                key={i}
                title={`${meld.kind}${meld.concealed ? " (concealed kong)" : ""}`}
              >
                {meld.tiles.map((t, j) => (
                  <TileGlyphSpan key={j} tile={t} highlight={isWinningInstance(t)} />
                ))}
              </span>
            ))}
            {declaredCount === 0 && hand.bonusTiles.length === 0 && <span className="hint">None</span>}
          </div>
        </div>
        <div className="hand-section concealed-section">
          <span className="hand-section-label">Concealed</span>
          <div className="hand-display breakdown-groups">
            {hand.melds.slice(declaredCount).map((meld, i) => (
              <span className="breakdown-group" key={i} title={meld.kind}>
                {meld.tiles.map((t, j) => (
                  <TileGlyphSpan key={j} tile={t} highlight={isWinningInstance(t)} />
                ))}
              </span>
            ))}
            <span className="breakdown-group" title="Pair">
              {hand.pair.map((t, j) => (
                <TileGlyphSpan key={j} tile={t} highlight={isWinningInstance(t)} />
              ))}
            </span>
          </div>
        </div>
      </div>
    </>
  );
}

// This models the table, not a text format: 手牌區 (concealed hand) is a
// plain multiset of tiles still to be decomposed, and 門前牌區 (declared
// melds) is a list of already-fixed groups - exactly mahjong.ts's
// freeTiles/declaredMelds split, just built by tapping instead of typed
// notation (see scoring.ts's parseScoringHand for the equivalent text
// grammar, still used by scoreHand/tests).
function ScoringPanel() {
  const [concealedTiles, setConcealedTiles] = useState<HandTile[]>([]);
  const [declaredMelds, setDeclaredMelds] = useState<DeclaredMeldTile[]>([]);
  // Bonus tiles (flowers/seasons) live in 門前牌區 alongside declared melds
  // (see BonusTile's doc comment in scoring.ts) but aren't melds themselves
  // and don't count toward hand completeness - kept as separate state rather
  // than folded into declaredMelds. A standard set has exactly one physical
  // copy of each kind+rank, so no counter/id is needed - the pair itself is
  // a stable enough key.
  const [bonusTiles, setBonusTiles] = useState<BonusTile[]>([]);
  const [meldKind, setMeldKind] = useState<MeldKind>("triplet");
  const [kongConcealed, setKongConcealed] = useState(true);
  const [seatWind, setSeatWind] = useState<Wind>(1);
  const [roundWind, setRoundWind] = useState<Wind>(1);
  const [selfDraw, setSelfDraw] = useState(false);
  // The 食胡 tile - the specific tile instance (not just its kind) that
  // completed the hand, set via long-press on a concealed-hand tile (see
  // WinningTileHandButton). Tracked by id so that long-pressing one of
  // several same-kind tiles highlights only that one - which instance was
  // pressed can matter for how a decomposition-sensitive pattern (e.g.
  // 假獨) reads the hand, even though scoring.ts's GameContext.winningTile
  // itself is still kind-based (see the ctx construction below).
  const [winningTile, setWinningTile] = useState<HandTile | null>(null);
  const nextTileId = useRef(0);
  const nextMeldId = useRef(0);
  // The scan trigger button lives in the panel header (next to Reset)
  // rather than HandScanner's own built-in one - see HandScannerHandle.
  const handScannerRef = useRef<HandScannerHandle>(null);
  const [scanBusy, setScanBusy] = useState(false);
  // Each tile-picker grid (declared melds, bonus tiles, concealed hand)
  // can be collapsed independently to reclaim vertical space once its
  // tiles are already picked - the already-added melds/hand display
  // itself stays visible either way, only the tap-to-add grid hides.
  const [declaredPickerCollapsed, setDeclaredPickerCollapsed] = useState(false);
  const [bonusPickerCollapsed, setBonusPickerCollapsed] = useState(false);
  const [concealedPickerCollapsed, setConcealedPickerCollapsed] = useState(false);

  // Mirrors the three state arrays above, updated synchronously - same
  // reason Calculator's handRef exists (see its comment at handRef's
  // declaration): two taps landing before a render commits between them
  // would otherwise both read the same stale state closure and independently
  // decide "not at the cap yet", letting a rapid double-tap add a 5th copy of
  // a tile or a duplicate bonus tile past its 1-copy limit. Every add/remove
  // handler below reads and writes these refs first, then mirrors the result
  // into state to trigger a render.
  const concealedRef = useRef<HandTile[]>([]);
  const declaredRef = useRef<DeclaredMeldTile[]>([]);
  const bonusRef = useRef<BonusTile[]>([]);

  const totalCopiesUsedRef = (tile: Tile): number => {
    let n = tileCount(concealedRef.current, tile);
    for (const meld of declaredRef.current) n += tileCount(meld.tiles, tile);
    return n;
  };
  const atCapRef = (): boolean => {
    const kongs = declaredRef.current.filter((m) => m.kind === "kong").length;
    const total = concealedRef.current.length + declaredRef.current.reduce((n, m) => n + m.tiles.length, 0);
    return total >= COMPLETE_SIZE + kongs;
  };

  // Render-time counterpart of totalCopiesUsedRef, derived from state - used
  // only for `disabled` props (a UI hint that's correct as of the last
  // commit), never for the actual gating decision inside a handler (that's
  // what the Ref-suffixed versions above are for).
  const totalCopiesUsed = (tile: Tile): number => {
    let n = tileCount(concealedTiles, tile);
    for (const meld of declaredMelds) n += tileCount(meld.tiles, tile);
    return n;
  };

  const kongCount = declaredMelds.filter((m) => m.kind === "kong").length;
  const requiredSize = COMPLETE_SIZE + kongCount;
  const totalTiles = concealedTiles.length + declaredMelds.reduce((n, m) => n + m.tiles.length, 0);
  const atCap = totalTiles >= requiredSize;
  const meldsFull = declaredMelds.length >= 5;

  const addConcealedTile = (tile: Tile) => {
    if (atCapRef() || totalCopiesUsedRef(tile) >= 4) return;
    const next = [...concealedRef.current, { ...tile, id: nextTileId.current++ }];
    concealedRef.current = next;
    setConcealedTiles(next);
  };
  const removeConcealedTile = (id: number) => {
    const next = concealedRef.current.filter((t) => t.id !== id);
    concealedRef.current = next;
    setConcealedTiles(next);
    setWinningTile((prev) => (prev && prev.id === id ? null : prev));
  };

  const pushMeld = (kind: MeldKind, concealed: boolean, tiles: Tile[]) => {
    if (atCapRef() || declaredRef.current.length >= 5) return;
    const next = [...declaredRef.current, { id: nextMeldId.current++, kind, concealed, tiles }];
    declaredRef.current = next;
    setDeclaredMelds(next);
  };
  const addMeldStartingAt = (tile: Tile) => {
    if (meldKind === "triplet") {
      if (totalCopiesUsedRef(tile) + 3 > 4) return;
      pushMeld("triplet", false, [tile, tile, tile]);
    } else if (meldKind === "kong") {
      if (totalCopiesUsedRef(tile) > 0) return;
      pushMeld("kong", kongConcealed, [tile, tile, tile, tile]);
    } else {
      const run = [0, 1, 2].map((d) => ({ suit: tile.suit, rank: tile.rank + d }));
      if (run.some((t) => totalCopiesUsedRef(t) + 1 > 4)) return;
      pushMeld("run", false, run);
    }
  };
  const removeMeld = (id: number) => {
    const next = declaredRef.current.filter((m) => m.id !== id);
    declaredRef.current = next;
    setDeclaredMelds(next);
  };

  const hasBonusTileRef = (tile: BonusTile) => bonusRef.current.some((b) => b.kind === tile.kind && b.rank === tile.rank);
  const hasBonusTile = (tile: BonusTile) => bonusTiles.some((b) => b.kind === tile.kind && b.rank === tile.rank);
  const addBonusTile = (tile: BonusTile) => {
    if (hasBonusTileRef(tile)) return;
    const next = [...bonusRef.current, tile];
    bonusRef.current = next;
    setBonusTiles(next);
  };
  const removeBonusTile = (tile: BonusTile) => {
    const next = bonusRef.current.filter((b) => !(b.kind === tile.kind && b.rank === tile.rank));
    bonusRef.current = next;
    setBonusTiles(next);
  };

  const canAddMeldTile = (tile: Tile): boolean => {
    if (atCap || meldsFull) return false;
    if (meldKind === "triplet") return totalCopiesUsed(tile) + 3 <= 4;
    if (meldKind === "kong") return totalCopiesUsed(tile) === 0;
    // A run starting at rank 8 or 9 would need a rank 10 or 11 tile, which
    // doesn't exist - meldPickerTiles keeps these tiles visible (rather
    // than hiding them, which reflows the rest of the row) so this needs
    // its own explicit range check; totalCopiesUsed alone wouldn't catch
    // it (an out-of-range rank just always reads as "0 copies used").
    if (tile.rank > 7) return false;
    const run = [0, 1, 2].map((d) => ({ suit: tile.suit, rank: tile.rank + d }));
    return run.every((t) => totalCopiesUsed(t) + 1 <= 4);
  };

  const handleReset = () => {
    concealedRef.current = [];
    declaredRef.current = [];
    bonusRef.current = [];
    setConcealedTiles([]);
    setDeclaredMelds([]);
    setBonusTiles([]);
    setWinningTile(null);
  };

  // A scanned detection's meaning for the declared-melds region: a real
  // tile, a bonus tile, or excluded (marked "not a tile", i.e. a false
  // positive) - both `tile` and `bonus` are already resolved as of
  // detection creation/correction (see ReviewDetection's doc comment).
  const classifyDeclaredDetection = (
    d: ReviewDetection
  ): { kind: "tile"; tile: Tile } | { kind: "bonus"; bonus: BonusTile } | { kind: "excluded" } => {
    if (d.tile) return { kind: "tile", tile: d.tile };
    if (d.bonus) return { kind: "bonus", bonus: d.bonus };
    return { kind: "excluded" };
  };

  // Sorts a region's detections into table (left-to-right) order - required
  // by groupDeclaredTiles, which assumes one meld's tiles are consecutive -
  // then splits them into the real tiles (for grouping) and bonus tiles.
  const declaredScanTiles = (detections: ReviewDetection[]): { realTiles: Tile[]; bonusTiles: BonusTile[] } => {
    const sorted = [...detections].sort((a, b) => a.box[0] - b.box[0]);
    const realTiles: Tile[] = [];
    const bonusTiles: BonusTile[] = [];
    for (const d of sorted) {
      const c = classifyDeclaredDetection(d);
      if (c.kind === "tile") realTiles.push(c.tile);
      else if (c.kind === "bonus") bonusTiles.push(c.bonus);
    }
    return { realTiles, bonusTiles };
  };

  // HandScanner's regionIssue for the Declared region. groupDeclaredTiles
  // assumes melds are laid out left-to-right and consecutive - a photo
  // grouped some other way (e.g. stacked top-to-bottom) breaks that
  // assumption partway through, leaving the rest of the tiles as leftover.
  // That's just an advisory warning (confirming anyway scores the melds
  // that WERE recognized, silently dropping the leftover - see
  // applyScannedRegions): the user can always fix the boxes and rescan for
  // a clean read, but forcing them to before they can even see a score
  // isn't worth it. The only case actually worth blocking on is zero
  // melds recognized at all - there's no "best effort" breakdown to fall
  // back on then, just an empty declared-melds region.
  const declaredRegionIssue = (
    detections: ReviewDetection[],
    regionIndex: number
  ): { blocking: boolean; message: string } | null => {
    if (regionIndex !== 1) return null;
    const { melds, leftover } = groupDeclaredTiles(declaredScanTiles(detections).realTiles);
    if (leftover.length === 0) return null;
    if (melds.length === 0) {
      return {
        blocking: true,
        message: `${leftover.length} tile${leftover.length === 1 ? "" : "s"} don't form a full meld - correct or remove ${
          leftover.length === 1 ? "its" : "their"
        } box${leftover.length === 1 ? "" : "es"} above`,
      };
    }
    return {
      blocking: false,
      message: `Grouping isn't clear from this photo (${leftover.length} tile${
        leftover.length === 1 ? "" : "s"
      } unmatched) - consider rescanning. Confirming will score using the melds detected so far.`,
    };
  };

  // HandScanner's onConfirm: region 0 is always the concealed hand and fully
  // replaces concealedTiles (same "scan replaces" behavior as the
  // Calculator). Region 1, the declared melds, is optional (the crop step
  // only produces it if the user added a 2nd region) - when present it fully
  // replaces both declaredMelds and bonusTiles; when absent, those are left
  // untouched, since the user simply wasn't scanning that part this time.
  const applyScannedRegions = (regions: { detections: ReviewDetection[] }[]) => {
    const [concealedRegion, declaredRegion] = regions;
    if (concealedRegion) {
      // Unlike the declared region, concealed tiles aren't clustered - each
      // detection is independent, so the model's raw left-to-right order
      // carries no meaning (and needn't be perfectly sorted to begin with,
      // e.g. "576t" instead of "567t" - see groupDeclaredTiles for the
      // declared region's equivalent). Just sort the whole bag by tile order.
      const detectedTiles = concealedRegion.detections.flatMap((d) => (d.tile ? [d.tile] : []));
      const nextConcealed = (sortTiles(detectedTiles) as Tile[]).map((t) => ({ ...t, id: nextTileId.current++ }));
      concealedRef.current = nextConcealed;
      setConcealedTiles(nextConcealed);
      setWinningTile(null);
      setConcealedPickerCollapsed(true);
    }
    if (declaredRegion) {
      const { realTiles, bonusTiles: scannedBonusTiles } = declaredScanTiles(declaredRegion.detections);
      const { melds } = groupDeclaredTiles(realTiles);
      const nextDeclared = melds.map((m) => ({ id: nextMeldId.current++, ...m }));
      declaredRef.current = nextDeclared;
      setDeclaredMelds(nextDeclared);
      bonusRef.current = scannedBonusTiles;
      setBonusTiles(scannedBonusTiles);
      setDeclaredPickerCollapsed(true);
    }
  };

  const isWinningTile = (tile: HandTile): boolean => winningTile !== null && winningTile.id === tile.id;
  const toggleWinningTile = (tile: HandTile) =>
    setWinningTile((prev) => (prev && prev.id === tile.id ? null : tile));

  // scoring.ts only cares about the winning tile's kind (see GameContext's
  // doc comment there) - the id above exists purely to disambiguate which
  // instance the UI highlights.
  const ctx: GameContext = { seatWind, roundWind, selfDraw, winningTile };
  const scoring = useMemo(() => {
    if (totalTiles !== requiredSize) return null;
    const parsed: ParsedScoringHand = {
      declaredMelds: declaredMelds.map(({ kind, concealed, tiles }) => ({ kind, concealed, tiles })),
      freeTiles: concealedTiles.map(({ id: _id, ...tile }) => tile),
      bonusTiles,
    };
    try {
      return { ok: true as const, result: scoreParsedHand(parsed, ctx) };
    } catch (e) {
      const message = e instanceof ScoringError ? e.message : "Could not score hand";
      return { ok: false as const, message };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [concealedTiles, declaredMelds, bonusTiles, totalTiles, requiredSize, seatWind, roundWind, selfDraw, winningTile]);

  return (
    <section className="panel scoring-panel">
      <div className="panel-header">
        <button
          type="button"
          onClick={handleReset}
          disabled={concealedTiles.length === 0 && declaredMelds.length === 0 && bonusTiles.length === 0}
        >
          Reset
        </button>
        <button type="button" onClick={() => handScannerRef.current?.trigger()} disabled={scanBusy}>
          📷 Scan
        </button>
        <span className="tile-count">
          {totalTiles} / {requiredSize} tiles
        </span>
      </div>

      <HandScanner
        ref={handScannerRef}
        hideTrigger
        onBusyChange={setScanBusy}
        regionLabels={["Concealed", "Declared"]}
        regionIssue={declaredRegionIssue}
        onConfirm={applyScannedRegions}
      />

      <div className="scoring-context">
        <WindPicker label="Seat wind" value={seatWind} onChange={setSeatWind} />
        <WindPicker label="Round wind" value={roundWind} onChange={setRoundWind} />
        <button
          type="button"
          className={selfDraw ? "toggle-on" : undefined}
          aria-pressed={selfDraw}
          onClick={() => setSelfDraw((s) => !s)}
          title="Self-draw vs won off a discard"
        >
          Self-draw
        </button>
      </div>

      <div className="panel-header">
        <span className="panel-title">門前牌區 (Declared melds)</span>
        <PickerCollapseToggle collapsed={declaredPickerCollapsed} onToggle={() => setDeclaredPickerCollapsed((c) => !c)} />
      </div>

      {!declaredPickerCollapsed && (
        <>
          <div className="panel-header meld-kind-row">
            {(["run", "triplet", "kong"] as MeldKind[]).map((k) => (
              <button
                key={k}
                type="button"
                className={meldKind === k ? "toggle-on" : undefined}
                aria-pressed={meldKind === k}
                onClick={() => setMeldKind(k)}
              >
                {MELD_KIND_LABELS[k]}
              </button>
            ))}
            {meldKind === "kong" && (
              <button
                type="button"
                className={kongConcealed ? "toggle-on" : undefined}
                aria-pressed={kongConcealed}
                onClick={() => setKongConcealed((c) => !c)}
                title={kongConcealed ? "Concealed kong (暗槓) - self-drawn, never called" : "Exposed kong (明槓/加槓) - called or added"}
              >
                {kongConcealed ? "Concealed" : "Exposed"}
              </button>
            )}
          </div>

          <div className="tile-picker">
            {(["m", "t", "b", "z"] as Suit[])
              .filter((suit) => meldKind !== "run" || suit !== "z")
              .map((suit) => (
                <div className="suit-row" key={suit}>
                  {meldPickerTiles(meldKind)
                    .filter((t) => t.suit === suit)
                    .map((t) => (
                      <TileButton key={tileLabel(t)} tile={t} onClick={() => addMeldStartingAt(t)} disabled={!canAddMeldTile(t)} />
                    ))}
                </div>
              ))}
          </div>

          {/* Bonus tiles (flowers/seasons) - set aside in this same 門前 area the
              moment they're drawn, but not melds themselves, so they get their
              own collapsible picker independent of the Triplet/Run/Kong one
              above. */}
          <div className="panel-header bonus-tile-row">
            <span className="panel-subtitle">Bonus tiles</span>
            <PickerCollapseToggle collapsed={bonusPickerCollapsed} onToggle={() => setBonusPickerCollapsed((c) => !c)} />
          </div>

          {!bonusPickerCollapsed && (
            <div className="tile-picker">
              <div className="suit-row">
                {([1, 2, 3, 4] as const).map((rank) => {
                  const tile: BonusTile = { kind: "flower", rank };
                  return <BonusTileButton key={`flower${rank}`} tile={tile} onClick={() => addBonusTile(tile)} disabled={hasBonusTile(tile)} />;
                })}
              </div>
              <div className="suit-row">
                {([1, 2, 3, 4] as const).map((rank) => {
                  const tile: BonusTile = { kind: "season", rank };
                  return <BonusTileButton key={`season${rank}`} tile={tile} onClick={() => addBonusTile(tile)} disabled={hasBonusTile(tile)} />;
                })}
              </div>
            </div>
          )}
        </>
      )}

      {declaredMelds.length === 0 && bonusTiles.length === 0 ? (
        !declaredPickerCollapsed && (
          <span className="hint">Tap a tile above to add a declared meld (called triplet/run, or a kong) or a bonus tile.</span>
        )
      ) : (
        <div className="hand-display breakdown-groups">
          {bonusTiles.length > 0 && (
            <div className="breakdown-group bonus-tile-group">
              {bonusTiles.map((tile) => (
                <button
                  type="button"
                  key={`${tile.kind}${tile.rank}`}
                  className="bonus-tile-remove"
                  onClick={() => removeBonusTile(tile)}
                  title={`${bonusTileLabel(tile)} - tap to remove`}
                >
                  <span className="tile-glyph large" data-suit="bonus">
                    {bonusTileGlyph(tile)}
                  </span>
                </button>
              ))}
            </div>
          )}
          {declaredMelds.map((meld) => (
            <button
              type="button"
              key={meld.id}
              className={meld.concealed ? "breakdown-group concealed-kong-meld meld-remove" : "breakdown-group meld-remove"}
              onClick={() => removeMeld(meld.id)}
              title={`${meld.kind}${meld.concealed ? " (concealed kong)" : ""} - tap to remove`}
            >
              {meld.tiles.map((t, j) => (
                <TileGlyphSpan key={j} tile={t} large />
              ))}
            </button>
          ))}
        </div>
      )}

      <div className="panel-header">
        <span className="panel-title">手牌區 (Concealed hand)</span>
        <PickerCollapseToggle collapsed={concealedPickerCollapsed} onToggle={() => setConcealedPickerCollapsed((c) => !c)} />
      </div>

      {!concealedPickerCollapsed && (
        <div className="tile-picker">
          {SUIT_ORDER.map((suit) => (
            <div className="suit-row" key={suit}>
              {allTileKinds()
                .filter((t) => t.suit === suit)
                .map((t) => (
                  <TileButton
                    key={tileLabel(t)}
                    tile={t}
                    onClick={() => addConcealedTile(t)}
                    disabled={atCap || totalCopiesUsed(t) >= 4}
                  />
                ))}
            </div>
          ))}
        </div>
      )}

      <div className="hand-display">
        {concealedTiles.length === 0 ? (
          !concealedPickerCollapsed && <span className="hint">Tap tiles above for the tiles still in your hand.</span>
        ) : (
          (sortTiles(concealedTiles) as HandTile[]).map((t) => (
            <WinningTileHandButton
              key={t.id}
              tile={t}
              isWinning={isWinningTile(t)}
              onRemove={() => removeConcealedTile(t.id)}
              onToggleWinning={() => toggleWinningTile(t)}
            />
          ))
        )}
      </div>
      {concealedTiles.length > 0 && <span className="hint">Long-press a tile to mark it as the 食胡 tile (the one that completed the hand).</span>}

      {scoring && !scoring.ok && <span className="error">{scoring.message}</span>}

      {scoring?.ok && (
        <>
          <div className="waits scoring-total">
            <span className="waits-label">Total:</span>
            <span className="scoring-total-value">{scoring.result.total} tai</span>
          </div>

          <ScoringBreakdown
            matched={scoring.result.matched}
            hand={scoring.result.hand}
            declaredCount={declaredMelds.length}
            winningTile={winningTile}
          />

          {scoring.result.second && (
            <>
              <div className="waits scoring-total scoring-second-label">
                <span className="waits-label">Also (嚦咕雙食 - also reads as an ordinary hand):</span>
              </div>
              <ScoringBreakdown
                matched={scoring.result.second.matched}
                hand={scoring.result.second.hand}
                declaredCount={0}
                winningTile={winningTile}
              />
            </>
          )}
        </>
      )}
    </section>
  );
}

function App() {
  const [mode, setMode] = useState<"calculator" | "trainer" | "scoring">("calculator");
  // Lifted above TrainerPanel so stats survive switching back to the
  // Calculator tab and back - TrainerPanel itself unmounts (and its other
  // state - the in-progress question, timer, etc. - resets) on every tab
  // switch, but a session's accumulated stats shouldn't disappear with it.
  const [trainerStats, setTrainerStats] = useState<Map<string, TrainerStatsEntry>>(new Map());

  return (
    <div className="page">
      <h1>Mahjong Waits Calculator</h1>
      <div className="mode-tabs">
        <button
          type="button"
          className={mode === "calculator" ? "toggle-on" : undefined}
          aria-pressed={mode === "calculator"}
          onClick={() => setMode("calculator")}
        >
          Calculator
        </button>
        <button
          type="button"
          className={mode === "trainer" ? "toggle-on" : undefined}
          aria-pressed={mode === "trainer"}
          onClick={() => setMode("trainer")}
        >
          Trainer
        </button>
        <button
          type="button"
          className={mode === "scoring" ? "toggle-on" : undefined}
          aria-pressed={mode === "scoring"}
          onClick={() => setMode("scoring")}
        >
          Scoring
        </button>
      </div>
      {mode === "calculator" && <Calculator />}
      {mode === "trainer" && <TrainerPanel stats={trainerStats} setStats={setTrainerStats} />}
      {mode === "scoring" && <ScoringPanel />}
      <footer className="build-version">v{__BUILD_TIME__}</footer>
    </div>
  );
}

export default App;
