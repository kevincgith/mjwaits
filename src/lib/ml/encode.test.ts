import { describe, expect, it } from "vitest";
import { botClaimFor, botTurnMoveFor, profileById, seededRng } from "@mjwaits/shared/engine/bots";
import { applyTurnMove, dealHand, resolveClaims, SEATS, type GameState } from "@mjwaits/shared/engine/game";
import {
  actionToClaim,
  actionToTurnMove,
  claimDecisionAction,
  encodeObservation,
  legalActions,
  NUM_ACTIONS,
  OBS_SIZE,
  turnMoveAction,
} from "./encode";

describe("ML encoding", () => {
  it("round-trips every bot decision through the action space, legally", () => {
    const rng = seededRng(5);
    const bots = ["grandmaster", "veteran", "wall", "casual"].map(profileById);
    // The deal seeded too, so the hand (and how many decisions it takes) is
    // the same every run - unseeded, a quick win sometimes left too few.
    let s: GameState = dealHand({ dealer: 0, roundWind: 1, dealerStreak: 0 }, undefined, rng);
    let decisions = 0;
    for (let steps = 0; s.phase.kind !== "over" && steps < 400; steps++) {
      if (s.phase.kind === "turn") {
        const seat = s.phase.seat;
        const obs = encodeObservation(s, seat);
        expect(obs).toHaveLength(OBS_SIZE);
        const mask = legalActions(s, seat);
        expect(mask).toHaveLength(NUM_ACTIONS);
        const move = botTurnMoveFor(s, bots[seat], rng);
        const a = turnMoveAction(move);
        expect(mask[a]).toBe(1);
        const back = actionToTurnMove(s, a);
        // Same move, so the engine accepts it and lands in the same place.
        expect(() => applyTurnMove(s, back)).not.toThrow();
        s = applyTurnMove(s, move);
        decisions++;
      } else {
        const claims = Array.from({ length: SEATS }, (_, i) => botClaimFor(s, i, bots[i], rng));
        for (let seat = 0; seat < SEATS; seat++) {
          const mask = legalActions(s, seat);
          if (!mask.some(Boolean)) continue;
          const a = claimDecisionAction(s, claims[seat]);
          expect(mask[a]).toBe(1);
          expect(actionToClaim(s, seat, a)).toEqual(claims[seat]);
          decisions++;
        }
        s = resolveClaims(s, claims);
      }
    }
    expect(decisions).toBeGreaterThan(20);
  });

  it("shows nothing a seat couldn't see: other hands don't change its view", () => {
    const s = dealHand({ dealer: 0, roundWind: 1, dealerStreak: 0 });
    const peek: GameState = { ...s, players: s.players.map((p, i) => (i === 2 ? { ...p, hand: [...p.hand].reverse().map((t) => ({ ...t, rank: t.suit === "z" ? 1 : 1 })) } : p)) };
    expect(encodeObservation(peek, 0)).toEqual(encodeObservation(s, 0));
  });
});
