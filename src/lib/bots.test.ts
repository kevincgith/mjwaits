import { describe, expect, it } from "vitest";
import { BOT_PROFILES, botSurrenders, botThoughts, dealInStake, inMood, thoughtLine, botClaimFor, botTurnFor, botTurnMoveFor, danger, longShotChance, profileById, rateDiscardsFor, rememberedView, seededRng, specialRoutes, sureSafe, threat, tileRisk, SPEECH, speechOf, type BotProfile } from "@mjwaits/shared/engine/bots";
import { runArena } from "./arena";
import { applyTurnMove, feelAfter, nextHand, NO_FEEL, dealHand, resolveClaims, secondChanceFan, SEATS, unseenCounts, type GameMeld, type GameState } from "@mjwaits/shared/engine/game";
import { allTileKinds, parseHand, specialDistances, tileKey, type Tile } from "@mjwaits/shared/engine/mahjong";
import { viewFor } from "@mjwaits/shared/engine/view";

const t = (suit: Tile["suit"], rank: number): Tile => ({ suit, rank });

function withPlayer(s: GameState, seat: number, patch: Partial<GameState["players"][number]>): GameState {
  return { ...s, players: s.players.map((p, i) => (i === seat ? { ...p, ...patch } : p)) };
}

describe("threat", () => {
  const base = dealHand({ dealer: 0, roundWind: 1, dealerStreak: 0 });
  const meld: GameMeld = { kind: "triplet", tiles: [t("m", 5), t("m", 5), t("m", 5)], concealed: false, from: 0 };
  const pond = Array.from({ length: 10 }, (_, i) => t("t", (i % 9) + 1));

  it("rises with discards and with called melds", () => {
    const early = threat(base, 1, 1);
    const late = threat(withPlayer(base, 1, { discards: pond }), 1, 1);
    const lateOpen = threat(withPlayer(base, 1, { discards: pond, melds: [meld, meld] }), 1, 1);
    expect(early).toBeLessThan(0.05);
    expect(late).toBeGreaterThan(early);
    expect(lateOpen).toBeGreaterThan(0.4);
  });
});

describe("tileRisk", () => {
  const s = dealHand({ dealer: 0, roundWind: 1, dealerStreak: 0 });

  it("knows a dead honour is near-safe and a middle tile isn't", () => {
    const unseen = unseenCounts(s, 0);
    unseen.set("z5", 0);
    expect(tileRisk(s, 0, 1, t("z", 5), 1, unseen)).toBeLessThan(0.05);
    expect(tileRisk(s, 0, 1, t("m", 5), 1, unseen)).toBeGreaterThan(0.5);
  });

  it("reads a wall (壁): no 4s left makes 3 safer", () => {
    const unseen = unseenCounts(s, 0);
    const open = tileRisk(s, 0, 1, t("b", 3), 1, unseen);
    unseen.set("b4", 0);
    unseen.set("b2", 0);
    expect(tileRisk(s, 0, 1, t("b", 3), 1, unseen)).toBeLessThan(open);
  });

  it("finds a tile an opponent threw safer than a fresh one", () => {
    const s2 = withPlayer(s, 1, { discards: [t("m", 6)] });
    const unseen = unseenCounts(s2, 0);
    expect(tileRisk(s2, 0, 1, t("m", 6), 1, unseen)).toBeLessThan(tileRisk(s2, 0, 1, t("m", 4), 1, unseen));
  });

  it("weighs danger by how threatening the table is", () => {
    const meld: GameMeld = { kind: "run", tiles: [t("t", 1), t("t", 2), t("t", 3)], concealed: false, from: 0 };
    const pond = Array.from({ length: 12 }, () => t("z", 1));
    const calm = danger(s, 0, t("m", 5), 1, unseenCounts(s, 0));
    const hot = withPlayer(s, 1, { melds: [meld, meld, meld], discards: pond });
    expect(danger(hot, 0, t("m", 5), 1, unseenCounts(hot, 0))).toBeGreaterThan(calm);
  });
});

