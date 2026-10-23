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
import { DEAD_WALL_SIZE, liveTilesLeft, type GameMeld, type GameState, type HandResult, type Player, type TableBonus } from "./game";
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
  riichi?: Player["riichi"];
}

// A finished hand's result as it travels: the score as its total and the
// patterns by name - ScoreResult itself holds the pattern definitions,
// functions and all.
export interface ScoreView {
  total: number;
  patterns: { id: string; name: string; tai: number }[];
}
export type ResultView = Omit<HandResult, "score"> & { score: ScoreView | null };

export function scoreView(score: ScoreResult): ScoreView {
  const named = (matched: ScoreResult["matched"], hand: ScoreResult["hand"]) =>
    matched.map(({ pattern, tai }) => ({ id: pattern.id, name: patternDisplayName(pattern, hand), tai }));
  return { total: score.total, patterns: [...named(score.matched, score.hand), ...(score.second ? named(score.second.matched, score.second.hand) : [])] };
}

export type PhaseView =
  // `drawn` and `forbidden` only for the seat whose turn it is.
  | { kind: "turn"; seat: number; drawn: Tile | null; replacement: "flower" | "kong" | null; forbidden?: Tile[] }
  | { kind: "claims"; from: number; tile: Tile }
  | { kind: "over"; result: ResultView };

export interface TableView {
  you: number;
  players: SeatView[];
  wallLeft: number; // live tiles left to draw
  deadWall: number;
  dealer: number;
  roundWind: GameState["roundWind"];
  dealerStreak: number;
  phase: PhaseView;
  firstGoAround: boolean;
  discardsMade: number;
  lahs: NonNullable<GameState["lahs"]>;
  dice?: GameState["dice"];
  diceBonus?: GameState["diceBonus"];
  tableBonuses: TableBonus[];
  chase?: GameState["chase"];
}

const copyTiles = (tiles: Tile[]) => tiles.map((t) => ({ suit: t.suit, rank: t.rank }));

export function viewFor(s: GameState, you: number): TableView {
  const over = s.phase.kind === "over";
  const players: SeatView[] = s.players.map((p, seat) => {
    const open = seat === you || over;
    return {
      hand: open ? copyTiles(p.hand) : null,
      handCount: p.hand.length,
      melds: p.melds.map((m): MeldView => (m.kind === "kong" && m.concealed && !open ? { kind: "kong", concealed: true, hidden: true, from: null } : { ...m, tiles: copyTiles(m.tiles) })),
      flowers: p.flowers.map((f) => ({ ...f })),
      discards: copyTiles(p.discards),
      ...(p.riichi ? { riichi: { ...p.riichi } } : {}),
    };
  });
  let phase: PhaseView;
  if (s.phase.kind === "turn") {
    const mine = s.phase.seat === you;
    phase = {
      kind: "turn",
      seat: s.phase.seat,
      drawn: mine && s.phase.drawn ? { ...s.phase.drawn } : null,
      replacement: s.phase.replacement,
      ...(mine && s.phase.forbidden ? { forbidden: copyTiles(s.phase.forbidden) } : {}),
    };
  } else if (s.phase.kind === "claims") {
    phase = { kind: "claims", from: s.phase.from, tile: { ...s.phase.tile } };
  } else {
    const { score, ...rest } = s.phase.result;
    phase = { kind: "over", result: { ...structuredClone(rest), score: score ? scoreView(score) : null } };
  }
  return {
    you,
    players,
    wallLeft: liveTilesLeft(s),
    deadWall: Math.min(DEAD_WALL_SIZE, s.wall.length),
    dealer: s.dealer,
    roundWind: s.roundWind,
    dealerStreak: s.dealerStreak,
    phase,
    firstGoAround: s.firstGoAround,
    discardsMade: s.discardsMade,
    lahs: structuredClone(s.lahs ?? []),
    ...(s.dice ? { dice: [...s.dice] as GameState["dice"] } : {}),
    ...(s.diceBonus ? { diceBonus: structuredClone(s.diceBonus) } : {}),
    tableBonuses: structuredClone(s.tableBonuses ?? []),
    ...(s.chase ? { chase: structuredClone(s.chase) } : {}),
  };
}
