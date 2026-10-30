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
  arriving,
}: {
  pile: Pile | null;
  side: "top" | "left" | "right" | "bottom";
  count: number;
  picked: number[];
  onPick: ((i: number) => void) | null;
  standing: boolean;
  // Tiles taken but still waiting their turn to fly: drawn where they lay
  // until they set off (place -> the tile, or null face down).
  held: Map<number, Tile | null>;
  // Yours, just given: places whose tile is still on its way down from your hand.
  arriving?: Set<number>; // yours: stood up facing you, so you see what goes where
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
            className={["play-swap-tile", !t && "is-gap", picked.includes(i) && "is-picked", arriving?.has(i) && "is-arriving"].filter(Boolean).join(" ")}
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

// The dealer's two dice, over the middle of the table: thrown one at a
// time, as at a real table - the first tumbles in and says how many swap
// rounds, then the second, how many tiles each - and held a moment.
// `factor`: the table's speed (fast plays it quicker).
const DIE_GAP_MS = 1300; // the first throw to the second
const DIE_SAY_MS = 800; // a throw to what it means
export const swapDiceMs = (factor: number) => Math.round((DIE_GAP_MS + DIE_SAY_MS + 900) * factor);

export function SwapDice({ phase, factor = 1 }: { phase: SwapPhase; factor?: number }) {
  // 0: the first die in the air; 1: it says its piece; 2: the second in
  // the air; 3: both said.
  const [step, setStep] = useState(0);
  useEffect(() => {
    const at = [DIE_SAY_MS, DIE_GAP_MS, DIE_GAP_MS + DIE_SAY_MS].map((ms) => ms * factor);
    const ids = at.map((ms, i) => window.setTimeout(() => setStep(i + 1), ms));
    return () => ids.forEach((id) => window.clearTimeout(id));
  }, [factor]);
  return (
    <div className="play-dice play-swap-dice-roll" role="status">
      <span className="play-swap-dice-title">換牌</span>
      <div className="play-swap-throws">
        {/* Each die with what it says, big beneath it. */}
        <div className="play-swap-throw">
          <PlayDie value={phase.dice[0]} rolling index={0} />
          <span className={`play-swap-result${step >= 1 ? " is-said" : ""}`}>
            {phase.rounds}
            <small>次</small>
          </span>
          <span className="play-swap-what">{phase.rounds === 1 ? "swap round" : "swap rounds"}</span>
        </div>
        <div className="play-swap-throw">
          {step >= 2 ? <PlayDie value={phase.dice[1]} rolling index={0} /> : <span className="play-die-slot" aria-hidden="true" />}
          <span className={`play-swap-result${step >= 3 ? " is-said" : ""}`}>
            {phase.count}
            <small>隻</small>
          </span>
          <span className="play-swap-what">tiles each</span>
        </div>
      </div>
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
  onClearGive,
  plan,
  onNextPlan,
  onTake,
  settling = false,
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
  onClearGive: () => void;
  // The suggested gives you can step through (see givePlans), and which is picked (null: your own picks).
  plan?: { names: string[]; at: number | null };
  onNextPlan?: () => void;
  settling?: boolean; // the last round's tiles still joining their hands
  onTake: (picks?: number[][]) => void;
}) {
  const { rounds, count, round, stage, piles, taker } = phase;
  const mineToGive = seated && stage === "give" && !piles[0] && !settling;
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
  if (settling) note = "Everyone takes in what they got…";
  else if (mineToGive) {
    const named = plan && plan.at !== null ? `${plan.names[plan.at]} · ` : "";
    note =
      giveCount === count
        ? `${named}${count} picked - ready to give (tap to change)`
        : giveCount > count
          ? `${giveCount} picked - ${giveCount - count} too many`
          : `${giveCount} of ${count} picked - tap ${count - giveCount} more`;
    tone = giveCount === count ? " is-ok" : giveCount > count ? " is-error" : "";
  }
  else if (stage === "give" && !settling) note = "Everyone lays tiles face down";
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
      <>
        {/* Clear: a quiet ✕ - nothing like the suggestions beside it. */}
        {clear(giveCount > 0, onClearGive)}
        {/* The next suggestion (孤張 → 斷么 → 混萬 → ... round again): just ⟳ - the bar names the one picked. */}
        {plan && plan.names.length > 1 && onNextPlan && (
          <button
            key="plan"
            type="button"
            className="play-call is-swap is-plan"
            onClick={onNextPlan}
            aria-label={`Suggest another: ${plan.names[((plan.at ?? -1) + 1) % plan.names.length]}`}
          >
            ⟳
          </button>
        )}
        <button
          key="main"
          type="button"
          className="play-call is-swap is-win is-long"
          disabled={giveCount !== count}
          onClick={onGive}
          aria-label={giveCount === count ? `Give these ${count}` : `${giveCount} of ${count} picked`}
        >
          放牌
          {/* How many you've picked, on the button itself. */}
          <span className={`play-swap-count${giveCount === count ? " is-ok" : giveCount > count ? " is-over" : ""}`}>
            {giveCount}/{count}
          </span>
        </button>
      </>
    );
  if (!check) return null;
  // The same two buttons all the way (one tap takes evenly, blind; with
  // picks, it takes those) - so quick taps never land on one that's just
  // been swapped in, moved, or is still popping up.
  return (
    <>
      {clear(taken > 0, () => setPicks(() => [[], [], [], []]))}
      <button
        key="main"
        type="button"
        className={`play-call is-swap is-long${taken === 0 || (check.ok && !check.warning) ? " is-win" : ""}${taken > 0 && check.warning ? " is-warn" : ""}`}
        disabled={taken > 0 && !check.ok}
        onClick={() => (taken === 0 ? quickTake() : onTake())}
        aria-label={taken === 0 ? `Take ${count} evenly, blind` : (check.error ?? check.warning ?? `Take these ${taken}`)}
      >
        {taken === 0 ? "攞牌" : check.warning ? "照攞" : `攞 ${taken}/${count}`}
      </button>
    </>
  );
}

