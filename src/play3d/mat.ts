// 4x4 matrices for laying tiles out, column-major as WebGL (and three.js's
// Matrix4.fromArray) has them - kept out of three.js so the layout runs
// and tests without it. Every matrix here works in CSS's own axes: x to
// the right, y down, z out of the screen (up off the felt), so a tile's
// transforms read as the table's CSS writes them.

export type Mat = Float32Array;

export const identity = (): Mat => {
  const m = new Float32Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
};

export function mul(a: Mat, b: Mat): Mat {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      o[c * 4 + r] = s;
    }
  return o;
}

// a * b * c * ...
export const chain = (...ms: Mat[]): Mat => ms.reduce((a, b) => mul(a, b));

export function translate(x: number, y: number, z = 0): Mat {
  const m = identity();
  m[12] = x;
  m[13] = y;
  m[14] = z;
  return m;
}

export function scale(x: number, y = x, z = x): Mat {
  const m = identity();
  m[0] = x;
  m[5] = y;
  m[10] = z;
  return m;
}

const rad = (deg: number) => (deg * Math.PI) / 180;

// As CSS's rotateX / rotateY / rotateZ (rotate), in degrees.
export function rotateX(deg: number): Mat {
  const m = identity();
  const c = Math.cos(rad(deg));
  const s = Math.sin(rad(deg));
  m[5] = c;
  m[6] = s;
  m[9] = -s;
  m[10] = c;
  return m;
}

export function rotateY(deg: number): Mat {
  const m = identity();
  const c = Math.cos(rad(deg));
  const s = Math.sin(rad(deg));
  m[0] = c;
  m[2] = -s;
  m[8] = s;
  m[10] = c;
  return m;
}

export function rotateZ(deg: number): Mat {
  const m = identity();
  const c = Math.cos(rad(deg));
  const s = Math.sin(rad(deg));
  m[0] = c;
  m[1] = s;
  m[4] = -s;
  m[5] = c;
  return m;
}

// A transform about a point, as CSS's transform-origin does it.
export const about = (x: number, y: number, z: number, m: Mat): Mat => chain(translate(x, y, z), m, translate(-x, -y, -z));

export function apply(m: Mat, x: number, y: number, z: number): [number, number, number] {
  return [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]];
}
