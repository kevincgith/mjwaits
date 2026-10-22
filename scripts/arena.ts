// npm run arena -- [--walls 200] [--bots veteran,speedster,hunter,wall] [--seed 1] [--workers 8]
//                  [--tweak veteran2:veteran.caution=0.4,foldAt=0.6] [--calibrate] [--list]
//                  [--session 16]   (hands per session: 拉, dealer and 連莊 carry over)
//
// --tweak adds a variant: a new id, the profile it copies, and the settings
// it changes - so tunings can be played off against each other.
// Plays the bots against each other headless (see src/lib/arena.ts) and
// prints a results table. Work is split across worker threads by wall, each
// with its own seed, so a run is repeatable for a given seed and worker count.

import { availableParallelism } from "node:os";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import { BASELINE, formatArena, mergeResults, runArena, type ArenaResult } from "../src/lib/arena";
import { BOT_PROFILES, flushSuit, profileById, tileRisk, type BotProfile } from "../src/lib/bots";
import { isWinningHand, meldsNeeded, SEATS, unseenCounts } from "@mjwaits/shared/engine/game";
import { shanten } from "@mjwaits/shared/engine/mahjong";

type Tweaks = Record<string, { from: string; set: Record<string, number> }>;

// "veteran2:veteran.caution=0.4,foldAt=0.6;..." -> variants by id.
function parseTweaks(spec: string): Tweaks {
  const out: Tweaks = {};
  for (const part of spec.split(";").filter(Boolean)) {
    const [id, rest] = part.split(":");
    const [from, ...assigns] = rest.split(".");
    const set: Record<string, number> = {};
    for (const a of assigns.join(".").split(",")) {
      const [k, v] = a.split("=");
      set[k] = Number(v);
    }
    out[id] = { from, set };
  }
  return out;
}

const lookupWith = (tweaks: Tweaks) => (id: string): BotProfile => {
  const t = tweaks[id];
  if (t) {
    const base = lookupWith({})(t.from);
    return { ...base, ...t.set, id, name: `${base.name}*${id.replace(t.from, "")}` };
  }
  return id === "basic" ? BASELINE : profileById(id);
};

