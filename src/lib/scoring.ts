// Scoring (tai/番) calculator for a complete Taiwanese 16-tile hand.
//
// Builds on mahjong.ts's flat Tile[] hand model, extended with two things
// scoring needs that the plain waits calculator never had to track:
//
// 1. Which melds were called (exposed) vs held concealed, and which kongs
//    were declared - not recoverable from the tiles alone, so the notation
//    gains new syntax for it (see parseScoringHand).
// 2. Every valid meld+pair decomposition of a hand, not just one - which
//    decomposition you pick can change the tai total (e.g. a run read as a
//    triplet-heavy vs run-heavy hand), so the correct score is the max tai
//    achievable over all valid readings (see decomposeHandAll).
//
// Deliberately not a generic/configurable rule engine: PATTERNS is a plain
// array of concrete checks against one house rule set, added one at a time.

import {
  decomposeEightPairs,
  decomposeSixteenUnrelated,
  decomposeThirteenOrphans,
  getWaits,
  isEightPairsComplete,
  isSixteenUnrelatedComplete,
  isThirteenOrphansComplete,
  MELDS_REQUIRED,
  ParseError,
  tileKey,
  tileLabel,
  type Suit,
  type Tile,
} from "./mahjong";

export type MeldKind = "triplet" | "run" | "kong";

export interface MeldDeclaration {
  tiles: Tile[];
  kind: MeldKind;
  concealed: boolean;
}

// Flowers/seasons: bonus tiles revealed and set aside (in the same 門前 area
// as declared melds) the moment they're drawn, then replaced by a draw from
// the dead wall. They don't belong to mahjong.ts's Tile model at all (no
// suit/rank shape, never part of a hand's melds+pair structure) and a
// standard set has exactly one physical copy of each of the 8 kinds, unlike
// ordinary tiles' 4-copy cap.
export type BonusKind = "flower" | "season";
export interface BonusTile {
  kind: BonusKind;
  rank: 1 | 2 | 3 | 4;
}

export interface ParsedScoringHand {
  // Melds fixed by the notation: exposed triplets/runs/kongs, written in
  // parens (see parseScoringHand). Concealed kongs are NOT captured here -
  // a bare 4-of-a-kind among the free tiles isn't necessarily a kong (it
  // might instead be a triplet plus one tile borrowed into an adjacent run,
  // e.g. "222234t" as 222t + 234t) - so that ambiguity is left to
  // decomposeHandAll's search, which tries both readings.
  declaredMelds: MeldDeclaration[];
  // Everything else: ordinary concealed tiles still to be decomposed into
  // melds + the pair (the pair is always concealed - it can't be called).
  // May include a rank held all 4 copies, which decomposeHandAll will try
  // reading as a concealed kong.
  freeTiles: Tile[];
  // Bonus tiles drawn during play - don't count toward hand completeness or
  // participate in decomposition, just carried through to scoring (no
  // pattern references them yet). The notation grammar doesn't have syntax
  // for these yet (see parseScoringHand) - always empty from text input.
  bonusTiles: BonusTile[];
}

function validateRank(suit: Suit, rank: number, raw: string): void {
  const max = suit === "z" ? 7 : 9;
  if (rank < 1 || rank > max) {
    throw new ParseError(`Invalid tile "${raw}" (must be 1-${max})`);
  }
}

// Classifies a parenthesized (declared, exposed) group's digits into a
// concrete meld kind: 3 identical digits is a called triplet (pon), 3
// consecutive digits in a numbered suit is a called run (chi), 4 identical
// digits is an exposed kong (either called from a discard or added to an
// existing pon - the notation doesn't distinguish those two yet).
function classifyDeclaredMeld(ranks: number[], suit: Suit, raw: string): MeldKind {
  const allSame = ranks.every((r) => r === ranks[0]);
  if (ranks.length === 4) {
    if (!allSame) throw new ParseError(`Invalid kong "(${raw})" (all 4 tiles must match)`);
    return "kong";
  }
  if (allSame) return "triplet";
  if (suit !== "z" && ranks[1] === ranks[0] + 1 && ranks[2] === ranks[1] + 1) return "run";
  throw new ParseError(`Invalid meld "(${raw})" (must be a triplet, or a run of 3 consecutive tiles)`);
}

export interface DeclaredGrouping {
  melds: MeldDeclaration[];
  // Tiles at the point grouping had to give up - whatever's left starting
  // from the first tile that didn't fit a kong/triplet/run shape, returned
  // untouched rather than guessed at.
  leftover: Tile[];
}

// A run cluster's 3 tiles aren't necessarily detected left-to-right in rank
// order (e.g. "576t" laid out for a called 6t) - only that the 3 tiles
// belonging to one meld are adjacent in the input, not their order within
// that group. Returns the 3 tiles sorted into ascending rank order if they
// form a same-suit run, null otherwise.
function matchRun(a: Tile, b: Tile, c: Tile): Tile[] | null {
  if (a.suit === "z" || a.suit !== b.suit || a.suit !== c.suit) return null;
  const ranks = [a.rank, b.rank, c.rank].sort((x, y) => x - y);
  if (ranks[1] !== ranks[0] + 1 || ranks[2] !== ranks[1] + 1) return null;
  return ranks.map((rank) => ({ suit: a.suit, rank }));
}

// Groups tiles detected in the declared-melds region of a hand-scan photo
// into melds, assuming they're already in left-to-right table order (the
// physical tiles of one meld are laid touching each other, so a
// spatially-sorted detection list has each meld's tiles consecutive, even
// though the tiles WITHIN one meld's cluster aren't necessarily in rank
// order - see matchRun). This is the primary, order-sensitive pass -
// groupDeclaredTiles below falls back to an order-independent search when
// this leaves leftover tiles, since the assumption above doesn't always
// hold (e.g. melds stacked top-to-bottom in the photo instead of left to
// right). Greedily consumes from the front: 4 identical tiles is a kong
// (defaulted to exposed - a genuinely concealed kong has 2 tiles face
// down, which the vision model can't read as their real class anyway, so
// callers should let the user flip that after the fact), 3 identical is a
// triplet, 3 same-suit tiles forming a run (any order) is a run. The
// first tile that doesn't start one of those three shapes, and everything
// after it, is returned as `leftover` instead of being guessed at.
function groupDeclaredTilesPositional(tiles: Tile[]): DeclaredGrouping {
  const melds: MeldDeclaration[] = [];
  let i = 0;
  while (i < tiles.length) {
    const a = tiles[i];
    if (i + 3 < tiles.length && [1, 2, 3].every((d) => tileKey(tiles[i + d]) === tileKey(a))) {
      melds.push({ kind: "kong", concealed: false, tiles: [a, a, a, a] });
      i += 4;
      continue;
    }
    if (i + 2 < tiles.length && [1, 2].every((d) => tileKey(tiles[i + d]) === tileKey(a))) {
      melds.push({ kind: "triplet", concealed: false, tiles: [a, a, a] });
      i += 3;
      continue;
    }
    const run = i + 2 < tiles.length ? matchRun(a, tiles[i + 1], tiles[i + 2]) : null;
    if (run) {
      melds.push({ kind: "run", concealed: false, tiles: run });
      i += 3;
      continue;
    }
    return { melds, leftover: tiles.slice(i) };
  }
  return { melds, leftover: [] };
}

// Groups tiles detected in the declared-melds region of a hand-scan photo
// into melds - see HandScanner/CropOverlay's "Declared" region in App.tsx,
// the only caller. Tries the order-sensitive positional read first (see
// groupDeclaredTilesPositional); if that leaves leftover tiles, falls back
// to allDeclaredDecompositions, a full backtracking search over the whole
// detected multiset that ignores position entirely - e.g. "1m 6m 7m 8m 4m
// 4m 4m 1m 1m 9m 9m 9m" (in detected order) fails the positional read
// immediately (1m/6m/7m starts neither a kong, triplet, nor run) even
// though the multiset cleanly resolves into 111m/444m/678m/999m once order
// is ignored. Only actually falls back (rather than reporting the
// positional leftover) when a full order-independent decomposition
// exists; a multiset that's genuinely ambiguous between several valid
// full decompositions just picks the first one found, same as
// decomposeHandAll already does for the concealed portion of a hand.
export function groupDeclaredTiles(tiles: Tile[]): DeclaredGrouping {
  const positional = groupDeclaredTilesPositional(tiles);
  if (positional.leftover.length === 0) return positional;
  const full = allDeclaredDecompositions(tiles);
  return full.length > 0 ? { melds: full[0], leftover: [] } : positional;
}

// Parses the scoring notation: mahjong.ts's plain digits+suit groups for
// concealed tiles, plus `(digits+suit)` for a declared exposed meld (triplet,
// run, or kong) - see the module doc comment for the full syntax. A bare
// 4-of-a-kind among the concealed digits is deliberately NOT treated as an
// automatic concealed kong here - see ParsedScoringHand's doc comment for
// why. Jokers aren't supported yet (rejected with a clear error rather than
// silently scored wrong).
export function parseScoringHand(input: string): ParsedScoringHand {
  const trimmed = input.trim();
  const groupPattern = /\((\d+)([mtbz])\)|(\d+)([mtbz])|(j+)/g;
  const declaredMelds: MeldDeclaration[] = [];
  const freeTiles: Tile[] = [];
  let matched = "";
  let match: RegExpExecArray | null;

  while ((match = groupPattern.exec(trimmed)) !== null) {
    matched += match[0];
    const [, declDigits, declSuit, freeDigits, freeSuit, jokers] = match;

    if (jokers !== undefined) {
      throw new ParseError("Jokers aren't supported in the scoring calculator yet");
    }

    if (declDigits !== undefined) {
      const suit = declSuit as Suit;
      for (const d of declDigits) validateRank(suit, Number(d), `${d}${suit}`);
      const ranks = Array.from(declDigits, Number).sort((a, b) => a - b);
      const kind = classifyDeclaredMeld(ranks, suit, `${declDigits}${suit}`);
      declaredMelds.push({ tiles: ranks.map((rank) => ({ suit, rank })), kind, concealed: false });
      continue;
    }

    const suit = freeSuit as Suit;
    for (const d of freeDigits) {
      const rank = Number(d);
      validateRank(suit, rank, `${d}${suit}`);
      freeTiles.push({ suit, rank });
    }
  }

  if (matched.replace(/\s/g, "") !== trimmed.replace(/\s/g, "")) {
    throw new ParseError(`Could not parse: "${trimmed}"`);
  }

  // 4-copies-per-kind cap, counted across declared melds and free tiles
  // together. A rank with exactly 4 free copies isn't extracted as a kong
  // here (see ParsedScoringHand's doc comment) - it's still just 4 tiles
  // for this cap check.
  const totalCounts = new Map<string, number>();
  for (const meld of declaredMelds) for (const t of meld.tiles) totalCounts.set(tileKey(t), (totalCounts.get(tileKey(t)) ?? 0) + 1);
  for (const t of freeTiles) totalCounts.set(tileKey(t), (totalCounts.get(tileKey(t)) ?? 0) + 1);
  for (const [key, count] of totalCounts) {
    if (count > 4) {
      const suit = key[0] as Suit;
      const rank = Number(key.slice(1));
      throw new ParseError(`Too many copies of ${tileLabel({ suit, rank })} (max 4)`);
    }
  }

  return { declaredMelds, freeTiles, bonusTiles: [] };
}

export interface ResolvedMeld {
  tiles: Tile[];
  kind: MeldKind;
  concealed: boolean;
}

export interface ResolvedHand {
  // Exactly MELDS_REQUIRED (5) for an ordinary hand - the one documented
  // exception is 十三么 (see scoreThirteenOrphans), which doesn't fit the
  // melds+pair shape at all and represents each of its 12 unpaired orphan
  // tiles as its own 1-tile "meld" purely so the UI has something to
  // render; PATTERNS is never evaluated against a hand shaped that way.
  melds: ResolvedMeld[];
  pair: Tile[];
  bonusTiles: BonusTile[];
}

function countsForSuit(tiles: Tile[], suit: Suit, size: number): number[] {
  const counts = new Array(size + 1).fill(0);
  for (const t of tiles) if (t.suit === suit) counts[t.rank]++;
  return counts;
}

// A hard ceiling on recursive search steps, mirroring
// JOKER_SEARCH_STEP_LIMIT in mahjong.ts - a defensive guard against a
// pathological hand shape, not expected to trigger on realistic hands.
const DECOMPOSE_STEP_LIMIT = 50_000;
// Caps how many alternate decompositions get collected - scoring only needs
// the max-tai one, so once there are "enough" candidates to be confident the
// max has been seen, further exploration is waste. Real hands have very few
// alternate readings in practice (see the README's note on genuinely
// ambiguous hands), so this is a defensive ceiling, not a normal limit.
const MAX_DECOMPOSITIONS = 500;

// All ways to decompose one suit's rank counts fully (zero tiles left over)
// into triplets, concealed kongs, and, for numbered suits, runs. Unlike
// mahjong.ts's canDecompose/decomposeSuitGroups (which stop at the first
// success), this collects every successful branch - the same hand shape can
// legitimately be read multiple ways (e.g. 111222333m as three triplets or
// three runs, or 222234m as a triplet+run vs... nothing else valid, but a
// rank held all 4 copies genuinely can go either way: a kong outright, or a
// triplet with the 4th copy spent on an adjacent run - see
// ParsedScoringHand's doc comment), and scoring needs to consider all of
// them. A meld found this way is always concealed (an exposed/called kong
// only ever comes from the notation's declared-meld syntax instead).
function allSuitDecompositions(
  counts: number[],
  allowRuns: boolean,
  suit: Suit,
  steps: { count: number }
): ResolvedMeld[][] {
  const size = counts.length - 1;

  function search(): ResolvedMeld[][] {
    steps.count++;
    if (steps.count > DECOMPOSE_STEP_LIMIT) return [];
    let i = 1;
    while (i <= size && counts[i] === 0) i++;
    if (i > size) return [[]];

    const results: ResolvedMeld[][] = [];

    if (counts[i] >= 3) {
      counts[i] -= 3;
      const meld: ResolvedMeld = {
        tiles: [{ suit, rank: i }, { suit, rank: i }, { suit, rank: i }],
        kind: "triplet",
        concealed: true,
      };
      for (const rest of search()) results.push([meld, ...rest]);
      counts[i] += 3;
    }

    // Tried alongside (not instead of) the triplet reading above, so a rank
    // whose 4th copy could go either way - a kong outright, or spent on an
    // adjacent run instead - gets both valid readings considered.
    if (counts[i] >= 4) {
      counts[i] -= 4;
      const meld: ResolvedMeld = {
        tiles: [{ suit, rank: i }, { suit, rank: i }, { suit, rank: i }, { suit, rank: i }],
        kind: "kong",
        concealed: true,
      };
      for (const rest of search()) results.push([meld, ...rest]);
      counts[i] += 4;
    }

    if (allowRuns && i <= size - 2 && counts[i + 1] > 0 && counts[i + 2] > 0) {
      counts[i]--;
      counts[i + 1]--;
      counts[i + 2]--;
      const meld: ResolvedMeld = {
        tiles: [{ suit, rank: i }, { suit, rank: i + 1 }, { suit, rank: i + 2 }],
        kind: "run",
        concealed: true,
      };
      for (const rest of search()) results.push([meld, ...rest]);
      counts[i]++;
      counts[i + 1]++;
      counts[i + 2]++;
    }

    return results;
  }

  return search();
}

const SUITS: { suit: Suit; allowRuns: boolean }[] = [
  { suit: "m", allowRuns: true },
  { suit: "t", allowRuns: true },
  { suit: "b", allowRuns: true },
  { suit: "z", allowRuns: false },
];

// Every full decomposition of `tiles` into declared melds (kong/triplet/
// run), ignoring the order they were detected in - groupDeclaredTiles's
// fallback for when the positional read doesn't work out. Reuses
// allSuitDecompositions's backtracking search (built for the free/
// concealed portion of a hand, but the same shape-exploring logic applies
// here too - see that function's doc comment for why greedily picking kong
// over triplet+run, or vice versa, isn't enough) per suit, then combines
// suits via cartesian product; every candidate meld gets `concealed: false`
// since anything detected in the declared region is by definition exposed
// (or, for a kong, at least treated as exposed - see
// groupDeclaredTilesPositional's doc comment). Empty if even one suit's
// tiles can't be fully consumed into melds.
function allDeclaredDecompositions(tiles: Tile[]): MeldDeclaration[][] {
  const steps = { count: 0 };
  let combos: MeldDeclaration[][] = [[]];
  for (const { suit, allowRuns } of SUITS) {
    if (combos.length === 0) break;
    const counts = countsForSuit(tiles, suit, suit === "z" ? 7 : 9);
    const suitDecomps = allSuitDecompositions(counts, allowRuns, suit, steps).map((melds) =>
      melds.map((m) => ({ ...m, concealed: false }))
    );
    const next: MeldDeclaration[][] = [];
    for (const c of combos) {
      for (const d of suitDecomps) {
        next.push([...c, ...d]);
        if (next.length > MAX_DECOMPOSITIONS) break;
      }
      if (next.length > MAX_DECOMPOSITIONS) break;
    }
    combos = next;
  }
  return combos;
}

// Every valid (pair, melds) decomposition of the *free* concealed tiles
// (i.e. excluding whatever's already fixed by declaredMelds) into
// `meldsNeeded` melds plus one pair. Callers combine each result with the
// declared melds to get a full ResolvedHand - see scoreHand.
export function decomposeHandAll(freeTiles: Tile[], meldsNeeded: number): { pair: Tile[]; melds: ResolvedMeld[] }[] {
  const countsBySuit = new Map(SUITS.map(({ suit }) => [suit, countsForSuit(freeTiles, suit, suit === "z" ? 7 : 9)]));
  const steps = { count: 0 };
  const results: { pair: Tile[]; melds: ResolvedMeld[] }[] = [];

  outer: for (const { suit: pairSuit } of SUITS) {
    const pairCounts = countsBySuit.get(pairSuit)!;
    for (let rank = 1; rank < pairCounts.length; rank++) {
      if (pairCounts[rank] < 2) continue;
      pairCounts[rank] -= 2;

      let combos: ResolvedMeld[][] = [[]];
      for (const { suit, allowRuns } of SUITS) {
        if (combos.length === 0) break;
        const suitDecomps = allSuitDecompositions(countsBySuit.get(suit)!, allowRuns, suit, steps);
        const next: ResolvedMeld[][] = [];
        for (const c of combos) {
          for (const d of suitDecomps) {
            next.push([...c, ...d]);
            if (next.length > MAX_DECOMPOSITIONS) break;
          }
          if (next.length > MAX_DECOMPOSITIONS) break;
        }
        combos = next;
      }

      pairCounts[rank] += 2;

      for (const melds of combos) {
        if (melds.length === meldsNeeded) {
          results.push({ pair: [{ suit: pairSuit, rank }, { suit: pairSuit, rank }], melds });
        }
      }
      if (results.length > MAX_DECOMPOSITIONS) break outer;
    }
  }

  return results.slice(0, MAX_DECOMPOSITIONS);
}

export type Wind = 1 | 2 | 3 | 4; // East/South/West/North, same order as mahjong.ts's z honors.

// 叮 (Riichi)'s declared state - a 4-way cycle in the UI (none -> 叮 ->
// 天叮 -> 地叮 -> none...), mutually exclusive by construction since it's
// a single value, not independent flags.
export type RiichiState = "none" | "riichi" | "heavenly-riichi" | "earthly-riichi";

// 四子內/七子內/十子內's declared state - another 4-way cycle in the UI
// (none -> 四子內 -> 七子內 -> 十子內 -> none...), same shape as
// RiichiState. Means the hand was won while the total discard count
// (excluding the tile that completed the hand) was still at or under the
// stated number - the app has no concept of discards/turn count at all,
// so like `riichi` this is purely what the user declares.
export type EarlyWinState = "none" | "four" | "seven" | "ten";

// 雙響/三響's declared state - a 3-way cycle in the UI (none -> 雙響 ->
// 三響 -> none...), same shape as RiichiState/EarlyWinState but with only
// 2 named steps instead of 3.
export type MultiWinState = "none" | "double" | "triple";

// 天胡/地胡/人胡's declared state - a 4-way cycle in the UI (none -> 天胡
// -> 地胡 -> 人胡 -> none...), same shape as RiichiState/EarlyWinState.
export type HeavenlyWinState = "none" | "heaven" | "earth" | "man";

// 河底撈魚/海底撈月's declared state - a 3-way cycle in the UI (none ->
// 河底撈魚 -> 海底撈月 -> none...), same shape as RiichiState/
// EarlyWinState/HeavenlyWinState. 海底撈月(一筒) is NOT a 4th state here -
// it's an automatic upgrade of "sea-bottom" (see the "sea-bottom-win-one-
// tong" PATTERNS entry), the same way 門清自摸/門清叮 auto-upgrade 自摸/叮
// rather than being their own declared states.
export type LastTileWinState = "none" | "river-bottom" | "sea-bottom";

