// npm run ml-selfplay -- --model ml/runs/bc2 [--hands 4000] [--session 16] [--temp 1] [--seed 1] [--out ml/data/sp1]
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

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import * as ort from "onnxruntime-web/wasm";
import { seededRng, type Rng } from "../src/lib/bots";
import { applyTurnMove, dealHand, fullWall, nextHand, resolveClaims, SEATS, type Claim, type GameState, type WallTile } from "../src/lib/game";
import { actionToClaim, actionToTurnMove, encodeObservation, legalActions, NUM_ACTIONS, OBS_SIZE } from "../src/lib/ml/encode";
import { sample } from "../src/lib/ml/policy";

const META = 6;

function shuffledWall(rng: Rng): WallTile[] {
  const w = fullWall();
  for (let i = w.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [w[i], w[j]] = [w[j], w[i]];
  }
  return w;
}

async function selfPlay(modelDir: string, hands: number, session: number, temperature: number, seed: number) {
  const meta = JSON.parse(readFileSync(`${modelDir}/meta.json`, "utf8")) as { styles: string[]; obsSize: number; numActions: number };
  if (meta.obsSize !== OBS_SIZE || meta.numActions !== NUM_ACTIONS) throw new Error("Model was trained on a different encoding");
  ort.env.wasm.numThreads = 1;
  const net = await ort.InferenceSession.create(readFileSync(`${modelDir}/policy.onnx`));
  const rng = seededRng(seed);
  const obsOut: Uint8Array[] = [];
  const maskOut: Uint8Array[] = [];
  const metaOut: number[] = [];
  const extraOut: number[] = [];

  // One decision: run the network, sample, and return the action with its log-prob.
  const decide = async (s: GameState, seat: number, style: number) => {
    const mask = legalActions(s, seat);
    let options = 0;
    for (const m of mask) options += m;
    if (options === 0) return null;
    const obs = encodeObservation(s, seat);
    const out = await net.run({
      obs: new ort.Tensor("float32", Float32Array.from(obs), [1, OBS_SIZE]),
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
    const sessionStart = metaOut.length / META;
    const sessionNet = [0, 0, 0, 0];
    let s: GameState = dealHand({ dealer: Math.floor(rng() * SEATS), roundWind: 1, dealerStreak: 0 }, shuffledWall(rng));
    for (let h = 0; h < session && played < hands; h++, played++) {
      const pending: { obs: Uint8Array; mask: Uint8Array; action: number; logp: number; kind: number; seat: number }[] = [];
      for (let steps = 0; s.phase.kind !== "over" && steps < 2000; steps++) {
        if (s.phase.kind === "turn") {
          const seat = s.phase.seat;
          const d = (await decide(s, seat, styles[seat]))!;
          if (d.record) pending.push({ obs: d.obs, mask: d.mask, action: d.action, logp: d.logp, kind: 0, seat });
          s = applyTurnMove(s, actionToTurnMove(s, d.action));
        } else {
          const claims: (Claim | null)[] = [];
          for (let seat = 0; seat < SEATS; seat++) {
            const d = await decide(s, seat, styles[seat]);
            if (d?.record) pending.push({ obs: d.obs, mask: d.mask, action: d.action, logp: d.logp, kind: 1, seat });
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
      }
      s = nextHand(s, shuffledWall(rng));
    }
    for (let i = sessionStart; i < metaOut.length / META; i++) metaOut[i * META + 3] = sessionNet[metaOut[i * META + 5]];
  }
  return { obsOut, maskOut, metaOut, extraOut, styles: meta.styles };
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
  const seed = Number(opt("seed", "1"));
  const out = opt("out", "ml/data/sp1");
  const workers = Math.min(availableParallelism(), Math.max(1, Math.ceil(hands / session)));
  mkdirSync(out, { recursive: true });
  const t0 = Date.now();
  const per = Array.from({ length: workers }, (_, i) => Math.floor(hands / workers) + (i < hands % workers ? 1 : 0));
  const results = await Promise.all(
    per.map(
      (n, w) =>
        new Promise<{ n: number; styles: string[] }>((resolve, reject) => {
          const worker = new Worker(new URL(import.meta.url), { workerData: { model, hands: n, session, temperature, seed: seed * 1000 + w, out, w } });
          worker.once("message", resolve);
          worker.once("error", reject);
        })
    )
  );
  const total = results.reduce((a, b) => a + b.n, 0);
  writeFileSync(
    `${out}/manifest.json`,
    JSON.stringify(
      {
        obsSize: OBS_SIZE,
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
  const { model, hands, session, temperature, seed, out, w } = workerData as { model: string; hands: number; session: number; temperature: number; seed: number; out: string; w: number };
  const { obsOut, maskOut, metaOut, extraOut, styles } = await selfPlay(model, hands, session, temperature, seed);
  const n = obsOut.length;
  const O = new Uint8Array(n * OBS_SIZE);
  const M = new Uint8Array(n * NUM_ACTIONS);
  obsOut.forEach((o, i) => O.set(o, i * OBS_SIZE));
  maskOut.forEach((m, i) => M.set(m, i * NUM_ACTIONS));
  writeFileSync(`${out}/obs-${w}.u8`, O);
  writeFileSync(`${out}/mask-${w}.u8`, M);
  writeFileSync(`${out}/meta-${w}.i32`, new Int32Array(metaOut));
  writeFileSync(`${out}/extra-${w}.f32`, new Float32Array(extraOut));
  parentPort!.postMessage({ n, styles });
}
