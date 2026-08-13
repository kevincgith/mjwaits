import { useMemo, useRef, useState } from "react";
import "./App.css";
import {
  ParseError,
  TENPAI_SIZE,
  allTileKinds,
  analyzeDiscards,
  decomposeHand,
  formatHand,
  getWaitsWithJokers,
  isCheckpointSize,
  meldsForSize,
  parseHand,
  shanten,
  sortTiles,
  tileCount,
  tileGlyph,
  tileLabel,
} from "./lib/mahjong";
import type { DiscardOption, JokerWaitResult, Suit, Tile } from "./lib/mahjong";

// A stable id per tile instance, so sorting for display never loses track
// of which underlying tile is which (needed to revert Sort cleanly, and to
// remove the right instance when several tiles share a suit/rank).
interface HandTile extends Tile {
  id: number;
}

const JOKER_TILE: Tile = { suit: "j", rank: 1 };
const SUIT_ORDER: Suit[] = ["m", "t", "s", "z"];
const CHECKPOINTS = [1, 4, 7, 10, 13, 16];

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

function TileGlyphSpan({ tile, large, highlight }: { tile: Tile; large?: boolean; highlight?: boolean }) {
  const classes = ["tile-glyph", large && "large", highlight && "wait-highlight"].filter(Boolean).join(" ");
  return (
    <span className={classes} data-suit={tile.suit} data-rank={tile.rank}>
      {tileGlyph(tile)}
    </span>
  );
}

function TileButton({ tile, onClick, disabled }: { tile: Tile; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      className="tile-button"
      onClick={onClick}
      disabled={disabled}
      title={tileLabel(tile)}
    >
      <TileGlyphSpan tile={tile} />
    </button>
  );
}

function HandTileButton({ tile, onClick }: { tile: Tile; onClick: () => void }) {
  return (
    <button type="button" className="hand-tile-button" onClick={onClick} title={`Remove ${tileLabel(tile)}`}>
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
    // Special hands (Thirteen Orphans, Eight Pairs) don't decompose into
    // melds + pair - fall back to the plain wait display for these.
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
  const ordered = sorted
    ? [...groups].sort((a, b) => {
        const [ta, tb] = [a.tiles[0], b.tiles[0]];
        return SUIT_ORDER.indexOf(ta.suit) - SUIT_ORDER.indexOf(tb.suit) || ta.rank - tb.rank;
      })
    : groups;

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

function DiscardOptionRow({ option }: { option: DiscardOption }) {
  return (
    <div className="discard-row">
      <TileGlyphSpan tile={option.discard} />
      <span className="discard-arrow">→</span>
      {option.draws.length > 0 ? (
        option.draws.map((t) => <TileGlyphSpan key={tileLabel(t)} tile={t} />)
      ) : (
        <span className="hint">no draw reaches tenpai</span>
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
  const [waitsCountMode, setWaitsCountMode] = useState(false);
  const nextId = useRef(0);
  const withIds = (tiles: Tile[]): HandTile[] => tiles.map((t) => ({ ...t, id: nextId.current++ }));
  const forDisplay = (tiles: HandTile[], sorted: boolean) => (sorted ? (sortTiles(tiles) as HandTile[]) : tiles);

  const displayHand = useMemo(() => forDisplay(hand, sortMode), [hand, sortMode]);

  const applyHand = (tiles: HandTile[]) => {
    setHand(tiles);
    setText(formatHand(forDisplay(tiles, sortMode)));
    setError(null);
  };

  const addTile = (tile: Tile) => {
    if (hand.length >= TENPAI_SIZE) return;
    applyHand([...hand, ...withIds([tile])]);
  };

  const onTextChange = (value: string) => {
    setText(value);
    try {
      setHand(withIds(parseHand(value)));
      setError(null);
    } catch (e) {
      setError(e instanceof ParseError ? e.message : "Could not parse hand");
    }
  };

  const toggleSortMode = () => {
    const next = !sortMode;
    setSortMode(next);
    setText(formatHand(forDisplay(hand, next)));
  };
  const handleReset = () => applyHand([]);
  const removeTile = (id: number) => applyHand(hand.filter((t) => t.id !== id));

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
  const discardOptions = useMemo(
    () =>
      !hasJokers && hand.length === TENPAI_SIZE && outcome && !outcome.overflowed && outcome.results.length === 0
        ? analyzeDiscards(hand)
        : null,
    [hand, outcome, hasJokers]
  );
  const nonJokerHand = useMemo(() => hand.filter((t) => t.suit !== "j"), [hand]);
  const remainingCounts = useMemo(() => {
    if (!waitsCountMode || outcome === null || outcome.overflowed) return null;
    const byKey = new Map<string, number>();
    for (const r of outcome.results) byKey.set(tileLabel(r.wait), 4 - tileCount(nonJokerHand, r.wait));
    return byKey;
  }, [waitsCountMode, outcome, nonJokerHand]);
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
                    disabled={hand.length >= TENPAI_SIZE || tileCount(hand, t) >= 4}
                  />
                ))}
            </div>
          ))}
          <div className="suit-row">
            <TileButton tile={JOKER_TILE} onClick={() => addTile(JOKER_TILE)} disabled={hand.length >= TENPAI_SIZE} />
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
          <button
            type="button"
            className={waitsCountMode ? "toggle-on" : undefined}
            onClick={() => setWaitsCountMode((v) => !v)}
            aria-pressed={waitsCountMode}
            title={
              waitsCountMode
                ? "Waits Count: on — shows how many of each waiting tile are left"
                : "Waits Count: off"
            }
          >
            Waits Count: {waitsCountMode ? "On" : "Off"}
          </button>
          <span className="tile-count">
            {hand.length} / {TENPAI_SIZE} tiles
          </span>
          {shantenValue !== null && (
            <span
              className="shanten-badge"
              title="Shanten: minimum discard+draw exchanges from tenpai. Covers the standard shape and Eight Pairs; doesn't yet account for jokers or Thirteen Orphans."
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
        {outcome !== null && !outcome.overflowed && outcome.results.length === 0 && discardOptions === null && (
          <div className="waits">
            <span className="waits-label">
              Not tenpai — no winning tile completes this hand{hasJokers ? ", even trying every joker possibility" : ""}.
            </span>
            {hasJokers && <span className="hint">Discard analysis isn't available yet for hands with jokers.</span>}
          </div>
        )}
        {discardOptions !== null && (
          <div className="waits discard-analysis">
            <span className="waits-label">Not tenpai — discard options and what to draw:</span>
            {discardOptions.map((o) => (
              <DiscardOptionRow key={tileLabel(o.discard)} option={o} />
            ))}
          </div>
        )}
        {outcome === null && hand.length > 0 && upcoming !== undefined && (
          <div className="waits">
            <span className="hint">
              Add {upcoming - hand.length} more tile{upcoming - hand.length === 1 ? "" : "s"} to see waits.
            </span>
          </div>
        )}
      </section>
    </div>
  );
}

export default App;
