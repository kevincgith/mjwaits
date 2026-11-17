// The Dice tab's dice, as Play's engine draws them (see engine's die mesh):
// real rounded cubes on the felt, lit as the tiles are, thrown by a small
// physics simulation - in from your edge of the table, in the air, a bounce
// or two on the felt, then rolling to a stop. They hit only what's there:
// each other, and (擲骰) the wall round them - never an unseen edge; each
// throw is aimed so the dice come to rest where they're meant to land.
//
// All in the felt's own px and CSS's axes (x right, y down, z up off it).

import { chain, scale, translate, type Mat } from "./mat";
import type { Anim, Quad } from "./layout";

// Rotations as quaternions [w, x, y, z].
export type Quat = [number, number, number, number];
export const qMul = (a: Quat, b: Quat): Quat => [
  a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
  a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
  a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
  a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
];
export const qAxis = (x: number, y: number, z: number, angle: number): Quat => {
  const h = Math.sin(angle / 2);
  return [Math.cos(angle / 2), x * h, y * h, z * h];
};
const qConj = (q: Quat): Quat => [q[0], -q[1], -q[2], -q[3]];
// The rotation as a matrix (column-major, as mat.ts).
function qMat([w, x, y, z]: Quat): Mat {
  const m = new Float32Array(16);
  m[0] = 1 - 2 * (y * y + z * z);
  m[1] = 2 * (x * y + w * z);
  m[2] = 2 * (x * z - w * y);
  m[4] = 2 * (x * y - w * z);
  m[5] = 1 - 2 * (x * x + z * z);
  m[6] = 2 * (y * z + w * x);
  m[8] = 2 * (x * z + w * y);
  m[9] = 2 * (y * z - w * x);
  m[10] = 1 - 2 * (x * x + y * y);
  m[15] = 1;
  return m;
}
// Between two rotations, `t` of the way (the short way round).
function qBlend(a: Quat, b: Quat, t: number): Quat {
  const s = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3] < 0 ? -1 : 1;
  const q = a.map((v, i) => v + (s * b[i] - v) * t) as Quat;
  const l = Math.hypot(...q);
  return q.map((v) => v / l) as Quat;
}

// The cube's faces (see the engine's die shader): 1 up (+z), 6 down, 2 and
// 5 toward and away from you (+y, -y), 3 and 4 right and left (+x, -x).
// The turn that brings each value's face up.
const FACE_UP: Record<number, Quat> = {
  1: [1, 0, 0, 0],
  2: qAxis(1, 0, 0, Math.PI / 2),
  3: qAxis(0, 1, 0, -Math.PI / 2),
  4: qAxis(0, 1, 0, Math.PI / 2),
  5: qAxis(1, 0, 0, -Math.PI / 2),
  6: qAxis(1, 0, 0, Math.PI),
};

export interface Box {
  l: number;
  t: number;
  r: number;
  b: number;
}
export interface ThrowFrame {
  x: number;
  y: number;
  /** Height above the felt, px. */
  z: number;
  q: Quat;
}
export const THROW_FPS = 60;
// The longest a throw lasts (the result shows as it ends).
export const THROW_MS = 1300;

// The physics, for dice `size` px across (as the old 30px dice had it,
// scaled): gravity, the felt's drag on a rolling die, the bounce.
const physics = (size: number) => {
  const k = size / 30;
  return { g: 1100 * k, drag: 160 * k, settle: 45 * k, rad: size * 0.62 };
};

// One die alone on the felt: how far it goes, thrown at `speed`.
function travel(size: number, speed: number, z: number, vz: number): number {
  const { g, drag, settle } = physics(size);
  const dt = 1 / 240;
  let v = speed;
  let d = 0;
  for (let step = 0; step < (240 * THROW_MS) / 1000; step++) {
    if (z > 0 || vz > 0) {
      vz -= g * dt;
      z += vz * dt;
      if (z <= 0) {
        z = 0;
        vz = -vz * 0.38;
        if (vz < settle) vz = 0;
      }
    }
    if (z <= 0.5) v = Math.max(0, v * (1 - 1.5 * dt) - drag * dt);
    d += v * dt;
    if (v === 0 && z === 0 && vz === 0) break;
  }
  return d;
}

// The edges of a convex fence (the wall's inner face), each with the way in.
function fenceEdges(fence: [number, number][]) {
  const cx = fence.reduce((s, p) => s + p[0], 0) / fence.length;
  const cy = fence.reduce((s, p) => s + p[1], 0) / fence.length;
  return fence.map((a, i) => {
    const b = fence[(i + 1) % fence.length];
    let nx = a[1] - b[1];
    let ny = b[0] - a[0];
    const l = Math.hypot(nx, ny);
    nx /= l;
    ny /= l;
    if ((cx - a[0]) * nx + (cy - a[1]) * ny < 0) [nx, ny] = [-nx, -ny];
    return { a, nx, ny };
  });
}

