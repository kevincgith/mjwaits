// The Dice tab's dice, as Play's engine draws them (see engine's die mesh):
// real rounded cubes on the felt, lit as the tiles are, thrown by a small
// rigid-body simulation. They leave a hand held high over your side of the
// table, spinning, and fall onto the felt: each cube lands on a corner or
// an edge and is kicked into a new spin, tumbles over edge to edge, rocks
// on its last face and lies still. They hit only what's there - the felt,
// each other, and (擲骰) the wall round them - never an unseen edge; of a
// few throws tried, one that comes to rest where the dice are meant to
// land is kept. Every throw is different: where the hand is, how high, which
// way and how hard, the spin.
//
// What a die shows is the roll's, not the simulation's: once a throw's done,
// each cube's faces are relabelled (a turn of the cube onto itself, so it
// looks no different) so the face that came up is the value rolled.
//
// All in the felt's own px and CSS's axes (x right, y down, z up off it).

import { chain, scale, translate, type Mat } from "./mat";
import type { Anim, Quad } from "./layout";

// Rotations as quaternions [w, x, y, z].
export type Quat = [number, number, number, number];
type Vec = [number, number, number];
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
const qNorm = (q: Quat): Quat => {
  const l = Math.hypot(...q);
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
};
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
// A vector turned by the rotation `m` (as qMat makes it).
const turn = (m: Mat, v: Vec): Vec => [m[0] * v[0] + m[4] * v[1] + m[8] * v[2], m[1] * v[0] + m[5] * v[1] + m[9] * v[2], m[2] * v[0] + m[6] * v[1] + m[10] * v[2]];
const cross = (a: Vec, b: Vec): Vec => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: Vec, b: Vec) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
// Between two rotations, `t` of the way (the short way round).
function qBlend(a: Quat, b: Quat, t: number): Quat {
  const s = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3] < 0 ? -1 : 1;
  return qNorm(a.map((v, i) => v + (s * b[i] - v) * t) as Quat);
}

// The cube's faces (see the engine's die shader): 1 up (+z), 6 down, 2 and
// 5 toward and away from you (+y, -y), 3 and 4 right and left (+x, -x).
const FACES: Record<number, Vec> = { 1: [0, 0, 1], 6: [0, 0, -1], 2: [0, 1, 0], 5: [0, -1, 0], 3: [1, 0, 0], 4: [-1, 0, 0] };
// Which face of a cube turned by q is up, and how squarely.
function faceUp(q: Quat): [number, number] {
  const m = qMat(q);
  let best: [number, number] = [1, -2];
  for (const [v, n] of Object.entries(FACES)) {
    const up = turn(m, n)[2];
    if (up > best[1]) best = [+v, up];
  }
  return best;
}
// The cube turned onto itself so face `from` is where face `to` was.
function relabel(from: number, to: number): Quat {
  const a = FACES[from];
  const b = FACES[to];
  const d = dot(a, b);
  if (d > 0.5) return [1, 0, 0, 0];
  if (d < -0.5) {
    // Opposite: half a turn about an axis square to them both.
    const ax: Vec = a[0] ? [0, 0, 1] : [1, 0, 0];
    return qAxis(ax[0], ax[1], ax[2], Math.PI);
  }
  const ax = cross(a, b);
  return qAxis(ax[0], ax[1], ax[2], Math.PI / 2);
}

export interface Box {
  l: number;
  t: number;
  r: number;
  b: number;
}
export interface ThrowFrame {
  x: number;
  y: number;
  /** The die's middle, above the felt (px). */
  z: number;
  q: Quat;
}
export const THROW_FPS = 60;
// The longest a throw lasts (the result shows as it ends).
export const THROW_MS = 2200;

