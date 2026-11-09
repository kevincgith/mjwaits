// Play's tiles: a WebGL canvas over the table (see engine.ts), drawing
// what PlayPanel says is on it (GLTableView) where layout.ts lays it out.
// The table's own sizes are read off the page only when the screen changes
// size; the compass is set where the layout puts the middle, and your
// row's box is sized to the tiles drawn in it, so the call buttons above it
// and the bar under it sit as they do in Play.
//
// Loaded on its own (with three.js) - see lib/lazyParts.ts.

import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { Engine, type Frame } from "./engine";
import { bubbleBox, feltToHand, layoutTable, SWAP_ROW, type Dims } from "./layout";
import { cornerZoom, layoutCorner } from "./corner";
import { sharedAtlas, type Atlas } from "./textures";
import { CORNER_TILT, CORNER_TILT_MAX, CORNER_TILT_MIN, CORNER_YAW, type CornerCamera, type GLSide, type GLTableView } from "./types";

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

// Where a pointer is, in the table's own pixels - it's drawn turned a quarter
// on a phone held upright.
function pointerIn(root: HTMLElement, e: PointerEvent): DOMPoint {
  const turn = new DOMMatrix(getComputedStyle(root).transform === "none" ? undefined : getComputedStyle(root).transform);
  return turn.inverse().transformPoint(new DOMPoint(e.clientX - root.offsetLeft, e.clientY - root.offsetTop));
}

// A press on the page's own controls, not on the table.
const offTable = (e: PointerEvent) => !!(e.target as Element | null)?.closest("button, a, input, [role=dialog], [role=menu], .play-menu, .play-calls, .sc-sheet");

// The free camera: degrees per pixel dragged, and the longest gap between a double tap's taps.
const DRAG_YAW = 0.4;
const DRAG_TILT = 0.25;
const DOUBLE_TAP_MS = 320;

// Each seat's name card outside its edge of the table, wherever the
// camera has put that, kept on the screen and clear of the top buttons and the bar.
function placeBadges(root: HTMLElement, f: Frame, feltW: number) {
  const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  const m = new DOMMatrix(f.felt);
  const c = feltW / 2;
  // (Far enough out to clear the hand standing at that edge.)
  const out = c * 1.45;
  for (const [side, dx, dy] of [["bottom", 0, 1], ["right", 1, 0], ["top", 0, -1], ["left", -1, 0]] as const) {
    const el = root.querySelector<HTMLElement>(`.play-badge.at-${side}`);
    if (!el) continue;
    const p = m.transformPoint(new DOMPoint(c + dx * out, c + dy * out, 0));
    const s = f.stage.d / (f.stage.d - p.z);
    const hw = el.offsetWidth / 2;
    const hh = el.offsetHeight / 2;
    const fit = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
    const x = fit(f.stage.ox + (p.x - f.stage.ox) * s, hw + 6, f.width - hw - 6);
    // (Only under the buttons at the screen's top corners need it stay lower.)
    const top = x - hw > 12.5 * rem && x + hw < f.width - 6.5 * rem ? 0.45 * rem : 3 * rem;
    el.style.left = `${x}px`;
    el.style.top = `${fit(f.stage.oy + (p.y - f.stage.oy) * s, top + hh, f.height - 2.6 * rem - hh)}px`;
  }
}

// Canvases whose context has been given back (see Engine.dispose): one
// can't be drawn on again, so the next engine gets a fresh canvas.
const spent = new WeakSet<HTMLCanvasElement>();