describe("decisions", () => {
  // A full hand per profile is slow, so each plays the opening 40 steps
  // (applyTurnMove throws on anything illegal) and the arena test below
  // covers whole hands.
  it("every profile makes only legal moves", () => {
    for (const profile of BOT_PROFILES) {
      const rng = seededRng(7);
      let s = dealHand({ dealer: 0, roundWind: 1, dealerStreak: 0 });
      for (let steps = 0; s.phase.kind !== "over" && steps < 40; steps++) {
        s =
          s.phase.kind === "turn"
            ? applyTurnMove(s, botTurnMoveFor(s, profile, rng))
            : resolveClaims(
                s,
                Array.from({ length: SEATS }, (_, i) => botClaimFor(s, i, profile, rng))
              );
      }
      expect(s.players.every((p) => p.hand.length + p.melds.length * 3 >= 16)).toBe(true);
    }
  }, 60_000);

  it("looks profiles up by id, falling back to the Veteran", () => {
    expect(profileById("hunter").id).toBe("hunter");
    expect(profileById("nobody").id).toBe("veteran");
  });
});

describe("arena", () => {
  it("plays each wall under four seatings and balances the books", () => {
    const bots = ["veteran", "speedster", "hunter", "wall"].map(profileById);
    const r = runArena(bots, 1, 3);
    expect(r.hands).toBe(4);
    expect(r.stats.every((s) => s.hands === 4)).toBe(true);
    const won = r.stats.reduce((n, s) => n + s.taiWon, 0);
    const lost = r.stats.reduce((n, s) => n + s.taiLost, 0);
    expect(won).toBe(lost);
    // Repeatable for a seed.
    expect(runArena(bots, 1, 3).stats).toEqual(r.stats);
  }, 120_000);
});

describe("human touches", () => {
  it("rates how hard a turn was, 0..1, and an obvious one as easy", () => {
    const s = dealHand({ dealer: 0, roundWind: 1, dealerStreak: 0 });
    const { move, difficulty } = botTurnFor(s, profileById("veteran"), seededRng(2));
    expect(move.kind).toBeDefined();
    expect(difficulty).toBeGreaterThanOrEqual(0);
    expect(difficulty).toBeLessThanOrEqual(1);
  });

  it("gives every personality speech bubbles for every moment", () => {
    for (const p of BOT_PROFILES) {
      const v = speechOf(p);
      expect(SPEECH[p.id]).toBeDefined();
      for (const lines of Object.values(v)) expect(lines.length).toBeGreaterThan(0);
    }
  });

  it("forgets old discards with a short memory, never its own", () => {
    const s0 = dealHand({ dealer: 0, roundWind: 1, dealerStreak: 0 });
    const pond = Array.from({ length: 15 }, (_, i) => t("t", (i % 9) + 1));
    const s = { ...s0, players: s0.players.map((p) => ({ ...p, discards: pond })) };
    const view = rememberedView(s, 0, 0);
    expect(view.players[0].discards).toHaveLength(15);
    expect(view.players[1].discards).toHaveLength(3);
    expect(view.players[1].discards).toEqual(pond.slice(-3));
    expect(rememberedView(s, 0, 1)).toBe(s);
  });
});

describe("the online table's bots", () => {
  it("are exactly the roster's personalities (the basic bot aside)", async () => {
    const { TABLE_BOTS } = await import("@mjwaits/shared/protocol/table");
    expect([...TABLE_BOTS].sort()).toEqual(BOT_PROFILES.map((p) => p.id).filter((id) => id !== "basic").sort());
  });
});