// A cube `size` px across (its weight 1). Gravity and speeds scale with it,
// so a throw looks the same at any size. The table's lively, not a pillow:
// a hit bounces back well (a cube on a corner turns most of a hit into spin,
// so it hops far less than this says) and the cloth grips lightly - the dice
// skip and tumble over and over before they lie still. A soft hit doesn't
// bounce.
const physics = (size: number) => {
  const k = size / 37;
  return {
    g: 3000 * k,
    inertia: (size * size) / 6,
    bounce: 0.9,
    still: 70 * k,
    grip: 0.25,
    // Dice knocking together: as balls this far round.
    rad: size * 0.56,
  };
};
// How far they roll on after first hitting the felt (in dice), as thrown.
const ROLL_ON = [1.5, 3.5];
const STEP = 1 / 600;
const PER_FRAME = 600 / THROW_FPS;

interface Body {
  p: Vec;
  v: Vec;
  q: Quat;
  w: Vec;
  // Inside each fence yet (thrown in over the wall), and where it first hit the felt.
  inside: boolean[];
  firstHit: [number, number] | null;
}
type Fence = { a: [number, number]; nx: number; ny: number }[];

// The dice as thrown, till all lie still (or THROW_MS is up, when they're
// laid flat): each die's place and turn at THROW_FPS; and whether they came
// to rest by themselves.
function simulate(size: number, bodies: Body[], fences: Fence[]): { frames: ThrowFrame[][]; settled: boolean } {
  const P = physics(size);
  const h = size / 2;
  const corners: Vec[] = [];
  for (const x of [-h, h]) for (const y of [-h, h]) for (const z of [-h, h]) corners.push([x, y, z]);
  const frames: ThrowFrame[][] = bodies.map(() => []);
  const record = () => bodies.forEach((b, i) => frames[i].push({ x: b.p[0], y: b.p[1], z: b.p[2], q: b.q }));
  record();
  let quiet = 0;
  let settled = false;
  const steps = Math.round(THROW_MS / 1000 / STEP);
  for (let step = 1; step <= steps; step++) {
    for (const b of bodies) {
      b.v[2] -= P.g * STEP;
      b.p = [b.p[0] + b.v[0] * STEP, b.p[1] + b.v[1] * STEP, b.p[2] + b.v[2] * STEP];
      const dq = qMul([0, b.w[0], b.w[1], b.w[2]], b.q);
      b.q = qNorm([b.q[0] + 0.5 * STEP * dq[0], b.q[1] + 0.5 * STEP * dq[1], b.q[2] + 0.5 * STEP * dq[2], b.q[3] + 0.5 * STEP * dq[3]]);
      // The felt, at each corner under it: pushed back up, the push and the
      // felt's grip turning the cube about that corner. (Only near the felt
      // can a corner reach it.)
      let low = 0;
      let touching = false;
      if (b.p[2] < h * 1.75)
        for (let pass = 0; pass < 2; pass++) {
          const m = qMat(b.q);
          for (const c of corners) {
            const r = turn(m, c);
            const z = b.p[2] + r[2];
            if (z >= 0) continue;
            touching = true;
            low = Math.min(low, z);
            if (!b.firstHit) b.firstHit = [b.p[0], b.p[1]];
            const u = cross(b.w, r).map((x, i) => x + b.v[i]) as Vec;
            if (u[2] >= 0) continue;
            const apply = (j: Vec) => {
              b.v = [b.v[0] + j[0], b.v[1] + j[1], b.v[2] + j[2]];
              const t = cross(r, j);
              b.w = [b.w[0] + t[0] / P.inertia, b.w[1] + t[1] / P.inertia, b.w[2] + t[2] / P.inertia];
            };
            const rn = cross(r, [0, 0, 1]);
            const jn = (-(1 + (-u[2] > P.still ? P.bounce : 0)) * u[2]) / (1 + dot(rn, rn) / P.inertia);
            apply([0, 0, jn]);
            // Grip: the corner's slide across the felt, stopped as far as
            // friction allows.
            const u2 = cross(b.w, r).map((x, i) => x + b.v[i]) as Vec;
            const slide = Math.hypot(u2[0], u2[1]);
            if (slide > 1e-6) {
              const t: Vec = [-u2[0] / slide, -u2[1] / slide, 0];
              const rt = cross(r, t);
              const jt = Math.min(slide / (1 + dot(rt, rt) / P.inertia), P.grip * jn);
              apply([t[0] * jt, t[1] * jt, 0]);
            }
          }
        }
      if (low < 0) b.p[2] -= low;
      // On the felt it slows: the cloth drags at whatever's turning on it.
      if (touching) {
        const k = 1 - 0.5 * STEP;
        b.w = [b.w[0] * k, b.w[1] * k, b.w[2] * (1 - 6 * STEP)];
        b.v = [b.v[0] * (1 - 0.3 * STEP), b.v[1] * (1 - 0.3 * STEP), b.v[2]];
      }
      // The wall, and the table's edge: once in, it bounces back off them.
      fences.forEach((fence, f) => {
        const into = fence.map((e) => (b.p[0] - e.a[0]) * e.nx + (b.p[1] - e.a[1]) * e.ny);
        if (!b.inside[f]) b.inside[f] = into.every((s) => s >= P.rad);
        else
          fence.forEach((e, i) => {
            if (into[i] >= P.rad) return;
            b.p[0] += (P.rad - into[i]) * e.nx;
            b.p[1] += (P.rad - into[i]) * e.ny;
            const vn = b.v[0] * e.nx + b.v[1] * e.ny;
            if (vn < 0) {
              b.v[0] -= 1.5 * vn * e.nx;
              b.v[1] -= 1.5 * vn * e.ny;
              // (A knock on the wall sets it spinning about the upright.)
              b.w[2] += vn * 0.02;
            }
          });
      });
    }
    // Dice knocking together.
    for (let i = 0; i < bodies.length; i++)
      for (let j = i + 1; j < bodies.length; j++) {
        const a = bodies[i];
        const b = bodies[j];
        const d: Vec = [b.p[0] - a.p[0], b.p[1] - a.p[1], b.p[2] - a.p[2]];
        const dist = Math.hypot(...d) || 0.01;
        if (dist >= P.rad * 2) continue;
        const n = d.map((x) => x / dist) as Vec;
        const push = (P.rad * 2 - dist) / 2;
        a.p = a.p.map((x, k) => x - n[k] * push) as Vec;
        b.p = b.p.map((x, k) => x + n[k] * push) as Vec;
        const closing = dot(a.v.map((x, k) => x - b.v[k]) as Vec, n);
        if (closing > 0) {
          const imp = (closing * 1.6) / 2;
          a.v = a.v.map((x, k) => x - imp * n[k]) as Vec;
          b.v = b.v.map((x, k) => x + imp * n[k]) as Vec;
          // A glancing knock spins them a little.
          a.w = [a.w[0] - n[1] * imp * 0.02, a.w[1] + n[0] * imp * 0.02, a.w[2] + imp * 0.01];
          b.w = [b.w[0] + n[1] * imp * 0.02, b.w[1] - n[0] * imp * 0.02, b.w[2] - imp * 0.01];
        }
      }
    if (step % PER_FRAME === 0) record();
    // Still: every die hardly moving, flat on a face - for a moment.
    const calm = bodies.every((b) => Math.hypot(...b.v) < 6 * (size / 37) && Math.hypot(...b.w) < 0.5 && b.p[2] < h + 0.5) && bodies.every((b) => faceUp(b.q)[1] > 0.995);
    quiet = calm ? quiet + 1 : 0;
    if (quiet > 0.08 / STEP) {
      settled = true;
      break;
    }
  }
  // Laid flat on the face that's up, exactly (a hair's turn at most when it
  // came to rest by itself).
  bodies.forEach((b, i) => {
    const n = turn(qMat(b.q), FACES[faceUp(b.q)[0]]);
    const ax = cross(n, [0, 0, 1]);
    const s = Math.hypot(...ax);
    const flat = s > 1e-6 ? qNorm(qMul(qAxis(ax[0] / s, ax[1] / s, ax[2] / s, Math.asin(Math.min(1, s))), b.q)) : b.q;
    frames[i].push({ x: b.p[0], y: b.p[1], z: h, q: flat });
  });
  return { frames, settled };
}

