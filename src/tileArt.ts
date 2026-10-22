// How tiles are drawn, switchable from the hidden developer sheet:
//   "art"     - the SVG tile faces in assets/tiles (see CREDITS.md there)
//   "unicode" - the Mahjong Tiles Unicode glyphs, in the system symbol font
// The choice is per browser (localStorage); the default is "art".

import { createContext, useContext } from "react";
import type { Tile } from "@mjwaits/shared/engine/mahjong";
import type { BonusTile } from "@mjwaits/shared/engine/scoring";

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

// Swaps the tile art for other images, keyed by the art's own URL. Only the
// printable rules reference sets it: there, every tile kind prints from one
// shared PNG instead of the SVG, because a PDF repeats an SVG's drawing for
// every tile shown (≈1,400 in a reference) but stores a repeated image once
// - about a third of the file size in Safari's engine.
export const TileArtRemapContext = createContext<ReadonlyMap<string, string> | null>(null);

export function useTileArtUrl(): (url: string) => string {
  const remap = useContext(TileArtRemapContext);
  return (url) => remap?.get(url) ?? url;
}

/** Every tile artwork drawn once as a PNG `height` pixels tall, keyed by
 *  its SVG URL (blob: URLs - revoke them when done). */
export async function rasterizeTileArt(height: number): Promise<Map<string, string>> {
  const entries = await Promise.all(
    Object.values(ART).map(
      (url) =>
        new Promise<[string, string] | null>((resolve) => {
          const img = new Image();
          img.onload = () => {
            const canvas = document.createElement("canvas");
            canvas.height = height;
            canvas.width = Math.round((height * img.naturalWidth) / img.naturalHeight);
            canvas.getContext("2d")?.drawImage(img, 0, 0, canvas.width, canvas.height);
            canvas.toBlob((blob) => resolve(blob ? [url, URL.createObjectURL(blob)] : null), "image/png");
          };
          img.onerror = () => resolve(null);
          img.src = url;
        }),
    ),
  );
  return new Map(entries.filter((e): e is [string, string] => e !== null));
}

// English names for the 8 bonus tiles, keyed by the number painted on the
// tile (see the glyph notes in TileGlyphs.tsx).
const FLOWER_NAMES: Record<1 | 2 | 3 | 4, string> = { 1: "Plum", 2: "Orchid", 3: "Chrysanthemum", 4: "Bamboo" };
const SEASON_NAMES: Record<1 | 2 | 3 | 4, string> = { 1: "Spring", 2: "Summer", 3: "Autumn", 4: "Winter" };

export function bonusTileLabel(tile: BonusTile): string {
  return tile.kind === "flower" ? `Flower: ${FLOWER_NAMES[tile.rank]}` : `Season: ${SEASON_NAMES[tile.rank]}`;
}