describe("kongs a person would make", () => {
  const t = (suit: Tile["suit"], rank: number) => ({ suit, rank }) as Tile;
  const z5 = t("z", 5);
  // Seat 1 holds three 5z; seat 0 throws the fourth... seat 1 punges, and keeps one.
  const afterPung = (): GameState => {
    const s0 = dealHand({ dealer: 0, roundWind: 1, dealerStreak: 0 });
    s0.players[1].hand = [z5, z5, z5, ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((r) => t("m", r)), t("t", 1), t("t", 2), t("t", 3), t("b", 9)];
    s0.players[0].hand = [...s0.players[0].hand.slice(1), z5];
    s0.phase = { kind: "turn", seat: 0, drawn: null, replacement: null };
    const s = applyTurnMove(s0, { kind: "discard", tile: z5 });
    return resolveClaims(s, [null, { kind: "pung" }, null, null]);
  };

  it("never 加槓 straight after its pung - with the fourth it kept", () => {
    const s = afterPung();
    expect(s.phase).toMatchObject({ kind: "turn", seat: 1, drawn: null });
    for (const p of BOT_PROFILES) for (let i = 0; i < 20; i++) expect(botTurnFor(s, p, seededRng(i)).move.kind, p.id).not.toBe("addedKong");
  });

  it("but 加槓 with the fourth when it draws it later", () => {
    const s = afterPung();
    const p1 = s.players[1];
    // Its kept 5z thrown, and a 5z drawn on a later turn.
    const later: GameState = { ...s, players: s.players.map((p, i) => (i === 1 ? { ...p1, hand: [...p1.hand.filter((x) => !(x.suit === "z" && x.rank === 5)), z5] } : p)), phase: { kind: "turn", seat: 1, drawn: z5, replacement: null } };
    expect(botTurnFor(later, profileById("veteran"), seededRng(1)).move).toEqual({ kind: "addedKong", tile: z5 });
  });
});

describe("special hands: how far a bot will chase them", () => {
  const tester = (over: Partial<BotProfile> = {}): BotProfile => ({ ...profileById("veteran"), longShot: 0.6, longShotFade: 0.5, longShotReach: 2, ...over });
  const allLeft = () => new Map(allTileKinds().map((k) => [tileKey(k), 4]));
  const base = dealHand({ dealer: 0, roundWind: 1, dealerStreak: 0 });
  const routes = (hand: Tile[], mood: number, profile = tester(), unseen = allLeft(), melds: GameMeld[] = []) =>
    specialRoutes(withPlayer({ ...base, moods: [0, mood, 0, 0] }, 1, { hand, melds }), 1, profile, unseen);

  const pairsOneAway = parseHand("11223344m5566t77b1z2z");
  const pairsTwoAway = parseHand("1122m3344t5566b7z8m9m1b");
  const sixteenReady = parseHand("147m147t147b123456z1m");
  const orphansReady = parseHand("19m19t19b1234567z1m23m");
  const orphansOneAway = parseHand("19m19t19b12345z1m234m9m");

  it("measures the distance to each one", () => {
    expect(specialDistances(pairsOneAway).pairs).toBe(1);
    expect(specialDistances(pairsTwoAway).pairs).toBe(2);
    expect(specialDistances(sixteenReady).sixteen).toBe(0);
    expect(specialDistances(orphansReady).orphans).toBe(0);
    expect(specialDistances(orphansOneAway).orphans).toBe(1);
  });

  it("fades with distance, and stops past the bot's reach", () => {
    const p = tester();
    expect(longShotChance(p, 0)).toBe(1);
    expect(longShotChance(p, -1)).toBe(1);
    expect(longShotChance(p, 1)).toBeCloseTo(0.6);
    expect(longShotChance(p, 2)).toBeCloseTo(0.3);
    expect(longShotChance(p, 3)).toBe(0);
  });

  it("counts one only when this hand's mood is under the chance", () => {
    expect(routes(pairsOneAway, 0.5).pairs).toBe(true);
    expect(routes(pairsOneAway, 0.7).pairs).toBe(false);
  });

  it("can come round to one as the hand gets closer", () => {
    expect(routes(pairsTwoAway, 0.5).pairs).toBe(false);
    expect(routes(pairsOneAway, 0.5).pairs).toBe(true);
  });

  it("always counts one that's ready, whatever the mood", () => {
    expect(routes(sixteenReady, 0.99).sixteen).toBe(true);
    expect(routes(orphansReady, 0.99).orphans).toBe(true);
  });

  it("drops them all once it has called", () => {
    const meld: GameMeld = { kind: "triplet", tiles: [t("m", 5), t("m", 5), t("m", 5)], concealed: false, from: 0 };
    expect(routes(pairsOneAway.slice(0, 13), 0, tester(), allLeft(), [meld])).toEqual({ sixteen: false, pairs: false, orphans: false });
  });

  it("gives up once a kind it still needs is gone", () => {
    const noWhite = allLeft();
    noWhite.set("z7", 0);
    expect(routes(sixteenReady, 0, tester(), noWhite).sixteen).toBe(false);
    expect(routes(orphansOneAway, 0, tester(), noWhite).orphans).toBe(false);
    // (One it already holds doesn't matter.)
    const noEast = allLeft();
    noEast.set("z1", 0);
    expect(routes(sixteenReady, 0, tester(), noEast).sixteen).toBe(true);
    expect(routes(orphansOneAway, 0, tester(), noEast).orphans).toBe(true);
  });

  it("suits each personality", () => {
    const chance = (id: string, away: number) => longShotChance(profileById(id), away);
    expect(chance("gambler", 3)).toBeGreaterThan(chance("veteran", 3));
    expect(chance("hunter", 4)).toBeGreaterThan(0);
    expect(chance("gambler", 4)).toBeGreaterThan(0);
    for (const id of ["speedster", "casual"]) expect(chance(id, 3)).toBe(0);
    for (const id of ["grandmaster", "veteran", "wall"]) expect(chance(id, 4)).toBe(0);
    for (const p of BOT_PROFILES) for (let away = 1; away < 6; away++) expect(longShotChance(p, away + 1)).toBeLessThanOrEqual(longShotChance(p, away));
  });

  it("doesn't count the shape as close for a bot that wouldn't go for it", () => {
    const hand = parseHand("156b158m259t12234577z");
    const s = withPlayer({ ...base, moods: [0.5, 0.5, 0.5, 0.5], phase: { ...base.phase, kind: "turn", seat: 1 } as GameState["phase"] }, 1, { hand, melds: [], discards: [] });
    const best = (p: BotProfile) => Math.min(...rateDiscardsFor(s, 1, p).map((o) => o.shanten));
    expect(best(tester({ longShot: 1, longShotFade: 1, longShotReach: 16 }))).toBeLessThan(best(tester({ longShotReach: 0 })));
  });

  it("draws a mood for each seat at the deal, and keeps it off the phones", () => {
    const dealt = dealHand({ dealer: 0, roundWind: 1, dealerStreak: 0 }, undefined, seededRng(7));
    expect(dealt.moods).toHaveLength(SEATS);
    for (const m of dealt.moods!) expect(m >= 0 && m < 1).toBe(true);
    expect(dealHand({ dealer: 0, roundWind: 1, dealerStreak: 0 }, undefined, seededRng(7)).moods).toEqual(dealt.moods);
    expect(JSON.stringify(viewFor(dealt, 0))).not.toContain(String(dealt.moods![1]));
    expect(JSON.stringify(viewFor(dealt, 0))).not.toContain("moods");
  });

  it("plays a hand dealt before moods existed", () => {
    const old: GameState = { ...base };
    delete old.moods;
    expect(() => specialRoutes(old, 1, tester(), allLeft())).not.toThrow();
  });
});

