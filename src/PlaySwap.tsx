// 換牌 at the Play table (the rules: shared/engine/swap.ts). The panel over
// the middle of the table while the swapping goes on - the dealer's two
// dice, then each round: who has laid their tiles out, and the face-down
// piles to take from, where you tap the tiles you want - and the sheet that
// sets which rounds swap and what the dice mean.

import { useState } from "react";
import { DEFAULT_SWAP_RULES, SWAP_MAX_ROUNDS, SWAP_MAX_TILES, SWAP_MIN_TILES, checkTake, type SwapPhase, type SwapRules } from "@mjwaits/shared/engine/swap";
import type { Wind } from "@mjwaits/shared/engine/scoring";
import { PlayDie } from "./PlayDie";

const WIND_CHARS = ["", "東", "南", "西", "北"];

// The panel. `picks`: the tiles you've tapped in each pile (by place);
// `after`: who takes after the one taking now.
export function SwapPanel({
  phase,
  rolling,
  nameOf,
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
  seated: boolean;
  picks: number[][];
  setPicks: (update: (p: number[][]) => number[][]) => void;
  after: number[];
  giveCount: number; // tiles you've picked from your hand to give
  onGive: () => void;
  onTake: () => void;
}) {
  const { dice, rounds, count, round, stage, piles, taker } = phase;
  const mineToGive = seated && stage === "give" && !piles[0];
  const myTake = seated && stage === "take" && taker === 0;
  const sizes = piles.map((p) => p?.length ?? 0);
  const split = picks.map((p) => p.length);
  const taken = split.reduce((a, b) => a + b, 0);
  const check = myTake ? checkTake(sizes, 0, after, count, split) : null;
  const toggle = (seat: number, i: number) => {
    if (!myTake || seat === 0) return;
    setPicks((now) => {
      const has = now[seat].includes(i);
      if (!has && now.flat().length >= count) return now;
      return now.map((p, g) => (g !== seat ? p : has ? p.filter((x) => x !== i) : [...p, i]));
    });
  };
  // The others' piles in the order they sit round from you: right, across, left.
  const order = [1, 2, 3, 0];
  return (
    <div className={`play-swap${rolling ? " is-rolling" : ""}`} role="status">
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
            Round {round} of {rounds} ·{" "}
            {stage === "give"
              ? "everyone lays tiles face down"
              : myTake
                ? `your turn: take ${count} - at least one from each`
                : `${nameOf(taker)} is taking`}
          </span>
          {stage === "give" ? (
            <div className="play-swap-givers">
              {[0, 1, 2, 3].map((seat) => (
                <span key={seat} className={`play-swap-giver${piles[seat] ? " is-done" : ""}`}>
                  {piles[seat] ? "✓ " : ""}
                  {nameOf(seat)}
                </span>
              ))}
            </div>
          ) : (
            <div className="play-swap-piles">
              {order.map((seat) => (
                <div key={seat} className={`play-swap-pile${seat === 0 ? " is-mine" : ""}${seat === taker ? " is-taking" : ""}`}>
                  <span className="play-swap-who">
                    {nameOf(seat)}
                    {myTake && seat !== 0 && picks[seat].length > 0 && <b> · {picks[seat].length}</b>}
                  </span>
                  <span className="play-swap-backs">
                    {piles[seat]!.map((_, i) => (
                      <button
                        key={i}
                        type="button"
                        className={`play-swap-back${picks[seat]?.includes(i) ? " is-picked" : ""}`}
                        disabled={!myTake || seat === 0}
                        aria-pressed={picks[seat]?.includes(i)}
                        aria-label={`${nameOf(seat)}'s tile ${i + 1}`}
                        onClick={() => toggle(seat, i)}
                      />
                    ))}
                    {piles[seat]!.length === 0 && <span className="play-swap-empty">taken</span>}
                  </span>
                </div>
              ))}
            </div>
          )}
          {mineToGive && (
            <div className="play-swap-act">
              <span>
                Tap {count} tiles in your hand to give · {giveCount}/{count}
              </span>
              <button type="button" className="play-swap-go" disabled={giveCount !== count} onClick={onGive}>
                放牌 Give
              </button>
            </div>
          )}
          {myTake && check && (
            <div className="play-swap-act">
              <span className={taken === count ? (check.ok ? (check.warning ? "is-warn" : "is-ok") : "is-error") : undefined}>
                {[1, 2, 3].map((g) => split[g]).join(" · ")} ({taken}/{count})
                {taken === count && (check.error ?? check.warning) ? ` - ${check.error ?? check.warning}` : ""}
              </span>
              <button type="button" className={`play-swap-go${check.warning ? " is-warn" : ""}`} disabled={!check.ok} onClick={onTake}>
                {check.warning ? "Take anyway" : "攞牌 Take"}
              </button>
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
