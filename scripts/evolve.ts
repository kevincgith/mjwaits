// npm run evolve -- [--gens 150] [--per 4] [--walls 24] [--rounds 3] [--seed 1] [--out evolution/run]
//
// Evolves the bots by self-play, one species per playing style. Each
// species keeps its settings inside its style's bounds (a Hunter stays
// greedy, an Iron Wall stays careful) - so evolution finds the strongest
// version of each style rather than turning everyone into the same bot -
// plus an unconstrained Grandmaster species that may become anything.
// Each generation:
//   1. the whole population is shuffled into mixed tables of four,
//      `rounds` times over, and each table plays `walls` walls (x4
//      seatings, as in the arena) - species compete against each other;
//   2. every bot is ranked within its species on net tai a hand over its
//      whole life (shrunk toward 0 while it has few hands, so a lucky
//      newcomer can't top an established bot on one good run);
//   3. each species keeps its top half; the rest are replaced by children
//      of two survivors of the same species - each setting from one parent,
//      then mutated within the species' bounds;
//   4. every few generations each species' champion plays a fixed
//      benchmark table (the original Veteran, the original efficiency-only
//      bot and the original Speedster), so progress is measured against
//      something that doesn't evolve.
// The full history goes to <out>/log.json after every generation, for
// scripts/evolve-report.ts to turn into a dashboard.

import { mkdirSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { isMainThread, parentPort, Worker } from "node:worker_threads";
import { BASELINE, runArena, type ArenaResult, type BotStats } from "../src/lib/arena";
import { BOT_PROFILES, profileById, seededRng, type BotProfile } from "../src/lib/bots";

// The settings evolution may change, and their ranges.
const GENES = {
  speed: [0.4, 1.6],
  greed: [0, 1],
  minTai: [0, 8],
  callAppetite: [0, 1],
  caution: [0, 1],
  foldAt: [0.2, 1],
  read: [0, 1],
  noise: [0, 0.3],
  slip: [0, 0.08],
  riichi: [0, 1],
  focus: [0, 0.9],
} as const;
type Gene = keyof typeof GENES;
const GENE_KEYS = Object.keys(GENES) as Gene[];

// The styles. `bounds` narrow GENES for that species (a few widen them -
// the Casual may be noisier than anyone else); `from` is the starting
// personality.
interface Species {
  id: string;
  name: string;
  from: string;
  bounds: Partial<Record<Gene, readonly [number, number]>>;
}
const SPECIES: Species[] = [
  { id: "grandmaster", name: "宗師 Grandmaster", from: "veteran", bounds: {} },
  { id: "veteran", name: "老手 Veteran", from: "veteran", bounds: { caution: [0.2, 0.6], greed: [0.05, 0.5], callAppetite: [0.4, 0.95], noise: [0, 0.08], slip: [0, 0.02] } },
  { id: "speedster", name: "快手 Speedster", from: "speedster", bounds: { callAppetite: [0.85, 1], greed: [0, 0.2], minTai: [0, 0], speed: [1.1, 1.6] } },
  { id: "hunter", name: "大牌 Hunter", from: "hunter", bounds: { greed: [0.7, 1], minTai: [3, 8], callAppetite: [0.2, 0.7] } },
  { id: "wall", name: "鐵壁 Iron Wall", from: "wall", bounds: { caution: [0.8, 1], callAppetite: [0, 0.3], foldAt: [0.2, 0.45], read: [0.7, 1] } },
  { id: "gambler", name: "賭徒 Gambler", from: "gambler", bounds: { caution: [0, 0.1], foldAt: [0.95, 1], riichi: [0.8, 1], focus: [0, 0] } },
  { id: "casual", name: "街坊 Casual", from: "casual", bounds: { noise: [0.2, 0.4], slip: [0.05, 0.1], read: [0, 0.4] } },
];
const rangeOf = (sp: Species, g: Gene): readonly [number, number] => sp.bounds[g] ?? GENES[g];

interface Job {
  id: number;
  bots: BotProfile[];
  walls: number;
  seed: number;
}

if (!isMainThread) {
  parentPort!.on("message", (job: Job) => {
    parentPort!.postMessage({ id: job.id, result: runArena(job.bots, job.walls, job.seed) });
  });
} else {
  const args = process.argv.slice(2);
  const opt = (name: string, fallback: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : fallback;
  };
  const GENS = Number(opt("gens", "150"));
  // Bots per species; the whole population must seat in fours.
  const PER = Math.max(2, Number(opt("per", "4")));
  const POP = SPECIES.length * PER;
  if (POP % 4) throw new Error(`${SPECIES.length} species x ${PER} must be a multiple of 4`);
  const BENCH_EVERY = Number(opt("benchEvery", "5"));
  const WALLS = Number(opt("walls", "24"));
  const ROUNDS = Number(opt("rounds", "3"));
  const BENCH_WALLS = Number(opt("bench", "24"));
  const SEED = Number(opt("seed", "1"));
  const OUT = opt("out", `evolution/run-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}`);
  const rng = seededRng(SEED);

  // ---- Worker pool ----
  const pool = Array.from({ length: availableParallelism() }, () => new Worker(new URL(import.meta.url)));
  let nextId = 0;
  async function runJobs(jobs: Omit<Job, "id">[]): Promise<ArenaResult[]> {
    const results: ArenaResult[] = new Array(jobs.length);
    let cursor = 0;
    await Promise.all(
      pool.map(
        (w) =>
          new Promise<void>((resolve, reject) => {
            const take = () => {
              if (cursor >= jobs.length) return resolve();
              const index = cursor++;
              const id = nextId++;
              const onMessage = (msg: { id: number; result: ArenaResult }) => {
                if (msg.id !== id) return;
                w.off("message", onMessage);
                w.off("error", reject);
                results[index] = msg.result;
                take();
              };
              w.on("message", onMessage);
              w.once("error", reject);
              w.postMessage({ ...jobs[index], id });
            };
            take();
          })
      )
    );
    return results;
  }

  // ---- Genetics ----
  const NICKS = ["阿明", "阿強", "阿珍", "阿玲", "阿輝", "阿芬", "阿偉", "阿豪", "阿賢", "阿標", "阿娟", "阿琪", "阿光", "阿彬", "阿雄", "阿敏", "阿德", "阿慧", "阿昌", "阿美", "阿龍", "阿鳳", "阿華", "阿英"];
  let born = 0;
  const gauss = () => Math.sqrt(-2 * Math.log(1 - rng())) * Math.cos(2 * Math.PI * rng());
  const clampGene = (sp: Species, g: Gene, v: number) => {
    const [lo, hi] = rangeOf(sp, g);
    const x = Math.min(hi, Math.max(lo, v));
    return g === "minTai" ? Math.round(x) : Math.round(x * 1000) / 1000;
  };
  // A short description from its most distinctive settings.
  function styleOf(p: BotProfile): string {
    const tags: string[] = [];
    if (p.callAppetite >= 0.75) tags.push("caller");
    else if (p.callAppetite <= 0.25) tags.push("門清");
    if (p.caution >= 0.6) tags.push("careful");
    else if (p.caution <= 0.15) tags.push("reckless");
    if (p.greed >= 0.6 || p.minTai >= 4) tags.push("greedy");
    if (p.riichi >= 0.75) tags.push("叮-happy");
    else if (p.riichi <= 0.2) tags.push("no-叮");
    if (p.speed >= 1.25) tags.push("fast");
    if (p.noise >= 0.18) tags.push("erratic");
    return tags.slice(0, 3).join(", ") || "balanced";
  }
  function make(sp: Species, gen: number, genes: Record<Gene, number>, parents: string[]): BotProfile & { parents: string[]; born: number; species: string } {
    const n = born++;
    const id = `g${gen}-${n}`;
    const p = { ...profileById(sp.from), ...genes, id, name: `${NICKS[n % NICKS.length]}${n >= NICKS.length ? Math.floor(n / NICKS.length) + 1 : ""}`, blurb: "", parents, born: gen, species: sp.id };
    p.blurb = styleOf(p);
    return p;
  }
  const genesOf = (p: BotProfile) => Object.fromEntries(GENE_KEYS.map((g) => [g, (p as unknown as Record<string, number>)[g] ?? 0])) as Record<Gene, number>;
  // Mutates within the species' bounds (and pulls any setting that starts
  // outside them - a personality's own value may - back inside).
  function mutate(sp: Species, genes: Record<Gene, number>, rate = 0.35, scale = 0.15): Record<Gene, number> {
    const out = { ...genes };
    for (const g of GENE_KEYS) {
      const [lo, hi] = rangeOf(sp, g);
      if (rng() < rate) out[g] += gauss() * scale * (hi - lo || GENES[g][1] - GENES[g][0]);
      out[g] = clampGene(sp, g, out[g]);
    }
    return out;
  }
  function crossover(a: Record<Gene, number>, b: Record<Gene, number>): Record<Gene, number> {
    return Object.fromEntries(GENE_KEYS.map((g) => [g, rng() < 0.5 ? a[g] : b[g]])) as Record<Gene, number>;
  }

  type Member = ReturnType<typeof make> & { life: BotStats };
  const blank = (p: BotProfile): BotStats => ({ id: p.id, name: p.name, hands: 0, wins: 0, selfDraws: 0, dealIns: 0, taiWon: 0, taiLost: 0, dealInTai: 0, winTurns: 0, calls: 0, riichis: 0, biggestWin: 0 });
  const addStats = (into: BotStats, s: BotStats) => {
    for (const k of ["hands", "wins", "selfDraws", "dealIns", "taiWon", "taiLost", "dealInTai", "winTurns", "calls", "riichis"] as const) into[k] += s[k];
    into.biggestWin = Math.max(into.biggestWin, s.biggestWin);
  };
  const net = (s: BotStats) => s.taiWon - s.taiLost;
  // Shrunk mean: a bot needs a few hundred hands before its score counts fully.
  const score = (s: BotStats) => net(s) / (s.hands + 300);

  // Generation 0: per species, its personality (pulled inside the bounds)
  // and mutants of it.
  const speciesOf = (m: { species: string }) => SPECIES.find((sp) => sp.id === m.species)!;
  let population: Member[] = [];
  for (const sp of SPECIES) {
    const base = profileById(sp.from);
    for (let i = 0; i < PER; i++) {
      const m = make(sp, 0, i === 0 ? mutate(sp, genesOf(base), 0) : mutate(sp, genesOf(base), 0.6, 0.25), [base.id]);
      population.push({ ...m, life: blank(m) });
    }
  }
  void BOT_PROFILES;

  const BENCH = [profileById("veteran"), BASELINE, profileById("speedster")];
  const history: unknown[] = [];
  mkdirSync(OUT, { recursive: true });
  const t0 = Date.now();
  console.log(`Evolving ${POP} bots for ${GENS} generations: ${(POP / 4) * ROUNDS * WALLS * 4} hands a generation, results in ${OUT}/log.json`);

  for (let gen = 0; gen < GENS; gen++) {
    const tg = Date.now();
    // 1. Tables: shuffle the population `ROUNDS` times; each table's walls
    //    are split into chunks so the worker pool stays busy.
    const jobs: Omit<Job, "id">[] = [];
    const seatings: number[][] = [];
    const CHUNK = Math.max(2, Math.ceil(WALLS / 4));
    for (let r = 0; r < ROUNDS; r++) {
      const order = population.map((_, i) => i).sort(() => rng() - 0.5);
      for (let t = 0; t < POP / 4; t++) {
        const table = order.slice(t * 4, t * 4 + 4);
        for (let w = 0; w < WALLS; w += CHUNK) {
          jobs.push({ bots: table.map((i) => population[i]), walls: Math.min(CHUNK, WALLS - w), seed: Math.floor(rng() * 1e9) });
          seatings.push(table);
        }
      }
    }
    // 4 (run alongside, every few generations and on the last). Each
    //    species' current champion at the benchmark table.
    const benchNow = gen % BENCH_EVERY === 0 || gen === GENS - 1;
    const champs = SPECIES.map((sp) => population.filter((m) => m.species === sp.id).sort((a, b) => score(b.life) - score(a.life))[0]);
    const benchJobs: number[] = [];
    if (benchNow)
      champs.forEach((champ, c) => {
        for (let w = 0; w < BENCH_WALLS; w += CHUNK) {
          jobs.push({ bots: [champ, ...BENCH], walls: Math.min(CHUNK, BENCH_WALLS - w), seed: Math.floor(rng() * 1e9) });
          benchJobs.push(c);
        }
      });
    const results = await runJobs(jobs);

    const genStats = new Map(population.map((m) => [m.id, blank(m)]));
    seatings.forEach((table, j) => results[j].stats.forEach((s, seat) => addStats(genStats.get(population[table[seat]].id)!, s)));
    // Per species champion: its benchmark stats and the yardsticks' at its table.
    const bench = champs.map((champ) => ({ champ: blank(champ), others: BENCH.map(blank) }));
    benchJobs.forEach((c, k) => {
      const r = results[seatings.length + k];
      addStats(bench[c].champ, r.stats[0]);
      r.stats.slice(1).forEach((s, i) => addStats(bench[c].others[i], s));
    });
    for (const m of population) addStats(m.life, genStats.get(m.id)!);

    // 2. Rank on lifetime score (overall for the log; selection is per species).
    const ranked = population.slice().sort((a, b) => score(b.life) - score(a.life));
    const snapshot = {
      gen,
      seconds: Math.round((Date.now() - tg) / 1000),
      bots: ranked.map((m, rank) => ({
        id: m.id,
        name: m.name,
        species: m.species,
        style: m.blurb,
        parents: m.parents,
        born: m.born,
        rank: rank + 1,
        score: Math.round(score(m.life) * 1000) / 1000,
        genes: genesOf(m),
        gen: genStats.get(m.id),
        life: { ...m.life },
      })),
      benchmark: benchNow
        ? SPECIES.map((sp, c) => ({ species: sp.id, champion: { id: champs[c].id, name: champs[c].name, genes: genesOf(champs[c]), stats: bench[c].champ }, others: bench[c].others }))
        : null,
    };
    history.push(snapshot);
    writeFileSync(
      `${OUT}/log.json`,
      JSON.stringify({ config: { GENS, PER, POP, WALLS, ROUNDS, BENCH_WALLS, BENCH_EVERY, SEED, genes: GENES, species: SPECIES }, generations: history }, null, 1)
    );

    const top = ranked[0];
    const perHand = (s: BotStats) => (s.hands ? (net(s) / s.hands).toFixed(2) : "-");
    console.log(
      `gen ${String(gen).padStart(3)}  ${snapshot.seconds}s  top ${top.name} [${top.species}] (${top.blurb}) ${perHand(top.life)}/hand over ${top.life.hands}` +
        (benchNow ? `\n         bench: ${SPECIES.map((sp, c) => `${sp.id} ${perHand(bench[c].champ)}`).join("  ")}` : "")
    );

    // 3. Next generation: keep the top half, breed the rest.
    if (gen === GENS - 1) break;
    const next: Member[] = [];
    for (const sp of SPECIES) {
      const mine = population.filter((m) => m.species === sp.id).sort((a, b) => score(b.life) - score(a.life));
      const survivors = mine.slice(0, Math.ceil(PER / 2));
      next.push(...survivors);
      for (let i = survivors.length; i < PER; i++) {
        const a = survivors[Math.floor(rng() * survivors.length)];
        const b = survivors[Math.floor(rng() * survivors.length)];
        const m = make(sp, gen + 1, mutate(sp, crossover(genesOf(a), genesOf(b))), a === b ? [a.id] : [a.id, b.id]);
        next.push({ ...m, life: blank(m) });
      }
    }
    population = next;
    void speciesOf;
  }
  console.log(`Done in ${Math.round((Date.now() - t0) / 60000)} min`);
  await Promise.all(pool.map((w) => w.terminate()));
}
