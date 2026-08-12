import { useMemo, useRef, useState } from "react";
import "./App.css";
import {
  ParseError,
  TENPAI_SIZE,
  allTileKinds,
  analyzeDiscards,
  formatHand,
  getWaitsWithJokers,
  isCheckpointSize,
  meldsForSize,
  parseHand,
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

function nextCheckpoint(size: number): number | undefined {
  return CHECKPOINTS.find((c) => c > size);
}

function TileGlyphSpan({ tile, large }: { tile: Tile; large?: boolean }) {
  return (
    <span className={large ? "tile-glyph large" : "tile-glyph"} data-suit={tile.suit} data-rank={tile.rank}>
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

function WaitResultTile({ result }: { result: JokerWaitResult }) {
  return (
    <span className="wait-result">
      <TileGlyphSpan tile={result.wait} large />
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
  const discardOptions = useMemo(
    () =>
      !hasJokers && hand.length === TENPAI_SIZE && outcome && !outcome.overflowed && outcome.results.length === 0
        ? analyzeDiscards(hand)
        : null,
    [hand, outcome, hasJokers]
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
          <span className="tile-count">
            {hand.length} / {TENPAI_SIZE} tiles
          </span>
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
          <div className="waits">
            <span className="waits-label">Waiting for:</span>
            {outcome.results.map((r) => (
              <WaitResultTile key={tileLabel(r.wait)} result={r} />
            ))}
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