// Clear your picks: always in its place (unseen, and not to be tapped, with
// nothing to clear), so the buttons beside it never move as you pick.
const clear = (on: boolean, onClick: () => void) => (
  <button
    key="clear"
    type="button"
    className={`play-call is-swap is-clear${on ? "" : " is-idle"}`}
    onClick={onClick}
    disabled={!on}
    aria-hidden={!on}
    tabIndex={on ? undefined : -1}
    aria-label="Clear your picks"
  >
    ✕
  </button>
);

// The settings: which round winds swap, and what each die means.
// The dice's mappings at a stroke - every throw the same at the two ends,
// the usual in between; the rounds that swap left as they are.
export const SWAP_PRESETS: { name: string; label: string; rounds: number[]; tiles: number[] }[] = [
  { name: "Min", label: "1 round · 3 tiles", rounds: [1, 1, 1, 1, 1, 1], tiles: [3, 3, 3, 3, 3, 3] },
  { name: "Usual", label: "1-2-3 rounds · 3-6 tiles", rounds: DEFAULT_SWAP_RULES.rounds, tiles: DEFAULT_SWAP_RULES.tiles },
  { name: "Max", label: "3 rounds · 6 tiles", rounds: [3, 3, 3, 3, 3, 3], tiles: [6, 6, 6, 6, 6, 6] },
];

