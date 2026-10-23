// The tile glyph components shared by every tab: one ordinary tile or one
// flower/season, drawn in the current tile style (art or Unicode).

import { tileGlyph, tileLabel, type Tile } from "@mjwaits/shared/engine/mahjong";
import type { BonusTile } from "@mjwaits/shared/engine/scoring";
import { bonusArtUrl, bonusTileLabel, tileArtUrl, useTileArtUrl, useTileStyle } from "./tileArt";

// A tile's sides, for one drawn as a solid block on a 3D table (the Play
// tab's felt): four sides and the four rounded corners between them, which
// its CSS stands up round the face; anywhere else they're hidden.
// Each rounded corner in three panels (see .tile-side.is-corner).
const CORNERS = ["nr1", "nr2", "nr3", "nl1", "nl2", "nl3", "fl1", "fl2", "fl3", "fr1", "fr2", "fr3"];
export const TileSides = () => (
  <>
    <i className="tile-side is-near" />
    <i className="tile-side is-far" />
    <i className="tile-side is-left" />
    <i className="tile-side is-right" />
    {CORNERS.map((c) => (
      <i key={c} className={`tile-side is-corner is-${c}`} />
    ))}
  </>
);

export function TileGlyphSpan({
  tile,
  large,
  highlight,
  jokerAssumed,
  block,
}: {
  tile: Tile;
  large?: boolean;
  highlight?: boolean;
  jokerAssumed?: boolean;
  block?: boolean; // with its sides (see TileSides)
}) {
  const art = useTileStyle() === "art";
  const artUrl = useTileArtUrl();
  const classes = ["tile-glyph", art && "tile-art", large && "large", highlight && "wait-highlight", jokerAssumed && "joker-assumed"]
    .filter(Boolean)
    .join(" ");
  // role/aria-label so assistive tech reads "3 Sou" rather than the bare
  // Mahjong Tiles codepoint. A button wrapping this can override with its own
  // aria-label to describe the action instead.
  return (
    <span
      className={classes}
      data-suit={tile.suit}
      data-rank={tile.rank}
      role="img"
      aria-label={jokerAssumed ? `${tileLabel(tile)} (assumed from a joker)` : tileLabel(tile)}
      title={jokerAssumed ? "Assumed from a joker" : undefined}
    >
      {art ? <img className="tile-face" src={artUrl(tileArtUrl(tile))} alt="" draggable={false} /> : tileGlyph(tile)}
      {art && block && <TileSides />}
    </span>
  );
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
const BONUS_TEXT_PRESENTATION = "︎"; // see mahjong.ts's TEXT_PRESENTATION for why

function bonusTileGlyph(tile: BonusTile): string {
  const codepoint = (tile.kind === "flower" ? FLOWER_CODEPOINTS : SEASON_CODEPOINTS)[tile.rank];
  return String.fromCodePoint(codepoint) + BONUS_TEXT_PRESENTATION;
}

// A flower/season tile, in the current tile style (see TileGlyphSpan).
export function BonusGlyphSpan({ tile, large, label, block }: { tile: BonusTile; large?: boolean; label?: boolean; block?: boolean }) {
  const art = useTileStyle() === "art";
  const artUrl = useTileArtUrl();
  return (
    <span
      className={["tile-glyph", art && "tile-art", large && "large"].filter(Boolean).join(" ")}
      data-suit="bonus"
      {...(label ? { role: "img", "aria-label": bonusTileLabel(tile) } : {})}
    >
      {art ? <img className="tile-face" src={artUrl(bonusArtUrl(tile))} alt="" draggable={false} /> : bonusTileGlyph(tile)}
      {art && block && <TileSides />}
    </span>
  );
}