describe("a bot's minimum for a win", () => {
  it("counts the win as the table would score it - the tile it's won off out of the pond", () => {
    // Seat 1 is ready on 5b, and seat 0 throws it: the fifth tile in the
    // ponds, so the fourth once it's taken - a 四子內 win.
    const base = dealHand({ dealer: 0, roundWind: 1, dealerStreak: 0 });
    const tile = t("b", 5);
    const pond = [t("z", 1), t("z", 2), t("z", 3), tile];
    let s: GameState = { ...base, discardsMade: 5, firstGoAround: false, phase: { kind: "claims", from: 0, tile } };
    s = withPlayer(s, 0, { discards: pond });
    // (Seat 1 has thrown a tile of its own: no 人胡.)
    s = withPlayer(s, 1, { hand: parseHand("123456789m123456t5b"), melds: [], discards: [t("z", 4)], flowers: [] });
    for (const seat of [2, 3]) s = withPlayer(s, seat, { discards: [] });
    const worth = secondChanceFan(s, 1, 0)!;
    // (With one more in the pond - as the tile, left there, would make it - it's 七子內: worth less.)
    const stale = secondChanceFan(withPlayer(s, 0, { discards: [...pond, tile] }), 1, 0)!;
    expect(worth).toBeGreaterThan(stale);
    // A bot that wants exactly what it's worth takes it; one that wants more lets it by.
    const wants = (minTai: number): BotProfile => ({ ...profileById("hunter"), minTai });
    expect(botClaimFor(s, 1, wants(worth), seededRng(1))).toEqual({ kind: "win" });
    expect(botClaimFor(s, 1, wants(worth + 1), seededRng(1))).toBeNull();
  });
});

