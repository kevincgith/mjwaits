// A felt drawn as Play's table is (see TableGL): Play's WebGL tiles on a
// canvas over a felt the page lays out and tips back, so the Dice tab's
// tiles are Play's own - the same blocks, light and motion. The felt is
// `feltRef`; its parent, the stage, gives the perspective and holds the
// canvas. `scene` lays the tiles out on the felt (in its own px) and is
// called on every render (cheap: the engine keeps each animation going by
// its key).
//
// Loaded on its own, with three.js (see DiceTableGL).

import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { Engine } from "./engine";
import { readFrame } from "./frame";
import type { Piece, Quad } from "./layout";
import { sharedAtlas, type Atlas } from "./textures";

export interface FeltScene {
  pieces: Piece[];
  quads: Quad[];
}

// A canvas whose context has been given back (React's dev double mount):
// a new one is made rather than used again.
const spent = new WeakSet<HTMLCanvasElement>();

export function FeltGL({ feltRef, scene }: { feltRef: RefObject<HTMLElement | null>; scene: (feltW: number, feltH: number) => FeltScene }) {
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
    const root = canvasRef.current?.parentElement;
    if (!e || !felt || !root) return;
    e.frame(readFrame(root, felt), Math.min(3, window.devicePixelRatio || 1));
    const s = sceneRef.current(felt.offsetWidth, felt.offsetHeight);
    e.show({ felt: s, hand: { pieces: [], quads: [], width: 0, height: 0 }, middle: { x: 0, y: 0 } });
    e.render();
  });
  // Every render: what's on the table may have changed.
  useLayoutEffect(() => draw.current());

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
