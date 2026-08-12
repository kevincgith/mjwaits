// Core engine for a Taiwanese (16-tile) Mahjong waits calculator.
//
// A complete Taiwanese hand is 5 melds (triplet or run) + 1 pair = 17 tiles.
// A tenpai hand is 16 tiles, one tile short of complete. This module figures
// out, for a given 16-tile hand, which tiles complete it.

export type Suit = "m" | "t" | "s" | "z" | "j";

export interface Tile {
  suit: Suit;
  rank: number; // 1-9 for m/t/s, 1-7 for z (honors), always 1 for j (joker)
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
  if (t.suit === "j") return "Joker";
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
  if (t.suit === "j") return String.fromCodePoint(0x1f02a) + TEXT_PRESENTATION;
  return String.fromCodePoint(HONOR_CODEPOINTS[t.rank]) + TEXT_PRESENTATION;
}

export class ParseError extends Error {}

// Parses algebraic notation like "123456789m11p22s" or "111z" into tiles.
// Jokers are written as one or more bare "j" characters (no digits, since a
// joker has no rank), e.g. "jj" for two jokers.
export function parseHand(input: string): Tile[] {
  const trimmed = input.trim();
  if (trimmed === "") return [];
  const groupPattern = /(\d+)([mtsz])|(j+)/g;
  const tiles: Tile[] = [];
  let matched = "";
  let match: RegExpExecArray | null;
  while ((match = groupPattern.exec(trimmed)) !== null) {
    matched += match[0];
    const [, digits, suitChar, jokers] = match;
    if (jokers !== undefined) {
      for (const _ of jokers) tiles.push({ suit: "j", rank: 1 });
      continue;
    }
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
    if (t.suit === "j") continue; // jokers aren't capped at 4 copies
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

// Groups tiles by suit (required by the notation format) but otherwise
// preserves the given order of ranks within each suit - callers that want
// ranks sorted should sort `tiles` first (see sortTiles). Jokers (no rank)
// are written as a run of bare "j" characters.
export function formatHand(tiles: Tile[]): string {
  const bySuit: Record<Suit, number[]> = { m: [], t: [], s: [], z: [], j: [] };
  for (const t of tiles) bySuit[t.suit].push(t.rank);
  const order: Suit[] = ["m", "t", "s", "z", "j"];
  return order
    .filter((suit) => bySuit[suit].length > 0)
    .map((suit) => (suit === "j" ? "j".repeat(bySuit.j.length) : bySuit[suit].join("") + suit))
    .join("");
}

export function sortTiles(tiles: Tile[]): Tile[] {
  const order: Record<Suit, number> = { m: 0, t: 1, s: 2, z: 3, j: 4 };
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

// The 13 "orphan" kinds: the terminal (1/9) of each numbered suit, plus all
// 7 honors.
const ORPHAN_TILES: Tile[] = [
  { suit: "m", rank: 1 },
  { suit: "m", rank: 9 },
  { suit: "t", rank: 1 },
  { suit: "t", rank: 9 },
  { suit: "s", rank: 1 },
  { suit: "s", rank: 9 },
  { suit: "z", rank: 1 },
  { suit: "z", rank: 2 },
  { suit: "z", rank: 3 },
  { suit: "z", rank: 4 },
  { suit: "z", rank: 5 },
  { suit: "z", rank: 6 },
  { suit: "z", rank: 7 },
];
const ORPHAN_KEYS = new Set(ORPHAN_TILES.map(tileKey));

function countAll(tiles: Tile[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const t of tiles) {
    const key = tileKey(t);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

// After removing one candidate meld, do the remaining 14 tiles consist of
// exactly the 13 orphan kinds, each once, except one kind twice (the pair)?
function isOrphanRemainder(counts: Map<string, number>): boolean {
  let total = 0;
  let pairs = 0;
  for (const key of ORPHAN_KEYS) {
    const c = counts.get(key) ?? 0;
    if (c < 1 || c > 2) return false;
    if (c === 2) pairs++;
    total += c;
  }
  if (pairs !== 1 || total !== 14) return false;
  for (const [key, c] of counts) {
    if (!ORPHAN_KEYS.has(key) && c > 0) return false;
  }
  return true;
}

function candidateMelds(tiles: Tile[]): Tile[][] {
  const counts = countAll(tiles);
  const melds: Tile[][] = [];
  for (const [key, c] of counts) {
    if (c >= 3) {
      const suit = key[0] as Suit;
      const rank = Number(key.slice(1));
      melds.push([{ suit, rank }, { suit, rank }, { suit, rank }]);
    }
  }
  for (const suit of ["m", "t", "s"] as const) {
    for (let rank = 1; rank <= 7; rank++) {
      const a = `${suit}${rank}`;
      const b = `${suit}${rank + 1}`;
      const c = `${suit}${rank + 2}`;
      if ((counts.get(a) ?? 0) >= 1 && (counts.get(b) ?? 0) >= 1 && (counts.get(c) ?? 0) >= 1) {
        melds.push([{ suit, rank }, { suit, rank: rank + 1 }, { suit, rank: rank + 2 }]);
      }
    }
  }
  return melds;
}

// The Taiwanese 16-tile Thirteen Orphans special hand: all 13 orphan kinds
// (one of each), one of them doubled to form the pair, plus one ordinary
// meld (pong or chow) - 13 + 1 + 3 = 17 tiles. Structurally unrelated to the
// standard "N melds + pair" shape, so it's checked separately.
export function isThirteenOrphansComplete(tiles: Tile[]): boolean {
  if (tiles.length !== COMPLETE_SIZE) return false;
  for (const meld of candidateMelds(tiles)) {
    const counts = countAll(tiles);
    for (const t of meld) {
      const key = tileKey(t);
      counts.set(key, (counts.get(key) ?? 0) - 1);
    }
    if (isOrphanRemainder(counts)) return true;
  }
  return false;
}

// The Taiwanese 16-tile Eight Pairs special hand ("liuliu"): 8 pairs of
// tile kinds (16 tiles), plus one more tile matching one of those pairs,
// upgrading it to a triplet - 7*2 + 1*3 = 17 tiles. A kind can also appear
// as all 4 copies at once, counting as two of the 8 pairs.
export function isEightPairsComplete(tiles: Tile[]): boolean {
  if (tiles.length !== COMPLETE_SIZE) return false;
  const counts = countAll(tiles);
  let tripleKinds = 0;
  for (const c of counts.values()) {
    if (c === 3) tripleKinds++;
    else if (c !== 2 && c !== 4) return false; // a lone single or 5+ copies breaks the pattern
  }
  return tripleKinds === 1;
}

// Checks whether `tiles` decomposes into `meldsRequired` melds (triplet/run)
// plus exactly one pair, i.e. tiles.length must be meldsRequired * 3 + 2.
export function isCompleteHand(tiles: Tile[], meldsRequired: number = MELDS_REQUIRED): boolean {
  if (tiles.length !== meldsRequired * 3 + 2) return false;
  if (meldsRequired === MELDS_REQUIRED && (isThirteenOrphansComplete(tiles) || isEightPairsComplete(tiles))) {
    return true;
  }

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

// Joker support: a joker tile can stand in for any of the 34 real tile
// kinds. Rather than exhaustively permuting which joker becomes which kind
// (34^N), we enumerate DISTINCT MULTISETS of substitutions - jokers are
// interchangeable with each other, so [5s, White] and [White, 5s] are the
// same assignment - which is C(34 + N - 1, N) and grows far slower.
// Benchmarked: ~14us per combination, so 100,000 keeps worst-case runtime
// under ~1.5s (comfortably covers 4 jokers, C(37,4)=66,045; 5 jokers,
// C(38,5)=501,942, overflows instead of hanging for ~7s).
export const MAX_JOKER_COMBINATIONS = 100_000;

// C(n + k - 1, k), the number of multisets of size k drawn from n kinds.
function combinationsWithRepetition(n: number, k: number): number {
  let result = 1;
  for (let i = 0; i < k; i++) {
    result = (result * (n + k - 1 - i)) / (i + 1);
  }
  return result;
}

// Every distinct multiset of `count` real tiles that could substitute for
// that many jokers, respecting the 4-copies-per-kind cap against whatever
// non-joker tiles are already present (`baseCounts`). Returns null if the
// number of combinations would exceed `cap`.
function jokerSubstitutions(count: number, baseCounts: Map<string, number>, cap: number): Tile[][] | null {
  if (count === 0) return [[]];
  const kinds = allTileKinds();
  const results: Tile[][] = [];
  let overflowed = false;

  function backtrack(startIndex: number, remaining: number, current: Tile[]) {
    if (overflowed) return;
    if (remaining === 0) {
      results.push([...current]);
      if (results.length > cap) overflowed = true;
      return;
    }
    for (let i = startIndex; i < kinds.length && !overflowed; i++) {
      const kind = kinds[i];
      const key = tileKey(kind);
      const alreadyUsed = (baseCounts.get(key) ?? 0) + current.filter((t) => tileKey(t) === key).length;
      if (alreadyUsed >= 4) continue;
      current.push(kind);
      backtrack(i, remaining - 1, current); // same start index -> combinations, not permutations
      current.pop();
    }
  }

  backtrack(0, count, []);
  return overflowed ? null : results;
}

export interface JokerWaitResult {
  wait: Tile;
  // What each joker resolves to for this particular wait (empty if the hand
  // has no jokers). One valid assignment among possibly several.
  jokers: Tile[];
}

export type JokerWaitsOutcome =
  | { overflowed: false; results: JokerWaitResult[] }
  | { overflowed: true; estimatedCombinations: number };

// Joker-aware version of getWaits: tries every viable joker substitution
// and unions the resulting waits, each tagged with an example resolution
// for the jokers. Behaves exactly like getWaits when there are no jokers.
export function getWaitsWithJokers(
  tiles: Tile[],
  meldsRequired: number = MELDS_REQUIRED
): JokerWaitsOutcome {
  const jokerCount = tiles.filter((t) => t.suit === "j").length;
  if (jokerCount === 0) {
    return { overflowed: false, results: getWaits(tiles, meldsRequired).map((wait) => ({ wait, jokers: [] })) };
  }

  const estimate = combinationsWithRepetition(allTileKinds().length, jokerCount);
  if (estimate > MAX_JOKER_COMBINATIONS) {
    return { overflowed: true, estimatedCombinations: estimate };
  }

  const nonJokers = tiles.filter((t) => t.suit !== "j");
  const baseCounts = countAll(nonJokers);
  const substitutions = jokerSubstitutions(jokerCount, baseCounts, MAX_JOKER_COMBINATIONS);
  if (substitutions === null) {
    return { overflowed: true, estimatedCombinations: estimate };
  }

  const found = new Map<string, Tile[]>();
  for (const substitution of substitutions) {
    const concreteHand = [...nonJokers, ...substitution];
    for (const wait of getWaits(concreteHand, meldsRequired)) {
      const key = tileKey(wait);
      if (!found.has(key)) found.set(key, substitution);
    }
  }

  const results = Array.from(found.entries()).map(([key, jokers]) => ({
    wait: allTileKinds().find((t) => tileKey(t) === key)!,
    jokers,
  }));
  return { overflowed: false, results };
}

export interface DiscardOption {
  discard: Tile;
  draws: Tile[];
}

function uniqueTileKinds(tiles: Tile[]): Tile[] {
  const seen = new Set<string>();
  const unique: Tile[] = [];
  for (const t of tiles) {
    const key = tileKey(t);
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(t);
    }
  }
  return unique;
}

// For a hand at a checkpoint size (meldsRequired * 3 + 1), and assuming it is
// NOT already tenpai, finds every (discard, resulting useful draws) pair:
// for each distinct tile you could discard, which tiles - once drawn - bring
// the hand back to that size and into tenpai. Options are sorted by number
// of useful draws, most first.
export function analyzeDiscards(tiles: Tile[], meldsRequired: number = MELDS_REQUIRED): DiscardOption[] {
  const size = meldsRequired * 3 + 1;
  if (tiles.length !== size) return [];

  const options: DiscardOption[] = [];
  for (const discard of uniqueTileKinds(tiles)) {
    const discardIndex = tiles.findIndex((t) => t.suit === discard.suit && t.rank === discard.rank);
    const remaining = [...tiles.slice(0, discardIndex), ...tiles.slice(discardIndex + 1)];

    const draws: Tile[] = [];
    for (const candidate of allTileKinds()) {
      if (tileCount(remaining, candidate) >= 4) continue;
      const redrawn = [...remaining, candidate];
      if (getWaits(redrawn, meldsRequired).length > 0) {
        draws.push(candidate);
      }
    }
    options.push({ discard, draws });
  }

  return options.sort((a, b) => b.draws.length - a.draws.length);
}