// The table's 換牌 rules, changed here and kept only on Confirm - closing
// leaves them as they were.
export function SwapSheet({ rules, onChange, onClose }: { rules: SwapRules; onChange: (r: SwapRules) => void; onClose: () => void }) {
  const [r, setR] = useState(rules);
  // Each change from the settings as they stand (not as last drawn), so
  // quick taps don't undo each other.
  const latest = useRef(rules);
  const update = (change: (r: SwapRules) => SwapRules) => {
    const next = change(latest.current);
    latest.current = next;
    setR(next);
  };
  const confirm = () => {
    onChange(latest.current);
    onClose();
  };
  const toggleWind = (w: Wind) => update((r) => ({ ...r, winds: r.winds.includes(w) ? r.winds.filter((x) => x !== w) : ([...r.winds, w].sort() as Wind[]) }));
  const options = (lo: number, hi: number) =>
    Array.from({ length: hi - lo + 1 }, (_, k) => lo + k).map((n) => (
      <option key={n} value={n}>
        {n}
      </option>
    ));
  const mapRow = (key: "rounds" | "tiles", lo: number, hi: number, unit: string) => (
    <div className="play-swap-map">
      {/* Every throw at once: one pick sets all six. */}
      <label className="play-swap-map-cell is-all">
        <span className="play-swap-all">All</span>
        <select
          value={r[key].every((x) => x === r[key][0]) ? r[key][0] : ""}
          aria-label={`Every die: ${unit}`}
          onChange={(e) => {
            const n = Number(e.target.value);
            if (n) update((r) => ({ ...r, [key]: r[key].map(() => n) }));
          }}
        >
          <option value="" disabled>
            –
          </option>
          {options(lo, hi)}
        </select>
      </label>
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
            {options(lo, hi)}
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
        <p className="play-swap-intro">
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
        <h3>Presets</h3>
        <div className="play-swap-presets">
          {SWAP_PRESETS.map((p) => {
            const on = p.rounds.join() === r.rounds.join() && p.tiles.join() === r.tiles.join();
            return (
              <button key={p.name} type="button" className={on ? "toggle-on" : undefined} aria-pressed={on} onClick={() => update((r) => ({ ...r, rounds: p.rounds, tiles: p.tiles }))}>
                <b>{p.name}</b>
                <span>{p.label}</span>
              </button>
            );
          })}
        </div>
        <h3>First die: swap rounds</h3>
        {mapRow("rounds", 1, SWAP_MAX_ROUNDS, "swap rounds")}
        <h3>Second die: tiles each</h3>
        {mapRow("tiles", SWAP_MIN_TILES, SWAP_MAX_TILES, "tiles each")}
        <button type="button" className="play-swap-confirm" onClick={confirm}>
          Confirm
        </button>
      </div>
    </div>
  );
}

