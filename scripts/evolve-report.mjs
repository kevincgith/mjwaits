// node scripts/evolve-report.mjs evolution/species1 [out.html]
//
// Turns an evolution run's log.json (scripts/evolve.ts) into one
// self-contained HTML dashboard: species champions, the benchmark trend,
// the in-species ranking trend, a leaderboard of the living population and
// where each style's settings drifted.

import { existsSync, readFileSync, writeFileSync } from "node:fs";

const dir = process.argv[2] ?? "evolution/species1";
const out = process.argv[3] ?? `${dir}/report.html`;
const log = JSON.parse(readFileSync(`${dir}/log.json`, "utf8"));
const gens = log.generations;
const last = gens[gens.length - 1];
const species = log.config.species;

const per = (s) => (s && s.hands ? (s.taiWon - s.taiLost) / s.hands : null);
const round = (x, d = 2) => (x === null ? null : Math.round(x * 10 ** d) / 10 ** d);

// Trend per species: best lifetime net/hand among its bots, each generation.
const rankTrend = species.map((sp) => ({
  id: sp.id,
  points: gens.map((g) => {
    const mine = g.bots.filter((b) => b.species === sp.id);
    const best = mine.reduce((a, b) => (b.score > a.score ? b : a), mine[0]);
    return [g.gen, round(per(best.life))];
  }),
}));
// Benchmark trend: each species champion's net/hand at the fixed table.
const benchTrend = species.map((sp) => ({
  id: sp.id,
  points: gens.filter((g) => g.benchmark).map((g) => [g.gen, round(per(g.benchmark.find((b) => b.species === sp.id).champion.stats))]),
}));
// Starting genes per species (generation 0's first bot of each species).
const startGenes = Object.fromEntries(species.map((sp) => [sp.id, gens[0].bots.find((b) => b.species === sp.id && b.born === 0)?.genes]));
const living = last.bots.map((b) => ({
  id: b.id,
  name: b.name,
  species: b.species,
  style: b.style,
  born: b.born,
  parents: b.parents,
  genes: b.genes,
  hands: b.life.hands,
  net: round(per(b.life)),
  win: round(b.life.wins / Math.max(1, b.life.hands), 3),
  tsumo: round(b.life.selfDraws / Math.max(1, b.life.wins), 3),
  dealIn: round(b.life.dealIns / Math.max(1, b.life.hands), 3),
  avgWin: round(b.life.taiWon / Math.max(1, b.life.wins), 1),
  avgLoss: round(b.life.dealInTai / Math.max(1, b.life.dealIns), 1),
  calls: round(b.life.calls / Math.max(1, b.life.hands), 2),
  riichi: round(b.life.riichis / Math.max(1, b.life.hands), 3),
  best: b.life.biggestWin,
}));
const lastBench = [...gens].reverse().find((g) => g.benchmark);
const totalHands = gens.reduce((n, g) => n + g.bots.reduce((m, b) => m + (b.gen?.hands ?? 0), 0) / 4, 0);
const data = {
  config: log.config,
  generations: gens.length,
  totalHands: Math.round(totalHands),
  minutes: Math.round(gens.reduce((n, g) => n + g.seconds, 0) / 60),
  rankTrend,
  benchTrend,
  startGenes,
  living,
  lastBench: lastBench
    ? {
        gen: lastBench.gen,
        rows: lastBench.benchmark.map((b) => ({ species: b.species, name: b.champion.name, net: round(per(b.champion.stats)), hands: b.champion.stats.hands })),
        refs: lastBench.benchmark[0].others.map((o) => ({ name: o.name, net: round(per(o)) })),
      }
    : null,
  updated: new Date().toISOString().slice(0, 16).replace("T", " "),
  // Optional: final head-to-head tournaments (written by hand from arena runs).
  final: existsSync(`${dir}/final.json`) ? JSON.parse(readFileSync(`${dir}/final.json`, "utf8")) : null,
};

const html = readFileSync(new URL("./evolve-report.html", import.meta.url), "utf8").replace("/*DATA*/null", JSON.stringify(data));
writeFileSync(out, html);
console.log(`Wrote ${out} (${Math.round(html.length / 1024)} KB): ${gens.length} generations`);
