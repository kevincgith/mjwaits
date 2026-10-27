import { describe, expect, it } from "vitest";
import {
  applyTurnMove,
  botClaim,
  botTurnMove,
  barredClaims,
  claimOptions,
  selfDrawBarred,
  forbiddenDiscards,
  roundLabel,
  swapDiscardBan,
  meldsNeeded,
  newGame,
  nextHand,
  resolveClaims,
  riichiBarred,
  riichiDiscards,
  riichiForcedDiscard,
  settleWin,
  lahAddOn,
  surrender,
  surrenderable,
  wallBreak,
  diceBonus,
  dealHand,
  flowerBonus,
  flowerRobbery,
  retractClaim,
  fullWall,
  kongOptions,
  SEATS,
  type GameState,
} from "./game";
import { parseHand, type Tile } from "./mahjong";
import { botTurnFor, profileById } from "./bots";

const sameTile = (a: Tile, b: Tile) => a.suit === b.suit && a.rank === b.rank;
const m = (rank: number): Tile => ({ suit: "m", rank });

function tilesInPlay(s: GameState): number {
  return (
    s.wall.length +
    s.players.reduce((n, p) => n + p.hand.length + p.discards.length + p.flowers.length + p.melds.reduce((m, x) => m + x.tiles.length, 0), 0) +
    // A claimed discard is in a meld; an unclaimed one is in a pond - either way counted above.
    // A kong tile shown for 搶槓 is in neither hand nor meld until the window closes.
    (s.phase.kind === "claims" && s.phase.robKong ? 1 : 0)
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

  it("叮: a passed-up win means no more wins this hand", () => {
    const s0 = newGame();
    s0.players[0].hand = parseHand("12345m111222333t55b");
    // Seat 1 is 叮, waiting on 5m (46m), every other set made.
    s0.players[1].hand = parseHand("111222333444t55b46m");
    s0.players[1].riichi = { state: "riichi", discard: 0, ippatsu: false };
    const s = applyTurnMove(s0, { kind: "discard", tile: { suit: "m", rank: 5 } });
    expect(claimOptions(s, 1).map((c) => c.kind)).toEqual(["win"]);
    // Passed up.
    const after = resolveClaims(s, [null, null, null, null]);
    expect(after.players[1].riichi?.passed).toBe(true);
    // The same tile again: no win on it.
    const again = { ...after, phase: { kind: "claims" as const, from: 3, tile: { suit: "m" as const, rank: 5 } } };
    expect(claimOptions(again, 1)).toEqual([]);
    // Nor drawn: no self-draw, and it throws its draw.
    const drew = { ...after, players: after.players.map((p, i) => (i === 1 ? { ...p, hand: [...p.hand, { suit: "m" as const, rank: 5 }] } : p)), phase: { kind: "turn" as const, seat: 1, drawn: { suit: "m" as const, rank: 5 }, replacement: null } };
    expect(() => applyTurnMove(drew, { kind: "selfDraw" })).toThrow();
    expect(botTurnMove(drew).kind).toBe("discard");
    // Another 叮 hand that hasn't passed still wins as ever.
    expect(claimOptions({ ...s, players: s.players.map((p, i) => (i === 1 ? { ...p, riichi: { ...p.riichi!, passed: false } } : p)) }, 1).map((c) => c.kind)).toEqual(["win"]);
  });

  it("過水: a passed-up win is barred, drawn too, till a throw that doesn't win", () => {
    const m5 = { suit: "m" as const, rank: 5 };
    const s0 = newGame();
    s0.players[0].hand = parseHand("12345m111222333t55b");
    // Seat 1, not 叮, waiting on 5m.
    s0.players[1].hand = parseHand("111222333444t55b46m");
    const s = applyTurnMove(s0, { kind: "discard", tile: m5 });
    const after = resolveClaims(s, [null, null, null, null]);
    expect(after.players[1].overWater).toBe(true);
    expect(after.players[1].riichi).toBeUndefined();
    // Off a discard: no.
    expect(claimOptions({ ...after, phase: { kind: "claims", from: 3, tile: m5 } }, 1)).toEqual([]);
    // Drawn: no - and throwing that winning tile keeps it barred.
    const withTile = (t: { suit: "m" | "z"; rank: number }) => ({
      ...after,
      // (Its waiting hand and the tile drawn - not the tile it drew after passing.)
      players: after.players.map((p, i) => (i === 1 ? { ...p, hand: [...parseHand("111222333444t55b46m"), t] } : p)),
      phase: { kind: "turn" as const, seat: 1, drawn: t, replacement: null },
    });
    expect(() => applyTurnMove(withTile(m5), { kind: "selfDraw" })).toThrow();
    expect(applyTurnMove(withTile(m5), { kind: "discard", tile: m5 }).players[1].overWater).toBe(true);
    // Throwing a tile that doesn't win lifts it: the next 5m wins.
    const z9 = { suit: "z" as const, rank: 7 };
    const lifted = applyTurnMove(withTile(z9), { kind: "discard", tile: z9 });
    expect(lifted.players[1].overWater).toBeUndefined();
    expect(claimOptions({ ...lifted, phase: { kind: "claims", from: 3, tile: m5 } }, 1).map((c) => c.kind)).toEqual(["win"]);
  });

  it("a passed-up pung is barred till that player draws - shown greyed meanwhile", () => {
    const z5 = { suit: "z" as const, rank: 5 };
    const s0 = newGame();
    s0.players[0].hand = parseHand("12345m111222333t5z");
    // Seat 2 holds two 5z: offered a pung when seat 0 throws one.
    s0.players[2].hand = parseHand("123456789m1234t55z");
    const s = applyTurnMove(s0, { kind: "discard", tile: z5 });
    expect(claimOptions(s, 2).map((c) => c.kind)).toEqual(["pung"]);
    const after = resolveClaims(s, [null, null, null, null]);
    expect(after.players[2].passedPung).toEqual(z5);
    // Seat 1 (between) throws another 5z: barred for seat 2, but shown.
    const again = { ...after, phase: { kind: "claims" as const, from: 1, tile: z5 } };
    expect(claimOptions(again, 2)).toEqual([]);
    expect(barredClaims(again, 2).map((c) => c.kind)).toEqual(["pung"]);
    // Another tile it could pung isn't barred.
    expect(barredClaims({ ...after, phase: { kind: "claims" as const, from: 1, tile: { suit: "m", rank: 1 } } }, 2)).toEqual([]);
    // Its own draw lifts it.
    const drawn = resolveClaims({ ...after, phase: { kind: "claims" as const, from: 1, tile: { suit: "t", rank: 9 } } }, [null, null, null, null]);
    expect(drawn.phase).toMatchObject({ kind: "turn", seat: 2 });
    expect(drawn.players[2].passedPung).toBeUndefined();
  });

  it("no run back from a tile just thrown: threw 1m from 123m, no 1m or 4m onto the 23m till the next draw", () => {
    const s0 = newGame();
    // Seat 1 to throw, holding 123m and 56m.
    s0.players[1].hand = parseHand("123m56m111222t55b5z");
    s0.phase = { kind: "turn", seat: 1, drawn: null, replacement: null };
    const s = applyTurnMove(s0, { kind: "discard", tile: { suit: "m", rank: 1 } });
    expect(s.players[1].threw).toEqual({ suit: "m", rank: 1 });
    // Seat 0, on its left, throws 4m: no run with it at all (greyed instead).
    const four = { ...s, phase: { kind: "claims" as const, from: 0, tile: { suit: "m" as const, rank: 4 } } };
    const runs = (cs: ReturnType<typeof claimOptions>) => cs.flatMap((c) => (c.kind === "chow" ? [c.tiles.map((t) => t.rank).join("")] : []));
    expect(runs(claimOptions(four, 1))).toEqual([]);
    expect(runs(barredClaims(four, 1))).toEqual(["23", "35", "56"]);
    // 7m isn't barred: 567.
    expect(runs(claimOptions({ ...s, phase: { kind: "claims" as const, from: 0, tile: { suit: "m" as const, rank: 7 } } }, 1))).toEqual(["56"]);
    // 1m back: no run at all.
    const one = { ...s, phase: { kind: "claims" as const, from: 0, tile: { suit: "m" as const, rank: 1 } } };
    expect(runs(claimOptions(one, 1))).toEqual([]);
    expect(runs(barredClaims(one, 1))).toEqual(["23"]);
    // With the table's No run back off, the run back is there.
    const free = applyTurnMove({ ...s0, runBack: true }, { kind: "discard", tile: { suit: "m", rank: 1 } });
    expect(free.players[1].threw).toBeUndefined();
    expect(runs(claimOptions({ ...free, phase: { kind: "claims" as const, from: 0, tile: { suit: "m" as const, rank: 4 } } }, 1))).toEqual(["23", "35", "56"]);
    // A draw lifts it.
    const drew = resolveClaims({ ...s, phase: { kind: "claims" as const, from: 0, tile: { suit: "z" as const, rank: 7 } } }, [null, null, null, null]);
    expect(drew.phase).toMatchObject({ kind: "turn", seat: 1 });
    expect(drew.players[1].threw).toBeUndefined();
  });

  it("叮 only on a hand that can win: not the hand a bot declared on, nor a dead wait", () => {
    const s0 = newGame();
    const turn = (hand: string) => ({ ...s0, players: s0.players.map((p, i) => (i === 0 ? { ...p, hand: parseHand(hand), melds: [] } : p)), phase: { kind: "turn" as const, seat: 0, drawn: null, replacement: null } });
    // 1111m + seven pairs + two singles, plus the tile to throw: no discard leaves it ready.
    expect(riichiDiscards(turn("1111m88m488t233b77z44z1z"), 0)).toEqual([]);
    // Throwing 1z would leave only a wait on 1b, all four held: ready by
    // shape, but it can't win - not offered. (Throwing a 1b, waiting on 1z, is.)
    const dead = riichiDiscards(turn("1111b888t345m888b678t1z"), 0);
    expect(dead.some((t) => t.suit === "z")).toBe(false);
    expect(dead).toContainEqual({ suit: "b", rank: 1 });
    // A real wait still may.
    expect(riichiDiscards(turn("111b888t345m888b67t77z1z"), 0).length).toBeGreaterThan(0);
  });

  it("no 叮 when 自摸 is there to take - it would pass the win up for good - shown greyed", () => {
    const s0 = newGame();
    // A complete hand: 自摸, and throwing any tile to declare would pass that up.
    const s = { ...s0, players: s0.players.map((p, i) => (i === 0 ? { ...p, hand: parseHand("111b888t345m888b678t77z"), melds: [] } : p)), phase: { kind: "turn" as const, seat: 0, drawn: null, replacement: null } };
    expect(riichiDiscards(s, 0)).toEqual([]);
    expect(riichiBarred(s, 0)).toBe(true);
    expect(() => applyTurnMove(s, { kind: "discard", tile: { suit: "z", rank: 7 }, riichi: true })).toThrow();
  });

  it("過水 and a passed 叮 win show the win greyed, not gone", () => {
    const m5 = { suit: "m" as const, rank: 5 };
    const s0 = newGame();
    s0.players[0].hand = parseHand("12345m111222333t55b");
    s0.players[1].hand = parseHand("111222333444t55b46m");
    const passed = resolveClaims(applyTurnMove(s0, { kind: "discard", tile: m5 }), [null, null, null, null]);
    // (Its waiting hand again - not the tile it drew after passing.)
    const after = { ...passed, players: passed.players.map((p, i) => (i === 1 ? { ...p, hand: parseHand("111222333444t55b46m") } : p)) };
    const again = { ...after, phase: { kind: "claims" as const, from: 3, tile: m5 } };
    expect(barredClaims(again, 1).map((c) => c.kind)).toEqual(["win"]);
    expect(selfDrawBarred({ ...after.players[1], hand: [...after.players[1].hand, m5] })).toBe(true);
    expect(selfDrawBarred({ ...after.players[1], overWater: undefined, hand: [...after.players[1].hand, m5] })).toBe(false);
  });

  it("a second kong is offered after the first's replacement draw", () => {
    const s0 = newGame();
    s0.players[0].hand = parseHand("1111b2222b345t678t9t1z");
    // All four of each in hand: none left in the wall (else the replacement
    // draw could be a fifth 2b, and five aren't a kong).
    s0.wall = s0.wall.filter((w) => !("tile" in w) || w.tile.suit !== "b" || w.tile.rank > 2);
    s0.phase = { kind: "turn", seat: 0, drawn: s0.players[0].hand[s0.players[0].hand.length - 1], replacement: null };
    const after = applyTurnMove(s0, { kind: "concealedKong", tile: { suit: "b", rank: 1 } });
    expect(after.phase).toMatchObject({ kind: "turn", seat: 0 });
    expect(kongOptions(after.players[0], after.phase)).toContainEqual({ kind: "concealedKong", tile: { suit: "b", rank: 2 } });
  });

  it("叮: throwing a self-drawn win is passing it up", () => {
    const s0 = newGame();
    const win = parseHand("111222333444t55b456m");
    s0.players[0].hand = win;
    s0.players[0].riichi = { state: "riichi", discard: 0, ippatsu: false };
    s0.phase = { kind: "turn", seat: 0, drawn: win[win.length - 1], replacement: null };
    const s = applyTurnMove(s0, { kind: "discard", tile: win[win.length - 1] });
    expect(s.players[0].riichi?.passed).toBe(true);
  });

  it("offers no kong straight after claiming a run or a pung - but the fourth of the pung just claimed", () => {
    const s0 = newGame();
    s0.players[0].hand = parseHand("12345m111222333t55b");
    // Seat 2 holds 555m (pung the discard, the fourth still held) and 1111b (a concealed kong).
    s0.players[2].hand = parseHand("555m1111b2345t789t1z");
    const s = applyTurnMove(s0, { kind: "discard", tile: { suit: "m", rank: 5 } });
    const after = resolveClaims(s, [null, null, { kind: "pung" }, null]);
    const p = after.players[2];
    expect(kongOptions(p).map((k) => k.kind).sort()).toEqual(["addedKong", "concealedKong"]);
    // Just the fourth 5m onto the pung.
    expect(kongOptions(p, after.phase)).toEqual([{ kind: "addedKong", tile: { suit: "m", rank: 5 } }]);
    expect(() => applyTurnMove(after, { kind: "concealedKong", tile: { suit: "b", rank: 1 } })).toThrow();
    expect(applyTurnMove(after, { kind: "addedKong", tile: { suit: "m", rank: 5 } }).players[2].melds[0].kind).toBe("kong");
    // A turn begun with a draw offers both again.
    const drawn = { ...after, phase: { kind: "turn" as const, seat: 2, drawn: { suit: "z" as const, rank: 1 }, replacement: null } };
    expect(kongOptions(p, drawn.phase).length).toBe(2);
    // A pung without the fourth: no kong at all - for bots of every kind too.
    const s1 = newGame();
    s1.players[0].hand = parseHand("12345m111222333t55b");
    s1.players[2].hand = parseHand("55m1111b2345t789t17z");
    const t = resolveClaims(applyTurnMove(s1, { kind: "discard", tile: { suit: "m", rank: 5 } }), [null, null, { kind: "pung" }, null]);
    expect(kongOptions(t.players[2], t.phase)).toEqual([]);
    expect(botTurnMove(t).kind).toBe("discard");
    for (const id of ["casual", "hunter", "veteran", "speedster"]) expect(botTurnFor(t, profileById(id)).move.kind).toBe("discard");
  });

  it("offers no kong straight after claiming a run", () => {
    const s0 = newGame();
    s0.players[0].hand = parseHand("12345m111222333t55b");
    // Seat 1 (next) runs 4-5-6m off the 5m, and holds 1111b.
    s0.players[1].hand = parseHand("46m1111b2345t789t17z");
    const s = applyTurnMove(s0, { kind: "discard", tile: { suit: "m", rank: 5 } });
    const after = resolveClaims(s, [null, claimOptions(s, 1).find((c) => c.kind === "chow")!, null, null]);
    expect(kongOptions(after.players[1], after.phase)).toEqual([]);
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

  describe("拉 / 踢", () => {
    // Your examples: 11, then a 20-tai repeat is worth 26 and the 拉 is 37;
    // 拉 29, then a 20-tai 踢 is worth 35 and the kicker's new 拉 is 20.
    it("adds half the 拉 on a repeat win and grows it", () => {
      const lahs = [{ holder: "1", pulled: "2", value: 11, count: 1 }];
      const [pair] = settleWin(lahs, 0, 1, 2, 20);
      expect(pair.worth).toBe(26);
      expect(lahAddOn(lahs, 1, 2)).toEqual({ amount: 6, kind: "拉", value: 11 });
    });

    it("kicks: the pulled player winning back adds half and takes over at the plain value", () => {
      const s0 = newGame();
      s0.dealer = 0;
      s0.lahs = [{ holder: "1", pulled: "2", value: 29, count: 1 }];
      // Seat 2 wins 20 tai off seat 1.
      const [pair] = settleWin(s0.lahs, 0, 2, 1, 20);
      expect(pair.lahKind).toBe("踢");
      expect(pair.worth).toBe(35);
    });

    it("pays each self-draw payer its own pair's 拉, and a draw keeps every 拉", () => {
      const lahs = [
        { holder: "0", pulled: "1", value: 10, count: 1 },
        { holder: "3", pulled: "0", value: 8, count: 1 },
      ];
      const pairs = settleWin(lahs, 2, 0, null, 12);
      const by = Object.fromEntries(pairs.map((p) => [p.payer, p.worth]));
      expect(by).toEqual({ "1": 12 + 5, "2": 12, "3": 12 + 4 });
      // A 流局 hand keeps them, and the next deal carries them on.
      const s0 = newGame();
      s0.lahs = lahs;
      s0.phase = { kind: "over", result: { winner: null, from: null, tile: null, score: null, scoreError: null, deltas: [0, 0, 0, 0] } };
      expect(nextHand(s0).lahs).toEqual(lahs);
    });

    it("allows 投降 only after 3 拉 in a row, between hands, paying nothing", () => {
      const s0 = newGame();
      s0.lahs = [
        { holder: "1", pulled: "0", value: 60, count: 3 },
        { holder: "2", pulled: "0", value: 30, count: 2 },
      ];
      // Mid-hand: not yet.
      expect(surrenderable(s0, 0)).toEqual([]);
      // After a draw the 拉 stands - that hand didn't involve them.
      s0.phase = { kind: "over", result: { winner: null, from: null, tile: null, score: null, scoreError: null, deltas: [0, 0, 0, 0] } };
      expect(surrenderable(s0, 0)).toEqual([]);
      // After seat 1 wins off a third player, neither.
      const offOther = settleWin([], 0, 1, 3, 10);
      s0.phase = { kind: "over", result: { winner: 1, from: 3, tile: null, score: null, scoreError: null, deltas: [0, 10, 0, -10], pairs: offOther } };
      expect(surrenderable(s0, 0)).toEqual([]);
      // After seat 1 self-draws (seat 0 paid): now.
      const selfDraw = settleWin([], 0, 1, null, 10);
      s0.phase = { kind: "over", result: { winner: 1, from: null, tile: null, score: null, scoreError: null, deltas: [-10, 30, -10, -10], pairs: selfDraw } };
      expect(surrenderable(s0, 0).map((l) => l.holder)).toEqual(["1"]);
      expect(surrender(s0, 1, 0).lahs).toEqual([{ holder: "2", pulled: "0", value: 30, count: 2 }]);
      expect(() => surrender(s0, 2, 0)).toThrow();
    });
  });

  describe("dice", () => {
    it("rolls three dice for a table-made deal, none for a given wall", () => {
      const s = newGame();
      expect(s.dice).toHaveLength(3);
      for (const d of s.dice!) expect(d >= 1 && d <= 6).toBe(true);
      expect(tilesInPlay(s)).toBe(144);
    });

    it("breaks the wall where a real table would: the total counted round from the dealer", () => {
      // 3 + 4 + 5 = 12: 12 counted from the dealer lands on the seat before them.
      expect(wallBreak([3, 4, 5], 0)).toEqual({ seat: 3, stacks: 12 });
      // 1 + 1 + 3 = 5: the dealer's own wall.
      expect(wallBreak([1, 1, 3], 2)).toEqual({ seat: 2, stacks: 5 });
      // 6 + 6 + 6 = 18: across from... 18 counted from seat 1 is seat 2.
      expect(wallBreak([6, 6, 6], 1)).toEqual({ seat: 2, stacks: 18 });
    });

    it("pays 圍骰 on a triple: the dealer collects 5 from each player", () => {
      expect(diceBonus([4, 4, 4], 2)).toEqual({ name: "圍骰", deltas: [-5, -5, 15, -5] });
      expect(diceBonus([4, 4, 5], 2)).toBeNull();
    });

    it("charges 蛇骰 on a 1-2-3 in any order: the dealer pays 5 to each player", () => {
      expect(diceBonus([3, 1, 2], 0)).toEqual({ name: "蛇骰", deltas: [-15, 5, 5, 5] });
      expect(diceBonus([2, 3, 4], 0)).toBeNull();
    });
  });
});

describe("flower bonuses", () => {
  const f = (kind: "flower" | "season", ...ranks: (1 | 2 | 3 | 4)[]) => ranks.map((rank) => ({ kind, rank }));
  it("草 is a mixed 1-2-3-4, 花 one set, 花草 both at once, at most one of each", () => {
    expect(flowerBonus([...f("flower", 1, 2), ...f("season", 3, 4)], [])).toEqual(["草"]);
    expect(flowerBonus(f("season", 1, 2, 3, 4), [])).toEqual(["花"]);
    // 123f + 12s, then 4f: 1234f and 1s 2s 3f 4f in one go.
    expect(flowerBonus([...f("flower", 1, 2, 3), ...f("season", 1, 2), ...f("flower", 4)], [])).toEqual(["花草"]);
    // 124s + 4f, then 3s: 1234s and 1s 2s 3s 4f.
    expect(flowerBonus([...f("season", 1, 2, 4), ...f("flower", 4), ...f("season", 3)], [])).toEqual(["花草"]);
    expect(flowerBonus([...f("flower", 1, 2, 3, 4), ...f("season", 4)], ["花"])).toEqual(["草"]);
    expect(flowerBonus([...f("flower", 1, 2, 3, 4), ...f("season", 1, 2, 3)], ["花草"])).toEqual([]);
    expect(flowerBonus([...f("flower", 1, 2), ...f("season", 1, 2)], [])).toEqual([]);
    expect(flowerBonus([...f("flower", 1, 2, 3, 4), ...f("season", 1, 2, 3, 4)], ["花草"])).toEqual(["八仙過海"]);
  });
  it("a draw that completes one charges the other three", () => {
    const wall = fullWall().filter((w) => !("bonus" in w));
    const bonus = (kind: "flower" | "season", rank: 1 | 2 | 3 | 4) => ({ bonus: { kind, rank } });
    // Seat 0 is dealt 1f 2f 3s at the start and 4s straight after.
    const s = dealHand({ dealer: 0, roundWind: 1, dealerStreak: 0 }, [bonus("flower", 1), bonus("flower", 2), bonus("season", 3), bonus("season", 4), ...wall]);
    expect(s.tableBonuses).toEqual([{ seat: 0, name: "草", deltas: [9, -3, -3, -3], paid: false }]);
  });
});

describe("7搶1 / 1搶7", () => {
  it("the eighth flower split seven and one: whoever drew it collects 30 off the other", () => {
    expect(flowerRobbery([1, 7, 0, 0], 1)).toEqual({ seat: 1, from: 0, name: "7搶1" });
    expect(flowerRobbery([1, 7, 0, 0], 0)).toEqual({ seat: 0, from: 1, name: "1搶7" });
    expect(flowerRobbery([1, 6, 0, 0], 1)).toBeNull();
    expect(flowerRobbery([2, 6, 0, 0], 1)).toBeNull();
    expect(flowerRobbery([0, 8, 0, 0], 1)).toBeNull();
  });
  it("is paid at the table by the one player", () => {
    const tiles = fullWall().filter((w) => !("bonus" in w));
    const b = (kind: "flower" | "season", rank: 1 | 2 | 3 | 4) => ({ bonus: { kind, rank } });
    // Seat 0 (dealer) draws 1f first; seat 1 then draws the other seven.
    const wall = [b("flower", 1), ...tiles.slice(0, 15), b("flower", 2), b("flower", 3), b("flower", 4), b("season", 1), b("season", 2), b("season", 3), b("season", 4), ...tiles.slice(15)];
    const s = dealHand({ dealer: 0, roundWind: 1, dealerStreak: 0 }, wall);
    expect(s.players.map((p) => p.flowers.length)).toEqual([1, 7, 0, 0]);
    expect(s.tableBonuses?.find((x) => x.name === "7搶1")).toEqual({ seat: 1, name: "7搶1", deltas: [-30, 30, 0, 0], paid: false });
  });
});


describe("暗槓", () => {
  it("declaring a concealed kong collects 5 from each player, every time", () => {
    const s0 = newGame();
    s0.tableBonuses = undefined;
    s0.phase = { kind: "turn", seat: 0, drawn: null, replacement: null };
    s0.players[0].hand = parseHand("1111m2222m333t55b789t");
    const s1 = applyTurnMove(s0, { kind: "concealedKong", tile: parseHand("1m")[0] });
    // (The replacement draw may bring flower bonuses of its own.)
    expect(s1.tableBonuses?.filter((b) => b.name === "暗槓")).toEqual([{ seat: 0, name: "暗槓", deltas: [15, -5, -5, -5], paid: false }]);
    if (s1.phase.kind !== "turn") throw new Error("still their turn");
    const s2 = applyTurnMove({ ...s1, phase: { ...s1.phase, seat: 0 } }, { kind: "concealedKong", tile: parseHand("2m")[0] });
    expect(s2.tableBonuses?.filter((b) => b.name === "暗槓")).toHaveLength(2);
  });
});

describe("追", () => {
  const throwAround = (s0: GameState, seats: number[], tile: string) => {
    let s = s0;
    for (const seat of seats) {
      const t = parseHand(tile)[0];
      s = { ...s, phase: { kind: "turn", seat, drawn: null, replacement: null } };
      s.players = s.players.map((p, i) => (i === seat ? { ...p, hand: [...p.hand, t], riichi: undefined } : p));
      s = applyTurnMove(s, { kind: "discard", tile: t });
    }
    return s;
  };
  const fresh = () => ({ ...newGame(), tableBonuses: undefined });
  it("the fourth in a row to throw the same tile pays the rest: 5 for an honour, 10 for m/t/b", () => {
    expect(throwAround(fresh(), [0, 1, 2, 3], "7z").tableBonuses).toEqual([{ seat: 3, name: "追", deltas: [5, 5, 5, -15], paid: false }]);
    expect(throwAround(fresh(), [2, 3, 0, 1], "5m").tableBonuses).toEqual([{ seat: 1, name: "追", deltas: [10, -30, 10, 10], paid: false }]);
  });
  it("needs four seats in turn and the same tile", () => {
    expect(throwAround(throwAround(fresh(), [0, 1, 2], "7z"), [3], "6z").tableBonuses).toBeUndefined();
    expect(throwAround(fresh(), [0, 1, 3, 0], "7z").tableBonuses).toBeUndefined();
  });
  it("a concealed kong along the way doesn't break the run", () => {
    let s = throwAround(fresh(), [0, 1], "7z");
    s = { ...s, phase: { kind: "turn", seat: 2, drawn: null, replacement: null } };
    s.players = s.players.map((p, i) => (i === 2 ? { ...p, hand: [...parseHand("1111m"), ...p.hand], riichi: undefined } : p));
    s = applyTurnMove(s, { kind: "concealedKong", tile: parseHand("1m")[0] });
    s = throwAround(s, [2, 3], "7z");
    expect(s.tableBonuses?.filter((b) => b.name === "追")).toEqual([{ seat: 3, name: "追", deltas: [5, 5, 5, -15], paid: false }]);
  });
});

describe("嗌錯", () => {
  it("takes back a call: the discard plays on as if passed, and the caller pays 5 to each", () => {
    const s0 = { ...newGame(), tableBonuses: undefined };
    s0.players[0].hand = parseHand("12345m111222333t55b");
    s0.players[1].hand = parseHand("46m111222333t12345b");
    const before = applyTurnMove({ ...s0, phase: { kind: "turn", seat: 0, drawn: null, replacement: null } }, { kind: "discard", tile: parseHand("5m")[0] });
    const [four, six] = parseHand("46m");
    const decisions: Parameters<typeof resolveClaims>[1] = [null, { kind: "chow", tiles: [four, six] }, null, null];
    expect(resolveClaims(before, decisions).players[1].melds).toHaveLength(1);
    const s = retractClaim(before, decisions, 1);
    expect(s.players[1].melds).toHaveLength(0);
    expect(s.players[0].discards.at(-1)).toEqual(parseHand("5m")[0]);
    expect(s.phase.kind === "turn" && s.phase.seat).toBe(1);
    expect(s.tableBonuses?.filter((b) => b.name === "嗌錯")).toEqual([{ seat: 1, name: "嗌錯", deltas: [5, -15, 5, 5], paid: false }]);
  });
});


describe("搶槓 (robbing a kong)", () => {
  // Seat 0 has a declared pung of 5m and has just drawn the fourth.
  // `waiting`: the seats that win on 5m (a 4-6m wait); the rest can't.
  const table = (waiting: number[], extra?: (s: GameState) => void): GameState => {
    const s = { ...newGame(), tableBonuses: undefined, chase: undefined };
    s.players = s.players.map((p) => ({ ...p, melds: [], flowers: [], discards: [], riichi: undefined }));
    s.players[0].melds = [{ kind: "triplet", tiles: [m(5), m(5), m(5)], concealed: false, from: 2 }];
    s.players[0].hand = parseHand("5m123456789t1122b");
    for (const seat of [1, 2, 3]) s.players[seat].hand = waiting.includes(seat) ? parseHand("46m111222333t456b77z") : parseHand("1357m1357t1357b1234z");
    s.phase = { kind: "turn", seat: 0, drawn: m(5), replacement: null };
    s.firstGoAround = false;
    extra?.(s);
    return s;
  };
  const addKong = (s: GameState) => applyTurnMove(s, { kind: "addedKong", tile: m(5) });

  it("lets anyone who'd win on the added tile take it - and only win", () => {
    const s = addKong(table([1], (s) => (s.players[3].hand = parseHand("55m1357t1357b1234z99t"))));
    expect(s.phase).toEqual({ kind: "claims", from: 0, tile: m(5), robKong: true });
    expect(claimOptions(s, 1)).toEqual([{ kind: "win" }]);
    expect(claimOptions(s, 3)).toEqual([]); // a pair of 5m: no pung on a kong being added
    // Nothing has happened to the kong player's pung yet, nor to anyone's pond.
    expect(s.players[0].melds[0].tiles).toHaveLength(3);
    expect(s.players[0].hand.some((t) => sameTile(t, m(5)))).toBe(false);
    expect(s.players.every((p) => p.discards.length === 0)).toBe(true);
  });

  it("scores a robbed win off the kong player, with 搶槓, and leaves the pung a pung", () => {
    const s = resolveClaims(addKong(table([1])), [null, { kind: "win" }, null, null]);
    if (s.phase.kind !== "over") throw new Error("the hand should be over");
    const { winner, from, tile, score, deltas } = s.phase.result;
    expect({ winner, from, tile }).toEqual({ winner: 1, from: 0, tile: m(5) });
    expect(s.phase.result.robKong).toBe(true);
    expect(score?.matched.map((x) => x.pattern.id)).toContain("rob-kong");
    expect(score?.matched.map((x) => x.pattern.id)).not.toContain("self-draw");
    expect(deltas[0]).toBeLessThan(0);
    expect(deltas[1]).toBe(-deltas[0]);
    expect(deltas[2]).toBe(0);
    expect(s.players[0].melds[0]).toMatchObject({ kind: "triplet", tiles: [m(5), m(5), m(5)] });
    expect(s.players[1].hand.filter((t) => sameTile(t, m(5)))).toHaveLength(1);
  });

  it("completes the kong with its replacement draw when no one robs it", () => {
    const s = resolveClaims(addKong(table([1])), [null, null, null, null]);
    expect(s.phase).toMatchObject({ kind: "turn", seat: 0 });
    if (s.phase.kind === "turn") expect(["kong", "flower"]).toContain(s.phase.replacement);
    expect(s.players[0].melds[0]).toMatchObject({ kind: "kong", tiles: [m(5), m(5), m(5), m(5)] });
  });

  it("doesn't stop at all when no one could win on the tile", () => {
    const s = addKong(table([]));
    expect(s.phase).toMatchObject({ kind: "turn", seat: 0 });
    expect(s.players[0].melds[0].kind).toBe("kong");
  });

  it("goes to the first robber in turn order, and ignores anything but a win", () => {
    const two = resolveClaims(addKong(table([2, 3])), [null, null, { kind: "win" }, { kind: "win" }]);
    expect(two.phase.kind === "over" && two.phase.result.winner).toBe(2);
    const pung = resolveClaims(addKong(table([1])), [null, null, null, { kind: "pung" }]);
    expect(pung.phase).toMatchObject({ kind: "turn", seat: 0 });
    expect(pung.players[0].melds[0].kind).toBe("kong");
  });

  it("never applies to a concealed kong", () => {
    const s = table([1], (s) => {
      s.players[0].melds = [];
      s.players[0].hand = parseHand("5555m123456789t1122b");
    });
    expect(applyTurnMove(s, { kind: "concealedKong", tile: m(5) }).phase).toMatchObject({ kind: "turn", seat: 0 });
  });

  it("is taken by a bot that can win, and played through by bot-only hands", () => {
    expect(botClaim(addKong(table([1])), 1)).toEqual({ kind: "win" });
    // (These made-up tables don't hold all 144 tiles, so not playOut's checks.)
    for (const start of [addKong(table([1])), addKong(table([]))]) {
      let s = start;
      for (let k = 0; k < 1000 && s.phase.kind !== "over"; k++)
        s = s.phase.kind === "turn" ? applyTurnMove(s, botTurnMove(s)) : resolveClaims(s, Array.from({ length: SEATS }, (_, i) => botClaim(s, i)));
      expect(s.phase.kind).toBe("over");
    }
  });
});

describe("一炮多響 (several winners off one discard)", () => {
  // Seat 0 has just discarded 5m; `waiting` win on it (a 4-6m wait).
  const table = (waiting: number[], multiWin: boolean, dealer = 3): GameState => {
    const s = { ...newGame(), tableBonuses: undefined, chase: undefined, dealer, multiWin };
    s.players = s.players.map((p) => ({ ...p, melds: [], flowers: [], discards: [], riichi: undefined }));
    for (const seat of [1, 2, 3]) s.players[seat].hand = waiting.includes(seat) ? parseHand("46m111222333t456b77z") : parseHand("1357m1357t1357b1234z");
    s.players[0].hand = parseHand("123456789t1122b3b");
    s.players[0].discards = [m(5)];
    s.phase = { kind: "claims", from: 0, tile: m(5) };
    s.firstGoAround = false;
    return s;
  };
  const allWin = (seats: number[]) => Array.from({ length: SEATS }, (_, i) => (seats.includes(i) ? ({ kind: "win" } as const) : null));
  const ids = (score: { matched: { pattern: { id: string } }[] } | null) => score?.matched.map((x) => x.pattern.id) ?? [];

  it("is off by default: two wins, the first in turn order takes it (截胡)", () => {
    const s = resolveClaims(table([1, 2], false), allWin([1, 2]));
    if (s.phase.kind !== "over") throw new Error("over");
    expect(s.phase.result.winner).toBe(1);
    expect(s.phase.result.alsoWon).toBeUndefined();
    expect(s.phase.result.deltas[2]).toBe(0);
  });

  it("pays every winner when on - 雙響", () => {
    const s = resolveClaims(table([1, 2], true), allWin([1, 2]));
    if (s.phase.kind !== "over") throw new Error("over");
    const r = s.phase.result;
    expect(r.winner).toBe(1);
    expect(r.alsoWon?.map((w) => w.winner)).toEqual([2]);
    expect(ids(r.score)).toContain("multi-win-double");
    expect(ids(r.alsoWon![0].score)).toContain("multi-win-double");
    expect(r.deltas[1]).toBeGreaterThan(0);
    expect(r.deltas[2]).toBeGreaterThan(0);
    expect(r.deltas[0]).toBe(-(r.deltas[1] + r.deltas[2]));
    expect(r.deltas[3]).toBe(0);
    expect(r.pairs?.map((p) => [p.winner, p.payer])).toEqual([["1", "0"], ["2", "0"]]);
    // Each winner has the tile; the discard has left the pond.
    expect(s.players[1].hand.filter((t) => sameTile(t, m(5)))).toHaveLength(1);
    expect(s.players[2].hand.filter((t) => sameTile(t, m(5)))).toHaveLength(1);
    expect(s.players[0].discards).toEqual([]);
  });

  it("scores three winners as 三響, and still only pays those who called", () => {
    const three = resolveClaims(table([1, 2, 3], true), allWin([1, 2, 3]));
    if (three.phase.kind !== "over") throw new Error("over");
    expect([three.phase.result.winner, ...three.phase.result.alsoWon!.map((w) => w.winner)]).toEqual([1, 2, 3]);
    expect(ids(three.phase.result.score)).toContain("multi-win-triple");
    // One who could win but passes isn't paid.
    const passed = resolveClaims(table([1, 2, 3], true), allWin([1, 3]));
    if (passed.phase.kind !== "over") throw new Error("over");
    expect([passed.phase.result.winner, ...passed.phase.result.alsoWon!.map((w) => w.winner)]).toEqual([1, 3]);
    expect(passed.phase.result.deltas[2]).toBe(0);
  });

  it("keeps the deal when the dealer is among the winners, passes it otherwise, and carries the setting", () => {
    const dealerWins = resolveClaims(table([1, 2], true, 2), allWin([1, 2]));
    const next = nextHand(dealerWins);
    expect(next.dealer).toBe(2);
    expect(next.dealerStreak).toBe(1);
    expect(next.multiWin).toBe(true);
    const otherWins = nextHand(resolveClaims(table([1, 2], true, 3), allWin([1, 2])));
    expect(otherWins.dealer).toBe(0);
  });

  it("lets two players rob the same kong", () => {
    const s = { ...table([1, 2], true), phase: { kind: "turn" as const, seat: 0, drawn: m(5), replacement: null } };
    s.players = s.players.map((p, i) => (i === 0 ? { ...p, discards: [], melds: [{ kind: "triplet" as const, tiles: [m(5), m(5), m(5)], concealed: false, from: 2 }], hand: parseHand("5m123456789t1122b") } : p));
    const robbing = applyTurnMove(s, { kind: "addedKong", tile: m(5) });
    const done = resolveClaims(robbing, allWin([1, 2]));
    if (done.phase.kind !== "over") throw new Error("over");
    expect(done.phase.result.robKong).toBe(true);
    expect(done.phase.result.alsoWon?.map((w) => w.winner)).toEqual([2]);
    expect(ids(done.phase.result.score)).toEqual(expect.arrayContaining(["rob-kong", "multi-win-double"]));
  });
});
