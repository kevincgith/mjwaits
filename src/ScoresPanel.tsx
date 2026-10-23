// Scores tab: keeps score of a real game at the table (港式台牌 house rules),
// with analytics. All the rules live in lib/ledger.ts and the numbers in
// lib/scoreStats.ts; this file is the board (戰況), its sheets, and the
// stats views (統計).
//
// The store - the game in progress, finished games and the player roster -
// is owned by App (so the Scoring tab can send a hand here) and saved to
// localStorage on every change.
//
// The pieces live in scores/: shared building blocks, the sheets, the board,
// 統計, and live sharing - 戰況's 線上 button: this phone's game on other
// phones as it's scored (live.tsx), or someone else's game followed here in
// 戰況 (online.tsx).

import { useEffect, useMemo, useState } from "react";
import { DEFAULT_SETTINGS, newGame, replay, type ScoreGame, type ScoreStore } from "@mjwaits/shared/engine/ledger";
import { unreadableScores, UNREADABLE_SCORES_KEY } from "./lib/scoreStore";
import { type ScoreSnapshot } from "./lib/scoreShare";
import { playerStats, trend } from "./lib/scoreStats";
import { type RecordRequest, type ScoreHandRequest, type SeatingResult, fmt, signed, tone, SectionHead, Segmented, withRoster } from "./scores/shared";

// TaiRulesSheet borrows the sheet and its controls; App the requests it sends.
export { NumberField, Segmented, Sheet, Toggle } from "./scores/shared";
export type { RecordRequest, ScoreHandRequest, SeatingResult } from "./scores/shared";
import { Setup } from "./scores/sheets";
import { Board } from "./scores/board";
import { TrendChart, TrendSummary, PlayerCard, type StatsView, saveBackupFile, BackupCard, StatsPanel, HandsTable } from "./scores/stats";
import { FollowView } from "./scores/online";
import { entryByOf, LiveSheet, Toast, useHostLive, useToast } from "./scores/live";
import { loadOnline, saveOnline, tokenFor, withoutRoom } from "./lib/online";
import { Icons } from "./scores/shared";

// ---- The tab ------------------------------------------------------------------------


// What a shared link opens: the game as it stood when it was shared,
// read-only, in the board's colours. Nothing here touches this phone's own
// scores.
export function SharedScoresView({ snap, onClose }: { snap: ScoreSnapshot; onClose: () => void }) {
  const ranked = [...snap.players].sort((a, b) => b.t - a.t);
  // A v2 link carries the whole game: replay it for the same Stats views as
  // the sender's - 走勢, 局 and 玩家 - read-only, in the sender's colours.
  const shared = useMemo(() => {
    if (!snap.game) return null;
    const game = snap.game;
    const state = replay(game);
    const store: ScoreStore = {
      active: null,
      history: [],
      roster: Object.entries(snap.colors ?? {}).map(([name, color]) => ({ name, color })),
      settings: { ...DEFAULT_SETTINGS, ...game.settings },
    };
    return { game, state, store, stats: playerStats(state, game).filter((x) => x.hands > 0), series: trend(state).series };
  }, [snap]);
  const [view, setView] = useState<"trend" | "hands" | "player">("trend");
  const [playerIndex, setPlayerIndex] = useState(0);
  const when = new Date(snap.at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  return (
    <section className="panel scores-panel sc-shared">
      <div className="card sc-shared-head">
        <span className="sc-shared-kicker">Shared scores · read-only</span>
        <h2 className="sc-shared-title">{snap.name ?? "Mahjong scores"}</h2>
        <p className="sc-help">
          {new Date(snap.started).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })} · {snap.label} · 局{snap.hands} · 東{snap.east} 圈{snap.circle}
          {snap.ended && " · ended"}
        </p>
      </div>
      <div className="card sc-list-card">
        {ranked.map((p, i) => (
          <div key={p.n} className="sc-leader sc-shared-row">
            <span className={`sc-leader-rank is-${i + 1}`}>{i + 1}</span>
            <span className={`sc-mono sc-mono-md sc-c${p.c >= 0 ? p.c : "x"}`} aria-hidden="true">
              {[...p.n][0]?.toUpperCase()}
            </span>
            <span className="sc-leader-id">
              <span className="sc-leader-name">
                {p.n}
                {p.n === snap.dealer && !snap.ended && <span className="sc-zhuang-tag sc-shared-zhuang">莊</span>}
              </span>
              <span className="sc-leader-sub">
                胡{p.w} · 摸{p.s} · 銃{p.d}
              </span>
            </span>
            <strong className={`sc-leader-total ${tone(p.t)}`}>{signed(p.t)}</strong>
          </div>
        ))}
      </div>
      <SectionHead zh="結帳" en="Settle up" />
      <div className="card">
        {snap.pays.length === 0 ? (
          <p className="sc-empty">Everyone is level.</p>
        ) : (
          <div className="sc-list">
            {snap.pays.map(([from, to, amount], i) => (
              <div key={i} className="sc-row">
                <span>
                  {from} → {to}
                </span>
                <strong>{fmt(amount)}</strong>
              </div>
            ))}
          </div>
        )}
        <p className="sc-help sc-help-block">At ×1. Shared {when} - a snapshot, so it won't update by itself.</p>
      </div>
      {shared && shared.state.hands.length > 0 && (
        <>
          <SectionHead zh="統計" en="Stats" />
          <div className="sc-views">
            <Segmented
              value={view}
              onChange={setView}
              options={[
                { value: "trend", label: "走勢" },
                { value: "hands", label: "局" },
                { value: "player", label: "玩家" },
              ]}
            />
          </div>
          {view === "trend" && (
            <div className="card">
              <div className="sc-card-head">
                <h3>走勢 Trend</h3>
                <span className="sc-help">累計分數 · Running totals, touch for a 局</span>
              </div>
              <TrendChart store={shared.store} state={shared.state} />
              <TrendSummary state={shared.state} />
            </div>
          )}
          {view === "hands" && <HandsTable store={shared.store} game={shared.game} state={shared.state} />}
          {view === "player" && shared.stats.length > 0 && (
            <PlayerCard
              store={shared.store}
              stats={shared.stats}
              seriesOf={(p) => shared.series.find((x) => x.player === p)?.values}
              index={Math.min(playerIndex, shared.stats.length - 1)}
              onIndex={setPlayerIndex}
            />
          )}
        </>
      )}
      <button type="button" className="sc-primary sc-shared-open" onClick={onClose}>
        Open MJWaits
      </button>
    </section>
  );
}