if (isMainThread) {
  const args = process.argv.slice(2);
  const opt = (name: string, fallback: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : fallback;
  };
  if (args.includes("--list")) {
    for (const p of [...BOT_PROFILES, BASELINE] as BotProfile[]) console.log(`${p.id.padEnd(10)} ${p.name} - ${p.blurb}`);
    process.exit(0);
  }
  const walls = Number(opt("walls", "100"));
  const ids = opt("bots", "veteran,speedster,hunter,wall").split(",");
  const seed = Number(opt("seed", "1"));
  const workers = Math.max(1, Math.min(Number(opt("workers", String(availableParallelism()))), walls));
  if (ids.length !== 4) throw new Error("--bots needs four ids (repeats allowed); --list shows them");
  // Each worker gets whole sessions.
  const session = Math.max(1, Number(opt("session", "1")));
  const sessions = Math.ceil(walls / session);
  const per = Array.from({ length: Math.min(workers, sessions) }, (_, i) => (Math.floor(sessions / Math.min(workers, sessions)) + (i < sessions % Math.min(workers, sessions) ? 1 : 0)) * session);
  const parts = await Promise.all(
    per.map(
      (n, i) =>
        new Promise<{ result: ArenaResult; calib?: Record<string, [number, number]> }>((resolve, reject) => {
          const w = new Worker(new URL(import.meta.url), { workerData: { ids, walls: n, seed: seed * 1000 + i, calibrate: args.includes("--calibrate"), tweak: opt("tweak", ""), session: Number(opt("session", "1")) } });
          w.once("message", resolve);
          w.once("error", reject);
        })
    )
  );
  console.log(formatArena(mergeResults(parts.map((p) => p.result))));
  if (args.includes("--calibrate")) {
    // How often a seat showing this many melds, this deep into the hand, is
    // actually ready - what threat() should be estimating.
    const table = new Map<string, [number, number]>();
    for (const p of parts)
      for (const [k, [n, ready]] of Object.entries(p.calib ?? {})) {
        const t = table.get(k) ?? [0, 0];
        table.set(k, [t[0] + n, t[1] + ready]);
      }
    console.log("\nReady rate by called melds (rows) and discards made (columns)");
    const cols = ["0-3", "4-6", "7-9", "10-12", "13-15", "16+"];
    console.log("melds  " + cols.map((c) => c.padStart(12)).join(""));
    for (let m = 0; m <= 5; m++) {
      const cells = cols.map((c) => {
        const t = table.get(`${m}|${c}`);
        return (t ? `${((100 * t[1]) / t[0]).toFixed(0)}% (${t[0]})` : "-").padStart(12);
      });
      console.log(`${m}      ` + cells.join(""));
    }
    console.log("\nWin-tile rate by predicted risk bucket (risk x 6): no read, every read, then each read alone");
    const kinds = ["naive", "risk", "suji", "kabe", "scarce", "flush"];
    console.log("bucket " + kinds.map((k) => k.padStart(16)).join(""));
    for (let b = 0; b <= 9; b++) {
      const cells = kinds.map((k) => {
        const t = table.get(`${k}|${b}`);
        return (t ? `${((100 * t[1]) / t[0]).toFixed(1)}% (${t[0]})` : "-").padStart(16);
      });
      console.log(`${b}      ` + cells.join(""));
    }
    for (const f of ["flush", "noflush"]) {
      const t = table.get(f);
      if (t) console.log(`${f}: ${((100 * t[1]) / t[0]).toFixed(0)}% ready (${t[0]})`);
    }
  }
} else {
  const { ids, walls, seed, calibrate, tweak, session } = workerData as { ids: string[]; walls: number; seed: number; calibrate: boolean; tweak: string; session: number };
  const lookup = lookupWith(parseTweaks(tweak));
  const calib: Record<string, [number, number]> = {};
  const bucket = (d: number) => (d <= 3 ? "0-3" : d <= 6 ? "4-6" : d <= 9 ? "7-9" : d <= 12 ? "10-12" : d <= 15 ? "13-15" : "16+");
  const add = (k: string, ready: boolean) => {
    const t = (calib[k] ??= [0, 0]);
    t[0]++;
    if (ready) t[1]++;
  };
  const result = runArena(
    ids.map(lookup),
    walls,
    seed,
    calibrate
      ? (s) => {
          if (s.phase.kind !== "turn") return;
          for (let o = 0; o < SEATS; o++) {
            if (o === s.phase.seat) continue;
            const p = s.players[o];
            const ready = shanten(p.hand, meldsNeeded(p)) <= 0;
            add(`${p.melds.length}|${bucket(p.discards.length)}`, ready);
            add(flushSuit(s, o) ? "flush" : "noflush", ready);
            if (!ready) continue;
            // Is tileRisk informative? For each tile the seat to act holds,
            // bucket its predicted risk against this ready seat and record
            // whether it would have won them the hand.
            const me = s.phase.seat;
            const unseen = unseenCounts(s, me);
            const seen = new Set<string>();
            for (const t of s.players[me].hand) {
              const key = t.suit + t.rank;
              if (seen.has(key)) continue;
              seen.add(key);
              const wins = isWinningHand(p, t);
              const none = { suji: false, kabe: false, scarce: false, flush: false };
              const variants = {
                naive: tileRisk(s, me, o, t, 0, unseen),
                risk: tileRisk(s, me, o, t, 1, unseen),
                suji: tileRisk(s, me, o, t, 1, unseen, { ...none, suji: true }),
                kabe: tileRisk(s, me, o, t, 1, unseen, { ...none, kabe: true }),
                scarce: tileRisk(s, me, o, t, 1, unseen, { ...none, scarce: true }),
                flush: tileRisk(s, me, o, t, 1, unseen, { ...none, flush: true }),
              };
              for (const [k, v] of Object.entries(variants)) add(`${k}|${Math.min(9, Math.floor(v * 6))}`, wins);
            }
          }
        }
      : undefined,
    session
  );
  parentPort!.postMessage({ result, calib });
}
