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
  settleWin,
  lahAddOn,
  surrender,
  surrenderable,
  wallBreak,
  diceBonus,
  dealHand,
  flowerBonus,
  flowerRobbery,
  fullWall,
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
