// Reading a table's felt (and your row) off the page, for the engine: where
// they sit in the canvas over them, and the perspectives they're seen
// through. Shared by Play's table (TableGL) and the Dice tab's (FeltGL).

import type { Frame } from "./engine";

// An element's layout box within `root` (its offsets - transforms aside).
export function offsetIn(el: HTMLElement, root: HTMLElement): { x: number; y: number } {
  let x = 0;
  let y = 0;
  for (let e: HTMLElement | null = el; e && e !== root; e = e.offsetParent as HTMLElement | null) {
    x += e.offsetLeft;
    y += e.offsetTop;
  }
  return { x, y };
}

// Where the felt and your row sit in the canvas (which covers `root`), and
// the perspectives they're seen through. (No row: a table with only a felt.)
export function readFrame(root: HTMLElement, felt: HTMLElement, hand: HTMLElement | null = null): Frame {
  const stage = felt.parentElement!;
  const fs = getComputedStyle(felt);
  const ss = getComputedStyle(stage);
  const hs = hand ? getComputedStyle(hand) : null;
  const pair = (v: string) => v.split(" ").map(parseFloat);
  const [tox, toy] = pair(fs.transformOrigin);
  const fo = offsetIn(felt, root);
  const tilt = new DOMMatrix(fs.transform === "none" ? undefined : fs.transform);
  const felted = new DOMMatrix().translate(fo.x + tox, fo.y + toy).multiply(tilt).translate(-tox, -toy);
  const so = offsetIn(stage, root);
  const [sox, soy] = pair(ss.perspectiveOrigin);
  const ho = hand ? offsetIn(hand, root) : { x: 0, y: 0 };
  const [hox, hoy] = hs ? pair(hs.perspectiveOrigin) : [0, 0];
  return {
    width: root.clientWidth,
    height: root.clientHeight,
    felt: Array.from(felted.toFloat32Array()),
    stage: { d: parseFloat(ss.perspective) || 1100, ox: so.x + sox, oy: so.y + soy },
    hand: { x: ho.x, y: ho.y, d: (hs && parseFloat(hs.perspective)) || 1100, ox: ho.x + hox, oy: ho.y + hoy },
  };
}

