// A felt drawn as Play's table is (see TableGL): Play's WebGL tiles on a
// canvas over a felt the page lays out and tips back, so the Dice tab's
// tiles are Play's own - the same blocks, light and motion. The felt is
// `feltRef`; its parent, the stage, gives the perspective and holds the
// canvas. `scene` lays the tiles out on the felt (in its own px) and is
// called whenever `look` changes (and on a resize); the engine keeps each
// animation going by its key.
//
// Loaded on its own, with three.js (see DiceTableGL).

import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { Engine, type Frame } from "./engine";
import { readFrame } from "./frame";
import type { Card, Piece, Quad } from "./layout";
import { sharedAtlas, type Atlas } from "./textures";
import type { DieItem } from "./dice";

export interface FeltScene {
  pieces: Piece[];
  quads: Quad[];
  // Its dice (see dice.ts).
  dice?: DieItem[];
  // What stands on it besides its tiles - its players' name cards and the
  // dealer's disc - and the cards' faces (see cards.ts).
  props?: Record<string, Card[]>;
  cardFaces?: HTMLCanvasElement;
}

// The canvas runs past the stage at its top (see .felt-gl's CSS), so a thing
// lifted off the felt's far edge - a plaque picked up, a die in the air -
// isn't cut off there: the frame, read against the stage, moved into the
// canvas's own px.
function bled(f: Frame, canvas: HTMLCanvasElement): Frame {
  const [dx, dy] = [-canvas.offsetLeft, -canvas.offsetTop];
  const felt = new DOMMatrix().translate(dx, dy).multiply(DOMMatrix.fromFloat32Array(Float32Array.from(f.felt)));
  return {
    ...f,
    width: canvas.clientWidth,
    height: canvas.clientHeight,
    felt: Array.from(felt.toFloat32Array()),
    stage: { ...f.stage, ox: f.stage.ox + dx, oy: f.stage.oy + dy },
  };
}

// A canvas whose context has been given back (React's dev double mount):
// a new one is made rather than used again.
const spent = new WeakSet<HTMLCanvasElement>();

// `look`: what's on the table, in a word - drawn again only when it changes
// (the page round it re-renders far more often: a die tumbling in the tray).
export function FeltGL({ feltRef, scene, look }: { feltRef: RefObject<HTMLElement | null>; scene: (feltW: number, feltH: number) => FeltScene; look: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engine = useRef<Engine | null>(null);
  const [atlas, setAtlas] = useState<Atlas | null>(null);
  const [canvasKey, setCanvasKey] = useState(0);
  const sceneRef = useRef(scene);
  sceneRef.current = scene;

  useEffect(() => {
    let live = true;
    sharedAtlas().then(
      (a) => live && setAtlas(a),
      (err: unknown) => console.error("Dice table: no tile faces", err)
    );
    return () => {
      live = false;
    };
  }, []);

  const draw = useRef(() => {
    const e = engine.current;
    const felt = feltRef.current;
    const canvas = canvasRef.current;
    const root = canvas?.parentElement;
    if (!e || !felt || !canvas || !root) return;
    e.frame(bled(readFrame(root, felt), canvas), Math.min(3, window.devicePixelRatio || 1));
    const s = sceneRef.current(felt.offsetWidth, felt.offsetHeight);
    e.show({ felt: s, hand: { pieces: [], quads: [], width: 0, height: 0 }, middle: { x: 0, y: 0 } });
    e.render();
  });
  useLayoutEffect(() => draw.current(), [look]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const felt = feltRef.current;
    if (!atlas || !canvas || !felt) return;
    if (spent.has(canvas)) {
      setCanvasKey((k) => k + 1);
      return;
    }
    let e: Engine;
    try {
      e = new Engine(canvas, atlas);
    } catch (err) {
      // No WebGL: the felt stays bare.
      console.error("Dice table couldn't start", err);
      spent.add(canvas);
      return;
    }
    engine.current = e;
    if (import.meta.env.DEV) (window as unknown as { __feltGL: Engine }).__feltGL = e;
    draw.current();
    const watch = new ResizeObserver(() => draw.current());
    [canvas.parentElement, felt].forEach((el) => el && watch.observe(el));
    // As Play's table: iOS drops the context when the app's put away - kept
    // restorable and drawn again once it's back.
    const lost = (ev: Event) => ev.preventDefault();
    let again = 0;
    const restored = () => {
      draw.current();
      cancelAnimationFrame(again);
      again = requestAnimationFrame(() => draw.current());
    };
    const back = () => document.visibilityState === "visible" && draw.current();
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
  }, [atlas, canvasKey, feltRef]);

  return <canvas key={canvasKey} ref={canvasRef} className="felt-gl" aria-hidden="true" />;
}
