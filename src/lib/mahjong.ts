// Core engine for a Taiwanese (16-tile) Mahjong waits calculator.
//
// A complete Taiwanese hand is 5 melds (triplet or run) + 1 pair = 17 tiles.
// A tenpai hand is 16 tiles, one tile short of complete. This module figures
// out, for a given 16-tile hand, which tiles complete it.

export type Suit = "m" | "t" | "s" | "z";

export interface Tile {
  suit: Suit;
  rank: number; // 1-9 for m/t/s, 1-7 for z (honors)
}

export const MELDS_REQUIRED = 5;
export const TENPAI_SIZE = MELDS_REQUIRED * 3 + 1; // 16
export const COMPLETE_SIZE = MELDS_REQUIRED * 3 + 2; // 17

// A hand can only be checked for waits at sizes of the form 3n + 1 (one tile
// short of some number of complete melds plus a pair): 1, 4, 7, 10, 13, 16.
export function isCheckpointSize(size: number): boolean {
  return size >= 1 && size <= TENPAI_SIZE && size % 3 === 1;
}

export function meldsForSize(size: number): number {
  return (size - 1) / 3;
}

// Honor order/labels: 1 East, 2 South, 3 West, 4 North, 5 Red, 6 Green, 7 White.
const HONOR_NAMES = ["", "East", "South", "West", "North", "Red", "Green", "White"];

export function tileKey(t: Tile): string {
  return `${t.suit}${t.rank}`;
}

export function allTileKinds(): Tile[] {
  const tiles: Tile[] = [];
  for (const suit of ["m", "t", "s"] as const) {
    for (let rank = 1; rank <= 9; rank++) tiles.push({ suit, rank });
  }
  for (let rank = 1; rank <= 7; rank++) tiles.push({ suit: "z", rank });
  return tiles;
}

export function tileLabel(t: Tile): string {
  if (t.suit === "z") return HONOR_NAMES[t.rank];
  const suitName = t.suit === "m" ? "Man" : t.suit === "t" ? "Pin" : "Sou";
  return `${t.rank} ${suitName}`;
}

// Unicode Mahjong Tiles block glyphs (U+1F000-U+1F02B).
// Honor order: East South West North (1F000-1F003), Red Green White (1F004,1F005,1F006).
const HONOR_CODEPOINTS: Record<number, number> = {
  1: 0x1f000,
  2: 0x1f001,
  3: 0x1f002,
  4: 0x1f003,
  5: 0x1f004,
  6: 0x1f005,
  7: 0x1f006,
};

// U+FE0E forces text (not emoji/color) presentation, since some of these
// codepoints (notably Red Dragon, U+1F004) default to emoji presentation
// while the rest of the block doesn't, which otherwise looks inconsistent.
const TEXT_PRESENTATION = String.fromCodePoint(0xfe0e);

export function tileGlyph(t: Tile): string {
  if (t.suit === "m") return String.fromCodePoint(0x1f007 + (t.rank - 1)) + TEXT_PRESENTATION;
  if (t.suit === "s") return String.fromCodePoint(0x1f010 + (t.rank - 1)) + TEXT_PRESENTATION;
  if (t.suit === "t") return String.fromCodePoint(0x1f019 + (t.rank - 1)) + TEXT_PRESENTATION;
  return String.fromCodePoint(HONOR_CODEPOINTS[t.rank]) + TEXT_PRESENTATION;
}

export class ParseError extends Error {}

// Parses algebraic notation like "123456789m11p22s" or "111z" into tiles.
export function parseHand(input: string): Tile[] {
  const trimmed = input.trim();
  if (trimmed === "") return [];
  const groupPattern = /(\d+)([mtsz])/g;
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
  if (tiles.length > TENPAI_SIZE) {
    throw new ParseError(`Too many tiles (max ${TENPAI_SIZE})`);
  }

  const counts = new Map<string, number>();
  for (const t of tiles) {
    const key = tileKey(t);
    const count = (counts.get(key) ?? 0) + 1;
    if (count > 4) {
      throw new ParseError(`Too many copies of ${tileLabel(t)} (max 4)`);
    }
    counts.set(key, count);
  }

  return tiles;
}

export function tileCount(tiles: Tile[], tile: Tile): number {
  return tiles.filter((t) => t.suit === tile.suit && t.rank === tile.rank).length;
}

export function formatHand(tiles: Tile[]): string {
  const bySuit: Record<Suit, number[]> = { m: [], t: [], s: [], z: [] };
  for (const t of tiles) bySuit[t.suit].push(t.rank);
  const order: Suit[] = ["m", "t", "s", "z"];
  return order
    .filter((suit) => bySuit[suit].length > 0)
    .map((suit) => bySuit[suit].sort((a, b) => a - b).join("") + suit)
    .join("");
}

export function sortTiles(tiles: Tile[]): Tile[] {
  const order: Record<Suit, number> = { m: 0, t: 1, s: 2, z: 3 };
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

// Checks whether `tiles` decomposes into `meldsRequired` melds (triplet/run)
// plus exactly one pair, i.e. tiles.length must be meldsRequired * 3 + 2.
export function isCompleteHand(tiles: Tile[], meldsRequired: number = MELDS_REQUIRED): boolean {
  if (tiles.length !== meldsRequired * 3 + 2) return false;

  const m = countsForSuit(tiles, "m", 9);
  const t = countsForSuit(tiles, "t", 9);
  const s = countsForSuit(tiles, "s", 9);
  const z = countsForSuit(tiles, "z", 7);

  const suitsData: { counts: number[]; allowRuns: boolean }[] = [
    { counts: m, allowRuns: true },
    { counts: t, allowRuns: true },
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

// For a hand one tile short of meldsRequired melds + a pair (length
// meldsRequired * 3 + 1), returns every tile kind that completes it.
export function getWaits(tiles: Tile[], meldsRequired: number = MELDS_REQUIRED): Tile[] {
  if (tiles.length !== meldsRequired * 3 + 1) return [];

  const waits: Tile[] = [];
  for (const candidate of allTileKinds()) {
    if (tileCount(tiles, candidate) >= 4) continue; // all 4 copies already used, can't draw a 5th
    if (isCompleteHand([...tiles, candidate], meldsRequired)) {
      waits.push(candidate);
    }
  }
  return waits;
}
