// 換牌 at the Play table (the rules: shared/engine/swap.ts). The panel over
// the middle of the table while the swapping goes on - the dealer's two
// dice, then each round the face-down piles where their players sit, which
// you tap to take from (or take evenly in one tap) - and the sheet that
// sets which rounds swap and what the dice mean.

import { useState } from "react";
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

const WIND_CHARS = ["", "東", "南", "西", "北"];

// The panel. Each pile lies where its player sits - across at the top, the
// players to your right and left at the sides, yours below - with their wind
// and name; a tile taken leaves its place empty. `picks`: the places you've
// tapped in each pile; `after`: who takes after the one taking now.
export function SwapPanel({
  phase,
  rolling,
  nameOf,
  windOf,
  seated,
  picks,
  setPicks,
  after,
  giveCount,
  onGive,
  onTake,
}: {
  phase: SwapPhase;
  rolling: boolean;
  nameOf: (seat: number) => string;
  windOf: (seat: number) => string;
  seated: boolean;
  picks: number[][];
  setPicks: (update: (p: number[][]) => number[][]) => void;
  after: number[];
  giveCount: number; // tiles you've picked from your hand to give
  onGive: () => void;
  onTake: (picks?: number[][]) => void;
}) {
  const { dice, rounds, count, round, stage, piles, taker } = phase;
  const mineToGive = seated && stage === "give" && !piles[0];
  const myTake = seated && stage === "take" && taker === 0;
  const sizes = piles.map(pileLeft);
  const split = picks.map((p) => p.length);
  const taken = split.reduce((a, b) => a + b, 0);
  const check = myTake ? checkTake(sizes, 0, after, count, split) : null;
  const toggle = (seat: number, i: number) => {
    if (!myTake || seat === 0 || !piles[seat]?.[i]) return;
    setPicks((now) => {
      const has = now[seat].includes(i);
      if (!has && now.flat().length >= count) return now;
      return now.map((p, g) => (g !== seat ? p : has ? p.filter((x) => x !== i) : [...p, i]));
    });
  };
  // One tap: an even take (the fairest there is), blind picks from each.
  const quickTake = () => {
    const even = botSplit(sizes, 0, after, count);
    onTake(piles.map((p, g) => blindPicks(p!, even[g])));
  };
  const pile = (seat: number, place: string) => {
    const p = piles[seat];
    return (
      <div key={seat} className={`play-swap-pile is-${place}${seat === taker && stage === "take" ? " is-taking" : ""}`}>
        <span className="play-swap-who">
          <span className="play-swap-wind">{windOf(seat)}</span>
          {nameOf(seat)}
          {myTake && seat !== 0 && picks[seat].length > 0 && <b> {picks[seat].length}</b>}
        </span>
        <span className="play-swap-backs">
          {p
            ? p.map((t, i) =>
                t ? (
                  <button
                    key={i}
                    type="button"
                    className={`play-swap-back${picks[seat]?.includes(i) ? " is-picked" : ""}`}
                    disabled={!myTake || seat === 0}
                    aria-pressed={picks[seat]?.includes(i)}
                    aria-label={`${nameOf(seat)}'s tile ${i + 1}`}
                    onClick={() => toggle(seat, i)}
                  />
                ) : (
                  <span key={i} className="play-swap-gap" aria-label="taken" />
                )
              )
            : Array.from({ length: count }, (_, i) => <span key={i} className="play-swap-gap is-coming" />)}
        </span>
      </div>
    );
  };
  return (
    <div className={`play-swap${rolling ? " is-rolling" : ""}${stage === "take" ? " is-taking" : ""}`} role="status">
      <div className="play-swap-head">
        <span className="play-swap-title">換牌</span>
        <span className="play-swap-dice" aria-label={`Dice ${dice[0]} and ${dice[1]}`}>
          <PlayDie value={dice[0]} rolling={rolling} index={0} />
          <PlayDie value={dice[1]} rolling={rolling} index={1} delay={650} />
        </span>
        <span className="play-swap-sum">
          {rounds} round{rounds === 1 ? "" : "s"} · {count} tiles
        </span>
      </div>
      {!rolling && (
        <>
          <span className="play-swap-round">
            Round {round} of {rounds} · {stage === "give" ? "everyone lays tiles face down" : myTake ? `your take: ${count}` : `${nameOf(taker)} is taking`}
          </span>
          <div className="play-swap-table">
            {pile(2, "top")}
            {pile(3, "left")}
            {/* Yours in the middle: there to see, not to take from. */}
            {stage === "take" ? pile(0, "mine") : <span className="play-swap-mid" />}
            {pile(1, "right")}
          </div>
          {mineToGive && (
            <div className="play-swap-act">
              <span>
                {giveCount === count ? "Your loneliest tiles, picked - tap to change" : `Tap ${count} tiles in your hand to give`} · {giveCount}/{count}
              </span>
              <button type="button" className="play-swap-go" disabled={giveCount !== count} onClick={onGive}>
                放牌 Give
              </button>
            </div>
          )}
          {myTake && check && (
            <div className="play-swap-act">
              <span className={taken === count ? (check.ok ? (check.warning ? "is-warn" : "is-ok") : "is-error") : undefined}>
                {taken === 0
                  ? `Tap ${count} tiles - at least one from each`
                  : `${[3, 2, 1].map((g) => split[g]).join(" · ")} (${taken}/${count})${taken === count && (check.error ?? check.warning) ? ` - ${check.error ?? check.warning}` : ""}`}
              </span>
              {taken === 0 ? (
                <button type="button" className="play-swap-go" onClick={quickTake}>
                  一按 Take evenly
                </button>
              ) : (
                <span className="play-swap-buttons">
                  <button type="button" className="play-swap-clear" onClick={() => setPicks(() => [[], [], [], []])}>
                    Clear
                  </button>
                  <button type="button" className={`play-swap-go${check.warning ? " is-warn" : ""}`} disabled={!check.ok} onClick={() => onTake()}>
                    {check.warning ? "Take anyway" : "攞牌 Take"}
                  </button>
                </span>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// The settings: which round winds swap, and what each die means.
export function SwapSheet({ rules, onChange, onClose }: { rules: SwapRules; onChange: (r: SwapRules) => void; onClose: () => void }) {
  const [r, setR] = useState(rules);
  const set = (next: SwapRules) => {
    setR(next);
    onChange(next);
  };
  const toggleWind = (w: Wind) => set({ ...r, winds: r.winds.includes(w) ? r.winds.filter((x) => x !== w) : ([...r.winds, w].sort() as Wind[]) });
  const mapRow = (key: "rounds" | "tiles", lo: number, hi: number, unit: string) => (
    <div className="play-swap-map">
      {r[key].map((v, i) => (
        <label key={i} className="play-swap-map-cell">
          <PlayDie value={i + 1} rolling={false} index={0} />
          <select
            value={v}
            aria-label={`Die ${i + 1}: ${unit}`}
            onChange={(e) => set({ ...r, [key]: r[key].map((x, j) => (j === i ? Number(e.target.value) : x)) })}
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
