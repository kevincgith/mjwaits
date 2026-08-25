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

import { MELDS_REQUIRED, ParseError, tileKey, tileLabel, type Suit, type Tile } from "./mahjong";

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
  melds: ResolvedMeld[]; // exactly MELDS_REQUIRED (5)
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

export interface GameContext {
  seatWind: Wind;
  roundWind: Wind;
  selfDraw: boolean;
  // The 食胡 tile - whichever tile kind completed the hand. Only its
  // suit/rank matter (not which physical copy), since every copy of a kind
  // is interchangeable for scoring purposes. null means unspecified - see
  // isMeldOpen for how that's treated.
  winningTile: Tile | null;
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
  const isMissingOneSuit = numberedSuitsUsed(hand).size === 2 && !isHonorTile(hand.pair[0]);
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

// Given the meld lists for three segments that must combine 1-to-1 into a
// straight, returns one meld-triple per instance. When a segment has more
// copies than another, the extra copies each form their own instance,
// reusing whichever segment(s) only have a single copy - see the 清龍/雜龍
// worked examples this was derived from (123m456m789m789m -> 2 instances,
// one pairing each 789m with the shared 123m/456m). Empty if any segment is
// missing entirely (no straight at all).
function combineSegments(segA: ResolvedMeld[], segB: ResolvedMeld[], segC: ResolvedMeld[]): ResolvedMeld[][] {
  if (segA.length === 0 || segB.length === 0 || segC.length === 0) return [];
  const instances = Math.max(segA.length, segB.length, segC.length);
  const result: ResolvedMeld[][] = [];
  for (let i = 0; i < instances; i++) {
    result.push([segA[Math.min(i, segA.length - 1)], segB[Math.min(i, segB.length - 1)], segC[Math.min(i, segC.length - 1)]]);
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
// instead). No 明/暗 split, but still stacks the same "extra copies each
// form their own instance, reusing the single-copy segment" way 清龍/雜龍 do
// (see combineSegments) - just with 2 segments instead of 3.
function oldYoungRunInstances(hand: ResolvedHand): number {
  let total = 0;
  for (const suit of ["m", "t", "b"] as const) {
    if (segmentMelds(hand, suit, 4).length > 0) continue;
    const ones = segmentMelds(hand, suit, 1);
    const nines = segmentMelds(hand, suit, 7);
    if (ones.length === 0 || nines.length === 0) continue;
    total += Math.max(ones.length, nines.length);
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
// nothing to unify around and shouldn't vacuously qualify.
// Shared by 混帶X/XY/XYZ: the pair must also be one of the shared ranks
// (it can only ever match one of them, being a single rank itself), *or*
// the pair is honors and exempt the same way honor melds are.
function pairMatchesOrIsHonor(hand: ResolvedHand, ranks: number[]): boolean {
  return isHonorTile(hand.pair[0]) || ranks.includes(hand.pair[0].rank);
}

function hasCommonRankAcrossNonHonorMelds(hand: ResolvedHand): boolean {
  const nonHonorMelds = hand.melds.filter((m) => m.tiles[0].suit !== "z");
  if (nonHonorMelds.length === 0) return false;
  for (let rank = 1; rank <= 9; rank++) {
    if (nonHonorMelds.every((m) => m.tiles.some((t) => t.rank === rank)) && pairMatchesOrIsHonor(hand, [rank])) return true;
  }
  return false;
}

// 混帶XY: same idea as 混帶X, but every non-honor meld must contain BOTH of
// some pair of distinct ranks (not just one shared rank).
function hasCommonRankPairAcrossNonHonorMelds(hand: ResolvedHand): boolean {
  const nonHonorMelds = hand.melds.filter((m) => m.tiles[0].suit !== "z");
  if (nonHonorMelds.length === 0) return false;
  for (let x = 1; x <= 9; x++) {
    for (let y = x + 1; y <= 9; y++) {
      if (
        nonHonorMelds.every((m) => m.tiles.some((t) => t.rank === x) && m.tiles.some((t) => t.rank === y)) &&
        pairMatchesOrIsHonor(hand, [x, y])
      ) {
        return true;
      }
    }
  }
  return false;
}

// 混帶XYZ: same idea again, but every non-honor meld must contain all 3 of
// some triple of distinct ranks - a run always has exactly 3 distinct
// ranks, so a hand with only a single non-honor meld (the rest all honor
// melds) still trivially qualifies using that meld's own 3 ranks; a lone
// triplet/kong (only 1 distinct rank) never can, on its own or otherwise.
function hasCommonRankTripleAcrossNonHonorMelds(hand: ResolvedHand): boolean {
  const nonHonorMelds = hand.melds.filter((m) => m.tiles[0].suit !== "z");
  if (nonHonorMelds.length === 0) return false;
  for (let x = 1; x <= 9; x++) {
    for (let y = x + 1; y <= 9; y++) {
      for (let z = y + 1; z <= 9; z++) {
        if (
          nonHonorMelds.every(
            (m) => m.tiles.some((t) => t.rank === x) && m.tiles.some((t) => t.rank === y) && m.tiles.some((t) => t.rank === z)
          ) &&
          pairMatchesOrIsHonor(hand, [x, y, z])
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

// 混帶么: the hand has an honor presence (an honor meld, or the pair itself
// is honors) AND every non-honor meld contains a terminal (rank 1 or 9).
// Requires at least one non-honor meld to exist - an all-honor hand has no
// terminal number melds to speak of, so it shouldn't vacuously qualify
// (same reasoning as 混帶X's guard).
function hasHonorMeldOrHonorPair(hand: ResolvedHand): boolean {
  return hand.melds.some((m) => m.tiles[0].suit === "z") || isHonorTile(hand.pair[0]);
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
// freely.
function isAllTerminalOrHonorTriplets(hand: ResolvedHand): boolean {
  return (
    hand.melds.every((m) => m.kind === "triplet" || m.kind === "kong") &&
    allHandTiles(hand).every((t) => isHonorTile(t) || t.rank === 1 || t.rank === 9)
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
// At most one instance possible - needs 4 of the hand's 5 melds.
function fourReturnsToFourRuns(hand: ResolvedHand): ResolvedMeld[] | null {
  for (const suit of ["m", "t", "b"] as const) {
    for (let rank = 1; rank <= 9; rank++) {
      const runs = hand.melds.filter((m) => m.kind === "run" && m.tiles[0].suit === suit && m.tiles.some((t) => t.rank === rank));
      if (runs.length === 4) return runs;
    }
  }
  return null;
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
// e.g. 123123m + 678678t. Reuses identicalRunPairInstances and just checks
// there are at least 2 of them; classification looks at all 4 runs across
// the first two instances found.
function twoSeparateIdenticalRunPairs(hand: ResolvedHand): [ResolvedMeld, ResolvedMeld, ResolvedMeld, ResolvedMeld] | null {
  const instances = identicalRunPairInstances(hand);
  if (instances.length < 2) return null;
  const [[a, b], [c, d]] = instances;
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
// ranks later and a run can start no later than 7.
function threeColorStepUpRunMelds(hand: ResolvedHand): ResolvedMeld[] | null {
  for (let rank = 1; rank <= 5; rank++) {
    for (const suits of THREE_SUIT_ORDERS) {
      const melds = suits.map((suit, i) => segmentMelds(hand, suit, rank + i)[0]);
      if (melds.every((m): m is ResolvedMeld => m !== undefined)) return melds;
    }
  }
  return null;
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
function hasSmallThreeConsecutiveTriplets(hand: ResolvedHand): boolean {
  const pair = hand.pair[0];
  if (pair.suit === "z") return false;
  const windows = [
    [pair.rank, pair.rank + 1, pair.rank + 2],
    [pair.rank - 1, pair.rank, pair.rank + 1],
    [pair.rank - 2, pair.rank - 1, pair.rank],
  ];
  for (const window of windows) {
    if (window[0] < 1 || window[2] > 9) continue;
    const others = window.filter((r) => r !== pair.rank);
    if (others.length === 2 && others.every((r) => isTripletOrKongAt(hand, pair.suit, r))) return true;
  }
  return false;
}
function hasBigThreeConsecutiveTriplets(hand: ResolvedHand): boolean {
  for (const suit of ["m", "t", "b"] as const) {
    for (let rank = 1; rank <= 7; rank++) {
      if ([rank, rank + 1, rank + 2].every((r) => isTripletOrKongAt(hand, suit, r))) return true;
    }
  }
  return false;
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
    id: "concealed-hand",
    name: "門清 (Concealed hand)",
    // Placeholder value from the initial foundation work, not yet confirmed
    // against the user's own house rules.
    score: (hand) => (hand.melds.every((m) => m.concealed) ? 1 : 0),
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
    // The pair can't be honors: an honor pair means the hand isn't actually
    // "2 suits, eyes included" - it's 2 suits in the melds with the eyes
    // sitting outside that shape entirely, which doesn't count.
    score: (hand) => (numberedSuitsUsed(hand).size === 2 && !isHonorTile(hand.pair[0]) ? 10 : 0),
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
    // Compound pattern - absorbs its 3 constituent conditions, same
    // precedent as 無字花大平胡 absorbing 平胡+無字花.
    score: (hand) => (hasThreeTreasures(hand) ? 40 : 0),
    excludes: ["no-fives", "greater-than-five", "less-than-five", "all-simples", "full-flush", "missing-one-suit"],
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
    score: (hand) => (hasHonorMeldOrHonorPair(hand) && everyNonHonorMeldHasTerminal(hand) ? 40 : 0),
  },
  {
    id: "pure-terminal",
    name: "全帶么 (No honors, terminal in every meld and the pair)",
    score: (hand) => (hasNoHonorsAndTerminalInEveryMeldAndPair(hand) ? 80 : 0),
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
    score: (hand, ctx) => {
      const runs = fourReturnsToFourRuns(hand);
      return runs && runs.some((r) => isMeldOpen(r, ctx)) ? 30 : 0;
    },
  },
  {
    id: "four-returns-to-four-hidden",
    name: "暗四歸四 (4 runs, concealed)",
    score: (hand, ctx) => {
      const runs = fourReturnsToFourRuns(hand);
      return runs && runs.every((r) => !isMeldOpen(r, ctx)) ? 60 : 0;
    },
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
    score: (hand) => (hasSmallThreeConsecutiveTriplets(hand) ? 15 : 0),
  },
  {
    id: "big-three-consecutive-triplets",
    name: "大三連刻 (3 consecutive triplets/kongs)",
    score: (hand) => (hasBigThreeConsecutiveTriplets(hand) ? 30 : 0),
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
    // Additional bonus, same "stacks with everything" framing as 雙姊妹.
    score: (hand) => (hasFullCrossSuitRuns(hand) ? 20 : 0),
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
    // Additional bonus, same "stacks with everything" framing as the other
    // 相逢-family bonuses - doesn't exclude 樓梯 even though every
    // 五步高/全碟 hand is also a 樓梯 (not explicitly stated either way,
    // kept consistent with 樓梯/雙姊妹/全姊妹 all being additive).
    score: (hand) => (hasRotatingStaircase(hand) ? 40 : 0),
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
    score: (hand, ctx) => {
      const melds = threeColorStepUpRunMelds(hand);
      return melds && melds.some((m) => isMeldOpen(m, ctx)) ? 5 : 0;
    },
  },
  {
    id: "three-color-step-up-hidden",
    name: "暗三色步步高 (3 suits, runs increasing by 1, concealed)",
    score: (hand, ctx) => {
      const melds = threeColorStepUpRunMelds(hand);
      return melds && melds.every((m) => !isMeldOpen(m, ctx)) ? 10 : 0;
    },
  },
];

export interface ScoreResult {
  total: number;
  matched: { pattern: TaiPattern; tai: number }[];
  hand: ResolvedHand;
}

export class ScoringError extends Error {}

// Validates completeness (kong-aware: a complete hand is 17 + total kong
// count tiles) and scores an already-parsed/already-structured hand against
// `ctx`, picking the decomposition with the highest total tai (see the
// module doc comment on why the max over all valid readings is the correct
// score). Split out from scoreHand so UI that already holds the hand as
// structured state (declared melds built via a tap picker, not typed
// notation) can score directly without a round trip through notation text.
export function scoreParsedHand(parsed: ParsedScoringHand, ctx: GameContext): ScoreResult {
  const meldsNeeded = MELDS_REQUIRED - parsed.declaredMelds.length;
  // Each free meld is 3 tiles (triplet/run) or 4 (a concealed kong
  // decomposeHandAll's search might find) - since which one isn't known
  // until decomposition is attempted, completeness is a range here rather
  // than a single expected size, bounded by "none of the free melds are
  // kongs" and "all of them are."
  const minFreeSize = meldsNeeded * 3 + 2;
  const maxFreeSize = meldsNeeded * 4 + 2;

  if (meldsNeeded < 0 || parsed.freeTiles.length < minFreeSize || parsed.freeTiles.length > maxFreeSize) {
    const totalTiles = parsed.freeTiles.length + parsed.declaredMelds.reduce((n, m) => n + m.tiles.length, 0);
    throw new ScoringError(`Hand isn't complete: got ${totalTiles} tiles, expected 17 plus 1 per kong (declared or concealed)`);
  }

  const declaredResolved: ResolvedMeld[] = parsed.declaredMelds.map((m) => ({ ...m }));
  const freeDecompositions = decomposeHandAll(parsed.freeTiles, meldsNeeded);
  if (freeDecompositions.length === 0) {
    throw new ScoringError("Hand isn't a valid complete hand (couldn't decompose into melds and a pair)");
  }

  let best: ScoreResult | null = null;
  for (const free of freeDecompositions) {
    const hand: ResolvedHand = { melds: [...declaredResolved, ...free.melds], pair: free.pair, bonusTiles: parsed.bonusTiles };
    const scored = PATTERNS.map((pattern) => ({ pattern, tai: pattern.score(hand, ctx) })).filter((m) => m.tai > 0);
    const excludedIds = new Set(scored.flatMap((m) => m.pattern.excludes ?? []));
    const matched = scored.filter((m) => !excludedIds.has(m.pattern.id));
    const total = matched.reduce((sum, m) => sum + m.tai, 0);
    if (!best || total > best.total) best = { total, matched, hand };
  }

  return best!;
}

// Parses notation text, then scores it - see scoreParsedHand.
export function scoreHand(input: string, ctx: GameContext): ScoreResult {
  return scoreParsedHand(parseScoringHand(input), ctx);
}
