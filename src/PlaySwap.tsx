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
              <TileGlyphSpan tile={t} block />
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
        className="play-call is-win is-long"
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
      <button type="button" className="play-call is-win is-long" onClick={quickTake} aria-label={`Take ${count} evenly, blind`}>
        攞牌
      </button>
    );
  return (
    <>
      <button type="button" className="play-call is-pass is-minor" onClick={() => setPicks(() => [[], [], [], []])} aria-label="Clear your picks">
        ↺
      </button>
      <button
        type="button"
        className={`play-call is-long${check.ok && !check.warning ? " is-win" : ""}${check.warning ? " is-warn" : ""}`}
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

// A tile on its way from a pile to the hand that took it: lifted, then
// flown to that seat, shrinking into the hand - face up if it's one of
// yours, else face down. Drawn flat over the table, from where it lay
// (`from`, on screen) by (dx, dy), after `delay`.
export interface Flight {
  id: number;
  seat: number; // whose pile it left, and its place there - where it's
  place: number; // drawn until it sets off
  tile: Tile | null; // null: face down - not yours to see
  ghost?: boolean; // the round's last take - its pile drawn from the ghost
  from: { left: number; top: number; width: number };
  dx: number;
  dy: number;
  delay: number;
}

// How long a flight takes (as .play-swap-flight's animation), and the
// wait between one tile of a take setting off and the next.
export const SWAP_FLIGHT_MS = 600;
export const SWAP_STAGGER_MS = 300;
// From a take to its last tile landing.
export const takeFlightMs = (tiles: number) => SWAP_FLIGHT_MS + Math.max(0, tiles - 1) * SWAP_STAGGER_MS;

export function SwapFlight({ flight, onStart, onDone }: { flight: Flight; onStart: () => void; onDone: () => void }) {
  // Gone when it lands - or, should the animation's end never come (a page
  // in the background holds animations), soon after it should have.
  useEffect(() => {
    const id = window.setTimeout(onDone, flight.delay + SWAP_FLIGHT_MS + 400);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <span
      className="play-swap-flight"
      style={
        {
          left: flight.from.left,
          top: flight.from.top,
          fontSize: flight.from.width / 0.74,
          "--dx": `${flight.dx}px`,
          "--dy": `${flight.dy}px`,
          animationDelay: `${flight.delay}ms`,
        } as CSSProperties
      }
      onAnimationStart={onStart}
      onAnimationEnd={onDone}
      aria-hidden="true"
    >
      {flight.tile ? <TileGlyphSpan tile={flight.tile} /> : <span className="play-swap-flight-back" />}
    </span>
  );
}
