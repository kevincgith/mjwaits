import { describe, expect, it } from "vitest";
import { applyTurnMove, botClaim, botTurnMove, dealHand, resolveClaims, SEATS, type GameState, type WallTile } from "./game";
import type { Tile } from "./mahjong";
import { viewFor } from "./view";

// A seeded random source, so a failure can be replayed.
function seeded(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Every state of some bot-played hands, start to finish.
function playedStates(hands: number, seed: number): GameState[] {
  const random = seeded(seed);
  const out: GameState[] = [];
  for (let h = 0; h < hands; h++) {
    let s = dealHand({ dealer: h % SEATS, roundWind: 1, dealerStreak: 0 }, undefined, random);
    for (let k = 0; k < 2000; k++) {
      out.push(s);
      if (s.phase.kind === "over") break;
      s = s.phase.kind === "turn" ? applyTurnMove(s, botTurnMove(s)) : resolveClaims(s, Array.from({ length: SEATS }, (_, i) => botClaim(s, i)));
    }
  }
  return out;
}

// The same table with everything `viewer` can't see dealt out again: the
// wall and the other hands' tiles shuffled together and handed back in the
// same numbers. Nothing a fair view shows may change.
function reshuffleHidden(s: GameState, viewer: number, random: () => number): GameState {
  const hidden: WallTile[] = [...s.wall];
  for (const [seat, p] of s.players.entries()) if (seat !== viewer) hidden.push(...p.hand.map((tile) => ({ tile })));
  for (let i = hidden.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [hidden[i], hidden[j]] = [hidden[j], hidden[i]];
  }
  // Bonus tiles can't go into a hand: keep them in the wall.
  const tiles = hidden.filter((w): w is { tile: Tile } => "tile" in w);
  const bonuses = hidden.filter((w) => "bonus" in w);
  const players = s.players.map((p, seat) => (seat === viewer ? p : { ...p, hand: tiles.splice(0, p.hand.length).map((w) => w.tile) }));
  const wall = [...tiles, ...bonuses];
  for (let i = wall.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [wall[i], wall[j]] = [wall[j], wall[i]];
  }
  // Someone else's just-drawn tile is one of their (now different) tiles too.
  const phase = s.phase.kind === "turn" && s.phase.seat !== viewer && s.phase.drawn ? { ...s.phase, drawn: players[s.phase.seat].hand.at(-1)! } : s.phase;
  return { ...s, players, wall, phase };
}

const states = playedStates(30, 2026);

describe("viewFor", () => {
  it("covers hands from deal to finish, with calls, kongs and wins", () => {
    expect(states.length).toBeGreaterThan(1000);
    expect(states.some((s) => s.players.some((p) => p.melds.some((m) => m.kind === "kong" && m.concealed)))).toBe(true);
    expect(states.some((s) => s.phase.kind === "over" && s.phase.result.winner !== null)).toBe(true);
  });

  // The test the server's fairness rests on.
  it("doesn't change when everything the seat can't see is shuffled", () => {
    const random = seeded(7);
    let compared = 0;
    for (const s of states) {
      if (s.phase.kind === "over") continue; // hands are shown at the end
      for (let seat = 0; seat < SEATS; seat++) {
        const view = JSON.stringify(viewFor(s, seat));
        const other = JSON.stringify(viewFor(reshuffleHidden(s, seat, random), seat));
        if (view !== other) throw new Error(`seat ${seat} could tell hidden tiles apart: ${view} vs ${other}`);
        compared++;
      }
    }
    expect(compared).toBeGreaterThan(4000);
  });

  it("shows a seat its own tiles, and of the others only counts and what's face up", () => {
    for (const s of states.filter((x) => x.phase.kind !== "over").slice(0, 400)) {
      for (let seat = 0; seat < SEATS; seat++) {
        const v = viewFor(s, seat);
        expect(v).not.toHaveProperty("wall");
        expect(v.players[seat].hand).toEqual(s.players[seat].hand);
        for (const [i, p] of v.players.entries()) {
          expect(p.handCount).toBe(s.players[i].hand.length);
          if (i === seat) continue;
          expect(p.hand).toBeNull();
          for (const m of p.melds) if (m.kind === "kong" && m.concealed) expect(m).toEqual({ kind: "kong", concealed: true, hidden: true, from: null });
        }
        if (v.phase.kind === "turn" && v.phase.seat !== seat) {
          expect(v.phase.drawn).toBeNull();
          expect(v.phase).not.toHaveProperty("forbidden");
        }
      }
    }
  });

  it("shows every hand once the hand is over, but never the wall", () => {
    const ends = states.filter((s) => s.phase.kind === "over");
    expect(ends.length).toBe(30);
    for (const s of ends) {
      const v = viewFor(s, 0);
      expect(v.players.map((p) => p.hand)).toEqual(s.players.map((p) => p.hand));
      expect(JSON.stringify(v)).not.toContain('"wall"');
    }
  });

  it("keeps a concealed kong face down at the end - but a winner's, and your own", () => {
    const s = states.find((x) => x.phase.kind === "over" && x.phase.result.winner !== null && x.phase.result.winner !== 0)!;
    const winner = (s.phase as Extract<GameState["phase"], { kind: "over" }>).result.winner!;
    const loser = [1, 2, 3].find((i) => i !== winner)!;
    const kong = { kind: "kong" as const, tiles: Array.from({ length: 4 }, () => ({ suit: "t" as const, rank: 5 })), concealed: true, from: null };
    const t = { ...s, players: s.players.map((p, i) => (i === winner || i === loser || i === 0 ? { ...p, melds: [...p.melds, kong] } : p)) };
    const v = viewFor(t, 0);
    const last = (seat: number) => v.players[seat].melds[v.players[seat].melds.length - 1];
    expect(last(loser)).toMatchObject({ hidden: true });
    expect(last(winner)).not.toHaveProperty("hidden");
    expect(last(0)).not.toHaveProperty("hidden");
  });

  it("is a copy: changing the view can't change the game", () => {
    const s = states[50];
    const v = viewFor(s, 0);
    v.players[0].hand!.pop();
    v.players[1].discards.push({ suit: "m", rank: 1 });
    expect(viewFor(s, 0)).not.toEqual(v);
  });
});

describe("dealHand's random source", () => {
  it("deals the same wall and dice from the same source, and different ones from another", () => {
    const a = dealHand({ dealer: 0, roundWind: 1, dealerStreak: 0 }, undefined, seeded(1));
    const b = dealHand({ dealer: 0, roundWind: 1, dealerStreak: 0 }, undefined, seeded(1));
    const c = dealHand({ dealer: 0, roundWind: 1, dealerStreak: 0 }, undefined, seeded(2));
    expect(a.wall).toEqual(b.wall);
    expect(a.dice).toEqual(b.dice);
    expect(a.players).toEqual(b.players);
    expect(JSON.stringify(a.wall)).not.toEqual(JSON.stringify(c.wall));
  });
});

describe("viewFor, 一炮多響", () => {
  it("carries every winner's score as plain data", () => {
    const s = dealHand({ dealer: 3, roundWind: 1, dealerStreak: 0, multiWin: true });
    s.players = s.players.map((p) => ({ ...p, melds: [], flowers: [], discards: [] }));
    const T = (h: string) => [...h.matchAll(/(\d+)([mtbz])/g)].flatMap(([, ds, suit]) => [...ds].map((d) => ({ suit, rank: Number(d) }) as Tile));
    s.players[1].hand = T("46m111222333t456b77z");
    s.players[2].hand = T("46m111222333t456b77z");
    s.players[0].discards = T("5m");
    s.phase = { kind: "claims", from: 0, tile: { suit: "m", rank: 5 } };
    const over = resolveClaims(s, [null, { kind: "win" }, { kind: "win" }, null]);
    const v = viewFor(over, 3);
    if (v.phase.kind !== "over") throw new Error("over");
    expect(v.multiWin).toBe(true);
    expect(v.phase.result.alsoWon?.[0]).toMatchObject({ winner: 2, scoreError: null });
    expect(v.phase.result.alsoWon?.[0].score?.patterns.map((x) => x.id)).toContain("multi-win-double");
    expect(() => JSON.stringify(v)).not.toThrow();
  });
});
