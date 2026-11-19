// 換牌 at the Play table (the rules: shared/engine/swap.ts): the dealer's
// two dice over the middle of the table; the swap's line in the bar under
// the table, with your buttons; and the sheet that sets which rounds swap
// and what the dice mean. The piles, rows and flying tiles themselves are
// the WebGL table's (play3d/).

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  blindPicks,
  botSplit,
  checkTake,
  DEFAULT_SWAP_RULES,
  pileLeft,
  SWAP_MAX_ROUNDS,
  SWAP_MAX_TILES,
  SWAP_MIN_TILES,
  type SwapPhase,
  type SwapRules,
} from "@mjwaits/shared/engine/swap";
import type { Wind } from "@mjwaits/shared/engine/scoring";
import { PlayDie } from "./PlayDie";
import type { Tile } from "@mjwaits/shared/engine/mahjong";

const WIND_CHARS = ["", "東", "南", "西", "北"];

// The dealer's two dice, over the middle of the table: thrown one at a
// time, as at a real table - the first tumbles in and says how many swap
// rounds, then the second, how many tiles each - and held a moment.
// `factor`: the table's speed (fast plays it quicker).
const DIE_GAP_MS = 1300; // the first throw to the second
export const DIE_SAY_MS = 800; // a throw to what it means
export const swapDiceMs = (factor: number) => Math.round((DIE_GAP_MS + DIE_SAY_MS + 900) * factor);
// The deal's three dice keep the same time: thrown together, what they
// mean said as they land (DIE_SAY_MS), and held as long as the swap's.
export const dealDiceMs = swapDiceMs;

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

// An even take (the fairest there is) for `seat`: blind picks from each pile.
export const evenTake = (phase: SwapPhase, seat: number, after: number[]) => {
  const even = botSplit(phase.piles.map(pileLeft), seat, after, phase.count);
  return phase.piles.map((p, g) => (p ? blindPicks(p, even[g]) : []));
};

// 快換: your take comes by itself (an even take) after this long - time to
// see it's yours, and to tap a tile to pick by hand; the same at any speed.
export const AUTO_TAKE_MS = 4000;

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
  autoTakeMs = null,
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
  // 快換: your take coming by itself in this long (ms) - 攞牌 lit, its time
  // running out across it; a tap takes now, a tile tapped picks by hand.
  autoTakeMs?: number | null;
}) {
  const { rounds, count, round, stage, piles, taker } = phase;
  const mineToGive = seated && stage === "give" && !piles[0] && !settling;
  const myTake = seated && stage === "take" && taker === 0;
  const sizes = piles.map(pileLeft);
  const split = picks.map((p) => p.length);
  const taken = split.reduce((a, b) => a + b, 0);
  const check = myTake ? checkTake(sizes, 0, after, count, split) : null;
  // One tap: an even take, blind.
  const quickTake = () => onTake(evenTake(phase, 0, after));
  const auto = autoTakeMs !== null && taken === 0;
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
  else if (auto) note = `Taking ${count} evenly - tap a tile to pick`;
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
        className={`play-call is-swap is-long${taken === 0 || (check.ok && !check.warning) ? " is-win" : ""}${taken > 0 && check.warning ? " is-warn" : ""}${auto ? " is-auto" : ""}`}
        disabled={taken > 0 && !check.ok}
        onClick={() => (taken === 0 ? quickTake() : onTake())}
        aria-label={taken === 0 ? `Take ${count} evenly, blind` : (check.error ?? check.warning ?? `Take these ${taken}`)}
      >
        {auto && <TakeRing ms={autoTakeMs} />}
        {taken === 0 ? "攞牌" : check.warning ? "照攞" : `攞 ${taken}/${count}`}
      </button>
    </>
  );
}

