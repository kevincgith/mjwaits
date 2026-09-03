import {
  Fragment,
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
  type ReactNode,
} from "react";
import "./App.css";
import {
  COMPLETE_SIZE,
  MELDS_REQUIRED,
  ParseError,
  allTileKinds,
  analyzeDiscardChoices,
  analyzeDiscardEfficiency,
  decomposeEightPairs,
  decomposeHand,
  decomposeSixteenUnrelated,
  decomposeThirteenOrphans,
  formatHand,
  getWaits,
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
import {
  classToBonusTile,
  IMG_SIZE,
  detectRowRegions,
  detectTiles,
  findRotatedOutlier,
  isPairOnlyRow,
  letterbox,
  prefetchModel,
  type DetectedRegions,
  type ScanProgress,
} from "./lib/vision";
import {
  FIVE_POWER_TAI_TABLE,
  groupDeclaredTiles,
  isGenuineMultiWait,
  isVisiblyExhaustedMultiWait,
  isVisiblyTripledWinningTile,
  isWinningTileHeldConcealedElsewhere,
  ScoringError,
  scoreParsedHand,
  type BonusTile,
  type GameContext,
  type MeldKind,
  type EarlyWinState,
  type HeavenlyWinState,
  type LastTileWinState,
  type MultiWinState,
  type ParsedScoringHand,
  type ResolvedHand,
  type RiichiState,
  type ScoreResult,
  type TaiPattern,
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
      <rect className="detection-label-bg" x={x1} y={y2 - 16} width={labelWidth} height={16} />
      <text className="detection-label" x={x1 + 3} y={y2 - 1}>
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
// replace the model's guess with the right tile or a specific bonus tile
// (the model sometimes calls a real tile a bonus one or vice versa), or
// remove the box outright for an outright false-positive detection - a
// false positive has no "keep the box but mark it excluded" state, since
// a box that isn't a tile at all shouldn't still show as a lingering grey
// box on the review image; removing it is the only outcome that makes
// sense, so there's a single "Remove box" action for it, not a separate
// "not a tile" pick that leaves a phantom box behind.
type Correction = { tile: Tile } | { bonus: BonusTile };

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
        <button type="button" className="correction-panel-remove" onClick={onRemove}>
          Not a tile - remove box
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

// A literal no-op, for a useTapAndLongPress caller that wants its
// long-press gesture to genuinely do nothing (see DeclaredMeldButton) -
// one shared reference rather than a fresh arrow function per render.
const NOOP = () => {};

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

// 門前牌區's declared-meld group: tap still removes it, same as before -
// for a kong specifically, long-press instead flips it between 暗槓
// (concealed) and 明槓 (exposed), same tap/long-press split as
// WinningTileHandButton above. Non-kong melds have no concealed/exposed
// distinction to flip, so their long-press is a deliberate no-op (not
// wired to onRemove either) - holding past LONG_PRESS_MS on a
// triplet/run does nothing at all, same as it would on a static label.
function DeclaredMeldButton({
  meld,
  onRemove,
  onToggleConcealed,
}: {
  meld: DeclaredMeldTile;
  onRemove: () => void;
  onToggleConcealed: () => void;
}) {
  const isKong = meld.kind === "kong";
  const tap = useTapAndLongPress(onRemove, isKong ? onToggleConcealed : NOOP);
  const title = isKong
    ? `${meld.kind} (${meld.concealed ? "concealed" : "exposed"} kong) - tap to remove, long-press to turn ${meld.concealed ? "exposed (明槓)" : "concealed (暗槓)"}`
    : `${meld.kind} - tap to remove`;
  return (
    <button
      type="button"
      className={meld.concealed ? "breakdown-group concealed-kong-meld meld-remove" : "breakdown-group meld-remove"}
      title={title}
      {...tap}
    >
      {meld.tiles.map((t, j) => (
        <TileGlyphSpan key={j} tile={t} large />
      ))}
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

// The lower of the 2 default boxes, computed once (nonOverlappingRegion is
// pure, so this is deterministic) - shared by the crop overlay's initial
// state, Reset, and post-rotate reset, all of which now default to 2
// regions (most photos have both a concealed and a declared area to crop).
// Kept as a stable reference, like DEFAULT_CROP itself, so a straight `===`
// check (see the Reset button's `disabled` prop) still cheaply detects
// "already at the default" instead of a deep-equality comparison.
const DEFAULT_LOWER_CROP: CropRect = nonOverlappingRegion(DEFAULT_CROP, REGION_W, REGION_H);
// Region 0 is always Concealed, region 1 always Declared (see
// applyScannedRegions/declaredRegionIssue) - independent of that, this
// controls which one starts on top: Declared (using DEFAULT_CROP's own
// upper/centered position) above, Concealed (DEFAULT_LOWER_CROP) near the
// bottom, matching the scan review's own Declared-before-Concealed order.
const defaultCropRegions = (): CropRect[] => [DEFAULT_LOWER_CROP, DEFAULT_CROP];

// Converts a detectRowRegions result into the [Concealed, Declared] region
// order this app uses everywhere else, or null if there's no result or the
// padded box(es) it computed don't actually fit/fail to clear each other -
// shared by HandScanner's initial pre-crop-screen fit and CropOverlay's own
// on-demand/post-rotate re-fit, so both apply the exact same sanity check
// before ever handing a detected layout to the crop screen.
//
// A result with no `declared` (see DetectedRegions' own comment - a fully
// concealed hand with no bonus tiles at all to split it by) fits a
// single-region [Concealed] array instead of the usual 2 - CropOverlay
// already supports starting in this 1-region mode (see its own "+ Add
// region" affordance), so this still gives the user a real head start
// instead of falling back to both fixed defaults over one confidently
// detected box.
function fittedRegionsFrom(result: DetectedRegions | null): CropRect[] | null {
  if (!result) return null;
  if (!result.declared) return fitsInFrame(result.concealed) ? [result.concealed] : null;
  const fitted: CropRect[] = [result.concealed, result.declared];
  return fitted.every(fitsInFrame) && !rectsOverlap(fitted[0], fitted[1]) ? fitted : null;
}

// Best-effort wrapper around detectRowRegions - never throws (a slow/broken
// model shouldn't block whatever's calling this, same "swallow it, the
// real scan surfaces real errors later" reasoning as prefetchModel), and
// already applies fittedRegionsFrom's own sanity check.
async function tryAutoFit(image: HTMLImageElement): Promise<CropRect[] | null> {
  try {
    return fittedRegionsFrom(await detectRowRegions(image));
  } catch {
    return null;
  }
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

// Redraws `source` rotated a quarter turn (clockwise or counterclockwise)
// onto a canvas (swapping width/height, since a photo shot sideways needs
// that swap to display upright) and loads the result back into a fresh
// <img> - phone cameras don't always agree with the browser on which way is
// up, and unlike a CSS transform, baking the rotation into real pixels
// means every downstream consumer (crop math, the detector) just sees an
// already-upright image and needs no rotation-awareness of its own.
function rotateImage(source: HTMLImageElement, clockwise: boolean): Promise<HTMLImageElement> {
  const w = source.naturalWidth;
  const h = source.naturalHeight;
  const canvas = document.createElement("canvas");
  canvas.width = h;
  canvas.height = w;
  const ctx = canvas.getContext("2d")!;
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate(clockwise ? Math.PI / 2 : -Math.PI / 2);
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
  initialRegions,
  regionLabels,
  onConfirm,
  onCancel,
}: {
  image: HTMLImageElement;
  // The regions to start with - either a row-detection auto-fit result or
  // defaultCropRegions(), decided by the caller (see handleScanFile) before
  // this ever mounts, so this component doesn't need its own opinion on
  // when detection succeeded vs. should fall back.
  initialRegions: CropRect[];
  // Badge text for each crop box once a 2nd region is added, e.g. ["Concealed",
  // "Declared"] on the scoring tab where the two regions mean different things -
  // falls back to plain 1-based numbers (the Calculator's case, where both
  // regions are just different crops of the same hand).
  regionLabels?: string[];
  onConfirm: (canvases: HTMLCanvasElement[]) => void;
  onCancel: () => void;
}) {
  const [regions, setRegions] = useState<CropRect[]>(initialRegions);
  // The image actually shown/measured/cropped - starts as the `image` prop
  // but is swapped out (via rotateImage) whenever the user rotates, never
  // mutating the prop itself. Rotating changes the aspect ratio for a
  // quarter or three-quarter turn, so any regions drawn against the old
  // orientation would land on the wrong area - see handleRotate.
  const [displayImage, setDisplayImage] = useState(image);
  const [rotating, setRotating] = useState(false);
  // True while a manual or post-rotate re-fit is running (see
  // handleAutoFitClick/handleRotate) - separate from `rotating` since a
  // plain Autofit tap doesn't rotate anything, but both block the same set
  // of buttons below to avoid overlapping mutations of `regions`.
  const [autoFitting, setAutoFitting] = useState(false);
  const busy = rotating || autoFitting;
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

  // Re-runs row-detection against `img` (see handleAutoFitClick/handleRotate,
  // its two callers) and applies the result if it found one - unlike the
  // initial pre-crop-screen fit (HandScanner), this always resolves the
  // `autoFitting` flag itself so callers can freely `await` it.
  const runAutoFit = async (img: HTMLImageElement): Promise<CropRect[] | null> => {
    setAutoFitting(true);
    const fitted = await tryAutoFit(img);
    setAutoFitting(false);
    return fitted;
  };

  const handleRotate = async (clockwise: boolean) => {
    setRotating(true);
    try {
      const rotated = await rotateImage(displayImage, clockwise);
      setDisplayImage(rotated);
      // The old regions are invalid regardless (rotating changes the
      // aspect ratio) - re-fit against the now-upright photo, falling back
      // to the fixed defaults same as before if that doesn't find a clean
      // 2-row split.
      setRegions((await runAutoFit(rotated)) ?? defaultCropRegions());
    } finally {
      setRotating(false);
    }
  };

  // Unlike handleRotate's forced fallback, a manual re-fit request that
  // doesn't find a clean 2-row split leaves the current regions alone -
  // the user may have already hand-positioned them, and an on-demand
  // "improve this" action shouldn't silently discard that when it can't.
  const handleAutoFitClick = async () => {
    const fitted = await runAutoFit(displayImage);
    if (fitted) setRegions(fitted);
  };

  // Swaps which existing box is labelled Concealed vs Declared without
  // moving either one - region 0 is always Concealed and region 1 always
  // Declared (see applyScannedRegions/declaredRegionIssue), so fixing a
  // labelling mistake (whether from auto-fit's own guess or the user's own
  // framing) only ever means reordering the array, never redrawing boxes.
  const swapRegions = () => setRegions((prev) => (prev.length === 2 ? [prev[1], prev[0]] : prev));

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

  // With MAX_REGIONS fixed at 2, "add a region" and "remove down to 1" are
  // really just the two states of one toggle - a user only ever has 1 hand
  // or 2 hands to crop, never a variable count worth an open-ended "add
  // another" button. Dropping back to 1 always keeps the first region (the
  // per-rect remove button below still lets you remove either one
  // specifically if the second one was actually the one worth keeping).
  const toggleRegionCount = () =>
    setRegions((prev) => (prev.length >= MAX_REGIONS ? [prev[0]] : [...prev, nonOverlappingRegion(prev[0], REGION_W, REGION_H)]));
  const removeRegion = (index: number) => setRegions((prev) => prev.filter((_, i) => i !== index));
  const resetRegions = () => setRegions(defaultCropRegions());

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
          <button type="button" onClick={() => handleRotate(false)} disabled={busy} title="Rotate photo 90° counterclockwise">
            ⟲
          </button>
          <button type="button" onClick={() => handleRotate(true)} disabled={busy} title="Rotate photo 90° clockwise">
            ⟳
          </button>
          <button
            type="button"
            onClick={handleAutoFitClick}
            disabled={busy}
            title={
              autoFitting
                ? "Autofitting…"
                : "Autofit - re-run row detection against the current photo and re-fit the region(s) to whatever it finds; leaves them alone if it doesn't find a clean fit"
            }
          >
            🪄
          </button>
        </div>
        <div className="crop-actions-top-right">
          <button
            type="button"
            className={regions.length >= MAX_REGIONS ? "toggle-on" : undefined}
            aria-pressed={regions.length >= MAX_REGIONS}
            onClick={toggleRegionCount}
            disabled={busy}
            title={
              regions.length >= MAX_REGIONS
                ? "Tap to go back to 1 region"
                : "Tap to add a 2nd region (e.g. two separate hands in one photo)"
            }
          >
            {regions.length >= MAX_REGIONS ? "2 regions" : "+ Add region"}
          </button>
          <button
            type="button"
            onClick={swapRegions}
            disabled={busy || regions.length !== 2}
            title="Swap regions - swap which box is Concealed and which is Declared, without moving either one"
          >
            ⇄
          </button>
          <button
            type="button"
            onClick={resetRegions}
            disabled={busy || (regions.length === 2 && regions[0] === DEFAULT_LOWER_CROP && regions[1] === DEFAULT_CROP)}
          >
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
  // capture="environment" on `trigger`'s file input skips straight to the
  // camera on mobile, which is what most scans want - but that camera
  // sheet is camera-only on iOS Safari, with no way back to an existing
  // photo from inside it. triggerLibrary opens a second, capture-less
  // file input instead, landing on the OS's own Photo Library/Browse
  // picker (or its full Camera/Library/Browse action sheet, depending on
  // platform) for the person who already has the photo taken.
  triggerLibrary: () => void;
  // Discards whatever the scan flow is currently doing - mid-crop, mid-
  // download/detect, or sitting on a finished review - and drops back to
  // idle. Used by ScoringPanel's Reset button so wiping the hand also
  // dismisses an in-progress scan rather than leaving it running/showing
  // underneath the now-empty hand. Doesn't abort the underlying model
  // fetch itself (see resetScan's own comment) - only the local UI state.
  reset: () => void;
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
    // Fires whenever scanStatus moves in or out of "idle" entirely -
    // broader than onBusyChange (also true during "review"/"error", not
    // just "cropping"/"loading"). ScoringPanel uses this to keep its Reset
    // button enabled while a scan is in progress even when the hand itself
    // is still empty, since Reset is also this flow's only cancel button
    // once the scan is running (see HandScannerHandle.reset).
    onActiveChange?: (active: boolean) => void;
  }
>(function HandScanner(
  { regionLabels, regionIssue, onConfirm, hideTrigger, triggerLabel = "📷 Scan a hand", onBusyChange, onActiveChange },
  ref
) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const libraryFileInputRef = useRef<HTMLInputElement>(null);
  const [scanStatus, setScanStatus] = useState<"idle" | "analyzing" | "cropping" | "loading" | "review" | "error">("idle");
  const [scanError, setScanError] = useState<string | null>(null);
  const [scanProgress, setScanProgress] = useState<ScanProgress | null>(null);
  const [scanPreview, setScanPreview] = useState<{ regions: ScanReviewRegion[] } | null>(null);
  const [editingDetectionId, setEditingDetectionId] = useState<number | null>(null);
  const nextDetectionId = useRef(0);
  const [cropImage, setCropImage] = useState<HTMLImageElement | null>(null);
  // Row-detection's guess at where the 2 crop regions should start (see
  // handleScanFile) - null falls back to defaultCropRegions() untouched,
  // either because detection hasn't run yet, found something other than a
  // clean 2-row split, or failed outright.
  const [autoFitRegions, setAutoFitRegions] = useState<CropRect[] | null>(null);
  // Bumped by resetScan to invalidate whatever runScan call is currently
  // in flight - its await'd detectTiles call has no way to actually abort
  // (and shouldn't: the model fetch it shares is cached module-wide, see
  // vision.ts's sessionPromise, so aborting would break the *next* scan
  // too), but this stops its result from clobbering the idle state resetScan
  // just set once it does resolve.
  const scanGeneration = useRef(0);

  const triggerScan = () => {
    // Starts the (large) model download as soon as the user shows intent
    // to scan, rather than after they've picked and cropped a photo - by
    // the time runScan needs it, it's often already downloaded or well
    // underway.
    prefetchModel();
    fileInputRef.current?.click();
  };
  const triggerScanLibrary = () => {
    prefetchModel();
    libraryFileInputRef.current?.click();
  };
  const resetScan = () => {
    scanGeneration.current++;
    setScanStatus("idle");
    setScanError(null);
    setScanProgress(null);
    setScanPreview(null);
    setEditingDetectionId(null);
    setCropImage(null);
    setAutoFitRegions(null);
  };
  useImperativeHandle(ref, () => ({ trigger: triggerScan, triggerLibrary: triggerScanLibrary, reset: resetScan }));

  const busy = scanStatus === "cropping" || scanStatus === "loading" || scanStatus === "analyzing";
  useEffect(() => {
    onActiveChange?.(scanStatus !== "idle");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanStatus]);
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
      tile: "tile" in correction ? correction.tile : null,
      bonus: "bonus" in correction ? correction.bonus : null,
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
    const myGeneration = scanGeneration.current;
    setScanError(null);
    try {
      const image = await loadImageFile(file);
      if (scanGeneration.current !== myGeneration) return; // reset mid-read - drop the result
      setCropImage(image);
      setScanStatus("analyzing");
      // Best-effort: run detection on the whole photo to see if it already
      // splits into 2 clear rows (declared melds, concealed hand) worth
      // seeding the crop regions with - never lets a slow/broken model
      // block the crop screen from appearing (see tryAutoFit's own comment).
      const fitted = await tryAutoFit(image);
      if (scanGeneration.current !== myGeneration) return; // reset mid-analyze - drop the result
      if (fitted) setAutoFitRegions(fitted);
      setScanStatus("cropping");
    } catch (err) {
      if (scanGeneration.current !== myGeneration) return;
      setScanError(err instanceof Error ? err.message : "Could not read that image");
      setScanStatus("error");
    }
  };

  // Each region (1 or 2, from CropOverlay) is letterboxed and detected
  // independently. The (cached) model session is only fetched/initialized
  // once regardless of region count.
  const runScan = async (sources: HTMLCanvasElement[]) => {
    const myGeneration = scanGeneration.current;
    setScanStatus("loading");
    setScanError(null);
    setScanProgress({ phase: "downloading-model", loaded: 0, total: null });
    try {
      const regions: ScanReviewRegion[] = [];
      for (const source of sources) {
        const box = letterbox(source);
        const { detections } = await detectTiles(box, (p) => {
          if (scanGeneration.current === myGeneration) setScanProgress(p);
        });
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
      if (scanGeneration.current !== myGeneration) return; // reset mid-scan - drop the result
      setScanPreview({ regions });
      setScanStatus("review");
    } catch (err) {
      if (scanGeneration.current !== myGeneration) return;
      setScanError(err instanceof Error ? err.message : "Could not scan that photo");
      setScanStatus("error");
    } finally {
      if (scanGeneration.current === myGeneration) {
        setScanProgress(null);
        setCropImage(null);
      }
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

  // With hideTrigger (an external button drives this instead - see the
  // Scoring tab's own Scan button), .scan-input renders nothing visible at
  // all while idle - just the always-present hidden file input. Its
  // divider/spacing styling still applied unconditionally, though, leaving
  // a bare horizontal rule floating in a chunk of empty margin+padding
  // above whatever comes next. Drop that styling in exactly this "nothing
  // to show" case so the section that follows just gets the normal single
  // gap.
  const scanInputEmpty = hideTrigger && scanStatus !== "analyzing" && scanStatus !== "loading" && scanStatus !== "error";

  return (
    <>
      <div className={`scan-input${scanInputEmpty ? " empty" : ""}`}>
        {/* capture="environment" skips straight to the rear camera on
            mobile instead of the OS's Photo Library/Camera/Browse action
            sheet - a tap saved on the common case of scanning a hand right
            in front of you. That camera sheet is camera-only on iOS Safari
            though, with no way back to an existing photo from inside it -
            libraryFileInputRef (no capture) is the escape hatch for someone
            who already has the photo taken, wired to its own trigger below.
            Desktop browsers ignore capture entirely either way. */}
        <input ref={fileInputRef} type="file" accept="image/*" capture="environment" onChange={handleScanFile} style={{ display: "none" }} />
        <input ref={libraryFileInputRef} type="file" accept="image/*" onChange={handleScanFile} style={{ display: "none" }} />
        {!hideTrigger && (
          <span className="scan-trigger-group">
            <button type="button" onClick={triggerScan} disabled={busy}>
              {scanStatus === "loading" ? scanStatusLabel(scanProgress) : scanStatus === "analyzing" ? "Analyzing layout…" : triggerLabel}
            </button>
            {scanStatus !== "loading" && scanStatus !== "analyzing" && (
              <button type="button" className="scan-library-link" onClick={triggerScanLibrary} disabled={busy}>
                or choose from Photos
              </button>
            )}
          </span>
        )}
        {scanStatus === "analyzing" && (
          <div className="scan-progress">
            <div className="scan-progress-track" role="progressbar" aria-label="Analyzing photo layout…" aria-valuemin={0} aria-valuemax={100}>
              <div className="scan-progress-fill indeterminate" />
            </div>
          </div>
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
        <CropOverlay
          image={cropImage}
          initialRegions={autoFitRegions ?? defaultCropRegions()}
          regionLabels={regionLabels}
          onConfirm={runScan}
          onCancel={cancelCrop}
        />
      )}

      {scanStatus === "review" && scanPreview && (
        <div className="scan-review">
          <div className="scan-review-images">
            {/* Displayed last-to-first (Declared before Concealed, for the
                Scoring tab's 2-region case) - purely a display-order choice,
                region indices/labels/regionIssues below are still keyed by
                their real index (0 = Concealed, 1 = Declared), untouched
                everywhere else (applyScannedRegions, declaredRegionIssue,
                the crop step itself). */}
            {[...scanPreview.regions.entries()].reverse().map(([i, region]) => (
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
                [...scanPreview.regions.entries()].reverse().map(([i, region]) => {
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
const WIND_SHORT: Record<Wind, string> = { 1: "東", 2: "南", 3: "西", 4: "北" };

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
      className={`icon-toggle${collapsed ? "" : " open"}`}
      onClick={onToggle}
      aria-expanded={!collapsed}
      title={collapsed ? "Show tile picker" : "Hide tile picker"}
    >
      ▸
    </button>
  );
}

// Wraps a collapsible section's content so toggling it animates smoothly
// instead of the content just popping in/out. Content stays mounted at all
// times (collapsed just drives the CSS) - grid-template-rows: 0fr collapses
// a track to zero height the same way height: 0 would, but without needing
// to know the content's own height up front (which a plain height
// transition would, since these sections' content is variable - a
// different number of declared melds, waits, etc). See .collapsible-panel
// in App.css.
function CollapsiblePanel({
  open,
  className,
  children,
}: {
  open: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={`collapsible-panel${open ? " open" : ""}${className ? ` ${className}` : ""}`}>
      <div className="collapsible-panel-inner">{children}</div>
    </div>
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

// The declared-melds picker's own kind selector - 4 flat peer choices, kong
// split up front into concealed/exposed rather than a single "Kong" choice
// plus a same-styled modifier button that only appeared once Kong was
// picked (that read as a hidden 4th peer option shifting the row in and
// out, not as a modifier of Kong - see git history). scoring.ts's own
// MeldKind stays a plain "triplet" | "run" | "kong" (concealed/exposed is
// a separate `concealed` field there, on MeldDeclaration) - this is a
// UI-only split, collapsed back via meldPickerUnderlyingKind below.
type MeldPickerKind = "run" | "triplet" | "concealed-kong" | "exposed-kong";
const MELD_PICKER_LABELS: Record<MeldPickerKind, string> = {
  run: "上",
  triplet: "碰",
  "concealed-kong": "暗槓",
  "exposed-kong": "明槓",
};
const meldPickerUnderlyingKind = (k: MeldPickerKind): MeldKind => (k === "run" || k === "triplet" ? k : "kong");
const meldPickerIsConcealed = (k: MeldPickerKind): boolean => k === "concealed-kong";

// 叮's declared state cycles through these 4 steps on each tap, wrapping
// back to "none" - see the Self-draw row in ScoringPanel.
const RIICHI_CYCLE: RiichiState[] = ["none", "riichi", "heavenly-riichi", "earthly-riichi"];
const RIICHI_LABELS: Record<RiichiState, string> = {
  none: "叮",
  riichi: "叮",
  "heavenly-riichi": "天叮",
  "earthly-riichi": "地叮",
};

// Same cycling idiom as RIICHI_CYCLE, for 四子內/七子內/十子內.
const EARLY_WIN_CYCLE: EarlyWinState[] = ["none", "four", "seven", "ten"];
const EARLY_WIN_LABELS: Record<EarlyWinState, string> = {
  none: "四子內",
  four: "四子內",
  seven: "七子內",
  ten: "十子內",
};

// Same cycling idiom, for 雙響/三響 - only 3 steps (no plain "off" label
// distinct from a first named step needed beyond "none" itself).
const MULTI_WIN_CYCLE: MultiWinState[] = ["none", "double", "triple"];
const MULTI_WIN_LABELS: Record<MultiWinState, string> = {
  none: "雙響",
  double: "雙響",
  triple: "三響",
};

// Same cycling idiom, for 天胡/地胡/人胡.
const HEAVENLY_WIN_CYCLE: HeavenlyWinState[] = ["none", "heaven", "earth", "man"];
const HEAVENLY_WIN_LABELS: Record<HeavenlyWinState, string> = {
  none: "天胡",
  heaven: "天胡",
  earth: "地胡",
  man: "人胡",
};
// 天胡 (the dealer's initial deal is already complete, before anyone
// discards) forces 自摸 on, same reasoning as 花摸/槓摸/海底撈月 above -
// 地胡/人胡 are deliberately left alone here, not asserted either way.
const isSelfDrawHeavenlyWin = (s: HeavenlyWinState): boolean => s === "heaven";

// Same cycling idiom, for 河底撈魚/海底撈月 - 海底撈月(一筒) isn't its own
// state to cycle to (see LastTileWinState's own comment in scoring.ts): it
// fires automatically, behind the scenes, whenever 海底撈月 coincides with
// a self-drawn 1 Tong.
const LAST_TILE_WIN_CYCLE: LastTileWinState[] = ["none", "river-bottom", "sea-bottom"];
const LAST_TILE_WIN_LABELS: Record<LastTileWinState, string> = {
  none: "河底撈魚",
  "river-bottom": "河底撈魚",
  "sea-bottom": "海底撈月",
};
// Both lastTileWin states (per this house rule, including 河底撈魚) force
// 自摸 on - only "none" doesn't.
const isSelfDrawLastTileWin = (s: LastTileWinState): boolean => s !== "none";

// 花摸/槓摸/搶槓 cycle through a plain count instead of named states - tap
// advances 0 -> 1 -> ... -> max -> 0. Label shows "花摸xN" once N > 0, or
// just the bare name at 0 (matching the other cycling buttons' "off"
// label being the same text as their first active step).
const cycleCount = (current: number, max: number) => (current + 1) % (max + 1);
const countLabel = (base: string, count: number) => (count === 0 ? base : `${base}x${count}`);

// 莊's own label - doesn't fit countLabel's "base"/"basexN" shape: n<=1
// reads as plain "莊" (off at n=0, just-activated-with-no-streak-yet at
// n=1 - same label either way, distinguished only by toggle-on styling),
// n>=2 reads as "莊連(n-1)" (an (n-1)-win streak) - see GameContext's own
// dealerStreak comment for why n and the displayed streak number differ
// by 1.
const dealerStreakLabel = (n: number): string => (n <= 1 ? "莊" : `莊連${n - 1}`);

// 明絕/絕絕 share a single button - 絕絕 is structurally a strictly stronger
// finding than 明絕 (see isVisiblyExhaustedMultiWait's doc comment in
// scoring.ts: whenever the multi-way wait is exhausted, the winning tile's
// own declared count is necessarily already 3, i.e. 明絕's own condition),
// so they read naturally as one three-step scale rather than two
// independent toggles. This state is purely a UI grouping - GameContext
// still takes the two original manualVisibleTripleWin/
// manualVisibleExhaustedMultiWait booleans, derived from this below.
type VisibleExhaustState = "none" | "triple" | "exhausted";
const VISIBLE_EXHAUST_CYCLE: VisibleExhaustState[] = ["none", "triple", "exhausted"];
const VISIBLE_EXHAUST_RANK: Record<VisibleExhaustState, number> = { none: 0, triple: 1, exhausted: 2 };
const VISIBLE_EXHAUST_LABELS: Record<VisibleExhaustState, string> = {
  none: "明絕",
  triple: "明絕",
  exhausted: "絕絕",
};

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

// Glyphs + English names for the 8 bonus tiles, keyed by `rank` = the NUMBER
// PAINTED ON THE TILE. That painted number is what the vision model reports
// (class "3f" etc., see classToBonusTile in vision.ts) and what 正花/爛花 pair
// against the seat wind (scoring.ts) - so `rank` itself must always mean the
// painted number; only the rank->codepoint map below bends to fit Unicode.
//
// Flowers, conventional numbering (as painted on a physical set, and how the
// MahjongVis training data is labelled):
//     梅1 Plum   蘭2 Orchid   菊3 Chrysanthemum   竹4 Bamboo
// Flowers, Unicode "Mahjong Tiles" block order (right after circles 1F019-
// 1F021, before Joker 1F02A):
//     1F022 Plum   1F023 Orchid   1F024 Bamboo   1F025 Chrysanthemum
// i.e. the block puts BAMBOO and CHRYSANTHEMUM in the opposite order to the
// painted numbers - commonly described as an error in the block's ordering.
// It's only the ordering: the codepoint *names*, and the fonts that follow
// them (Apple Symbols / Noto Sans Symbols 2 / Segoe UI Symbol, our stack in
// App.css), are self-consistent - 1F024 draws 竹, 1F025 draws 菊. So we map
// rank 3 -> 1F025 and rank 4 -> 1F024 on purpose, so a scanned "3" tile
// (chrysanthemum) renders as a chrysanthemum rather than as bamboo.
//
// Seasons have no such issue: painted 春1 夏2 秋3 冬4 matches the block order
// 1F026-1F029 one-to-one, so SEASON_CODEPOINTS is a plain sequential map.
const FLOWER_CODEPOINTS: Record<1 | 2 | 3 | 4, number> = { 1: 0x1f022, 2: 0x1f023, 3: 0x1f025, 4: 0x1f024 };
const SEASON_CODEPOINTS: Record<1 | 2 | 3 | 4, number> = { 1: 0x1f026, 2: 0x1f027, 3: 0x1f028, 4: 0x1f029 };
const FLOWER_NAMES: Record<1 | 2 | 3 | 4, string> = { 1: "Plum", 2: "Orchid", 3: "Chrysanthemum", 4: "Bamboo" };
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
// rather than taking whichever group happens to render first. Declared
// melds are never searched at all (see `declaredCount`, used only to slice
// them off): the 食胡 tile is set via long-press on a CONCEALED-hand tile
// (see WinningTileHandButton) - a declared meld is entered as a complete,
// already-exposed group from the start, never "waiting" on a tile, so it
// can never be the one that actually completed the hand. Without this
// exclusion, a rank held both in a declared meld and a concealed one (e.g.
// declared 888t plus a concealed 789t run) would wrongly match the
// declared copy first, highlighting the wrong section entirely - and since
// a declared triplet/kong's 3-4 tiles are literally the same object
// repeated (see pushMeld in ScoringPanel), a reference-equality highlight
// check would then light up every tile in that meld at once.
function findWinningTileInstance(hand: ResolvedHand, declaredCount: number, winningTile: Tile | null): Tile | null {
  if (winningTile === null) return null;
  const matches = (t: Tile) => t.suit === winningTile.suit && t.rank === winningTile.rank;
  const pairMatch = hand.pair.find(matches);
  if (pairMatch) return pairMatch;
  const concealedMelds = hand.melds.slice(declaredCount);
  for (const kind of ["triplet", "kong"] as const) {
    for (const meld of concealedMelds) {
      if (meld.kind !== kind) continue;
      const t = meld.tiles.find(matches);
      if (t) return t;
    }
  }
  for (const meld of concealedMelds) {
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
// One row of the Patterns list - tappable to expand the specific tiles
// behind that pattern's tai, when it has any (see TaiPattern.tiles). A
// pure game-context pattern (自摸, riichi, dealer streak, and similar)
// has no `tiles` at all - nothing to point at - so it just renders as a
// plain, non-interactive row, same look as before this feature existed.
// Same tap-to-expand idiom as ProjectedWaitRow (own collapsed-by-default
// state, CollapsiblePanel for the animated reveal).
//
// Separately, once expanded, each individual meld/pair group shown in the
// breakdown is itself press-able: press and hold one and it lights up
// back in the DECLARED/CONCEALED summary below (see ScoringBreakdown's
// pressedGroup) - momentary, gone the instant the finger/mouse lifts, and
// independent of the row's own expanded/collapsed state (which stays
// exactly as it was, driven only by the row's onClick). onPointerLeave is
// a mouse-only safety net: a touch pointer has implicit capture (see the
// useTap comment above) so it always still gets pointerup/pointercancel
// here even if the finger drifts off the group first, but a mouse has no
// such capture - button-mashing then dragging off before releasing would
// otherwise leave the highlight stuck on with no pointerup ever landing
// on this element to clear it.
function PatternRow({
  pattern,
  tai,
  hand,
  ctx,
  onGroupPressStart,
  onGroupPressEnd,
}: {
  pattern: TaiPattern;
  tai: number;
  hand: ResolvedHand;
  ctx: GameContext;
  onGroupPressStart: (group: Tile[]) => void;
  onGroupPressEnd: (group: Tile[]) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const rows = pattern.tiles?.(hand, ctx);
  if (!rows || rows.length === 0) {
    return (
      <div className="pattern-row">
        <div className="scoring-pattern-row" title={pattern.caveat}>
          <span className="scoring-pattern-name">{pattern.name}</span>
          <span className="scoring-pattern-meta">
            <span className="scoring-pattern-tai">{tai} tai</span>
            {/* Reserves the same width a caret takes on a tappable row,
                invisibly, so the tai column still lines up between plain
                and tappable rows instead of a non-expandable row's tai
                sitting further right with nothing after it. */}
            <span className="projected-wait-caret" aria-hidden="true" style={{ visibility: "hidden" }}>
              ▸
            </span>
          </span>
        </div>
      </div>
    );
  }
  return (
    <div className="pattern-row">
      <button type="button" className="scoring-pattern-row" onClick={() => setExpanded((e) => !e)} aria-expanded={expanded} title={pattern.caveat}>
        <span className="scoring-pattern-name">{pattern.name}</span>
        <span className="scoring-pattern-meta">
          <span className="scoring-pattern-tai">{tai} tai</span>
          <span className={`projected-wait-caret${expanded ? " open" : ""}`} aria-hidden="true">
            ▸
          </span>
        </span>
      </button>
      <CollapsiblePanel open={expanded}>
        <div className="scoring-pattern-tiles">
          {/* One row per matched instance (see TaiPattern.tiles) - a
              stacking pattern with several instances (e.g. 3 separate
              步步高 windows) renders as 3 separate rows, rather than every
              instance's melds all wrapping together into one undifferentiated
              block. */}
          {rows.map((row, i) => (
            <div className="breakdown-groups" key={i}>
              {row.map((group, j) => (
                <span
                  className="breakdown-group"
                  key={j}
                  onPointerDown={() => onGroupPressStart(group)}
                  onPointerUp={() => onGroupPressEnd(group)}
                  onPointerCancel={() => onGroupPressEnd(group)}
                  onPointerLeave={() => onGroupPressEnd(group)}
                >
                  {group.map((t, k) => (
                    <TileGlyphSpan key={k} tile={t} />
                  ))}
                </span>
              ))}
            </div>
          ))}
        </div>
      </CollapsiblePanel>
    </div>
  );
}

function ScoringBreakdown({
  matched,
  hand,
  declaredCount,
  winningTile,
  ctx,
}: {
  matched: ScoreResult["matched"];
  hand: ResolvedHand;
  declaredCount: number;
  winningTile: Tile | null;
  ctx: GameContext;
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
  const winningInstance = findWinningTileInstance(hand, declaredCount, winningTile);
  const isWinningInstance = (t: Tile): boolean => t === winningInstance;
  // The one meld/pair group (if any) currently being pressed under an
  // expanded pattern's breakdown below - momentary, not the same as that
  // row's own expanded/collapsed state (see PatternRow's own comment).
  // Every TaiPattern.tiles implementation derives its groups by filtering
  // hand.melds/hand.pair's own arrays rather than fabricating new Tile
  // objects (see e.g. wholeHandGroupsFlat and the rest of scoring.ts), and
  // each returned group is always exactly one meld's own tiles array or
  // hand.pair itself, never a hand-built combination of pieces from more
  // than one (see TaiPattern.tiles' own doc comment - "one group per
  // relevant unit"). So a pressed group is the very same array reference
  // as some meld.tiles/hand.pair below - plain reference equality is
  // enough to find which one, lighting up that whole meld as one box
  // (same idea as .concealed-kong-meld) rather than each tile separately.
  const [pressedGroup, setPressedGroup] = useState<Tile[] | null>(null);
  const isGroupHighlighted = (group: Tile[]): boolean => group === pressedGroup;
  // Declaration order (the default) already reads as a rough thematic
  // grouping - PATTERNS is authored one related family at a time - so
  // sorting by tai is opt-in rather than the default, same "toggle changes
  // the view, doesn't change what fired" spirit as the projected-waits
  // list's own score/tile sort toggle. Both tai directions keep their ties
  // in original order for free (Array.prototype.sort is stable).
  const patternSortCycle = ["order", "tai-desc", "tai-asc"] as const;
  type PatternSort = (typeof patternSortCycle)[number];
  const [patternSort, setPatternSort] = useState<PatternSort>("order");
  const displayedMatched =
    patternSort === "order"
      ? matched
      : [...matched].sort((a, b) => (patternSort === "tai-desc" ? b.tai - a.tai : a.tai - b.tai));
  const patternSortLabel: Record<PatternSort, string> = { order: "Sort: order", "tai-desc": "Sort: tai ↓", "tai-asc": "Sort: tai ↑" };
  const patternSortTitle: Record<PatternSort, string> = {
    order: "Sorted in the order they were checked - tap to sort by tai, highest first",
    "tai-desc": "Sorted by tai, highest first - tap to sort by tai, lowest first",
    "tai-asc": "Sorted by tai, lowest first - tap to sort by the order they were checked",
  };
  return (
    <>
      <div className="waits breakdown-list">
        <div className="projected-waits-header">
          <span className="waits-label">Patterns:</span>
          {matched.length > 1 && (
            <button
              type="button"
              className="projected-sort-toggle"
              onClick={() => setPatternSort((s) => patternSortCycle[(patternSortCycle.indexOf(s) + 1) % patternSortCycle.length])}
              title={patternSortTitle[patternSort]}
            >
              {patternSortLabel[patternSort]}
            </button>
          )}
        </div>
        {matched.length === 0 ? (
          <span className="hint">No patterns matched yet — this is an early version, more get added over time.</span>
        ) : (
          displayedMatched.map(({ pattern, tai }) => (
            <PatternRow
              key={pattern.id}
              pattern={pattern}
              tai={tai}
              hand={hand}
              ctx={ctx}
              onGroupPressStart={setPressedGroup}
              onGroupPressEnd={(group) => setPressedGroup((g) => (g === group ? null : g))}
            />
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
                className={["breakdown-group", meld.concealed && "concealed-kong-meld", isGroupHighlighted(meld.tiles) && "pattern-highlighted"]
                  .filter(Boolean)
                  .join(" ")}
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
              <span
                className={`breakdown-group${isGroupHighlighted(meld.tiles) ? " pattern-highlighted" : ""}`}
                key={i}
                title={meld.kind}
              >
                {meld.tiles.map((t, j) => (
                  <TileGlyphSpan key={j} tile={t} highlight={isWinningInstance(t)} />
                ))}
              </span>
            ))}
            <span className={`breakdown-group${isGroupHighlighted(hand.pair) ? " pattern-highlighted" : ""}`} title="Pair">
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

// One tenpai wait's projected outcome: the tile that would complete the
// concealed hand, and the score the whole hand lands on if it does (with
// that tile taken as the 食胡 tile - see the projectedWaits memo). `result`
// is null only if scoreParsedHand somehow rejects a hand getWaits already
// vouched for as structurally complete - not expected, but surfaced rather
// than swallowed.
interface ProjectedWait {
  wait: Tile;
  result: ScoreResult | null;
  error: string | null;
}

// One row of the near-complete "if this wait completes the hand" list: a
// tap-to-expand summary (wait tile + total tai) over the full
// ScoringBreakdown for that completion, including 嚦咕雙食's second reading
// when scoreParsedHand returns one. Collapsed by default so a hand with
// many waits stays scannable.
function ProjectedWaitRow({
  projected,
  declaredCount,
  ctx,
}: {
  projected: ProjectedWait;
  declaredCount: number;
  ctx: GameContext;
}) {
  const [expanded, setExpanded] = useState(false);
  const { wait, result, error } = projected;
  // Each wait's own effective context - same override the projectedWaits
  // memo itself applies before scoring (see ScoringPanel), since PatternRow
  // needs a ctx with winningTile pinned to THIS row's wait, not whatever
  // the ambient hand's own marked 食胡 tile happens to be.
  const waitCtx: GameContext = { ...ctx, winningTile: wait };
  return (
    <div className="projected-wait">
      <button
        type="button"
        className="projected-wait-head"
        onClick={() => setExpanded((e) => !e)}
        aria-expanded={expanded}
        aria-label={`${tileLabel(wait)} — ${result ? `${result.total} tai` : "not scoreable"}, tap for breakdown`}
      >
        <TileGlyphSpan tile={wait} large />
        <span className="projected-wait-tai">{result ? `${result.total} tai` : "—"}</span>
        <span className={`projected-wait-caret${expanded ? " open" : ""}`} aria-hidden="true">
          ▸
        </span>
      </button>
      <CollapsiblePanel open={expanded}>
        {error ? (
          <span className="error">{error}</span>
        ) : result ? (
          <>
            <ScoringBreakdown
              matched={result.matched}
              hand={result.hand}
              declaredCount={declaredCount}
              winningTile={wait}
              ctx={waitCtx}
            />
            {result.second && (
              <>
                <div className="waits scoring-total scoring-second-label">
                  <span className="waits-label">Also (嚦咕雙食 - also reads as an ordinary hand):</span>
                </div>
                <ScoringBreakdown
                  matched={result.second.matched}
                  hand={result.second.hand}
                  declaredCount={0}
                  winningTile={wait}
                  ctx={waitCtx}
                />
              </>
            )}
          </>
        ) : null}
      </CollapsiblePanel>
    </div>
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
  const [meldKind, setMeldKind] = useState<MeldPickerKind>("run");
  const [seatWind, setSeatWind] = useState<Wind>(1);
  const [roundWind, setRoundWind] = useState<Wind>(1);
  const [selfDraw, setSelfDraw] = useState(false);
  const [riichi, setRiichi] = useState<RiichiState>("none");
  const [instantWin, setInstantWin] = useState(false);
  const [eatRiichi, setEatRiichi] = useState(false);
  // Tapping 叮 advances it through none -> 叮 -> 天叮 -> 地叮 -> none...;
  // 一發 only makes sense (and only scores) once riichi is declared, so
  // stepping back to "none" resets it rather than leaving a stale true
  // value stuck behind its own disabled button with no way to un-toggle
  // it. 食叮 is left alone here - unlike 一發, it scores its flat 5 tai
  // regardless of whether 叮 is declared at all, per the user's own house
  // rule, so there's no "riichi went back to none" case to reset it for.
  const cycleRiichi = () => {
    setRiichi((prev) => {
      const next = RIICHI_CYCLE[(RIICHI_CYCLE.indexOf(prev) + 1) % RIICHI_CYCLE.length];
      if (next === "none") setInstantWin(false);
      return next;
    });
  };
  const [earlyWin, setEarlyWin] = useState<EarlyWinState>("none");
  // 四子內/七子內/十子內 (won within the first N discards) and 河底撈魚/
  // 海底撈月 (won on the very last tile) are mutually exclusive by
  // definition - the wall can't be both nearly full and exhausted at once
  // - so activating either cycle clears the other back to "none".
  const cycleEarlyWin = () => {
    const next = EARLY_WIN_CYCLE[(EARLY_WIN_CYCLE.indexOf(earlyWin) + 1) % EARLY_WIN_CYCLE.length];
    if (next !== "none") setLastTileWin("none");
    setEarlyWin(next);
  };
  const [multiWin, setMultiWin] = useState<MultiWinState>("none");
  const [heavenlyWin, setHeavenlyWin] = useState<HeavenlyWinState>("none");
  // 天胡 forces 自摸 on (the dealer's initial deal is already a complete
  // hand - inherently self-drawn); 地胡 forces it off (this house rule's
  // 地胡 is winning off the very first discard - claimed, not self-drawn,
  // joining 搶槓/雙響/三響's group); 人胡 is deliberately left unlinked
  // either way. All 3 (天胡/地胡/人胡) are also mutually exclusive with
  // 河底撈魚/海底撈月 - both describe extreme ends of the hand (won on
  // essentially the very first tile vs. the very last one),
  // so activating any of the 3 clears lastTileWin, same shape as
  // cycleEarlyWin/cycleLastTileWin's own exclusion below. The deactivate
  // helpers are called before setHeavenlyWin so this transition's own
  // authoritative next value - set last - always wins over anything a
  // helper's (stale, pre-transition) heavenlyWin check might otherwise
  // clear it back to (see deactivateSelfDrawGroup/deactivateClaimedWinGroup
  // below).
  const cycleHeavenlyWin = () => {
    const next = HEAVENLY_WIN_CYCLE[(HEAVENLY_WIN_CYCLE.indexOf(heavenlyWin) + 1) % HEAVENLY_WIN_CYCLE.length];
    if (next === "heaven") deactivateClaimedWinGroup();
    else if (next === "earth") deactivateSelfDrawGroup();
    if (next !== "none") setLastTileWin("none");
    setHeavenlyWin(next);
  };
  const [lastTileWin, setLastTileWin] = useState<LastTileWinState>("none");
  const cycleLastTileWin = () => {
    const next = LAST_TILE_WIN_CYCLE[(LAST_TILE_WIN_CYCLE.indexOf(lastTileWin) + 1) % LAST_TILE_WIN_CYCLE.length];
    if (next !== "none") {
      setEarlyWin("none"); // see cycleEarlyWin's own comment
      setHeavenlyWin("none"); // mutually exclusive with 天胡/地胡/人胡 - see cycleHeavenlyWin's own comment
    }
    setLastTileWin(next);
    if (!isSelfDrawLastTileWin(lastTileWin) && isSelfDrawLastTileWin(next)) deactivateClaimedWinGroup();
  };
  const [flowerDraw, setFlowerDraw] = useState(0);
  const [kongDraw, setKongDraw] = useState(0);
  const [robKong, setRobKong] = useState(0);
  // 莊 (連莊) - independent of every self-draw/claimed-win signal above
  // (a dealer can extend their streak by either self-drawing or claiming a
  // discard, so this has no business joining either mutual-exclusion
  // group). Tapping the button itself toggles between inactive (0) and
  // just-active-with-no-streak-yet (1, shown as plain "莊", 1 tai); +/- then
  // step it further into 莊連1/莊連2/... (shown with the streak number,
  // 2n-1 tai) - see dealerStreakLabel and toggleDealerStreak/
  // bumpDealerStreak, and GameContext.dealerStreak's own comment in
  // scoring.ts for the full n-to-label-to-tai mapping.
  const [dealerStreak, setDealerStreak] = useState(0);
  const toggleDealerStreak = () => setDealerStreak((n) => (n > 0 ? 0 : 1));
  const bumpDealerStreak = (delta: 1 | -1) => setDealerStreak((n) => Math.max(0, n + delta));
  // 自摸 (incl. its 花摸/槓摸/河底撈魚/海底撈月/天胡-forced form) and {搶槓,
  // 雙響/三響, 地胡, 食叮} are mutually exclusive - the latter group all mean
  // the win was claimed off another player (robbing a kong, multiple players
  // claiming the same discard, this house rule's 地胡 being won off the very
  // first discard, or 食叮 - eating straight into the completed hand off a
  // discard once 叮 is declared), the opposite of a self-draw. Activating
  // either group clears every self-draw-implying/claimed-win-implying field
  // in the other, rather than letting the two silently coexist as a
  // contradictory state.
  const deactivateSelfDrawGroup = () => {
    setSelfDraw(false);
    setFlowerDraw(0);
    setKongDraw(0);
    if (isSelfDrawLastTileWin(lastTileWin)) setLastTileWin("none");
    if (isSelfDrawHeavenlyWin(heavenlyWin)) setHeavenlyWin("none");
  };
  const deactivateClaimedWinGroup = () => {
    setRobKong(0);
    setMultiWin("none");
    if (heavenlyWin === "earth") setHeavenlyWin("none");
    setEatRiichi(false);
  };
  const cycleMultiWin = () => {
    const next = MULTI_WIN_CYCLE[(MULTI_WIN_CYCLE.indexOf(multiWin) + 1) % MULTI_WIN_CYCLE.length];
    setMultiWin(next);
    if (multiWin === "none" && next !== "none") deactivateSelfDrawGroup();
  };
  // 花摸's cap is however many bonus tiles are actually in the hand right
  // now (can't have flowered into more replacement tiles than bonus tiles
  // drawn), and 槓摸's is however many kongs are actually declared (see
  // `kongCount` below) - both computed live off the current hand rather
  // than the fixed 8/5 ceilings used before. A separate effect (below,
  // after those are computed) clamps the count down if the hand changes
  // out from under an already-declared value.
  const cycleFlowerDraw = () => {
    const next = cycleCount(flowerDraw, bonusTiles.length);
    setFlowerDraw(next);
    if (flowerDraw === 0 && next > 0) deactivateClaimedWinGroup();
  };
  const cycleKongDraw = () => {
    const next = cycleCount(kongDraw, kongCount);
    setKongDraw(next);
    if (kongDraw === 0 && next > 0) deactivateClaimedWinGroup();
  };
  const cycleRobKong = () => {
    const next = cycleCount(robKong, 5);
    setRobKong(next);
    if (robKong === 0 && next > 0) deactivateSelfDrawGroup();
  };
  // 明絕/絕絕's manual override, as one shared tri-state (see
  // VisibleExhaustState above) - only advanceable by the user past whatever
  // floor the auto-detect checks already prove (see the button's own
  // `disabled`/cycle logic below); once set past that floor, cycling/
  // removing tiles could make the auto-check start failing again without
  // this manual state noticing, so it's left as whatever the user last set
  // rather than trying to track that.
  const [manualVisibleExhaust, setManualVisibleExhaust] = useState<VisibleExhaustState>("none");
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
  // Broader than scanBusy - also true while the scan flow is sitting on a
  // finished review or an error, not just mid-crop/mid-detect. Keeps Reset
  // enabled through the whole scan flow (see handleReset below, which also
  // cancels it) even when the hand itself is still empty and would
  // otherwise leave Reset looking like there's nothing to do.
  const [scanActive, setScanActive] = useState(false);
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
  // How many tiles of "room" are left before the hand's required size
  // (COMPLETE_SIZE + however many kongs are already declared) would be
  // exceeded - unlike atCapRef (a single-tile check, correct for
  // addConcealedTile which only ever adds one tile at a time), declaring a
  // new meld adds 3 or 4 tiles in one go, so atCapRef alone isn't enough to
  // stop one from being started too close to the cap: it only blocks once
  // the hand is ALREADY full, not once there's merely too little room left
  // for a WHOLE new meld to fit (e.g. 4 melds already declared plus 3+
  // concealed tiles leaves only 2 slots for the 5th meld's minimum 3,
  // but atCapRef alone wouldn't catch that). Every meld costs exactly 3 of
  // this budget regardless of kind - a kong's 4th tile is exactly offset
  // by the 1 extra tile it adds to the required size itself, so the "cost"
  // for room-accounting purposes is the same 3 either way. Used as
  // `meldRoomRef() < 3` to gate declaring any new meld at all.
  const meldRoomRef = (): number => {
    const kongs = declaredRef.current.filter((m) => m.kind === "kong").length;
    const total = concealedRef.current.length + declaredRef.current.reduce((n, m) => n + m.tiles.length, 0);
    return COMPLETE_SIZE + kongs - total;
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
  // Render-time counterpart of meldRoomRef - see its own comment.
  const meldRoom = requiredSize - totalTiles;
  // Keeps 花摸/槓摸's declared counts from outliving their caps - e.g.
  // removing a declared kong after already cycling 槓摸 up to x2 would
  // otherwise leave a stale x2 sitting above the new (lower) kongCount
  // until the button happened to be tapped again.
  useEffect(() => {
    setFlowerDraw((c) => Math.min(c, bonusTiles.length));
  }, [bonusTiles.length]);
  useEffect(() => {
    setKongDraw((c) => Math.min(c, kongCount));
  }, [kongCount]);

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
    if (meldRoomRef() < 3 || declaredRef.current.length >= 5) return;
    const next = [...declaredRef.current, { id: nextMeldId.current++, kind, concealed, tiles }];
    declaredRef.current = next;
    setDeclaredMelds(next);
  };
  const addMeldStartingAt = (tile: Tile) => {
    if (meldKind === "triplet") {
      if (totalCopiesUsedRef(tile) + 3 > 4) return;
      pushMeld("triplet", false, [tile, tile, tile]);
    } else if (meldKind === "concealed-kong" || meldKind === "exposed-kong") {
      if (totalCopiesUsedRef(tile) > 0) return;
      pushMeld("kong", meldPickerIsConcealed(meldKind), [tile, tile, tile, tile]);
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
  // Flips a declared kong between 暗槓 (concealed) and 明槓 (exposed) in
  // place - see DeclaredMeldButton's long-press wiring. DeclaredMeldButton
  // only ever wires this to a kong's long-press (a non-kong meld's
  // long-press calls onRemove instead) - this doesn't re-check `kind`
  // itself, so it must stay that way: flipping `concealed` on a
  // triplet/run isn't inert, it actually feeds hiddenTripletOrKongCount's
  // own 暗刻-chain scoring the same as a kong would.
  const toggleMeldConcealed = (id: number) => {
    const next = declaredRef.current.map((m) => (m.id === id ? { ...m, concealed: !m.concealed } : m));
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
    if (meldRoom < 3 || meldsFull) return false;
    if (meldKind === "triplet") return totalCopiesUsed(tile) + 3 <= 4;
    if (meldKind === "concealed-kong" || meldKind === "exposed-kong") return totalCopiesUsed(tile) === 0;
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
    setSeatWind(1);
    setRoundWind(1);
    setSelfDraw(false);
    setRiichi("none");
    setInstantWin(false);
    setEatRiichi(false);
    setEarlyWin("none");
    setMultiWin("none");
    setHeavenlyWin("none");
    setLastTileWin("none");
    setFlowerDraw(0);
    setKongDraw(0);
    setRobKong(0);
    setDealerStreak(0);
    setManualVisibleExhaust("none");
    handScannerRef.current?.reset();
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
      // If one tile in the concealed hand photo comes back conspicuously
      // rotated relative to the rest (see findRotatedOutlier's own
      // reasoning - a claimed or self-drawn winning tile is often laid at
      // an angle to mark it apart), assume it's the 食胡 tile. Failing
      // that, a concealed region that's JUST the hand's own pair (將眼,
      // once every meld is declared elsewhere - see isPairOnlyRow) needs
      // no rotation signal at all: findRotatedOutlier can't tell anything
      // apart from only 2 tiles (not enough for its median comparison to
      // mean anything), but both tiles ARE the exact same kind here, so
      // either one is safely the 食胡 tile regardless. Either way, matched
      // back to `nextConcealed` by kind only (post-sort, the original
      // detection order is gone) - any instance of that kind works, since
      // scoring only ever cares about the winning tile's kind, not which
      // physical copy. Falls back to no pre-selected winning tile (as
      // before) when neither signal finds anything.
      const outlier = findRotatedOutlier(concealedRegion.detections);
      const winningKind = outlier?.tile ?? (isPairOnlyRow(concealedRegion.detections) ? concealedRegion.detections[0].tile : null);
      const winningMatch = winningKind ? nextConcealed.find((t) => t.suit === winningKind.suit && t.rank === winningKind.rank) : undefined;
      setWinningTile(winningMatch ?? null);
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

  // 花摸/槓摸 (declared at all), either of 河底撈魚/海底撈月, and
  // 天胡 all force 自摸 on regardless of its own manual state (per this
  // house rule - see isSelfDrawLastTileWin's own comment for 河底撈魚
  // specifically) - but 搶槓/雙響/三響/地胡 deliberately do NOT (see
  // deactivateSelfDrawGroup/deactivateClaimedWinGroup above for the full
  // mutual-exclusion wiring).
  // See the 自摸 button below for the other half of this: tapping it off
  // while forced on this way cascades back through deactivateSelfDrawGroup.
  const effectiveSelfDraw =
    selfDraw || flowerDraw > 0 || kongDraw > 0 || isSelfDrawLastTileWin(lastTileWin) || isSelfDrawHeavenlyWin(heavenlyWin);

  // scoring.ts only cares about the winning tile's kind (see GameContext's
  // doc comment there) - the id above exists purely to disambiguate which
  // instance the UI highlights.
  const ctx: GameContext = {
    seatWind,
    roundWind,
    selfDraw: effectiveSelfDraw,
    winningTile,
    riichi,
    instantWin,
    eatRiichi,
    earlyWin,
    multiWin,
    heavenlyWin,
    lastTileWin,
    flowerDraw,
    kongDraw,
    robKong,
    dealerStreak,
    manualVisibleTripleWin: manualVisibleExhaust !== "none",
    manualVisibleExhaustedMultiWait: manualVisibleExhaust === "exhausted",
  };
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
  }, [
    concealedTiles,
    declaredMelds,
    bonusTiles,
    totalTiles,
    requiredSize,
    seatWind,
    roundWind,
    selfDraw,
    riichi,
    instantWin,
    eatRiichi,
    earlyWin,
    multiWin,
    heavenlyWin,
    lastTileWin,
    flowerDraw,
    kongDraw,
    robKong,
    dealerStreak,
    manualVisibleExhaust,
    winningTile,
  ]);

  // "Near-complete" = the concealed hand is exactly one tile short of a full
  // hand (declared melds are always complete by construction, so the missing
  // tile is necessarily concealed). Jokers and kongs never enter the picture
  // here: the concealed tile-picker can't produce a joker, and a concealed
  // kong isn't scoreable via this tap UI anyway (see the `scoring` memo's
  // exact-size gate) - so the plain no-wildcard getWaits on the concealed
  // tiles is all that's needed to enumerate what completes the hand.
  const nearComplete = totalTiles === requiredSize - 1;
  const projectedWaits = useMemo<ProjectedWait[] | null>(() => {
    if (!nearComplete) return null;
    const meldsNeeded = MELDS_REQUIRED - declaredMelds.length;
    const concealed = concealedTiles.map(({ id: _id, ...tile }) => tile);
    const declared = declaredMelds.map(({ kind, concealed: c, tiles }) => ({ kind, concealed: c, tiles }));
    // getWaits only counts copies within the concealed tiles it's given, so a
    // wait kind whose remaining copies are all sitting in a declared meld is
    // structurally suggested but physically impossible to draw - drop those.
    const waits = getWaits(concealed, meldsNeeded).filter((w) => totalCopiesUsed(w) < 4);
    return waits
      .map((wait): ProjectedWait => {
        const parsed: ParsedScoringHand = {
          declaredMelds: declared,
          freeTiles: [...concealed, wait],
          bonusTiles,
        };
        try {
          // Each wait is, by definition, the tile that completed the hand -
          // score it as the 食胡 tile regardless of any long-press mark (the
          // marked tile, if any, isn't the completing one while tenpai).
          return { wait, result: scoreParsedHand(parsed, { ...ctx, winningTile: wait }), error: null };
        } catch (e) {
          return { wait, result: null, error: e instanceof ScoringError ? e.message : "Could not score hand" };
        }
      })
      // Canonical tile order (suit then rank); the display-order toggle
      // re-sorts a copy of this without recomputing any scores.
      .sort(
        (a, b) =>
          SUIT_ORDER.indexOf(a.wait.suit) - SUIT_ORDER.indexOf(b.wait.suit) || a.wait.rank - b.wait.rank
      );
    // Same deps as `scoring` above minus winningTile (overridden per wait); ctx
    // is rebuilt every render so its primitive inputs are listed individually.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    nearComplete,
    concealedTiles,
    declaredMelds,
    bonusTiles,
    seatWind,
    roundWind,
    selfDraw,
    riichi,
    instantWin,
    eatRiichi,
    earlyWin,
    multiWin,
    heavenlyWin,
    lastTileWin,
    flowerDraw,
    kongDraw,
    robKong,
    dealerStreak,
    manualVisibleExhaust,
  ]);

  // Display order for the projected-waits list: highest tai first, or plain
  // tile order. Only reorders the already-scored rows, so flipping it is
  // cheap.
  const [projectedSort, setProjectedSort] = useState<"score" | "tiles">("score");
  const displayedProjectedWaits = useMemo(() => {
    if (!projectedWaits || projectedSort === "tiles") return projectedWaits;
    return [...projectedWaits].sort(
      (a, b) =>
        (b.result?.total ?? -1) - (a.result?.total ?? -1) ||
        SUIT_ORDER.indexOf(a.wait.suit) - SUIT_ORDER.indexOf(b.wait.suit) ||
        a.wait.rank - b.wait.rank
    );
  }, [projectedWaits, projectedSort]);

  // Whether 明絕/絕絕's auto-detect alone (ignoring the manual state) already
  // proves one of the two true, purely to decide the shared button's floor -
  // see manualVisibleExhaust's own doc comment. Checked as exhausted first
  // since it's the strictly stronger finding (see VisibleExhaustState).
  const visibleExhaustAuto: VisibleExhaustState = scoring?.ok
    ? isVisiblyExhaustedMultiWait(scoring.result.hand, ctx)
      ? "exhausted"
      : isVisiblyTripledWinningTile(scoring.result.hand, ctx)
        ? "triple"
        : "none"
    : "none";
  // Whether the winning tile's kind is ALSO sitting elsewhere in this
  // hand's own concealed tiles - if so, the MANUAL half of 明絕/絕絕 (both
  // of them - see isWinningTileHeldConcealedElsewhere's own doc comment) is
  // blocked entirely: unlike the auto-detect floor above, the manual
  // override isn't derived from declared-meld counts, so it isn't
  // automatically safe from this collision, and this tool CAN see the
  // player's own concealed hand even though it can't see the discard pile
  // or other players' melds.
  const visibleExhaustManualBlocked = scoring?.ok ? isWinningTileHeldConcealedElsewhere(scoring.result.hand, ctx) : false;
  // Whether this hand's own concealed pre-completion wait genuinely was
  // multi-way - if not, the MANUAL half of 絕絕 specifically is blocked
  // (see isGenuineMultiWait's own doc comment: 明絕 doesn't care about wait
  // count, so this only caps escalation to "exhausted", not to "triple").
  const visibleExhaustGenuineMultiWait = scoring?.ok ? isGenuineMultiWait(scoring.result.hand, ctx) : false;
  // The manual override's ceiling, folding both blocks above into a single
  // reachable top state: pinned to the auto floor when the concealed-
  // duplicate block applies (blocks both 明絕 and 絕絕 manually), else
  // capped at "triple" when the wait wasn't genuinely multi-way (blocks
  // only 絕絕 manually - 明絕 stays reachable), else uncapped.
  const visibleExhaustCeiling: VisibleExhaustState = visibleExhaustManualBlocked
    ? visibleExhaustAuto
    : visibleExhaustGenuineMultiWait
      ? "exhausted"
      : VISIBLE_EXHAUST_RANK[visibleExhaustAuto] > VISIBLE_EXHAUST_RANK.triple
        ? visibleExhaustAuto
        : "triple";
  // Every state the shared button can currently land on: at or above the
  // auto-detected floor, at or below the manual ceiling above. A floor of
  // "exhausted" (or a floor pinned to the ceiling by either block above)
  // leaves only one reachable state, which is why the button is also
  // `disabled` then.
  const visibleExhaustReachable = VISIBLE_EXHAUST_CYCLE.filter(
    (s) => VISIBLE_EXHAUST_RANK[s] >= VISIBLE_EXHAUST_RANK[visibleExhaustAuto] && VISIBLE_EXHAUST_RANK[s] <= VISIBLE_EXHAUST_RANK[visibleExhaustCeiling],
  );
  // The manual declaration, clamped to the reachable ceiling - matters when
  // the winning tile changes out from under an already-declared manual
  // state (e.g. it now collides with a concealed duplicate that didn't
  // exist a moment ago), so the button never displays a state the scoring
  // engine has actually stopped counting.
  const visibleExhaustManualClamped: VisibleExhaustState =
    VISIBLE_EXHAUST_RANK[manualVisibleExhaust] > VISIBLE_EXHAUST_RANK[visibleExhaustCeiling] ? visibleExhaustCeiling : manualVisibleExhaust;
  // The state actually shown/scored: whichever of the (clamped) manual
  // declaration and the auto-detected floor is stronger - the user can only
  // ever cycle upward from the floor (see cycleVisibleExhaust), so this is
  // just "whichever one currently has the higher rank."
  const visibleExhaustEffective: VisibleExhaustState =
    VISIBLE_EXHAUST_RANK[visibleExhaustManualClamped] > VISIBLE_EXHAUST_RANK[visibleExhaustAuto] ? visibleExhaustManualClamped : visibleExhaustAuto;
  // Steps the shared button to its next reachable state.
  const cycleVisibleExhaust = () => {
    const idx = visibleExhaustReachable.indexOf(visibleExhaustEffective);
    setManualVisibleExhaust(visibleExhaustReachable[(idx + 1) % visibleExhaustReachable.length]);
  };

  return (
    <section className="panel scoring-panel">
      <div className="panel-header">
        <button
          type="button"
          onClick={handleReset}
          disabled={
            concealedTiles.length === 0 &&
            declaredMelds.length === 0 &&
            bonusTiles.length === 0 &&
            seatWind === 1 &&
            roundWind === 1 &&
            !selfDraw &&
            riichi === "none" &&
            earlyWin === "none" &&
            multiWin === "none" &&
            heavenlyWin === "none" &&
            lastTileWin === "none" &&
            flowerDraw === 0 &&
            kongDraw === 0 &&
            robKong === 0 &&
            dealerStreak === 0 &&
            manualVisibleExhaust === "none" &&
            !scanActive
          }
        >
          Reset
        </button>
        <button type="button" onClick={() => handScannerRef.current?.trigger()} disabled={scanBusy}>
          📷 Scan
        </button>
        {/* The camera sheet 📷 Scan opens (capture="environment") is
            camera-only on iOS Safari - no way back to an existing photo
            from inside it - so this is the separate escape hatch straight
            to the OS's own photo picker for someone who already has the
            shot taken. */}
        <button type="button" onClick={() => handScannerRef.current?.triggerLibrary()} disabled={scanBusy} title="Choose an existing photo instead of the camera">
          🖼️ Photos
        </button>
        <span className="tile-count">
          {totalTiles} / {requiredSize} tiles
        </span>
      </div>

      <HandScanner
        ref={handScannerRef}
        hideTrigger
        onBusyChange={setScanBusy}
        onActiveChange={setScanActive}
        regionLabels={["Concealed", "Declared"]}
        regionIssue={declaredRegionIssue}
        onConfirm={applyScannedRegions}
      />

      <div className="scoring-context">
        <WindPicker label="Round wind" value={roundWind} onChange={setRoundWind} />
        <WindPicker label="Seat wind" value={seatWind} onChange={setSeatWind} />
      </div>

      <div className="panel-header">
        <span className="panel-title">門前牌區 (Declared melds)</span>
        <PickerCollapseToggle collapsed={declaredPickerCollapsed} onToggle={() => setDeclaredPickerCollapsed((c) => !c)} />
      </div>

      <CollapsiblePanel open={!declaredPickerCollapsed} className="meld-kind-collapsible">
        <div className="panel-header meld-kind-row">
          {(["run", "triplet", "exposed-kong", "concealed-kong"] as MeldPickerKind[]).map((k) => (
            <button
              key={k}
              type="button"
              className={meldKind === k ? "toggle-on" : undefined}
              aria-pressed={meldKind === k}
              onClick={() => setMeldKind(k)}
            >
              {MELD_PICKER_LABELS[k]}
            </button>
          ))}
        </div>

        <div className="tile-picker">
          {(["m", "t", "b", "z"] as Suit[])
            .filter((suit) => meldKind !== "run" || suit !== "z")
            .map((suit) => (
              <div className="suit-row" key={suit}>
                {meldPickerTiles(meldPickerUnderlyingKind(meldKind))
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

        <CollapsiblePanel open={!bonusPickerCollapsed}>
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
        </CollapsiblePanel>
      </CollapsiblePanel>

      <div className="hand-display breakdown-groups">
        {declaredMelds.length === 0 && bonusTiles.length === 0 ? (
          <span className="hint">Tap to add declared melds.</span>
        ) : (
          <>
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
              <DeclaredMeldButton
                key={meld.id}
                meld={meld}
                onRemove={() => removeMeld(meld.id)}
                onToggleConcealed={() => toggleMeldConcealed(meld.id)}
              />
            ))}
          </>
        )}
      </div>

      <div className="panel-header">
        <span className="panel-title">手牌區 (Concealed hand)</span>
        <PickerCollapseToggle collapsed={concealedPickerCollapsed} onToggle={() => setConcealedPickerCollapsed((c) => !c)} />
      </div>

      <CollapsiblePanel open={!concealedPickerCollapsed}>
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
      </CollapsiblePanel>

      <div className="hand-display">
        {concealedTiles.length === 0 ? (
          <span className="hint">Tap to add concealed tiles.</span>
        ) : (
          // While near-complete, the tile that completes the hand isn't in
          // hand yet - each projected wait supplies its own 食胡 tile - so the
          // long-press marker is meaningless here: fall back to plain
          // tap-to-remove tiles and drop the hint until the hand is whole.
          (sortTiles(concealedTiles) as HandTile[]).map((t) =>
            nearComplete ? (
              <HandTileButton key={t.id} tile={t} onClick={() => removeConcealedTile(t.id)} />
            ) : (
              <WinningTileHandButton
                key={t.id}
                tile={t}
                isWinning={isWinningTile(t)}
                onRemove={() => removeConcealedTile(t.id)}
                onToggleWinning={() => toggleWinningTile(t)}
              />
            )
          )
        )}
      </div>
      {concealedTiles.length > 0 && !nearComplete && (
        <span className="hint">Long-press a tile to mark it as the 食胡 tile (the one that completed the hand).</span>
      )}

      <div className="scoring-context">
        <button
          type="button"
          className={dealerStreak > 0 ? "toggle-on" : undefined}
          aria-pressed={dealerStreak > 0}
          onClick={toggleDealerStreak}
          title={dealerStreak > 0 ? "莊 - tap to turn off (0 tai)" : "莊 - tap to declare (1 tai); use +/- to build up a 連莊 streak from there"}
        >
          {dealerStreakLabel(dealerStreak)}
        </button>
        {dealerStreak > 0 && (
          <>
            <button type="button" onClick={() => bumpDealerStreak(-1)} title="莊 - decrease the streak by 1">
              −
            </button>
            <button type="button" onClick={() => bumpDealerStreak(1)} title="莊 - increase the streak by 1">
              +
            </button>
          </>
        )}
        <button
          type="button"
          className={effectiveSelfDraw ? "toggle-on" : undefined}
          aria-pressed={effectiveSelfDraw}
          onClick={() => {
            if (effectiveSelfDraw) {
              // Turning off while forced/held on by 花摸/槓摸/河底撈魚/
              // 海底撈月/天胡 cascades to turning those off too (see
              // deactivateSelfDrawGroup), not just flip the
              // (possibly already false) manual flag and leave 自摸 stuck
              // on regardless. 人胡 is untouched - it doesn't force 自摸 on
              // in the first place.
              deactivateSelfDrawGroup();
            } else {
              setSelfDraw(true);
              deactivateClaimedWinGroup();
            }
          }}
          title="自摸 - self-draw vs won off a discard (also turned on by 花摸/槓摸/河底撈魚/海底撈月/天胡, and mutually exclusive with 搶槓/雙響/三響/地胡/食叮 - turning any one of these on turns the others off)"
        >
          自摸
        </button>
        <button
          type="button"
          className={riichi !== "none" ? "toggle-on" : undefined}
          aria-pressed={riichi !== "none"}
          onClick={cycleRiichi}
          title="叮 - tap to cycle 叮 / 天叮 / 地叮 / off"
        >
          {RIICHI_LABELS[riichi]}
        </button>
        <button
          type="button"
          className={instantWin ? "toggle-on" : undefined}
          aria-pressed={instantWin}
          disabled={riichi === "none"}
          onClick={() => setInstantWin((w) => !w)}
          title={
            riichi === "none"
              ? "一發 - only counts once 叮 is declared"
              : "一發 - the hand completed within the immediate round after declaring - adds 5 tai"
          }
        >
          一發
        </button>
        <button
          type="button"
          className={eatRiichi ? "toggle-on" : undefined}
          aria-pressed={eatRiichi}
          onClick={() => {
            const next = !eatRiichi;
            setEatRiichi(next);
            // Eating into the completed hand off a discard is a claimed
            // win, mutually exclusive with self-draw - see
            // deactivateSelfDrawGroup's own comment.
            if (next) deactivateSelfDrawGroup();
          }}
          title="食叮 - adds 5 tai regardless of whether 叮 is declared; mutually exclusive with 自摸/花摸/槓摸/河底撈魚/海底撈月/天胡"
        >
          食叮
        </button>
        <button
          type="button"
          className={earlyWin !== "none" ? "toggle-on" : undefined}
          aria-pressed={earlyWin !== "none"}
          onClick={cycleEarlyWin}
          title="Won while the discard count (excluding the completing tile) was still at or under this number - tap to cycle 四子內(60) / 七子內(30) / 十子內(15) / off (mutually exclusive with 河底撈魚/海底撈月)"
        >
          {EARLY_WIN_LABELS[earlyWin]}
        </button>
        <button
          type="button"
          className={multiWin !== "none" ? "toggle-on" : undefined}
          aria-pressed={multiWin !== "none"}
          onClick={cycleMultiWin}
          title="Multiple players won off the same discard - tap to cycle 雙響(5) / 三響(10) / off (mutually exclusive with 自摸, same as 搶槓)"
        >
          {MULTI_WIN_LABELS[multiWin]}
        </button>
        <button
          type="button"
          className={heavenlyWin !== "none" ? "toggle-on" : undefined}
          aria-pressed={heavenlyWin !== "none"}
          onClick={cycleHeavenlyWin}
          title="Tap to cycle 天胡(160) / 地胡(120) / 人胡(80) / off - 天胡 also turns on 自摸 (deactivating 搶槓/雙響/三響/地胡), 地胡 also turns off 自摸; all 3 are mutually exclusive with 河底撈魚/海底撈月"
        >
          {HEAVENLY_WIN_LABELS[heavenlyWin]}
        </button>
        <button
          type="button"
          className={lastTileWin !== "none" ? "toggle-on" : undefined}
          aria-pressed={lastTileWin !== "none"}
          onClick={cycleLastTileWin}
          title="Tap to cycle 河底撈魚(5) / 海底撈月(10) / off - 海底撈月 auto-upgrades to 海底撈月(一筒)(20) if the winning tile is 1 Tong, no separate declaration needed; either state also turns on 自摸 (deactivating 搶槓/雙響/三響/地胡); also mutually exclusive with 四子內/七子內/十子內 and with 天胡/地胡/人胡"
        >
          {LAST_TILE_WIN_LABELS[lastTileWin]}
        </button>
        <button
          type="button"
          className={flowerDraw > 0 ? "toggle-on" : undefined}
          aria-pressed={flowerDraw > 0}
          disabled={bonusTiles.length === 0}
          onClick={cycleFlowerDraw}
          title={
            bonusTiles.length === 0
              ? "花摸 - no bonus tiles in hand to have flowered off of"
              : `Tap to cycle 花摸x0-x${bonusTiles.length} (2 tai each, capped at the ${bonusTiles.length} bonus tile${bonusTiles.length === 1 ? "" : "s"} in hand) - also turns on 自摸, deactivating 搶槓/雙響/三響`
          }
        >
          {countLabel("花摸", flowerDraw)}
        </button>
        <button
          type="button"
          className={kongDraw > 0 ? "toggle-on" : undefined}
          aria-pressed={kongDraw > 0}
          disabled={kongCount === 0}
          onClick={cycleKongDraw}
          title={
            kongCount === 0
              ? "槓摸 - no kongs declared to have drawn a replacement tile for"
              : `Tap to cycle 槓摸x0-x${kongCount} (tai: ${FIVE_POWER_TAI_TABLE.slice(1, kongCount + 1).join("/")}, capped at the ${kongCount} kong${kongCount === 1 ? "" : "s"} declared) - also turns on 自摸, deactivating 搶槓/雙響/三響`
          }
        >
          {countLabel("槓摸", kongDraw)}
        </button>
        <button
          type="button"
          className={robKong > 0 ? "toggle-on" : undefined}
          aria-pressed={robKong > 0}
          onClick={cycleRobKong}
          title={`Tap to cycle 搶槓x0-x5 (tai: ${FIVE_POWER_TAI_TABLE.slice(1).join("/")}) - mutually exclusive with 自摸`}
        >
          {countLabel("搶槓", robKong)}
        </button>
        <button
          type="button"
          className={visibleExhaustEffective !== "none" ? "toggle-on" : undefined}
          aria-pressed={visibleExhaustEffective !== "none"}
          disabled={visibleExhaustReachable.length <= 1}
          onClick={cycleVisibleExhaust}
          title={
            visibleExhaustAuto === "exhausted"
              ? "絕絕 - already true from this hand's own declared melds"
              : visibleExhaustAuto === "triple"
                ? "明絕 already true from this hand's own declared melds - tap to also declare 絕絕(10 tai) manually"
                : visibleExhaustManualBlocked
                  ? "Can't declare manually - the winning tile is also sitting elsewhere in this hand's own concealed tiles, so it wasn't the last copy anywhere"
                  : !visibleExhaustGenuineMultiWait
                    ? "明絕(5) can still be declared manually, but 絕絕(10) can't - this hand's own concealed wait was only ever a single wait, not genuinely multi-way"
                    : "Tap to cycle 明絕(5) / 絕絕(10) / off - declare manually when this hand's own declared melds alone can't prove it (e.g. you saw the other copies discarded)"
          }
        >
          {VISIBLE_EXHAUST_LABELS[visibleExhaustEffective]}
        </button>
      </div>

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
            ctx={ctx}
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
                ctx={ctx}
              />
            </>
          )}
        </>
      )}

      {nearComplete && displayedProjectedWaits !== null && (
        <div className="waits projected-waits">
          {displayedProjectedWaits.length === 0 ? (
            <span className="waits-label">Not tenpai — no tile completes this hand.</span>
          ) : (
            <>
              <div className="projected-waits-header">
                <span className="waits-label">
                  If completed — {displayedProjectedWaits.length} wait{displayedProjectedWaits.length === 1 ? "" : "s"}{" "}
                  (tap a row for its breakdown):
                </span>
                <button
                  type="button"
                  className="projected-sort-toggle"
                  onClick={() => setProjectedSort((s) => (s === "score" ? "tiles" : "score"))}
                  title={
                    projectedSort === "score"
                      ? "Sorted by score — tap to sort by tile"
                      : "Sorted by tile — tap to sort by score"
                  }
                >
                  {projectedSort === "score" ? "Sort: score" : "Sort: tile"}
                </button>
              </div>
              {displayedProjectedWaits.length === allTileKinds().length && (
                <span className="waits-label universal-wait">Universal wait — any tile completes this hand.</span>
              )}
              {displayedProjectedWaits.map((pw) => (
                <ProjectedWaitRow key={tileKey(pw.wait)} projected={pw} declaredCount={declaredMelds.length} ctx={ctx} />
              ))}
            </>
          )}
        </div>
      )}
    </section>
  );
}

// The pip layout for each die face, as grid cells (1-9, reading left-to-right,
// top-to-bottom) that carry a pip. Rendered as a 3x3 grid so the pips land in
// the familiar positions without a sprite.
const DIE_PIPS: Record<number, number[]> = {
  1: [5],
  2: [3, 7],
  3: [3, 5, 7],
  4: [1, 3, 7, 9],
  5: [1, 3, 5, 7, 9],
  6: [1, 3, 4, 6, 7, 9],
};

function Die({
  value,
  onBump,
  disabled,
}: {
  value: number;
  onBump: () => void;
  disabled: boolean;
}) {
  const pips = DIE_PIPS[value] ?? [];
  return (
    <button
      type="button"
      className="die"
      onClick={onBump}
      disabled={disabled}
      aria-label={`Die showing ${value} — tap to change`}
    >
      {Array.from({ length: 9 }, (_, i) => (
        <span key={i} className={pips.includes(i + 1) ? "die-pip" : "die-cell"} />
      ))}
    </button>
  );
}

// The built wall, playing with bonus tiles: 136 + 8 = 144 tiles = 72 stacks of
// two, split evenly across the four seats' walls = 18 stacks per side, and each
// bar is drawn two tiles deep (2 x 18). The four bars are offset in a pinwheel
// (each bar's far end juts one bar-width past its neighbour, the near end butts
// against the next), which is how a real wall is pushed together before the deal.
const WALL_STACKS_PER_SIDE = 18;
const WALL_BAR_DEPTH = 2;

type WallSide = "top" | "right" | "bottom" | "left";

const WALL_SIDE_LABEL: Record<WallSide, string> = {
  top: "top",
  right: "right",
  bottom: "bottom",
  left: "left",
};

// Where the dice sum breaks the wall. The seat is (sum mod 4) counted round from
// the roller; then `sum` stacks are counted clockwise along that side, so the
// side is split sum | (18 - sum). Each bar renders its stacks in clockwise order
// (see the flex-direction per side in the CSS), so `gapAfter` is simply how many
// stacks precede the gap.
type WallBreak = { side: WallSide; n: number; gapAfter: number };

function wallBreak(total: number | null): WallBreak | null {
  if (total == null || total < 3 || total > WALL_STACKS_PER_SIDE) return null;
  // 18 counts the whole right wall and lands exactly on the bottom-right corner,
  // so the break is drawn on the bottom side, hard against the right wall (before
  // its first clockwise stack).
  if (total === WALL_STACKS_PER_SIDE) {
    return { side: "bottom", n: total, gapAfter: 0 };
  }
  const mod = total % 4;
  const side: WallSide = mod === 3 ? "top" : mod === 0 ? "left" : mod === 1 ? "bottom" : "right";
  return { side, n: total, gapAfter: total };
}

function WallGap({ withMarker }: { withMarker: boolean }) {
  return (
    <div className="wall-gap">
      {withMarker && (
        <span className="wall-break-marker" aria-hidden="true">
          👉
        </span>
      )}
    </div>
  );
}

function WallBar({
  orientation,
  brk,
}: {
  orientation: "h" | "v";
  brk: WallBreak | null;
}) {
  const breakAt = brk?.gapAfter ?? null;
  // Draw the pointing finger off the outer face of the bar: that is the first
  // line for the top/left bars, the last line for the bottom/right bars.
  const markerLine = brk && (brk.side === "bottom" || brk.side === "right") ? WALL_BAR_DEPTH - 1 : 0;
  return (
    <div className={`wall-bar wall-bar-${orientation}`}>
      {Array.from({ length: WALL_BAR_DEPTH }, (_, line) => (
        <div className="wall-bar-line" key={line}>
          {Array.from({ length: WALL_STACKS_PER_SIDE }, (_, i) => {
            // Stacks render in clockwise order, so the first `gapAfter` are the counted run.
            const counted = breakAt != null && i < breakAt;
            return (
              <Fragment key={i}>
                {breakAt === i && <WallGap withMarker={line === markerLine} />}
                <div className={`wall-seg${counted ? " wall-seg-counted" : ""}`} />
              </Fragment>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function Wall({ total }: { total: number | null }) {
  const brk = wallBreak(total);
  const slot = (side: WallSide, orientation: "h" | "v") => (
    <div className={`wall-bar-slot wall-${side}`}>
      <WallBar orientation={orientation} brk={brk?.side === side ? brk : null} />
    </div>
  );
  return (
    <div
      className="wall"
      role="img"
      aria-label={
        brk
          ? `Mahjong wall broken on the ${WALL_SIDE_LABEL[brk.side]} side, ${brk.n} stacks clockwise`
          : `Built mahjong wall: four ${WALL_BAR_DEPTH} by ${WALL_STACKS_PER_SIDE} bars of tile stacks in a pinwheel`
      }
    >
      {slot("top", "h")}
      {slot("right", "v")}
      {slot("bottom", "h")}
      {slot("left", "v")}
    </div>
  );
}

// Shared dice-roll state: `count` d6 that start on 1 and cycle 1..6 when a die
// is tapped (bumpDie). roll() tumbles the dice faces for ~0.6s, then commits one
// settled result. `dice` is that settled result (stable during a roll, so
// derived readouts don't flicker); `faces` is what the tray shows - the
// tumbling values mid-roll, the settled ones otherwise.
function useDiceRoll(count: number) {
  const [dice, setDice] = useState<number[]>(() => Array<number>(count).fill(1));
  const [tumbling, setTumbling] = useState<number[] | null>(null);
  const rollTimer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (rollTimer.current !== null) window.clearInterval(rollTimer.current);
    },
    []
  );

  const rollOnce = () => Array.from({ length: count }, () => 1 + Math.floor(Math.random() * 6));
  const rolling = tumbling !== null;

  const roll = () => {
    if (rolling) return;
    setTumbling(rollOnce());
    let ticks = 0;
    if (rollTimer.current !== null) window.clearInterval(rollTimer.current);
    rollTimer.current = window.setInterval(() => {
      ticks += 1;
      if (ticks >= 10) {
        if (rollTimer.current !== null) window.clearInterval(rollTimer.current);
        rollTimer.current = null;
        setDice(rollOnce());
        setTumbling(null);
      } else {
        setTumbling(rollOnce());
      }
    }, 60);
  };

  const bumpDie = (idx: number) => {
    if (rolling) return;
    setDice((d) => d.map((v, i) => (i === idx ? (v % 6) + 1 : v)));
  };

  return { dice, faces: tumbling ?? dice, rolling, roll, bumpDie };
}

function DicePanel() {
  const { dice, faces, rolling, roll, bumpDie } = useDiceRoll(3);

  const total = dice[0] + dice[1] + dice[2];
  const brk = rolling ? null : wallBreak(total);

  // Highlight two notable rolls (based on the settled dice): a three-of-a-kind
  // (green) and a 1-2-3 in any order (red).
  const sortedDice = [...dice].sort((a, b) => a - b);
  const rollTint = rolling
    ? ""
    : sortedDice[0] === sortedDice[2]
      ? " dice-total-trips"
      : sortedDice[0] === 1 && sortedDice[1] === 2 && sortedDice[2] === 3
        ? " dice-total-run"
        : "";

  return (
    <>
      <div className="dice-tray">
        {faces.map((v, i) => (
          <Die key={i} value={v} onBump={() => bumpDie(i)} disabled={rolling} />
        ))}
      </div>

      <button type="button" className="dice-roll" onClick={roll} disabled={rolling}>
        {rolling ? "Rolling…" : "Roll the dice"}
      </button>

      <div className={`waits dice-total${rollTint}`}>
        <span className="waits-label">Total:</span>
        <span className="scoring-total-value">{rolling ? "–" : total}</span>
      </div>

      <Wall total={rolling ? null : total} />

      {brk && (
        <div className="wall-break-caption">
          {brk.n === WALL_STACKS_PER_SIDE ? (
            <>
              Break the <strong>bottom</strong> wall at the right-hand corner (18 lands on the wall’s
              end)
            </>
          ) : (
            <>
              Break the <strong>{WALL_SIDE_LABEL[brk.side]}</strong> wall: count {brk.n} clockwise →{" "}
              <strong>{brk.n}</strong> │ {WALL_STACKS_PER_SIDE - brk.n} left
            </>
          )}
        </div>
      )}
    </>
  );
}

function ExchangePanel() {
  const { dice, faces, rolling, roll, bumpDie } = useDiceRoll(2);
  // The first die picks a round: 1-2 -> 1, 3-4 -> 2, 5-6 -> 3.
  const round = Math.ceil(dice[0] / 2);
  // The second die picks a tile count, with a floor of 3.
  const tiles = Math.max(dice[1], 3);
  return (
    <>
      <div className="dice-tray exchange-tray">
        <div className="exchange-die">
          <span className="exchange-die-label">Round</span>
          <Die value={faces[0]} onBump={() => bumpDie(0)} disabled={rolling} />
        </div>
        <div className="exchange-die">
          <span className="exchange-die-label">Tiles</span>
          <Die value={faces[1]} onBump={() => bumpDie(1)} disabled={rolling} />
        </div>
      </div>

      <button type="button" className="dice-roll" onClick={roll} disabled={rolling}>
        {rolling ? "Rolling…" : "Roll the dice"}
      </button>

      <div className="dice-result-boxes">
        <div className="waits dice-total">
          <span className="waits-label">Round:</span>
          <span className="scoring-total-value">{rolling ? "–" : round}</span>
        </div>
        <div className="waits dice-total">
          <span className="waits-label">Tiles:</span>
          <span className="scoring-total-value">{rolling ? "–" : tiles}</span>
        </div>
      </div>

      <div className="waits dice-total">
        <span className="waits-label">Total:</span>
        <span className="scoring-total-value">{rolling ? "–" : round * tiles}</span>
      </div>
    </>
  );
}

function DiceTab() {
  const [sub, setSub] = useState<"wall" | "exchange">("wall");
  return (
    <section className="panel dice-panel">
      <div className="mode-tabs sub-tabs">
        <button
          type="button"
          className={sub === "wall" ? "toggle-on" : undefined}
          aria-pressed={sub === "wall"}
          onClick={() => setSub("wall")}
        >
          Dice &amp; wall
        </button>
        <button
          type="button"
          className={sub === "exchange" ? "toggle-on" : undefined}
          aria-pressed={sub === "exchange"}
          onClick={() => setSub("exchange")}
        >
          Exchange tiles
        </button>
      </div>
      {sub === "wall" ? <DicePanel /> : <ExchangePanel />}
    </section>
  );
}

function App() {
  const [mode, setMode] = useState<"calculator" | "trainer" | "scoring" | "dice">("calculator");
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
        <button
          type="button"
          className={mode === "dice" ? "toggle-on" : undefined}
          aria-pressed={mode === "dice"}
          onClick={() => setMode("dice")}
        >
          Dice rolling
        </button>
      </div>
      {mode === "calculator" && <Calculator />}
      {mode === "trainer" && <TrainerPanel stats={trainerStats} setStats={setTrainerStats} />}
      {mode === "scoring" && <ScoringPanel />}
      {mode === "dice" && <DiceTab />}
      <footer className="build-version">v{__BUILD_TIME__}</footer>
    </div>
  );
}

export default App;