// 槓摸/搶槓's declared tai lookup: index by the cycled count (0-5) to get
// that count's tai - 5, 25, 125, 250, 250 for counts 1-5 (0 always means
// "not declared", i.e. 0 tai). Deliberately a literal table rather than a
// formula (the user's own description, "min(5^n, 240)", doesn't actually
// match these numbers - 5^4 and 5^5 both cap at 250, not 240 - so the
// explicit list is treated as the ground truth over the mismatched
// formula description).
export const FIVE_POWER_TAI_TABLE: readonly number[] = [0, 5, 25, 125, 250, 250];

export interface GameContext {
  seatWind: Wind;
  roundWind: Wind;
  selfDraw: boolean;
  // The 食胡 tile - whichever tile kind completed the hand. Only its
  // suit/rank matter (not which physical copy), since every copy of a kind
  // is interchangeable for scoring purposes. null means unspecified - see
  // isMeldOpen for how that's treated.
  winningTile: Tile | null;
  // 叮/天叮/地叮 (Riichi and its two upgrades) - a house-rule declaration,
  // entirely independent of the hand's own shape (unlike every other
  // GameContext field, nothing about the tiles themselves can derive
  // this - it's just what the user cycles through in the UI). See the
  // "riichi"/"heavenly-riichi"/"earthly-riichi" PATTERNS entries.
  riichi: RiichiState;
  // 一發/食叮 - independent toggles, each only meaningful once `riichi` is
  // declared (not "none"); the UI only shows them then, and resets both
  // back to false whenever riichi cycles back to "none" (see
  // ScoringPanel). See the "riichi-instant-win"/"riichi-eat" PATTERNS
  // entries.
  instantWin: boolean;
  eatRiichi: boolean;
  // 四子內/七子內/十子內 - independent of riichi, another purely-declared
  // cycle. See the "early-win-four"/"early-win-seven"/"early-win-ten"
  // PATTERNS entries.
  earlyWin: EarlyWinState;
  // 雙響/三響 - independent of everything else here, another purely-
  // declared cycle. See the "multi-win-double"/"multi-win-triple"
  // PATTERNS entries.
  multiWin: MultiWinState;
  // 天胡/地胡/人胡 - independent of everything else here, another
  // purely-declared cycle. See the "heavenly-win"/"earthly-win"/
  // "human-win" PATTERNS entries.
  heavenlyWin: HeavenlyWinState;
  // 河底撈魚/海底撈月/海底撈月(一筒) - independent of everything else here,
  // another purely-declared cycle. See the "river-bottom-win"/
  // "sea-bottom-win"/"sea-bottom-win-one-tong" PATTERNS entries.
  lastTileWin: LastTileWinState;
  // 花摸 - how many times the user declares a bonus-tile replacement draw
  // completed/advanced the hand, 0-8 (a standard set has 8 bonus tiles
  // total). Purely declared - the app has no concept of draw order, so
  // unlike a real 花摸 ruling (which genuinely depends on exactly when
  // each bonus tile was revealed relative to the winning tile) this is
  // just "how many times did it happen, trust the user." Tai is 2 per
  // count (see the "flower-draw" PATTERNS entry).
  flowerDraw: number;
  // 槓摸 - how many times the user declares a kong-replacement draw
  // completed/advanced the hand, 0-5. Same "purely declared, trust the
  // user" reasoning as flowerDraw - tai comes from FIVE_POWER_TAI_TABLE
  // (see the "kong-draw" PATTERNS entry).
  kongDraw: number;
  // 搶槓 (robbing the kong) - same shape as kongDraw (0-5, same
  // FIVE_POWER_TAI_TABLE), fully independent of it. See the "rob-kong"
  // PATTERNS entry.
  robKong: number;
  // 明絕/絕絕's manual override - see isVisiblyTripledWinningTile/
  // isVisiblyExhaustedMultiWait's own PATTERNS entries. Only meaningful
  // (and only shown as an interactive toggle in the UI) when the
  // auto-detected check is false - when auto-detection already proves the
  // pattern true, the UI locks the toggle on rather than letting the user
  // turn it off, since the hand's own declared melds already settle it.
  // When auto-detection can't tell (its whole reason for existing - no
  // visibility into the discard pile or other players' melds), this lets
  // the user assert it anyway; the pattern's score is (auto-detected OR
  // this flag), so there's no double-counting either way.
  manualVisibleTripleWin: boolean;
  manualVisibleExhaustedMultiWait: boolean;
}

// The dealer is whoever's own seat wind is East for the current hand - not
// tracked as a separate field since it'd otherwise just be a second way to
// say the same thing.
export function isDealer(ctx: GameContext): boolean {
  return ctx.seatWind === 1;
}

export interface TaiPattern {
  id: string;
  name: string;
  // Tai this pattern contributes for the given hand - 0 means it doesn't
  // apply. Most patterns are a flat yes/no value (1 or 0); a few (正花, 三元
  // 牌) stack per matching instance, hence a function rather than a fixed
  // number.
  score: (hand: ResolvedHand, ctx: GameContext) => number;
  // Ids of other patterns suppressed when this one scores > 0 on the same
  // hand - e.g. holding all three dragon triplets (大三元) already prices in
  // holding any two of them (小三元) or even just one (三元牌), so those
  // shouldn't also count once the bigger pattern applies.
  excludes?: string[];
  // Optional disclaimer surfaced in the UI (as a tooltip on the pattern's
  // row - see ScoringBreakdown) alongside its name, for a pattern whose
  // check is a narrower proxy for what it's actually named after and
  // could otherwise read as a stronger claim than it really is - e.g. 明絕
  // only ever looks at this one hand's own declared melds, not the
  // discard pile or any other player's melds.
  caveat?: string;
}

function allHandTiles(hand: ResolvedHand): Tile[] {
  return [...hand.melds.flatMap((m) => m.tiles), ...hand.pair];
}

const isHonorTile = (t: Tile): boolean => t.suit === "z";

// Ranks (1-4) of every wind meld (triplet/kong of East/South/West/North) in
// the hand - a kong counts the same as a triplet here, only the tile kind
// matters.
function windMeldRanks(hand: ResolvedHand): number[] {
  return hand.melds.filter((m) => m.tiles[0].suit === "z" && m.tiles[0].rank <= 4).map((m) => m.tiles[0].rank);
}

// Ranks (5-7) of every dragon meld (triplet/kong of Red/Green/White) in the hand.
function dragonMeldRanks(hand: ResolvedHand): number[] {
  return hand.melds.filter((m) => m.tiles[0].suit === "z" && m.tiles[0].rank >= 5).map((m) => m.tiles[0].rank);
}

// Shared by 小三風/小四喜: is the pair itself a wind tile that's none of the
// wind kinds already used up by `meldRanks` (the only wind kind left, given
// there are only 4 total)?
function pairIsSpareWind(hand: ResolvedHand, meldRanks: Set<number>): boolean {
  const pair = hand.pair[0];
  return isHonorTile(pair) && pair.rank <= 4 && !meldRanks.has(pair.rank);
}

// Shared by 小三元: is the pair a dragon tile that's none of the dragon
// kinds already used up by `meldRanks` (the only dragon kind left, given
// there are only 3 total)?
function pairIsSpareDragon(hand: ResolvedHand, meldRanks: Set<number>): boolean {
  const pair = hand.pair[0];
  return isHonorTile(pair) && pair.rank >= 5 && !meldRanks.has(pair.rank);
}

const SINGLE_WIND_PATTERN_IDS = ["wrong-seat-wind", "correct-seat-wind", "correct-round-wind"];

const isAllRuns = (hand: ResolvedHand): boolean => hand.melds.every((m) => m.kind === "run");

// Shared by 全求人/半求人: every meld is declared/exposed - no concealed
// meld of any kind, kongs included. ("No concealed kong" in the user's
// phrasing is redundant with this in the current data model, since a kong
// is only ever concealed or exposed, never a third state.)
const isFullyDeclared = (hand: ResolvedHand): boolean => hand.melds.every((m) => !m.concealed);

// Shared by 門前清/門清自摸: no declared run or triplet - an exposed kong
// (明槓/加槓) doesn't break this.
const isConcealedExceptKongs = (hand: ResolvedHand): boolean =>
  hand.melds.every((m) => m.concealed || m.kind === "kong");

const isNoHonorsNoFlowers = (hand: ResolvedHand): boolean =>
  allHandTiles(hand).every((t) => !isHonorTile(t)) && hand.bonusTiles.length === 0;

// Distinct numbered suits (m/t/b) touched anywhere in the hand - honors
// don't count as a "suit" for this purpose.
function numberedSuitsUsed(hand: ResolvedHand): Set<Suit> {
  const suits = new Set<Suit>();
  for (const t of allHandTiles(hand)) {
    if (t.suit === "m" || t.suit === "t" || t.suit === "b") suits.add(t.suit);
  }
  return suits;
}

const hasNoFives = (hand: ResolvedHand): boolean => allHandTiles(hand).every((t) => t.suit !== "z" && t.rank !== 5);

const allTilesInRange = (hand: ResolvedHand, min: number, max: number): boolean =>
  allHandTiles(hand).every((t) => t.suit !== "z" && t.rank >= min && t.rank <= max);

// 三寶: a compound bonus requiring all 3 at once: (1) one of 缺五/小於五/
// 大於五 (a restricted numeric range), (2) 斷么 (no honors, no terminals),
// and (3) one of 清一色/缺一門 (suit purity or missing-one-suit). Checked
// directly against each pattern's raw condition rather than the (possibly
// excluded) PATTERNS results - same reasoning as 全姊妹, since e.g. 清一色
// scoring 0 because it's excluded by nothing here doesn't mean the shape
// itself isn't present.
function hasThreeTreasures(hand: ResolvedHand): boolean {
  const hasRangeRestriction = hasNoFives(hand) || allTilesInRange(hand, 1, 4) || allTilesInRange(hand, 6, 9);
  const isAllSimples = allHandTiles(hand).every((t) => t.suit !== "z" && t.rank >= 2 && t.rank <= 8);
  const isFullFlush = numberedSuitsUsed(hand).size === 1 && allHandTiles(hand).every((t) => !isHonorTile(t));
  const isMissingOneSuit = numberedSuitsUsed(hand).size === 2 && allHandTiles(hand).every((t) => !isHonorTile(t));
  return hasRangeRestriction && isAllSimples && (isFullFlush || isMissingOneSuit);
}

// The 5 "suits" for 五門齊/七門齊: the 3 numbered suits, plus winds and
// dragons treated as two further suits of their own (not lumped together
// as one "honors" suit).
type FiveSuitCategory = "m" | "t" | "b" | "wind" | "dragon";
function fiveSuitCategory(t: Tile): FiveSuitCategory {
  if (t.suit === "m" || t.suit === "t" || t.suit === "b") return t.suit;
  return t.rank <= 4 ? "wind" : "dragon";
}
// Every category touched anywhere in the hand (melds, pair - just needs a
// single tile of that category to count).
function categoriesPresent(hand: ResolvedHand): Set<FiveSuitCategory> {
  return new Set(allHandTiles(hand).map(fiveSuitCategory));
}
// Every category with its own complete, dedicated meld - a strictly
// stronger condition than merely being present (see 大/小五門齊).
function categoriesWithFullMeld(hand: ResolvedHand): Set<FiveSuitCategory> {
  return new Set(hand.melds.map((m) => fiveSuitCategory(m.tiles[0])));
}

const hasBonusKind = (hand: ResolvedHand, kind: BonusKind): boolean => hand.bonusTiles.some((b) => b.kind === kind);

const meldHasTileKind = (meld: ResolvedMeld, tile: Tile): boolean =>
  meld.tiles.some((t) => t.suit === tile.suit && t.rank === tile.rank);

// 對碰 (shanpon/dual-pair wait): the 食胡 tile completed a plain triplet -
// e.g. tenpai on 44m+44t, waiting for either pair to become a triplet.
// This is really just "did the winning tile land in a triplet meld" - a
// triplet's other 2 tiles are necessarily a pair before that tile arrives,
// and the hand's actual pair is always a separate group by construction,
// so no extra "was there really a second pair" check is needed. Doesn't
// apply to kongs (that's not a pair-to-triplet completion) or to a
// self-drawn/claimed tile that instead completes a run.
function isShanponWait(hand: ResolvedHand, ctx: GameContext): boolean {
  if (ctx.winningTile === null) return false;
  // Only a CONCEALED triplet can be what the 食胡 tile completed - a
  // declared triplet is already a complete, exposed group from the start,
  // never "waiting" on a tile (see preWinWaitInput's own version of this
  // rule). A declared triplet is always concealed:false (see pushMeld in
  // ScoringPanel), so this check alone is enough to exclude it - no
  // separate declared-meld count needed.
  return hand.melds.some((m) => m.kind === "triplet" && m.concealed && meldHasTileKind(m, ctx.winningTile!));
}

// Shared by 獨獨/假獨: the pre-completion tiles - everything except kong
// melds (already fixed and structurally irrelevant to the wait) AND
// declared melds (also already fixed - a declared meld is entered as a
// complete, exposed group from the start, never "waiting" on a tile, so
// it can't be what the 食胡 tile actually completed; see isShanponWait's
// version of the same rule) - minus one copy of the 食胡 tile, plus how
// many melds' worth of flexible tiles that represents. A non-kong meld is
// concealed:true if and only if it came from the free/concealed
// decomposition rather than the notation's declared-meld syntax (see
// pushMeld in ScoringPanel / MeldDeclaration's construction), so
// `m.concealed` alone reliably tells the two apart here. Returns null if
// the winning tile can't be found among the concealed non-kong tiles
// (shouldn't happen for a hand actually built around it, but guards
// against a stale/mismatched marker).
//
// Known gap: getWaits only sees these tiles, so it can't tell that some
// copies of a kong's rank are already locked away - a hand with both a
// kong and an independent wait on that same rank could over-count how many
// copies are still available. Rare in practice (needs a kong and a wait on
// the exact same rank at once), not worth the extra plumbing yet.
function preWinWaitInput(hand: ResolvedHand, winningTile: Tile): { tiles: Tile[]; meldsRequired: number } | null {
  const kongCount = hand.melds.filter((m) => m.kind === "kong").length;
  const declaredNonKongCount = hand.melds.filter((m) => m.kind !== "kong" && !m.concealed).length;
  const concealedTiles = hand.melds
    .filter((m) => m.kind !== "kong" && m.concealed)
    .flatMap((m) => m.tiles)
    .concat(hand.pair);
  const idx = concealedTiles.findIndex((t) => t.suit === winningTile.suit && t.rank === winningTile.rank);
  if (idx === -1) return null;
  return {
    tiles: [...concealedTiles.slice(0, idx), ...concealedTiles.slice(idx + 1)],
    meldsRequired: MELDS_REQUIRED - kongCount - declaredNonKongCount,
  };
}

// 獨獨: the pre-completion hand has exactly one tile kind that would
// complete it - reuses the Calculator tab's own getWaits rather than
// reimplementing wait-finding here.
function isGenuineSingleWait(hand: ResolvedHand, ctx: GameContext): boolean {
  if (ctx.winningTile === null) return false;
  const pre = preWinWaitInput(hand, ctx.winningTile);
  return pre !== null && getWaits(pre.tiles, pre.meldsRequired).length === 1;
}

