import { useMemo, useState } from "react";
import "./App.css";
import {
  ParseError,
  TENPAI_SIZE,
  allTileKinds,
  formatHand,
  getWaits,
  parseHand,
  sortTiles,
  tileGlyph,
  tileLabel,
} from "./lib/mahjong";
import type { Suit, Tile } from "./lib/mahjong";

const SUIT_ORDER: Suit[] = ["m", "p", "s", "z"];
const SUIT_LABELS: Record<Suit, string> = { m: "Man", p: "Pin", s: "Sou", z: "Honors" };

function TileButton({ tile, onClick, disabled }: { tile: Tile; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      className="tile-button"
      onClick={onClick}
      disabled={disabled}
      title={tileLabel(tile)}
    >
      <span className="tile-glyph" data-suit={tile.suit}>
        {tileGlyph(tile)}
      </span>
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

  const handleSort = () => applyHand(sortTiles(hand));
  const handleReset = () => applyHand([]);

  const waits = useMemo(() => (hand.length === TENPAI_SIZE ? getWaits(hand) : []), [hand]);

  const remaining = TENPAI_SIZE - hand.length;

  return (
    <div className="page">
      <h1>Mahjong Waits Calculator</h1>
      <p className="subtitle">Taiwanese rules · 16-tile hand</p>

      <section className="panel">
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
          {hand.length === 0 && <span className="hint">Click tiles below, or type algebraic notation.</span>}
          {hand.map((t, i) => (
            <span key={i} className="tile-glyph large" data-suit={t.suit}>
              {tileGlyph(t)}
            </span>
          ))}
        </div>

        {hand.length === TENPAI_SIZE && (
          <div className="waits">
            {waits.length > 0 ? (
              <>
                <span className="waits-label">Waiting for:</span>
                {waits.map((t) => (
                  <span key={tileLabel(t)} className="tile-glyph large" data-suit={t.suit}>
                    {tileGlyph(t)}
                  </span>
                ))}
              </>
            ) : (
              <span className="waits-label">Not tenpai — no winning tile completes this hand.</span>
            )}
          </div>
        )}
        {hand.length < TENPAI_SIZE && hand.length > 0 && (
          <div className="waits">
            <span className="hint">Add {remaining} more tile{remaining === 1 ? "" : "s"} to check waits.</span>
          </div>
        )}

        <div className="tile-picker">
          {SUIT_ORDER.map((suit) => (
            <div className="suit-row" key={suit}>
              <span className="suit-label">{SUIT_LABELS[suit]}</span>
              {allTileKinds()
                .filter((t) => t.suit === suit)
                .map((t) => (
                  <TileButton
                    key={tileLabel(t)}
                    tile={t}
                    onClick={() => addTile(t)}
                    disabled={hand.length >= TENPAI_SIZE}
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
            placeholder="e.g. 111222333444m11p22s"
            spellCheck={false}
          />
          {error && <span className="error">{error}</span>}
        </div>
      </section>
    </div>
  );
}

export default App;