// When this phone isn't keeping the scores safely: the last change couldn't be
// saved (storage full or blocked), or saved scores couldn't be read when the
// app opened (a copy was kept). Either way, a file to keep them by.
function StorageWarning({ store, saveFailed }: { store: ScoreStore; saveFailed: boolean }) {
  const [unreadable, setUnreadable] = useState(() => unreadableScores());
  if (!saveFailed && !unreadable) return null;
  const saveUnreadable = () => {
    const blob = new Blob([unreadable ?? ""], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "mjwaits-scores-unreadable.json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <div className="card sc-storage-warning" role="alert">
      {saveFailed && (
        <p>
          <strong>儲存唔到 · Not saved</strong>
          This phone couldn't keep the last change (its storage is full or blocked) - a reload would lose it. Save a backup file now.
          <button type="button" className="sc-primary" onClick={() => saveBackupFile(store)}>
            儲存 Save file
          </button>
        </p>
      )}
      {unreadable && (
        <p>
          <strong>讀唔到舊紀錄 · Old scores unreadable</strong>
          The scores saved here couldn't be read when the app opened. A copy was kept - save it as a file to recover later.
          <span className="sc-storage-actions">
            <button type="button" className="sc-primary" onClick={saveUnreadable}>
              儲存副本 Save copy
            </button>
            <button
              type="button"
              className="sc-secondary"
              onClick={() => {
                try {
                  window.localStorage.removeItem(UNREADABLE_SCORES_KEY);
                } catch {
                  // Then it shows again next time - harmless.
                }
                setUnreadable(null);
              }}
            >
              唔要 Discard
            </button>
          </span>
        </p>
      )}
    </div>
  );
}

export function ScoresPanel({
  store,
  setStore,
  seatNames,
  request,
  onRequestDone,
  onScoreHand,
  onOpenSeating,
  seatingResult,
  onSeatingResultDone,
  saveFailed,
  joinCode = null,
}: {
  store: ScoreStore;
  setStore: (s: ScoreStore) => void;
  saveFailed?: boolean; // the last change couldn't be kept on this phone
  seatNames: readonly string[];
  request: RecordRequest | null;
  onRequestDone: () => void;
  onScoreHand?: (req: Omit<ScoreHandRequest, "nonce">) => void;
  onOpenSeating?: (names: string[], east: number | null) => void; // the Dice tab's Seating, for the seat ceremony (east: the provisional East's seat)
  seatingResult?: SeatingResult | null; // ...and what it came back with
  onSeatingResultDone?: () => void;
  joinCode?: string | null; // a ?room= link: follow that game (or open 線上 to join it)
}) {
  const [sub, setSub] = useState<"board" | "stats">("board");
  // This phone's game, live on others' (線上 on 戰況).
  const live = useHostLive(store, setStore);
  const liveToast = useToast(live.problem);
  // Someone else's game, followed here in 戰況 in place of this phone's own
  // (which is kept, and back when you leave). An invite link to a game this
  // phone already follows goes straight to it; to a new one, opens 線上 to join.
  const [following, setFollowing] = useState<string | null>(() => {
    const memory = loadOnline();
    if (joinCode) return tokenFor(memory, joinCode) && memory.sharing?.code !== joinCode ? joinCode : null;
    return memory.current;
  });
  const [liveOpen, setLiveOpen] = useState(() => !!joinCode && !following);
  const follow = (code: string, name: string) => {
    saveOnline({ ...loadOnline(), name, current: code });
    setFollowing(code);
    setLiveOpen(false);
    setSub("board");
  };
  const unfollow = (forget = false) => {
    const now = loadOnline();
    saveOnline(forget && following ? withoutRoom(now, following) : { ...now, current: null });
    setFollowing(null);
  };
  const [view, setView] = useState<StatsView>("trend");
  useEffect(() => {
    if (request || seatingResult) setSub("board");
  }, [request, seatingResult]);
  const game = store.active;
  const state = useMemo(() => (game ? replay(game) : null), [game]);

  // Every change stamps the game, so a backup merge keeps its latest copy.
  const update = (next: ScoreGame, extra: Partial<ScoreStore> = {}) => setStore({ ...store, ...extra, active: { ...next, updatedAt: Date.now() } });
  const endGame = () => {
    if (!game) return;
    // An empty game isn't kept, so there's no final state to send: just stop.
    if (live.code && game.events.length === 0) live.stop();
    const finished = { ...game, endedAt: Date.now(), updatedAt: Date.now() };
    setStore({ ...store, active: null, history: game.events.length > 0 ? [finished, ...store.history] : store.history });
  };
  const start = (seats: string[], dealer: number) => setStore({ ...store, roster: withRoster(store, seats), active: newGame(seats, dealer, store.settings) });

  return (
    <section className="panel scores-panel">
      <StorageWarning store={store} saveFailed={saveFailed ?? false} />
      <div className="segmented sub-tabs">
        <button type="button" className={sub === "board" ? "toggle-on" : undefined} aria-pressed={sub === "board"} onClick={() => setSub("board")}>
          戰況 Table
        </button>
        <button type="button" className={sub === "stats" ? "toggle-on" : undefined} aria-pressed={sub === "stats"} onClick={() => setSub("stats")}>
          統計 Stats
        </button>
      </div>
      {sub === "board" &&
        (following ? (
          <FollowView key={following} code={following} name={loadOnline().name} store={store} setStore={setStore} onLeave={unfollow} />
        ) : game && state ? (
          <Board
            store={store}
            game={game}
            state={state}
            update={update}
            onEndGame={endGame}
            request={request}
            onRequestDone={onRequestDone}
            onScoreHand={onScoreHand}
            onOpenSeating={onOpenSeating}
            seatingResult={seatingResult ?? null}
            onSeatingResultDone={onSeatingResultDone}
            live={{ on: live.code !== null, onOpen: () => setLiveOpen(true) }}
            entryBy={live.code ? entryByOf(live.room) : undefined}
          />
        ) : (
          <>
            <button type="button" className="card ol-entry" onClick={() => setLiveOpen(true)}>
              <span className="ol-entry-icon">{Icons.live}</span>
              <span>
                <strong>線上</strong> · Follow a game on this phone, or reopen one you shared
              </span>
            </button>
            <Setup store={store} suggestion={seatNames} onStart={start} waitingHand={request !== null} />
            <BackupCard store={store} setStore={setStore} />
          </>
        ))}
      {sub === "stats" && <StatsPanel store={store} setStore={setStore} view={view} setView={setView} />}
      {liveOpen && <LiveSheet live={live} store={store} joinCode={joinCode} onFollow={follow} onClose={() => setLiveOpen(false)} />}
      {!following && <Toast toast={liveToast} />}
    </section>
  );
}
