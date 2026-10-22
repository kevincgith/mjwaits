// npm run ml-selfplay -- --model ml/runs/bc2 [--hands 4000] [--session 16] [--temp 1] [--seed 1] [--out ml/data/sp1]
//                        [--rules grandmaster,veteran,gambler]   (rule bots for two seats of every table)
//                        [--label teacher]   (DAgger: record what the rule bot of that style would do)
//
// --label teacher: the network still plays (so the positions are the ones
// IT reaches), but each recorded action is the rule bot's choice there -
// the corrections behaviour cloning needs where its own mistakes have
// taken it off the teacher's path. Train on it with the original data
// (train.py --data a,b).
//
// Stage 2 data: the network plays itself. Every seat is the network as a
// random personality, sampling its moves (temperature 1 = as it believes),
// and every real decision is recorded with the probability the network gave
// the move it made - what PPO training needs (ml/train.py --rl) - plus the
// hand's outcome for that seat: net tai, the tai of its own win (0 if it
// didn't win), whether it dealt in, and how many discards it made before
// the hand ended. Each personality's reward is shaped from these in
// train.py, so styles come from what they're rewarded for.
//
// Output per worker w, N samples: obs-w.u8, mask-w.u8 (as ml-data.ts),
//   meta-w.i32  N x 6  action, style, hand net, session net, kind, seat
//   extra-w.f32 N x 4  log-prob of the action, own win tai, dealt in (0/1), discards made
// and manifest.json.
//
// A v2 model (trained with match-day inputs, encode.ts OBS_SIZE_MATCH)
// plays match days instead of sessions, as ml-data.ts --match does, and the
// hands-w.f32 / link-w.i32 files are written alongside.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import * as ort from "onnxruntime-node";
import { botClaimFor, botSurrenders, botTurnMoveFor, profileById, seededRng, type BotProfile, type Rng } from "../src/lib/bots";
import { applyTurnMove, dealHand, fullWall, nextHand, resolveClaims, SEATS, surrender, type Claim, type GameState, type WallTile } from "../src/lib/game";
import { actionToClaim, actionToTurnMove, claimDecisionAction, encodeObservation, legalActions, NUM_ACTIONS, NUM_PLANES, OBS_SIZE, OBS_SIZE_MATCH, turnMoveAction } from "../src/lib/ml/encode";
import { afterHand, randomMatch, type MatchContext } from "../src/lib/ml/match";
import { sample } from "../src/lib/ml/policy";

const META = 6;
const HAND_ROW = 15;

function shuffledWall(rng: Rng): WallTile[] {
  const w = fullWall();
  for (let i = w.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [w[i], w[j]] = [w[j], w[i]];
  }
  return w;
}

