// One seat's view of a hand: everything that seat may see, and nothing more.
//
// The multiplayer server holds the whole GameState - the wall and all four
// hands - and sends each player only viewFor(state, theirSeat): their own
// tiles, and of everyone else what's face up on the table (melds, flowers,
// ponds, 叮). Other hands are a count; the wall is a count; another player's
// concealed kong lies face down. Once the hand is over every hand is shown,
// as at a real table. view.test.ts checks that a view doesn't change when
// everything the seat can't see is shuffled.

import type { Tile } from "./mahjong";
import { DEAD_WALL_SIZE, liveTilesLeft, type Chain, type GameMeld, type GameState, type HandResult, type Player, type TableBonus } from "./game";
import { patternDisplayName, type ScoreResult } from "./scoring";

// A meld as another seat sees it: a concealed kong is four face-down tiles.
export type MeldView = GameMeld | { kind: "kong"; concealed: true; hidden: true; from: null };

export interface SeatView {
  // The tiles in hand: this seat's own, or everyone's once the hand is over;
  // otherwise null - only `handCount` is known.
  hand: Tile[] | null;
  handCount: number;
  melds: MeldView[];
  flowers: Player["flowers"];
  discards: Tile[];
  riichi?: Player["riichi"]; // `passed` your own only (it tells you held a win)
  overWater?: boolean; // your own only, likewise
  played?: true; // past its first turn (地叮 / 人胡)
  passedPung?: Tile; // your own only (it tells what you hold)
  threw?: Tile; // your own only: the last throw, barring a claim back of it
}

// A finished hand's result as it travels: the score as its total and the
// patterns by name - ScoreResult itself holds the pattern definitions,
// functions and all.
export interface ScoreView {
  total: number;
  patterns: { id: string; name: string; tai: number }[];
}
export type ResultView = Omit<HandResult, "score" | "alsoWon"> & {
  score: ScoreView | null;
  alsoWon?: { winner: number; score: ScoreView | null; scoreError: string | null }[];
};

export function scoreView(score: ScoreResult): ScoreView {
  const named = (matched: ScoreResult["matched"], hand: ScoreResult["hand"]) =>
    matched.map(({ pattern, tai }) => ({ id: pattern.id, name: patternDisplayName(pattern, hand), tai }));
  return { total: score.total, patterns: [...named(score.matched, score.hand), ...(score.second ? named(score.second.matched, score.second.hand) : [])] };
}

export type PhaseView =
  // `drawn` and `forbidden` only for the seat whose turn it is; `drew` for
  // everyone - that they're holding a tile just drawn (not which: whether a
  // player drew or called is seen by all), so it can stand apart.
  // `chain` (the kongs and bonus tiles replaced this turn) for everyone: all were seen.
  | { kind: "turn"; seat: number; drawn: Tile | null; drew?: true; replacement: "flower" | "kong" | null; forbidden?: Tile[]; chain?: Chain }
  | { kind: "claims"; from: number; tile: Tile; robKong?: true } // robKong: a kong shown for 搶槓, not a discard
  // 換牌: every pile laid face down - your own you see, the others' only as
  // backs ("back"); a place taken, empty (null); and who took each.
  | {
      kind: "swap";
      dice: [number, number];
      rounds: number;
      count: number;
      round: number;
      stage: "give" | "take";
      piles: ((Tile | "back" | null)[] | null)[];
      taker: number;
      took: number[];
      takenBy?: (number | null)[][];
    }
  | { kind: "over"; result: ResultView };

export interface TableView {
  you: number;
  players: SeatView[];
  wallLeft: number; // live tiles left to draw
  deadWall: number;
  dealer: number;
  roundWind: GameState["roundWind"];
  dealerStreak: number;
  firstDealer: number;
  phase: PhaseView;
  firstGoAround: boolean;
  discardsMade: number;
  lahs: NonNullable<GameState["lahs"]>;
  multiWin: boolean;
  dice?: GameState["dice"];
  diceBonus?: GameState["diceBonus"];
  tableBonuses: TableBonus[];
  chase?: GameState["chase"];
}

const copyTiles = (tiles: Tile[]) => tiles.map((t) => ({ suit: t.suit, rank: t.rank }));

