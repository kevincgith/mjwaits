// An online table, as the Play table shows it. The server sends each phone
// its seat's view (TableView: its own tiles, everyone's melds and ponds,
// counts for the rest); the Play table draws a GameState with you at seat 0.
// seatState turns one into the other: other hands and the wall become blank
// tiles of the right number, and the seats are turned so you're at 0 - so
// everything the Play table works out from the game (what you may call, the
// waits, the hints, the tile tracker) reads only what you can see.

import type { GameMeld, GameState, HandResult, Phase } from "@mjwaits/shared/engine/game";
import type { Tile } from "@mjwaits/shared/engine/mahjong";
import type { ResultView, TableView } from "@mjwaits/shared/engine/view";

// A tile no one may see: never drawn face up (hands and walls show their
// backs, a hidden kong is face down), only counted.
export const BLANK: Tile = { suit: "z", rank: 0 } as Tile;

export interface SeatState {
  game: GameState; // you at seat 0
  // The finished hand's result with its scores as they travel (the
  // GameState's own result has no ScoreResult to give), seats turned the same way.
  result: ResultView | null;
  // Seat numbers: the table's to this game's, and back.
  toLocal: (seat: number) => number;
  toTable: (seat: number) => number;
}

export function seatState(view: TableView): SeatState {
  const k = view.you < 0 ? 0 : view.you;
  const toLocal = (seat: number) => (seat - k + 4) % 4;
  const toTable = (seat: number) => (seat + k) % 4;
  // An array by table seat, in local seat order.
  const turn = <T,>(bySeat: T[]): T[] => bySeat.map((_, i) => bySeat[toTable(i)]);
  const id = (seat: string) => String(toLocal(Number(seat)));

  const players = turn(view.players).map((p) => ({
    hand: p.hand ? p.hand.map((t) => ({ ...t })) : Array.from({ length: p.handCount }, () => BLANK),
    melds: p.melds.map(
      (m): GameMeld =>
        "hidden" in m ? { kind: "kong", tiles: [BLANK, BLANK, BLANK, BLANK], concealed: true, from: null } : { ...m, from: m.from === null ? null : toLocal(m.from) }
    ),
    flowers: p.flowers,
    discards: p.discards,
    ...(p.riichi ? { riichi: p.riichi } : {}),
    ...(p.overWater ? { overWater: true } : {}),
    ...(p.passedPung ? { passedPung: p.passedPung } : {}),
    ...(p.threw ? { threw: p.threw } : {}),
  }));

  let phase: Phase;
  let result: ResultView | null = null;
  const vp = view.phase;
  if (vp.kind === "turn") phase = { ...vp, seat: toLocal(vp.seat) };
  else if (vp.kind === "claims") phase = { ...vp, from: toLocal(vp.from) };
  else if (vp.kind === "swap") {
    // The others' piles as backs (BLANK), yours as it is; seats turned.
    phase = {
      ...vp,
      piles: turn(vp.piles.map((pile) => (pile ? pile.map((t) => (t === "back" ? BLANK : t ? { ...t } : null)) : null))),
      taker: toLocal(vp.taker),
      took: vp.took.map(toLocal),
      ...(vp.takenBy ? { takenBy: turn(vp.takenBy.map((row) => row.map((t) => (t === null ? null : toLocal(t))))) } : {}),
    };
  } else {
    const r = vp.result;
    result = {
      ...r,
      winner: r.winner === null ? null : toLocal(r.winner),
      from: r.from === null ? null : toLocal(r.from),
      deltas: turn(r.deltas),
      ...(r.pairs ? { pairs: r.pairs.map((p) => ({ ...p, winner: id(p.winner), payer: id(p.payer) })) } : {}),
      ...(r.alsoWon ? { alsoWon: r.alsoWon.map((w) => ({ ...w, winner: toLocal(w.winner) })) } : {}),
      ...(r.fanXue ? { fanXue: r.fanXue.map((f) => ({ ...f, from: toLocal(f.from), to: toLocal(f.to) })) } : {}),
    };
    // The game's own copy: the same, without scores (the table shows `result`'s).
    const { alsoWon, ...rest } = result;
    phase = {
      kind: "over",
      result: { ...rest, score: null, ...(alsoWon ? { alsoWon: alsoWon.map((w) => ({ ...w, score: null })) } : {}) } as HandResult,
    };
  }

  const game: GameState = {
    wall: Array.from({ length: view.wallLeft + view.deadWall }, () => ({ tile: BLANK })),
    players,
    dealer: toLocal(view.dealer),
    roundWind: view.roundWind,
    dealerStreak: view.dealerStreak,
    // (Tables from before it was sent: seat 0, as they were dealt.)
    ...(toLocal(view.firstDealer ?? 0) ? { firstDealer: toLocal(view.firstDealer ?? 0) } : {}),
    phase,
    firstGoAround: view.firstGoAround,
    discardsMade: view.discardsMade,
    log: [],
    lahs: view.lahs.map((l) => ({ ...l, holder: id(l.holder), pulled: id(l.pulled) })),
    ...(view.dice ? { dice: view.dice } : {}),
    ...(view.diceBonus ? { diceBonus: { ...view.diceBonus, deltas: turn(view.diceBonus.deltas) } } : {}),
    tableBonuses: view.tableBonuses.map((b) => ({ ...b, seat: toLocal(b.seat), deltas: turn(b.deltas) })),
    ...(view.chase ? { chase: { ...view.chase, seat: toLocal(view.chase.seat) } } : {}),
    multiWin: view.multiWin,
  };
  return { game, result, toLocal, toTable };
}