// `n` dice thrown up the table from `from` (the y they leave the hand at,
// at your edge), to come to rest inside `land`. Each die's place and turn
// at THROW_FPS, until all have stopped; its last frame is where it rests.
export function simulateThrow(o: { land: Box; from: number; size: number; n: number; fence?: [number, number][]; random?: () => number }): ThrowFrame[][] {
  const rnd = o.random ?? Math.random;
  const { size, n, land } = o;
  const { g, drag, settle, rad } = physics(size);
  const edges = o.fence ? fenceEdges(o.fence) : [];
  const W = land.r - land.l;
  const H = land.b - land.t;
  let best: { frames: ThrowFrame[][]; miss: number } | null = null;
  for (let attempt = 0; attempt < 12; attempt++) {
    const dice = Array.from({ length: n }, (_, i) => {
      const lane = i - (n - 1) / 2;
      // Where it's meant to stop: its own share of the box, across.
      const tx = land.l + W / 2 + lane * (W / n) * 0.75 + (rnd() - 0.5) * (W / n) * 0.35;
      const ty = land.t + H * (0.25 + rnd() * 0.5);
      const x = tx + (rnd() - 0.5) * size * 1.5 + lane * size * 0.4;
      const y = o.from;
      const z = (38 + rnd() * 14) * (size / 30);
      const vz = (40 + rnd() * 60) * (size / 30);
      const dist = Math.hypot(tx - x, ty - y);
      // As fast as takes it there (the farther, the faster - by halves).
      let lo = 0;
      let hi = 8000 * (size / 30);
      for (let k = 0; k < 24; k++) {
        const mid = (lo + hi) / 2;
        if (travel(size, mid, z, vz) < dist) lo = mid;
        else hi = mid;
      }
      const speed = (lo + hi) / 2;
      const sa = rnd() * Math.PI * 2;
      const sb = Math.acos(2 * rnd() - 1);
      return {
        x,
        y,
        z,
        vz,
        vx: ((tx - x) / dist) * speed,
        vy: ((ty - y) / dist) * speed,
        spin: [Math.sin(sb) * Math.cos(sa), Math.sin(sb) * Math.sin(sa), Math.cos(sb)] as const,
        q: qAxis(0, 0, 1, (rnd() - 0.5) * Math.PI),
        // Inside the wall yet (it's thrown in over it).
        inside: false,
      };
    });
    const frames: ThrowFrame[][] = dice.map(() => []);
    const dt = 1 / 240;
    for (let step = 0; step < (240 * THROW_MS) / 1000; step++) {
      for (const d of dice) {
        if (d.z > 0 || d.vz > 0) {
          d.vz -= g * dt;
          d.z += d.vz * dt;
          if (d.z <= 0) {
            d.z = 0;
            d.vz = -d.vz * 0.38;
            if (d.vz < settle) d.vz = 0;
          }
        }
        const flying = d.z > 0.5;
        const v = Math.hypot(d.vx, d.vy);
        const nv = flying ? v : Math.max(0, v * (1 - 1.5 * dt) - drag * dt);
        if (v > 0) {
          d.vx *= nv / v;
          d.vy *= nv / v;
        }
        d.x += d.vx * dt;
        d.y += d.vy * dt;
        // The wall: once it's in, it bounces back off it.
        if (edges.length) {
          const into = edges.map((e) => (d.x - e.a[0]) * e.nx + (d.y - e.a[1]) * e.ny);
          if (!d.inside) d.inside = into.every((s) => s >= rad);
          else
            edges.forEach((e, k) => {
              if (into[k] >= rad) return;
              d.x += (rad - into[k]) * e.nx;
              d.y += (rad - into[k]) * e.ny;
              const vn = d.vx * e.nx + d.vy * e.ny;
              if (vn < 0) {
                d.vx -= 1.6 * vn * e.nx;
                d.vy -= 1.6 * vn * e.ny;
              }
            });
        }
        // In the air it spins freely; on the felt it rolls without sliding.
        const dist = nv * dt;
        if (flying) d.q = qMul(qAxis(d.spin[0], d.spin[1], d.spin[2], 16 * dt), d.q);
        else if (dist > 0) d.q = qMul(qAxis(-d.vy / nv, d.vx / nv, 0, dist / (size / 2)), d.q);
      }
      // Dice knock into each other: pushed apart, trading speed along the hit.
      for (let i = 0; i < n; i++)
        for (let j = i + 1; j < n; j++) {
          const a = dice[i];
          const b = dice[j];
          if (Math.abs(a.z - b.z) > size) continue;
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const d = Math.hypot(dx, dy) || 0.01;
          if (d >= rad * 2) continue;
          const nx = dx / d;
          const ny = dy / d;
          const push = (rad * 2 - d) / 2;
          a.x -= nx * push;
          a.y -= ny * push;
          b.x += nx * push;
          b.y += ny * push;
          const closing = (a.vx - b.vx) * nx + (a.vy - b.vy) * ny;
          if (closing > 0) {
            const k = (closing * 1.75) / 2;
            a.vx -= k * nx;
            a.vy -= k * ny;
            b.vx += k * nx;
            b.vy += k * ny;
          }
        }
      if (step % (240 / THROW_FPS) === 0) dice.forEach((d, i) => frames[i].push({ x: d.x, y: d.y, z: d.z, q: d.q }));
      if (step > 60 && dice.every((d) => d.z === 0 && d.vz === 0 && Math.hypot(d.vx, d.vy) < 4)) break;
    }
    dice.forEach((d, i) => frames[i].push({ x: d.x, y: d.y, z: 0, q: d.q }));
    // How far outside where they should be (knocked about, they may stray):
    // the throw that lands best is kept.
    const miss = dice.reduce((s, d) => s + Math.max(0, land.l - d.x, d.x - land.r) + Math.max(0, land.t - d.y, d.y - land.b), 0);
    if (!best || miss < best.miss) best = { frames, miss };
    if (miss === 0) break;
  }
  return best!.frames;
}