// `shown`: at a hand's end, whose hands everyone sees - all of them unless
// the table keeps losing hands hidden (then the winners', and whoever
// chose to show). You always see your own.
// A concealed kong (暗槓) stays face down to the others till the hand's
// over - then it's shown with the rest of that player's hand (a hand kept
// hidden keeps it hidden too).
export function viewFor(s: GameState, you: number, shown: (seat: number) => boolean = () => true): TableView {
  const over = s.phase.kind === "over";
  const players: SeatView[] = s.players.map((p, seat) => {
    const open = seat === you || (over && shown(seat));
    return {
      hand: open ? copyTiles(p.hand) : null,
      handCount: p.hand.length,
      melds: p.melds.map((m): MeldView => (m.kind === "kong" && m.concealed && !open ? { kind: "kong", concealed: true, hidden: true, from: null } : { ...m, tiles: copyTiles(m.tiles) })),
      flowers: p.flowers.map((f) => ({ ...f })),
      discards: copyTiles(p.discards),
      // A passed-up win says the hand was ready: only to whoever sees the hand.
      ...(p.riichi ? { riichi: open ? { ...p.riichi } : { state: p.riichi.state, discard: p.riichi.discard, ippatsu: p.riichi.ippatsu } } : {}),
      ...(open && p.overWater ? { overWater: true } : {}),
      ...(p.played ? { played: true as const } : {}),
      ...(seat === you && p.passedPung ? { passedPung: { ...p.passedPung } } : {}),
      ...(seat === you && p.threw ? { threw: { ...p.threw } } : {}),
    };
  });
  let phase: PhaseView;
  if (s.phase.kind === "turn") {
    const mine = s.phase.seat === you;
    phase = {
      kind: "turn",
      seat: s.phase.seat,
      drawn: mine && s.phase.drawn ? { ...s.phase.drawn } : null,
      ...(s.phase.drawn ? { drew: true as const } : {}),
      replacement: s.phase.replacement,
      ...(mine && s.phase.forbidden ? { forbidden: copyTiles(s.phase.forbidden) } : {}),
      ...(s.phase.chain ? { chain: { ...s.phase.chain } } : {}),
    };
  } else if (s.phase.kind === "claims") {
    phase = { kind: "claims", from: s.phase.from, tile: { ...s.phase.tile }, ...(s.phase.robKong ? { robKong: true as const } : {}) };
  } else if (s.phase.kind === "swap") {
    const ph = s.phase;
    phase = {
      kind: "swap",
      dice: [...ph.dice] as [number, number],
      rounds: ph.rounds,
      count: ph.count,
      round: ph.round,
      stage: ph.stage,
      piles: ph.piles.map((pile, seat) => (pile ? pile.map((t) => (!t ? null : seat === you ? { suit: t.suit, rank: t.rank } : "back")) : null)),
      taker: ph.taker,
      took: [...ph.took],
      ...(ph.takenBy ? { takenBy: ph.takenBy.map((row) => [...row]) } : {}),
    };
  } else {
    const { score, alsoWon, ...rest } = s.phase.result;
    phase = {
      kind: "over",
      result: {
        ...structuredClone(rest),
        score: score ? scoreView(score) : null,
        ...(alsoWon ? { alsoWon: alsoWon.map((w) => ({ winner: w.winner, score: w.score ? scoreView(w.score) : null, scoreError: w.scoreError })) } : {}),
      },
    };
  }
  return {
    you,
    players,
    wallLeft: liveTilesLeft(s),
    deadWall: Math.min(DEAD_WALL_SIZE, s.wall.length),
    dealer: s.dealer,
    roundWind: s.roundWind,
    dealerStreak: s.dealerStreak,
    firstDealer: s.firstDealer ?? 0,
    phase,
    firstGoAround: s.firstGoAround,
    discardsMade: s.discardsMade,
    lahs: structuredClone(s.lahs ?? []),
    multiWin: !!s.multiWin,
    ...(s.dice ? { dice: [...s.dice] as GameState["dice"] } : {}),
    ...(s.diceBonus ? { diceBonus: structuredClone(s.diceBonus) } : {}),
    tableBonuses: structuredClone(s.tableBonuses ?? []),
    ...(s.chase ? { chase: structuredClone(s.chase) } : {}),
  };
}
