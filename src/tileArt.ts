// How tiles are drawn, switchable from the hidden developer sheet:
//   "art"     - the SVG tile faces in assets/tiles (see CREDITS.md there)
//   "unicode" - the Mahjong Tiles Unicode glyphs, in the system symbol font
// The choice is per browser (localStorage); the default is "art".

import { createContext, useContext } from "react";
import type { Tile } from "./lib/mahjong";
import type { BonusTile } from "./lib/scoring";

export type TileStyle = "art" | "unicode";

export const TILE_STYLES: { value: TileStyle; label: string }[] = [
  { value: "art", label: "Tile art" },
  { value: "unicode", label: "Unicode" },
];

const TILE_STYLE_KEY = "mjwaits.tileStyle";

export function loadTileStyle(): TileStyle {
  try {
    const saved = window.localStorage.getItem(TILE_STYLE_KEY);
    if (saved === "art" || saved === "unicode") return saved;
  } catch {
    // Storage blocked - use the default.
  }
  return "art";
}

export function saveTileStyle(style: TileStyle): void {
  try {
    if (style === "art") window.localStorage.removeItem(TILE_STYLE_KEY);
    else window.localStorage.setItem(TILE_STYLE_KEY, style);
  } catch {
    // Storage unavailable - the choice just won't survive a reload.
  }
}

export const TileStyleContext = createContext<TileStyle>("art");

export const useTileStyle = () => useContext(TileStyleContext);

// Vite turns each file into a hashed asset URL.
const ART = import.meta.glob<string>("./assets/tiles/*.svg", { eager: true, query: "?url", import: "default" });
const artUrl = (name: string): string => ART[`./assets/tiles/${name}.svg`];

export function tileArtUrl(tile: Tile): string {
  return artUrl(tile.suit === "j" ? "joker" : `${tile.suit}${tile.rank}`);
}

export function bonusArtUrl(tile: BonusTile): string {
  return artUrl(`${tile.kind}${tile.rank}`);
}

// English names for the 8 bonus tiles, keyed by the number painted on the
// tile (see the glyph notes in TileGlyphs.tsx).
const FLOWER_NAMES: Record<1 | 2 | 3 | 4, string> = { 1: "Plum", 2: "Orchid", 3: "Chrysanthemum", 4: "Bamboo" };
const SEASON_NAMES: Record<1 | 2 | 3 | 4, string> = { 1: "Spring", 2: "Summer", 3: "Autumn", 4: "Winter" };

export function bonusTileLabel(tile: BonusTile): string {
  return tile.kind === "flower" ? `Flower: ${FLOWER_NAMES[tile.rank]}` : `Season: ${SEASON_NAMES[tile.rank]}`;
}