describe("the bots' fixes", () => {
  const base = dealHand({ dealer: 0, roundWind: 1, dealerStreak: 0 });
  const turn = (hand: string, drawn: Tile, melds: GameMeld[] = []): GameState => ({
    ...withPlayer(base, 0, { hand: [...parseHand(hand), drawn], melds, flowers: [] }),
    phase: { kind: "turn", seat: 0, drawn, replacement: null },
  });
  const pung = (tile: Tile, from = 1): GameMeld => ({ kind: "triplet", tiles: [tile, tile, tile], concealed: false, from });
  const declared = { state: "riichi" as const, discard: 2, ippatsu: false, ponds: [3, 2, 1, 0], melds: [0, 0, 0, 0] };

  it("a tile thrown since a 叮 was declared is safe against it - if remembered", () => {
    let s = withPlayer(base, 1, { riichi: declared, discards: [t("z", 1), t("z", 2), t("b", 5)] });
    s = withPlayer(s, 0, { discards: [t("m", 1), t("m", 2), t("m", 3), t("t", 5)] });
    s = withPlayer(s, 2, { discards: [t("b", 1), t("b", 2), t("b", 3), t("b", 4), t("b", 6), t("b", 7), t("b", 8)] });
    expect(sureSafe(s, 1, t("t", 5))).toBe(true); // thrown after
    expect(sureSafe(s, 1, t("b", 5))).toBe(true); // its own declaring discard
    expect(sureSafe(s, 1, t("m", 3))).toBe(false); // thrown before
    expect(sureSafe(s, 1, t("z", 1))).toBe(false); // its own, before (no 振聽 here)
    expect(sureSafe(s, 2, t("t", 5))).toBe(false); // and only against the 叮
    const unseen = unseenCounts(s, 3);
    expect(danger(s, 3, t("t", 5), 1, unseen, 0.99)).toBe(0);
    expect(danger(s, 3, t("t", 6), 1, unseen, 0.99)).toBeGreaterThan(0);
    // Seat 2's 2b went by the 叮 too - but a short memory has lost it.
    expect(sureSafe(s, 1, t("b", 2))).toBe(true);
    expect(sureSafe(s, 1, t("b", 2), rememberedView(s, 3, 0))).toBe(false);
  });

  it("the discard that's just gone by unclaimed is safe against everyone", () => {
    const s: GameState = { ...turn("123456789m123456t5b", t("z", 1)), chase: { seat: 3, tile: t("b", 9), run: 1 } };
    for (const o of [1, 2, 3]) expect(sureSafe(s, o, t("b", 9))).toBe(true);
    expect(sureSafe(s, 1, t("b", 8))).toBe(false);
  });

  it("a lazy throw never breaks up a ready hand", () => {
    // Ready by throwing 東 or 5b; anything else sets it back.
    const s = turn("123456789m123456t5b", t("z", 1));
    const lazy: BotProfile = { ...profileById("casual"), slip: 1, riichi: 0 };
    for (let seed = 1; seed <= 20; seed++) {
      const m = botTurnFor(s, lazy, seededRng(seed)).move;
      expect(m.kind === "discard" && ["z1", "b5"].includes(tileKey(m.tile))).toBe(true);
    }
  });

  it("a 叮 hand takes any win: passing would kill it", () => {
    let s: GameState = { ...base, phase: { kind: "claims", from: 0, tile: t("b", 5) } };
    s = withPlayer(s, 0, { discards: [t("b", 5)] });
    s = withPlayer(s, 1, { hand: parseHand("123456789m123456t5b"), melds: [], flowers: [], discards: [t("z", 4)] });
    const picky: BotProfile = { ...profileById("hunter"), minTai: 500 };
    expect(botClaimFor(s, 1, picky, seededRng(1))).toBeNull();
    expect(botClaimFor(withPlayer(s, 1, { ...s.players[1], riichi: { ...declared, discard: 0, ponds: [0, 0, 0, 0] } }), 1, picky, seededRng(1))).toEqual({ kind: "win" });
  });

  it("an added kong: not with a tile the hand needs", () => {
    const gambler = profileById("gambler");
    // 5m fills 4m-6m: kept, the hand is ready.
    const needed = botTurnFor(turn("46m123456t78t99b" + "1z", t("m", 5), [pung(t("m", 5))]), gambler, seededRng(1)).move;
    expect(needed.kind).toBe("discard");
    // Nothing to do with it in hand: the kong.
    const spare = botTurnFor(turn("123456789t99b1b" + "1z", t("m", 5), [pung(t("m", 5))]), gambler, seededRng(1)).move;
    expect(spare).toEqual({ kind: "addedKong", tile: t("m", 5) });
  });

  it("a run isn't called for a throw 食替 bars", () => {
    // Ready. 7m taken with 56m would need 4m thrown to stay ready - barred.
    let s: GameState = { ...base, phase: { kind: "claims", from: 0, tile: t("m", 7) } };
    s = withPlayer(s, 0, { discards: [t("m", 7)] });
    s = withPlayer(s, 1, { hand: parseHand("456m123456t77t88b"), melds: [pung(t("z", 5), 2)], flowers: [], discards: [] });
    const lazy: BotProfile = { ...profileById("casual"), slip: 1 };
    expect(botClaimFor(s, 1, lazy, seededRng(1))).toBeNull();
  });
});

