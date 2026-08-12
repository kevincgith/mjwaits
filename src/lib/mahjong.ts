// Core engine for a Taiwanese (16-tile) Mahjong waits calculator.
//
// A complete Taiwanese hand is 5 melds (triplet or run) + 1 pair = 17 tiles.
// A tenpai hand is 16 tiles, one tile short of complete. This module figures
// out, for a given 16-tile hand, which tiles complete it.

export type Suit = "m" | "p" | "s" | "z";

export interface Tile {
  suit: Suit;
  rank: number; // 1-9 for m/p/s, 1-7 for z (honors)
}

export const MELDS_REQUIRED = 5;
export const TENPAI_SIZE = MELDS_REQUIRED * 3 + 1; // 16
export const COMPLETE_SIZE = MELDS_REQUIRED * 3 + 2; // 17

// Honor order/labels follow the common riichi convention:
// 1 East, 2 South, 3 West, 4 North, 5 White, 6 Green, 7 Red.
const HONOR_NAMES = ["", "East", "South", "West", "North", "White", "Green", "Red"];

export function tileKey(t: Tile): string {
  return `${t.suit}${t.rank}`;
}

export function allTileKinds(): Tile[] {
  const tiles: Tile[] = [];
  for (const suit of ["m", "p", "s"] as const) {
    for (let rank = 1; rank <= 9; rank++) tiles.push({ suit, rank });
  }
  for (let rank = 1; rank <= 7; rank++) tiles.push({ suit: "z", rank });
  return tiles;
}

export function tileLabel(t: Tile): string {
  if (t.suit === "z") return HONOR_NAMES[t.rank];
  const suitName = t.suit === "m" ? "Man" : t.suit === "p" ? "Pin" : "Sou";
  return `${t.rank} ${suitName}`;
}

// Unicode Mahjong Tiles block glyphs for the numbered suits (well-supported
// by most fonts). Honor tiles use traditional CJK characters instead, since
// the wind/dragon codepoints in that block have poor font coverage.
const HONOR_GLYPHS = ["", "東", "南", "西", "北", "白", "發", "中"];

export function tileGlyph(t: Tile): string {
  if (t.suit === "m") return String.fromCodePoint(0x1f007 + (t.rank - 1));
  if (t.suit === "s") return String.fromCodePoint(0x1f010 + (t.rank - 1));
  if (t.suit === "p") return String.fromCodePoint(0x1f019 + (t.rank - 1));
  return HONOR_GLYPHS[t.rank];
}

export class ParseError extends Error {}

// Parses algebraic notation like "123456789m11p22s" or "111z" into tiles.
export function parseHand(input: string): Tile[] {
  const trimmed = input.trim();
  if (trimmed === "") return [];
  const groupPattern = /(\d+)([mpsz])/g;
  const tiles: Tile[] = [];
  let matched = "";
  let match: RegExpExecArray | null;
  while ((match = groupPattern.exec(trimmed)) !== null) {
    matched += match[0];
    const [, digits, suitChar] = match;
    const suit = suitChar as Suit;
    for (const d of digits) {
      const rank = Number(d);
      if (suit === "z") {
        if (rank < 1 || rank > 7) {
          throw new ParseError(`Invalid honor tile "${d}z" (must be 1-7)`);
        }
      } else if (rank < 1 || rank > 9) {
        throw new ParseError(`Invalid tile "${d}${suit}" (must be 1-9)`);
      }
      tiles.push({ suit, rank });
    }
  }
  if (matched.replace(/\s/g, "") !== trimmed.replace(/\s/g, "")) {
    throw new ParseError(`Could not parse: "${trimmed}"`);
  }
  return tiles;
}

export function formatHand(tiles: Tile[]): string {
  const bySuit: Record<Suit, number[]> = { m: [], p: [], s: [], z: [] };
  for (const t of tiles) bySuit[t.suit].push(t.rank);
  const order: Suit[] = ["m", "p", "s", "z"];
  return order
    .filter((suit) => bySuit[suit].length > 0)
    .map((suit) => bySuit[suit].sort((a, b) => a - b).join("") + suit)
    .join("");
}

export function sortTiles(tiles: Tile[]): Tile[] {
  const order: Record<Suit, number> = { m: 0, p: 1, s: 2, z: 3 };
  return [...tiles].sort((a, b) => order[a.suit] - order[b.suit] || a.rank - b.rank);
}

function countsForSuit(tiles: Tile[], suit: Suit, size: number): number[] {
  const counts = new Array(size + 1).fill(0);
  for (const t of tiles) if (t.suit === suit) counts[t.rank]++;
  return counts;
}

// Can `counts` (1-indexed, index 0 unused) be fully decomposed into triplets
// (and runs, if `allowRuns`) with nothing left over?
function canDecompose(counts: number[], allowRuns: boolean): boolean {
  const size = counts.length - 1;
  let i = 1;
  while (i <= size && counts[i] === 0) i++;
  if (i > size) return true; // nothing left, fully decomposed

  if (counts[i] >= 3) {
    counts[i] -= 3;
    if (canDecompose(counts, allowRuns)) {
      counts[i] += 3;
      return true;
    }
    counts[i] += 3;
  }

  if (allowRuns && i <= size - 2 && counts[i + 1] > 0 && counts[i + 2] > 0) {
    counts[i]--;
    counts[i + 1]--;
    counts[i + 2]--;
    if (canDecompose(counts, allowRuns)) {
      counts[i]++;
      counts[i + 1]++;
      counts[i + 2]++;
      return true;
    }
    counts[i]++;
    counts[i + 1]++;
    counts[i + 2]++;
  }

  return false;
}

// Checks whether `tiles` (expected length = COMPLETE_SIZE) decomposes into
// MELDS_REQUIRED melds (triplet/run) plus exactly one pair.
export function isCompleteHand(tiles: Tile[]): boolean {
  if (tiles.length !== COMPLETE_SIZE) return false;

  const m = countsForSuit(tiles, "m", 9);
  const p = countsForSuit(tiles, "p", 9);
  const s = countsForSuit(tiles, "s", 9);
  const z = countsForSuit(tiles, "z", 7);

  const suitsData: { counts: number[]; allowRuns: boolean }[] = [
    { counts: m, allowRuns: true },
    { counts: p, allowRuns: true },
    { counts: s, allowRuns: true },
    { counts: z, allowRuns: false },
  ];

  for (const { counts } of suitsData) {
    for (let rank = 1; rank < counts.length; rank++) {
      if (counts[rank] >= 2) {
        counts[rank] -= 2;
        const ok = suitsData.every((sd) => canDecompose(sd.counts, sd.allowRuns));
        counts[rank] += 2;
        if (ok) return true;
      }
    }
  }
  return false;
}

// For a tenpai hand (length TENPAI_SIZE), returns every tile kind that
// completes it.
export function getWaits(tiles: Tile[]): Tile[] {
  if (tiles.length !== TENPAI_SIZE) return [];

  const waits: Tile[] = [];
  for (const candidate of allTileKinds()) {
    const already = tiles.filter(
      (t) => t.suit === candidate.suit && t.rank === candidate.rank
    ).length;
    if (already >= 4) continue; // all 4 copies already used, can't draw a 5th
    if (isCompleteHand([...tiles, candidate])) {
      waits.push(candidate);
    }
  }
  return waits;
}
