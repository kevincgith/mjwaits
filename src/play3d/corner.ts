// An observer's free view of the table: turned and laid back as the camera
// says, starting from a chair at the corner between two players. Each seat is laid out the
// same way - its standing hand at its edge, its melds and bonus tiles in front,
// its pond by the compass - in its own frame (the table's centre at the origin,
// +y toward its player), then turned round to its side of a square table.
//
// Every hand is real tiles, faces looking outward to its player. So whichever
// seats the camera is behind show their faces, and the far ones only their
// backs - as they would to anyone sitting there.

import { sameTile } from "@mjwaits/shared/engine/game";
import { sortTiles } from "@mjwaits/shared/engine/mahjong";
import { bezier, EASE_OUT, keyframes } from "./anim";
import { BACK, bubbleBox, faceOf, flowerGroup, LIT, lying, lyingDown, meldGroup, placeGroup, shadowAt, THICK, TILE_H, TILE_W, TURNED, UNSEEN, wallFaces, type Anim, type Dims, type Group, type Layout, type Piece, type Quad } from "./layout";
import { chain, rotateX, rotateZ, scale, translate, type Mat } from "./mat";
import { CORNER_TILT, type CornerCamera, type GLSide, type GLTableView, type GLWall } from "./types";

// How each seat's frame is turned onto the table.
const TURN: Record<GLSide, number> = { bottom: 0, right: -90, top: 180, left: 90 };
const POND_ROW = 6;
const sum = (ns: number[]) => ns.reduce((a, b) => a + b, 0);

// How much smaller the table's drawn for this camera: the felt is sized for
// the starting view, and only a flatter look down at it takes more of the
// screen's height than that.
export function cornerZoom({ yaw, tilt }: CornerCamera): number {
  const rad = (deg: number) => (deg * Math.PI) / 180;
  const across = (y: number) => Math.abs(Math.cos(rad(y))) + Math.abs(Math.sin(rad(y)));
  return Math.min(1, (across(45) * Math.cos(rad(CORNER_TILT))) / (across(yaw) * Math.cos(rad(tilt))));
}

// A hand's faces as they stand (a drawn tile last, set apart).
function standingFaces(w: GLWall): { faces: string[]; apart: boolean } {
  if (!w.tiles) return { faces: Array<string>(w.count).fill(UNSEEN), apart: w.drew };
  const rest = w.tiles.slice();
  const at = w.drawnTile ? rest.findIndex((t) => sameTile(t, w.drawnTile!)) : -1;
  const drawn = at >= 0 ? rest.splice(at, 1)[0] : null;
  return { faces: [...sortTiles(rest), ...(drawn ? [drawn] : [])].map(faceOf), apart: !!drawn };
}

