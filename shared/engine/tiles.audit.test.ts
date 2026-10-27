import { describe, expect, it } from "vitest";
import { applyTurnMove, botClaim, botTurnMove, claimOptions, newGame, nextHand, resolveClaims, swapGive, swapTake, takersAfter, tileCensus, type GameState } from "./game";
import { botGive, blindPicks, botSplit, pileLeft, DEFAULT_SWAP_RULES } from "./swap";

// Every tile, always: 4 of each of the 34 kinds and each of the 8 bonus
// tiles once - 144 - wherever they are (wall, hands, melds, ponds, flowers,
// 換牌 piles), after every move of whole games played out by bots. A tile
// lost or doubled anywhere (a claim, a kong, a robbed kong, a swap) fails
// here at the move that did it.

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The game's own check (tileCensus), after every move - what the game runs too.
function check(g: GameState, where: string) {
  const c = tileCensus(g);
  if (c.total !== 144 || c.off.length) throw new Error(`${where}: ${c.total} tiles, off: ${JSON.stringify(c.off)}`);
}

describe("all 144 tiles, after every move", () => {
  it("the check names what's off: a tile lost, one doubled, a bonus tile gone", () => {
    const g = newGame();
    expect(tileCensus(g)).toEqual({ total: 144, off: [] });
    const lost = { ...g, players: g.players.map((p, i) => (i === 0 ? { ...p, hand: p.hand.slice(1) } : p)) };
    expect(tileCensus(lost).total).toBe(143);
    expect(tileCensus(lost).off).toHaveLength(1);
    const doubled = { ...g, players: g.players.map((p, i) => (i === 0 ? { ...p, hand: [...p.hand, p.hand[0]] } : p)) };
    expect(tileCensus(doubled).off[0]).toMatchObject({ count: 5, expected: 4 });
    const noBonus = { ...g, wall: g.wall.filter((w) => !("bonus" in w)), players: g.players.map((p) => ({ ...p, flowers: [] })) };
    expect(tileCensus(noBonus).off.map((o) => o.tile)).toHaveLength(8);
  });

  it("a hand nobody wins plays the wall out to its last tile - none held back", () => {
    let g = newGame();
    let moves = 0;
    while (g.phase.kind !== "over" && moves++ < 400) {
      const ph = g.phase;
      if (ph.kind === "turn") {
        // Throw the drawn tile, never win (a 自摸 would end it early).
        const hand = g.players[ph.seat].hand;
        g = applyTurnMove(g, { kind: "discard", tile: ph.drawn ?? hand[hand.length - 1] });
      } else if (ph.kind === "claims") g = resolveClaims(g, [null, null, null, null]);
      check(g, `move ${moves}`);
    }
    expect(g.phase.kind === "over" && g.phase.result.winner).toBe(null);
    expect(g.wall.length).toBe(0);
    // Every tile on the table: hands and ponds, flowers set aside.
    const ponds = g.players.reduce((n, p) => n + p.discards.length, 0);
    expect(ponds + g.players.reduce((n, p) => n + p.hand.length + p.flowers.length, 0)).toBe(144);
  });

  for (const swap of [false, true]) {
    it(`whole games played out by bots${swap ? ", with 換牌" : ""}`, { timeout: 120_000 }, () => {
      const rand = rng(swap ? 77 : 7);
      let g = newGame({ multiWin: rand() < 0.5, ...(swap ? { swapRules: { ...DEFAULT_SWAP_RULES, winds: [1, 2, 3, 4] } } : {}) });
      let moves = 0;
      let draws = 0;
      for (let hand = 0; hand < 40; hand++) {
        check(g, `hand ${hand} dealt`);
        for (let step = 0; step < 400 && g.phase.kind !== "over"; step++) {
          const ph = g.phase;
          if (ph.kind === "swap") {
            if (ph.stage === "give") {
              for (let s = 0; s < 4; s++) if (!ph.piles[s] && g.phase.kind === "swap") g = swapGive(g, s, botGive(g.players[s].hand, ph.count, rand), rand);
            } else {
              const split = botSplit(ph.piles.map(pileLeft), ph.taker, takersAfter(ph, g.dealer), ph.count, rand);
              g = swapTake(g, ph.taker, ph.piles.map((p, i) => (p ? blindPicks(p, split[i], rand) : [])));
            }
          } else if (ph.kind === "turn") g = applyTurnMove(g, botTurnMove(g));
          else if (ph.kind === "claims") g = resolveClaims(g, [0, 1, 2, 3].map((s) => (s === ph.from || !claimOptions(g, s).length ? null : botClaim(g, s))));
          moves++;
          check(g, `hand ${hand}, move ${step} (${ph.kind})`);
        }
        // A draw (流局) plays the wall out to its last tile: none held back.
        if (g.phase.kind === "over" && g.phase.result.winner === null) {
          expect(g.wall.length).toBe(0);
          draws++;
        }
        g = nextHand(g, undefined, rand);
      }
      expect(moves).toBeGreaterThan(1000);
    });
  }
});
