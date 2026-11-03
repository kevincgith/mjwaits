import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The model loading in vision.ts, with the download and onnxruntime faked -
// kept apart from vision.test.ts because the loaded engine is module state.

const sessionCreate = vi.fn();
vi.mock("onnxruntime-web/wasm", () => ({
  InferenceSession: { create: (...args: unknown[]) => sessionCreate(...args) },
  // The faked sessions never look at their input.
  Tensor: class {},
}));

const gpuSessionCreate = vi.fn();
vi.mock("onnxruntime-web/webgpu", () => ({
  InferenceSession: { create: (...args: unknown[]) => gpuSessionCreate(...args) },
  // The faked sessions never look at their input.
  Tensor: class {},
}));

// One small tile, so detectTiles doesn't go on to a shrunk re-read.
const oneTile = { output0: { data: new Float32Array([100, 100, 120, 130, 0.9, 0]), dims: [1, 1, 6] } };

const fakeBox = () => {
  const canvas = { getContext: () => ({ getImageData: () => ({ data: new Uint8ClampedArray(640 * 640 * 4) }) }) };
  return { canvas, size: 640 } as unknown as import("./vision").Letterbox;
};

beforeEach(() => {
  vi.resetModules();
  sessionCreate.mockReset();
  gpuSessionCreate.mockReset();
  sessionCreate.mockResolvedValue({ run: async () => oneTile, release: async () => {} });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("loading the tile detector", () => {
  it("tries the download again after a failed one, rather than keeping the failure", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("network down"))
      .mockResolvedValue(new Response(new ArrayBuffer(8)));
    vi.stubGlobal("fetch", fetchMock);
    const vision = await import("./vision");

    await expect(vision.detectTiles(fakeBox(), () => {})).rejects.toThrow("network down");
    const result = await vision.detectTiles(fakeBox(), () => {});
    expect(result.tiles).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(await vision.detectorBackend()).toBe("wasm");
  });

  it("keeps a loaded engine rather than downloading it again", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response(new ArrayBuffer(8)));
    vi.stubGlobal("fetch", fetchMock);
    const vision = await import("./vision");

    vision.prefetchModel();
    await vision.detectTiles(fakeBox());
    await vision.detectTiles(fakeBox());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("drops a GPU engine that fails mid-session for the CPU one, and frees it", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => new Response(new ArrayBuffer(8))));
    vi.stubGlobal("navigator", { gpu: { requestAdapter: async () => ({}) } });
    const release = vi.fn(async () => {});
    let gpuRuns = 0;
    gpuSessionCreate.mockResolvedValue({
      // The warm-up run works; the real one then fails, as a lost device would.
      run: async () => {
        if (gpuRuns++ > 0) throw new Error("device lost");
        return oneTile;
      },
      release,
    });
    const vision = await import("./vision");

    expect(await vision.detectorBackend()).toBe("webgpu");
    const result = await vision.detectTiles(fakeBox(), () => {});
    expect(result.tiles).toHaveLength(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect(await vision.detectorBackend()).toBe("wasm");
  });
});
