// Play 2.0's tile animations, timed as Play's CSS times them: its
// cubic-bezier easings and keyframes, worked out per frame for the
// WebGL table instead of by the browser.

// CSS's cubic-bezier(x1, y1, x2, y2): progress in time -> progress in value.
export function bezier(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
  const at = (a: number, b: number, s: number) => 3 * a * s * (1 - s) ** 2 + 3 * b * s * s * (1 - s) + s ** 3;
  return (t) => {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (at(x1, x2, mid) < t) lo = mid;
      else hi = mid;
    }
    return at(y1, y2, (lo + hi) / 2);
  };
}

export const EASE = bezier(0.25, 0.1, 0.25, 1);
export const EASE_IN = bezier(0.42, 0, 1, 1);
export const EASE_OUT = bezier(0, 0, 0.58, 1);

// A keyframe: at `at` (0..1 of the animation) the values `v`, eased from
// there to the next by `ease` (CSS's animation-timing-function on it).
export interface Frame {
  at: number;
  v: number[];
  ease?: (t: number) => number;
}

// The values at `t` (0..1) through `frames`.
export function keyframes(frames: Frame[], t: number): number[] {
  if (t <= frames[0].at) return frames[0].v;
  for (let i = 0; i < frames.length - 1; i++) {
    const a = frames[i];
    const b = frames[i + 1];
    if (t <= b.at) {
      const k = (a.ease ?? EASE)((t - a.at) / (b.at - a.at || 1));
      return a.v.map((x, j) => x + (b.v[j] - x) * k);
    }
  }
  return frames[frames.length - 1].v;
}
