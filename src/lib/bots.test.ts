import { describe, expect, it } from "vitest";
import { BOT_PROFILES, botClaimFor, botTurnFor, botTurnMoveFor, danger, profileById, rememberedView, seededRng, threat, tileRisk, VOICES, voiceOf } from "@mjwaits/shared/engine/bots";
import { runArena } from "./arena";
import { applyTurnMove, dealHand, resolveClaims, SEATS, unseenCounts, type GameMeld, type GameState } from "@mjwaits/shared/engine/game";
import type { Tile } from "@mjwaits/shared/engine/mahjong";

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

  it("gives every personality a voice for every moment", () => {
    for (const p of BOT_PROFILES) {
      const v = voiceOf(p);
      expect(VOICES[p.id]).toBeDefined();
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
