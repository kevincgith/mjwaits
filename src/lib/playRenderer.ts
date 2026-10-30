// Which table Play draws: the WebGL one (play3d/) - or Legacy,
// the page's own 3D CSS, on a phone without WebGL. "mjwaits.playRenderer"
// ("dom" / "webgl") overrides it, as the e2e tests do for Legacy's flows.

export type PlayRenderer = "dom" | "webgl";

const KEY = "mjwaits.playRenderer";

let found: PlayRenderer | null = null;

export function playRenderer(): PlayRenderer {
  try {
    const set = window.localStorage.getItem(KEY);
    if (set === "dom" || set === "webgl") return set;
  } catch {
    // Storage blocked - as the phone allows, then.
  }
  if (found) return found;
  try {
    const c = document.createElement("canvas");
    found = c.getContext("webgl2") || c.getContext("webgl") ? "webgl" : "dom";
  } catch {
    found = "dom";
  }
  return found;
}
