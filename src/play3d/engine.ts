// Play's renderer: the table's tiles drawn by WebGL (three.js) on one
// canvas over the table, the felt and everything else staying the page's
// own. Every tile is the same block - rounded at its four upright edges,
// the face on top, sides running from the jade back to the ivory under the
// face - drawn as one instanced mesh for the felt and one for your hand, so
// a whole table is a handful of draw calls.
//
// It draws in the table's own CSS pixels: the canvas covers .play-table,
// and each space is projected exactly as the CSS would - the felt through
// .play-stage's perspective after .play-felt's tilt, your hand through
// .play-hand's own - so the tiles sit on the page's felt, by its compass.

import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { BACK, PEEK_CUT, PEEK_PITCH, PEEK_TINT, THICK, TILE_H, TILE_R, TILE_W, type Card, type Layout, type Piece, type Quad, type QuadKind } from "./layout";
import type { Mat } from "./mat";
import type { Atlas } from "./textures";
import type { GLSide } from "./types";
import { PLAQUE_RINGED } from "./cards";
import { SEAT_TILE_RINGED } from "./diceScenes";
import { bar, bubble, dingBar, gapOutline, wonOutline, peekTray, goldRing, pickedRim, pin, rowShadow, tileShadow, triangle } from "./textures";

const SIDES: GLSide[] = ["top", "bottom", "left", "right"];
const MAX_FELT = 260;
const MAX_HAND = 48;
// A peek's tiles: those seen through in the rack, and those lifted out of it.
const MAX_GLASS = 20; // (a peek's tiles, and a win's ghosts)
// The Dice tab's dice.
const MAX_DICE = 3;
// A tile that would go over the others but only slides along: this long (s).
const SLIDE_ALONG_S = 0.45;
// ...and one joining the row, into the room made for it (after that).
const JOIN_S = 0.5;
// The Dice tab's players' name cards.
const MAX_CARDS = 4;

