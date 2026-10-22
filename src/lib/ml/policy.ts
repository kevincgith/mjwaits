// Playing with a trained network (ml/train.py): turn its output into a move
// or a claim. The network itself runs wherever its runner lives -
// onnxruntime-web in the browser, the same package's WASM build in the
// arena under Node - so this file stays free of any runtime and only maps
// positions in and decisions out, through encode.ts.

import type { Claim, GameState, TurnMove } from "../game";
import { actionToClaim, actionToTurnMove, encodeObservation, legalActions, NUM_ACTIONS, OBS_SIZE } from "./encode";

// Runs the network on a batch of one: the raw observation, the style id and
// the legal mask in; logits (illegal at -1e9) and the value out.
export type PolicyRunner = (obs: Float32Array, style: number, mask: Float32Array) => Promise<{ logits: Float32Array; value: number }>;

export interface LearnedBot {
  run: PolicyRunner;
  // Index into the trained model's styles (meta.json) - which personality it plays.
  style: number;
  // Sampling temperature: 0 always plays the top move; around 0.5-1 plays
  // like the data, mistakes included.
  temperature: number;
}

async function decide(bot: LearnedBot, s: GameState, seat: number, rng: () => number): Promise<{ action: number; value: number } | null> {
  const mask = legalActions(s, seat);
  if (!mask.some(Boolean)) return null;
  const obs = Float32Array.from(encodeObservation(s, seat));
  const { logits, value } = await bot.run(obs, bot.style, Float32Array.from(mask));
  return { action: sample(logits, mask, bot.temperature, rng), value };
}

export function sample(logits: Float32Array, mask: Uint8Array, temperature: number, rng: () => number): number {
  let best = -1;
  for (let a = 0; a < NUM_ACTIONS; a++) if (mask[a] && (best < 0 || logits[a] > logits[best])) best = a;
  if (temperature <= 0 || best < 0) return best;
  let total = 0;
  const w = new Float64Array(NUM_ACTIONS);
  for (let a = 0; a < NUM_ACTIONS; a++) if (mask[a]) total += w[a] = Math.exp((logits[a] - logits[best]) / temperature);
  let x = rng() * total;
  for (let a = 0; a < NUM_ACTIONS; a++) {
    if (!mask[a]) continue;
    x -= w[a];
    if (x <= 0) return a;
  }
  return best;
}

export async function learnedTurnMove(bot: LearnedBot, s: GameState, rng: () => number = Math.random): Promise<TurnMove> {
  if (s.phase.kind !== "turn") throw new Error("Not a turn");
  const d = await decide(bot, s, s.phase.seat, rng);
  if (!d) throw new Error("No legal move");
  return actionToTurnMove(s, d.action);
}

export async function learnedClaim(bot: LearnedBot, s: GameState, seat: number, rng: () => number = Math.random): Promise<Claim | null> {
  const d = await decide(bot, s, seat, rng);
  return d ? actionToClaim(s, seat, d.action) : null;
}

export { OBS_SIZE };