export default function TableGL({
  view,
  rootRef,
  feltRef,
  handRef,
  middleRef,
  onTile,
  onPile,
  sweep = false,
  onSweep,
  onPress,
  tileXRef,
}: {
  view: GLTableView;
  // A tap on a pile's tile, on your take (換牌).
  onPile: (side: GLSide, index: number) => void;
  // A tap on one of your tiles (by its place in your hand).
  onTile: (index: number) => void;
  // `sweep`: a press on one of your tiles and a slide across others, finger
  // down all the while (換牌's give) - each tile in turn, `first` the one
  // pressed. The press is no tap then.
  sweep?: boolean;
  onSweep?: (index: number, first: boolean) => void;
  // The tile a finger is held on in your row, from press to let go (null:
  // none - let go, or slid off it, which is no tap).
  onPress?: (index: number | null) => void;
  // Set to where one of your tiles is seen: the x of its middle, from your
  // row's box's left (null: not drawn) - for what's shown over it.
  tileXRef?: RefObject<((index: number) => number | null) | null>;
  rootRef: RefObject<HTMLElement | null>;
  feltRef: RefObject<HTMLElement | null>;
  handRef: RefObject<HTMLElement | null>;
  middleRef: RefObject<HTMLElement | null>;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [atlas, setAtlas] = useState<Atlas | null>(null);
  // The browser wouldn't give it WebGL (iOS can refuse): a message and a
  // retry, over the felt - the game itself carries on in PlayPanel.
  const [failed, setFailed] = useState(false);
  const [tries, setTries] = useState(0);
  const [canvasKey, setCanvasKey] = useState(0);
  const engine = useRef<Engine | null>(null);
  const dims = useRef<Dims | null>(null);
  const keptWidth = useRef(0);
  const camera = useRef<CornerCamera>({ yaw: CORNER_YAW, tilt: CORNER_TILT });
  const viewRef = useRef(view);
  viewRef.current = view;
  if (import.meta.env.DEV) (window as unknown as { __glView: GLTableView }).__glView = view;
  const onTileRef = useRef(onTile);
  onTileRef.current = onTile;
  const onPileRef = useRef(onPile);
  onPileRef.current = onPile;
  const sweepRef = useRef(sweep);
  sweepRef.current = sweep;
  const onSweepRef = useRef(onSweep);
  onSweepRef.current = onSweep;
  const onPressRef = useRef(onPress);
  onPressRef.current = onPress;

  useEffect(() => {
    let live = true;
    sharedAtlas().then(
      (a) => live && setAtlas(a),
      (err: unknown) => {
        console.error("Play's table: no tile faces", err);
        if (live) setFailed(true);
      }
    );
    return () => {
      live = false;
    };
  }, [tries]);

  useEffect(() => {
    if (!tileXRef) return;
    tileXRef.current = (i) => {
      const e3 = engine.current;
      const root = rootRef.current;
      const hand = handRef.current;
      const x = e3 && root && hand ? e3.handTileX(i, root.clientWidth) : null;
      return x === null ? null : x - offsetIn(hand!, root!).x;
    };
    return () => void (tileXRef.current = null);
  }, [tileXRef, rootRef, handRef]);

  // Lay the table out and draw it: the compass where the middle is, your
  // row's box the size of what's in it, then the tiles.
  const draw = useRef((remeasure: boolean) => {
    const e = engine.current;
    const root = rootRef.current;
    const felt = feltRef.current;
    const hand = handRef.current;
    const middle = middleRef.current;
    if (!e || !root || !felt || !hand || !middle) return;
    const corner = !!viewRef.current.corner;
    if (corner) {
      felt.style.setProperty("--corner-yaw", `${camera.current.yaw}deg`);
      felt.style.setProperty("--corner-tilt", `${camera.current.tilt}deg`);
      felt.style.setProperty("--corner-zoom", String(cornerZoom(camera.current)));
    }
    if (remeasure || !dims.current) {
      const d = readDims(felt, middle);
      // Where your standing tiles' tops are seen, on the felt (your pond stops short of them).
      hand.style.height = `${1.2 * d.hand}px`;
      const f = readFrame(root, felt, hand);
      d.handTop = feltYAt(f, f.hand.y + 0.2 * d.hand, d.feltW / 2, d.feltH);
      // (Its tiles 0.8 of your hand's, standing a row's height above it, leant back as yours.)
      d.rowTop = feltYAt(f, f.hand.y - 0.25 * d.rem - 1.12 * SWAP_ROW * d.hand, d.feltW / 2, d.feltH);
      d.rowRoom = root.clientWidth;
      // The felt as seen from your row: from the middle of its top edge (it's centred, so that stays put).
      const tilt = new DOMMatrix(f.felt);
      const handMid = f.hand.x + hand.offsetWidth / 2;
      d.feltToHand = feltToHand(new Float32Array(f.felt), f.stage, f.hand, handMid, f.hand.y);
      d.project = (x, y, z) => {
        const p = tilt.transformPoint(new DOMPoint(x, y, z));
        const s = f.stage.d / (f.stage.d - p.z);
        return { x: f.stage.ox + (p.x - f.stage.ox) * s - handMid, y: f.stage.oy + (p.y - f.stage.oy) * s - f.hand.y, s };
      };
      dims.current = d;
      const b = bubbleBox(dims.current);
      e.sizeBubbles(b.bw, b.bh, b.em, Math.min(3, window.devicePixelRatio || 1) * 1.5);
    }
    // (In 換牌 your row keeps the widest it's been, so it never re-centres.)
    dims.current.handMinWidth = viewRef.current.mine.sliding ? keptWidth.current : 0;
    const layout = corner ? layoutCorner(viewRef.current, dims.current, camera.current) : layoutTable(viewRef.current, dims.current);
    keptWidth.current = viewRef.current.mine.sliding ? Math.max(keptWidth.current, layout.hand.width) : 0;
    middle.style.left = `${layout.middle.x}px`;
    middle.style.top = `${layout.middle.y}px`;
    hand.style.width = `${layout.hand.width}px`;
    hand.style.height = `${layout.hand.height}px`;
    const frame = readFrame(root, felt, hand);
    e.frame(frame, Math.min(3, window.devicePixelRatio || 1));
    if (corner) placeBadges(root, frame, dims.current.feltW);
    e.show(layout);
    e.render();
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!atlas || !canvas || failed) return;
    // (Its context already given back - React's dev double mount: a new canvas.)
    if (spent.has(canvas)) {
      setCanvasKey((k) => k + 1);
      return;
    }
    let e: Engine;
    try {
      e = new Engine(canvas, atlas);
    } catch (err) {
      console.error("Play's table couldn't start", err);
      spent.add(canvas);
      setFailed(true);
      return;
    }
    engine.current = e;
    if (import.meta.env.DEV) (window as unknown as { __gl: Engine }).__gl = e;
    draw.current(true);
    // Re-measured whenever the table, the felt (its depth is fitted to the
    // screen) or your row changes size.
    const watch = new ResizeObserver(() => draw.current(true));
    [rootRef.current, feltRef.current].forEach((el) => el && watch.observe(el));
    // iOS drops the context when the app's put away: kept restorable, and
    // drawn again in full once it's back (three uploads everything again,
    // but only draws when told to) - and on coming back to the app.
    const lost = (ev: Event) => ev.preventDefault();
    // (Again a frame later: the browser can show the first frame after a
    // restore blank, or black.)
    let again = 0;
    const restored = () => {
      draw.current(true);
      cancelAnimationFrame(again);
      again = requestAnimationFrame(() => draw.current(false));
    };
    const back = () => document.visibilityState === "visible" && draw.current(true);
    canvas.addEventListener("webglcontextlost", lost);
    canvas.addEventListener("webglcontextrestored", restored);
    document.addEventListener("visibilitychange", back);
    return () => {
      canvas.removeEventListener("webglcontextlost", lost);
      canvas.removeEventListener("webglcontextrestored", restored);
      document.removeEventListener("visibilitychange", back);
      cancelAnimationFrame(again);
      watch.disconnect();
      engine.current = null;
      spent.add(canvas);
      e.dispose();
    };
  }, [atlas, failed, canvasKey, rootRef, feltRef]);

  // Taps on your tiles: a ray from where you tapped into your row (the
  // canvas lets taps through to the page; buttons and sheets keep theirs).
  // While sweeping is on, a press on a tile and the slide after it instead.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    let down: { x: number; y: number; at: number } | null = null;
    // A sweep under way: the tile the finger was last over.
    let swept: number | null = null;
    // The tile a finger's held on (see onPress).
    let pressed: number | null = null;
    const press = (i: number | null) => {
      if (i === pressed) return;
      pressed = i;
      onPressRef.current?.(i);
    };
    const moved = (e: PointerEvent, from: { x: number; y: number }) => Math.hypot(e.clientX - from.x, e.clientY - from.y) > 10;
    const at = (e: PointerEvent) => pointerIn(root, e);
    const tileAt = (e: PointerEvent): number | null => {
      const e3 = engine.current;
      if (!e3) return null;
      const p = at(e);
      const i = e3.pickHand(p.x, p.y, root.clientWidth, root.clientHeight);
      return i !== null && viewRef.current.mine.tiles[i]?.enabled ? i : null;
    };
    const outside = offTable;
    const onDown = (e: PointerEvent) => {
      down = e.isPrimary ? { x: e.clientX, y: e.clientY, at: e.timeStamp } : null;
      swept = null;
      if (!down || outside(e)) return;
      const i = tileAt(e);
      if (!sweepRef.current) return press(i);
      if (i === null) return;
      swept = i;
      onSweepRef.current?.(i, true);
    };
    const onMove = (e: PointerEvent) => {
      if (!e.isPrimary) return;
      // Held on a tile: slid off it, it's let go (no tap now).
      if (pressed !== null && down) press(moved(e, down) ? null : (tileAt(e) ?? pressed));
      if (swept === null) return;
      const i = tileAt(e);
      if (i === null || i === swept) return;
      // Every tile between, too - a quick slide can pass one between two
      // moves. (Your row's places run in order across it.)
      const step = i > swept ? 1 : -1;
      for (let k = swept + step; k !== i + step; k += step) if (viewRef.current.mine.tiles[k]?.enabled) onSweepRef.current?.(k, false);
      swept = i;
    };
    const onUp = (e: PointerEvent) => {
      const start = down;
      down = null;
      const held = pressed;
      press(null);
      // (A sweep has done its picking as it went.)
      if (swept !== null) return void (swept = null);
      const e3 = engine.current;
      // (A long press is a tap still if it was held on one of your tiles -
      // to read its waits.)
      if (!start || !e3 || !e.isPrimary || moved(e, start) || (e.timeStamp - start.at > 800 && held === null)) return;
      if (outside(e)) return;
      const p = at(e);
      const i = e3.pickHand(p.x, p.y, root.clientWidth, root.clientHeight);
      if (i !== null) {
        if (viewRef.current.mine.tiles[i]?.enabled) onTileRef.current(i);
        return;
      }
      const pile = e3.pickPile(p.x, p.y, root.clientWidth, root.clientHeight);
      if (pile) onPileRef.current(pile[0] as GLSide, pile[1]);
    };
    const onCancel = () => {
      down = null;
      swept = null;
      press(null);
    };
    root.addEventListener("pointerdown", onDown);
    root.addEventListener("pointermove", onMove);
    root.addEventListener("pointerup", onUp);
    root.addEventListener("pointercancel", onCancel);
    return () => {
      root.removeEventListener("pointerdown", onDown);
      root.removeEventListener("pointermove", onMove);
      root.removeEventListener("pointerup", onUp);
      root.removeEventListener("pointercancel", onCancel);
    };
  }, [rootRef]);

  // The free camera: a drag across the table circles it (side to side) and
  // lays it back or stands it up (up and down), the table following the
  // finger; a double tap puts the camera back where it started.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    let drag: (CornerCamera & { x: number; y: number; moved: boolean }) | null = null;
    let lastTap = 0;
    let queued = 0;
    const redraw = () => {
      if (queued) return;
      queued = requestAnimationFrame(() => {
        queued = 0;
        draw.current(false);
      });
    };
    const onDown = (e: PointerEvent) => {
      if (!viewRef.current.corner || !e.isPrimary || offTable(e)) return;
      const p = pointerIn(root, e);
      drag = { ...camera.current, x: p.x, y: p.y, moved: false };
    };
    const onMove = (e: PointerEvent) => {
      if (!drag || !e.isPrimary) return;
      const p = pointerIn(root, e);
      const dx = p.x - drag.x;
      const dy = p.y - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < 4) return;
      drag.moved = true;
      camera.current = { yaw: drag.yaw - dx * DRAG_YAW, tilt: Math.max(CORNER_TILT_MIN, Math.min(CORNER_TILT_MAX, drag.tilt - dy * DRAG_TILT)) };
      redraw();
    };
    const onUp = (e: PointerEvent) => {
      if (!drag || !e.isPrimary) return;
      const tapped = !drag.moved;
      drag = null;
      if (!tapped) return;
      if (e.timeStamp - lastTap < DOUBLE_TAP_MS) {
        lastTap = 0;
        camera.current = { yaw: CORNER_YAW, tilt: CORNER_TILT };
        redraw();
      } else lastTap = e.timeStamp;
    };
    const onCancel = () => void (drag = null);
    root.addEventListener("pointerdown", onDown);
    root.addEventListener("pointermove", onMove);
    root.addEventListener("pointerup", onUp);
    root.addEventListener("pointercancel", onCancel);
    return () => {
      cancelAnimationFrame(queued);
      root.removeEventListener("pointerdown", onDown);
      root.removeEventListener("pointermove", onMove);
      root.removeEventListener("pointerup", onUp);
      root.removeEventListener("pointercancel", onCancel);
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

  return (
    <>
      <canvas key={canvasKey} ref={canvasRef} className="play-gl" aria-hidden="true" />
      {failed && (
        <div role="alert" style={{ position: "absolute", inset: 0, zIndex: 2, display: "flex", alignItems: "center", justifyContent: "center", pointerEvents: "none" }}>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "0.6rem", padding: "0.9rem 1.2rem", borderRadius: "0.8rem", background: "rgba(14, 18, 16, 0.92)", border: "1px solid rgba(255, 209, 102, 0.85)", color: "#f4f7f5", textAlign: "center", pointerEvents: "auto" }}>
            <span>The table couldn't start</span>
            <button
              type="button"
              className="btn-primary"
              onClick={() => {
                setFailed(false);
                setCanvasKey((k) => k + 1);
                setTries((t) => t + 1);
              }}
            >
              再試 Try again
            </button>
          </div>
        </div>
      )}
    </>
  );
}