describe("how the game's going", () => {
  const base = dealHand({ dealer: 0, roundWind: 1, dealerStreak: 0 });
  const over = (winner: number | null, from: number | null, deltas: number[], feel = NO_FEEL()): GameState => ({
    ...base,
    feel,
    phase: { kind: "over", result: { winner, from, tile: null, score: null, scoreError: null, deltas } },
  });

  it("a deal-in leaves the payer sore at the winner, and both their form moved - fading hand by hand", () => {
    const one = feelAfter(over(1, 0, [-40, 40, 0, 0]));
    expect(one.sore[0][1]).toBeCloseTo(0.6);
    expect(one.sore[2][1]).toBe(0);
    expect(one.form[0]).toBeCloseTo(-0.5);
    expect(one.form[1]).toBeCloseTo(0.5);
    const two = feelAfter(over(null, null, [0, 0, 0, 0], one));
    expect(two.sore[0][1]).toBeCloseTo(0.42);
    expect(two.form[0]).toBeCloseTo(-0.325);
    // Winning it back settles most of it.
    const back = feelAfter(over(0, 1, [40, -40, 0, 0], one));
    expect(back.sore[0][1]).toBeLessThan(0.2);
    // A self-draw: everyone a little sore.
    expect(feelAfter(over(2, null, [-20, -20, 60, -20])).sore.map((row) => row[2])).toEqual([0.15, 0.15, 0, 0.15]);
  });

  it("is carried to the next hand", () => {
    expect(nextHand(over(1, 0, [-40, 40, 0, 0])).feel?.sore[0][1]).toBeCloseTo(0.6);
  });

  it("moves a bot with a temper - and not one without", () => {
    const losing: GameState = { ...base, feel: { ...NO_FEEL(), form: [-1, -0.1, 1, 0] } };
    const wall = profileById("wall");
    expect(inMood(wall, losing, 0).riichi).toBeGreaterThan(wall.riichi); // behind: has to come out
    expect(inMood(wall, losing, 2).caution).toBeGreaterThan(wall.caution); // ahead: sits on it
    expect(inMood(wall, losing, 1)).toBe(wall); // a small swing: as ever
    expect(inMood(wall, losing, 3)).toBe(wall);
    const gm = profileById("grandmaster");
    expect(inMood(gm, losing, 0)).toBe(gm);
    // Never out of range.
    for (const p of BOT_PROFILES) for (const seat of [0, 2]) {
      const m = inMood(p, losing, seat);
      expect(m.caution).toBeGreaterThanOrEqual(0);
      expect(m.caution).toBeLessThanOrEqual(1);
      expect(m.callAppetite).toBeLessThanOrEqual(1);
      expect(m.minTai).toBeGreaterThanOrEqual(0);
    }
  });

  it("a grudge: feeding them again costs more, and their 拉 is given up less readily", () => {
    const feel = NO_FEEL();
    feel.sore[0][1] = 0.8;
    const s: GameState = { ...base, feel };
    expect(dealInStake(s, 0, 1, 1, 0.9)).toBeGreaterThan(dealInStake(s, 0, 2, 1, 0.9));
    expect(dealInStake(s, 0, 1, 1, 0)).toBe(dealInStake(s, 0, 2, 1, 0));
    const lah = { holder: "1", pulled: "0", count: 3, value: 100, lastWin: true };
    const between: GameState = { ...over(1, 0, [-40, 40, 0, 0]), lahs: [lah] as GameState["lahs"] };
    const eager: BotProfile = { ...profileById("wall"), surrender: 0.6, grudge: 0 };
    if (botSurrenders(between, 0, eager).length) {
      expect(botSurrenders({ ...between, feel }, 0, { ...eager, grudge: 1 })).toEqual([]);
    }
  });
});