// 嚦咕嚦咕八飛: the wait count for the pre-completion hand, specific to the
// 嚦咕嚦咕 shape itself - NOT the general getWaits (that would also count
// completions via a totally unrelated normal-hand reading, which the user
// confirmed shouldn't factor in here: a 2-wait example hand's pre-
// completion tiles happened to also admit several incidental normal-hand
// waits that don't belong in this count).
//
// Two rules, per the user's own examples:
// 1. If every kind in the pre-completion hand already sits at an EVEN
//    count (2, or 4 - i.e. a "clean" 8-pairs shape with nothing already
//    tripled or dangling as a single), it's unconditionally treated as an
//    8-way wait - even if some of those kinds are already at all 4 copies
//    and so can't literally be drawn again (e.g. 5555t7777t9999m1177z
//    "only" has 1z/7z left to literally draw, but still counts as 8).
// 2. Otherwise, count how many of the 34 tile kinds - skipping any already
//    at 4 copies, since a 5th can't exist - make
//    isEightPairsComplete(preTiles + candidate) true when added. This is
//    deliberately narrower than getWaits: it only recognizes completions
//    via the 嚦咕嚦咕 shape itself, not any other hand type.
function eightPairsCountsByKind(tiles: Tile[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const t of tiles) {
    const key = `${t.suit}${t.rank}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}
function eightPairsWaitCount(preTiles: Tile[]): number {
  const counts = eightPairsCountsByKind(preTiles);
  if ([...counts.values()].every((c) => c === 2 || c === 4)) return 8;

  let waitCount = 0;
  const candidates: Tile[] = [];
  for (const suit of ["m", "t", "b"] as const) {
    for (let rank = 1; rank <= 9; rank++) candidates.push({ suit, rank });
  }
  for (let rank = 1; rank <= 7; rank++) candidates.push({ suit: "z", rank });
  for (const candidate of candidates) {
    const key = `${candidate.suit}${candidate.rank}`;
    if ((counts.get(key) ?? 0) >= 4) continue;
    if (isEightPairsComplete([...preTiles, candidate])) waitCount++;
  }
  return waitCount;
}

// null if the wait count can't be determined (no 食胡 tile recorded).
function preCompletionEightPairsWaitCount(hand: ResolvedHand, ctx: GameContext): number | null {
  if (ctx.winningTile === null) return null;
  const pre = preWinWaitInput(hand, ctx.winningTile);
  return pre === null ? null : eightPairsWaitCount(pre.tiles);
}

// 明/暗四歸 (嚦咕嚦咕 context): every kind held all 4 copies at once (each
// one uses up 2 of the 8 pairs) - structurally different from
// orphansQuadKind's single "triplet meld + matching single" shape, since a
// 嚦咕嚦咕 quad is just one 4-tile group. Unlike 十三么 (at most one quad,
// since only one triplet ever exists there), a 嚦咕嚦咕 hand can hold
// several independent quads at once - e.g. two different ranks each held
// all 4 copies, using 4 of the 8 pairs between them - so every quad found
// stacks, not just the first.
function eightPairsQuadKinds(hand: ResolvedHand): Tile[] {
  return hand.melds.filter((m) => m.tiles.length === 4).map((m) => m.tiles[0]);
}

// Unifies the two special hands' quad-finding for 明/暗四歸: tries the
// 十三么 shape (orphansQuadKind, at most one - only one triplet ever
// exists there) first, falling back to the 嚦咕嚦咕 shape (eightPairsQuadKinds,
// zero, one, or several) only when there's no 十三么-style quad, since the
// two special hands' fake-meld constructions never coexist in one `hand`.
function allFourReturnQuadKinds(hand: ResolvedHand): Tile[] {
  const orphansQuad = orphansQuadKind(hand);
  return orphansQuad ? [orphansQuad] : eightPairsQuadKinds(hand);
}

// 小五門齊/小七門齊 (嚦咕嚦咕 context): the normal small-five-suits/small-
// seven-suits patterns can't be reused as-is here - their own "not also
// big" guard (categoriesWithFullMeld().size < 5) assumes hand.melds holds
// genuine 3+-tile melds, but every group in a 嚦咕嚦咕 hand independently
// covers its own category, so that guard would (wrongly) never trip and
// 大五/七門齊 would fire instead. These check presence only, exactly the
// "no need to have a meld" shape the user asked for.
function eightPairsSmallFiveSuitsTai(hand: ResolvedHand): number {
  return categoriesPresent(hand).size === 5 ? 10 : 0;
}
function eightPairsSmallSevenSuitsTai(hand: ResolvedHand): number {
  return categoriesPresent(hand).size === 5 && hasBonusKind(hand, "flower") && hasBonusKind(hand, "season") ? 15 : 0;
}

// 將眼 (嚦咕嚦咕 context): the normal pattern only ever checks the single
// designated `hand.pair`, but a 嚦咕嚦咕 hand really has 7 "eyes"-like pair
// groups (the triple doesn't count, it's been upgraded) - each one at
// rank 2/5/8 (not honors) fires its own instance, stacking. A quad (4
// copies, counting as 2 of the 8 pairs) contributes 2 instances if it
// qualifies, matching its "2 pairs at once" nature elsewhere.
function eightPairsMiddleTilePairCount(hand: ResolvedHand): number {
  const groups: Tile[][] = [hand.pair, ...hand.melds.filter((m) => m.tiles.length !== 3).map((m) => m.tiles)];
  let count = 0;
  for (const group of groups) {
    const t = group[0];
    if (t.suit === "z" || ![2, 5, 8].includes(t.rank)) continue;
    count += group.length === 4 ? 2 : 1;
  }
  return count;
}

// 三元嚦咕/三風嚦咕/四喜嚦咕: half-tai borrowings of 小三元/小三風/小四喜 for
// the 嚦咕嚦咕 context - just "is the kind present at all" (confirmed by
// the user: 5z/6z/7z all present as plain pairs, no triplet or pair-role
// requirement, already qualifies as 三元嚦咕), since every tile in an
// eight-pairs hand already belongs to some pair/triple/quad group - no
// loose leftover tiles the way a normal hand's 小/大 distinction hinges
// on. Tai values (20, 15, 60) are the user's confirmed half of the normal
// 小三元 (40), 小三風 (30), and 小四喜 (120).
function eightPairsDragonRankCount(hand: ResolvedHand): number {
  return new Set(allHandTiles(hand).filter((t) => t.suit === "z" && t.rank >= 5 && t.rank <= 7).map((t) => t.rank)).size;
}
function eightPairsWindRankCount(hand: ResolvedHand): number {
  return new Set(allHandTiles(hand).filter((t) => t.suit === "z" && t.rank >= 1 && t.rank <= 4).map((t) => t.rank)).size;
}

// 假獨: the 食胡 tile fills the *middle* rank of some run meld it belongs
// to (a kanchan/closed-wait shape) - e.g. 12334m completed by 2m can be
// read as 234m (already complete) + 13m waiting on 2m only, even though
// the hand's true wait was also open to 5m (123m + 34m). Checked directly
// against the meld list rather than needing an alternate decomposition:
// since a duplicated rank can put the same tile kind in more than one meld
// at once (as in the 12334m example, where 2m sits in both 123m and
// 234m), scanning every meld for "does it have this kind as its middle
// rank" already captures the alternate reading without exploring
// decomposeHandAll's other candidates.
// The standard rule covers 3 classic narrow/single-tile wait shapes:
// - 嵌張 (kanchan): the winning tile fills the *middle* rank of a run it
//   belongs to - e.g. holding 1_3 waiting on 2 only.
// - 邊張 (penchan/edge wait): a 1-2-3 run completed specifically by the 3
//   (holding 1-2, which can only ever wait on 3 - there's no 0 to make it
//   two-sided), or a 7-8-9 run completed specifically by the 7 (holding
//   8-9, no 10 to extend the other way). Completing a 1-2-3 run via 1, or
//   a 7-8-9 run via 9, is an ordinary two-sided (兩面) wait instead, not
//   this shape - those ranks can genuinely extend both directions.
// - 單騎 (tanki): the winning tile completes the pair.
// None of these need to check for an alternate/wider reading explicitly -
// genuine-single-wait already excludes this pattern whenever it fires (see
// its own `excludes`), so a hand where one of these shapes was actually
// the *only* possible completion never reaches here already covered by
// 獨獨 instead; this only needs to recognize the shape itself.
//
// Two special-hand-only extensions apply on top (irrelevant to ordinary
// hands, since neither shape can occur there): 十三么's 12 unpaired orphan
// kinds are each represented as their own 1-tile "meld" (see
// scoreThirteenOrphans), and the winning tile's kind can land in BOTH one
// of those 1-tile placeholders AND the genuine 3-tile ordinary meld at
// once - e.g. 19m1t789t19b12345677z waits on 6t/9t (either extends the
// 7t8t run), but 9t specifically also happens to be the pre-existing
// single's own kind, the same "an alternate reading pins the winning tile
// down to one fixed role" idea as kanchan, just produced by this special
// hand's fake single-tile melds instead of a duplicated rank within a run.
// 嚦咕嚦咕's own extension (isEightPairsFakeSingleWait) is wired in
// separately by its caller rather than folded in here.
function isFakeSingleWait(hand: ResolvedHand, ctx: GameContext): boolean {
  if (ctx.winningTile === null) return false;
  const winningTile = ctx.winningTile;
  // Only a CONCEALED run can be what the 食胡 tile completed - same
  // declared-melds-are-already-fixed reasoning as isShanponWait/
  // preWinWaitInput. A declared run is always concealed:false, so this
  // check alone is enough to exclude it.
  const kanchan = hand.melds.some((m) => {
    if (m.kind !== "run" || !m.concealed || !meldHasTileKind(m, winningTile)) return false;
    const ranks = m.tiles.map((t) => t.rank).sort((a, b) => a - b);
    return ranks[1] === winningTile.rank;
  });
  if (kanchan) return true;
  const penchan = hand.melds.some((m) => {
    if (m.kind !== "run" || !m.concealed || !meldHasTileKind(m, winningTile)) return false;
    const ranks = m.tiles.map((t) => t.rank).sort((a, b) => a - b);
    return (ranks[0] === 1 && ranks[2] === 3 && winningTile.rank === 3) || (ranks[0] === 7 && ranks[2] === 9 && winningTile.rank === 7);
  });
  if (penchan) return true;
  const tanki = hand.pair.some((t) => t.suit === winningTile.suit && t.rank === winningTile.rank);
  if (tanki) return true;
  const inSingleMeld = hand.melds.some((m) => m.tiles.length === 1 && meldHasTileKind(m, winningTile));
  const inLargerMeld = hand.melds.some((m) => m.tiles.length > 1 && meldHasTileKind(m, winningTile));
  return inSingleMeld && inLargerMeld;
}

// Copies of `tile`'s kind sitting in this hand's own DECLARED (exposed)
// melds - shared by 明絕 and 絕絕 below. Only exposed melds count: a
// concealed (self-drawn) kong is invisible to the rest of the table (2
// tiles face down), same as every other concealed meld, so it doesn't
// factor in even though it's still 4 physical copies.
function declaredCopiesOfTile(hand: ResolvedHand, tile: Tile): number {
  return hand.melds
    .filter((m) => !m.concealed)
    .reduce((n, m) => n + m.tiles.filter((t) => t.suit === tile.suit && t.rank === tile.rank).length, 0);
}

// 明絕: the 食胡 tile's kind already sits exactly 3 times across this
// hand's own DECLARED (exposed) melds - most often a single declared
// triplet of that kind, but just as easily spread across 3 separate
// declared runs each holding one copy, or any other combination of
// declared melds that happens to sum to exactly 3 (a declared kong of
// that kind would push the total to 4, which falls outside this pattern
// with no extra kind check needed to exclude it). "明" (visible)
// specifically: only exposed melds count - an exposed kong counts, but a
// concealed (self-drawn) kong doesn't, since it isn't visible to anyone
// else at the table, same as every other concealed meld here. Does NOT
// require the concealed wait itself to be single - the concealed hand
// can still be genuinely waiting on other, un-exhausted kinds too; this
// only cares about the one kind that actually completed it.
//
// CAVEAT (also surfaced in the UI via this pattern's `caveat`, see
// PATTERNS below): this only ever looks at THIS hand's own declared
// melds. It has no visibility into the discard pile or any other
// player's declared melds, so it can't actually confirm the 食胡 tile was
// the last live copy anywhere in the game - only that this hand's own
// exposed melds already show 3 of them.
// Exported (unlike every other auto-detect helper in this file) so the UI
// can independently ask "does the auto-check alone already prove this?" to
// decide whether the manual-override button should be locked on - see
// GameContext.manualVisibleTripleWin's own doc comment for why that needs
// to be answerable without also depending on the manual flag's own value.
export function isVisiblyTripledWinningTile(hand: ResolvedHand, ctx: GameContext): boolean {
  if (ctx.winningTile === null) return false;
  return declaredCopiesOfTile(hand, ctx.winningTile) === 3;
}

// 絕絕: an extension of 明絕. The concealed hand's genuine pre-completion
// wait (same getWaits computation 獨獨 uses) has 2+ distinct tile kinds -
// a nominally multi-way wait - but this hand's own DECLARED melds already
// account for every copy of those waiting kinds except a single one
// anywhere: summing `4 - declaredCopiesOfTile` across every waiting kind
// comes out to exactly 1. E.g. waiting on 3m/6m via a 45m two-sided
// shape, with declared 333m+666m+567m already showing 3 of 3m's 4 copies
// and all 4 of 6m's (3 from 666m's triplet plus 1 from 567m's own 6m) -
// 6m is entirely gone, only one 3m is left anywhere. An exposed kong
// works the same way (e.g. declared 333m + an exposed 6666m kong also
// accounts for all 4 of 6m's copies) - but a CONCEALED kong doesn't
// count, same "only what's visible" reasoning as declaredCopiesOfTile
// itself. Excludes 明絕 (see PATTERNS below) since this is the same
// underlying "visibly exhausted" idea, just a stronger, more specific
// finding when it applies.
//
// CAVEAT (surfaced in the UI too, same as 明絕): only checks THIS hand's
// own declared melds - no visibility into the discard pile or any other
// player's declared melds, so it can't confirm these are truly the last
// copies anywhere in the game.
// Exported for the same reason as isVisiblyTripledWinningTile above.
export function isVisiblyExhaustedMultiWait(hand: ResolvedHand, ctx: GameContext): boolean {
  if (ctx.winningTile === null) return false;
  const pre = preWinWaitInput(hand, ctx.winningTile);
  if (pre === null) return false;
  const waits = getWaits(pre.tiles, pre.meldsRequired);
  if (waits.length < 2) return false;
  const totalRemaining = waits.reduce((n, w) => n + (4 - declaredCopiesOfTile(hand, w)), 0);
  return totalRemaining === 1;
}

// 明 (open) vs 暗 (concealed/hidden), per the house rule: a meld is 明 if
// it's declared/exposed, OR if it's the meld the 食胡 tile (winningTile)
// completed and that win wasn't a self-draw - claiming the last tile of an
// otherwise-concealed meld off a discard still makes that meld count as
// open, even though it was never "called" in the usual pon/chi sense. With
// no winningTile recorded, that second condition just never fires (only
// physical declaration disqualifies a meld) - see the ScoringPanel UI's
// 食胡-tile long-press.
//
// Kongs are handled specially by the 暗刻-chain patterns below, NOT here:
// a kong counts toward 兩/三/四/五暗刻 regardless of open/concealed status,
// so those patterns check `kind === "kong"` directly rather than routing
// kongs through this function.
function isMeldOpen(meld: ResolvedMeld, ctx: GameContext): boolean {
  if (!meld.concealed) return true;
  return !ctx.selfDraw && ctx.winningTile !== null && meldHasTileKind(meld, ctx.winningTile);
}

// Count of melds that satisfy the 暗刻-chain's "concealed triplet or kong"
// condition - a kong always counts (regardless of isMeldOpen), a triplet
// only counts if isMeldOpen says it's still 暗.
function hiddenTripletOrKongCount(hand: ResolvedHand, ctx: GameContext): number {
  return hand.melds.filter((m) => m.kind === "kong" || (m.kind === "triplet" && !isMeldOpen(m, ctx))).length;
}

// A "segment" meld is a run occupying exactly one of the three fixed
// 3-tile spans a straight needs (1-2-3, 4-5-6, 7-8-9) in a given suit -
// unlike an ordinary run search, position is fixed, not "any 3 consecutive
// ranks starting anywhere."
function segmentMelds(hand: ResolvedHand, suit: Suit, startRank: number): ResolvedMeld[] {
  return hand.melds.filter((m) => m.kind === "run" && m.tiles[0].suit === suit && m.tiles[0].rank === startRank);
}

// Given the meld lists for three segments that must combine into a
// straight, returns one meld-triple per instance - every combination of one
// meld from each segment, since a segment held only once is reused
// (shared) across as many instances as the other segments' copies call
// for, not consumed by forming one. This is the full Cartesian product,
// not a 1-to-1 pairing: with 2 copies of the low segment, 1 of the mid, and
// 2 of the high (e.g. 123m123m456m789m789m), pairing by index alone would
// only ever find 2 instances (123m#1+456m+789m#1, 123m#2+456m+789m#2), but
// every low copy can pair with every high copy while still sharing the one
// mid copy, so all 4 combinations count - confirmed against exactly that
// example. Simpler shapes (e.g. 123m456m789m789m, only one segment
// duplicated) still reduce to the same 2 instances either way. Empty if any
// segment is missing entirely (no straight at all).
function combineSegments(segA: ResolvedMeld[], segB: ResolvedMeld[], segC: ResolvedMeld[]): ResolvedMeld[][] {
  if (segA.length === 0 || segB.length === 0 || segC.length === 0) return [];
  const result: ResolvedMeld[][] = [];
  for (const a of segA) {
    for (const b of segB) {
      for (const c of segC) {
        result.push([a, b, c]);
      }
    }
  }
  return result;
}

// Every 清龍 (pure straight, single suit) instance in the hand - see
// combineSegments for how duplicate segments turn into multiple instances.
function pureStraightInstances(hand: ResolvedHand): ResolvedMeld[][] {
  const result: ResolvedMeld[][] = [];
  for (const suit of ["m", "t", "b"] as const) {
    result.push(...combineSegments(segmentMelds(hand, suit, 1), segmentMelds(hand, suit, 4), segmentMelds(hand, suit, 7)));
  }
  return result;
}

// All 6 orderings of the 3 numbered suits - used to assign which suit plays
// which segment's role for 雜龍 (mixed straight, one segment per suit).
function suitPermutations(): Suit[][] {
  const suits: Suit[] = ["m", "t", "b"];
  const result: Suit[][] = [];
  for (const a of suits) {
    for (const b of suits) {
      for (const c of suits) {
        if (a !== b && b !== c && a !== c) result.push([a, b, c]);
      }
    }
  }
  return result;
}

// Every 雜龍 (mixed straight, one segment per suit) instance in the hand.
// A given meld can only ever fill the role matching its own rank span, so
// permutations naturally partition without double-counting the same meld
// under two different roles - see combineSegments for the duplicate-segment
// instance counting itself.
function mixedStraightInstances(hand: ResolvedHand): ResolvedMeld[][] {
  const result: ResolvedMeld[][] = [];
  for (const [suitA, suitB, suitC] of suitPermutations()) {
    result.push(...combineSegments(segmentMelds(hand, suitA, 1), segmentMelds(hand, suitB, 4), segmentMelds(hand, suitC, 7)));
  }
  return result;
}

function meldsAtRank(hand: ResolvedHand, kinds: MeldKind[], suit: Suit, rank: number): ResolvedMeld[] {
  return hand.melds.filter((m) => kinds.includes(m.kind) && m.tiles[0].suit === suit && m.tiles[0].rank === rank);
}

// 老少上 instances: a 1-2-3 run and a 7-8-9 run in the same suit, as long as
// that suit doesn't *also* have a 4-5-6 run (that would make it 清龍
// instead). No 明/暗 split, but still stacks the same combineSegments-style
// full-combination way 清龍/雜龍 do - just with 2 segments instead of 3, so
// every low copy pairs with every high copy (e.g. 2 copies of each is 4
// instances, not 2 - same reasoning as combineSegments' own fix).
function oldYoungRunInstances(hand: ResolvedHand): number {
  let total = 0;
  for (const suit of ["m", "t", "b"] as const) {
    if (segmentMelds(hand, suit, 4).length > 0) continue;
    const ones = segmentMelds(hand, suit, 1);
    const nines = segmentMelds(hand, suit, 7);
    total += ones.length * nines.length;
  }
  return total;
}

// 老少碰 instances: a rank-1 triplet/kong and a rank-9 triplet/kong in the
// same suit. No 明/暗 split, stacks the same way.
function oldYoungTripletInstances(hand: ResolvedHand): number {
  let total = 0;
  for (const suit of ["m", "t", "b"] as const) {
    const ones = meldsAtRank(hand, ["triplet", "kong"], suit, 1);
    const nines = meldsAtRank(hand, ["triplet", "kong"], suit, 9);
    if (ones.length === 0 || nines.length === 0) continue;
    total += Math.max(ones.length, nines.length);
  }
  return total;
}

// 混帶X: is there some single rank 1-9 that every *non-honor* meld contains
// a tile of? Honor melds are naturally exempt (they have no numeric rank to
// match), and so is the pair (the pattern is about melds only). Requires at
// least one non-honor meld to check - a hand with none (e.g. 字一色) has
// nothing to unify around and shouldn't vacuously qualify. The pair must
// also match the shared rank, unless the pair is honors - a pair (2 tiles,
// 1 rank) can only ever match a *single* rank, which is exactly what 混帶X
// itself needs, so this works the same way an honor meld's exemption does.
function hasCommonRankAcrossNonHonorMelds(hand: ResolvedHand): boolean {
  const nonHonorMelds = hand.melds.filter((m) => m.tiles[0].suit !== "z");
  if (nonHonorMelds.length === 0) return false;
  const pair = hand.pair[0];
  for (let rank = 1; rank <= 9; rank++) {
    if (nonHonorMelds.every((m) => m.tiles.some((t) => t.rank === rank)) && (isHonorTile(pair) || pair.rank === rank)) return true;
  }
  return false;
}

// 混帶XY: same idea as 混帶X, but every non-honor meld must contain BOTH of
// some pair of distinct ranks (not just one shared rank). Unlike 混帶X, a
// non-honor pair can *never* satisfy this - a pair is 2 identical tiles,
// only ever one rank, so it structurally can't "contain both X and Y" the
// way a meld can, regardless of which rank it happens to hold. Only an
// honor pair is exempt here, the same way an honor meld is; a numerically-
// matching non-honor pair doesn't count (it can match at most one of the
// two required ranks, never both).
function hasCommonRankPairAcrossNonHonorMelds(hand: ResolvedHand): boolean {
  const nonHonorMelds = hand.melds.filter((m) => m.tiles[0].suit !== "z");
  if (nonHonorMelds.length === 0 || !isHonorTile(hand.pair[0])) return false;
  for (let x = 1; x <= 9; x++) {
    for (let y = x + 1; y <= 9; y++) {
      if (nonHonorMelds.every((m) => m.tiles.some((t) => t.rank === x) && m.tiles.some((t) => t.rank === y))) return true;
    }
  }
  return false;
}

// 混帶XYZ: same idea again, but every non-honor meld must contain all 3 of
// some triple of distinct ranks - a run always has exactly 3 distinct
// ranks, so a hand with only a single non-honor meld (the rest all honor
// melds) still trivially qualifies using that meld's own 3 ranks; a lone
// triplet/kong (only 1 distinct rank) never can, on its own or otherwise.
// Same reasoning as 混帶XY for the pair: a non-honor pair can never
// contain 3 distinct ranks, so only an honor pair is exempt.
function hasCommonRankTripleAcrossNonHonorMelds(hand: ResolvedHand): boolean {
  const nonHonorMelds = hand.melds.filter((m) => m.tiles[0].suit !== "z");
  if (nonHonorMelds.length === 0 || !isHonorTile(hand.pair[0])) return false;
  for (let x = 1; x <= 9; x++) {
    for (let y = x + 1; y <= 9; y++) {
      for (let z = y + 1; z <= 9; z++) {
        if (
          nonHonorMelds.every(
            (m) => m.tiles.some((t) => t.rank === x) && m.tiles.some((t) => t.rank === y) && m.tiles.some((t) => t.rank === z)
          )
        ) {
          return true;
        }
      }
    }
  }
  return false;
}

// 全帶X: the ultimate extension of 混帶X/XY/XYZ - no honor meld AND no honor
// pair, and every meld *and* the pair itself all contain the same rank X.
// Checking !isHonorTile on the pair (rather than relying on the rank match
// alone) matters because an honor tile's rank (1-7, wind/dragon identity)
// could otherwise coincidentally equal a numbered X and falsely "match".
function hasCommonRankAcrossAllMeldsAndPair(hand: ResolvedHand): boolean {
  if (hand.melds.some((m) => m.tiles[0].suit === "z") || isHonorTile(hand.pair[0])) return false;
  for (let rank = 1; rank <= 9; rank++) {
    if (hand.melds.every((m) => m.tiles.some((t) => t.rank === rank)) && hand.pair.some((t) => t.rank === rank)) return true;
  }
  return false;
}

// 混帶么: the hand has an honor presence *somewhere* (an honor meld, or the
// pair itself is honors) - this is what distinguishes it from the no-
// honors-at-all 全帶么 below - AND every meld and the pair each contain a
// terminal or honor: every non-honor meld needs a terminal (rank 1 or 9),
// and the pair itself must independently be a terminal or honor too - not
// just exempted by some unrelated honor meld existing elsewhere in the
// hand. Requires at least one non-honor meld to exist - an all-honor hand
// has no terminal number melds to speak of, so it shouldn't vacuously
// qualify (same reasoning as 混帶X's guard).
function hasHonorPresenceAnywhere(hand: ResolvedHand): boolean {
  return hand.melds.some((m) => m.tiles[0].suit === "z") || isHonorTile(hand.pair[0]);
}
function pairIsTerminalOrHonor(hand: ResolvedHand): boolean {
  const pair = hand.pair[0];
  return isHonorTile(pair) || pair.rank === 1 || pair.rank === 9;
}
function everyNonHonorMeldHasTerminal(hand: ResolvedHand): boolean {
  const nonHonorMelds = hand.melds.filter((m) => m.tiles[0].suit !== "z");
  return nonHonorMelds.length > 0 && nonHonorMelds.every((m) => m.tiles.some((t) => t.rank === 1 || t.rank === 9));
}

// 全帶么: the "no honors at all" counterpart to 混帶么 - no honor meld, no
// honor pair, and every meld *and the pair itself* contains a terminal.
// Mutually exclusive with 混帶么 by construction (that one requires honor
// presence), so no explicit exclude needed between them.
function hasNoHonorsAndTerminalInEveryMeldAndPair(hand: ResolvedHand): boolean {
  if (hand.melds.some((m) => m.tiles[0].suit === "z") || isHonorTile(hand.pair[0])) return false;
  const hasTerminal = (tiles: Tile[]) => tiles.some((t) => t.rank === 1 || t.rank === 9);
  return hand.melds.every((m) => hasTerminal(m.tiles)) && hasTerminal(hand.pair);
}

// 混老頭: every meld is a triplet/kong, and every tile in the hand (melds
// and pair) is either a terminal (1/9) or an honor - the two can mix
// freely. Requires at least one terminal tile somewhere (meld or pair) -
// an all-honor hand (already 字一色) has no terminals to "mix" at all, so
// it shouldn't vacuously qualify (same reasoning as 混帶么's guard).
function isAllTerminalOrHonorTriplets(hand: ResolvedHand): boolean {
  const tiles = allHandTiles(hand);
  return (
    hand.melds.every((m) => m.kind === "triplet" || m.kind === "kong") &&
    tiles.every((t) => isHonorTile(t) || t.rank === 1 || t.rank === 9) &&
    tiles.some((t) => !isHonorTile(t))
  );
}

// 清老頭: same all-triplets/kongs shape, but terminals only - no honors
// anywhere. Every 清老頭 hand is trivially also a 混老頭 hand (honors are
// merely *allowed* there, not required), so this should probably exclude
// it - flagged for confirmation rather than assumed.
function isAllTerminalTriplets(hand: ResolvedHand): boolean {
  return (
    hand.melds.every((m) => m.kind === "triplet" || m.kind === "kong") &&
    allHandTiles(hand).every((t) => t.suit !== "z" && (t.rank === 1 || t.rank === 9))
  );
}

// 四歸一/二/四: the hand holds all 4 copies of some rank X (one suit), split
// across melds in different ways rather than as a kong. 明/暗 classification
// reuses isMeldOpen on whichever melds are involved (see the 明/暗 concept) -
// 明 if any of them is open, 暗 if all are concealed. The pair itself is
// never "declared" so it never factors into that check directly (only
// 四歸二 involves the pair at all, and only to identify which rank/suit is
// in play, not to judge its own openness).

// 四歸一: a triplet of X plus a run containing X (3 + 1 = the 4 copies).
// Can stack - different ranks/suits can each independently form their own
// triplet+run pair, hand-size permitting.
function fourReturnsToOneInstances(hand: ResolvedHand): [ResolvedMeld, ResolvedMeld][] {
  const instances: [ResolvedMeld, ResolvedMeld][] = [];
  for (const suit of ["m", "t", "b"] as const) {
    for (let rank = 1; rank <= 9; rank++) {
      const triplet = hand.melds.find((m) => m.kind === "triplet" && m.tiles[0].suit === suit && m.tiles[0].rank === rank);
      if (!triplet) continue;
      const run = hand.melds.find((m) => m.kind === "run" && m.tiles[0].suit === suit && m.tiles.some((t) => t.rank === rank));
      if (run) instances.push([triplet, run]);
    }
  }
  return instances;
}

// 四歸二: the pair itself is X, plus 2 runs each containing X (2 + 1 + 1 =
// the 4 copies). At most one instance possible - a hand only has one pair.
function fourReturnsToTwoRuns(hand: ResolvedHand): [ResolvedMeld, ResolvedMeld] | null {
  const pairTile = hand.pair[0];
  if (pairTile.suit === "z") return null; // honors have no runs
  const runs = hand.melds.filter(
    (m) => m.kind === "run" && m.tiles[0].suit === pairTile.suit && m.tiles.some((t) => t.rank === pairTile.rank)
  );
  return runs.length >= 2 ? [runs[0], runs[1]] : null;
}

// 四歸四: 4 separate runs, each containing X (1 + 1 + 1 + 1 = the 4 copies).
// A single hand can only ever hold one *group* of 4 runs (needs 4 of its 5
// melds), but that doesn't cap it at 1 instance the way 四歸二 is capped
// (a hand only has one pair): 4 *identical* runs (e.g. 123m×4) satisfy this
// independently for every rank the run spans - 1m, 2m, and 3m here are each
// also spread as all 4 copies across that same group of 4 runs, so all 3
// stack rather than only the first rank found.
function fourReturnsToFourInstances(hand: ResolvedHand): ResolvedMeld[][] {
  const instances: ResolvedMeld[][] = [];
  for (const suit of ["m", "t", "b"] as const) {
    for (let rank = 1; rank <= 9; rank++) {
      const runs = hand.melds.filter((m) => m.kind === "run" && m.tiles[0].suit === suit && m.tiles.some((t) => t.rank === rank));
      if (runs.length === 4) instances.push(runs);
    }
  }
  return instances;
}

// 般高 (identical sequences): pairs of runs that are exact duplicates (same
// suit, same 3 ranks) - e.g. 234m + 234m. Stacks - multiple such pairs can
// coexist (a run held 4 times, for instance, forms 2 pairs).
function identicalRunPairInstances(hand: ResolvedHand): [ResolvedMeld, ResolvedMeld][] {
  const instances: [ResolvedMeld, ResolvedMeld][] = [];
  for (const suit of ["m", "t", "b"] as const) {
    for (let rank = 1; rank <= 7; rank++) {
      const matching = hand.melds.filter((m) => m.kind === "run" && m.tiles[0].suit === suit && m.tiles[0].rank === rank);
      const pairCount = Math.floor(matching.length / 2);
      for (let i = 0; i < pairCount; i++) instances.push([matching[i * 2], matching[i * 2 + 1]]);
    }
  }
  return instances;
}

// 小雙般高: e.g. 22334455m - 2 copies each of 4 consecutive ranks, where the
// pair can be read as either end (22 + two 345 runs, or 55 + two 234 runs).
// Both readings are genuinely valid decompositions of the same tiles, so
// this only needs to check whichever pair *this* resolved hand actually
// has against both directions - scoreParsedHand's max-tai-across-
// decompositions already surfaces whichever reading scores higher. At most
// one instance possible (one pair per hand).
function smallTwinIdenticalSequences(hand: ResolvedHand): [ResolvedMeld, ResolvedMeld] | null {
  const pair = hand.pair[0];
  if (pair.suit === "z") return null;
  const runsStartingAt = (startRank: number) =>
    hand.melds.filter((m) => m.kind === "run" && m.tiles[0].suit === pair.suit && m.tiles[0].rank === startRank);

  if (pair.rank + 3 <= 9) {
    const runs = runsStartingAt(pair.rank + 1); // pair is the low end
    if (runs.length >= 2) return [runs[0], runs[1]];
  }
  if (pair.rank - 3 >= 1) {
    const runs = runsStartingAt(pair.rank - 3); // pair is the high end
    if (runs.length >= 2) return [runs[0], runs[1]];
  }
  return null;
}

// 真雙般高: two *separate* 般高 pairs (4 runs total, two different shapes) -
// e.g. 123123m + 678678t. Takes at most one pair per distinct (suit, rank)
// shape - NOT identicalRunPairInstances directly, since that helper splits
// a single 4-copy group (e.g. 123m held 4 times) into 2 pairs of the *same*
// shape for 般高's own stacking, which would wrongly count as "two
// separate" shapes here and fire alongside 一色四同順 on the same 4 runs.
function twoSeparateIdenticalRunPairs(hand: ResolvedHand): [ResolvedMeld, ResolvedMeld, ResolvedMeld, ResolvedMeld] | null {
  const groups: [ResolvedMeld, ResolvedMeld][] = [];
  for (const suit of ["m", "t", "b"] as const) {
    for (let rank = 1; rank <= 7; rank++) {
      const matching = hand.melds.filter((m) => m.kind === "run" && m.tiles[0].suit === suit && m.tiles[0].rank === rank);
      if (matching.length >= 2) groups.push([matching[0], matching[1]]);
    }
  }
  if (groups.length < 2) return null;
  const [[a, b], [c, d]] = groups;
  return [a, b, c, d];
}

// 一色三同順: 3 fully identical runs (same suit, same 3 ranks) - e.g.
// 123m x3. At most 4 copies of any tile can exist, so at most one such
// group of 3 (with maybe 1 leftover) is possible per rank/suit.
function tripleIdenticalRunInstance(hand: ResolvedHand): [ResolvedMeld, ResolvedMeld, ResolvedMeld] | null {
  for (const suit of ["m", "t", "b"] as const) {
    for (let rank = 1; rank <= 7; rank++) {
      const matching = hand.melds.filter((m) => m.kind === "run" && m.tiles[0].suit === suit && m.tiles[0].rank === rank);
      if (matching.length >= 3) return [matching[0], matching[1], matching[2]];
    }
  }
  return null;
}

// 一色四同順: 4 fully identical runs - the maximum possible (4 copies of
// each of the 3 ranks involved).
function quadrupleIdenticalRunInstance(hand: ResolvedHand): [ResolvedMeld, ResolvedMeld, ResolvedMeld, ResolvedMeld] | null {
  for (const suit of ["m", "t", "b"] as const) {
    for (let rank = 1; rank <= 7; rank++) {
      const matching = hand.melds.filter((m) => m.kind === "run" && m.tiles[0].suit === suit && m.tiles[0].rank === rank);
      if (matching.length >= 4) return [matching[0], matching[1], matching[2], matching[3]];
    }
  }
  return null;
}

// 單色步步高 (gap 1: starts X, X+1, X+2, e.g. 123m+234m+345m) and 單色二步高
// (gap 2: starts X, X+2, X+4, e.g. 123m+345m+567m) - 3 same-suit runs at
// evenly-spaced starting ranks. Reuses combineSegments exactly like 清龍/
// 雜龍: a duplicated segment (e.g. an extra 345m) reuses the other two
// shared runs and forms a second instance - see the worked example in the
// module's duplicate-instance-counting patterns.
function evenlySpacedRunInstances(hand: ResolvedHand, gap: number): ResolvedMeld[][] {
  const result: ResolvedMeld[][] = [];
  for (const suit of ["m", "t", "b"] as const) {
    for (let x = 1; x <= 7; x++) {
      result.push(...combineSegments(segmentMelds(hand, suit, x), segmentMelds(hand, suit, x + gap), segmentMelds(hand, suit, x + 2 * gap)));
    }
  }
  return result;
}

const isTripletOrKongAt = (hand: ResolvedHand, suit: Suit, rank: number): boolean =>
  hand.melds.some((m) => (m.kind === "triplet" || m.kind === "kong") && m.tiles[0].suit === suit && m.tiles[0].rank === rank);

// 明/暗三色步步高: 3 suits, each holding one run, with the runs' starting
// ranks increasing by 1 across suits in some order (e.g. 456t + 567m +
// 678b, or 234m + 345t + 456b) - the cross-suit extension of 單色步步高
// (same "climb by 1" shape, but confined to a single suit there). Starting
// rank is capped at 5 (not 7) since the highest of the 3 runs starts 2
// ranks later and a run can start no later than 7. Stacks the same
// combineSegments-style way 清龍/雜龍/步步高 do: e.g. 123456m234567t34599b
// (123m+456m, 234t+567t, 345b) forms 3 overlapping instances -
// 123m+234t+345b, 234t+345b+456m, and 345b+456m+567t - each shifted by 1
// rank, with 345b (the only b-suit run) shared across all three.
function threeColorStepUpInstances(hand: ResolvedHand): ResolvedMeld[][] {
  const result: ResolvedMeld[][] = [];
  for (let rank = 1; rank <= 5; rank++) {
    for (const suits of THREE_SUIT_ORDERS) {
      result.push(
        ...combineSegments(segmentMelds(hand, suits[0], rank), segmentMelds(hand, suits[1], rank + 1), segmentMelds(hand, suits[2], rank + 2))
      );
    }
  }
  return result;
}

// 二連刻: 2 triplets/kongs at consecutive ranks in one suit (e.g. 222m+333m,
// mixing triplet/kong freely). No 明/暗 split. Stacks per adjacent pair
// found (matches the precedent set by 老少上/二步高-style patterns), so 3
// consecutive triplets (222+333+444) counts as 2 instances.
function consecutiveTripletOrKongPairCount(hand: ResolvedHand): number {
  let count = 0;
  for (const suit of ["m", "t", "b"] as const) {
    for (let rank = 1; rank <= 8; rank++) {
      if (isTripletOrKongAt(hand, suit, rank) && isTripletOrKongAt(hand, suit, rank + 1)) count++;
    }
  }
  return count;
}

// 小三連刻: 3 consecutive ranks in one suit where the hand's pair sits at
// one of the 3 positions and the other 2 are triplets/kongs (e.g. 22m +
// 333m + 444m). 大三連刻: same 3-consecutive-rank shape, but all 3 are full
// triplets/kongs (pair not involved at all) - these are structurally
// different (one needs the pair, one doesn't), so not mutually exclusive.
// Both stack: overlapping windows sharing a triplet each count separately -
// e.g. 大三連刻 on 111m222m333m444m555m is 3 instances ([1,2,3], [2,3,4],
// [3,4,5]), same sliding-window reasoning as 二連刻/清龍's own stacking.
function smallThreeConsecutiveTripletCount(hand: ResolvedHand): number {
  const pair = hand.pair[0];
  if (pair.suit === "z") return 0;
  const windows = [
    [pair.rank, pair.rank + 1, pair.rank + 2],
    [pair.rank - 1, pair.rank, pair.rank + 1],
    [pair.rank - 2, pair.rank - 1, pair.rank],
  ];
  let count = 0;
  for (const window of windows) {
    if (window[0] < 1 || window[2] > 9) continue;
    const others = window.filter((r) => r !== pair.rank);
    if (others.length === 2 && others.every((r) => isTripletOrKongAt(hand, pair.suit, r))) count++;
  }
  return count;
}
function bigThreeConsecutiveTripletCount(hand: ResolvedHand): number {
  let count = 0;
  for (const suit of ["m", "t", "b"] as const) {
    for (let rank = 1; rank <= 7; rank++) {
      if ([rank, rank + 1, rank + 2].every((r) => isTripletOrKongAt(hand, suit, r))) count++;
    }
  }
  return count;
}

// 相逢: 2 runs with the same 3 ranks but in *different* suits (e.g.
// 234m+234t). No 明/暗 split. Stacks - grouped by suit-pair rather than a
// flat count, so a run duplicated within one suit (a 般高 concern) doesn't
// get miscounted as multiple 相逢 instances against itself.
const NUMBERED_SUITS: Suit[] = ["m", "t", "b"];
function crossSuitSameRunInstances(hand: ResolvedHand): [ResolvedMeld, ResolvedMeld][] {
  const instances: [ResolvedMeld, ResolvedMeld][] = [];
  for (let rank = 1; rank <= 7; rank++) {
    for (let i = 0; i < NUMBERED_SUITS.length; i++) {
      for (let j = i + 1; j < NUMBERED_SUITS.length; j++) {
        const a = segmentMelds(hand, NUMBERED_SUITS[i], rank);
        const b = segmentMelds(hand, NUMBERED_SUITS[j], rank);
        const pairCount = Math.min(a.length, b.length);
        for (let k = 0; k < pairCount; k++) instances.push([a[k], b[k]]);
      }
    }
  }
  return instances;
}

// 明/暗三/四/五相逢: all 3 suits have a run at the same rank, with at least
// `minRuns` runs total across them (e.g. minRuns=3 for 三相逢: one run per
// suit; minRuns=5 for 五相逢: 5 runs spread across the 3 suits however they
// fall, like 2+2+1 or 3+1+1). Returns every run meld found there, which may
// exceed minRuns - a hand satisfying a higher tier also satisfies the lower
// ones, and the exclusion chain on each PATTERNS entry decides which tier
// actually scores.
function nSuitSameRunMelds(hand: ResolvedHand, minRuns: number): ResolvedMeld[] | null {
  for (let rank = 1; rank <= 7; rank++) {
    const groups = NUMBERED_SUITS.map((suit) => segmentMelds(hand, suit, rank));
    if (groups.some((g) => g.length === 0)) continue;
    if (groups.reduce((n, g) => n + g.length, 0) >= minRuns) return groups.flat();
  }
  return null;
}

// 雙姊妹: a bonus on top of 相逢 - true when 2 *distinct* 相逢 instances
// exist, sharing no meld between them (e.g. 123m+123b and 678t+678b). A
// shape like 123m+123m+123t only ever produces one 相逢 instance (the 2nd
// 123m has no 2nd 123t to pair with - see crossSuitSameRunInstances' min-
// based pairing), so it doesn't qualify; even if it somehow produced 2
// instances that both reused the same 123t, they wouldn't count as
// "distinct" either.
function hasTwoDistinctCrossSuitRuns(hand: ResolvedHand): boolean {
  const instances = crossSuitSameRunInstances(hand);
  for (let i = 0; i < instances.length; i++) {
    for (let j = i + 1; j < instances.length; j++) {
      if (!instances[i].some((m) => instances[j].includes(m))) return true;
    }
  }
  return false;
}

// 全姊妹: every one of the 5 melds individually has a same-start-rank run
// partner in a different suit somewhere in the hand (e.g. 123m+123m+123t -
// both 123m copies count, even though crossSuitSameRunInstances' min-based
// pairing only ever forms one *stacking* instance out of them; this is a
// looser per-meld existence check, not an instance count). A triplet/kong
// or honor meld can never satisfy this, so 全姊妹 implies an all-runs hand.
function isPartOfCrossSuitRun(hand: ResolvedHand, meld: ResolvedMeld): boolean {
  if (meld.kind !== "run") return false;
  const startRank = Math.min(...meld.tiles.map((t) => t.rank));
  const suit = meld.tiles[0].suit;
  return hand.melds.some(
    (other) =>
      other !== meld &&
      other.kind === "run" &&
      other.tiles[0].suit !== suit &&
      Math.min(...other.tiles.map((t) => t.rank)) === startRank
  );
}
function hasFullCrossSuitRuns(hand: ResolvedHand): boolean {
  return hand.melds.every((m) => isPartOfCrossSuitRun(hand, m));
}

// 樓梯: all 5 melds are runs whose starting ranks form 5 consecutive
// numbers (X..X+4) - suit is unrestricted, melds can repeat or vary
// freely across suits, e.g. 123t+234b+345t+456m+567m. No 明/暗 split.
function hasStaircase(hand: ResolvedHand): boolean {
  if (!hand.melds.every((m) => m.kind === "run")) return false;
  const starts = hand.melds.map((m) => Math.min(...m.tiles.map((t) => t.rank))).sort((a, b) => a - b);
  return starts.every((s, i) => i === 0 || s === starts[i - 1] + 1);
}

// 五步高/全碟: a stricter 樓梯 - same 5-consecutive-starting-rank run shape,
// but the suits (read off in ascending-start order) must either all match,
// or follow a fixed rotation: the first 3 positions are 3 different suits
// (all of m/t/b), the 4th repeats the 1st, and the 5th repeats the 2nd -
// e.g. t,m,b,t,m. No 明/暗 split.
function hasRotatingStaircase(hand: ResolvedHand): boolean {
  if (!hasStaircase(hand)) return false;
  const suits = [...hand.melds]
    .sort((a, b) => Math.min(...a.tiles.map((t) => t.rank)) - Math.min(...b.tiles.map((t) => t.rank)))
    .map((m) => m.tiles[0].suit);
  if (suits.every((s) => s === suits[0])) return true;
  return new Set(suits.slice(0, 3)).size === 3 && suits[3] === suits[0] && suits[4] === suits[1];
}

// 兩兄弟: 2 triplets/kongs at the same rank but different suits (e.g.
// 555t+555b). No 明/暗 split; stacks the same way 相逢 does - paired by
// suit-index rather than a flat count so a within-suit duplicate isn't
// double-counted.
function crossSuitSameTripletInstances(hand: ResolvedHand): [ResolvedMeld, ResolvedMeld][] {
  const instances: [ResolvedMeld, ResolvedMeld][] = [];
  const tripletsAt = (suit: Suit, rank: number) =>
    hand.melds.filter((m) => (m.kind === "triplet" || m.kind === "kong") && m.tiles[0].suit === suit && m.tiles[0].rank === rank);
  for (let rank = 1; rank <= 9; rank++) {
    for (let i = 0; i < NUMBERED_SUITS.length; i++) {
      for (let j = i + 1; j < NUMBERED_SUITS.length; j++) {
        const a = tripletsAt(NUMBERED_SUITS[i], rank);
        const b = tripletsAt(NUMBERED_SUITS[j], rank);
        const pairCount = Math.min(a.length, b.length);
        for (let k = 0; k < pairCount; k++) instances.push([a[k], b[k]]);
      }
    }
  }
  return instances;
}

// 小三色連刻: 3 consecutive ranks across all 3 different suits, with the
// hand's pair sitting at one of the 3 positions (in its own suit) and the
// other 2 positions each held as a triplet/kong in one of the other 2
// suits (e.g. 33m + 444t + 555b). The cross-suit extension of 小三連刻
// (same shape, but confined to a single suit).
function hasSmallThreeColorConsecutiveTriplets(hand: ResolvedHand): boolean {
  const pair = hand.pair[0];
  if (pair.suit === "z") return false;
  const otherSuits = NUMBERED_SUITS.filter((s) => s !== pair.suit);
  const windows = [
    [pair.rank, pair.rank + 1, pair.rank + 2],
    [pair.rank - 1, pair.rank, pair.rank + 1],
    [pair.rank - 2, pair.rank - 1, pair.rank],
  ];
  for (const window of windows) {
    if (window[0] < 1 || window[2] > 9) continue;
    const others = window.filter((r) => r !== pair.rank);
    if (
      (isTripletOrKongAt(hand, otherSuits[0], others[0]) && isTripletOrKongAt(hand, otherSuits[1], others[1])) ||
      (isTripletOrKongAt(hand, otherSuits[1], others[0]) && isTripletOrKongAt(hand, otherSuits[0], others[1]))
    ) {
      return true;
    }
  }
  return false;
}

// 大三色連刻: 3 consecutive ranks, one full triplet/kong per suit (all 3
// suits used, none reduced to a pair) - e.g. 333t + 4444m + 555b. Not
// mutually exclusive with the small version: structurally different shapes
// (one needs the pair at one of the 3 ranks, one doesn't touch the pair at
// all), same precedent as 小/大三連刻.
const THREE_SUIT_ORDERS: Suit[][] = [
  ["m", "t", "b"],
  ["m", "b", "t"],
  ["t", "m", "b"],
  ["t", "b", "m"],
  ["b", "m", "t"],
  ["b", "t", "m"],
];
function hasBigThreeColorConsecutiveTriplets(hand: ResolvedHand): boolean {
  for (let rank = 1; rank <= 7; rank++) {
    const ranks = [rank, rank + 1, rank + 2];
    for (const suits of THREE_SUIT_ORDERS) {
      if (ranks.every((r, i) => isTripletOrKongAt(hand, suits[i], r))) return true;
    }
  }
  return false;
}

// 小三兄弟: the 3-suit extension of 兩兄弟 - one rank held as the pair (in
// its own suit) with the other 2 suits each holding a triplet/kong at that
// *same* rank (e.g. 33t + 333m + 3333b). Unlike the consecutive-rank color
// patterns, this is a single fixed rank, so no sliding window is needed.
function hasSmallThreeBrothers(hand: ResolvedHand): boolean {
  const pair = hand.pair[0];
  if (pair.suit === "z") return false;
  const otherSuits = NUMBERED_SUITS.filter((s) => s !== pair.suit);
  return otherSuits.every((s) => isTripletOrKongAt(hand, s, pair.rank));
}

// 大三兄弟: all 3 suits hold a triplet/kong at the same rank (e.g.
// 555m+555t+555b) - the pair-free counterpart to 小三兄弟, same precedent
// as every other small/big pair in this file (structurally different
// shapes, not mutually exclusive with each other).
function hasBigThreeBrothers(hand: ResolvedHand): boolean {
  for (let rank = 1; rank <= 9; rank++) {
    if (NUMBERED_SUITS.every((suit) => isTripletOrKongAt(hand, suit, rank))) return true;
  }
  return false;
}

// Shared by 大雞/大鴨: ids always exempt from their "did anything else
// fire" check - 底 and the bonus-tile patterns (an allowed single bonus
// tile still shouldn't disqualify either). Each pattern adds its own extra
// exemptions on top (see the two PATTERNS entries below) - notably, 大雞
// does NOT exempt 自摸/門清自摸: a self-drawn win is itself "a pattern
// detected," so 大雞 can never apply to a self-drawn hand (mirroring
// 全求人 requiring a claimed win). 大鴨 is the self-drawn counterpart and
// exempts those two specifically, since self-draw is exactly what it's
// checking for.
const BIG_CHICKEN_BASE_EXEMPT_IDS = new Set(["base-tai", "no-flowers", "correct-flower", "wrong-flower"]);
function anyOtherPatternFires(hand: ResolvedHand, ctx: GameContext, extraExempt: string[]): boolean {
  const exempt = new Set([...BIG_CHICKEN_BASE_EXEMPT_IDS, ...extraExempt]);
  return PATTERNS.some((p) => !exempt.has(p.id) && p.score(hand, ctx) > 0);
}

// House tai list, added one pattern at a time as the user supplies them -
// see the module doc comment on why this stays a plain array of concrete
// checks rather than a generic rule engine.
export const PATTERNS: TaiPattern[] = [
  {
    id: "base-tai",
    name: "底 (Base tai)",
    // Unconditional - every completed hand gets this, no matter its shape.
    score: () => 5,
  },
  {
    id: "concealed-except-kongs",
    name: "門前清 (Concealed hand)",
    // An exposed kong (明槓/加槓) doesn't break this, only a declared run
    // or triplet does. (There used to also be a stricter 門清 - "every
    // meld concealed, kongs included" - but that was scaffolding from the
    // initial foundation work, never one of the user's own house rules,
    // and was removed once that came up.)
    score: (hand) => (isConcealedExceptKongs(hand) ? 5 : 0),
  },
  {
    id: "kong",
    name: "槓 (Kong)",
    // Stacks: 2 tai per kong held, declared (exposed) or concealed alike.
    score: (hand) => hand.melds.filter((m) => m.kind === "kong").length * 2,
  },
  {
    id: "no-flowers",
    name: "無花 (No flowers)",
    score: (hand) => (hand.bonusTiles.length === 0 ? 2 : 0),
  },
  {
    id: "correct-flower",
    name: "正花 (Correct flower)",
    // Stacks: 2 tai for each bonus tile whose rank matches the seat wind
    // (up to 2 - the flower and the season for that wind position).
    score: (hand, ctx) => hand.bonusTiles.filter((b) => b.rank === ctx.seatWind).length * 2,
  },
  {
    id: "wrong-flower",
    name: "爛花 (Wrong flower)",
    // Stacks: 2 tai for each bonus tile whose rank doesn't match the seat
    // wind - tai value assumed to match 正花 (and 爛位風/正位風's shared
    // value), not explicitly given. Naturally disjoint from 無花/無字花
    // (both require zero bonus tiles), so no exclusion needed.
    score: (hand, ctx) => hand.bonusTiles.filter((b) => b.rank !== ctx.seatWind).length * 2,
  },
  {
    id: "no-honors-no-flowers",
    name: "無字花 (No honors, no flowers)",
    score: (hand) => (isNoHonorsNoFlowers(hand) ? 10 : 0),
    excludes: ["no-honors", "no-flowers"],
  },
  {
    id: "no-honors",
    name: "無字 (No honors)",
    score: (hand) => (allHandTiles(hand).every((t) => !isHonorTile(t)) ? 2 : 0),
  },
  {
    id: "wrong-seat-wind",
    name: "爛位風 (Wind meld not matching seat wind)",
    score: (hand, ctx) => (windMeldRanks(hand).some((r) => r !== ctx.seatWind) ? 2 : 0),
  },
  {
    id: "correct-seat-wind",
    name: "正位風 (Wind meld matching seat wind)",
    score: (hand, ctx) => (windMeldRanks(hand).some((r) => r === ctx.seatWind) ? 2 : 0),
  },
  {
    id: "correct-round-wind",
    name: "正圈風 (Wind meld matching round wind)",
    // Placeholder: kept in the list (so the wind-pattern exclusion chain
    // below stays wired up around it) but worth 0 tai for now. 爛圈風 was
    // removed entirely rather than zeroed the same way.
    score: () => 0,
  },
  {
    id: "small-three-winds",
    name: "小三風 (Small three winds)",
    score: (hand) => {
      const ranks = new Set(windMeldRanks(hand));
      return ranks.size >= 2 && pairIsSpareWind(hand, ranks) ? 30 : 0;
    },
    excludes: SINGLE_WIND_PATTERN_IDS,
  },
  {
    id: "big-three-winds",
    name: "大三風 (Big three winds)",
    score: (hand) => (new Set(windMeldRanks(hand)).size >= 3 ? 60 : 0),
    excludes: [...SINGLE_WIND_PATTERN_IDS, "small-three-winds"],
  },
  {
    id: "small-four-winds",
    name: "小四喜 (Small four winds)",
    score: (hand) => {
      const ranks = new Set(windMeldRanks(hand));
      return ranks.size >= 3 && pairIsSpareWind(hand, ranks) ? 120 : 0;
    },
    excludes: [...SINGLE_WIND_PATTERN_IDS, "small-three-winds", "big-three-winds"],
  },
  {
    id: "big-four-winds",
    name: "大四喜 (Big four winds)",
    score: (hand) => (new Set(windMeldRanks(hand)).size >= 4 ? 160 : 0),
    excludes: [...SINGLE_WIND_PATTERN_IDS, "small-three-winds", "big-three-winds", "small-four-winds"],
  },
  {
    id: "dragon-tile",
    name: "三元牌 (Dragon meld)",
    // Stacks: 2 tai for each dragon meld held.
    score: (hand) => dragonMeldRanks(hand).length * 2,
  },
  {
    id: "small-three-dragons",
    name: "小三元 (Small three dragons)",
    score: (hand) => {
      const ranks = new Set(dragonMeldRanks(hand));
      return ranks.size >= 2 && pairIsSpareDragon(hand, ranks) ? 40 : 0;
    },
    excludes: ["dragon-tile"],
  },
  {
    id: "big-three-dragons",
    name: "大三元 (Big three dragons)",
    score: (hand) => (new Set(dragonMeldRanks(hand)).size >= 3 ? 80 : 0),
    excludes: ["dragon-tile", "small-three-dragons"],
  },
  {
    id: "all-honors",
    name: "字一色 (All honors)",
    score: (hand) => (allHandTiles(hand).every(isHonorTile) ? 160 : 0),
  },
  {
    id: "all-runs",
    name: "平胡 (All runs)",
    score: (hand) => (isAllRuns(hand) ? 5 : 0),
  },
  {
    id: "all-runs-no-honors-no-flowers",
    name: "無字花大平胡 (All runs, no honors, no flowers)",
    score: (hand) => (isAllRuns(hand) && isNoHonorsNoFlowers(hand) ? 20 : 0),
    excludes: ["all-runs", "no-honors-no-flowers"],
  },
  {
    id: "missing-one-suit",
    name: "缺一門 (Missing one suit)",
    // No honor tile anywhere in the hand - melds or pair. Any honor
    // presence disqualifies the hand from 缺一門 entirely, not just an
    // honor pair.
    score: (hand) => (numberedSuitsUsed(hand).size === 2 && allHandTiles(hand).every((t) => !isHonorTile(t)) ? 10 : 0),
  },
  {
    id: "middle-tile-pair",
    name: "將眼 (Pair is 2, 5, or 8 - not honors)",
    score: (hand) => (!isHonorTile(hand.pair[0]) && [2, 5, 8].includes(hand.pair[0].rank) ? 2 : 0),
  },
  {
    id: "no-fives",
    name: "缺五 (No fives)",
    score: (hand) => (hasNoFives(hand) ? 10 : 0),
  },
  {
    id: "small-five-suits",
    name: "小五門齊 (Small five suits complete)",
    score: (hand) => (categoriesPresent(hand).size === 5 && categoriesWithFullMeld(hand).size < 5 ? 10 : 0),
  },
  {
    id: "big-five-suits",
    name: "大五門齊 (Big five suits complete)",
    // Implies categoriesPresent(hand).size === 5 too - 5 melds, 5 categories,
    // one dedicated meld each covers every category on its own.
    score: (hand) => (categoriesWithFullMeld(hand).size === 5 ? 15 : 0),
  },
  {
    id: "small-seven-suits",
    name: "小七門齊 (Small seven suits complete)",
    score: (hand) =>
      categoriesPresent(hand).size === 5 &&
      categoriesWithFullMeld(hand).size < 5 &&
      hasBonusKind(hand, "flower") &&
      hasBonusKind(hand, "season")
        ? 15
        : 0,
    excludes: ["small-five-suits"],
  },
  {
    id: "big-seven-suits",
    name: "大七門齊 (Big seven suits complete)",
    score: (hand) =>
      categoriesWithFullMeld(hand).size === 5 && hasBonusKind(hand, "flower") && hasBonusKind(hand, "season") ? 20 : 0,
    excludes: ["big-five-suits"],
  },
  {
    id: "greater-than-five",
    name: "大於五 (All 6-9)",
    score: (hand) => (allTilesInRange(hand, 6, 9) ? 40 : 0),
    excludes: ["no-fives"],
  },
  {
    id: "less-than-five",
    name: "小於五 (All 1-4)",
    score: (hand) => (allTilesInRange(hand, 1, 4) ? 40 : 0),
    excludes: ["no-fives"],
  },
  {
    id: "all-simples",
    name: "斷么 (All simples)",
    score: (hand) => (allHandTiles(hand).every((t) => t.suit !== "z" && t.rank >= 2 && t.rank <= 8) ? 10 : 0),
  },
  {
    id: "three-treasures",
    name: "三寶 (Range restriction + all-simples + suit purity/missing-one-suit)",
    // Additional bonus - stacks with all 3 constituent patterns, same
    // "stacks with everything" framing as 雙/全姊妹, 樓梯, and 五步高/全碟.
    score: (hand) => (hasThreeTreasures(hand) ? 40 : 0),
  },
  {
    id: "all-triplets",
    name: "對對胡 (All triplets)",
    score: (hand) => (hand.melds.every((m) => m.kind === "triplet" || m.kind === "kong") ? 40 : 0),
  },
  {
    id: "five-concealed-triplets",
    name: "坎坎胡 (Five concealed triplets, self-draw)",
    // Kongs aren't eligible here (unlike the 暗刻 chain below) - every meld
    // must be a plain triplet, physically concealed, and the win must be
    // self-drawn (which also means isMeldOpen's winningTile carve-out can
    // never apply, so checking `concealed` directly is equivalent and
    // simpler).
    score: (hand, ctx) => (ctx.selfDraw && hand.melds.every((m) => m.kind === "triplet" && m.concealed) ? 160 : 0),
    excludes: ["all-triplets", "two-hidden-triplets", "three-hidden-triplets", "four-hidden-triplets", "five-hidden-triplets"],
  },
  {
    id: "two-hidden-triplets",
    name: "兩暗刻 (Two concealed triplets/kongs)",
    score: (hand, ctx) => (hiddenTripletOrKongCount(hand, ctx) >= 2 ? 5 : 0),
  },
  {
    id: "three-hidden-triplets",
    name: "三暗刻 (Three concealed triplets/kongs)",
    score: (hand, ctx) => (hiddenTripletOrKongCount(hand, ctx) >= 3 ? 15 : 0),
    excludes: ["two-hidden-triplets"],
  },
  {
    id: "four-hidden-triplets",
    name: "四暗刻 (Four concealed triplets/kongs)",
    score: (hand, ctx) => (hiddenTripletOrKongCount(hand, ctx) >= 4 ? 30 : 0),
    excludes: ["two-hidden-triplets", "three-hidden-triplets"],
  },
  {
    id: "five-hidden-triplets",
    name: "五暗刻 (Five concealed triplets/kongs)",
    score: (hand, ctx) => (hiddenTripletOrKongCount(hand, ctx) >= 5 ? 80 : 0),
    excludes: ["two-hidden-triplets", "three-hidden-triplets", "four-hidden-triplets"],
  },
  {
    id: "five-kongs",
    name: "五槓子 (Five kongs)",
    score: (hand) => (hand.melds.every((m) => m.kind === "kong") ? 240 : 0),
    excludes: ["kong", "four-hidden-triplets", "five-hidden-triplets"],
  },
  {
    id: "pure-straight-open",
    name: "明清龍 (Pure straight, open)",
    // Stacks per instance - see pureStraightInstances/combineSegments.
    score: (hand, ctx) => pureStraightInstances(hand).filter((inst) => inst.some((m) => isMeldOpen(m, ctx))).length * 10,
  },
  {
    id: "pure-straight-hidden",
    name: "暗清龍 (Pure straight, concealed)",
    score: (hand, ctx) => pureStraightInstances(hand).filter((inst) => inst.every((m) => !isMeldOpen(m, ctx))).length * 20,
  },
  {
    id: "mixed-straight-open",
    name: "明雜龍 (Mixed straight across suits, open)",
    score: (hand, ctx) => mixedStraightInstances(hand).filter((inst) => inst.some((m) => isMeldOpen(m, ctx))).length * 8,
  },
  {
    id: "mixed-straight-hidden",
    name: "暗雜龍 (Mixed straight across suits, concealed)",
    score: (hand, ctx) => mixedStraightInstances(hand).filter((inst) => inst.every((m) => !isMeldOpen(m, ctx))).length * 15,
  },
  {
    id: "old-young-run",
    name: "老少上 (Terminal runs, 123 + 789)",
    // No excludes needed against 清龍 - oldYoungRunInstances already skips
    // any suit that also has a 4-5-6 run itself.
    score: (hand) => oldYoungRunInstances(hand) * 3,
  },
  {
    id: "old-young-triplet",
    name: "老少碰 (Terminal triplets/kongs, 111 + 999)",
    score: (hand) => oldYoungTripletInstances(hand) * 5,
  },
  {
    id: "mixed-common-rank",
    name: "混帶X (Common rank across every non-honor meld)",
    score: (hand) => (hasCommonRankAcrossNonHonorMelds(hand) ? 30 : 0),
  },
  {
    id: "mixed-common-rank-pair",
    name: "混帶XY (Common rank pair across every non-honor meld)",
    score: (hand) => (hasCommonRankPairAcrossNonHonorMelds(hand) ? 50 : 0),
    excludes: ["mixed-common-rank"],
  },
  {
    id: "mixed-common-rank-triple",
    name: "混帶XYZ (Common rank triple across every non-honor meld)",
    score: (hand) => (hasCommonRankTripleAcrossNonHonorMelds(hand) ? 60 : 0),
    excludes: ["mixed-common-rank-pair"],
  },
  {
    id: "pure-common-rank",
    name: "全帶X (Common rank across every meld and the pair, no honors)",
    score: (hand) => (hasCommonRankAcrossAllMeldsAndPair(hand) ? 120 : 0),
    excludes: ["mixed-common-rank"],
  },
  {
    id: "mixed-terminal",
    name: "混帶么 (Honor presence + terminal in every non-honor meld)",
    // Doesn't need to exclude 缺五 the way 全帶么 does: 缺五 requires no
    // honors anywhere at all (see hasNoFives), but 混帶么 specifically
    // requires honor presence somewhere - that's its whole "混" (mixed)
    // characteristic - so the two are already mutually exclusive by
    // construction, no explicit exclude needed.
    score: (hand) => (hasHonorPresenceAnywhere(hand) && pairIsTerminalOrHonor(hand) && everyNonHonorMeldHasTerminal(hand) ? 40 : 0),
  },
  {
    id: "pure-terminal",
    name: "全帶么 (No honors, terminal in every meld and the pair)",
    // Excludes 缺五: the only runs/triplets containing a terminal are
    // 1-2-3, 7-8-9, 111, or 999 - none of which can ever contain a 5 - so
    // every meld (and the pair) containing a terminal already structurally
    // guarantees the whole hand has no fives at all. Same "stricter
    // version subsumes the automatically-implied simpler one" precedent as
    // 大於五/小於五 excluding it.
    score: (hand) => (hasNoHonorsAndTerminalInEveryMeldAndPair(hand) ? 80 : 0),
    excludes: ["no-fives"],
  },
  {
    id: "mixed-terminal-honor-triplets",
    name: "混老頭 (All triplets/kongs, terminals and/or honors)",
    // Stacks fine with 對對胡/坎坎胡 (not excluded) - just excludes the two
    // 帶么 patterns it subsumes (every meld here trivially "contains" its
    // own terminal or honor).
    score: (hand) => (isAllTerminalOrHonorTriplets(hand) ? 100 : 0),
    excludes: ["mixed-terminal", "pure-terminal"],
  },
  {
    id: "pure-terminal-triplets",
    name: "清老頭 (All triplets/kongs, terminals only)",
    score: (hand) => (isAllTerminalTriplets(hand) ? 200 : 0),
    excludes: ["mixed-terminal", "pure-terminal", "mixed-terminal-honor-triplets"],
  },
  {
    id: "four-returns-to-one-open",
    name: "明四歸一 (Triplet + run, open)",
    score: (hand, ctx) =>
      fourReturnsToOneInstances(hand).filter(([triplet, run]) => isMeldOpen(triplet, ctx) || isMeldOpen(run, ctx)).length * 5,
  },
  {
    id: "four-returns-to-one-hidden",
    name: "暗四歸一 (Triplet + run, concealed)",
    score: (hand, ctx) =>
      fourReturnsToOneInstances(hand).filter(([triplet, run]) => !isMeldOpen(triplet, ctx) && !isMeldOpen(run, ctx)).length * 15,
  },
  {
    id: "four-returns-to-two-open",
    name: "明四歸二 (Pair + 2 runs, open)",
    score: (hand, ctx) => {
      const runs = fourReturnsToTwoRuns(hand);
      return runs && (isMeldOpen(runs[0], ctx) || isMeldOpen(runs[1], ctx)) ? 15 : 0;
    },
  },
  {
    id: "four-returns-to-two-hidden",
    name: "暗四歸二 (Pair + 2 runs, concealed)",
    score: (hand, ctx) => {
      const runs = fourReturnsToTwoRuns(hand);
      return runs && !isMeldOpen(runs[0], ctx) && !isMeldOpen(runs[1], ctx) ? 30 : 0;
    },
  },
  {
    id: "four-returns-to-four-open",
    name: "明四歸四 (4 runs, open)",
    score: (hand, ctx) =>
      fourReturnsToFourInstances(hand).filter((runs) => runs.some((r) => isMeldOpen(r, ctx))).length * 30,
  },
  {
    id: "four-returns-to-four-hidden",
    name: "暗四歸四 (4 runs, concealed)",
    score: (hand, ctx) =>
      fourReturnsToFourInstances(hand).filter((runs) => runs.every((r) => !isMeldOpen(r, ctx))).length * 60,
  },
  {
    id: "identical-sequences-open",
    name: "明般高 (Identical sequences, open)",
    score: (hand, ctx) => identicalRunPairInstances(hand).filter(([a, b]) => isMeldOpen(a, ctx) || isMeldOpen(b, ctx)).length * 5,
  },
  {
    id: "identical-sequences-hidden",
    name: "暗般高 (Identical sequences, concealed)",
    score: (hand, ctx) =>
      identicalRunPairInstances(hand).filter(([a, b]) => !isMeldOpen(a, ctx) && !isMeldOpen(b, ctx)).length * 8,
  },
  {
    id: "small-twin-identical-sequences-open",
    name: "明小雙般高 (Pair at one end of twin sequences, open)",
    score: (hand, ctx) => {
      const runs = smallTwinIdenticalSequences(hand);
      return runs && (isMeldOpen(runs[0], ctx) || isMeldOpen(runs[1], ctx)) ? 10 : 0;
    },
    excludes: ["identical-sequences-open", "identical-sequences-hidden"],
  },
  {
    id: "small-twin-identical-sequences-hidden",
    name: "暗小雙般高 (Pair at one end of twin sequences, concealed)",
    score: (hand, ctx) => {
      const runs = smallTwinIdenticalSequences(hand);
      return runs && !isMeldOpen(runs[0], ctx) && !isMeldOpen(runs[1], ctx) ? 15 : 0;
    },
    excludes: ["identical-sequences-open", "identical-sequences-hidden"],
  },
  {
    id: "triple-identical-sequences-open",
    name: "明一色三同順 (3 identical sequences, open)",
    score: (hand, ctx) => {
      const runs = tripleIdenticalRunInstance(hand);
      return runs && runs.some((r) => isMeldOpen(r, ctx)) ? 30 : 0;
    },
    excludes: ["identical-sequences-open", "identical-sequences-hidden"],
  },
  {
    id: "triple-identical-sequences-hidden",
    name: "暗一色三同順 (3 identical sequences, concealed)",
    score: (hand, ctx) => {
      const runs = tripleIdenticalRunInstance(hand);
      return runs && runs.every((r) => !isMeldOpen(r, ctx)) ? 60 : 0;
    },
    excludes: ["identical-sequences-open", "identical-sequences-hidden"],
  },
  {
    id: "quadruple-identical-sequences-open",
    name: "明一色四同順 (4 identical sequences, open)",
    score: (hand, ctx) => {
      const runs = quadrupleIdenticalRunInstance(hand);
      return runs && runs.some((r) => isMeldOpen(r, ctx)) ? 80 : 0;
    },
    excludes: ["identical-sequences-open", "identical-sequences-hidden", "triple-identical-sequences-open", "triple-identical-sequences-hidden"],
  },
  {
    id: "quadruple-identical-sequences-hidden",
    name: "暗一色四同順 (4 identical sequences, concealed)",
    score: (hand, ctx) => {
      const runs = quadrupleIdenticalRunInstance(hand);
      return runs && runs.every((r) => !isMeldOpen(r, ctx)) ? 160 : 0;
    },
    excludes: ["identical-sequences-open", "identical-sequences-hidden", "triple-identical-sequences-open", "triple-identical-sequences-hidden"],
  },
  {
    id: "two-separate-identical-sequences-open",
    name: "明真雙般高 (2 separate identical-sequence pairs, open)",
    score: (hand, ctx) => {
      const runs = twoSeparateIdenticalRunPairs(hand);
      return runs && runs.some((r) => isMeldOpen(r, ctx)) ? 20 : 0;
    },
    excludes: ["identical-sequences-open", "identical-sequences-hidden"],
  },
  {
    id: "two-separate-identical-sequences-hidden",
    name: "暗真雙般高 (2 separate identical-sequence pairs, concealed)",
    score: (hand, ctx) => {
      const runs = twoSeparateIdenticalRunPairs(hand);
      return runs && runs.every((r) => !isMeldOpen(r, ctx)) ? 40 : 0;
    },
    excludes: ["identical-sequences-open", "identical-sequences-hidden"],
  },
  {
    id: "same-suit-consecutive-open",
    name: "明單色步步高 (3 ascending sequences, gap 1, open)",
    score: (hand, ctx) =>
      evenlySpacedRunInstances(hand, 1).filter((inst) => inst.some((m) => isMeldOpen(m, ctx))).length * 15,
  },
  {
    id: "same-suit-consecutive-hidden",
    name: "暗單色步步高 (3 ascending sequences, gap 1, concealed)",
    score: (hand, ctx) =>
      evenlySpacedRunInstances(hand, 1).filter((inst) => inst.every((m) => !isMeldOpen(m, ctx))).length * 30,
  },
  {
    id: "same-suit-two-step-open",
    name: "明單色二步高 (3 sequences, gap 2, open)",
    score: (hand, ctx) =>
      evenlySpacedRunInstances(hand, 2).filter((inst) => inst.some((m) => isMeldOpen(m, ctx))).length * 8,
  },
  {
    id: "same-suit-two-step-hidden",
    name: "暗單色二步高 (3 sequences, gap 2, concealed)",
    score: (hand, ctx) =>
      evenlySpacedRunInstances(hand, 2).filter((inst) => inst.every((m) => !isMeldOpen(m, ctx))).length * 15,
  },
  {
    id: "consecutive-triplet-pair",
    name: "二連刻 (2 consecutive triplets/kongs)",
    // Stacks per adjacent pair; no 明/暗 split.
    score: (hand) => consecutiveTripletOrKongPairCount(hand) * 5,
  },
  {
    id: "small-three-consecutive-triplets",
    name: "小三連刻 (3 consecutive ranks, pair at one end + 2 triplets/kongs)",
    score: (hand) => smallThreeConsecutiveTripletCount(hand) * 15,
    excludes: ["consecutive-triplet-pair"],
  },
  {
    id: "big-three-consecutive-triplets",
    name: "大三連刻 (3 consecutive triplets/kongs)",
    score: (hand) => bigThreeConsecutiveTripletCount(hand) * 30,
    excludes: ["consecutive-triplet-pair"],
  },
  {
    id: "half-flush",
    name: "混一色 (One numbered suit + honors)",
    score: (hand) => (numberedSuitsUsed(hand).size === 1 ? 40 : 0),
  },
  {
    id: "full-flush",
    name: "清一色 (One numbered suit, no honors)",
    score: (hand) => (numberedSuitsUsed(hand).size === 1 && allHandTiles(hand).every((t) => !isHonorTile(t)) ? 120 : 0),
    excludes: ["half-flush"],
  },
  {
    id: "cross-suit-same-run",
    name: "相逢 (Same run, different suits)",
    // No 明/暗 split; stacks per instance.
    score: (hand) => crossSuitSameRunInstances(hand).length * 3,
  },
  {
    id: "twin-cross-suit-runs",
    name: "雙姊妹 (2 distinct 相逢 instances)",
    // Additional bonus on top of 相逢 - stacks with it (and with anything
    // else), not an alternative to it. No 明/暗 split.
    score: (hand) => (hasTwoDistinctCrossSuitRuns(hand) ? 5 : 0),
  },
  {
    id: "full-cross-suit-runs",
    name: "全姊妹 (Every meld is part of a 相逢)",
    // Additional bonus, same "stacks with everything" framing as 雙姊妹 -
    // except against 雙姊妹 itself, which it excludes: every meld already
    // being paired off implies (at least) 2 distinct 相逢 instances, so
    // scoring both would double-count the same underlying structure.
    score: (hand) => (hasFullCrossSuitRuns(hand) ? 20 : 0),
    excludes: ["twin-cross-suit-runs"],
  },
  {
    id: "staircase",
    name: "樓梯 (5 runs, consecutive starting ranks, any suit)",
    // Additional bonus, same "stacks with everything" framing as 雙/全姊妹 -
    // doesn't exclude 平胡 even though every 樓梯 hand is also 平胡.
    score: (hand) => (hasStaircase(hand) ? 20 : 0),
  },
  {
    id: "rotating-staircase",
    name: "五步高/全碟 (Stricter 樓梯: same suit or a fixed rotation)",
    // Every 五步高/全碟 hand is also a 樓梯 (same 5-consecutive-starting-
    // rank run shape, just with the added suit constraint) - excludes it
    // so the stricter version doesn't double-score on top of the version
    // it subsumes.
    score: (hand) => (hasRotatingStaircase(hand) ? 40 : 0),
    excludes: ["staircase"],
  },
  {
    id: "three-suit-same-run-open",
    name: "明三相逢 (Same run in all 3 suits, open)",
    score: (hand, ctx) => {
      const melds = nSuitSameRunMelds(hand, 3);
      return melds && melds.some((m) => isMeldOpen(m, ctx)) ? 10 : 0;
    },
    excludes: ["cross-suit-same-run"],
  },
  {
    id: "three-suit-same-run-hidden",
    name: "暗三相逢 (Same run in all 3 suits, concealed)",
    score: (hand, ctx) => {
      const melds = nSuitSameRunMelds(hand, 3);
      return melds && melds.every((m) => !isMeldOpen(m, ctx)) ? 20 : 0;
    },
    excludes: ["cross-suit-same-run"],
  },
  {
    id: "four-suit-same-run-open",
    name: "明四相逢 (4 runs across all 3 suits, one suit doubled, open)",
    score: (hand, ctx) => {
      const melds = nSuitSameRunMelds(hand, 4);
      return melds && melds.some((m) => isMeldOpen(m, ctx)) ? 40 : 0;
    },
    excludes: ["cross-suit-same-run", "three-suit-same-run-open", "three-suit-same-run-hidden"],
  },
  {
    id: "four-suit-same-run-hidden",
    name: "暗四相逢 (4 runs across all 3 suits, one suit doubled, concealed)",
    score: (hand, ctx) => {
      const melds = nSuitSameRunMelds(hand, 4);
      return melds && melds.every((m) => !isMeldOpen(m, ctx)) ? 80 : 0;
    },
    excludes: ["cross-suit-same-run", "three-suit-same-run-open", "three-suit-same-run-hidden"],
  },
  {
    id: "five-suit-same-run-open",
    name: "明五相逢 (5 runs across all 3 suits, open)",
    score: (hand, ctx) => {
      const melds = nSuitSameRunMelds(hand, 5);
      return melds && melds.some((m) => isMeldOpen(m, ctx)) ? 80 : 0;
    },
    excludes: [
      "cross-suit-same-run",
      "three-suit-same-run-open",
      "three-suit-same-run-hidden",
      "four-suit-same-run-open",
      "four-suit-same-run-hidden",
    ],
  },
  {
    id: "five-suit-same-run-hidden",
    name: "暗五相逢 (5 runs across all 3 suits, concealed)",
    score: (hand, ctx) => {
      const melds = nSuitSameRunMelds(hand, 5);
      return melds && melds.every((m) => !isMeldOpen(m, ctx)) ? 160 : 0;
    },
    excludes: [
      "cross-suit-same-run",
      "three-suit-same-run-open",
      "three-suit-same-run-hidden",
      "four-suit-same-run-open",
      "four-suit-same-run-hidden",
    ],
  },
  {
    id: "cross-suit-same-triplet",
    name: "兩兄弟 (Same triplet/kong rank, different suits)",
    // No 明/暗 split; stacks per instance, same as 相逢.
    score: (hand) => crossSuitSameTripletInstances(hand).length * 5,
  },
  {
    id: "small-three-color-consecutive-triplets",
    name: "小三色連刻 (3 consecutive ranks across all 3 suits, pair at one + 2 triplets/kongs)",
    score: (hand) => (hasSmallThreeColorConsecutiveTriplets(hand) ? 10 : 0),
  },
  {
    id: "big-three-color-consecutive-triplets",
    name: "大三色連刻 (3 consecutive ranks across all 3 suits, all triplets/kongs)",
    // Tai value not yet confirmed by the user - assumed 20 (double the small
    // version, matching the 小/大 doubling convention used elsewhere, e.g.
    // 小三連刻=15 / 大三連刻=30). Flag for confirmation.
    score: (hand) => (hasBigThreeColorConsecutiveTriplets(hand) ? 20 : 0),
  },
  {
    id: "small-three-brothers",
    name: "小三兄弟 (Same rank across all 3 suits, pair at one + 2 triplets/kongs)",
    score: (hand) => (hasSmallThreeBrothers(hand) ? 20 : 0),
    excludes: ["cross-suit-same-triplet"],
  },
  {
    id: "big-three-brothers",
    name: "大三兄弟 (Same rank across all 3 suits, all triplets/kongs)",
    score: (hand) => (hasBigThreeBrothers(hand) ? 40 : 0),
    excludes: ["cross-suit-same-triplet"],
  },
  {
    id: "three-color-step-up-open",
    name: "明三色步步高 (3 suits, runs increasing by 1, open)",
    score: (hand, ctx) => threeColorStepUpInstances(hand).filter((inst) => inst.some((m) => isMeldOpen(m, ctx))).length * 5,
  },
  {
    id: "three-color-step-up-hidden",
    name: "暗三色步步高 (3 suits, runs increasing by 1, concealed)",
    score: (hand, ctx) => threeColorStepUpInstances(hand).filter((inst) => inst.every((m) => !isMeldOpen(m, ctx))).length * 10,
  },
  {
    id: "shanpon-wait",
    name: "對碰 (Shanpon: dual-pair wait completed into a triplet)",
    score: (hand, ctx) => (isShanponWait(hand, ctx) ? 2 : 0),
  },
  {
    id: "genuine-single-wait",
    name: "獨獨 (Genuine single wait)",
    score: (hand, ctx) => (isGenuineSingleWait(hand, ctx) ? 2 : 0),
    excludes: ["fake-single-wait"],
  },
  {
    id: "fake-single-wait",
    name: "假獨 (Fake single wait)",
    score: (hand, ctx) => (isFakeSingleWait(hand, ctx) ? 2 : 0),
  },
  {
    id: "visible-triple-win",
    name: "明絕 (Won on a tile already declared 3 times)",
    // OR'd with the manual override (see GameContext.manualVisibleTripleWin)
    // rather than added to it - the manual toggle is for asserting this is
    // true when the auto-check can't see it, not a second independent
    // instance of the same pattern.
    score: (hand, ctx) => (isVisiblyTripledWinningTile(hand, ctx) || ctx.manualVisibleTripleWin ? 5 : 0),
    caveat:
      "Only checks this hand's own declared melds - it has no knowledge of the discard pile or any other player's declared melds, so it can't confirm this is truly the last copy of the tile anywhere in the game.",
  },
  {
    id: "visible-exhausted-multi-wait",
    name: "絕絕 (Multi-way wait narrowed to one visible copy)",
    // Same OR-with-manual-override reasoning as 明絕 above.
    score: (hand, ctx) => (isVisiblyExhaustedMultiWait(hand, ctx) || ctx.manualVisibleExhaustedMultiWait ? 10 : 0),
    // Excludes 明絕 since it's the same underlying "visibly exhausted"
    // idea, just a stronger, more specific finding when it applies - the
    // two CAN co-occur (明絕 doesn't require the wait to be single, so it
    // can still independently fire on the one collided kind even when
    // the overall wait is genuinely multi-way), so this exclusion is
    // load-bearing, not just defensive.
    excludes: ["visible-triple-win"],
    caveat:
      "Only checks this hand's own declared melds - it has no knowledge of the discard pile or any other player's declared melds, so it can't confirm these are truly the last copies of the tile anywhere in the game.",
  },
  {
    id: "self-draw",
    name: "自摸 (Self-drawn win)",
    score: (_hand, ctx) => (ctx.selfDraw ? 1 : 0),
  },
  {
    id: "riichi",
    name: "叮 (Riichi)",
    // Purely a declared state (ctx.riichi) - nothing about the hand's own
    // shape determines this, unlike every other pattern here.
    score: (_hand, ctx) => (ctx.riichi === "riichi" ? 5 : 0),
  },
  {
    id: "concealed-riichi",
    name: "門清叮 (Riichi while 門前清)",
    // Upgrade of 叮: excludes plain 叮, but stacks with 門前清 itself (the
    // two measure different things - one about melds, one about the
    // declared state) - same shape as 自摸/門清自摸 just above.
    score: (hand, ctx) => (ctx.riichi === "riichi" && isConcealedExceptKongs(hand) ? 10 : 0),
    excludes: ["riichi", "heavenly-riichi", "earthly-riichi"],
  },
  {
    id: "heavenly-riichi",
    name: "天叮 (Heavenly Riichi)",
    score: (_hand, ctx) => (ctx.riichi === "heavenly-riichi" ? 60 : 0),
    // Excludes 叮/門清叮 explicitly per the user, even though ctx.riichi
    // being a single value already makes them mutually exclusive by
    // construction - kept for the same defensive-clarity reasons as
    // elsewhere in this file (e.g. 絕絕/明絕).
    excludes: ["riichi", "concealed-riichi"],
  },
  {
    id: "earthly-riichi",
    name: "地叮 (Earthly Riichi)",
    score: (_hand, ctx) => (ctx.riichi === "earthly-riichi" ? 50 : 0),
    excludes: ["riichi", "concealed-riichi"],
  },
  {
    id: "riichi-instant-win",
    name: "一發",
    // Only meaningful once riichi is declared (any of the 3 states) -
    // stacks additively on top of whichever 叮/天叮/地叮/門清叮 tai already
    // applies, same as 食叮 below.
    score: (_hand, ctx) => (ctx.riichi !== "none" && ctx.instantWin ? 5 : 0),
  },
  {
    id: "riichi-eat",
    name: "食叮",
    // Independent of 一發 - both can be declared at once, each adding
    // their own flat 5 tai. Unlike 一發, this scores regardless of
    // whether 叮 itself is declared - purely `eatRiichi` on its own, per
    // the user's own house rule (the UI button matches: always enabled).
    score: (_hand, ctx) => (ctx.eatRiichi ? 5 : 0),
  },
  {
    id: "early-win-four",
    name: "四子內 (Won within 4 discards)",
    // Purely a declared state (ctx.earlyWin), same shape as 叮/天叮/地叮 -
    // independent of riichi entirely.
    score: (_hand, ctx) => (ctx.earlyWin === "four" ? 60 : 0),
  },
  {
    id: "early-win-seven",
    name: "七子內 (Won within 7 discards)",
    score: (_hand, ctx) => (ctx.earlyWin === "seven" ? 30 : 0),
  },
  {
    id: "early-win-ten",
    name: "十子內 (Won within 10 discards)",
    score: (_hand, ctx) => (ctx.earlyWin === "ten" ? 15 : 0),
  },
  {
    id: "multi-win-double",
    name: "雙響",
    // Purely a declared state (ctx.multiWin), same cycling shape as
    // 叮/天叮/地叮 and 四子內/七子內/十子內 - independent of both.
    score: (_hand, ctx) => (ctx.multiWin === "double" ? 5 : 0),
  },
  {
    id: "multi-win-triple",
    name: "三響",
    score: (_hand, ctx) => (ctx.multiWin === "triple" ? 10 : 0),
  },
  {
    id: "heavenly-win",
    name: "天胡",
    // Purely a declared state (ctx.heavenlyWin), same cycling shape as
    // every other purely-declared pattern above.
    score: (_hand, ctx) => (ctx.heavenlyWin === "heaven" ? 160 : 0),
  },
  {
    id: "earthly-win",
    name: "地胡",
    score: (_hand, ctx) => (ctx.heavenlyWin === "earth" ? 120 : 0),
  },
  {
    id: "human-win",
    name: "人胡",
    score: (_hand, ctx) => (ctx.heavenlyWin === "man" ? 80 : 0),
  },
  {
    id: "river-bottom-win",
    name: "河底撈魚",
    score: (_hand, ctx) => (ctx.lastTileWin === "river-bottom" ? 5 : 0),
  },
  {
    id: "sea-bottom-win",
    name: "海底撈月",
    score: (_hand, ctx) => (ctx.lastTileWin === "sea-bottom" ? 10 : 0),
  },
  {
    id: "sea-bottom-win-one-tong",
    name: "海底撈月(一筒)",
    // Upgrade of 海底撈月, not its own declared state (see
    // LastTileWinState) - fires automatically when the self-drawn
    // last-wall-tile win happens to be exactly 1 Tong, same "auto-upgrade
    // excludes the base" shape as 門清自摸/門清叮. ctx.selfDraw is checked
    // explicitly rather than assumed from lastTileWin === "sea-bottom"
    // alone - the UI happens to always force selfDraw true alongside
    // sea-bottom, but scoring.ts doesn't rely on any particular UI's
    // wiring to stay correct on its own.
    score: (_hand, ctx) =>
      ctx.lastTileWin === "sea-bottom" && ctx.selfDraw && ctx.winningTile?.suit === "t" && ctx.winningTile?.rank === 1 ? 20 : 0,
    excludes: ["sea-bottom-win"],
  },
  {
    id: "flower-draw",
    name: "花摸",
    // ctx.flowerDraw is a declared count (0-8, clamped by the UI's cycle),
    // 2 tai per count - see GameContext.flowerDraw's own doc comment for
    // why this is a flat per-count multiplier rather than trying to
    // actually model draw order.
    score: (_hand, ctx) => ctx.flowerDraw * 2,
  },
  {
    id: "kong-draw",
    name: "槓摸",
    score: (_hand, ctx) => FIVE_POWER_TAI_TABLE[ctx.kongDraw] ?? 0,
  },
  {
    id: "rob-kong",
    name: "搶槓",
    // Same declared-count/tai-table shape as 槓摸, fully independent of it.
    score: (_hand, ctx) => FIVE_POWER_TAI_TABLE[ctx.robKong] ?? 0,
  },
  {
    id: "concealed-self-draw",
    name: "門清自摸 (Self-drawn win while 門前清)",
    // Upgrade of 自摸: excludes plain 自摸, but stacks with 門前清 itself
    // (the two measure different things - one about melds, one about how
    // the tile arrived - so both keep contributing).
    score: (hand, ctx) => (ctx.selfDraw && isConcealedExceptKongs(hand) ? 3 : 0),
    excludes: ["self-draw"],
  },
  {
    id: "everyone-else-completes-it",
    name: "全求人 (All melds declared, win claimed not self-drawn)",
    score: (hand, ctx) => (isFullyDeclared(hand) && !ctx.selfDraw ? 30 : 0),
  },
  {
    id: "half-everyone-else-completes-it",
    name: "半求人 (All melds declared, win self-drawn)",
    // Same shape as 全求人, but the winning tile is self-drawn instead of
    // claimed - mutually exclusive with it by construction (selfDraw can't
    // be both), so no explicit exclusion is needed either way.
    score: (hand, ctx) => (isFullyDeclared(hand) && ctx.selfDraw ? 15 : 0),
  },
  {
    id: "big-chicken",
    name: "大雞 (Nothing but the base + at most one bonus tile)",
    // Meta pattern: fires only when no other named pattern would score for
    // this hand (excluding 底 itself and the bonus-tile patterns - "a
    // single bonus tile or none" is explicitly still allowed). A
    // self-drawn win is itself "a pattern detected" (自摸 fires), so this
    // can never apply to a self-drawn hand - mirrors 全求人 requiring a
    // claimed win. Re-evaluates every other pattern's raw score directly
    // rather than reading the already-filtered/excluded PATTERNS result,
    // since this needs to know what *would* fire, not what survives
    // exclusion.
    score: (hand, ctx) => (hand.bonusTiles.length > 1 || anyOtherPatternFires(hand, ctx, ["big-chicken"]) ? 0 : 30),
  },
  {
    id: "big-duck",
    name: "大鴨 (Nothing but the base + at most one bonus tile, self-drawn)",
    // The self-drawn counterpart to 大雞 (mirrors 全求人/半求人): same
    // "nothing else fires" shape, but self-drawn, and specifically
    // exempting 自摸/門清自摸 from that check since being self-drawn is
    // exactly what this is checking for - it stacks with them rather than
    // being blocked by them.
    score: (hand, ctx) =>
      !ctx.selfDraw || hand.bonusTiles.length > 1 || anyOtherPatternFires(hand, ctx, ["big-duck", "self-draw", "concealed-self-draw"])
        ? 0
        : 15,
  },
  {
    id: "thirteen-orphans",
    name: "十三么 (Thirteen Orphans)",
    // In normal play this is only ever reached via scoreThirteenOrphans'
    // short-circuit (see there), which builds `hand` from the same
    // breakdown this re-derives from `allHandTiles` - kept as a real,
    // independently-correct check anyway rather than a `score: () => 0`
    // stub, so PATTERNS stays the single source of truth for every
    // pattern's name/tai even for this one. By construction the hand it's
    // built from has no declared melds and no kongs, so it never coexists
    // with 門前清 or any kong-related pattern - it's exclusive of every
    // other pattern except 底 (nothing else is ever evaluated against it).
    score: (hand) => (isThirteenOrphansComplete(allHandTiles(hand)) ? 160 : 0),
  },
  {
    id: "orphans-four-return-open",
    name: "明四歸 (Special hand: one kind held all 4 copies, open)",
    // Only ever reached via scoreThirteenOrphans'/scoreEightPairs' own
    // short-circuit, but kept independently correct. Despite the id,
    // applies within either special hand - see allFourReturnQuadKinds for
    // why 十三么 contributes at most one quad while 嚦咕嚦咕 can contribute
    // several, all stacking here. A single winning tile can only ever
    // match one of them (they're all different kinds), so this is really
    // just "0 or 5" in practice, but stays a proper stacking sum for
    // consistency with -hidden below.
    score: (hand, ctx) => {
      if (ctx.winningTile === null || ctx.selfDraw) return 0;
      const matches = allFourReturnQuadKinds(hand).filter(
        (q) => q.suit === ctx.winningTile!.suit && q.rank === ctx.winningTile!.rank
      ).length;
      return matches * 5;
    },
  },
  {
    id: "orphans-four-return-hidden",
    name: "暗四歸 (Special hand: one kind held all 4 copies, concealed)",
    // Stacks once per quad NOT completed by a claimed 食胡 tile - see
    // -open above for why at most one quad can ever be "open".
    score: (hand, ctx) => {
      const quads = allFourReturnQuadKinds(hand);
      const openCount =
        ctx.winningTile !== null && !ctx.selfDraw
          ? quads.filter((q) => q.suit === ctx.winningTile!.suit && q.rank === ctx.winningTile!.rank).length
          : 0;
      return (quads.length - openCount) * 15;
    },
  },
  {
    id: "sixteen-unrelated",
    name: "十六不搭 (Sixteen Unrelated Tiles)",
    // Same "only ever reached via scoreSixteenUnrelated's short-circuit,
    // but kept independently correct" reasoning as 十三么.
    score: (hand) => (isSixteenUnrelatedComplete(allHandTiles(hand)) ? 50 : 0),
  },
  {
    id: "sixteen-unrelated-flying",
    name: "十六不搭(十六飛) (16-way wait - the 食胡 tile completed the pair)",
    // Upgrade of 十六不搭: before the 食胡 tile arrived, the hand was 16
    // genuinely unrelated singles with no pair formed yet at all - any one
    // of the 16 kinds would complete it by pairing up, hence "十六飛" (a
    // 16-way wait). Detected by checking whether the winning tile's kind is
    // the one that ended up as the pair, rather than one of the 15
    // ordinary singles. Excludes the base 十六不搭 - see
    // scoreSixteenUnrelated for how the two are chosen between.
    score: (hand, ctx) =>
      ctx.winningTile !== null &&
      isSixteenUnrelatedComplete(allHandTiles(hand)) &&
      hand.pair[0].suit === ctx.winningTile.suit &&
      hand.pair[0].rank === ctx.winningTile.rank
        ? 60
        : 0,
    excludes: ["sixteen-unrelated"],
  },
  {
    id: "sixteen-unrelated-same-ranks",
    name: "不搭三相逢 (Same 3 ranks across all 3 suits)",
    // Additional bonus - stacks with either 十六不搭 or 十六不搭(十六飛),
    // not an alternative to them.
    score: (hand) => (isSixteenUnrelatedComplete(allHandTiles(hand)) && sixteenUnrelatedRanksMatchAcrossSuits(hand) ? 20 : 0),
  },
  {
    id: "sixteen-unrelated-straight",
    name: "不搭雜龍 (Ranks span 1-9 across all 3 suits)",
    // Additional bonus, same "stacks with everything" framing as
    // 不搭三相逢 - mutually exclusive with it by construction (the ranks'
    // union can't be both size 3 and size 9 at once), but not via an
    // explicit exclude since they simply never co-fire.
    score: (hand) => (isSixteenUnrelatedComplete(allHandTiles(hand)) && sixteenUnrelatedRanksSpanOneToNine(hand) ? 20 : 0),
  },
  {
    id: "eight-pairs",
    name: "嚦咕嚦咕 (Eight Pairs)",
    // Same "only ever reached via scoreEightPairs' short-circuit, but kept
    // independently correct" reasoning as the other special hands.
    score: (hand) => (isEightPairsComplete(allHandTiles(hand)) ? 50 : 0),
  },
  {
    id: "eight-pairs-flying",
    name: "嚦咕嚦咕八飛 (More than 2 waits)",
    // Upgrade of 嚦咕嚦咕: fires when the pre-completion hand's 嚦咕嚦咕-
    // specific wait count exceeds 2 - see preCompletionEightPairsWaitCount
    // for the exact rule (an all-even "clean 8 pairs" shape always counts
    // as 8, regardless of literal tile availability).
    score: (hand, ctx) => {
      if (!isEightPairsComplete(allHandTiles(hand))) return 0;
      const waits = preCompletionEightPairsWaitCount(hand, ctx);
      return waits !== null && waits > 2 ? 60 : 0;
    },
    excludes: ["eight-pairs"],
  },
  {
    id: "eight-pairs-three-dragons",
    name: "三元嚦咕 (嚦咕嚦咕: all 3 dragon kinds present)",
    // Additive bonus, half of 小三元's 40 tai - the user confirmed this
    // maps to the "small" tier's value even though the condition itself
    // (mere presence, no meld/pair-role requirement) doesn't structurally
    // distinguish 小/大 the way normal hands do.
    score: (hand) => (eightPairsDragonRankCount(hand) === 3 ? 20 : 0),
  },
  {
    id: "eight-pairs-three-winds",
    name: "三風嚦咕 (嚦咕嚦咕: at least 3 wind kinds present)",
    // Additive bonus, half of 小三風's 30 tai. Excluded by 四喜嚦咕 below
    // (all 4 wind kinds trivially includes "at least 3").
    score: (hand) => (eightPairsWindRankCount(hand) >= 3 ? 15 : 0),
  },
  {
    id: "eight-pairs-four-winds",
    name: "四喜嚦咕 (嚦咕嚦咕: all 4 wind kinds present)",
    // Additive bonus, half of 小四喜's 120 tai.
    score: (hand) => (eightPairsWindRankCount(hand) === 4 ? 60 : 0),
    excludes: ["eight-pairs-three-winds"],
  },
];

export interface ScoreResult {
  // Includes `second`'s tai too, when present.
  total: number;
  matched: { pattern: TaiPattern; tai: number }[];
  hand: ResolvedHand;
  // 嚦咕雙食: set when the same 17 tiles are *also* validly a normal
  // melds+pair hand (or vice versa, if this result's primary reading is
  // the normal one) - the rare double case where 嚦咕嚦咕 and an ordinary
  // decomposition both apply at once. Both readings are scored and shown
  // separately in the summary tab; `total` is their sum.
  second?: { matched: { pattern: TaiPattern; tai: number }[]; hand: ResolvedHand };
}

export class ScoringError extends Error {}

// Validates completeness (kong-aware: a complete hand is 17 + total kong
// count tiles) and scores an already-parsed/already-structured hand against
// `ctx`, picking the decomposition with the highest total tai (see the
// module doc comment on why the max over all valid readings is the correct
// score). Split out from scoreHand so UI that already holds the hand as
// structured state (declared melds built via a tap picker, not typed
// notation) can score directly without a round trip through notation text.
// 十三么 (Thirteen Orphans): 13 orphan kinds one each, one doubled as the
// pair, plus one ordinary meld - 13+1+3 = 17 tiles. Structurally unrelated
// to the melds+pair shape (see decomposeHandAll's empty result for a hand
// like this), so it's detected up front and short-circuits the normal
// per-decomposition PATTERNS loop entirely - reuses mahjong.ts's own
// Thirteen Orphans detection (already relied on by the Calculator tab)
// rather than reimplementing it. Only recognized fully concealed (no
// declared melds): calling tiles doesn't help collect 13 different
// singles, so that's the only case worth handling.
// 明/暗四歸 (十三么 only): the "one ordinary meld" 十三么 needs happens to
// be a triplet of an orphan kind that ALSO shows up among the 12 singles -
// i.e. that kind is held all 4 copies (3 in the triplet, 1 as its normal
// single), rather than the meld being an unrelated triplet/run elsewhere.
// A degenerate cousin of 明/暗四歸一: that pattern's 4th copy always sits in
// a *run* (only possible for numbered tiles); here the "4th copy" is just
// another single, since honors can never be part of a run at all. Returns
// the tile kind held 4 times, or null if the meld isn't that kind of
// triplet.
function orphansQuadKind(hand: ResolvedHand): Tile | null {
  const tripletMeld = hand.melds.find((m) => m.kind === "triplet" && m.tiles.length === 3);
  if (!tripletMeld) return null;
  const quadTile = tripletMeld.tiles[0];
  const hasMatchingSingle = hand.melds.some((m) => m.tiles.length === 1 && m.tiles[0].suit === quadTile.suit && m.tiles[0].rank === quadTile.rank);
  return hasMatchingSingle ? quadTile : null;
}

function scoreThirteenOrphans(parsed: ParsedScoringHand, ctx: GameContext): ScoreResult | null {
  if (parsed.declaredMelds.length > 0) return null;
  const breakdown = decomposeThirteenOrphans(parsed.freeTiles);
  if (!breakdown) return null;

  const singleMelds: ResolvedMeld[] = breakdown.singles.map((t) => ({ tiles: [t], kind: "triplet", concealed: true }));
  const isTriplet = breakdown.meld[0].suit === breakdown.meld[1].suit && breakdown.meld[0].rank === breakdown.meld[1].rank;
  const mainMeld: ResolvedMeld = { tiles: breakdown.meld, kind: isTriplet ? "triplet" : "run", concealed: true };
  const hand: ResolvedHand = { melds: [...singleMelds, mainMeld], pair: breakdown.pair, bonusTiles: parsed.bonusTiles };

  const basePattern = PATTERNS.find((p) => p.id === "base-tai")!;
  const orphansPattern = PATTERNS.find((p) => p.id === "thirteen-orphans")!;
  const matched = [
    { pattern: basePattern, tai: basePattern.score(hand, ctx) },
    { pattern: orphansPattern, tai: orphansPattern.score(hand, ctx) },
  ];

  // 明/暗四歸: each pattern's own score() already recomputes the relevant
  // quad(s) via allFourReturnQuadKinds and sums correctly (a 十三么 hand
  // has at most one, so at most one of the two ever actually fires here,
  // but calling both and filtering keeps this in sync with scoreEightPairs
  // below, which genuinely can need both at once).
  for (const id of ["orphans-four-return-open", "orphans-four-return-hidden"]) {
    const pattern = PATTERNS.find((p) => p.id === id)!;
    const tai = pattern.score(hand, ctx);
    if (tai > 0) matched.push({ pattern, tai });
  }

  // 混帶么/混老頭: reused as-is (same ids/tai as their normal-hand
  // definitions - see the user's request) rather than special-cased,
  // because they already happen to evaluate correctly against this special
  // 13-meld construction: every non-honor "meld" among the 12 singles is
  // trivially a terminal already, so both checks reduce to just asking
  // about the one real 3-tile meld - a terminal-containing run only
  // satisfies 混帶么 (e.g. 123m); a triplet - terminal *or* honor, e.g.
  // 111m or 777z - satisfies 混老頭 too, which then excludes 混帶么, same
  // as their normal-hand exclusion relationship.
  const mixedTerminalPattern = PATTERNS.find((p) => p.id === "mixed-terminal")!;
  const allTerminalTripletsPattern = PATTERNS.find((p) => p.id === "mixed-terminal-honor-triplets")!;
  const allTerminalTripletsTai = allTerminalTripletsPattern.score(hand, ctx);
  if (allTerminalTripletsTai > 0) {
    matched.push({ pattern: allTerminalTripletsPattern, tai: allTerminalTripletsTai });
  } else {
    const mixedTerminalTai = mixedTerminalPattern.score(hand, ctx);
    if (mixedTerminalTai > 0) matched.push({ pattern: mixedTerminalPattern, tai: mixedTerminalTai });
  }

  pushFlowerBonuses(hand, ctx, matched);
  pushSelfDrawAndGenuineSingleWait(hand, ctx, matched);
  return { total: matched.reduce((sum, m) => sum + m.tai, 0), matched, hand };
}

// Shared by 十三么/十六不搭: 無花/正花/爛花 are purely bonusTiles-based
// checks, unrelated to meld structure, so they apply unmodified - a
// 十三么/十六不搭 hand still carries its own bonus tiles the same way any
// normal hand does. 嚦咕嚦咕 doesn't use this helper - it lumps the same 3
// ids into its own reusableIds batch instead (see scoreEightPairs),
// alongside 無字/無字花, so that pattern's exclusion of 無花/無字 is
// actually honored (無字/無字花 can never fire for 十三么/十六不搭, since
// both always include all 7 honors by definition, so there's no
// cross-exclusion to worry about keeping in the same batch for them).
function pushFlowerBonuses(hand: ResolvedHand, ctx: GameContext, matched: { pattern: TaiPattern; tai: number }[]): void {
  for (const id of ["no-flowers", "correct-flower", "wrong-flower"]) {
    const pattern = PATTERNS.find((p) => p.id === id)!;
    const tai = pattern.score(hand, ctx);
    if (tai > 0) matched.push({ pattern, tai });
  }
}

// Every purely-declared pattern (nothing about the hand's own shape
// determines these - see each one's own PATTERNS entry) that applies to
// all 3 special hands: 自摸 (but deliberately NOT its 門清自摸 upgrade),
// 叮/天叮/地叮 (but deliberately NOT 叮's 門清叮 upgrade), 一發/食叮,
// 四子內/七子內/十子內, 雙響/三響, 天胡/地胡/人胡, and 河底撈魚/海底撈月/
// 海底撈月(一筒)/花摸/槓摸/搶槓.
//
// 門清自摸/門清叮 are excluded on purpose, per the user: since all 3
// special hands are always fully concealed by construction (no declared
// melds ever - see each one's own "declaredMelds.length > 0 -> null"
// guard), isConcealedExceptKongs is unconditionally true there, so those
// two would otherwise ALWAYS fire instead of their plain counterparts
// whenever self-draw/叮 is declared - a self-drawn/叮'd special hand
// should just get the ordinary 1/5 tai, matching 十三么's own separate
// choice to treat plain 門前清 itself as "trivially true, not meaningful
// to list" for these hands (see the Foundation section) rather than
// stacking an upgrade on top of something that's structurally guaranteed
// either way.
const DECLARED_ONLY_PATTERN_IDS = [
  "self-draw",
  "riichi",
  "heavenly-riichi",
  "earthly-riichi",
  "riichi-instant-win",
  "riichi-eat",
  "early-win-four",
  "early-win-seven",
  "early-win-ten",
  "multi-win-double",
  "multi-win-triple",
  "heavenly-win",
  "earthly-win",
  "human-win",
  "river-bottom-win",
  "sea-bottom-win",
  "sea-bottom-win-one-tong",
  "flower-draw",
  "kong-draw",
  "rob-kong",
];
function pushDeclaredOnlyPatterns(hand: ResolvedHand, ctx: GameContext, matched: { pattern: TaiPattern; tai: number }[]): void {
  const scored = PATTERNS.filter((p) => DECLARED_ONLY_PATTERN_IDS.includes(p.id))
    .map((pattern) => ({ pattern, tai: pattern.score(hand, ctx) }))
    .filter((m) => m.tai > 0);
  const excluded = new Set(scored.flatMap((m) => m.pattern.excludes ?? []));
  matched.push(...scored.filter((m) => !excluded.has(m.pattern.id)));
}

// Shared by all three special hands: the declared-only battery above, plus
// 獨獨/假獨 - 獨獨's getWaits-based check already generalizes to these
// special shapes for free, since isCompleteHand (which getWaits calls per
// candidate tile) already recognizes 十三么/十六不搭/八仙過海 as valid
// completions, not just ordinary melds+pair. 假獨's extended check (see
// isFakeSingleWait) only ever fires for 十三么 in practice - 十六不搭 has no
// multi-tile "ordinary meld" for a single-tile placeholder to collide with
// - but is safe to check unconditionally here since it's simply never true
// otherwise. The optional `extraFakeSingleWaitCheck` covers 嚦咕嚦咕's own
// distinct 假獨 shape (see isEightPairsFakeSingleWait) as a separate
// callback rather than folding it into isFakeSingleWait itself, since that
// check's "quad + triple coexist" signal would wrongly fire on any
// ordinary hand holding a genuine kong alongside an unrelated triplet.
// Both fake-wait paths are kept mutually exclusive with 獨獨 by only
// checking them when 獨獨 didn't fire, matching genuine-single-wait's own
// declared `excludes`.
function pushSelfDrawAndGenuineSingleWait(
  hand: ResolvedHand,
  ctx: GameContext,
  matched: { pattern: TaiPattern; tai: number }[],
  extraFakeSingleWaitCheck?: (hand: ResolvedHand, ctx: GameContext) => boolean,
): void {
  pushDeclaredOnlyPatterns(hand, ctx, matched);

  const genuineSingleWaitPattern = PATTERNS.find((p) => p.id === "genuine-single-wait")!;
  const genuineSingleWaitTai = genuineSingleWaitPattern.score(hand, ctx);
  if (genuineSingleWaitTai > 0) {
    matched.push({ pattern: genuineSingleWaitPattern, tai: genuineSingleWaitTai });
  } else {
    const fakeSingleWaitPattern = PATTERNS.find((p) => p.id === "fake-single-wait")!;
    const fakeSingleWaitTai = fakeSingleWaitPattern.score(hand, ctx);
    if (fakeSingleWaitTai > 0 || (extraFakeSingleWaitCheck?.(hand, ctx) ?? false)) {
      matched.push({ pattern: fakeSingleWaitPattern, tai: fakeSingleWaitTai > 0 ? fakeSingleWaitTai : 2 });
    }
  }
}

// 嚦咕嚦咕's own 假獨 shape: a genuine "dual already-tripled kind" wait -
// e.g. 225577t8844222b111m waits on 2b/1m (both sat at 3 copies
// pre-completion; drawing the 4th of either quads it while the other
// stays a plain triple). Requires a 食胡 tile to be set, same as every
// other 假獨 case, and specifically checks that the winning tile is what
// turned its own kind into the quad - not just that a quad and a triple
// happen to coexist somewhere in the hand, which (without pinning it to
// the winning tile) would fire even with no 食胡 tile's completion story
// behind it at all. Doesn't fire on the "clean" completion (8 pairs, one
// upgraded to a triple by the winning tile), since that never produces a
// quad. Same "identical tiles could have landed in either group"
// ambiguity as the other 假獨 checks, just between two of this special
// hand's own pair/triple groups.
function isEightPairsFakeSingleWait(hand: ResolvedHand, ctx: GameContext): boolean {
  if (ctx.winningTile === null) return false;
  const quadGroup = hand.melds.find((m) => m.tiles.length === 4);
  const hasTriple = hand.melds.some((m) => m.tiles.length === 3);
  return quadGroup !== undefined && hasTriple && meldHasTileKind(quadGroup, ctx.winningTile);
}

// 不搭三相逢 (十六不搭 only): the 3 unrelated ranks chosen are the *same*
// 3 ranks in all of m/t/b - e.g. 159m+159t+159b. Since that uses up all 9
// numbered kinds without any repeats, the pair is necessarily one of the 7
// honor kinds - a consequence of the shape, not a separate condition worth
// checking on its own.
function sixteenUnrelatedRanksMatchAcrossSuits(hand: ResolvedHand): boolean {
  const ranksBySuit: Record<"m" | "t" | "b", Set<number>> = { m: new Set(), t: new Set(), b: new Set() };
  for (const t of allHandTiles(hand)) {
    if (t.suit === "m" || t.suit === "t" || t.suit === "b") ranksBySuit[t.suit].add(t.rank);
  }
  const [m, t, b] = [ranksBySuit.m, ranksBySuit.t, ranksBySuit.b];
  return m.size === 3 && t.size === 3 && b.size === 3 && [...m].every((r) => t.has(r) && b.has(r));
}

// 不搭雜龍 (十六不搭 only): the 3 suits' unrelated ranks collectively span
// 1-9 with no rank repeated across suits - e.g. 147m+258b+369t. Each suit
// already contributes exactly 3 distinct ranks in a valid 十六不搭 hand, so
// the union hitting all 9 possible ranks is only possible with zero
// overlap between suits (3+3+3 = 9 distinct values).
function sixteenUnrelatedRanksSpanOneToNine(hand: ResolvedHand): boolean {
  const ranks = new Set<number>();
  for (const t of allHandTiles(hand)) {
    if (t.suit === "m" || t.suit === "t" || t.suit === "b") ranks.add(t.rank);
  }
  return ranks.size === 9;
}

// 十六不搭 (Sixteen Unrelated Tiles): all 7 honors, plus 3 mutually-
// unrelated ranks (no two within 3 of each other) from each of m/t/b - 16
// distinct kinds, one doubled as the pair - 15+2 = 17 tiles. No "ordinary
// meld" at all here (unlike 十三么), so all 15 non-pair kinds become
// 1-tile "melds" in the display construction. Same fully-concealed-only
// restriction and short-circuit reasoning as scoreThirteenOrphans.
function scoreSixteenUnrelated(parsed: ParsedScoringHand, ctx: GameContext): ScoreResult | null {
  if (parsed.declaredMelds.length > 0) return null;
  const breakdown = decomposeSixteenUnrelated(parsed.freeTiles);
  if (!breakdown) return null;

  const singleMelds: ResolvedMeld[] = breakdown.singles.map((t) => ({ tiles: [t], kind: "triplet", concealed: true }));
  const hand: ResolvedHand = { melds: singleMelds, pair: breakdown.pair, bonusTiles: parsed.bonusTiles };

  const basePattern = PATTERNS.find((p) => p.id === "base-tai")!;
  const sixteenPattern = PATTERNS.find((p) => p.id === "sixteen-unrelated")!;
  const flyingPattern = PATTERNS.find((p) => p.id === "sixteen-unrelated-flying")!;
  const flyingTai = flyingPattern.score(hand, ctx);
  const matched = [
    { pattern: basePattern, tai: basePattern.score(hand, ctx) },
    flyingTai > 0 ? { pattern: flyingPattern, tai: flyingTai } : { pattern: sixteenPattern, tai: sixteenPattern.score(hand, ctx) },
  ];

  const sameRanksPattern = PATTERNS.find((p) => p.id === "sixteen-unrelated-same-ranks")!;
  const sameRanksTai = sameRanksPattern.score(hand, ctx);
  if (sameRanksTai > 0) matched.push({ pattern: sameRanksPattern, tai: sameRanksTai });

  const straightPattern = PATTERNS.find((p) => p.id === "sixteen-unrelated-straight")!;
  const straightTai = straightPattern.score(hand, ctx);
  if (straightTai > 0) matched.push({ pattern: straightPattern, tai: straightTai });

  // 將眼: reused as-is (same id/tai/condition as the normal-hand
  // definition) - a 十六不搭 hand has one genuine designated pair
  // (`breakdown.pair`, unlike 嚦咕嚦咕's 8 pair-like groups, which needed
  // its own eightPairsMiddleTilePairCount variant), so the normal pattern's
  // plain `hand.pair[0]` check already works unmodified here.
  const middleTilePairPattern = PATTERNS.find((p) => p.id === "middle-tile-pair")!;
  const middleTilePairTai = middleTilePairPattern.score(hand, ctx);
  if (middleTilePairTai > 0) matched.push({ pattern: middleTilePairPattern, tai: middleTilePairTai });

  pushFlowerBonuses(hand, ctx, matched);
  pushSelfDrawAndGenuineSingleWait(hand, ctx, matched);
  return { total: matched.reduce((sum, m) => sum + m.tai, 0), matched, hand };
}

// 嚦咕嚦咕 (Eight Pairs / Liguligu): 8 pairs of tile kinds (16 tiles), one
// of them upgraded to a triplet by the 食胡 tile - 7*2 + 1*3 = 17 tiles. A
// kind held all 4 copies counts as two of the 8 pairs. No "ordinary meld"
// or single designated pair the way 十三么/十六不搭 have one - the display
// construction below just picks the first (lowest-sorted) pair group's
// first 2 tiles as `pair`, with everything else (including that group's
// other 2 tiles, if it was a 4-copy kind) becoming its own "meld"; the
// split is arbitrary since every 嚦咕嚦咕 hand is fully concealed anyway
// (so it's all one "Concealed" box in the UI regardless).
function scoreEightPairs(parsed: ParsedScoringHand, ctx: GameContext): ScoreResult | null {
  if (parsed.declaredMelds.length > 0) return null;
  const breakdown = decomposeEightPairs(parsed.freeTiles);
  if (!breakdown) return null;

  // A quad (4 copies, counting as 2 of the 8 pairs) must stay together as
  // one 4-tile group - picking whichever pair group happens to be a
  // genuine 2-tile pair for `pair` instead of always taking the first one,
  // since the first (lowest-sorted) group could itself be a quad. At least
  // one genuine 2-tile pair always exists: 7 pair-slots can hold at most 3
  // quads (6 slots), leaving at least 1 as a real pair.
  const pairIndex = breakdown.pairs.findIndex((g) => g.length === 2);
  const pair = breakdown.pairs[pairIndex];
  const meldGroups = breakdown.pairs.filter((_, i) => i !== pairIndex);
  const groupMelds: ResolvedMeld[] = [
    { tiles: breakdown.triple, kind: "triplet", concealed: true },
    ...meldGroups.map((g): ResolvedMeld => ({ tiles: g, kind: "triplet", concealed: true })),
  ];
  const hand: ResolvedHand = { melds: groupMelds, pair, bonusTiles: parsed.bonusTiles };

  const basePattern = PATTERNS.find((p) => p.id === "base-tai")!;
  const eightPairsPattern = PATTERNS.find((p) => p.id === "eight-pairs")!;
  const flyingPattern = PATTERNS.find((p) => p.id === "eight-pairs-flying")!;
  const flyingTai = flyingPattern.score(hand, ctx);
  const matched = [
    { pattern: basePattern, tai: basePattern.score(hand, ctx) },
    flyingTai > 0 ? { pattern: flyingPattern, tai: flyingTai } : { pattern: eightPairsPattern, tai: eightPairsPattern.score(hand, ctx) },
  ];

  // 明/暗四歸: a 嚦咕嚦咕 hand can hold several independent quads at once
  // (see eightPairsQuadKinds), so both patterns can genuinely fire
  // together here (some quads open, others hidden) - each one's own
  // score() sums across every quad it applies to.
  for (const id of ["orphans-four-return-open", "orphans-four-return-hidden"]) {
    const pattern = PATTERNS.find((p) => p.id === id)!;
    const tai = pattern.score(hand, ctx);
    if (tai > 0) matched.push({ pattern, tai });
  }

  const smallFiveSuitsTai = eightPairsSmallFiveSuitsTai(hand);
  const smallSevenSuitsTai = eightPairsSmallSevenSuitsTai(hand);
  if (smallSevenSuitsTai > 0) {
    matched.push({ pattern: PATTERNS.find((p) => p.id === "small-seven-suits")!, tai: smallSevenSuitsTai });
  } else if (smallFiveSuitsTai > 0) {
    matched.push({ pattern: PATTERNS.find((p) => p.id === "small-five-suits")!, tai: smallFiveSuitsTai });
  }

  // 斷么/缺一門/清老頭/混老頭/混一色/清一色/字一色/無花/正花/爛花/無字/無字花:
  // reused as-is (same ids/tai as their normal-hand definitions), since
  // every one of these conditions is either purely about the flat tile
  // multiset/bonus tiles already, or - for 清老頭/混老頭's "every meld is a
  // triplet/kong" half - trivially true here regardless (every group in
  // this hand's construction is tagged "triplet" no matter its actual tile
  // count). 無花/正花/爛花/無字/無字花 are lumped into this same batch
  // (rather than the separate pushFlowerBonuses helper 十三么/十六不搭 use)
  // specifically so 無字花's exclusion of 無花/無字 is actually honored -
  // those two special hands always include all 7 honors by definition, so
  // 無字/無字花 can never fire there and the cross-exclusion doesn't matter,
  // but 嚦咕嚦咕 can genuinely go honor-free. Their own excludes metadata
  // (e.g. 清一色 excluding 混一色, 無字花 excluding 無花/無字) is applied
  // the same way the normal per-decomposition loop does, scoped to just
  // this batch.
  const reusableIds = [
    "all-simples",
    "no-fives",
    "greater-than-five",
    "less-than-five",
    "missing-one-suit",
    "pure-terminal-triplets",
    "mixed-terminal-honor-triplets",
    "half-flush",
    "full-flush",
    "all-honors",
    "three-treasures",
    "no-flowers",
    "correct-flower",
    "wrong-flower",
    "no-honors",
    "no-honors-no-flowers",
  ];
  const reusableScored = PATTERNS.filter((p) => reusableIds.includes(p.id))
    .map((pattern) => ({ pattern, tai: pattern.score(hand, ctx) }))
    .filter((m) => m.tai > 0);
  const reusableExcluded = new Set(reusableScored.flatMap((m) => m.pattern.excludes ?? []));
  matched.push(...reusableScored.filter((m) => !reusableExcluded.has(m.pattern.id)));

  const middleTilePairCount = eightPairsMiddleTilePairCount(hand);
  if (middleTilePairCount > 0) {
    matched.push({ pattern: PATTERNS.find((p) => p.id === "middle-tile-pair")!, tai: middleTilePairCount * 2 });
  }

  // 三元嚦咕/三風嚦咕/四喜嚦咕: eight-pairs-only bonuses, same raw-score +
  // exclude-cascade approach as the reusable batch above, just kept
  // separate since these ids don't exist as normal-hand patterns at all.
  const honorBonusIds = ["eight-pairs-three-dragons", "eight-pairs-three-winds", "eight-pairs-four-winds"];
  const honorBonusScored = PATTERNS.filter((p) => honorBonusIds.includes(p.id))
    .map((pattern) => ({ pattern, tai: pattern.score(hand, ctx) }))
    .filter((m) => m.tai > 0);
  const honorBonusExcluded = new Set(honorBonusScored.flatMap((m) => m.pattern.excludes ?? []));
  matched.push(...honorBonusScored.filter((m) => !honorBonusExcluded.has(m.pattern.id)));

  pushSelfDrawAndGenuineSingleWait(hand, ctx, matched, isEightPairsFakeSingleWait);
  return { total: matched.reduce((sum, m) => sum + m.tai, 0), matched, hand };
}

// Patterns whose condition depends only on the flat tile multiset (via
// allHandTiles), not on which meld structure produced it - meaningful only
// through their own scoreThirteenOrphans/scoreSixteenUnrelated/
// scoreEightPairs construction, never as a generic entry in the normal
// per-decomposition PATTERNS loop (see the comment where this is used).
const SPECIAL_HAND_ONLY_PATTERN_IDS = new Set([
  "thirteen-orphans",
  "orphans-four-return-open",
  "orphans-four-return-hidden",
  "sixteen-unrelated",
  "sixteen-unrelated-flying",
  "sixteen-unrelated-same-ranks",
  "sixteen-unrelated-straight",
  "eight-pairs",
  "eight-pairs-flying",
  "eight-pairs-three-dragons",
  "eight-pairs-three-winds",
  "eight-pairs-four-winds",
]);

export function scoreParsedHand(parsed: ParsedScoringHand, ctx: GameContext): ScoreResult {
  // Special-hand readings and the normal melds+pair reading aren't always
  // mutually exclusive at the tile-count level - e.g. 123m123m123m123m
  // (four identical runs) also happens to satisfy 嚦咕嚦咕's per-kind-count
  // check (1m/2m/3m at 4 copies each). Both are collected as candidates
  // rather than the first successful one short-circuiting, so the usual
  // "max tai across every valid reading" rule still picks whichever
  // actually scores higher (三/四同順 well outscores 嚦咕嚦咕 there).
  const candidates: ScoreResult[] = [];
  const orphans = scoreThirteenOrphans(parsed, ctx);
  if (orphans) candidates.push(orphans);
  const sixteenUnrelated = scoreSixteenUnrelated(parsed, ctx);
  if (sixteenUnrelated) candidates.push(sixteenUnrelated);
  const eightPairs = scoreEightPairs(parsed, ctx);
  if (eightPairs) candidates.push(eightPairs);

  const meldsNeeded = MELDS_REQUIRED - parsed.declaredMelds.length;
  // Each free meld is 3 tiles (triplet/run) or 4 (a concealed kong
  // decomposeHandAll's search might find) - since which one isn't known
  // until decomposition is attempted, completeness is a range here rather
  // than a single expected size, bounded by "none of the free melds are
  // kongs" and "all of them are."
  const minFreeSize = meldsNeeded * 3 + 2;
  const maxFreeSize = meldsNeeded * 4 + 2;
  const sizeOk = meldsNeeded >= 0 && parsed.freeTiles.length >= minFreeSize && parsed.freeTiles.length <= maxFreeSize;

  const normalCandidates: ScoreResult[] = [];
  if (sizeOk) {
    const declaredResolved: ResolvedMeld[] = parsed.declaredMelds.map((m) => ({ ...m }));
    for (const free of decomposeHandAll(parsed.freeTiles, meldsNeeded)) {
      const hand: ResolvedHand = { melds: [...declaredResolved, ...free.melds], pair: free.pair, bonusTiles: parsed.bonusTiles };
      // Skip the special-hand-only patterns here: their conditions read
      // only the flat tile multiset (allHandTiles), not meld structure, so
      // they'd otherwise fire on a normal decomposition whenever the same
      // 17 tiles also happen to satisfy that shape (e.g. 123m123m123m123m,
      // 4 identical runs, also passes 嚦咕嚦咕's per-kind-count check) -
      // stacking a reading it isn't actually being scored under. They're
      // only meaningful via their own scoreXxx short-circuit, which builds
      // the dedicated hand construction for that shape.
      const scored = PATTERNS.filter((p) => !SPECIAL_HAND_ONLY_PATTERN_IDS.has(p.id))
        .map((pattern) => ({ pattern, tai: pattern.score(hand, ctx) }))
        .filter((m) => m.tai > 0);
      const excludedIds = new Set(scored.flatMap((m) => m.pattern.excludes ?? []));
      const matched = scored.filter((m) => !excludedIds.has(m.pattern.id));
      normalCandidates.push({ total: matched.reduce((sum, m) => sum + m.tai, 0), matched, hand });
    }
  }
  candidates.push(...normalCandidates);

  // 嚦咕雙食: the same 17 tiles are validly *both* 嚦咕嚦咕 and an ordinary
  // melds+pair hand (e.g. 112233m667788t777z55z - three identical-run
  // pairs read as either 3 pairs of runs, or 2 runs each - see the user's
  // own example). When that happens, both readings are scored and shown
  // together, with `total` as their sum - always at least as good as
  // either alone, so it naturally wins the max-tai comparison below
  // without needing special-casing there.
  if (eightPairs && normalCandidates.length > 0) {
    const bestNormal = normalCandidates.reduce((best, c) => (c.total > best.total ? c : best));
    candidates.push({
      total: eightPairs.total + bestNormal.total,
      matched: eightPairs.matched,
      hand: eightPairs.hand,
      second: { matched: bestNormal.matched, hand: bestNormal.hand },
    });
  }

  if (candidates.length === 0) {
    if (!sizeOk) {
      const totalTiles = parsed.freeTiles.length + parsed.declaredMelds.reduce((n, m) => n + m.tiles.length, 0);
      throw new ScoringError(`Hand isn't complete: got ${totalTiles} tiles, expected 17 plus 1 per kong (declared or concealed)`);
    }
    throw new ScoringError("Hand isn't a valid complete hand (couldn't decompose into melds and a pair)");
  }

  return candidates.reduce((best, c) => (c.total > best.total ? c : best));
}

// Parses notation text, then scores it - see scoreParsedHand.
export function scoreHand(input: string, ctx: GameContext): ScoreResult {
  return scoreParsedHand(parseScoringHand(input), ctx);
}
