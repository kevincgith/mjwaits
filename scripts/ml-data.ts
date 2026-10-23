// npm run ml-data -- [--hands 4000] [--session 16] [--seed 1] [--out ml/data/run1] [--match]
//
// --match (encoding v2): sessions are match days (match.ts) - 60-100 hands,
// half joined part-way with a random scoreboard, each with a random goal -
// and every observation carries the match inputs. Also written:
//   hands-w.f32   M x 15   per hand: goal, hand index, match length, totals
//                          before (4), after (4), and at the match's end (4)
//   link-w.i32    N        the hand row each decision belongs to
// which train.py uses to learn what a scoreboard is worth.
//
// Records training data for the learned bots: bots of every personality
// play sessions against each other (拉, dealer and 連莊 carry over, 投降
// between hands) and every real decision - more than one legal option - is
// written down: what the deciding seat saw (encode.ts), which actions were
// legal, what the bot chose, its personality, and afterwards how that hand
// and that session went for it.
//
// Output, per worker w (numbers little-endian, N samples):
//   obs-w.u8      N x OBS_SIZE   observations
//   mask-w.u8     N x NUM_ACTIONS legal actions (0/1)
//   meta-w.i32    N x 6          action, style, hand net, session net, decision kind (0 turn / 1 claim), seat
// and manifest.json describing the layout and the style ids. ml/train.py
// reads it.

import { mkdirSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import { botClaimFor, botSurrenders, botTurnMoveFor, BOT_PROFILES, seededRng, type BotProfile, type Rng } from "@mjwaits/shared/engine/bots";
import { applyTurnMove, dealHand, fullWall, nextHand, resolveClaims, SEATS, surrender, type GameState, type WallTile } from "@mjwaits/shared/engine/game";
import { claimDecisionAction, encodeObservation, legalActions, NUM_ACTIONS, NUM_PLANES, OBS_SIZE, OBS_SIZE_MATCH, turnMoveAction } from "../src/lib/ml/encode";
import { afterHand, randomMatch, type MatchContext } from "../src/lib/ml/match";

const STYLES = BOT_PROFILES.map((p) => p.id);
const META = 6;

function shuffledWall(rng: Rng): WallTile[] {
  const w = fullWall();
  for (let i = w.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [w[i], w[j]] = [w[j], w[i]];
  }
  return w;
}

interface Sample {
  obs: Uint8Array;
  mask: Uint8Array;
  action: number;
  style: number;
  kind: number;
  seat: number;
}

export const HAND_ROW = 15;

function record(hands: number, session: number, seed: number, matchDays: boolean) {
  const rng = seededRng(seed);
  const obs: Uint8Array[] = [];
  const masks: Uint8Array[] = [];
  const meta: number[] = [];
  const handRows: number[] = [];
  const links: number[] = [];
  let played = 0;
  while (played < hands) {
    // A table of four random personalities for the session.
    const bots: BotProfile[] = Array.from({ length: SEATS }, () => BOT_PROFILES[Math.floor(rng() * BOT_PROFILES.length)]);
    const sessionStart = meta.length / META;
    const sessionNet = [0, 0, 0, 0];
    let match: MatchContext | undefined = matchDays ? randomMatch(rng) : undefined;
    const matchRowStart = handRows.length / HAND_ROW;
    const length = match ? match.length - match.hand : session;
    let s: GameState = dealHand({ dealer: Math.floor(rng() * SEATS), roundWind: 1, dealerStreak: 0 }, shuffledWall(rng));
    let h = 0;
    for (; h < length && played < hands; h++, played++) {
      const handSamples: Sample[] = [];
      const take = (seat: number, kind: number, action: number) => {
        const mask = legalActions(s, seat);
        let options = 0;
        for (const m of mask) options += m;
        if (options < 2) return;
        handSamples.push({ obs: encodeObservation(s, seat, match), mask, action, style: STYLES.indexOf(bots[seat].id), kind, seat });
      };
      for (let steps = 0; s.phase.kind !== "over" && steps < 2000; steps++) {
        if (s.phase.kind === "turn") {
          const seat = s.phase.seat;
          const move = botTurnMoveFor(s, bots[seat], rng);
          take(seat, 0, turnMoveAction(move));
          s = applyTurnMove(s, move);
        } else {
          const claims = Array.from({ length: SEATS }, (_, i) => botClaimFor(s, i, bots[i], rng));
          for (let seat = 0; seat < SEATS; seat++) take(seat, 1, claimDecisionAction(s, claims[seat]));
          s = resolveClaims(s, claims);
        }
      }
      const deltas = s.phase.kind === "over" ? s.phase.result.deltas : [0, 0, 0, 0];
      deltas.forEach((d, seat) => (sessionNet[seat] += d));
      for (const x of handSamples) {
        obs.push(x.obs);
        masks.push(x.mask);
        meta.push(x.action, x.style, deltas[x.seat], 0, x.kind, x.seat);
        if (match) links.push(handRows.length / HAND_ROW);
      }
      if (match) {
        const before = match.totals;
        match = afterHand(match, s);
        handRows.push(match.goal, match.hand - 1, match.length, ...before, ...match.totals, 0, 0, 0, 0);
      }
      // Session net so far, filled in for the whole session at its end.
      if (s.phase.kind !== "over") break;
      let between = s;
      for (let seat = 0; seat < SEATS; seat++) for (const holder of botSurrenders(between, seat, bots[seat])) between = surrender(between, holder, seat);
      s = nextHand(between, shuffledWall(rng));
    }
    // Each decision also learns how the whole session went for its seat.
    for (let i = sessionStart; i < meta.length / META; i++) meta[i * META + 3] = sessionNet[meta[i * META + 5]];
    // Every hand of the match learns where the match ended.
    // A match cut short (this worker's hands ran out, or a hand broke off)
    // has no end: NaN, and train.py leaves it out.
    const done = h >= length;
    if (match) for (let r = matchRowStart; r < handRows.length / HAND_ROW; r++) for (let k = 0; k < 4; k++) handRows[r * HAND_ROW + 11 + k] = done ? match.totals[k] : NaN;
  }
  return { obs, masks, meta, handRows, links };
}

if (isMainThread) {
  const args = process.argv.slice(2);
  const opt = (name: string, fallback: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : fallback;
  };
  const hands = Number(opt("hands", "4000"));
  const session = Number(opt("session", "16"));
  const seed = Number(opt("seed", "1"));
  const out = opt("out", "ml/data/run1");
  const matchDays = args.includes("--match");
  const workers = Math.min(availableParallelism(), Math.max(1, Math.ceil(hands / session)));
  mkdirSync(out, { recursive: true });
  const t0 = Date.now();
  const per = Array.from({ length: workers }, (_, i) => Math.floor(hands / workers) + (i < hands % workers ? 1 : 0));
  const counts = await Promise.all(
    per.map(
      (n, w) =>
        new Promise<number>((resolve, reject) => {
          const worker = new Worker(new URL(import.meta.url), { workerData: { hands: n, session, seed: seed * 1000 + w, out, w, matchDays } });
          worker.once("message", resolve);
          worker.once("error", reject);
        })
    )
  );
  const total = counts.reduce((a, b) => a + b, 0);
  writeFileSync(
    `${out}/manifest.json`,
    JSON.stringify(
      {
        obsSize: matchDays ? OBS_SIZE_MATCH : OBS_SIZE,
        numPlanes: NUM_PLANES,
        numActions: NUM_ACTIONS,
        meta: ["action", "style", "handNet", "sessionNet", "kind", "seat"],
        styles: STYLES,
        ...(matchDays ? { match: true, handRow: ["goal", "hand", "length", "before0", "before1", "before2", "before3", "after0", "after1", "after2", "after3", "final0", "final1", "final2", "final3"] } : {}),
        shards: counts.map((n, w) => ({ w, samples: n })),
        samples: total,
        hands,
        session,
        seed,
      },
      null,
      1
    )
  );
  console.log(`${total.toLocaleString()} decisions from ${hands} hands in ${((Date.now() - t0) / 1000).toFixed(0)}s -> ${out}`);
} else {
  const { hands, session, seed, out, w, matchDays } = workerData as { hands: number; session: number; seed: number; out: string; w: number; matchDays: boolean };
  const { obs, masks, meta, handRows, links } = record(hands, session, seed, matchDays);
  const n = obs.length;
  const size = matchDays ? OBS_SIZE_MATCH : OBS_SIZE;
  const O = new Uint8Array(n * size);
  const M = new Uint8Array(n * NUM_ACTIONS);
  obs.forEach((o, i) => O.set(o, i * size));
  masks.forEach((m, i) => M.set(m, i * NUM_ACTIONS));
  writeFileSync(`${out}/obs-${w}.u8`, O);
  writeFileSync(`${out}/mask-${w}.u8`, M);
  writeFileSync(`${out}/meta-${w}.i32`, new Int32Array(meta));
  if (matchDays) {
    writeFileSync(`${out}/hands-${w}.f32`, new Float32Array(handRows));
    writeFileSync(`${out}/link-${w}.i32`, new Int32Array(links));
  }
  parentPort!.postMessage(n);
}
