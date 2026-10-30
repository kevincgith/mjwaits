// Play 2.0's tiles: a WebGL canvas over the table (see engine.ts), drawing
// what PlayPanel says is on it (GLTableView) where layout.ts lays it out.
// The table's own sizes are read off the page only when the screen changes
// size; the compass is set where the layout puts the middle, and your
// row's box is sized to the tiles drawn in it, so the call buttons above it
// and the bar under it sit as they do in Play.
//
// Loaded on its own (with three.js) only when Play 2.0 opens.

import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { Engine, type Frame } from "./engine";
import { bubbleBox, layoutTable, type Dims } from "./layout";
import { buildAtlas, type Atlas } from "./textures";
import type { GLSide, GLTableView } from "./types";

// An element's layout box within `root` (its offsets - transforms aside).
function offsetIn(el: HTMLElement, root: HTMLElement): { x: number; y: number } {
  let x = 0;
  let y = 0;
  for (let e: HTMLElement | null = el; e && e !== root; e = e.offsetParent as HTMLElement | null) {
    x += e.offsetLeft;
    y += e.offsetTop;
  }
  return { x, y };
}

// The table's CSS sizes, by a probe set in the felt for a moment.
function readDims(felt: HTMLElement, middle: HTMLElement): Dims {
  const probe = document.createElement("span");
  probe.style.cssText = "position:absolute;visibility:hidden";
  felt.appendChild(probe);
  const size = (v: string) => {
    probe.style.fontSize = `var(${v})`;
    return parseFloat(getComputedStyle(probe).fontSize);
  };
  const dims: Dims = {
    feltW: felt.offsetWidth,
    feltH: felt.offsetHeight,
    rem: parseFloat(getComputedStyle(document.documentElement).fontSize) || 16,
    under: size("--play-under"),
    hand: size("--play-hand"),
    tile: size("--play-tile"),
    wall: size("--play-wall"),
    wallTop: size("--play-wall-top"),
    middle: parseFloat(getComputedStyle(middle).fontSize),
    compass: (middle.firstElementChild as HTMLElement | null)?.offsetHeight ?? 0,
    handTop: Infinity,
  };
  probe.remove();
  return dims;
}

// Where the felt and your row sit in the canvas (which covers `root`), and
// the perspectives they're seen through.
function readFrame(root: HTMLElement, felt: HTMLElement, hand: HTMLElement): Frame {
  const stage = felt.parentElement!;
  const fs = getComputedStyle(felt);
  const ss = getComputedStyle(stage);
  const hs = getComputedStyle(hand);
  const pair = (v: string) => v.split(" ").map(parseFloat);
  const [tox, toy] = pair(fs.transformOrigin);
  const fo = offsetIn(felt, root);
  const tilt = new DOMMatrix(fs.transform === "none" ? undefined : fs.transform);
  const felted = new DOMMatrix().translate(fo.x + tox, fo.y + toy).multiply(tilt).translate(-tox, -toy);
  const so = offsetIn(stage, root);
  const [sox, soy] = pair(ss.perspectiveOrigin);
  const ho = offsetIn(hand, root);
  const [hox, hoy] = pair(hs.perspectiveOrigin);
  return {
    width: root.clientWidth,
    height: root.clientHeight,
    felt: Array.from(felted.toFloat32Array()),
    stage: { d: parseFloat(ss.perspective) || 1100, ox: so.x + sox, oy: so.y + soy },
    hand: { x: ho.x, y: ho.y, d: parseFloat(hs.perspective) || 1100, ox: ho.x + hox, oy: ho.y + hoy },
  };
}

// The felt's y (in its own plane, down the middle) that's seen at the
// canvas's `screenY` - through its tilt and the stage's perspective.
function feltYAt(f: Frame, screenY: number, x: number, depth: number): number {
  const m = new DOMMatrix(f.felt);
  const seen = (y: number) => {
    const p = m.transformPoint(new DOMPoint(x, y, 0));
    return f.stage.oy + ((p.y - f.stage.oy) * f.stage.d) / (f.stage.d - p.z);
  };
  if (seen(depth) <= screenY) return depth;
  let lo = 0;
  let hi = depth;
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    if (seen(mid) < screenY) lo = mid;
    else hi = mid;
  }
  return lo;
}

