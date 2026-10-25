// 換牌 at the Play table (the rules: shared/engine/swap.ts): the dealer's
// two dice over the middle of the table; each seat's face-down pile on the
// felt where its discards go, which you tap to take from; the swap's line in
// the bar under the table, with your buttons; and the sheet that sets which
// rounds swap and what the dice mean.

import { type CSSProperties, useEffect, useRef, useState } from "react";
import {
  blindPicks,
  botSplit,
  checkTake,
  DEFAULT_SWAP_RULES,
  pileLeft,
  SWAP_MAX_ROUNDS,
  SWAP_MAX_TILES,
  SWAP_MIN_TILES,
  type Pile,
  type SwapPhase,
  type SwapRules,
} from "@mjwaits/shared/engine/swap";
import type { Wind } from "@mjwaits/shared/engine/scoring";
import { PlayDie } from "./PlayDie";
import { TileGlyphSpan, TileSides } from "./TileGlyphs";
import { tileLabel, type Tile } from "@mjwaits/shared/engine/mahjong";

const WIND_CHARS = ["", "東", "南", "西", "北"];

// A seat's pile, on the felt where its discards go: real 3D blocks like
// every other tile on the table, laid as that seat's tiles lie - across the
// table in a row, the side seats' along their side - so their depth is
// drawn from where you sit. The others' lie face down; yours stand up
// facing you, as at a real table - and a tile taken from yours flies to
// the player who took it (SwapFlight), so you see who took what. A tile
// taken leaves its place empty; the rest don't move. Tappable (`onPick`)
// only on your take, and never your own pile.
// A waiting tile whose face isn't yours to see.
const HELD_BACK: Tile = { suit: "j", rank: 0 };

export function SwapPond({
  pile,
  side,
  count,
  picked,
  onPick,
  standing,
  held,
}: {
  pile: Pile | null;
  side: "top" | "left" | "right" | "bottom";
  count: number;
  picked: number[];
  onPick: ((i: number) => void) | null;
  standing: boolean;
  // Tiles taken but still waiting their turn to fly: drawn where they lay
  // until they set off (place -> the tile, or null face down).
  held: Map<number, Tile | null>; // yours: stood up facing you, so you see what goes where
}) {
  if (!pile) return null;
  return (
    <div
      className={`play-pond play-pond-${side} play-swap-pond${onPick ? " is-pickable" : ""}${standing ? " is-standing" : ""}`}
      style={{ "--n": count } as CSSProperties}
    >
      {pile.map((slot, i) => {
        const t = slot ?? (held.has(i) ? (held.get(i) ?? HELD_BACK) : null);
        return (
          <span
            key={i}
            className={["play-swap-tile", !t && "is-gap", picked.includes(i) && "is-picked"].filter(Boolean).join(" ")}
            role={onPick && slot ? "button" : undefined}
            aria-pressed={onPick && slot ? picked.includes(i) : undefined}
            aria-label={t ? (standing ? `Your ${tileLabel(t)}` : `Face-down tile ${i + 1}`) : "Taken"}
            onClick={onPick && slot ? () => onPick(i) : undefined}
          >
            {t && t !== HELD_BACK && standing ? (
              // Drawn as finely as your hand's - it stands like them.
              <TileGlyphSpan tile={t} block="fine" />
            ) : (
              <span className="play-back">
                <i className="tile-top" />
                <TileSides />
              </span>
            )}
          </span>
        );
      })}
    </div>
  );
}

// The dealer's two dice, tumbling one then the other, over the middle of
// the table - then what they mean.
export function SwapDice({ phase }: { phase: SwapPhase }) {
  return (
    <div className="play-dice play-swap-dice-roll" role="status">
      <div className="play-dice-row">
        <PlayDie value={phase.dice[0]} rolling index={0} />
        <PlayDie value={phase.dice[1]} rolling index={1} delay={650} />
      </div>
      <span className="play-dice-caption play-swap-sum">
        換牌 · {phase.rounds} round{phase.rounds === 1 ? "" : "s"} · {phase.count} tiles each
      </span>
    </div>
  );
}

