import { describe, expect, it } from "vitest";
import {
  applyTurnMove,
  botClaim,
  botTurnMove,
  claimOptions,
  meldsNeeded,
  newGame,
  nextHand,
  resolveClaims,
  SEATS,
  type GameState,
} from "./game";
import { parseHand } from "./mahjong";

function tilesInPlay(s: GameState): number {
  return (
    s.wall.length +
    s.players.reduce((n, p) => n + p.hand.length + p.discards.length + p.flowers.length + p.melds.reduce((m, x) => m + x.tiles.length, 0), 0) +
    // A claimed discard is in a meld; an unclaimed one is in a pond - either way counted above.
    0
  );
}

// Plays a hand out with all four seats as bots.
function playOut(s: GameState): GameState {
  for (let steps = 0; steps < 1000 && s.phase.kind !== "over"; steps++) {
    if (s.phase.kind === "turn") {
      const p = s.players[s.phase.seat];
      expect(p.hand.length).toBe(meldsNeeded(p) * 3 + 2);
      s = applyTurnMove(s, botTurnMove(s));
    } else {
      const decisions = Array.from({ length: SEATS }, (_, seat) => botClaim(s, seat));
      s = resolveClaims(s, decisions);
    }
    expect(tilesInPlay(s)).toBe(144);
  }
  return s;
}

describe("game", () => {
  it("deals 16 each plus the dealer's draw, flowers set aside", () => {
    const s = newGame();
    expect(s.phase.kind).toBe("turn");
    s.players.forEach((p, i) => expect(p.hand.length).toBe(i === s.dealer ? 17 : 16));
    expect(tilesInPlay(s)).toBe(144);
  });

  it("plays bot-only hands to a finish, keeping every tile accounted for", () => {
    let s = newGame();
    const started = performance.now();
    let wins = 0;
    for (let hand = 0; hand < 12; hand++) {
      s = playOut(s);
      expect(s.phase.kind).toBe("over");
      if (s.phase.kind === "over" && s.phase.result.winner !== null) {
        wins++;
        expect(s.phase.result.scoreError).toBeNull();
        expect(s.phase.result.score!.total).toBeGreaterThan(0);
        expect(s.phase.result.deltas.reduce((a, b) => a + b, 0)).toBe(0);
      }
      s = nextHand(s);
    }
    const ms = performance.now() - started;
    console.log(`12 hands, ${wins} wins, ${ms.toFixed(0)}ms`);
    expect(wins).toBeGreaterThan(0);
  }, 60_000);

  it("offers chow only to the next seat, pung to anyone with a pair", () => {
    const s0 = newGame();
    // Seat 0 (dealer) discards 5m; seat 1 holds 46m, seat 2 holds 55m.
    s0.players[0].hand = parseHand("12345m111222333t55b");
    s0.players[1].hand = parseHand("46m111222333t12345b");
    s0.players[2].hand = parseHand("55m111222333b12345t");
    s0.players[3].hand = parseHand("1234567z123456789b");
    const s = applyTurnMove(s0, { kind: "discard", tile: { suit: "m", rank: 5 } });
    expect(claimOptions(s, 1).map((c) => c.kind)).toEqual(["chow"]);
    expect(claimOptions(s, 2).map((c) => c.kind)).toEqual(["pung"]);
    expect(claimOptions(s, 3)).toEqual([]);
    // Pung beats chow, and the tile leaves the discarder's pond.
    const after = resolveClaims(s, [null, claimOptions(s, 1)[0], { kind: "pung" }, null]);
    expect(after.phase).toMatchObject({ kind: "turn", seat: 2 });
    expect(after.players[2].melds[0].kind).toBe("triplet");
    expect(after.players[0].discards).toEqual([]);
  });
});