// Where things are in the table's own frame - its layout box, before it's
// turned (on a phone held upright the whole table is drawn a quarter turned,
// see .play-screen). The flights are laid out in that frame, so they fly the
// same either way the phone is held.
export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}
export interface Frame {
  point: (x: number, y: number) => { x: number; y: number };
  box: (el: Element) => Box;
}
export function tableFrame(): Frame {
  const table = document.querySelector<HTMLElement>(".play-table");
  let inv = new DOMMatrix();
  if (table) {
    const cs = getComputedStyle(table);
    if (cs.transform && cs.transform !== "none") {
      // Laid out at its offset in the screen (fixed, unturned), then turned about its origin.
      const host = (table.offsetParent ?? document.body).getBoundingClientRect();
      const [ox, oy] = cs.transformOrigin.split(" ").map(parseFloat);
      inv = new DOMMatrix()
        .translate(host.left + table.offsetLeft + ox, host.top + table.offsetTop + oy)
        .multiply(new DOMMatrix(cs.transform))
        .translate(-ox, -oy)
        .inverse();
    } else {
      const r = table.getBoundingClientRect();
      inv = new DOMMatrix().translate(-r.left, -r.top);
    }
  }
  const point = (x: number, y: number) => {
    const p = inv.transformPoint(new DOMPoint(x, y));
    return { x: p.x, y: p.y };
  };
  const box = (el: Element) => {
    const r = el.getBoundingClientRect();
    const ps = [point(r.left, r.top), point(r.right, r.top), point(r.right, r.bottom), point(r.left, r.bottom)];
    const xs = ps.map((p) => p.x);
    const ys = ps.map((p) => p.y);
    return { left: Math.min(...xs), top: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
  };
  return { point, box };
}
export const centreOf = (b: Box) => ({ x: b.left + b.width / 2, y: b.top + b.height / 2 });

// How a tile is seen where it lies: from the eye of the perspective it's
// drawn in (the felt's, or your hand's - each has its own), tipped back
// (rotateX: flat on the felt, or standing as your hand does), turned on the
// table, and its sides lit as there.
export interface View {
  eye: { x: number; y: number; d: number };
  tilt: number;
  turn: number;
  shade: [number, number]; // --shade-long, --shade-end
}
export function viewOf(el: Element, frame: Frame, tilt: number, turn: number): View {
  let a = el.parentElement;
  while (a && getComputedStyle(a).perspective === "none") a = a.parentElement;
  const cs = getComputedStyle(el);
  const shade: [number, number] = [parseFloat(cs.getPropertyValue("--shade-long")) || 0, parseFloat(cs.getPropertyValue("--shade-end")) || 0];
  if (!a) return { eye: { x: 0, y: 0, d: 1100 }, tilt, turn, shade };
  const ac = getComputedStyle(a);
  const [ox, oy] = ac.perspectiveOrigin.split(" ").map(parseFloat);
  const b = frame.box(a);
  return { eye: { x: b.left + ox, y: b.top + oy, d: parseFloat(ac.perspective) || 1100 }, tilt, turn, shade };
}

// One end of a flight: the tile there (its outline in the table's frame) and how it's seen.
export interface FlightEnd {
  box: Box;
  view: View;
  // Where it lay: how far apart the tiles there sit side by side, and
  // their middle - where its group gathers (see flightPath).
  pitch?: number;
  home?: { x: number; y: number };
}

// A tile at one moment of its flight: its centre (table frame), turn, size
// (a fraction of its own), tip, the eye it's seen from, and its sides' light.
export interface Pose {
  x: number;
  y: number;
  r: number;
  s: number;
  t: number;
  ex: number;
  ey: number;
  d: number;
  shade: [number, number];
  // Its shadow on the felt: how far it falls below the tile (px), squashed
  // to (a standing tile's foot), and how dark each of its looks shows - as
  // where it lay, as where it lands, and lifted (see SwapFlight).
  sh: { dy: number; sy: number; o: [number, number, number]; ex: number; ey: number; d: number };
}
// As a transform of the flying tile, whose own centre (untransformed) is
// `c`: seen from the pose's eye (so it shows the sides it would there),
// tipped, then turned on the table, then sized - thickness too.
export const poseTransform = (p: Pose, c: { x: number; y: number }) =>
  `translate(${p.ex - c.x}px, ${p.ey - c.y}px) perspective(${p.d}px) translate(${p.x - p.ex}px, ${p.y - p.ey}px) rotateX(${p.t}deg) rotate(${p.r}deg) scale3d(${p.s}, ${p.s}, ${p.s})`;

// A taken (or given) tile, flown from its pile to its place by the taker's
// hand (or yours to your pile), and left there till the round's over - face
// up if it's yours to see, else face down. Laid out in the table's frame
// where it starts (`from`), hidden, until its path is known: then each end
// is fitted to the tile drawn there (fitPose), so it sets off exactly as
// its pile's tile lay and lands exactly as its place's tile lies - and in
// between it morphs from the one to the other.
export interface Flight {
  id: number;
  to: number; // the seat whose hand it's flying to
  real: Tile; // what it is - joining that hand as it lands
  seat: number; // whose pile it left, and its place there - where it's
  place: number; // drawn until it sets off
  tile: Tile | null; // null: face down - not yours to see
  // Face down where it lay, face up where it lands (yours, from another's
  // pile): it turns over on the way.
  flip?: boolean;
  ghost?: boolean; // the round's last take - its pile drawn from the ghost
  from: { left: number; top: number; font: number };
  start: FlightEnd;
  end?: FlightEnd;
  // Its poses, sampled evenly over the flight (see aimGroup). Empty until
  // it's known where it lands: a seat's row is laid out first, then
  // measured - see `row`.
  path?: Pose[];
  delay: number;
  // Landing in a row by a seat's hand: its giver's group there, and once
  // measured, its place in that group.
  row?: { group: number; place?: number };
}

// Eased progress: speeding up once, slowing once.
const ease = (u: number) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);
const turnBy = (x: number, y: number, deg: number) => {
  const a = (deg * Math.PI) / 180;
  return { x: x * Math.cos(a) - y * Math.sin(a), y: x * Math.sin(a) + y * Math.cos(a) };
};

// How far through a flight its tiles have gathered, and how much bigger
// they show lifted off the table.
const GATHER = 0.4;
const LIFT = 1.08;

