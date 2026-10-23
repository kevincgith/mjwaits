// 回顧: a look back at your discards in the hand just played - your hand as
// it stood, what you threw, what the Grandmaster would have thrown, and how
// risky your tile was (the bots' own read of the table: who looks ready,
// what's safe). The tile that dealt in is marked. Everything is worked out
// from what you could see at the time, so it reads the same online.

import { useMemo } from "react";
import { HUMAN, sameTile, type GameState } from "@mjwaits/shared/engine/game";
import { profileById, rateDiscardsFor } from "@mjwaits/shared/engine/bots";
import { sortTiles, type Tile } from "@mjwaits/shared/engine/mahjong";
import { TileGlyphSpan } from "./TileGlyphs";

// One of your discards: the table just before you threw, and the tile.
export interface Decision {
  before: GameState;
  tile: Tile;
}

const COACH = profileById("grandmaster");
// Risk as the hints mark it (see DANGER_MARK in PlayPanel): a tile at least
// this dangerous gets the red mark.
const RISKY = 0.12;
const SOME_RISK = 0.05;

interface Row {
  hand: Tile[];
  tile: Tile;
  best: Tile | null;
  danger: number;
  locked: boolean;
}

export function ReviewSheet({ decisions, dealtIn, onClose }: { decisions: Decision[]; dealtIn: boolean; onClose: () => void }) {
  const rows = useMemo<Row[]>(
    () =>
      decisions.map(({ before, tile }) => {
        const locked = !!before.players[HUMAN].riichi;
        let best: Tile | null = null;
        let danger = 0;
        try {
          const ratings = rateDiscardsFor(before, HUMAN, COACH);
          best = ratings[0]?.tile ?? null;
          danger = ratings.find((r) => sameTile(r.tile, tile))?.danger ?? 0;
        } catch {
          // A table it can't read (shouldn't happen): no advice for this one.
        }
        return { hand: sortTiles(before.players[HUMAN].hand), tile, best, danger, locked };
      }),
    [decisions]
  );
  const free = rows.filter((r) => !r.locked && r.best);
  const agreed = free.filter((r) => r.best && sameTile(r.best, r.tile)).length;

  return (
    <div className="play-sheet-backdrop" onClick={onClose}>
      <div className="play-sheet play-review" role="dialog" aria-label="Hand review" onClick={(e) => e.stopPropagation()}>
        <div className="play-sheet-head">
          <h2>回顧 Review</h2>
          <span>
            {free.length > 0 ? `Your discards: the Grandmaster agreed with ${agreed} of ${free.length}` : "You didn't discard this hand"}
          </span>
          <button type="button" className="play-sheet-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <ol className="play-review-list">
          {rows.map((r, i) => {
            const last = i === rows.length - 1;
            const dealIn = dealtIn && last;
            const same = !r.best || sameTile(r.best, r.tile);
            const risk = r.danger >= RISKY ? "is-high" : r.danger >= SOME_RISK ? "is-some" : "is-low";
            return (
              <li key={i} className={`play-review-row${dealIn ? " is-deal-in" : ""}`}>
                <span className="play-review-n">{i + 1}</span>
                <span className="play-review-hand" aria-label="Your hand">
                  {r.hand.map((t, j) => (
                    <TileGlyphSpan key={j} tile={t} highlight={sameTile(t, r.tile) && j === r.hand.findIndex((h) => sameTile(h, r.tile))} />
                  ))}
                </span>
                <span className="play-review-verdict">
                  <span className="play-review-threw">
                    <TileGlyphSpan tile={r.tile} />
                    {dealIn ? <b className="play-review-tag is-deal-in">出銃</b> : <b className={`play-review-tag ${risk}`}>{risk === "is-high" ? "risky" : risk === "is-some" ? "some risk" : "safe-ish"}</b>}
                  </span>
                  {r.locked ? (
                    <span className="play-review-note">叮 - your hand was locked</span>
                  ) : same ? (
                    <span className="play-review-note is-agree">✓ Grandmaster too</span>
                  ) : (
                    <span className="play-review-note">
                      宗師 would throw <TileGlyphSpan tile={r.best!} />
                    </span>
                  )}
                </span>
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}
