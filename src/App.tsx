import { useMemo, useState } from "react";
import "./App.css";
import {
  ParseError,
  TENPAI_SIZE,
  allTileKinds,
  formatHand,
  getWaits,
  isCheckpointSize,
  meldsForSize,
  parseHand,
  sortTiles,
  tileCount,
  tileGlyph,
  tileLabel,
} from "./lib/mahjong";
import type { Suit, Tile } from "./lib/mahjong";

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

function App() {
  const [hand, setHand] = useState<Tile[]>([]);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);

  const applyHand = (tiles: Tile[]) => {
    setHand(tiles);
    setText(formatHand(tiles));
    setError(null);
  };

  const addTile = (tile: Tile) => {
    if (hand.length >= TENPAI_SIZE) return;
    applyHand(sortTiles([...hand, tile]));
  };

  const onTextChange = (value: string) => {
    setText(value);
    try {
      const tiles = parseHand(value);
      setHand(tiles);
      setError(null);
    } catch (e) {
      setError(e instanceof ParseError ? e.message : "Could not parse hand");
    }
  };

  const handleSort = () => setHand((h) => sortTiles(h));
  const handleReset = () => applyHand([]);
  const removeTileAt = (index: number) => applyHand(hand.filter((_, i) => i !== index));

  const canCalculate = isCheckpointSize(hand.length);
  const upcoming = nextCheckpoint(hand.length);
  const results = useMemo(
    () => (canCalculate && hand.length > 0 ? getWaits(hand, meldsForSize(hand.length)) : null),
    [hand, canCalculate]
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
          <button type="button" onClick={handleSort} disabled={hand.length === 0}>
            Sort
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
          {hand.map((t, i) => (
            <HandTileButton key={i} tile={t} onClick={() => removeTileAt(i)} />
          ))}
        </div>

        {results !== null && (
          <div className="waits">
            {results.length > 0 ? (
              <>
                <span className="waits-label">Waiting for:</span>
                {results.map((t) => (
                  <TileGlyphSpan key={tileLabel(t)} tile={t} large />
                ))}
              </>
            ) : (
              <span className="waits-label">Not tenpai — no winning tile completes this hand.</span>
            )}
          </div>
        )}
        {results === null && hand.length > 0 && upcoming !== undefined && (
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