// `rules`: rule bots to seat at two of the four places at every table (random
// seats, random picks), so the network doesn't only learn to beat itself.
// Their decisions aren't recorded.
// `onHand`: told the hands played so far after each one (for the dashboard).
async function selfPlay(modelDir: string, hands: number, session: number, temperature: number, seed: number, rules: BotProfile[], teacher: boolean, onHand?: (played: number) => void) {
  const meta = JSON.parse(readFileSync(`${modelDir}/meta.json`, "utf8")) as { styles: string[]; obsSize: number; numActions: number };
  if ((meta.obsSize !== OBS_SIZE && meta.obsSize !== OBS_SIZE_MATCH) || meta.numActions !== NUM_ACTIONS) throw new Error("Model was trained on a different encoding");
  const matchDays = meta.obsSize === OBS_SIZE_MATCH;
  const handRows: number[] = [];
  const links: number[] = [];
  let match: MatchContext | undefined;
  // The native runtime, one thread: several of these run side by side.
  const net = await ort.InferenceSession.create(readFileSync(`${modelDir}/policy.onnx`), { intraOpNumThreads: 1, interOpNumThreads: 1 });
  const rng = seededRng(seed);
  const obsOut: Uint8Array[] = [];
  const maskOut: Uint8Array[] = [];
  const metaOut: number[] = [];
  const extraOut: number[] = [];

  // One decision: run the network, sample, and return the action with its log-prob.
  // The teacher's own random stream, so labelling doesn't change the play.
  const teacherRng = seededRng(seed + 7919);
  const decide = async (s: GameState, seat: number, style: number) => {
    const mask = legalActions(s, seat);
    let options = 0;
    for (const m of mask) options += m;
    if (options === 0) return null;
    // One legal move (most claim checks: only pass) - nothing to decide, and
    // not recorded, so no need to encode or run the network.
    if (options === 1) return { action: mask.indexOf(1), logp: 0, obs: new Uint8Array(0), mask, record: false };
    const obs = encodeObservation(s, seat, match);
    const out = await net.run({
      obs: new ort.Tensor("float32", Float32Array.from(obs), [1, obs.length]),
      style: new ort.Tensor("int64", BigInt64Array.from([BigInt(style)]), [1]),
      mask: new ort.Tensor("float32", Float32Array.from(mask), [1, NUM_ACTIONS]),
    });
    const logits = out.logits.data as Float32Array;
    const action = sample(logits, mask, temperature, rng);
    // log-softmax at the sampling temperature, over legal actions.
    let max = -Infinity;
    for (let a = 0; a < NUM_ACTIONS; a++) if (mask[a]) max = Math.max(max, logits[a] / Math.max(temperature, 1e-6));
    let z = 0;
    for (let a = 0; a < NUM_ACTIONS; a++) if (mask[a]) z += Math.exp(logits[a] / Math.max(temperature, 1e-6) - max);
    const logp = logits[action] / Math.max(temperature, 1e-6) - max - Math.log(z);
    return { action, logp, obs, mask, record: options > 1 };
  };

  let played = 0;
  while (played < hands) {
    const styles = Array.from({ length: SEATS }, () => Math.floor(rng() * meta.styles.length));
    // Which seats are rule bots this session (none without --rules).
    const ruleSeat: (BotProfile | null)[] = [null, null, null, null];
    if (rules.length) {
      const seats = [0, 1, 2, 3].sort(() => rng() - 0.5).slice(0, 2);
      for (const seat of seats) ruleSeat[seat] = rules[Math.floor(rng() * rules.length)];
    }
    const sessionStart = metaOut.length / META;
    const sessionNet = [0, 0, 0, 0];
    match = matchDays ? randomMatch(rng) : undefined;
    const matchRowStart = handRows.length / HAND_ROW;
    const length = match ? match.length - match.hand : session;
    let s: GameState = dealHand({ dealer: Math.floor(rng() * SEATS), roundWind: 1, dealerStreak: 0 }, shuffledWall(rng));
    let h = 0;
    for (; h < length && played < hands; h++, played++) {
      const pending: { obs: Uint8Array; mask: Uint8Array; action: number; logp: number; kind: number; seat: number }[] = [];
      for (let steps = 0; s.phase.kind !== "over" && steps < 2000; steps++) {
        if (s.phase.kind === "turn") {
          const seat = s.phase.seat;
          if (ruleSeat[seat]) {
            s = applyTurnMove(s, botTurnMoveFor(s, ruleSeat[seat]!, rng));
            continue;
          }
          const d = (await decide(s, seat, styles[seat]))!;
          if (d.record) pending.push({ obs: d.obs, mask: d.mask, action: teacher ? turnMoveAction(botTurnMoveFor(s, profileById(meta.styles[styles[seat]]), teacherRng)) : d.action, logp: d.logp, kind: 0, seat });
          s = applyTurnMove(s, actionToTurnMove(s, d.action));
        } else {
          const claims: (Claim | null)[] = [];
          for (let seat = 0; seat < SEATS; seat++) {
            if (ruleSeat[seat]) {
              claims.push(botClaimFor(s, seat, ruleSeat[seat]!, rng));
              continue;
            }
            const d = await decide(s, seat, styles[seat]);
            if (d?.record)
              pending.push({ obs: d.obs, mask: d.mask, action: teacher ? claimDecisionAction(s, botClaimFor(s, seat, profileById(meta.styles[styles[seat]]), teacherRng)) : d.action, logp: d.logp, kind: 1, seat });
            claims.push(d ? actionToClaim(s, seat, d.action) : null);
          }
          s = resolveClaims(s, claims);
        }
      }
      if (s.phase.kind !== "over") break;
      const r = s.phase.result;
      r.deltas.forEach((d, seat) => (sessionNet[seat] += d));
      for (const x of pending) {
        obsOut.push(x.obs);
        maskOut.push(x.mask);
        metaOut.push(x.action, styles[x.seat], r.deltas[x.seat], 0, x.kind, x.seat);
        extraOut.push(x.logp, r.winner === x.seat ? (r.score?.total ?? 0) : 0, r.from === x.seat ? 1 : 0, s.players[x.seat].discards.length);
        if (match) links.push(handRows.length / HAND_ROW);
      }
      if (match) {
        const before = match.totals;
        match = afterHand(match, s);
        handRows.push(match.goal, match.hand - 1, match.length, ...before, ...match.totals, 0, 0, 0, 0);
      }
      for (let seat = 0; seat < SEATS; seat++) if (ruleSeat[seat]) for (const holder of botSurrenders(s, seat, ruleSeat[seat]!)) s = surrender(s, holder, seat);
      s = nextHand(s, shuffledWall(rng));
      onHand?.(played + 1);
    }
    for (let i = sessionStart; i < metaOut.length / META; i++) metaOut[i * META + 3] = sessionNet[metaOut[i * META + 5]];
    // Where the match ended, for every hand of it (NaN if it was cut short).
    const done = h >= length;
    if (match) for (let r = matchRowStart; r < handRows.length / HAND_ROW; r++) for (let k = 0; k < 4; k++) handRows[r * HAND_ROW + 11 + k] = done ? match.totals[k] : NaN;
  }
  return { obsOut, maskOut, metaOut, extraOut, handRows, links, matchDays, styles: meta.styles };
}