export function layoutCorner(view: GLTableView, d: Dims, camera: CornerCamera): Layout {
  const pieces: Piece[] = [];
  const quads: Quad[] = [];
  const S = d.feltW;
  const middle = { x: S / 2, y: S / 2 };
  // Tile sizes: a full hand (17) just clears the next seat's row.
  const H = 0.066 * S;
  const T = 0.8 * H;
  const P = 0.95 * T;
  const pondW = POND_ROW * 0.74 * P;
  const pondFrom = Math.max(d.compass / 2, pondW / 2) + 0.25 * P;
  // The foot of a standing row, in from the table's edge.
  const foot = S / 2 - 0.035 * S - THICK * H;
  const meldY = foot - 0.25 * H - 0.54 * T;

  for (const side of ["top", "left", "right", "bottom"] as const) {
    const w = side === "bottom" ? view.corner!.bottom : view.walls[side];
    const shade: [number, number] = side === "left" || side === "right" ? TURNED : LIT;
    const seat = chain(translate(middle.x, middle.y, 0), rotateZ(TURN[side]));
    const mine: Piece[] = [];
    const marks: Quad[] = [];

    // The hand.
    if (w.down && w.tiles) {
      const { faces, win } = wallFaces(w);
      const pitch = TILE_W * H;
      const gap = win >= 0 ? 0.3 * H : 0;
      const x0 = -(faces.length * pitch + gap) / 2;
      faces.forEach((face, i) => {
        const x = x0 + (i + 0.5) * pitch + (i === win ? gap : 0);
        mine.push({ face, m: lying(x, foot, H), shade: LIT, tint: 1 });
        marks.push(shadowAt(x, foot, H));
      });
    } else {
      const { faces, apart } = standingFaces(w);
      const pitch = TILE_W * H;
      const gap = apart ? 0.3 * H : 0;
      const x0 = -(faces.length * pitch + gap) / 2;
      faces.forEach((face, i) => {
        const x = x0 + (i + 0.5) * pitch + (apart && i === faces.length - 1 ? gap : 0);
        mine.push({ face, m: chain(translate(x, foot, 0), rotateX(-90), translate(0, (-TILE_H / 2) * H, 0), scale(H)), shade: LIT, tint: 1 });
      });
    }

    // In front of it: the bonus tiles, then the melds, centred.
    const flowers = flowerGroup(w.flowers, T);
    const groups: Group[] = [...(flowers ? [flowers] : []), ...w.melds.map((m) => meldGroup(m, w.hideConcealed, false, T))];
    const gap = 0.15 * T;
    let x = -(sum(groups.map((g) => g.along)) + gap * Math.max(0, groups.length - 1)) / 2;
    for (const g of groups) {
      const from = x + g.pad;
      placeGroup(g, (k) => [from + TILE_W * g.em * (k + 0.5), meldY], 0, shade, mine, marks);
      x += g.along + gap;
    }

    // The pond, or - in 換牌 - the pile laid there, face down.
    const pond = view.ponds[side];
    const pile = view.piles?.[side];
    if (pile) {
      const em = 1.1 * P;
      const pitch = 0.84 * em;
      pile.slots.forEach((slot, i) => {
        if (!slot) return;
        const px = ((1 - pile.slots.length) / 2 + i) * pitch;
        mine.push({ face: BACK, m: lyingDown(px, pondFrom + 0.5 * em, em), shade, tint: 1 });
        marks.push(shadowAt(px, pondFrom + 0.5 * em, em));
      });
    } else if (pond.tiles.length) {
      const step = (i: number) => (i === pond.riichiAt ? 0.95 : 0.74) * P;
      const lines: number[][] = [[]];
      let len = 0;
      pond.tiles.forEach((_, i) => {
        if (len + step(i) > pondW + 0.01 && lines[lines.length - 1].length) {
          lines.push([]);
          len = 0;
        }
        lines[lines.length - 1].push(i);
        len += step(i);
      });
      const depth = 0.93 * P;
      const room = meldY - 0.54 * T - pondFrom - 3;
      const fit = Math.max(0.5, Math.min(1, room / (lines.length * depth)));
      const em = P * fit;
      pond.tiles.forEach((t, i) => {
        const r = lines.findIndex((l) => l.includes(i));
        const before = sum(lines[r].filter((j) => j < i).map(step));
        const riichi = i === pond.riichiAt;
        const lean = riichi ? ((TILE_H - TILE_W) / 2) * P : 0;
        const px = (-pondW / 2 + before + step(i) / 2) * fit;
        const py = pondFrom + ((r + 0.5) * depth - lean) * fit;
        const rot = riichi ? 90 : 0;
        const m = lying(px, py, em, rot);
        const last = pond.pinLast && i === pond.tiles.length - 1;
        const anim: Anim | undefined = last
          ? {
              key: `corner:${side}:drop:${i}`,
              delay: 0,
              dur: 0.36,
              pose: (k) => chain(translate(0, 0, keyframes([{ at: 0, v: [1.4 * em], ease: bezier(0.5, 0, 0.9, 0.6) }, { at: 0.72, v: [0] }, { at: 1, v: [0] }], k)[0]), m),
            }
          : undefined;
        mine.push({ face: faceOf(t), m, shade, tint: 1, anim });
        marks.push(shadowAt(px, py, em, rot));
        if (last) marks.push({ kind: "pin", m: chain(translate(px, py + (riichi ? 0.39 : 0.5) * em + 0.075 * em, THICK * em * 0.5), scale(0.3 * em, 0.15 * em, 1)) });
      });
    }

    const placed = (m: Mat) => chain(seat, m);
    for (const p of mine) pieces.push({ ...p, m: placed(p.m), anim: p.anim && { ...p.anim, pose: (k) => placed(p.anim!.pose(k)) } });
    for (const q of marks) quads.push({ ...q, m: placed(q.m), anim: q.anim && { ...q.anim, pose: (k) => placed(q.anim!.pose(k)) } });
  }

  // The discard up for grabs, in its bubble as on the usual table: held up
  // over the table on its thrower's side, squarely facing the camera, its
  // tail pointing the way the thrower is on the screen.
  if (view.spotlight) {
    const { from, tile, key } = view.spotlight;
    const { te, bw, bh, em } = bubbleBox(d);
    const r = d.compass / 2 + 0.35 * bh;
    const [dx, dy] = from === "bottom" ? [0, 1] : from === "right" ? [1, 0] : from === "top" ? [0, -1] : [-1, 0];
    const yaw = (camera.yaw * Math.PI) / 180;
    const sx = dx * Math.cos(yaw) - dy * Math.sin(yaw);
    const sy = dx * Math.sin(yaw) + dy * Math.cos(yaw);
    const tail = Math.abs(sx) > Math.abs(sy) ? (sx > 0 ? "right" : "left") : sy > 0 ? "bottom" : "top";
    // Its foot, facing the camera - popped in from half size.
    const stand = (s: number) => chain(translate(middle.x + dx * r, middle.y + dy * r, 0.5 * bh + 0.4 * em), rotateZ(-camera.yaw), rotateX(-camera.tilt), translate(0, bh / 2, 0), scale(s, s, 1));
    const bubble = (s: number) => chain(stand(s), translate(0, -bh / 2, 0), scale(bw + 2 * em, bh + 2 * em, 1));
    // The tile in it, tipped back from its foot to show its thickness.
    const held = (s: number) => chain(stand(s), translate(0, -0.38 * em, 0), translate(0, 0, 0.55 * te), rotateX(30), translate(0, -0.5 * te, 0), scale(te));
    const pop = (pose: (s: number) => Mat, part: string): Anim => ({ key: `spot:${key}:${part}`, delay: 0, dur: 0.22, pose: (k) => pose(0.5 + 0.5 * EASE_OUT(k)) });
    quads.push({ kind: `bubble-${tail}`, m: bubble(1), anim: pop(bubble, "bubble") });
    pieces.push({ face: faceOf(tile), m: held(1), shade: LIT, tint: 1, anim: pop(held, "tile") });
  }

  return { felt: { pieces, quads }, hand: { pieces: [], quads: [], width: 0, height: 0 }, middle };
}