export default function TableGL({
  view,
  rootRef,
  feltRef,
  handRef,
  middleRef,
  onTile,
  onPile,
}: {
  view: GLTableView;
  // A tap on a pile's tile, on your take (換牌).
  onPile: (side: GLSide, index: number) => void;
  // A tap on one of your tiles (by its place in your hand).
  onTile: (index: number) => void;
  rootRef: RefObject<HTMLElement | null>;
  feltRef: RefObject<HTMLElement | null>;
  handRef: RefObject<HTMLElement | null>;
  middleRef: RefObject<HTMLElement | null>;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [atlas, setAtlas] = useState<Atlas | null>(null);
  const engine = useRef<Engine | null>(null);
  const dims = useRef<Dims | null>(null);
  const viewRef = useRef(view);
  viewRef.current = view;
  const onTileRef = useRef(onTile);
  onTileRef.current = onTile;
  const onPileRef = useRef(onPile);
  onPileRef.current = onPile;

  useEffect(() => {
    let live = true;
    void buildAtlas().then((a) => live && setAtlas(a));
    return () => {
      live = false;
    };
  }, []);

  // Lay the table out and draw it: the compass where the middle is, your
  // row's box the size of what's in it, then the tiles.
  const draw = useRef((remeasure: boolean) => {
    const e = engine.current;
    const root = rootRef.current;
    const felt = feltRef.current;
    const hand = handRef.current;
    const middle = middleRef.current;
    if (!e || !root || !felt || !hand || !middle) return;
    if (remeasure || !dims.current) {
      const d = readDims(felt, middle);
      // Where your standing tiles' tops are seen, on the felt (your pond stops short of them).
      hand.style.height = `${1.2 * d.hand}px`;
      const f = readFrame(root, felt, hand);
      d.handTop = feltYAt(f, f.hand.y + 0.2 * d.hand, d.feltW / 2, d.feltH);
      // The felt as seen from your row: from the middle of its top edge (it's centred, so that stays put).
      const tilt = new DOMMatrix(f.felt);
      const handMid = f.hand.x + hand.offsetWidth / 2;
      d.project = (x, y, z) => {
        const p = tilt.transformPoint(new DOMPoint(x, y, z));
        const s = f.stage.d / (f.stage.d - p.z);
        return { x: f.stage.ox + (p.x - f.stage.ox) * s - handMid, y: f.stage.oy + (p.y - f.stage.oy) * s - f.hand.y, s };
      };
      dims.current = d;
      const b = bubbleBox(dims.current);
      e.sizeBubbles(b.bw, b.bh, b.em, Math.min(3, window.devicePixelRatio || 1) * 1.5);
    }
    const layout = layoutTable(viewRef.current, dims.current);
    middle.style.left = `${layout.middle.x}px`;
    middle.style.top = `${layout.middle.y}px`;
    hand.style.width = `${layout.hand.width}px`;
    hand.style.height = `${layout.hand.height}px`;
    e.frame(readFrame(root, felt, hand), Math.min(3, window.devicePixelRatio || 1));
    e.show(layout);
    e.render();
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!atlas || !canvas) return;
    const e = new Engine(canvas, atlas);
    engine.current = e;
    if (import.meta.env.DEV) (window as unknown as { __gl: Engine }).__gl = e;
    draw.current(true);
    // Re-measured whenever the table, the felt (its depth is fitted to the
    // screen) or your row changes size.
    const watch = new ResizeObserver(() => draw.current(true));
    [rootRef.current, feltRef.current].forEach((el) => el && watch.observe(el));
    return () => {
      watch.disconnect();
      engine.current = null;
      e.dispose();
    };
  }, [atlas, rootRef, feltRef]);

  // Taps on your tiles: a ray from where you tapped into your row (the
  // canvas lets taps through to the page; buttons and sheets keep theirs).
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    let down: { x: number; y: number; at: number } | null = null;
    const onDown = (e: PointerEvent) => {
      down = e.isPrimary ? { x: e.clientX, y: e.clientY, at: e.timeStamp } : null;
    };
    const onUp = (e: PointerEvent) => {
      const start = down;
      down = null;
      const e3 = engine.current;
      if (!start || !e3 || !e.isPrimary || Math.hypot(e.clientX - start.x, e.clientY - start.y) > 10 || e.timeStamp - start.at > 800) return;
      if ((e.target as Element | null)?.closest("button, a, input, [role=dialog], [role=menu], .play-menu, .play-calls, .sc-sheet")) return;
      // Into the table's own pixels - it's drawn turned a quarter on a phone held upright.
      const turn = new DOMMatrix(getComputedStyle(root).transform === "none" ? undefined : getComputedStyle(root).transform);
      const p = turn.inverse().transformPoint(new DOMPoint(e.clientX - root.offsetLeft, e.clientY - root.offsetTop));
      const i = e3.pickHand(p.x, p.y, root.clientWidth, root.clientHeight);
      if (i !== null) {
        if (viewRef.current.mine.tiles[i]?.enabled) onTileRef.current(i);
        return;
      }
      const pile = e3.pickPile(p.x, p.y, root.clientWidth, root.clientHeight);
      if (pile) onPileRef.current(pile[0] as GLSide, pile[1]);
    };
    root.addEventListener("pointerdown", onDown);
    root.addEventListener("pointerup", onUp);
    return () => {
      root.removeEventListener("pointerdown", onDown);
      root.removeEventListener("pointerup", onUp);
    };
  }, [rootRef]);

  // Drawn again only when what's on the table changes.
  const shown = useRef("");
  useLayoutEffect(() => {
    const key = JSON.stringify(view);
    if (key === shown.current || !engine.current) return;
    shown.current = key;
    draw.current(false);
  });

  return <canvas ref={canvasRef} className="play-gl" aria-hidden="true" />;
}