// A throw, ready to draw: each die's path (in the felt px it was thrown at,
// `width`), the turn it rests at, and the value it shows.
export interface Thrown {
  key: string;
  width: number;
  size: number;
  values: number[];
  paths: ThrowFrame[][];
  rest: Quat[];
}

export function throwDice(o: { key: string; width: number; land: Box; from: number; size: number; values: number[]; fence?: [number, number][]; random?: () => number }): Thrown {
  const rnd = o.random ?? Math.random;
  const paths = simulateThrow({ land: o.land, from: o.from, size: o.size, n: o.values.length, fence: o.fence, random: rnd });
  return { key: o.key, width: o.width, size: o.size, values: o.values, paths, rest: o.values.map(() => qAxis(0, 0, 1, ((rnd() - 0.5) * 70 * Math.PI) / 180)) };
}

// Set by hand (or no motion wanted): resting in a row across the box.
export function laidDice(o: { key: string; width: number; land: Box; size: number; values: number[] }): Thrown {
  const n = o.values.length;
  const y = (o.land.t + o.land.b) / 2;
  const yaws = [-9, 12, -4];
  return {
    key: o.key,
    width: o.width,
    size: o.size,
    values: o.values,
    paths: o.values.map((_, i) => [{ x: o.land.l + ((i + 0.5) / n) * (o.land.r - o.land.l), y: y + (i % 2 ? 6 : -6) * (o.size / 30), z: 0, q: [1, 0, 0, 0] }]),
    rest: o.values.map((_, i) => qAxis(0, 0, 1, (yaws[i % 3] * Math.PI) / 180)),
  };
}

export interface DieItem {
  m: Mat;
  anim?: Anim;
}

// The dice for the engine, drawn on a felt `width` px across: each die and
// its shadow, flying their paths (once, by the throw's key) to rest.
export function diceScene(t: Thrown, width: number): { dice: DieItem[]; quads: Quad[] } {
  const f = width / t.width;
  const s = t.size * f;
  const dice: DieItem[] = [];
  const quads: Quad[] = [];
  t.paths.forEach((path, i) => {
    const end = path[path.length - 1];
    // Every frame turned by the same amount, so the last is exactly at rest
    // (face up, at its angle) - the rolling itself untouched.
    const fix = qMul(qConj(end.q), t.rest[i]);
    const up = FACE_UP[t.values[i]] ?? FACE_UP[1];
    const at = (x: number, y: number, z: number, q: Quat) => chain(translate(x * f, y * f, z * f + s / 2), qMat(qMul(qMul(q, fix), up)), scale(s));
    // Its shadow, falling further off and smaller the higher it is.
    const shade = (x: number, y: number, z: number) => chain(translate((x + z * 0.35) * f, (y + z * 0.55) * f, 0.4), scale(s * 1.3 / (1 + z / 110)));
    const pose = (k: number) => {
      const p = k * (path.length - 1);
      const j = Math.min(path.length - 2, Math.floor(p));
      const u = p - j;
      const a = path[j];
      const b = path[j + 1];
      return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u, z: a.z + (b.z - a.z) * u, q: qBlend(a.q, b.q, u) };
    };
    const dur = (path.length - 1) / THROW_FPS;
    const moving = path.length > 1;
    dice.push({
      m: at(end.x, end.y, 0, end.q),
      ...(moving
        ? {
            anim: {
              key: `die:${t.key}:${i}`,
              delay: 0,
              dur,
              pose: (k: number) => {
                const p = pose(k);
                return at(p.x, p.y, p.z, p.q);
              },
            },
          }
        : {}),
    });
    quads.push({
      kind: "shadow",
      m: shade(end.x, end.y, 0),
      ...(moving
        ? {
            anim: {
              key: `die:${t.key}:${i}:shadow`,
              delay: 0,
              dur,
              pose: (k: number) => {
                const p = pose(k);
                return shade(p.x, p.y, p.z);
              },
            },
          }
        : {}),
    });
  });
  return { dice, quads };
}
