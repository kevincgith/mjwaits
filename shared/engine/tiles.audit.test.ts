import { describe, expect, it } from "vitest";
import { applyTurnMove, botClaim, botTurnMove, claimOptions, newGame, nextHand, resolveClaims, swapGive, swapTake, takersAfter, type GameState } from "./game";
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

function census(g: GameState): Map<string, number> {
  const n = new Map<string, number>();
  const add = (k: string) => n.set(k, (n.get(k) ?? 0) + 1);
  for (const w of g.wall) add("bonus" in w ? `${w.bonus.kind}${w.bonus.rank}` : `${w.tile.rank}${w.tile.suit}`);
  for (const p of g.players) {
    for (const t of p.hand) add(`${t.rank}${t.suit}`);
    for (const t of p.discards) add(`${t.rank}${t.suit}`);
    for (const m of p.melds) for (const t of m.tiles) add(`${t.rank}${t.suit}`);
    for (const f of p.flowers) add(`${f.kind}${f.rank}`);
  }
  if (g.phase.kind === "swap") for (const pile of g.phase.piles) for (const t of pile ?? []) if (t) add(`${t.rank}${t.suit}`);
  // 一炮多響: each winner off the one discard holds it in their winning
  // hand, so it's there once per extra winner.
  if (g.phase.kind === "over" && g.phase.result.tile && g.phase.result.alsoWon?.length) {
    const k = `${g.phase.result.tile.rank}${g.phase.result.tile.suit}`;
    n.set(k, n.get(k)! - g.phase.result.alsoWon.length);
  }
  return n;
}

function check(g: GameState, where: string) {
  const n = census(g);
  const total = [...n.values()].reduce((a, b) => a + b, 0);
  const off = [...n].filter(([k, c]) => (/^(flower|season)/.test(k) ? c !== 1 : c !== 4));
  if (total !== 144 || n.size !== 42 || off.length) throw new Error(`${where}: ${total} tiles, ${n.size} kinds, off: ${JSON.stringify(off)}`);
}

describe("all 144 tiles, after every move", () => {
  for (const swap of [false, true]) {
    it(`whole games played out by bots${swap ? ", with 換牌" : ""}`, { timeout: 120_000 }, () => {
      const rand = rng(swap ? 77 : 7);
      let g = newGame({ multiWin: rand() < 0.5, ...(swap ? { swapRules: { ...DEFAULT_SWAP_RULES, winds: [1, 2, 3, 4] } } : {}) });
      let moves = 0;
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
        g = nextHand(g, undefined, rand);
      }
      expect(moves).toBeGreaterThan(1000);
    });
  }
});
