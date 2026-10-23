// 戰況 on the Play table: the game so far, as the Scores tab shows a game -
// the players best first with 胡·摸·銃, the 拉 in play, then every entry
// (最近), the trend, the score sheet (局), each player's stats and analysis
// (玩家) and the hands' patterns (牌型). Read-only; the game is the table's
// own record (see shared/engine/playLedger.ts), kept by this phone or, at an
// online table, by the server.
//
// Shown over the table in the Scores tab's own look (outside the table's
// dark theme, which it would otherwise inherit).

import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { replay, type ScoreGame } from "@mjwaits/shared/engine/ledger";
import { playerStats, trend } from "../lib/scoreStats";
import { RecentRows } from "./board";
import { liveStore } from "./online";
import { fmt, Segmented, Sheet } from "./shared";
import { HandsTable, Leaderboard, PatternsCard, PlayerCard, TrendChart, TrendSummary } from "./stats";

type View = "recent" | "trend" | "hands" | "player" | "patterns";

export function PlayScores({ game, onClose }: { game: ScoreGame; onClose: () => void }) {
  // Each seat in its own colour.
  const store = useMemo(() => liveStore(game, Object.fromEntries(game.seats.map((p, i) => [p, i]))), [game]);
  const state = useMemo(() => replay(game), [game]);
  const stats = useMemo(() => playerStats(state, game), [state, game]);
  const series = useMemo(() => trend(state).series, [state]);
  const [view, setView] = useState<View>("recent");
  const [playerIndex, setPlayerIndex] = useState(0);
  const views: { value: View; label: string }[] = [
    { value: "recent", label: "最近" },
    { value: "trend", label: "走勢" },
    { value: "hands", label: "局" },
    { value: "player", label: "玩家" },
    { value: "patterns", label: "牌型" },
  ];

  return createPortal(
    <Sheet title="戰況 Scores" subtitle={`${state.label} · ${state.hands.length}局`} onClose={onClose}>
      <div className="scores-panel play-scores">
        <Leaderboard
          store={store}
          stats={stats}
          series={series}
          onPick={(i) => {
            setPlayerIndex(i);
            setView("player");
          }}
        />
        {/* The 拉 in play: who holds one on whom, and how much - the one
            pulled can 踢 it back by winning off the holder. */}
        {state.lahs.length > 0 && (
          <div className="card ol-lahs">
            {state.lahs.map((l) => (
              <span key={`${l.holder}>${l.pulled}`} className="ol-lah">
                {l.holder} 拉 {l.pulled} <strong>{fmt(l.value)}</strong>
                {l.count > 1 && ` ×${l.count}`}
              </span>
            ))}
          </div>
        )}
        <div className="sc-views">
          <Segmented value={view} onChange={setView} options={views} small />
        </div>
        {view === "recent" &&
          (game.events.length ? (
            <div className="card">
              <RecentRows store={store} game={game} state={state} />
            </div>
          ) : (
            <p className="sc-empty">Hands show here as they're played.</p>
          ))}
        {view === "trend" &&
          (state.hands.length > 1 ? (
            <div className="card">
              <TrendChart store={store} state={state} />
              <TrendSummary state={state} />
            </div>
          ) : (
            <p className="sc-empty">The trend shows after two hands.</p>
          ))}
        {view === "hands" && <HandsTable store={store} game={game} state={state} />}
        {view === "player" &&
          (stats.some((s) => s.hands > 0) ? (
            <PlayerCard store={store} stats={stats} seriesOf={(p) => series.find((x) => x.player === p)?.values} index={Math.min(playerIndex, stats.length - 1)} onIndex={setPlayerIndex} />
          ) : (
            <p className="sc-empty">Each player's stats show after the first hand.</p>
          ))}
        {view === "patterns" && <PatternsCard state={state} store={store} />}
      </div>
    </Sheet>,
    document.body
  );
}