// The wall's inner face, each edge with the way in.
function fenceEdges(fence: [number, number][]): Fence {
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

// The felt's edge, `inset` px in: solid all round.
const rimOf = (W: number, inset: number): [number, number][] => [
  [inset, inset],
  [W - inset, inset],
  [W - inset, W - inset],
  [inset, W - inset],
];

// Where a throw's dice are thrown to, and kept: aimed at `land`, to come to
// rest inside `keep` (land, if not given); inside `fence` (the wall), if
// there is one; and off `rim` (px in from the felt's edge, solid), if given.
export interface ThrowAt {
  width: number;
  land: Box;
  keep?: Box;
  size: number;
  fence?: [number, number][];
  rim?: number;
  random?: () => number;
}

// `n` dice thrown onto a felt `width` px square (see ThrowAt): each die's path.
export function simulateThrow(o: ThrowAt & { n: number }): ThrowFrame[][] {
  const rnd = o.random ?? Math.random;
  const between = (a: number, b: number) => a + (b - a) * rnd();
  const { size, n, land, width: W } = o;
  const P = physics(size);
  const keep = o.keep ?? land;
  const fences = [o.fence, o.rim === undefined ? undefined : rimOf(W, o.rim)].filter((f) => f !== undefined).map(fenceEdges);
  const insideFence = (x: number, y: number) => fences.every((fence) => fence.every((e) => (x - e.a[0]) * e.nx + (y - e.a[1]) * e.ny >= P.rad * 0.6));
  let best: { frames: ThrowFrame[][]; miss: number } | null = null;
  for (let attempt = 0; attempt < 24; attempt++) {
    // The hand: over your side of the table, somewhere along it, high up.
    const hand: Vec = [W * between(0.22, 0.78), W * between(0.8, 0.95), size * between(3.5, 6.5)];
    // Where they're thrown to: somewhere in the box - and they first hit
    // the felt a few dice short of it, rolling over and over the rest.
    const aim: [number, number] = [between(land.l, land.r), between(land.t + (land.b - land.t) * 0.2, land.b - (land.b - land.t) * 0.2)];
    const dx = aim[0] - hand[0];
    const dy = aim[1] - hand[1];
    const dist = Math.hypot(dx, dy);
    const dir: [number, number] = [dx / dist, dy / dist];
    const side: [number, number] = [-dir[1], dir[0]];
    // (Inside the wall, if there is one: past where its line crosses it.)
    let inside = 0;
    for (const e of fences.flat()) {
      const into = dir[0] * e.nx + dir[1] * e.ny;
      if (into > 0) inside = Math.max(inside, (P.rad + size * 0.4 - ((hand[0] - e.a[0]) * e.nx + (hand[1] - e.a[1]) * e.ny)) / into);
    }
    const toHit = Math.min(dist, Math.max(dist * 0.3, inside, dist - size * between(ROLL_ON[0], ROLL_ON[1])));
    // Tossed up a little, flung flat, or thrown down - and hard.
    const vz = size * between(-6, 5);
    const fall = (vz + Math.sqrt(vz * vz + 2 * P.g * hand[2])) / P.g;
    const speed = Math.min(toHit / fall, size * 40);
    const bodies: Body[] = Array.from({ length: n }, (_, i) => {
      const lane = i - (n - 1) / 2;
      const spread = size * between(0.9, 1.4);
      const p: Vec = [hand[0] + side[0] * lane * spread + between(-0.2, 0.2) * size, hand[1] + side[1] * lane * spread + between(-0.3, 0.3) * size, hand[2] + between(-0.4, 0.4) * size];
      // Each its own way a little: speed, heading, and spin - a tumble
      // forward off the fingers, and some every which way.
      const veer = between(-0.14, 0.14) + lane * 0.06;
      const sp = speed * between(0.85, 1.15);
      const hx = dir[0] * Math.cos(veer) - dir[1] * Math.sin(veer);
      const hy = dir[0] * Math.sin(veer) + dir[1] * Math.cos(veer);
      const roll = between(16, 30);
      const a = rnd() * Math.PI * 2;
      const b = Math.acos(2 * rnd() - 1);
      const free = between(4, 10);
      return {
        p,
        v: [hx * sp, hy * sp, vz * between(0.85, 1.15)],
        q: qNorm([rnd() - 0.5, rnd() - 0.5, rnd() - 0.5, rnd() - 0.5]),
        // (Forward: about the level axis square to its heading.)
        w: [-hy * roll + Math.sin(b) * Math.cos(a) * free, hx * roll + Math.sin(b) * Math.sin(a) * free, Math.cos(b) * free],
        inside: fences.map(() => false),
        firstHit: null,
      };
    });
    const { frames, settled } = simulate(size, bodies, fences);
    // How far from right it went: off where they're meant to stop, a first
    // hit off the felt or on the wall, or not done in time.
    const pad = size * 0.3;
    let miss = settled ? 0 : size * 4;
    bodies.forEach((b, i) => {
      const end = frames[i][frames[i].length - 1];
      miss += Math.max(0, keep.l - pad - end.x, end.x - keep.r - pad) + Math.max(0, keep.t - pad - end.y, end.y - keep.b - pad);
      const hit = b.firstHit;
      if (!hit || hit[0] < size || hit[0] > W - size || hit[1] < size || hit[1] > W - size || !insideFence(hit[0], hit[1])) miss += size * 3;
    });
    if (!best || miss < best.miss) best = { frames, miss };
    if (miss === 0) break;
  }
  return best!.frames;
}

// A throw, ready to draw: each die's path (in the felt px it was thrown at,
// `width`), and how its faces are relabelled to show the value rolled.
export interface Thrown {
  key: string;
  width: number;
  size: number;
  values: number[];
  paths: ThrowFrame[][];
  faces: Quat[];
}

export function throwDice(o: ThrowAt & { key: string; values: number[] }): Thrown {
  const paths = simulateThrow({ ...o, n: o.values.length });
  return {
    key: o.key,
    width: o.width,
    size: o.size,
    values: o.values,
    paths,
    faces: o.values.map((v, i) => relabel(v, faceUp(paths[i][paths[i].length - 1].q)[0])),
  };
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
    paths: o.values.map((_, i) => [
      { x: o.land.l + ((i + 0.5) / n) * (o.land.r - o.land.l), y: y + (i % 2 ? 6 : -6) * (o.size / 30), z: o.size / 2, q: qAxis(0, 0, 1, (yaws[i % 3] * Math.PI) / 180) },
    ]),
    faces: o.values.map((v) => relabel(v, 1)),
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
    const faces = t.faces[i];
    const at = (p: ThrowFrame) => chain(translate(p.x * f, p.y * f, p.z * f), qMat(qMul(p.q, faces)), scale(s));
    // Its shadow, falling further off and smaller the higher it is.
    const shade = (p: ThrowFrame) => {
      const up = Math.max(0, p.z - t.size / 2);
      return chain(translate((p.x + up * 0.12) * f, (p.y + up * 0.2) * f, 0.4), scale((s * 1.3) / (1 + up / 160)));
    };
    const pose = (k: number): ThrowFrame => {
      const p = k * (path.length - 1);
      const j = Math.min(path.length - 2, Math.floor(p));
      const u = p - j;
      const a = path[j];
      const b = path[j + 1];
      return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u, z: a.z + (b.z - a.z) * u, q: qBlend(a.q, b.q, u) };
    };
    const dur = (path.length - 1) / THROW_FPS;
    const moving = path.length > 1;
    dice.push({ m: at(end), ...(moving ? { anim: { key: `die:${t.key}:${i}`, delay: 0, dur, pose: (k: number) => at(pose(k)) } } : {}) });
    quads.push({ kind: "shadow", m: shade(end), ...(moving ? { anim: { key: `die:${t.key}:${i}:shadow`, delay: 0, dur, pose: (k: number) => shade(pose(k)) } } : {}) });
  });
  return { dice, quads };
}