// One giver's tiles in a take go in two steps. First they lift off their
// pile and close up there - the gaps between them gone, in the order and
// spacing they'll land in - each group by its own pile, where the givers'
// groups are well apart. Then the group flies over as one: its middle
// glides from the pile to the row (curving round to come in square to it,
// when `approach` is given, so the groups landing in a row together come
// in side by side), turning about it from the way the tiles lay (a side
// seat's sideways) to the way the row runs - the turn mostly done early,
// so it comes in already lined up. The tiles keep their order and their
// spacing all the way: they can't touch.
// Each starts at the size its pile's tile shows (`sizes`, a fraction of
// its own), a touch bigger lifted, and lands at the size its place shows
// (`endSizes`) - the group's spacing keeping pace with its size.
// `starts`/`ends`: each tile's centre, leaving and landing; `turnFrom`/
// `turnTo`: how the tiles lie, leaving and landing (deg). Each sample is the
// tile's offset from where it started, its turn and its size.
export function flightPath(
  starts: { x: number; y: number }[],
  ends: { x: number; y: number }[],
  turnFrom: number,
  turnTo: number,
  sizes: number[] = starts.map(() => 1),
  endSizes: number[] = starts.map(() => 1),
  approach?: { x: number; y: number },
  // How far apart tiles lie side by side in the pile (centre to centre):
  // the group gathers at that spacing, then takes its row's as it turns.
  pitch?: number,
  // Where the group gathers: its pile's middle (else where its tiles were).
  home?: { x: number; y: number },
  samples = 32
) {
  const mean = (ps: { x: number; y: number }[]) => ({ x: ps.reduce((t, p) => t + p.x, 0) / ps.length, y: ps.reduce((t, p) => t + p.y, 0) / ps.length });
  const c0 = mean(starts);
  const c1 = mean(ends);
  const h = home ?? c0;
  // The curve's pull: back from the row along the way in, half the trip.
  const reach = Math.hypot(c1.x - h.x, c1.y - h.y) * 0.5;
  const pull = approach ? { x: c1.x - approach.x * reach, y: c1.y - approach.y * reach } : null;
  const middle = (e: number) =>
    pull
      ? { x: (1 - e) * (1 - e) * h.x + 2 * (1 - e) * e * pull.x + e * e * c1.x, y: (1 - e) * (1 - e) * h.y + 2 * (1 - e) * e * pull.y + e * e * c1.y }
      : { x: h.x + (c1.x - h.x) * e, y: h.y + (c1.y - h.y) * e };
  let turn = turnTo - turnFrom;
  if (turn > 180) turn -= 360;
  if (turn <= -180) turn += 360;
  // The pile's way (first to last of these), and each tile's place along it.
  const a = starts[0];
  const b = starts[starts.length - 1];
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const dir = len ? { x: (b.x - a.x) / len, y: (b.y - a.y) / len } : null;
  const rank = starts.map((p) => (dir ? (p.x - c0.x) * dir.x + (p.y - c0.y) * dir.y : 0));
  const order = rank.map((_, i) => i).sort((p, q) => rank[p] - rank[q]);
  return starts.map((start, i) => {
    // Its place in the group, leaving and landing - the landing one turned
    // back into the way the tiles lay - and gathered: side by side along the
    // pile, the gaps between them gone (at the row's spacing, turned back,
    // without the pile's own).
    const os = { x: start.x - c0.x, y: start.y - c0.y };
    const oe = turnBy(ends[i].x - c1.x, ends[i].y - c1.y, -turn);
    const at = order.indexOf(i) - (starts.length - 1) / 2;
    // (A touch apart - 5% - while in the air: turning and tipping shows a tile a little bigger than it lies.)
    const og = pitch && dir ? { x: dir.x * at * pitch * 1.05, y: dir.y * at * pitch * 1.05 } : oe;
    const lifted = sizes[i] * LIFT;
    return Array.from({ length: samples + 1 }, (_, k) => {
      const u = k / samples;
      if (u <= GATHER) {
        // Lifting and closing up, by its pile.
        const g = ease(u / GATHER);
        const s = sizes[i] + (lifted - sizes[i]) * g;
        const k = s / (pitch ? sizes[i] : endSizes[i]);
        const c = { x: c0.x + (h.x - c0.x) * g, y: c0.y + (h.y - c0.y) * g };
        return { x: os.x + (og.x * k - os.x) * g + c.x - start.x, y: os.y + (og.y * k - os.y) * g + c.y - start.y, r: turnFrom, s, lift: g };
      }
      // Flying over as one, landing.
      const f = ease((u - GATHER) / (1 - GATHER));
      const te = 1 - Math.pow(1 - f, 2.5);
      const s = lifted + (endSizes[i] - lifted) * f;
      // From the pile's spacing to the row's as it turns, sized in step.
      const from = { x: og.x * (s / (pitch ? sizes[i] : endSizes[i])), y: og.y * (s / (pitch ? sizes[i] : endSizes[i])) };
      const to = { x: oe.x * (s / endSizes[i]), y: oe.y * (s / endSizes[i]) };
      const apart = 1 + 0.05 * Math.sin(Math.PI * f);
      const o = turnBy((from.x + (to.x - from.x) * te) * apart, (from.y + (to.y - from.y) * te) * apart, turn * te);
      const c = middle(f);
      return { x: c.x + o.x - start.x, y: c.y + o.y - start.y, r: turnFrom + turn * te, s, lift: 1 - f * f };
    });
  });
}

