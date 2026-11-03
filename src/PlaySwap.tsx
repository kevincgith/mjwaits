// 換牌 at the Play table (the rules: shared/engine/swap.ts): the dealer's
// two dice over the middle of the table; the swap's line in the bar under
// the table, with your buttons; and the sheet that sets which rounds swap
// and what the dice mean. The piles, rows and flying tiles themselves are
// the WebGL table's (play3d/).

import { useEffect, useRef, useState } from "react";
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
  // Its giver's group in the taker's row, and once worked out, its place in that group.
  row?: { group: number; place?: number };
}

// How long a take's flight takes (all its tiles go together), and how long the round's rows stay once its last
// take is down, before every tile joins its hand.
export const SWAP_FLIGHT_MS = 750;
export const SWAP_ROUND_HOLD_MS = 1400;
