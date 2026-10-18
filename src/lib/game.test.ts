import { describe, expect, it } from "vitest";
import {
  applyTurnMove,
  botClaim,
  botTurnMove,
  claimOptions,
  forbiddenDiscards,
  roundLabel,
  swapDiscardBan,
  meldsNeeded,
  newGame,
  nextHand,
  resolveClaims,
  riichiDiscards,
  riichiForcedDiscard,
  kongOptions,
  SEATS,
  type GameState,
} from "./game";
import { parseHand, type Tile } from "./mahjong";

const sameTile = (a: Tile, b: Tile) => a.suit === b.suit && a.rank === b.rank;
const m = (rank: number): Tile => ({ suit: "m", rank });

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
      const move = botTurnMove(s);
      if (move.kind === "discard") expect(forbiddenDiscards(s).some((t) => sameTile(t, move.tile))).toBe(false);
      s = applyTurnMove(s, move);
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

  it("bars 食替 discards after a call", () => {
    // Pung: just the claimed tile.
    expect(swapDiscardBan(m(5))).toEqual([m(5)]);
    // Chow at the high end: 56 + 7 also waited on 4.
    expect(swapDiscardBan(m(7), [m(5), m(6)])).toEqual([m(7), m(4)]);
    // Chow at the low end: 34 + 2 also waited on 5.
    expect(swapDiscardBan(m(2), [m(3), m(4)])).toEqual([m(2), m(5)]);
    // Edge and middle chows have no far side: 89 + 7, 68 + 7.
    expect(swapDiscardBan(m(7), [m(8), m(9)])).toEqual([m(7)]);
    expect(swapDiscardBan(m(7), [m(6), m(8)])).toEqual([m(7)]);
  });

  it("applies 食替 after a chow, and waives it when nothing else is left", () => {
    const s0 = newGame();
    s0.players[0].hand = parseHand("12347m111222333t5b");
    s0.players[1].hand = parseHand("56m111222333t12345b");
    const s = applyTurnMove(s0, { kind: "discard", tile: m(7) });
    const after = resolveClaims(s, [null, claimOptions(s, 1)[0], null, null]);
    expect(forbiddenDiscards(after)).toEqual([m(7), m(4)]);
    expect(() => applyTurnMove(after, { kind: "discard", tile: m(4) })).toThrow();
    expect(botTurnMove(after)).not.toMatchObject({ kind: "discard", tile: m(4) });
    // A hand of only barred tiles may throw one anyway.
    const stuck = { ...after, players: after.players.map((p, i) => (i === 1 ? { ...p, hand: [m(4), m(4)] } : p)) };
    expect(forbiddenDiscards(stuck)).toEqual([]);
  });

  it("labels the round and deal", () => {
    const s = newGame();
    expect(roundLabel(s)).toBe("東圈東局");
    expect(roundLabel({ ...s, dealer: 2 })).toBe("東圈西局");
    expect(roundLabel({ ...s, roundWind: 2, dealer: 3 })).toBe("南圈北局");
  });

  describe("叮", () => {
    const t = (suit: Tile["suit"], rank: number): Tile => ({ suit, rank });
    // Dealer (seat 0): five melds + a single 3t and a spare 5z - throwing
    // either leaves the hand ready.
    function declared() {
      const s0 = newGame();
      s0.dealer = 0;
      s0.players[0].hand = parseHand("123456789m111222t3t5z");
      s0.phase = { kind: "turn", seat: 0, drawn: t("z", 5), replacement: null };
      expect(riichiDiscards(s0, 0).map((x) => x.suit + x.rank).sort()).toEqual(["t3", "z5"]);
      return applyTurnMove(s0, { kind: "discard", tile: t("z", 5), riichi: true });
    }

    it("declares with a discard that leaves the hand ready - 天叮 on the dealer's first", () => {
      const s = declared();
      expect(s.players[0].riichi).toEqual({ state: "heavenly-riichi", discard: 0, ippatsu: true });
      const s0 = newGame();
      s0.players[0].hand = parseHand("123456789m111222t3t5z");
      s0.phase = { kind: "turn", seat: 0, drawn: t("z", 5), replacement: null };
      // A discard that leaves the hand short of ready can't declare.
      expect(() => applyTurnMove(s0, { kind: "discard", tile: m(1), riichi: true })).toThrow();
    });

    it("locks the hand: only the drawn tile goes, no kongs, only a win can be called", () => {
      const s = declared();
      const turn: GameState = {
        ...s,
        players: s.players.map((p, i) => (i === 0 ? { ...p, hand: [...p.hand, t("b", 9)] } : p)),
        phase: { kind: "turn", seat: 0, drawn: t("b", 9), replacement: null },
      };
      expect(riichiForcedDiscard(turn)).toEqual(t("b", 9));
      expect(() => applyTurnMove(turn, { kind: "discard", tile: m(1) })).toThrow();
      expect(kongOptions(turn.players[0])).toEqual([]);
      expect(botTurnMove(turn)).toEqual({ kind: "discard", tile: t("b", 9) });
      const after = applyTurnMove(turn, { kind: "discard", tile: t("b", 9) });
      // The first discard after declaring ends 一發.
      expect(after.players[0].riichi?.ippatsu).toBe(false);
      // Seat 3 throws 1m (a pair-and-run shape would let others pung); seat 0 may only win.
      const claim: GameState = { ...s, players: s.players.map((p, i) => (i === 0 ? { ...p, hand: [...p.hand, m(1), m(1)].slice(2) } : p)), phase: { kind: "claims", from: 3, tile: m(1) } };
      expect(claimOptions(claim, 0).every((c) => c.kind === "win")).toBe(true);
    });

    it("scores 天叮 and 一發 on a win before the next discard, and 食叮 off a declared player", () => {
      const s = declared();
      // Seat 1 throws the 3t; seat 0 wins with 一發.
      const s1: GameState = { ...s, players: s.players.map((p, i) => (i === 1 ? { ...p, discards: [t("t", 3)] } : p)), phase: { kind: "claims", from: 1, tile: t("t", 3) } };
      const won = resolveClaims(s1, [{ kind: "win" }, null, null, null]);
      const ids = won.phase.kind === "over" ? won.phase.result.score?.matched.map((x) => x.pattern.id) : [];
      expect(ids).toContain("heavenly-riichi");
      expect(ids).toContain("riichi-instant-win");
      expect(ids).not.toContain("riichi-eat");
      // Seat 1, ready on 5z, wins off seat 0's declaring discard: 食叮.
      const s2: GameState = { ...s, players: s.players.map((p, i) => (i === 1 ? { ...p, hand: parseHand("123456789m111222t5z") } : p)) };
      const eaten = resolveClaims(s2, [null, { kind: "win" }, null, null]);
      const eatIds = eaten.phase.kind === "over" ? eaten.phase.result.score?.matched.map((x) => x.pattern.id) : [];
      expect(eatIds).toContain("riichi-eat");
    });
  });
});
