// Loads the learned bots' network in the browser, the same way the tile
// scanner loads its model: lazily, from public/model, on onnxruntime-web's
// WASM build. Resolves to null when there's no model (or it can't load), so
// the Play table simply doesn't offer learned opponents.

import { modelUrl } from "../modelUrl";
import { NUM_ACTIONS, OBS_SIZE } from "./encode";
import type { PolicyRunner } from "./policy";

export interface LearnedModel {
  run: PolicyRunner;
  styles: string[];
  // How the model was made, shown in the Opponents sheet.
  label: string;
}

let loading: Promise<LearnedModel | null> | null = null;

export function loadLearnedModel(): Promise<LearnedModel | null> {
  loading ??= (async () => {
    try {
      const base = `${import.meta.env.BASE_URL}model/`;
      const metaResponse = await fetch(`${base}mj-policy.json`);
      if (!metaResponse.ok) return null;
      const meta = (await metaResponse.json()) as { styles: string[]; obsSize: number; numActions: number; label?: string };
      // A model trained on another encoding would read the table wrong.
      if (meta.obsSize !== OBS_SIZE || meta.numActions !== NUM_ACTIONS) return null;
      // (The runtime only once a learned bot is wanted - not with the Play table.)
      const [ortWasm, buffer] = await Promise.all([import("onnxruntime-web/wasm"), fetch(modelUrl("mj-policy.onnx")).then((r) => r.arrayBuffer())]);
      const session = await ortWasm.InferenceSession.create(buffer, { executionProviders: ["wasm"] });
      const run: PolicyRunner = async (obs, style, mask) => {
        const out = await session.run({
          obs: new ortWasm.Tensor("float32", obs, [1, OBS_SIZE]),
          style: new ortWasm.Tensor("int64", BigInt64Array.from([BigInt(style)]), [1]),
          mask: new ortWasm.Tensor("float32", mask, [1, NUM_ACTIONS]),
        });
        return { logits: out.logits.data as Float32Array, value: (out.value.data as Float32Array)[0] };
      };
      return { run, styles: meta.styles, label: meta.label ?? "learned" };
    } catch {
      return null;
    }
  })();
  return loading;
}