// The swap's controls: its line in the bar under the table (the round,
// what's happening - `part` "bar"), and your buttons ("actions") in the
// calls corner like 上 碰 槓: give; take what you've tapped, or take evenly
// in one tap. `picks`: the places you've tapped in
// each pile; `after`: who takes after the one taking now.
export function SwapControls({
  part,
  phase,
  nameOf,
  seated,
  picks,
  setPicks,
  after,
  giveCount,
  onGive,
  onTake,
}: {
  part: "bar" | "actions";
  phase: SwapPhase;
  nameOf: (seat: number) => string;
  seated: boolean;
  picks: number[][];
  setPicks: (update: (p: number[][]) => number[][]) => void;
  after: number[];
  giveCount: number; // tiles you've picked from your hand to give
  onGive: () => void;
  onTake: (picks?: number[][]) => void;
}) {
  const { rounds, count, round, stage, piles, taker } = phase;
  const mineToGive = seated && stage === "give" && !piles[0];
  const myTake = seated && stage === "take" && taker === 0;
  const sizes = piles.map(pileLeft);
  const split = picks.map((p) => p.length);
  const taken = split.reduce((a, b) => a + b, 0);
  const check = myTake ? checkTake(sizes, 0, after, count, split) : null;
  // One tap: an even take (the fairest there is), blind picks from each.
  const quickTake = () => {
    const even = botSplit(sizes, 0, after, count);
    onTake(piles.map((p, g) => blindPicks(p!, even[g])));
  };
  let note: string;
  let tone = "";
  if (mineToGive) note = giveCount === count ? `Your loneliest ${count}, picked - tap to change` : `Tap ${count} tiles to give · ${giveCount}/${count}`;
  else if (stage === "give") note = "Everyone lays tiles face down";
  else if (!myTake) note = `${nameOf(taker)} is taking`;
  else if (taken === 0) note = `Take ${count} - at least one from each`;
  else {
    note = `${[3, 2, 1].map((g) => split[g]).join("·")} (${taken}/${count})`;
    if (taken === count && check) {
      if (check.error ?? check.warning) note += ` - ${check.error ?? check.warning}`;
      tone = check.ok ? (check.warning ? " is-warn" : " is-ok") : " is-error";
    }
  }
  if (part === "bar")
    return (
      <span className="play-swap-bar">
        <b>
          換牌 {round}/{rounds}
        </b>
        <span className={`play-swap-note${tone}`}>{note}</span>
      </span>
    );
  // Your buttons: discs in the calls corner, like 上 碰 槓 - where your moves
  // always are.
  if (!mineToGive && !myTake) return null;
  if (mineToGive)
    return (
      <button
        type="button"
        className="play-call is-swap is-win is-long"
        disabled={giveCount !== count}
        onClick={onGive}
        aria-label={giveCount === count ? `Give these ${count}` : `Pick ${count} tiles to give`}
      >
        放牌
      </button>
    );
  if (!check) return null;
  if (taken === 0)
    return (
      <button type="button" className="play-call is-swap is-win is-long" onClick={quickTake} aria-label={`Take ${count} evenly, blind`}>
        攞牌
      </button>
    );
  return (
    <>
      <button type="button" className="play-call is-swap is-pass is-minor" onClick={() => setPicks(() => [[], [], [], []])} aria-label="Clear your picks">
        ↺
      </button>
      <button
        type="button"
        className={`play-call is-swap is-long${check.ok && !check.warning ? " is-win" : ""}${check.warning ? " is-warn" : ""}`}
        disabled={!check.ok}
        onClick={() => onTake()}
        aria-label={check.error ?? check.warning ?? `Take these ${taken}`}
      >
        {check.warning ? "照攞" : `攞 ${taken}/${count}`}
      </button>
    </>
  );
}