// The block, in ems: its rounded footprint stood up `THICK` high, a cap at
// either end. aPart: 0 a side, 1 the face (top), 2 the back (bottom).
function tileGeometry(): THREE.BufferGeometry {
  const seg = 6;
  const outline: [number, number, number][] = []; // x, y, angle
  const cx = TILE_W / 2 - TILE_R;
  const cy = TILE_H / 2 - TILE_R;
  const corners: [number, number][] = [
    [cx, cy],
    [-cx, cy],
    [-cx, -cy],
    [cx, -cy],
  ];
  corners.forEach(([ox, oy], k) => {
    for (let i = 0; i <= seg; i++) {
      const a = ((k + i / seg) * Math.PI) / 2;
      outline.push([ox + TILE_R * Math.cos(a), oy + TILE_R * Math.sin(a), a]);
    }
  });
  const pos: number[] = [];
  const nrm: number[] = [];
  const uv: number[] = [];
  const part: number[] = [];
  const vert = (x: number, y: number, z: number, nx: number, ny: number, nz: number, p: number) => {
    pos.push(x, y, z);
    nrm.push(nx, ny, nz);
    uv.push(x / TILE_W + 0.5, y / TILE_H + 0.5);
    part.push(p);
  };
  const n = outline.length;
  for (let i = 0; i < n; i++) {
    const [ax, ay, aa] = outline[i];
    const [bx, by, ba] = outline[(i + 1) % n];
    // The long straight runs between corners keep their corners' normals.
    const [anx, any] = [Math.cos(aa), Math.sin(aa)];
    const [bnx, bny] = [Math.cos(ba), Math.sin(ba)];
    // Side: (a0, b0, b1), (a0, b1, a1) - facing out.
    vert(ax, ay, 0, anx, any, 0, 0);
    vert(bx, by, 0, bnx, bny, 0, 0);
    vert(bx, by, THICK, bnx, bny, 0, 0);
    vert(ax, ay, 0, anx, any, 0, 0);
    vert(bx, by, THICK, bnx, bny, 0, 0);
    vert(ax, ay, THICK, anx, any, 0, 0);
    // Face (up) and back (down), fanned from the middle.
    vert(0, 0, THICK, 0, 0, 1, 1);
    vert(ax, ay, THICK, 0, 0, 1, 1);
    vert(bx, by, THICK, 0, 0, 1, 1);
    vert(0, 0, 0, 0, 0, -1, 2);
    vert(bx, by, 0, 0, 0, -1, 2);
    vert(ax, ay, 0, 0, 0, -1, 2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute("aPart", new THREE.Float32BufferAttribute(part, 1));
  return g;
}

const hex = (h: number) => `vec3(${(((h >> 16) & 255) / 255).toFixed(4)}, ${(((h >> 8) & 255) / 255).toFixed(4)}, ${((h & 255) / 255).toFixed(4)})`;

// Colours as the CSS has them (sRGB, unconverted); the sides' gradient:
// jade at the foot, a light seam, ivory up to the face.
const TILE_VERTEX = /* glsl */ `
  attribute float aPart;
  attribute vec4 aFace;
  attribute vec2 aShade;
  attribute float aTint;
  uniform vec4 uBack;
  varying vec2 vUv;
  varying float vPart;
  varying float vZ;
  varying float vShade;
  varying float vTint;
  varying vec4 vRect;
  varying float vX;
  void main() {
    vUv = uv;
    vX = position.x;
    vPart = aPart;
    vZ = position.z / ${THICK.toFixed(3)};
    // Its long sides (facing along y) shaded one way, its ends another,
    // a rounded corner between them by how far round it faces.
    vShade = mix(aShade.x, aShade.y, abs(normal.x));
    vTint = aTint;
    vRect = aPart > 1.5 ? uBack : aFace;
    gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
  }
`;
const TILE_FRAGMENT_HEAD = /* glsl */ `
  uniform sampler2D uAtlas;
  varying vec2 vUv;
  varying float vPart;
  varying float vZ;
  varying float vShade;
  varying float vTint;
  varying vec4 vRect;
  varying float vX;
  vec3 side(float z) {
    vec3 c = mix(${hex(0x1f7a32)}, ${hex(0x35a84a)}, clamp(z / 0.38, 0.0, 1.0));
    c = mix(c, ${hex(0x7fd98c)}, clamp((z - 0.38) / 0.08, 0.0, 1.0));
    c = mix(c, ${hex(0xe6dfcb)}, clamp((z - 0.46) / 0.08, 0.0, 1.0));
    c = mix(c, ${hex(0xf2ede0)}, clamp((z - 0.54) / 0.46, 0.0, 1.0));
    return c;
  }
`;

// A tile seen through (a peek): the same block, its body clear enough to see
// the table behind it and its face nearly solid. `aTint` is how solid it is
// - or, from PEEK_TINT less its reach, a peek's own tile: solid, as your
// row's tiles are, aTint - PEEK_TINT places from the finger across the
// screen; dimmed in a gradient toward the window's ends, by how far each
// point of it is, and cut off at them (half the last tile each side shown).
const glassMaterial = (atlas: THREE.Texture, back: [number, number, number, number]) =>
  new THREE.ShaderMaterial({
    uniforms: { uAtlas: { value: atlas }, uBack: { value: new THREE.Vector4(...back) } },
    vertexShader: TILE_VERTEX,
    fragmentShader: /* glsl */ `
      ${TILE_FRAGMENT_HEAD}
      void main() {
        vec3 c;
        float a;
        if (vTint > ${(PEEK_TINT / 2).toFixed(1)}) {
          float d = abs(vTint - ${PEEK_TINT.toFixed(1)} + vX / ${PEEK_PITCH.toFixed(3)});
          if (d > ${PEEK_CUT.toFixed(1)}) discard;
          c = vPart < 0.5 ? side(vZ) * (1.0 - vShade) : texture2D(uAtlas, vRect.xy + vUv * vRect.zw).rgb;
          gl_FragColor = vec4(c * mix(1.0, 0.22, smoothstep(0.45, ${PEEK_CUT.toFixed(1)}, d)), 1.0);
          return;
        }
        if (vPart < 0.5) {
          c = mix(side(vZ) * (1.0 - vShade), vec3(0.86, 1.0, 0.9), 0.22);
          a = 0.58;
        } else {
          c = texture2D(uAtlas, vRect.xy + vUv * vRect.zw).rgb;
          a = vPart > 1.5 ? 0.5 : 0.95;
        }
        a *= vTint;
        gl_FragColor = vec4(c * a, a);
      }
    `,
    transparent: true,
    premultipliedAlpha: true,
    side: THREE.BackSide,
  });

const tileMaterial = (atlas: THREE.Texture, back: [number, number, number, number]) =>
  new THREE.ShaderMaterial({
    uniforms: { uAtlas: { value: atlas }, uBack: { value: new THREE.Vector4(...back) } },
    vertexShader: TILE_VERTEX,
    fragmentShader: /* glsl */ `
      ${TILE_FRAGMENT_HEAD}
      void main() {
        vec3 c;
        if (vPart < 0.5) c = side(vZ) * (1.0 - vShade);
        else c = texture2D(uAtlas, vRect.xy + vUv * vRect.zw).rgb;
        // 食替: dimmed (brightness 0.62, saturate 0.6).
        float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
        c = mix(vec3(l), c, mix(0.6, 1.0, vTint)) * mix(0.62, 1.0, vTint);
        gl_FragColor = vec4(c, 1.0);
      }
    `,
    // (CSS's axes are mirrored against WebGL's - y runs down - so a face
    // wound to face out is a back face here.)
    side: THREE.BackSide,
  });

// A flat mark: a texture on the unit square, its alpha premultiplied.
const markMaterial = (map: THREE.Texture) =>
  new THREE.ShaderMaterial({
    uniforms: { uMap: { value: map } },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D uMap;
      varying vec2 vUv;
      void main() { gl_FragColor = texture2D(uMap, vUv); }
    `,
    transparent: true,
    depthWrite: false,
    premultipliedAlpha: true,
    side: THREE.DoubleSide,
  });

// A die: a rounded cube a unit across, centred on its middle, as the
// Dice tab's own dice are drawn above the table (.die): white, its pips
// in the same ink and red, set the same way - its top as bright as theirs,
// matt, and the sides it shows you in a warm shade (as .die's side), so it
// reads as a block, as the tiles do. Its pips on each face by value: 1 up
// (+z), 6 down, 2 and 5 toward and away from you (+y, -y), 3 and 4 right
// and left (+x, -x) - see dice.ts's FACE_UP. Chinese dice: the 1 and the 4
// red, the 1 big.
const dieMaterial = () =>
  new THREE.ShaderMaterial({
    vertexShader: /* glsl */ `
      varying vec3 vP;
      varying vec3 vN;
      varying vec3 vLit;
      void main() {
        vP = position;
        vN = normal;
        vLit = mat3(instanceMatrix) * normal;
        gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vP;
      varying vec3 vN;
      varying vec3 vLit;
      float pip(vec2 uv, vec2 c, float r) {
        float d = length(uv - c) - r;
        float w = fwidth(d) * 0.75;
        return 1.0 - smoothstep(-w, w, d);
      }
      float pips(vec2 uv, float v) {
        if (v < 0.5) return 0.0;
        if (v < 1.5) return pip(uv, vec2(0.0), 0.16);
        float g = 0.255;
        float r = 0.092;
        float m = max(pip(uv, vec2(-g, -g), r), pip(uv, vec2(g, g), r));
        if (v > 3.5) m = max(m, max(pip(uv, vec2(-g, g), r), pip(uv, vec2(g, -g), r)));
        if (abs(v - 3.0) < 0.5 || abs(v - 5.0) < 0.5) m = max(m, pip(uv, vec2(0.0), r));
        if (v > 5.5) m = max(m, max(pip(uv, vec2(-g, 0.0), r), pip(uv, vec2(g, 0.0), r)));
        return m;
      }
      void main() {
        // Which face: the way it mostly faces (its rounded edges too).
        vec3 a = abs(vN);
        float v;
        vec2 uv;
        if (a.z >= a.x && a.z >= a.y) { v = vN.z > 0.0 ? 1.0 : 6.0; uv = vP.xy; }
        else if (a.y >= a.x) { v = vN.y > 0.0 ? 2.0 : 5.0; uv = vP.xz; }
        else { v = vN.x > 0.0 ? 3.0 : 4.0; uv = vP.yz; }
        float red = abs(v - 1.0) < 0.5 || abs(v - 4.0) < 0.5 ? 1.0 : 0.0;
        vec3 ink = mix(${hex(0x1a1a1a)}, ${hex(0xb3261e)}, red);
        vec3 c = mix(vec3(1.0), ink, pips(uv, v));
        // Matt: the top full white, a side by how far it's turned from the
        // light - down to .die's warm side shade.
        vec3 n = normalize(vLit);
        float lit = clamp(dot(n, normalize(vec3(-0.2, 0.35, 1.0))) / 0.85, 0.0, 1.0);
        c *= mix(${hex(0xe2ded6)}, vec3(1.0), lit);
        gl_FragColor = vec4(c, 1.0);
      }
    `,
    // (As the tiles: CSS's mirrored axes turn its outsides into back faces.)
    side: THREE.BackSide,
  });

// A player's name card (see cards.ts), as a casino's high-value plaque
// is: a thick slab a unit across, deep and thick, its corners and edges
// rounded. On top its face - the `aCard`th of the faces stacked down the
// card faces' canvas (uFaces of them), upright to you: the player's colour,
// framed in gold, their name in gold foil - a matte top, no shine. Round
// its edge, the colour a shade deeper with a gold pinstripe.
const cardMaterial = () =>
  new THREE.ShaderMaterial({
    uniforms: { uMap: { value: null }, uFaces: { value: 1 } },
    vertexShader: /* glsl */ `
      attribute float aCard;
      varying vec3 vP;
      varying vec3 vN;
      varying vec3 vLit;
      varying float vCard;
      void main() {
        vP = position;
        vN = normal;
        vLit = mat3(instanceMatrix) * normal;
        vCard = aCard;
        gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D uMap;
      uniform float uFaces;
      varying vec3 vP;
      varying vec3 vN;
      varying vec3 vLit;
      varying float vCard;
      vec3 face(vec2 at) {
        vec4 t = texture2D(uMap, vec2(clamp(at.x, 0.002, 0.998), (vCard + clamp(at.y, 0.002, 0.998)) / uFaces));
        return t.rgb / max(t.a, 0.001);
      }
      void main() {
        vec3 c = face(vec2(0.004, 0.5)) * 0.82;
        if (uFaces < 0.5) c = vec3(0.8);
        else if (vN.z > 0.6) c = face(vP.xy + 0.5);
        else if (vN.z > -0.6) {
          // The edge: a gold pinstripe round its middle.
          float w = fwidth(vP.z) * 0.8;
          float stripe = 1.0 - smoothstep(0.09 - w, 0.09 + w, abs(vP.z));
          c = mix(c, ${hex(0xd4ad5a)}, stripe);
        }
        vec3 n = normalize(vLit);
        vec3 l = normalize(vec3(-0.2, 0.35, 1.0));
        float lit = clamp(dot(n, l) / 0.85, 0.0, 1.0);
        // (Matte: lit and shaded, no shine off it.)
        c *= mix(vec3(0.62), vec3(1.0), lit);
        gl_FragColor = vec4(min(c, vec3(1.0)), 1.0);
      }
    `,
    side: THREE.BackSide,
  });

function unitQuad(): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1], 2));
  return g;
}

function canvasTexture(c: HTMLCanvasElement, mip = true): THREE.Texture {
  const t = new THREE.CanvasTexture(c);
  t.flipY = false;
  t.premultiplyAlpha = true;
  t.colorSpace = THREE.NoColorSpace;
  t.generateMipmaps = mip;
  t.minFilter = mip ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  return t;
}

// The projection CSS's `perspective: d` with its origin at (ox, oy) makes,
// for points in the canvas's own CSS pixels (x right, y down, z toward
// you), onto a canvas cw x ch: x' = ox + (x - ox) d / (d - z), the same in y.
function cssProjection(d: number, ox: number, oy: number, cw: number, ch: number): THREE.Matrix4 {
  const zn = d - 400;
  const zf = -4000;
  const a = (zn + zf - 2 * d) / (zn - zf);
  const b = d - zf - a * zf;
  return new THREE.Matrix4().set(2 * d / cw, 0, 1 - (2 * ox) / cw, -d, 0, (-2 * d) / ch, (2 * oy) / ch - 1, d, 0, 0, a, b, 0, 0, -1, d);
}

// Anything the GPU holds a copy of.
type Freeable = { dispose(): void };

// One space's tiles and marks: a scene seen through its own projection.
class Space {
  scene = new THREE.Scene();
  root = new THREE.Group();
  camera = new THREE.Camera();
  tiles: THREE.InstancedMesh;
  marks = new Map<QuadKind, THREE.InstancedMesh>();
  face: THREE.InstancedBufferAttribute;
  shade: THREE.InstancedBufferAttribute;
  tint: THREE.InstancedBufferAttribute;
  // Each tile's place in your hand (for taps), by instance; a pile's tile, likewise.
  hits: (number | undefined)[] = [];
  picks: ([string, number] | undefined)[] = [];
  // Everything it makes for the GPU goes through `keep`, to be freed with the engine.
  private keep: <T extends Freeable>(d: T) => T;
  constructor(geometry: THREE.BufferGeometry, material: THREE.Material, max: number, keep: <T extends Freeable>(d: T) => T) {
    this.keep = keep;
    this.root.matrixAutoUpdate = false;
    this.scene.add(this.root);
    const g = keep(geometry.clone());
    this.face = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4);
    this.shade = new THREE.InstancedBufferAttribute(new Float32Array(max * 2), 2);
    this.tint = new THREE.InstancedBufferAttribute(new Float32Array(max), 1);
    g.setAttribute("aFace", this.face);
    g.setAttribute("aShade", this.shade);
    g.setAttribute("aTint", this.tint);
    this.tiles = keep(new THREE.InstancedMesh(g, material, max));
    this.tiles.frustumCulled = false;
    this.tiles.count = 0;
    this.tiles.renderOrder = 1;
    this.root.add(this.tiles);
  }
  // The Dice tab's dice, and where they are (see dice.ts).
  dice: THREE.InstancedMesh | null = null;
  private diceItems: { m: Mat; anim?: Quad["anim"] }[] = [];
  addDice(geometry: THREE.BufferGeometry, material: THREE.Material, max: number) {
    const m = this.keep(new THREE.InstancedMesh(geometry, material, max));
    m.frustumCulled = false;
    m.count = 0;
    m.renderOrder = 1;
    this.root.add(m);
    this.dice = m;
  }
  // Things standing on the felt besides its tiles - the Dice tab's name
  // cards (see cards.ts) - by name: each an instance of one
  // mesh, eased to where it's set, showing face `face` (aCard).
  private props = new Map<string, { mesh: THREE.InstancedMesh; items: Card[]; face: THREE.InstancedBufferAttribute }>();
  addProps(name: string, geometry: THREE.BufferGeometry, material: THREE.Material, max: number) {
    const g = this.keep(geometry.clone());
    const face = new THREE.InstancedBufferAttribute(new Float32Array(max), 1);
    g.setAttribute("aCard", face);
    const mesh = this.keep(new THREE.InstancedMesh(g, material, max));
    mesh.frustumCulled = false;
    mesh.count = 0;
    mesh.renderOrder = 1;
    this.root.add(mesh);
    this.props.set(name, { mesh, items: [], face });
  }
  propMesh(name: string) {
    return this.props.get(name)?.mesh;
  }
  addMarks(kind: QuadKind, material: THREE.Material, max: number, order: number) {
    const m = this.keep(new THREE.InstancedMesh(this.keep(unitQuad()), material, max));
    m.frustumCulled = false;
    m.count = 0;
    m.renderOrder = order;
    this.root.add(m);
    this.marks.set(kind, m);
  }
  // What's shown, and how it moves: when each animation began (by its
  // key, from the frame it first appeared), and each eased move under way.
  private pieces: Piece[] = [];
  // Instance `i`'s face, if it's a tile out in the open (Piece.seen) face up.
  seenFace(i: number): string | null {
    const p = this.pieces[i];
    return p?.seen && p.face !== BACK ? p.face : null;
  }
  private quads = new Map<QuadKind, Quad[]>();
  private starts = new Map<string, number>();
  private eases = new Map<string, { from: THREE.Matrix4; to: Mat; start: number; dur: number; curve: (t: number) => number; lift: number; over: number }>();
  private shown = new Map<string, THREE.Matrix4>();
  // Tints fading (Piece.fade): from, to, when it began, how long - and
  // whether its end's been written (frames can skip past it: a page in the
  // background, a slow one).
  private fades = new Map<string, { from: number; to: number; start: number; dur: number; done?: boolean }>();
  private fadeAt(f: { from: number; to: number; start: number; dur: number }, now: number) {
    const k = f.dur > 0 ? Math.min(1, Math.max(0, (now - f.start) / 1000 / f.dur)) : 1;
    return f.from + (f.to - f.from) * (k * k * (3 - 2 * k));
  }

  set(pieces: Piece[], quads: Quad[], rects: Atlas["rects"], now: number, dice: { m: Mat; anim?: Quad["anim"] }[] = [], props: Record<string, Card[]> = {}) {
    const n = Math.min(pieces.length, this.tiles.instanceMatrix.count);
    this.pieces = pieces.slice(0, n);
    const keys = new Set<string>();
    const begin = (a: { key: string } | undefined) => {
      if (!a) return;
      keys.add(a.key);
      if (!this.starts.has(a.key)) this.starts.set(a.key, now);
    };
    // Moved: eased from where it shows now to its new place. (`fresh`: the
    // moves just begun that would go over the others - see `over`.)
    const fresh: { key: string; x0: number; x1: number; dy: number; over: number; wait: number }[] = [];
    const track = (p: { m: Mat; ease?: Piece["ease"] }) => {
      if (!p.ease) return;
      keys.add(p.ease.key);
      const was = this.eases.get(p.ease.key);
      const target = was?.to ?? this.shown.get(p.ease.key)?.toArray();
      if (target && target.some((v, j) => Math.abs(v - p.m[j]) > 1e-3)) {
        const from = this.shown.get(p.ease.key)!.clone();
        // (Lifted only to go somewhere - not to rise where it is.)
        const across = Math.hypot(p.m[12] - from.elements[12], p.m[13] - from.elements[13]) > 1;
        // (An `over` move waits its turn only to go along the row: picked
        // up or put down where it is - a give's suggestion - it goes at once.)
        const along = Math.abs(p.m[12] - from.elements[12]) > 1;
        const delay = p.ease.over && !along ? 0 : (p.ease.delay ?? 0);
        const dur = p.ease.over && !along ? Math.min(p.ease.dur, 0.2) : p.ease.dur;
        this.eases.set(p.ease.key, { from, to: p.m, start: now + delay * 1000, dur, curve: p.ease.curve, lift: across ? (p.ease.lift ?? 0) : 0, over: 0 });
        if (p.ease.over && along) fresh.push({ key: p.ease.key, x0: from.elements[12], x1: p.m[12], dy: p.m[13] - from.elements[13], over: p.ease.over, wait: p.ease.overDelay ?? 0 });
      } else if (!was) this.shown.set(p.ease.key, new THREE.Matrix4().fromArray(p.m));
    };
    for (let i = 0; i < n; i++) {
      const p = pieces[i];
      begin(p.anim);
      begin(p.fly);
      track(p);
      const r = rects.get(p.face) ?? rects.get("back")!;
      this.face.setXYZW(i, r[0], r[1], r[2], r[3]);
      this.shade.setXY(i, p.shade[0], p.shade[1]);
      let tint = p.tint;
      if (p.fade) {
        keys.add(p.fade.key);
        const f = this.fades.get(p.fade.key);
        if (!f) {
          const from = p.fade.from ?? p.tint;
          this.fades.set(p.fade.key, { from, to: p.tint, start: now, dur: from === p.tint ? 0 : p.fade.dur });
          tint = from;
        }
        else if (f.to !== p.tint) {
          tint = this.fadeAt(f, now);
          this.fades.set(p.fade.key, { from: tint, to: p.tint, start: now, dur: p.fade.dur });
        } else tint = this.fadeAt(f, now);
      }
      this.tint.setX(i, tint);
    }
    // Taken over the others only if it changes places with one of them:
    // just shifting along, it slides; coming in from above the row, it waits
    // for the room made for it and goes straight in.
    if (fresh.length) {
      // (Changing places is judged among the pieces staying in the row: one
      // coming in from above doesn't make those shifting along to make room
      // for it go over.)
      const at = this.pieces.flatMap((p) => {
        if (!p.ease) return [];
        const was = this.shown.get(p.ease.key)?.elements;
        return [{ key: p.ease.key, x0: was?.[12] ?? p.m[12], x1: p.m[12], dy: was ? p.m[13] - was[13] : 0 }];
      });
      for (const f of fresh) {
        const level = (dy: number) => Math.abs(dy) <= 0.25 * f.over;
        const swaps = level(f.dy) && at.some((o) => o.key !== f.key && level(o.dy) && Math.abs(f.x0 - o.x0) > 1 && Math.abs(f.x1 - o.x1) > 1 && Math.sign(f.x0 - o.x0) !== Math.sign(f.x1 - o.x1));
        const e = this.eases.get(f.key)!;
        if (swaps) {
          e.over = f.over;
          e.start += f.wait * 1000;
        } else if (Math.abs(f.dy) > 0.25 * f.over) {
          // Joining the row from off it (換牌's taken tiles, from above your
          // hand): the give the other way - once the row's made room, straight
          // into its gap.
          e.start += SLIDE_ALONG_S * 1000;
          e.dur = Math.min(e.dur, JOIN_S);
          // (Just sliding along, all together - a row closing up, or making
          // room - a little quicker than going over.)
        } else e.dur = Math.min(e.dur, SLIDE_ALONG_S);
      }
    }
    this.tiles.count = n;
    this.hits = this.pieces.map((p) => p.hit);
    this.picks = this.pieces.map((p) => p.pick);
    this.face.needsUpdate = this.shade.needsUpdate = this.tint.needsUpdate = true;
    if (this.dice) {
      this.diceItems = dice.slice(0, this.dice.instanceMatrix.count);
      this.diceItems.forEach((d) => begin(d.anim));
      this.dice.count = this.diceItems.length;
    }
    for (const [name, prop] of this.props) {
      prop.items = (props[name] ?? []).slice(0, prop.mesh.instanceMatrix.count);
      prop.items.forEach((c, i) => (track(c), prop.face.setX(i, c.face)));
      prop.face.needsUpdate = true;
      prop.mesh.count = prop.items.length;
    }
    for (const [kind, mesh] of this.marks) {
      const mine = quads.filter((q) => q.kind === kind).slice(0, mesh.instanceMatrix.count);
      mine.forEach((q) => (begin(q.anim), track(q)));
      this.quads.set(kind, mine);
      mesh.count = mine.length;
    }
    for (const k of [...this.starts.keys()]) if (!keys.has(k)) this.starts.delete(k);
    for (const k of [...this.shown.keys()]) if (!keys.has(k)) (this.shown.delete(k), this.eases.delete(k));
    for (const k of [...this.fades.keys()]) if (!keys.has(k)) this.fades.delete(k);
    this.tick(now);
  }

  // Everything where it is at `now` (ms); whether anything's still moving.
  tick(now: number): boolean {
    let moving = false;
    let fading = false;
    const mat = new THREE.Matrix4();
    const at = (item: { m: Mat; anim?: Quad["anim"] }): Mat => {
      const a = item.anim;
      if (!a) return item.m;
      const t = (now - (this.starts.get(a.key) ?? now)) / 1000 - a.delay;
      if (t >= a.dur) return item.m;
      moving = true;
      return a.pose(Math.max(0, t) / a.dur);
    };
    // An eased move (see set's track), `mat` set to where it is now.
    const easing = (key: string) => {
      const e = this.eases.get(key)!;
      const k = Math.min(1, Math.max(0, now - e.start) / 1000 / e.dur);
      const v = e.curve(k);
      const [p0, q0, s0] = [new THREE.Vector3(), new THREE.Quaternion(), new THREE.Vector3()];
      const [p1, q1, s1] = [new THREE.Vector3(), new THREE.Quaternion(), new THREE.Vector3()];
      e.from.decompose(p0, q0, s0);
      mat.fromArray(e.to).decompose(p1, q1, s1);
      if (e.over) {
        // Up over the others (up the screen, and a touch toward you), across,
        // and down into its place.
        const s = (a: number, b: number) => {
          const u = Math.min(1, Math.max(0, (k - a) / (b - a)));
          return u * u * (3 - 2 * u);
        };
        const top = Math.min(p0.y, p1.y) - e.over;
        const up = Math.min(s(0, 0.3), 1 - s(0.7, 1));
        const y = k < 0.3 ? p0.y + (top - p0.y) * s(0, 0.3) : k < 0.7 ? top : top + (p1.y - top) * s(0.7, 1);
        p0.set(p0.x + (p1.x - p0.x) * s(0.2, 0.8), y, p0.z + (p1.z - p0.z) * k + up * 0.3 * e.over);
      } else {
        p0.lerp(p1, v);
        p0.z += Math.sin(Math.PI * v) * e.lift;
      }
      mat.compose(p0, q0.slerp(q1, v), s0.lerp(s1, v));
      if (k >= 1) this.eases.delete(key);
      else moving = true;
    };
    this.pieces.forEach((p, i) => {
      const e = p.ease && this.eases.get(p.ease.key);
      if (e && !(p.anim && (now - (this.starts.get(p.anim.key) ?? 0)) / 1000 < p.anim.delay + p.anim.dur)) {
        easing(p.ease!.key);
      } else if (p.fly && p.hideAfter !== undefined && (now - (this.starts.get(p.fly.key) ?? now)) / 1000 >= p.hideAfter) {
        mat.makeScale(0, 0, 0);
      } else if (p.fly && (now - (this.starts.get(p.fly.key) ?? now)) / 1000 < p.fly.dur) {
        // In the air: eased along, turning to how it lands, lifted mid-way.
        const k = (now - this.starts.get(p.fly.key)!) / 1000 / p.fly.dur;
        const v = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
        const [p0, q0, s0] = [new THREE.Vector3(), new THREE.Quaternion(), new THREE.Vector3()];
        const [p1, q1, s1] = [new THREE.Vector3(), new THREE.Quaternion(), new THREE.Vector3()];
        // Between two poses, `u` of the way.
        const blend = (a: Mat, b: Mat, u: number) => {
          mat.fromArray(a).decompose(p0, q0, s0);
          mat.fromArray(b).decompose(p1, q1, s1);
          mat.compose(p0.lerp(p1, u), q0.slerp(q1, u), s0.lerp(s1, u));
        };
        if (p.fly.pose) {
          // In formation - eased out of the pile at the start, and into its
          // place at the end, from wherever the formation has it.
          const f = p.fly.pose(v);
          if (k < 0.15) blend(p.fly.from, f, k / 0.15);
          else if (k > 0.85) blend(f, p.m, (k - 0.85) / 0.15);
          else mat.fromArray(f);
        } else {
          blend(p.fly.from, p.m, v);
          mat.decompose(p0, q0, s0);
          p0.z += Math.sin(Math.PI * v) * p.fly.lift;
          mat.compose(p0, q0, s0);
        }
        moving = true;
      } else mat.fromArray(at(p));
      if (p.ease) this.shown.set(p.ease.key, mat.clone());
      this.tiles.setMatrixAt(i, mat);
      const f = p.fade && this.fades.get(p.fade.key);
      if (f && f.dur > 0 && !f.done) {
        this.tint.setX(i, this.fadeAt(f, now));
        fading = true;
        if (now - f.start >= f.dur * 1000) f.done = true;
        else moving = true;
      }
    });
    this.tiles.instanceMatrix.needsUpdate = true;
    if (fading) this.tint.needsUpdate = true;
    if (this.dice) {
      this.diceItems.forEach((d, i) => this.dice!.setMatrixAt(i, mat.fromArray(at(d))));
      this.dice.instanceMatrix.needsUpdate = true;
    }
    for (const { mesh, items } of this.props.values()) {
      items.forEach((c, i) => {
        if (c.ease && this.eases.has(c.ease.key)) easing(c.ease.key);
        else mat.fromArray(c.m);
        if (c.ease) this.shown.set(c.ease.key, mat.clone());
        mesh.setMatrixAt(i, mat);
      });
      mesh.instanceMatrix.needsUpdate = true;
    }
    for (const [kind, mesh] of this.marks) {
      (this.quads.get(kind) ?? []).forEach((q, i) => {
        if (q.ease && this.eases.has(q.ease.key)) easing(q.ease.key);
        else mat.fromArray(at(q));
        if (q.ease) this.shown.set(q.ease.key, mat.clone());
        mesh.setMatrixAt(i, mat);
      });
      mesh.instanceMatrix.needsUpdate = true;
    }
    return moving;
  }
}

// Where the spaces sit in the canvas, read off the page.
export interface Frame {
  width: number;
  height: number;
  // The felt's own plane into the canvas (its offset and tilt), and the
  // stage's perspective.
  felt: number[];
  stage: { d: number; ox: number; oy: number };
  // Your row's box in the canvas, and its perspective.
  hand: { x: number; y: number; d: number; ox: number; oy: number };
}

export class Engine {
  renderer: THREE.WebGLRenderer;
  felt: Space;
  hand: Space;
  rects: Atlas["rects"];
  private ray = new THREE.Raycaster();
  // Every geometry, material, texture and mesh it's made - all freed in dispose().
  readonly kept = new Set<Freeable>();
  private keep = <T extends Freeable>(d: T): T => (this.kept.add(d), d);
  // A peek's tiles: seen as the felt is, drawn over it.
  glass: Space;
  constructor(canvas: HTMLCanvasElement, atlas: Atlas) {
    // (Throws if the browser won't give it a context - see TableGL.)
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, premultipliedAlpha: true });
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.autoClear = false;
    this.rects = atlas.rects;
    const keep = this.keep;
    // (The atlas's canvas is shared by every engine; its texture is this one's.)
    const tex = keep(canvasTexture(atlas.canvas));
    tex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    const geometry = keep(tileGeometry());
    const material = keep(tileMaterial(tex, atlas.rects.get("back")!));
    this.felt = new Space(geometry, material, MAX_FELT, keep);
    this.hand = new Space(geometry, material, MAX_HAND, keep);
    const mark = (c: HTMLCanvasElement) => keep(markMaterial(keep(canvasTexture(c))));
    this.glass = new Space(geometry, keep(glassMaterial(tex, atlas.rects.get("back")!)), MAX_GLASS, keep);
    this.glass.addMarks("tray", mark(peekTray()), 1, 0);
    this.felt.addMarks("shadow", mark(tileShadow()), MAX_FELT, 0);
    this.felt.addDice(keep(new RoundedBoxGeometry(1, 1, 1, 5, 0.13)), keep(dieMaterial()), MAX_DICE);
    this.felt.addProps("cards", keep(new RoundedBoxGeometry(1, 1, 1, 5, 0.14)), keep(cardMaterial()), MAX_CARDS);
    this.felt.addMarks("pin", mark(pin()), 4, 2);
    // (18: the Dice tab's counted run along a whole side.)
    this.felt.addMarks("picked", mark(pickedRim()), 18, 2);
    this.felt.addMarks("gap", mark(gapOutline()), 32, 0);
    // A tile won off a discard: a gold rim round its ghost in the pond.
    this.felt.addMarks("won-gap", mark(wonOutline()), 1, 0);
    this.felt.addMarks("ring", mark(goldRing(PLAQUE_RINGED)), 1, 0);
    this.felt.addMarks("tile-ring", mark(goldRing(SEAT_TILE_RINGED)), 1, 0);
    // (Each 叮's: a bar in each pond.)
    for (const side of SIDES) this.felt.addMarks(`ding-${side}`, mark(dingBar("#ffd166")), 4, 2);
    for (const side of ["top", "bottom", "left", "right"] as const) this.felt.addMarks(`bubble-${side}`, mark(bubble(10, 10, 1, side, 1)), 1, 2);
    this.hand.addMarks("row-shadow", mark(rowShadow()), 1, 0);
    this.hand.addMarks("hint", mark(bar("#ffd166")), MAX_HAND, 2);
    this.hand.addMarks("ready", mark(triangle("#ffd23f")), MAX_HAND, 2);
    this.hand.addMarks("danger", mark(bar("#ff6b5a")), MAX_HAND, 2);
  }

  // Each side's 叮 bars, repainted when its colour changes.
  private dingPainted: Partial<Record<GLSide, string>> = {};
  dingColours(colours: Record<GLSide, string> | undefined) {
    if (!colours) return;
    for (const side of SIDES) {
      if (this.dingPainted[side] === colours[side]) continue;
      this.dingPainted[side] = colours[side];
      const mat = this.felt.marks.get(`ding-${side}`)!.material as THREE.ShaderMaterial;
      const old = mat.uniforms.uMap.value as THREE.Texture;
      old.dispose();
      this.kept.delete(old);
      mat.uniforms.uMap.value = this.keep(canvasTexture(dingBar(colours[side])));
    }
  }

  // The spotlight's bubbles, painted at the table's size.
  sizeBubbles(bw: number, bh: number, em: number, scale: number) {
    for (const side of ["top", "bottom", "left", "right"] as const) {
      const mesh = this.felt.marks.get(`bubble-${side}`)!;
      const mat = mesh.material as THREE.ShaderMaterial;
      const old = mat.uniforms.uMap.value as THREE.Texture;
      old.dispose();
      this.kept.delete(old);
      mat.uniforms.uMap.value = this.keep(canvasTexture(bubble(bw, bh, em, side, scale)));
    }
  }

  private sized = "";
  frame(f: Frame, dpr: number) {
    // (Only when it's changed: setting a canvas's size reallocates it, and a
    // camera being dragged comes through here every frame.)
    const size = `${f.width}x${f.height}@${dpr}`;
    if (size !== this.sized) {
      this.sized = size;
      this.renderer.setPixelRatio(dpr);
      this.renderer.setSize(f.width, f.height, false);
    }
    this.felt.root.matrix.fromArray(f.felt);
    this.felt.root.matrixWorldNeedsUpdate = true;
    const fp = cssProjection(f.stage.d, f.stage.ox, f.stage.oy, f.width, f.height);
    this.felt.camera.projectionMatrix.copy(fp);
    this.felt.camera.projectionMatrixInverse.copy(fp).invert();
    this.glass.root.matrix.fromArray(f.felt);
    this.glass.root.matrixWorldNeedsUpdate = true;
    this.glass.camera.projectionMatrix.copy(fp);
    this.glass.camera.projectionMatrixInverse.copy(fp).invert();
    this.hand.root.matrix.makeTranslation(f.hand.x, f.hand.y, 0);
    this.hand.root.matrixWorldNeedsUpdate = true;
    const hp = cssProjection(f.hand.d, f.hand.ox, f.hand.oy, f.width, f.height);
    this.hand.camera.projectionMatrix.copy(hp);
    this.hand.camera.projectionMatrixInverse.copy(hp).invert();
  }

  show(layout: Layout) {
    const now = performance.now();
    if (layout.felt.cardFaces) this.cardFaces(layout.felt.cardFaces);
    this.felt.set(layout.felt.pieces, layout.felt.quads, this.rects, now, layout.felt.dice, layout.felt.props);
    this.hand.set(layout.hand.pieces, layout.hand.quads, this.rects, now);
    this.glass.set(layout.felt.glass ?? [], layout.felt.glassQuads ?? [], this.rects, now);
  }

  // The name cards' faces (see cards.ts): painted afresh on the same canvas
  // when they change - a texture made of it once, updated after.
  private cardTex: THREE.Texture | null = null;
  private cardFaces(c: HTMLCanvasElement) {
    const mat = this.felt.propMesh("cards")?.material as THREE.ShaderMaterial | undefined;
    if (!mat) return;
    if (this.cardTex?.image !== c) {
      if (this.cardTex) {
        this.cardTex.dispose();
        this.kept.delete(this.cardTex);
      }
      this.cardTex = this.keep(canvasTexture(c));
      mat.uniforms.uMap.value = this.cardTex;
    } else this.cardTex.needsUpdate = true;
    mat.uniforms.uFaces.value = Number(c.dataset.faces ?? 1);
  }

  // Drawn now - and every frame after while anything's moving.
  private looping = 0;
  render() {
    const r = this.renderer;
    const now = performance.now();
    const moving = [this.felt.tick(now), this.glass.tick(now), this.hand.tick(now)].some(Boolean);
    r.clear();
    r.render(this.felt.scene, this.felt.camera);
    r.clearDepth();
    r.render(this.glass.scene, this.glass.camera);
    r.clearDepth();
    r.render(this.hand.scene, this.hand.camera);
    if (moving && !this.looping) {
      this.looping = requestAnimationFrame(() => {
        this.looping = 0;
        this.render();
      });
    }
  }

  // The tile of yours under a point of the canvas (its CSS pixels), if any:
  // a ray from the eye through it, into your row's blocks.
  pickHand(x: number, y: number, width: number, height: number): number | null {
    const i = this.pickIn(this.hand, x, y, width, height, (n) => this.hand.hits[n] !== undefined);
    return i === null ? null : this.hand.hits[i]!;
  }

  // Where your row's tile `index` is seen: the x of its middle, in the
  // table's own pixels (null: not drawn).
  handTileX(index: number, width: number): number | null {
    const n = this.hand.hits.indexOf(index);
    if (n < 0) return null;
    this.hand.scene.updateMatrixWorld();
    const m = new THREE.Matrix4();
    this.hand.tiles.getMatrixAt(n, m);
    const p = new THREE.Vector3().setFromMatrixPosition(m.premultiply(this.hand.tiles.matrixWorld)).applyMatrix4(this.hand.camera.projectionMatrix);
    return ((p.x + 1) / 2) * width;
  }

  // Where a point of the canvas falls on the felt's plane, in the felt's own pixels.
  feltPoint(x: number, y: number, width: number, height: number): { x: number; y: number } | null {
    const space = this.felt;
    space.scene.updateMatrixWorld();
    const ndc = (z: number) => new THREE.Vector3((x / width) * 2 - 1, 1 - (y / height) * 2, z).applyMatrix4(space.camera.projectionMatrixInverse);
    const near = ndc(-1);
    const ray = new THREE.Ray(near, ndc(1).sub(near).normalize()).applyMatrix4(space.root.matrixWorld.clone().invert());
    const p = ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), 0), new THREE.Vector3());
    return p && { x: p.x, y: p.y };
  }

  // A pile's tile under a point, on your take (換牌).
  pickPile(x: number, y: number, width: number, height: number): [string, number] | null {
    const i = this.pickIn(this.felt, x, y, width, height, (n) => this.felt.picks[n] !== undefined);
    return i === null ? null : this.felt.picks[i]!;
  }

  // The tile out in the open under a point (a pond's, a meld's - yours too -
  // a bonus tile), for 見牌: its face.
  // (And where it's seen, in the table's own pixels: its box on screen.)
  pickSeen(x: number, y: number, width: number, height: number): { face: string; x0: number; x1: number; y0: number; y1: number } | null {
    for (const space of [this.hand, this.felt]) {
      // (The tile the finger's on, or none: not one behind it - a wall tile
      // stood in front of a pond gives nothing to see.)
      const i = this.pickIn(space, x, y, width, height, (n) => space.seenFace(n) !== null, false);
      if (i === null) continue;
      const m = new THREE.Matrix4();
      space.tiles.getMatrixAt(i, m);
      m.premultiply(space.tiles.matrixWorld);
      const xs: number[] = [];
      const ys: number[] = [];
      for (const cx of [-0.5, 0.5]) for (const cy of [-0.5, 0.5]) for (const cz of [0, 1]) {
        const v = new THREE.Vector3(cx * TILE_W, cy * TILE_H, cz * THICK).applyMatrix4(m).applyMatrix4(space.camera.matrixWorldInverse).applyMatrix4(space.camera.projectionMatrix);
        xs.push(((v.x + 1) / 2) * width);
        ys.push(((1 - v.y) / 2) * height);
      }
      return { face: space.seenFace(i)!, x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
    }
    return null;
  }

  // `through`: past tiles that aren't `ok`, to the first that is - else only the nearest counts.
  private pickIn(space: Space, x: number, y: number, width: number, height: number, ok: (instance: number) => boolean, through = true): number | null {
    space.scene.updateMatrixWorld();
    const ndc = (z: number) => new THREE.Vector3((x / width) * 2 - 1, 1 - (y / height) * 2, z).applyMatrix4(space.camera.projectionMatrixInverse);
    const near = ndc(-1);
    const far = ndc(1);
    this.ray.ray.set(near, far.sub(near).normalize());
    // (Either side: the blocks are drawn by their back faces - see tileMaterial.)
    // (Where the tiles are now - one may have been mid-move when last set.)
    space.tiles.computeBoundingSphere();
    const material = space.tiles.material as THREE.Material;
    material.side = THREE.DoubleSide;
    const hits = this.ray.intersectObject(space.tiles, false).filter((h) => h.instanceId !== undefined);
    const hit = through ? hits.find((h) => ok(h.instanceId!)) : hits[0] && ok(hits[0].instanceId!) ? hits[0] : undefined;
    material.side = THREE.BackSide;
    return hit ? hit.instanceId! : null;
  }

  // Everything freed, and the context given back at once (iOS holds only a
  // few, and won't wait for the canvas to be collected).
  dispose() {
    cancelAnimationFrame(this.looping);
    this.looping = 0;
    this.kept.forEach((d) => d.dispose());
    this.kept.clear();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }
}
