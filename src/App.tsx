import {
  useEffect,
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
import { detectTiles, letterbox, type Detection, type ScanProgress } from "./lib/vision";

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

// Draws each detection's box onto the (already letterboxed) canvas it was
// detected on - green for tiles that make it into the hand, gray/dashed for
// bonus tiles (flowers/seasons) that are recognized but excluded from it.
function drawDetections(canvas: HTMLCanvasElement, detections: Detection[]): void {
  const ctx = canvas.getContext("2d")!;
  ctx.font = "13px ui-monospace, SFMono-Regular, Menlo, monospace";
  ctx.textBaseline = "bottom";
  for (const d of detections) {
    const [x1, y1, x2, y2] = d.box;
    const included = d.tile !== null;
    ctx.strokeStyle = included ? "#2fbf5f" : "#bbb";
    ctx.lineWidth = 2;
    ctx.setLineDash(included ? [] : [4, 3]);
    ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
    const label = included ? d.className : `${d.className} (ignored)`;
    const textWidth = ctx.measureText(label).width;
    ctx.setLineDash([]);
    ctx.fillStyle = included ? "#2fbf5f" : "#999";
    ctx.fillRect(x1, y1, textWidth + 6, 16);
    ctx.fillStyle = "#fff";
    ctx.fillText(label, x1 + 3, y1 + 15);
  }
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
  // way - e.g. 112233m112233s11222z is simultaneously a standard hand
  // (123m123m123s123s + 222z/11z) and Eight Pairs. Most hands only match
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

const FULL_CROP: CropRect = { x: 0, y: 0, w: 1, h: 1 };
const MIN_CROP_FRACTION = 0.1;
const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

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

const CROP_HANDLES: CropDragMode[] = ["nw", "ne", "sw", "se"];

// Lets the user crop down to just the hand before it's sent to the
// detector - a hand photographed alongside other hands, a hand of cards,
// or a cluttered table can otherwise pick up stray detections. `image` is
// the already-loaded element from loadImageFile; it's inserted into the DOM
// directly (rather than re-rendered via a new <img src>) since its object
// URL was already revoked once it loaded.
function CropOverlay({
  image,
  onConfirm,
  onCancel,
}: {
  image: HTMLImageElement;
  onConfirm: (canvas: HTMLCanvasElement) => void;
  onCancel: () => void;
}) {
  const [rect, setRect] = useState<CropRect>(FULL_CROP);
  const stageRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ mode: CropDragMode; startX: number; startY: number; startRect: CropRect; w: number; h: number } | null>(
    null
  );

  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    image.className = "crop-image";
    image.draggable = false;
    image.alt = "Photo to crop before scanning";
    stage.insertBefore(image, stage.firstChild);
    return () => {
      if (image.parentElement === stage) stage.removeChild(image);
    };
  }, [image]);

  const beginDrag = (mode: CropDragMode) => (e: ReactPointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const bounds = stageRef.current?.getBoundingClientRect();
    if (!bounds) return;
    dragRef.current = { mode, startX: e.clientX, startY: e.clientY, startRect: rect, w: bounds.width, h: bounds.height };
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  };

  const onDragMove = (e: ReactPointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    const dx = (e.clientX - drag.startX) / drag.w;
    const dy = (e.clientY - drag.startY) / drag.h;
    setRect(applyCropDrag(drag.mode, drag.startRect, dx, dy));
  };

  const endDrag = () => {
    dragRef.current = null;
  };

  return (
    <div className="crop-overlay">
      <span className="hint">Drag to crop out anything that isn't the hand, then tap Scan.</span>
      <div className="crop-stage" ref={stageRef}>
        <div className="crop-mask crop-mask-top" style={{ height: `${rect.y * 100}%` }} />
        <div className="crop-mask crop-mask-bottom" style={{ top: `${(rect.y + rect.h) * 100}%` }} />
        <div
          className="crop-mask crop-mask-left"
          style={{ top: `${rect.y * 100}%`, height: `${rect.h * 100}%`, width: `${rect.x * 100}%` }}
        />
        <div
          className="crop-mask crop-mask-right"
          style={{ top: `${rect.y * 100}%`, height: `${rect.h * 100}%`, left: `${(rect.x + rect.w) * 100}%` }}
        />
        <div
          className="crop-rect"
          style={{ left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.w * 100}%`, height: `${rect.h * 100}%` }}
          onPointerDown={beginDrag("move")}
          onPointerMove={onDragMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          {CROP_HANDLES.map((corner) => (
            <span
              key={corner}
              className={`crop-handle crop-handle-${corner}`}
              onPointerDown={beginDrag(corner)}
              onPointerMove={onDragMove}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
            />
          ))}
        </div>
      </div>
      <div className="crop-actions">
        <button type="button" onClick={() => setRect(FULL_CROP)} disabled={rect === FULL_CROP}>
          Reset
        </button>
        <div className="crop-actions-right">
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" onClick={() => onConfirm(cropToCanvas(image, rect))}>
            Scan
          </button>
        </div>
      </div>
    </div>
  );
}

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

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [scanStatus, setScanStatus] = useState<"idle" | "cropping" | "loading" | "review" | "error">("idle");
  const [scanError, setScanError] = useState<string | null>(null);
  const [scanProgress, setScanProgress] = useState<ScanProgress | null>(null);
  const [scanPreview, setScanPreview] = useState<{ imageUrl: string; tiles: Tile[]; ignoredBonusCount: number } | null>(
    null
  );
  const [cropImage, setCropImage] = useState<HTMLImageElement | null>(null);

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

  const runScan = async (source: HTMLImageElement | HTMLCanvasElement) => {
    setScanStatus("loading");
    setScanError(null);
    setScanProgress({ phase: "downloading-model", loaded: 0, total: null });
    try {
      const box = letterbox(source);
      const { detections, tiles, ignoredBonusCount } = await detectTiles(box, setScanProgress);
      drawDetections(box.canvas, detections);
      setScanPreview({ imageUrl: box.canvas.toDataURL(), tiles, ignoredBonusCount });
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
    onTextChange(formatHand(scanPreview.tiles));
    setScanStatus("idle");
    setScanPreview(null);
  };
  const cancelScan = () => {
    setScanStatus("idle");
    setScanPreview(null);
    setScanError(null);
  };

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
            placeholder="e.g. 111222333444m11t22s"
            spellCheck={false}
          />
          {error && <span className="error">{error}</span>}
        </div>

        <div className="scan-input">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            onChange={handleScanFile}
            style={{ display: "none" }}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={scanStatus === "loading" || scanStatus === "cropping"}
          >
            {scanStatus === "loading" ? scanStatusLabel(scanProgress) : "📷 Scan a hand"}
          </button>
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
              {scanProgressDetail(scanProgress) && (
                <span className="scan-progress-detail">{scanProgressDetail(scanProgress)}</span>
              )}
            </div>
          )}
          {scanStatus === "error" && scanError && <span className="error">{scanError}</span>}
        </div>

        {scanStatus === "cropping" && cropImage && (
          <CropOverlay image={cropImage} onConfirm={runScan} onCancel={cancelCrop} />
        )}

        {scanStatus === "review" && scanPreview && (
          <div className="scan-review">
            <img src={scanPreview.imageUrl} alt="Scanned hand with detected tiles boxed" />
            <div className="scan-review-summary">
              <span>
                {scanPreview.tiles.length} tile{scanPreview.tiles.length === 1 ? "" : "s"} detected
                {scanPreview.ignoredBonusCount > 0 &&
                  ` (+${scanPreview.ignoredBonusCount} flower/season tile${scanPreview.ignoredBonusCount === 1 ? "" : "s"} ignored)`}
              </span>
              <div className="scan-review-actions">
                <button type="button" onClick={cancelScan}>
                  Cancel
                </button>
                <button type="button" onClick={confirmScan} disabled={scanPreview.tiles.length === 0}>
                  Use this hand
                </button>
              </div>
            </div>
          </div>
        )}

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

function App() {
  const [mode, setMode] = useState<"calculator" | "trainer">("calculator");
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
      </div>
      {mode === "calculator" ? <Calculator /> : <TrainerPanel stats={trainerStats} setStats={setTrainerStats} />}
      <footer className="build-version">v{__BUILD_TIME__}</footer>
    </div>
  );
}

export default App;