// 快換's auto take, counting down: the button's own gold frame running out
// clockwise from the top - as the compass's turn timer does its rim - over
// the frame dimmed. (Drawn to the button's own size, whatever its width.)
export function TakeRing({ ms }: { ms: number }) {
  const svg = useRef<SVGSVGElement>(null);
  const bar = useRef<SVGPathElement>(null);
  // The button's size (its border included) and the border's width.
  const [size, setSize] = useState<[number, number, number] | null>(null);
  useLayoutEffect(() => {
    const button = svg.current?.parentElement;
    if (!button) return;
    const measure = () => setSize([button.offsetWidth, button.offsetHeight, parseFloat(getComputedStyle(button).borderTopWidth) || 2]);
    measure();
    const seen = new ResizeObserver(measure);
    seen.observe(button);
    return () => seen.disconnect();
  }, []);
  const drawn = size !== null;
  useEffect(() => {
    const run = bar.current?.animate?.([{ strokeDashoffset: 0 }, { strokeDashoffset: -1 }], { duration: ms, fill: "forwards" });
    return () => run?.cancel();
  }, [ms, drawn]);
  // Along the middle of the border: a pill, from the top's middle.
  const [w, h, b] = size ?? [0, 0, 2];
  const a = b / 2;
  const r = Math.min(h / 2 - a, w / 2 - a);
  const d = `M${w / 2} ${a}H${w - a - r}A${r} ${r} 0 0 1 ${w - a - r} ${h - a}H${a + r}A${r} ${r} 0 0 1 ${a + r} ${a}Z`;
  return (
    <svg ref={svg} className="play-take-ring" style={{ top: -b, left: -b }} width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true">
      {drawn && <path ref={bar} d={d} pathLength={1} strokeWidth={b} />}
    </svg>
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
  // A die's row: "All" (one pick sets all six), then a pick for each throw.
  const mapRow = (key: "rounds" | "tiles", lo: number, hi: number, label: string, unit: string) => (
    <>
      <span className="play-swap-grid-label">{label}</span>
      <select
        className="is-all"
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
      {r[key].map((v, i) => (
        <select
          key={i}
          value={v}
          aria-label={`Die ${i + 1}: ${unit}`}
          onChange={(e) => {
            const n = Number(e.target.value);
            update((r) => ({ ...r, [key]: r[key].map((x, j) => (j === i ? n : x)) }));
          }}
        >
          {options(lo, hi)}
        </select>
      ))}
    </>
  );
  // On one screen, a phone held sideways: which rounds swap, a preset and
  // 快換 on the left; on the right what each throw of the two dice means.
  return (
    <div className="play-sheet-backdrop" onClick={onClose}>
      <div className="play-sheet play-swap-sheet" role="dialog" aria-label="Swap tiles" onClick={(e) => e.stopPropagation()}>
        <div className="play-sheet-head">
          <h2>換牌 Swap tiles</h2>
          <span>From the next hand dealt</span>
          <button type="button" className="play-swap-confirm" onClick={confirm}>
            Confirm
          </button>
          <button type="button" className="play-sheet-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <p className="play-swap-intro">Dealt 16; the dealer&apos;s first die says how many rounds, the second how many tiles each lays face down and takes back.</p>
        <div className="play-swap-cols">
          <div className="play-swap-col">
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
            <div className="play-swap-quick" title="Taken tiles grey out where they lie; once everyone has taken, they all fly at once - and your own take comes by itself">
              <b>快換 Quick swap</b>
              <span className="play-menu-seg">
                {[false, true].map((on) => (
                  <button key={String(on)} type="button" className={(r.quick !== false) === on ? "toggle-on" : undefined} aria-pressed={(r.quick !== false) === on} onClick={() => update((r) => ({ ...r, quick: on }))}>
                    {on ? "On" : "Off"}
                  </button>
                ))}
              </span>
            </div>
          </div>
          <div className="play-swap-col">
            <h3>Each throw</h3>
            <div className="play-swap-grid">
              <span />
              <span className="play-swap-all">All</span>
              {[1, 2, 3, 4, 5, 6].map((v) => (
                <span key={v} className="play-swap-grid-die">
                  <PlayDie value={v} rolling={false} index={0} />
                </span>
              ))}
              {mapRow("rounds", 1, SWAP_MAX_ROUNDS, "Rounds", "swap rounds")}
              {mapRow("tiles", SWAP_MIN_TILES, SWAP_MAX_TILES, "Tiles", "tiles each")}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// A taken tile, flown from its pile to its place in a row by the taker's
// hand, and left there till the round's over - face up if it's yours to
// see, else face down (see GLFlight).
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
  // Quick swap: taken, but held where it lay (greyed) till the round's last
  // take - then every one sets off together.
  waiting?: boolean;
  // Quick swap: it waited greyed - and stays so till it lifts off, then
  // brightens on the way (not a blink bright first).
  greyed?: boolean;
  // Its giver's group in the taker's row, and once worked out, its place in that group.
  row?: { group: number; place?: number };
}

// How long a take's flight takes (all its tiles go together), and how long the round's rows stay once its last
// take is down, before every tile joins its hand.
// (Kept with the online table's own pace, which has to cover them: see
// shared/engine/swap's SWAP_PACE_MS.)
export { SWAP_FLIGHT_MS, SWAP_ROUND_HOLD_MS } from "@mjwaits/shared/engine/swap";
