import { describe, expect, it } from "vitest";
import { applyTurnMove, botClaim, botTurnMove, claimOptions, kongOptions, newGame, resolveClaims, riichiDiscards, seatWind, SEATS, unseenCounts, type GameState } from "@mjwaits/shared/engine/game";
import { profileById, rateDiscardsFor, seededRng } from "@mjwaits/shared/engine/bots";
import { tileKey } from "@mjwaits/shared/engine/mahjong";
import { viewFor } from "@mjwaits/shared/engine/view";
import { BLANK, seatState } from "./seatState";

// A few moves into a hand, with bots at every seat.
function midHand(steps: number): GameState {
  const real = Math.random;
  Math.random = seededRng(42);
  try {
    let s = newGame();
    for (let i = 0; i < steps && s.phase.kind !== "over"; i++) {
      if (s.phase.kind === "turn") s = applyTurnMove(s, botTurnMove(s));
      else s = resolveClaims(s, Array.from({ length: SEATS }, (_, seat) => botClaim(s, seat)));
    }
    return s;
  } finally {
    Math.random = real;
  }
}

const withoutBlanks = (m: Map<string, number>) => new Map([...m].filter(([k]) => k !== tileKey(BLANK)));

describe("seatState", () => {
  for (const seat of [0, 1, 2, 3]) {
    it(`shows seat ${seat} at the bottom, with only what it may see`, () => {
      for (const steps of [0, 7, 20, 41]) {
        const real = midHand(steps);
        const { game, toLocal, toTable } = seatState(viewFor(real, seat));
        expect(toTable(0)).toBe(seat);
        expect(toLocal(seat)).toBe(0);
        // Your hand is yours; the others are blanks of the right number.
        expect(game.players[0].hand).toEqual(real.players[seat].hand);
        for (let i = 1; i < SEATS; i++) {
          expect(game.players[i].hand.length).toBe(real.players[toTable(i)].hand.length);
          expect(game.players[i].hand.every((t) => t === BLANK)).toBe(true);
          expect(game.players[i].discards).toEqual(real.players[toTable(i)].discards);
        }
        expect(game.wall.length).toBe(real.wall.length);
        // Winds follow the seats round.
        for (let i = 0; i < SEATS; i++) expect(seatWind(i, game.dealer)).toBe(seatWind(toTable(i), real.dealer));
        // Everything the table works out for you comes out the same.
        expect(withoutBlanks(unseenCounts(game, 0))).toEqual(withoutBlanks(unseenCounts(real, seat)));
        expect(kongOptions(game.players[0])).toEqual(kongOptions(real.players[seat]));
        if (real.phase.kind === "turn" && real.phase.seat === seat) {
          expect(game.phase).toMatchObject({ kind: "turn", seat: 0 });
          expect(riichiDiscards(game, 0)).toEqual(riichiDiscards(real, seat));
          // The hints: the Veteran's read of your discards, from your seat's view alone.
          const hint = profileById("veteran");
          expect(rateDiscardsFor(game, 0, hint)).toEqual(rateDiscardsFor(real, seat, hint));
        }
        if (real.phase.kind === "claims") expect(claimOptions(game, 0)).toEqual(claimOptions(real, seat));
      }
    });
  }

  it("turns a finished hand's result round too, scores included", () => {
    const s = midHand(400);
    expect(s.phase.kind).toBe("over");
    const seat = 2;
    const { game, result, toLocal } = seatState(viewFor(s, seat));
    if (s.phase.kind !== "over") return;
    const r = s.phase.result;
    expect(result!.winner).toBe(r.winner === null ? null : toLocal(r.winner));
    expect(result!.deltas[0]).toBe(r.deltas[seat]);
    if (r.score) expect(result!.score!.total).toBe(r.score.total);
    expect(game.phase.kind).toBe("over");
    // Everyone's tiles are open once it's over.
    for (let i = 0; i < SEATS; i++) expect(game.players[i].hand.some((t) => t === BLANK)).toBe(false);
  });

  it("puts someone watching at seat 0's place, seeing no hand", () => {
    const real = midHand(5);
    const { game } = seatState(viewFor(real, -1));
    expect(game.players.every((p) => p.hand.every((t) => t === BLANK))).toBe(true);
  });
});