// The settings: which round winds swap, and what each die means.
export function SwapSheet({ rules, onChange, onClose }: { rules: SwapRules; onChange: (r: SwapRules) => void; onClose: () => void }) {
  const [r, setR] = useState(rules);
  // Each change from the settings as they stand (not as last drawn), so
  // quick taps don't undo each other.
  const latest = useRef(rules);
  const update = (change: (r: SwapRules) => SwapRules) => {
    const next = change(latest.current);
    latest.current = next;
    setR(next);
    onChange(next);
  };
  const set = (next: SwapRules) => update(() => next);
  const toggleWind = (w: Wind) => update((r) => ({ ...r, winds: r.winds.includes(w) ? r.winds.filter((x) => x !== w) : ([...r.winds, w].sort() as Wind[]) }));
  const mapRow = (key: "rounds" | "tiles", lo: number, hi: number, unit: string) => (
    <div className="play-swap-map">
      {r[key].map((v, i) => (
        <label key={i} className="play-swap-map-cell">
          <PlayDie value={i + 1} rolling={false} index={0} />
          <select
            value={v}
            aria-label={`Die ${i + 1}: ${unit}`}
            onChange={(e) => {
              const n = Number(e.target.value);
              update((r) => ({ ...r, [key]: r[key].map((x, j) => (j === i ? n : x)) }));
            }}
          >
            {Array.from({ length: hi - lo + 1 }, (_, k) => lo + k).map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
      ))}
    </div>
  );
  return (
    <div className="play-sheet-backdrop" onClick={onClose}>
      <div className="play-sheet play-swap-sheet" role="dialog" aria-label="Swap tiles" onClick={(e) => e.stopPropagation()}>
        <div className="play-sheet-head">
          <h2>換牌 Swap tiles</h2>
          <span>From the next hand dealt</span>
          <button type="button" className="play-sheet-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <p className="play-swap-note">
          Everyone is dealt 16 and the dealer throws two dice: the first says how many swap rounds, the second how many tiles. Each round everyone lays that many
          face down, then from the dealer round the table each takes as many back from the others&apos; piles - at least one from each, as evenly as it goes.
        </p>
        <h3>Rounds that swap</h3>
        <div className="play-swap-winds">
          {([1, 2, 3, 4] as Wind[]).map((w) => (
            <button key={w} type="button" className={r.winds.includes(w) ? "toggle-on" : undefined} aria-pressed={r.winds.includes(w)} onClick={() => toggleWind(w)}>
              {WIND_CHARS[w]}圈
            </button>
          ))}
        </div>
        <h3>First die: swap rounds</h3>
        {mapRow("rounds", 1, SWAP_MAX_ROUNDS, "swap rounds")}
        <h3>Second die: tiles each</h3>
        {mapRow("tiles", SWAP_MIN_TILES, SWAP_MAX_TILES, "tiles each")}
        <button type="button" className="play-swap-reset" onClick={() => set(DEFAULT_SWAP_RULES)}>
          Back to the usual (南 北 · 1-2-3 rounds · 3-3-3-4-5-6 tiles)
        </button>
      </div>
    </div>
  );
}

// A taken tile, flown from its pile to its place in the row by the
// taker's hand, and left there till the round's over - face up if it's
// yours to see, else face down. Drawn flat over the table, from where it
// lay (`from`, on screen) by (dx, dy), after `delay`.
export interface Flight {
  id: number;
  to: number; // the seat whose hand it's flying to
  real: Tile; // what it is - joining that hand as it lands
  seat: number; // whose pile it left, and its place there - where it's
  place: number; // drawn until it sets off
  tile: Tile | null; // null: face down - not yours to see
  ghost?: boolean; // the round's last take - its pile drawn from the ghost
  from: { left: number; top: number; width: number };
  // Where it goes, sampled evenly over the flight: offsets from where it
  // started (px) and its turn on the table (deg) - see flightPath.
  path: { x: number; y: number; r: number; s: number }[];
  delay: number;
}

// Eased progress: speeding up once, slowing once.
const ease = (u: number) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);
const turnBy = (x: number, y: number, deg: number) => {
  const a = (deg * Math.PI) / 180;
  return { x: x * Math.cos(a) - y * Math.sin(a), y: x * Math.sin(a) + y * Math.cos(a) };
};

