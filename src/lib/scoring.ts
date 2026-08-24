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
  // Melds fixed by the notation: exposed triplets/runs/kongs (written in
  // parens) and concealed kongs (a bare 4-of-a-kind - see parseScoringHand).
  declaredMelds: MeldDeclaration[];
  // Everything else: ordinary concealed tiles still to be decomposed into
  // melds + the pair (the pair is always concealed - it can't be called).
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
// run, or kong) and a bare 4-of-a-kind for a concealed kong - see the module
// doc comment and README for the full syntax. Jokers aren't supported yet
// (rejected with a clear error rather than silently scored wrong).
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

  // Any rank held 4 times among the free (undeclared) tiles unambiguously
  // means a concealed kong - a natural hand can only ever hold all 4 copies
  // of one kind by forming a kong, since the declared-meld syntax above is
  // the only other way a 4th copy could appear.
  const bySuitRank = new Map<string, Tile[]>();
  for (const t of freeTiles) {
    const key = tileKey(t);
    const list = bySuitRank.get(key) ?? [];
    list.push(t);
    bySuitRank.set(key, list);
  }
  const remainingFree: Tile[] = [];
  for (const tiles of bySuitRank.values()) {
    if (tiles.length === 4) {
      declaredMelds.push({ tiles, kind: "kong", concealed: true });
    } else {
      remainingFree.push(...tiles);
    }
  }

  // 4-copies-per-kind cap, counted across declared melds and free tiles
  // together (a kong already spends all 4 copies of its kind).
  const totalCounts = new Map<string, number>();
  for (const meld of declaredMelds) for (const t of meld.tiles) totalCounts.set(tileKey(t), (totalCounts.get(tileKey(t)) ?? 0) + 1);
  for (const t of remainingFree) totalCounts.set(tileKey(t), (totalCounts.get(tileKey(t)) ?? 0) + 1);
  for (const [key, count] of totalCounts) {
    if (count > 4) {
      const suit = key[0] as Suit;
      const rank = Number(key.slice(1));
      throw new ParseError(`Too many copies of ${tileLabel({ suit, rank })} (max 4)`);
    }
  }

  return { declaredMelds, freeTiles: remainingFree, bonusTiles: [] };
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
// into triplets and, for numbered suits, runs. Unlike mahjong.ts's
// canDecompose/decomposeSuitGroups (which stop at the first success),
// this collects every successful branch - the same hand shape can
// legitimately be read multiple ways (e.g. 111222333m as three triplets or
// three runs), and scoring needs to consider all of them.
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

const SINGLE_WIND_PATTERN_IDS = ["wrong-seat-wind", "correct-seat-wind", "wrong-round-wind", "correct-round-wind"];

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

// House tai list, added one pattern at a time as the user supplies them -
// see the module doc comment on why this stays a plain array of concrete
// checks rather than a generic rule engine.
export const PATTERNS: TaiPattern[] = [
  {
    id: "concealed-hand",
    name: "門清 (Concealed hand)",
    // Placeholder value from the initial foundation work, not yet confirmed
    // against the user's own house rules.
    score: (hand) => (hand.melds.every((m) => m.concealed) ? 1 : 0),
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
    id: "no-honors-no-flowers",
    name: "無字花 (No honors, no flowers)",
    score: (hand) => (isNoHonorsNoFlowers(hand) ? 10 : 0),
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
    id: "wrong-round-wind",
    name: "爛圈風 (Wind meld not matching round wind)",
    score: (hand, ctx) => (windMeldRanks(hand).some((r) => r !== ctx.roundWind) ? 2 : 0),
  },
  {
    id: "correct-round-wind",
    name: "正圈風 (Wind meld matching round wind)",
    score: (hand, ctx) => (windMeldRanks(hand).some((r) => r === ctx.roundWind) ? 2 : 0),
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
    score: (hand) => (numberedSuitsUsed(hand).size === 2 ? 10 : 0),
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
];

export interface ScoreResult {
  total: number;
  matched: { pattern: TaiPattern; tai: number }[];
  hand: ResolvedHand;
}

export class ScoringError extends Error {}

// Validates completeness (kong-aware: a complete hand is
// 17 + declaredKongCount tiles) and scores an already-parsed/already-
// structured hand against `ctx`, picking the decomposition with the highest
// total tai (see the module doc comment on why the max over all valid
// readings is the correct score). Split out from scoreHand so UI that
// already holds the hand as structured state (declared melds built via a
// tap picker, not typed notation) can score directly without a round trip
// through notation text.
export function scoreParsedHand(parsed: ParsedScoringHand, ctx: GameContext): ScoreResult {
  const meldsNeeded = MELDS_REQUIRED - parsed.declaredMelds.length;
  const expectedFreeSize = meldsNeeded * 3 + 2;

  if (meldsNeeded < 0 || parsed.freeTiles.length !== expectedFreeSize) {
    const kongCount = parsed.declaredMelds.filter((m) => m.kind === "kong").length;
    const totalTiles = parsed.freeTiles.length + parsed.declaredMelds.reduce((n, m) => n + m.tiles.length, 0);
    throw new ScoringError(
      `Hand isn't complete: expected ${MELDS_REQUIRED * 3 + 2 + kongCount} tiles (17, plus 1 per declared kong), got ${totalTiles}`
    );
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
