import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import { Engine } from "./engine";
import type { Atlas } from "./textures";

// No WebGL here: a renderer that only notes what's asked of it, and blank
// canvases for the marks.
const renderer = { dispose: vi.fn(), forceContextLoss: vi.fn() };
vi.mock("three", async (actual) => ({
  ...(await actual<typeof import("three")>()),
  WebGLRenderer: class {
    capabilities = { getMaxAnisotropy: () => 1 };
    setClearColor() {}
    dispose = renderer.dispose;
    forceContextLoss = renderer.forceContextLoss;
  },
}));
vi.mock("./textures", () => {
  const canvas = () => ({ width: 1, height: 1 });
  return { tileShadow: canvas, rowShadow: canvas, pin: canvas, pickedRim: canvas, gapOutline: canvas, bar: canvas, bubble: canvas };
});
vi.stubGlobal("cancelAnimationFrame", () => {});

describe("the WebGL table's engine", () => {
  it("frees everything it drew with, and gives its context back", () => {
    const atlas = { canvas: { width: 1, height: 1 }, rects: new Map([["back", [0, 0, 1, 1]]]) } as unknown as Atlas;
    const e = new Engine({} as HTMLCanvasElement, atlas);
    e.sizeBubbles(100, 60, 16, 2);
    // Everything the scenes hold: meshes, geometries, materials, and their textures.
    const used = new Set<THREE.EventDispatcher<{ dispose: object }>>();
    for (const scene of [e.felt.scene, e.hand.scene])
      scene.traverse((o) => {
        if (!(o instanceof THREE.InstancedMesh)) return;
        const m = o.material as THREE.ShaderMaterial;
        used.add(o).add(o.geometry).add(m);
        for (const u of Object.values(m.uniforms)) if (u.value instanceof THREE.Texture) used.add(u.value);
      });
    expect(used.size).toBeGreaterThan(20);
    const freed = new Set<unknown>();
    for (const d of used) d.addEventListener("dispose", () => freed.add(d));
    e.dispose();
    expect([...used].filter((d) => !freed.has(d))).toEqual([]);
    expect(renderer.dispose).toHaveBeenCalled();
    expect(renderer.forceContextLoss).toHaveBeenCalled();
  });
});