// How long a take's flight takes (all its tiles go together), and how long the round's rows stay once its last
// take is down, before every tile joins its hand.
export const SWAP_FLIGHT_MS = 750;
export const SWAP_ROUND_HOLD_MS = 1400;

// Tipped as the felt is, or as your hand's tiles stand (see .play-hand).
export const SWAP_TILT_FLAT = 32;
export const SWAP_TILT_STANDING = -22;

// The tile in a flight that's drawn at one end: the face, or (turning over
// on the way) the back it shows where it lay.
const tileIn = (el: HTMLElement, atStart: boolean) =>
  ((el.querySelector(atStart ? ".play-swap-flip-back" : ".play-swap-flip-face") ?? el).firstElementChild ?? el) as HTMLElement;

// A flight's tile posed as at one end, sized and nudged till its outline
// matches the tile drawn there (a few rounds: the eye's perspective makes
// it not quite linear) - so nothing jumps as it sets off or lands.
function fitPose(el: HTMLElement, frame: Frame, c: { x: number; y: number }, end: FlightEnd, atStart: boolean): Pose {
  const target = centreOf(end.box);
  const pose: Pose = { x: target.x, y: target.y, r: end.view.turn, s: 1, t: end.view.tilt, ex: end.view.eye.x, ey: end.view.eye.y, d: end.view.eye.d, shade: end.view.shade, sh: { dy: 0, sy: 1, o: [0, 0, 0], ex: 0, ey: 0, d: 1100 } };
  const tile = tileIn(el, atStart);
  for (let i = 0; i < 4; i++) {
    el.style.transform = poseTransform(pose, c);
    const b = frame.box(tile);
    if (!b.width || !b.height) break;
    pose.s *= Math.sqrt((end.box.width * end.box.height) / (b.width * b.height));
    const at = centreOf(b);
    pose.x += target.x - at.x;
    pose.y += target.y - at.y;
  }
  el.style.transform = "";
  return pose;
}

const lerp = (a: number, b: number, e: number) => a + (b - a) * e;