if (isMainThread) {
  const args = process.argv.slice(2);
  const opt = (name: string, fallback: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : fallback;
  };
  const model = opt("model", "ml/runs/bc2");
  const hands = Number(opt("hands", "4000"));
  const session = Number(opt("session", "16"));
  const temperature = Number(opt("temp", "1"));
  const rules = opt("rules", "");
  const teacher = opt("label", "self") === "teacher";
  const seed = Number(opt("seed", "1"));
  const out = opt("out", "ml/data/sp1");
  // Short jobs of at most JOB_HANDS hands, each in a fresh worker, run
  // availableParallelism() at a time: a worker that plays thousands of
  // hands grows the network runtime's memory until Node crashes.
  const JOB_HANDS = 500;
  const modelMeta = JSON.parse(readFileSync(`${model}/meta.json`, "utf8")) as { obsSize: number };
  const jobs = Array.from({ length: Math.ceil(hands / JOB_HANDS) }, (_, j) => Math.min(JOB_HANDS, hands - j * JOB_HANDS));
  mkdirSync(out, { recursive: true });
  const t0 = Date.now();
  const results: { n: number; styles: string[] }[] = new Array(jobs.length);
  let next = 0;
  const runJob = (j: number) =>
    new Promise<void>((resolve, reject) => {
      const worker = new Worker(new URL(import.meta.url), { workerData: { model, hands: jobs[j], session, temperature, seed: seed * 1000 + j, out, w: j, rules, teacher } });
      worker.once("message", (r) => {
        results[j] = r;
        void worker.terminate();
        resolve();
      });
      worker.once("error", reject);
    });
  await Promise.all(
    Array.from({ length: Math.min(availableParallelism(), jobs.length) }, async () => {
      while (next < jobs.length) await runJob(next++);
    })
  );
  const total = results.reduce((a, b) => a + b.n, 0);
  writeFileSync(
    `${out}/manifest.json`,
    JSON.stringify(
      {
        obsSize: modelMeta.obsSize,
        ...(modelMeta.obsSize === OBS_SIZE_MATCH ? { match: true } : {}),
        numPlanes: NUM_PLANES,
        numActions: NUM_ACTIONS,
        meta: ["action", "style", "handNet", "sessionNet", "kind", "seat"],
        extra: ["logp", "winTai", "dealtIn", "discards"],
        styles: results[0].styles,
        shards: results.map((r, w) => ({ w, samples: r.n })),
        samples: total,
        model,
        temperature,
        hands,
        session,
        seed,
      },
      null,
      1
    )
  );
  console.log(`${total.toLocaleString()} self-play decisions from ${hands} hands in ${((Date.now() - t0) / 1000).toFixed(0)}s -> ${out}`);
} else {
  const { model, hands, session, temperature, seed, out, w, rules, teacher } = workerData as { model: string; hands: number; session: number; temperature: number; seed: number; out: string; w: number; rules: string; teacher: boolean };
  const { obsOut, maskOut, metaOut, extraOut, handRows, links, matchDays, styles } = await selfPlay(model, hands, session, temperature, seed, rules ? rules.split(",").map(profileById) : [], teacher, (n) => writeFileSync(`${out}/progress-${w}`, String(n)));
  const n = obsOut.length;
  const size = matchDays ? OBS_SIZE_MATCH : OBS_SIZE;
  const O = new Uint8Array(n * size);
  const M = new Uint8Array(n * NUM_ACTIONS);
  obsOut.forEach((o, i) => O.set(o, i * size));
  maskOut.forEach((m, i) => M.set(m, i * NUM_ACTIONS));
  writeFileSync(`${out}/obs-${w}.u8`, O);
  writeFileSync(`${out}/mask-${w}.u8`, M);
  writeFileSync(`${out}/meta-${w}.i32`, new Int32Array(metaOut));
  writeFileSync(`${out}/extra-${w}.f32`, new Float32Array(extraOut));
  if (matchDays) {
    writeFileSync(`${out}/hands-${w}.f32`, new Float32Array(handRows));
    writeFileSync(`${out}/link-${w}.i32`, new Int32Array(links));
  }
  parentPort!.postMessage({ n, styles });
}