describe("after the hand: what a bot was up to", () => {
  const base = dealHand({ dealer: 0, roundWind: 1, dealerStreak: 0 });
  const ended = (patch: Partial<GameState["players"][number]>, feel?: GameState["feel"]): GameState => ({
    ...withPlayer(base, 1, { melds: [], flowers: [], discards: [], ...patch }),
    ...(feel ? { feel } : {}),
    phase: { kind: "over", result: { winner: null, from: null, tile: null, score: null, scoreError: null, deltas: [0, 0, 0, 0] } },
  });
  const name = (seat: number) => ["you", "A", "B", "C"][seat];

  it("a ready hand: its waits, and how many were left", () => {
    const [t1] = botThoughts(ended({ hand: parseHand("123456789m123456t5b") }), 1, null);
    expect(t1.kind).toBe("ready");
    expect(thoughtLine(t1, name)).toMatch(/^Ready, waiting on 5索 - \d left$/);
  });

  it("a win let go by", () => {
    const all = botThoughts(ended({ hand: parseHand("123456789m123456t5b"), overWater: true }), 1, null);
    expect(all[0]).toEqual({ kind: "passed" });
  });

  it("a hand far off: how far, and what it was building", () => {
    const flush = botThoughts(ended({ hand: parseHand("134679m1z"), melds: [2, 5, 8].map((r): GameMeld => ({ kind: "triplet", tiles: [t("m", r), t("m", r), t("m", r)], concealed: false, from: 0 })) }), 1, null).find((t) => t.kind === "away");
    expect(flush && flush.kind === "away" && flush.aim).toBe("flush");
    expect(thoughtLine(flush!, name)).toMatch(/from ready, building a flush$/);
  });

  it("the winner's, a hidden hand's: nothing", () => {
    const s = ended({ hand: parseHand("123456789m123456t5b") });
    expect(botThoughts({ ...s, phase: { kind: "over", result: { winner: 1, from: null, tile: null, score: null, scoreError: null, deltas: [0, 0, 0, 0] } } }, 1, null)).toEqual([]);
    expect(botThoughts(ended({ hand: Array.from({ length: 16 }, () => t("m", 0)) }), 1, null)).toEqual([]);
  });

  it("its temper and its grudges - only where its personality is known", () => {
    const feel = NO_FEEL();
    feel.form[1] = -0.9;
    feel.sore[1][0] = 0.9;
    const s = ended({ hand: parseHand("147m258t369b12345z19m") }, feel);
    const kinds = (p: BotProfile | null) => botThoughts(s, 1, p).map((t) => t.kind);
    expect(kinds(profileById("gambler"))).toEqual(expect.arrayContaining(["mood", "sore"]));
    expect(kinds(null)).not.toEqual(expect.arrayContaining(["mood"]));
    expect(kinds(null)).not.toEqual(expect.arrayContaining(["sore"]));
    expect(thoughtLine({ kind: "sore", at: 0 }, name)).toBe("Had a score to settle with you");
  });
});