// One giver's flights in a take (or your give), as one formation: each
// fitted at both ends to the tiles drawn there, then flown along
// flightPath from the one pose to the other - its eye, tip and light
// easing over with it, so it morphs from how it lay to how it lands.
// `approach`: the way it comes in (see flightPath). Each flight's element
// must be in the page (laid out, hidden): `els` by flight id.
export function aimGroup(fs: Flight[], els: Map<number, HTMLElement>, frame: Frame, approach?: { x: number; y: number }, pitch?: number, home?: { x: number; y: number }): Map<number, Pose[]> {
  const out = new Map<number, Pose[]>();
  const fitted = fs.map((f) => {
    const el = els.get(f.id);
    if (!el || !f.end) return null;
    const c = { x: el.offsetLeft + el.offsetWidth / 2, y: el.offsetTop + el.offsetHeight / 2 };
    return { f, a: fitPose(el, frame, c, f.start, true), b: fitPose(el, frame, c, f.end, false) };
  });
  if (fitted.some((x) => !x)) return out;
  const all = fitted as { f: Flight; a: Pose; b: Pose }[];
  const paths = flightPath(
    all.map((x) => ({ x: x.a.x, y: x.a.y })),
    all.map((x) => ({ x: x.b.x, y: x.b.y })),
    all[0].a.r,
    all[0].b.r,
    all.map((x) => x.a.s),
    all.map((x) => x.b.s),
    approach,
    pitch,
    home
  );
  // Its shadow where it rests at an end: a tile lying flat casts it round
  // itself (as the felt's tiles do); a standing one, along its foot. (How
  // soft: .play-swap-shadow's looks.)
  const font = (f: Flight) => f.from.font;
  // Shadows lie on the felt: seen from the felt's own eye, whoever's tile casts them.
  const feltEl = document.querySelector(".play-felt");
  const felt = feltEl ? viewOf(feltEl, frame, SWAP_TILT_FLAT, 0).eye : null;
  const restShadow = (f: Flight, end: FlightEnd, p: Pose) =>
    end.view.tilt === SWAP_TILT_FLAT
      ? { dy: 0.03 * font(f) * p.s, sy: 1, a: 0.3 }
      : { dy: end.box.height / 2 - 0.2 * font(f) * p.s, sy: 0.42, a: 0.32 };
  all.forEach(({ f, a, b }, i) => {
    const n = paths[i].length - 1;
    const s0 = restShadow(f, f.start, a);
    const s1 = restShadow(f, f.end!, b);
    out.set(
      f.id,
      paths[i].map((p, k) => {
        // Held as it lay while it gathers; then seen, tipped and lit as where it lands, in step with its turn.
        const u = k / n;
        const e = u <= GATHER ? 0 : 1 - Math.pow(1 - ease((u - GATHER) / (1 - GATHER)), 2.5);
        return {
          x: a.x + p.x,
          y: a.y + p.y,
          r: p.r,
          s: p.s,
          t: lerp(a.t, b.t, e),
          ex: lerp(a.ex, b.ex, e),
          ey: lerp(a.ey, b.ey, e),
          d: lerp(a.d, b.d, e),
          shade: [lerp(a.shade[0], b.shade[0], e), lerp(a.shade[1], b.shade[1], e)],
          // Lifted, it falls away below, soft and faint; down, it's as where it rests.
          sh: ((rest, h, lay) => {
            const air = { dy: 0.4 * font(f) * p.s, sy: 1, a: 0.14 };
            const eye = felt ?? { x: lerp(a.ex, b.ex, e), y: lerp(a.ey, b.ey, e), d: lerp(a.d, b.d, e) };
            const down = rest.a * (1 - h);
            return { dy: lerp(rest.dy, air.dy, h), sy: lerp(rest.sy, air.sy, h), o: [lay ? down : 0, lay ? 0 : down, air.a * h], ex: eye.x, ey: eye.y, d: eye.d };
          })(u <= GATHER ? s0 : s1, p.lift, u <= GATHER),
        };
      })
    );
  });
  return out;
}