// One giver's tiles in a take move as one formation: its middle glides from
// the pile to the row while the formation turns about it - from the way the
// tiles lay (a side seat's sideways) to the way the row runs - each tile
// sliding along the formation from its place in the pile to its place in
// the row. So the tiles follow their true arcs and stay in order, a tile
// apart: they can't touch. (Straight lines would cut the corner of a turn
// and run them into each other.)
// Each starts at the size its pile's tile shows on screen (`sizes`, a
// fraction of its own) and grows to its own as it lands - its formation
// opening up in step, so the gaps keep pace.
// `starts`/`ends`: each tile's centre on screen, leaving and landing;
// `turnFrom`/`turnTo`: how the tiles lie, leaving and landing (deg).
export function flightPath(
  starts: { x: number; y: number }[],
  ends: { x: number; y: number }[],
  turnFrom: number,
  turnTo: number,
  sizes: number[] = starts.map(() => 1),
  samples = 24
) {
  const mean = (ps: { x: number; y: number }[]) => ({ x: ps.reduce((t, p) => t + p.x, 0) / ps.length, y: ps.reduce((t, p) => t + p.y, 0) / ps.length });
  const c0 = mean(starts);
  const c1 = mean(ends);
  let turn = turnTo - turnFrom;
  if (turn > 180) turn -= 360;
  if (turn <= -180) turn += 360;
  return starts.map((start, i) => {
    // Its place in the formation, leaving and landing - the landing one
    // turned back into the formation's own frame.
    const os = { x: start.x - c0.x, y: start.y - c0.y };
    const oe = turnBy(ends[i].x - c1.x, ends[i].y - c1.y, -turn);
    return Array.from({ length: samples + 1 }, (_, k) => {
      const e = ease(k / samples);
      const o = turnBy(os.x + (oe.x - os.x) * e, os.y + (oe.y - os.y) * e, turn * e);
      return { x: c0.x + (c1.x - c0.x) * e + o.x - start.x, y: c0.y + (c1.y - c0.y) * e + o.y - start.y, r: turnFrom + turn * e, s: sizes[i] + (1 - sizes[i]) * e };
    });
  });
}

// How long a take's flight takes (all its tiles go together), and how long the round's rows stay once its last
// take is down, before every tile joins its hand.
export const SWAP_FLIGHT_MS = 600;
export const SWAP_ROUND_HOLD_MS = 1400;

export function SwapFlight({ flight, onStart, onLanded }: { flight: Flight; onStart: () => void; onLanded: () => void }) {
  const ref = useRef<HTMLSpanElement>(null);
  // Flown along its path; down when it lands - or, should the animation's
  // end never come (a page in the background holds animations), soon after
  // it should have. It stays in its row till the round's over (PlayPanel
  // clears them).
  useEffect(() => {
    const quick = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const anim = ref.current?.animate(
      flight.path.map((p) => ({ transform: `translate(${p.x}px, ${p.y}px) rotate(${p.r}deg) scale(${p.s})`, visibility: "visible" })),
      { duration: quick ? 1 : SWAP_FLIGHT_MS, delay: flight.delay, easing: "linear", fill: "forwards" }
    );
    const off = window.setTimeout(onStart, flight.delay);
    const down = window.setTimeout(onLanded, flight.delay + SWAP_FLIGHT_MS + 300);
    anim?.finished.then(onLanded, () => {});
    return () => {
      window.clearTimeout(off);
      window.clearTimeout(down);
      // One flight per tile: a second run of this effect (React may run it
      // twice) mustn't leave the first still playing underneath.
      anim?.cancel();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <span
      ref={ref}
      className="play-swap-flight"
      style={{ left: flight.from.left, top: flight.from.top, fontSize: flight.from.width / 0.74 }}
      aria-hidden="true"
      data-to={flight.to}
      data-from={flight.seat}
    >
      {flight.tile ? <TileGlyphSpan tile={flight.tile} /> : <span className="play-swap-flight-back" />}
    </span>
  );
}
