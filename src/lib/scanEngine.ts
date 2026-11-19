// Which of the scanner's engines this phone runs on, as found out by a
// scan (lib/vision.ts): the GPU one, or the plain one - which every phone
// can run, and which a phone with a GPU still falls back to when the GPU
// engine won't start or fails its first run. Kept on the phone, so what's
// fetched ahead for use with no signal (lib/offline.ts) is the files of the
// engine that will really be used - the plain one until a scan has shown
// otherwise.

export type ScanEngine = "wasm" | "webgpu";

const KEY = "mjwaits.scanEngine";

export function rememberScanEngine(engine: ScanEngine): void {
  try {
    localStorage.setItem(KEY, engine);
  } catch {
    // Private mode: just this visit.
  }
}

export function knownScanEngine(): ScanEngine {
  try {
    return localStorage.getItem(KEY) === "webgpu" ? "webgpu" : "wasm";
  } catch {
    return "wasm";
  }
}