export function SwapFlight({ flight, landed, onStart, onLanded }: { flight: Flight; landed: boolean; onStart: () => void; onLanded: () => void }) {
  const ref = useRef<HTMLSpanElement>(null);
  const shadowRef = useRef<HTMLSpanElement>(null);
  // Flown along its path; down when it lands - or, should the animation's
  // end never come (a page in the background holds animations), soon after
  // it should have. It stays in its row till the round's over (PlayPanel
  // clears them).
  useEffect(() => {
    const quick = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const el = ref.current;
    if (!flight.path || !el) return;
    // Nothing to fly (see PlayPanel): straight down where it goes.
    if (!flight.path.length) {
      onStart();
      onLanded();
      return;
    }
    const c = { x: el.offsetLeft + el.offsetWidth / 2, y: el.offsetTop + el.offsetHeight / 2 };
    const ms = quick ? 1 : SWAP_FLIGHT_MS;
    const timing: KeyframeAnimationOptions = { duration: ms, delay: flight.delay, easing: "linear", fill: "forwards" };
    // Moved by its transform alone, so the flight runs on the compositor.
    const anims = [el.animate(flight.path.map((p) => ({ transform: poseTransform(p, c) })), timing)];
    // Set at a moment of the flight and held: shown as it sets off, its
    // sides' light eased over in a few small steps (light animated smoothly
    // would hold every frame on the main thread).
    const at = (e: HTMLElement, u: number, kf: Keyframe) => anims.push(e.animate([kf, kf], { duration: 0, delay: flight.delay + u * ms, fill: "forwards" }));
    const n = flight.path.length - 1 || 1;
    let lit = "";
    flight.path.forEach((p, k) => {
      const shade = p.shade.map((x) => String(Math.round(x * 50) / 50));
      if (shade.join() === lit) return;
      lit = shade.join();
      at(el, k / n, { "--shade-long": shade[0], "--shade-end": shade[1], ...(k ? {} : { visibility: "visible" }) });
    });
    // Turned over on the way: edge on a third of the way along, where the
    // back gives way to the face, then flat again as it lands.
    const flip = el.querySelector<HTMLElement>(".play-swap-flip");
    if (flight.flip && flip) {
      anims.push(flip.animate([{ transform: "rotateY(0deg)" }, { transform: "rotateY(90deg)", offset: 0.35 }, { transform: "rotateY(0deg)" }], { ...timing, easing: "ease-in-out" }));
      const back = flip.querySelector<HTMLElement>(".play-swap-flip-back");
      const face = flip.querySelector<HTMLElement>(".play-swap-flip-face");
      if (back) at(back, 0.35, { visibility: "hidden" });
      if (face) at(face, 0.35, { visibility: "visible" });
    }
    const shadow = shadowRef.current;
    if (shadow) {
      const sc = { x: shadow.offsetLeft + shadow.offsetWidth / 2, y: shadow.offsetTop + shadow.offsetHeight / 2 };
      // On the felt: flat, under where the tile is (a lifted tile's size, unlifted).
      anims.push(shadow.animate(flight.path.map((p) => ({ transform: `${poseTransform({ ...p, y: p.y + p.sh.dy, t: SWAP_TILT_FLAT, ex: p.sh.ex, ey: p.sh.ey, d: p.sh.d }, sc)} scale(1, ${p.sh.sy})` })), timing));
      // Its looks, each blurred already, faded one into the next as it lifts and lands.
      const path = flight.path;
      [...shadow.children].forEach((look, i) => {
        if (path.some((p) => p.sh.o[i] > 0)) anims.push((look as HTMLElement).animate(path.map((p) => ({ opacity: String(p.sh.o[i]) })), timing));
      });
    }
    const off = window.setTimeout(onStart, flight.delay);
    const down = window.setTimeout(onLanded, flight.delay + SWAP_FLIGHT_MS + 300);
    anims[0].finished.then(onLanded, () => {});
    return () => {
      window.clearTimeout(off);
      window.clearTimeout(down);
      // One flight per tile: a second run of this effect (React may run it
      // twice) mustn't leave the first still playing underneath.
      anims.forEach((a) => a.cancel());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!flight.path]);
  // Landed in a row, the row's own tile takes over.
  if (landed && flight.row) return null;
  const face = flight.tile && <TileGlyphSpan tile={flight.tile} block="fine" />;
  const back = (
    <span className="play-back">
      <i className="tile-top" />
      <TileSides />
    </span>
  );
  return (
    <>
    <span
      ref={shadowRef}
      className={`play-swap-shadow${flight.tile ? "" : " is-back"}`}
      style={{ left: flight.from.left, top: flight.from.top, fontSize: flight.from.font }}
      aria-hidden="true"
    >
      {/* As where it lay, as where it lands, and lifted. */}
      {[flight.start, flight.end].map((end, i) => (
        <i key={i} className={end?.view.tilt === SWAP_TILT_FLAT ? "is-flat" : "is-standing"} />
      ))}
      <i className="is-air" />
    </span>
    <span
      ref={ref}
      className="play-swap-flight"
      style={{ left: flight.from.left, top: flight.from.top, fontSize: flight.from.font }}
      aria-hidden="true"
      data-flight={flight.id}
      data-to={flight.to}
      data-from={flight.seat}
    >
      {flight.flip && face ? (
        <span className="play-swap-flip">
          <span className="play-swap-flip-back">{back}</span>
          <span className="play-swap-flip-face">{face}</span>
        </span>
      ) : (
        (face ?? back)
      )}
    </span>
    </>
  );
}
