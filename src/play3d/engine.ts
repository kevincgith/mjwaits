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
// .play-hand's own - so the tiles sit on the page's felt, by its compass,
// as Play's own would.

import * as THREE from "three";
import { THICK, TILE_H, TILE_R, TILE_W, type Layout, type Piece, type Quad, type QuadKind } from "./layout";
import type { Mat } from "./mat";
import type { Atlas } from "./textures";
import { bar, bubble, gapOutline, pickedRim, pin, rowShadow, tileShadow } from "./textures";

const MAX_FELT = 260;
const MAX_HAND = 48;

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

// Colours as the CSS has them (sRGB, unconverted), the sides' gradient its
// --tile-sides: jade at the foot, a light seam, ivory up to the face.
const tileMaterial = (atlas: THREE.Texture, back: [number, number, number, number]) =>
  new THREE.ShaderMaterial({
    uniforms: { uAtlas: { value: atlas }, uBack: { value: new THREE.Vector4(...back) } },
    vertexShader: /* glsl */ `
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
      void main() {
        vUv = uv;
        vPart = aPart;
        vZ = position.z / ${THICK.toFixed(3)};
        // Its long sides (facing along y) shaded one way, its ends another,
        // a rounded corner between them by how far round it faces.
        vShade = mix(aShade.x, aShade.y, abs(normal.x));
        vTint = aTint;
        vRect = aPart > 1.5 ? uBack : aFace;
        gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D uAtlas;
      varying vec2 vUv;
      varying float vPart;
      varying float vZ;
      varying float vShade;
      varying float vTint;
      varying vec4 vRect;
      vec3 side(float z) {
        vec3 c = mix(${hex(0x1f7a32)}, ${hex(0x35a84a)}, clamp(z / 0.38, 0.0, 1.0));
        c = mix(c, ${hex(0x7fd98c)}, clamp((z - 0.38) / 0.08, 0.0, 1.0));
        c = mix(c, ${hex(0xe6dfcb)}, clamp((z - 0.46) / 0.08, 0.0, 1.0));
        c = mix(c, ${hex(0xf2ede0)}, clamp((z - 0.54) / 0.46, 0.0, 1.0));
        return c;
      }
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
  constructor(geometry: THREE.BufferGeometry, material: THREE.Material, max: number) {
    this.root.matrixAutoUpdate = false;
    this.scene.add(this.root);
    const g = geometry.clone();
    this.face = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4);
    this.shade = new THREE.InstancedBufferAttribute(new Float32Array(max * 2), 2);
    this.tint = new THREE.InstancedBufferAttribute(new Float32Array(max), 1);
    g.setAttribute("aFace", this.face);
    g.setAttribute("aShade", this.shade);
    g.setAttribute("aTint", this.tint);
    this.tiles = new THREE.InstancedMesh(g, material, max);
    this.tiles.frustumCulled = false;
    this.tiles.count = 0;
    this.tiles.renderOrder = 1;
    this.root.add(this.tiles);
  }
  addMarks(kind: QuadKind, material: THREE.Material, max: number, order: number) {
    const m = new THREE.InstancedMesh(unitQuad(), material, max);
    m.frustumCulled = false;
    m.count = 0;
    m.renderOrder = order;
    this.root.add(m);
    this.marks.set(kind, m);
  }
  // What's shown, and how it moves: when each animation began (by its
  // key, from the frame it first appeared), and each eased move under way.
  private pieces: Piece[] = [];
  private quads = new Map<QuadKind, Quad[]>();
  private starts = new Map<string, number>();
  private eases = new Map<string, { from: THREE.Matrix4; to: Mat; start: number; dur: number; curve: (t: number) => number }>();
  private shown = new Map<string, THREE.Matrix4>();

  set(pieces: Piece[], quads: Quad[], rects: Atlas["rects"], now: number) {
    const n = Math.min(pieces.length, this.tiles.instanceMatrix.count);
    this.pieces = pieces.slice(0, n);
    const keys = new Set<string>();
    const begin = (a: { key: string } | undefined) => {
      if (!a) return;
      keys.add(a.key);
      if (!this.starts.has(a.key)) this.starts.set(a.key, now);
    };
    for (let i = 0; i < n; i++) {
      const p = pieces[i];
      begin(p.anim);
      begin(p.fly);
      // Moved: eased from where it shows now to its new place.
      if (p.ease) {
        keys.add(p.ease.key);
        const was = this.eases.get(p.ease.key);
        const target = was?.to ?? this.shown.get(p.ease.key)?.toArray();
        if (target && target.some((v, j) => Math.abs(v - p.m[j]) > 1e-3)) {
          const from = this.shown.get(p.ease.key)!.clone();
          this.eases.set(p.ease.key, { from, to: p.m, start: now, dur: p.ease.dur, curve: p.ease.curve });
        } else if (!was) this.shown.set(p.ease.key, new THREE.Matrix4().fromArray(p.m));
      }
      const r = rects.get(p.face) ?? rects.get("back")!;
      this.face.setXYZW(i, r[0], r[1], r[2], r[3]);
      this.shade.setXY(i, p.shade[0], p.shade[1]);
      this.tint.setX(i, p.tint);
    }
    this.tiles.count = n;
    this.hits = this.pieces.map((p) => p.hit);
    this.picks = this.pieces.map((p) => p.pick);
    this.face.needsUpdate = this.shade.needsUpdate = this.tint.needsUpdate = true;
    for (const [kind, mesh] of this.marks) {
      const mine = quads.filter((q) => q.kind === kind).slice(0, mesh.instanceMatrix.count);
      mine.forEach((q) => begin(q.anim));
      this.quads.set(kind, mine);
      mesh.count = mine.length;
    }
    for (const k of [...this.starts.keys()]) if (!keys.has(k)) this.starts.delete(k);
    for (const k of [...this.shown.keys()]) if (!keys.has(k)) (this.shown.delete(k), this.eases.delete(k));
    this.tick(now);
  }

  // Everything where it is at `now` (ms); whether anything's still moving.
  tick(now: number): boolean {
    let moving = false;
    const mat = new THREE.Matrix4();
    const at = (item: Piece | Quad): Mat => {
      const a = item.anim;
      if (!a) return item.m;
      const t = (now - (this.starts.get(a.key) ?? now)) / 1000 - a.delay;
      if (t >= a.dur) return item.m;
      moving = true;
      return a.pose(Math.max(0, t) / a.dur);
    };
    this.pieces.forEach((p, i) => {
      const e = p.ease && this.eases.get(p.ease.key);
      if (e && !(p.anim && (now - (this.starts.get(p.anim.key) ?? 0)) / 1000 < p.anim.delay + p.anim.dur)) {
        const k = Math.min(1, (now - e.start) / 1000 / e.dur);
        const v = e.curve(k);
        const [p0, q0, s0] = [new THREE.Vector3(), new THREE.Quaternion(), new THREE.Vector3()];
        const [p1, q1, s1] = [new THREE.Vector3(), new THREE.Quaternion(), new THREE.Vector3()];
        e.from.decompose(p0, q0, s0);
        mat.fromArray(e.to).decompose(p1, q1, s1);
        mat.compose(p0.lerp(p1, v), q0.slerp(q1, v), s0.lerp(s1, v));
        if (k >= 1) this.eases.delete(p.ease!.key);
        else moving = true;
      } else if (p.fly && p.hideAfter !== undefined && (now - (this.starts.get(p.fly.key) ?? now)) / 1000 >= p.hideAfter) {
        mat.makeScale(0, 0, 0);
      } else if (p.fly && (now - (this.starts.get(p.fly.key) ?? now)) / 1000 < p.fly.dur) {
        // In the air: eased along, turning to how it lands, lifted mid-way.
        const k = (now - this.starts.get(p.fly.key)!) / 1000 / p.fly.dur;
        const v = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
        const [p0, q0, s0] = [new THREE.Vector3(), new THREE.Quaternion(), new THREE.Vector3()];
        const [p1, q1, s1] = [new THREE.Vector3(), new THREE.Quaternion(), new THREE.Vector3()];
        mat.fromArray(p.fly.from).decompose(p0, q0, s0);
        mat.fromArray(p.m).decompose(p1, q1, s1);
        p0.lerp(p1, v);
        p0.z += Math.sin(Math.PI * v) * p.fly.lift;
        mat.compose(p0, q0.slerp(q1, v), s0.lerp(s1, v));
        moving = true;
      } else mat.fromArray(at(p));
      if (p.ease) this.shown.set(p.ease.key, mat.clone());
      this.tiles.setMatrixAt(i, mat);
    });
    this.tiles.instanceMatrix.needsUpdate = true;
    for (const [kind, mesh] of this.marks) {
      (this.quads.get(kind) ?? []).forEach((q, i) => mesh.setMatrixAt(i, mat.fromArray(at(q))));
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
  bubbles = new Map<string, THREE.Texture>();
  private ray = new THREE.Raycaster();
  private disposables: { dispose(): void }[] = [];
  constructor(canvas: HTMLCanvasElement, atlas: Atlas) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, premultipliedAlpha: true });
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.autoClear = false;
    this.rects = atlas.rects;
    const tex = canvasTexture(atlas.canvas);
    tex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    const geometry = tileGeometry();
    const material = tileMaterial(tex, atlas.rects.get("back")!);
    this.felt = new Space(geometry, material, MAX_FELT);
    this.hand = new Space(geometry, material, MAX_HAND);
    const shadow = markMaterial(canvasTexture(tileShadow()));
    this.felt.addMarks("shadow", shadow, MAX_FELT, 0);
    this.felt.addMarks("pin", markMaterial(canvasTexture(pin())), 4, 2);
    this.felt.addMarks("picked", markMaterial(canvasTexture(pickedRim())), 16, 2);
    this.felt.addMarks("gap", markMaterial(canvasTexture(gapOutline())), 32, 0);
    for (const side of ["top", "bottom", "left", "right"] as const) this.felt.addMarks(`bubble-${side}`, markMaterial(canvasTexture(bubble(10, 10, 1, side, 1))), 1, 2);
    this.hand.addMarks("row-shadow", markMaterial(canvasTexture(rowShadow())), 1, 0);
    this.hand.addMarks("hint", markMaterial(canvasTexture(bar("#ffd166"))), MAX_HAND, 2);
    this.hand.addMarks("danger", markMaterial(canvasTexture(bar("#ff6b5a"))), MAX_HAND, 2);
    this.disposables.push(geometry, material, tex);
  }

  // The spotlight's bubbles, painted at the table's size.
  sizeBubbles(bw: number, bh: number, em: number, scale: number) {
    for (const side of ["top", "bottom", "left", "right"] as const) {
      const mesh = this.felt.marks.get(`bubble-${side}`)!;
      const mat = mesh.material as THREE.ShaderMaterial;
      (mat.uniforms.uMap.value as THREE.Texture).dispose();
      mat.uniforms.uMap.value = canvasTexture(bubble(bw, bh, em, side, scale));
    }
  }

  frame(f: Frame, dpr: number) {
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(f.width, f.height, false);
    this.felt.root.matrix.fromArray(f.felt);
    this.felt.root.matrixWorldNeedsUpdate = true;
    const fp = cssProjection(f.stage.d, f.stage.ox, f.stage.oy, f.width, f.height);
    this.felt.camera.projectionMatrix.copy(fp);
    this.felt.camera.projectionMatrixInverse.copy(fp).invert();
    this.hand.root.matrix.makeTranslation(f.hand.x, f.hand.y, 0);
    this.hand.root.matrixWorldNeedsUpdate = true;
    const hp = cssProjection(f.hand.d, f.hand.ox, f.hand.oy, f.width, f.height);
    this.hand.camera.projectionMatrix.copy(hp);
    this.hand.camera.projectionMatrixInverse.copy(hp).invert();
  }

  show(layout: Layout) {
    const now = performance.now();
    this.felt.set(layout.felt.pieces, layout.felt.quads, this.rects, now);
    this.hand.set(layout.hand.pieces, layout.hand.quads, this.rects, now);
  }

  // Drawn now - and every frame after while anything's moving.
  private looping = 0;
  render() {
    const r = this.renderer;
    const now = performance.now();
    const moving = [this.felt.tick(now), this.hand.tick(now)].some(Boolean);
    r.clear();
    r.render(this.felt.scene, this.felt.camera);
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

  // A pile's tile under a point, on your take (換牌).
  pickPile(x: number, y: number, width: number, height: number): [string, number] | null {
    const i = this.pickIn(this.felt, x, y, width, height, (n) => this.felt.picks[n] !== undefined);
    return i === null ? null : this.felt.picks[i]!;
  }

  private pickIn(space: Space, x: number, y: number, width: number, height: number, ok: (instance: number) => boolean): number | null {
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
    const hit = this.ray.intersectObject(space.tiles, false).find((h) => h.instanceId !== undefined && ok(h.instanceId));
    material.side = THREE.BackSide;
    return hit ? hit.instanceId! : null;
  }

  dispose() {
    cancelAnimationFrame(this.looping);
    this.disposables.forEach((d) => d.dispose());
    this.renderer.dispose();
  }
}
