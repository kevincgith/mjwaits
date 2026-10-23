// Scores tab, following someone else's 戰況 game on this phone.
//
// Joined from the 線上 sheet (or a ?room= link, or the QR code), the game
// shows in 戰況 in place of this phone's own as the host keeps score - totals,
// the last change, 拉, every hand and the trend. If the host lets you record,
// you get the same 戰況 board they have, and what you enter goes to everyone.
// 線上 in the toolbar shows the room's status, and Leave.

import { useMemo, useRef, useState } from "react";
import { replay, handAt, stepAt, type ScoreGame, type ScoreStore } from "@mjwaits/shared/engine/ledger";
import type { RoomView } from "@mjwaits/shared/protocol/server";
import { Board, EventRow, HandRow } from "./board";
import { ChangesList, entryByOf, InviteBlock, STATUS_TEXT, Toast, useLiveGame, useToast } from "./live";
import { fmt, Icons, SEAT_AREAS, SectionHead, Sheet, signed, tone, withRoster } from "./shared";
import { TrendChart } from "./stats";

// The store the shared pieces expect, made up for a game that isn't this
// phone's: each player in the host's colour, the game's own settings.
function liveStore(game: ScoreGame, colors: Record<string, number>): ScoreStore {
  const roster = Object.entries(colors).map(([name, color]) => ({ name, color }));
  for (const [i, name] of game.seats.entries()) if (!roster.some((r) => r.name === name)) roster.push({ name, color: i });
  return { active: game, history: [], roster, settings: replay(game).settings };
}

// ---- A live game ------------------------------------------------------------------

export function FollowView({
  code,
  name,
  store,
  setStore,
  onLeave,
}: {
  code: string;
  name: string;
  store: ScoreStore;
  setStore: (s: ScoreStore) => void;
  onLeave: (forget?: boolean) => void;
}) {
  // This phone's copy of the game: what a recorder edits, kept in step.
  const [copy, setCopy] = useState<ScoreGame | null>(null);
  const live = useLiveGame({ code, name, local: copy, onAdopt: setCopy });
  const toast = useToast(live.problem);
  const { room, me, status, gone } = live;
  const meHere = room?.people.find((p) => p.id === me?.id);
  const host = room?.people.find((p) => p.host);
  const canRecord = (meHere?.canRecord ?? false) && room?.phase === "live";
  const game = copy ?? room?.game ?? null;
  const stuck = status === "closed" && live.problem && (live.problem.code === "nameTaken" || live.problem.code === "version");
  const ended = room?.phase === "ended";

  const [statusOpen, setStatusOpen] = useState(false);
  const openStatus = () => setStatusOpen(true);
  const entryBy = entryByOf(room);

  return (
    <>
      {gone && (
        <div className="card ol-stuck" role="alert">
          <p>Game {code} has closed - a shared game closes two days after its last change.</p>
          <button type="button" className="sc-primary" onClick={() => onLeave(true)}>
            OK
          </button>
        </div>
      )}
      {stuck && (
        <div className="card ol-stuck" role="alert">
          <p>{live.problem!.message}</p>
          {live.problem!.code === "version" ? (
            <button type="button" className="sc-primary" onClick={() => window.location.reload()}>
              Reload
            </button>
          ) : (
            <button type="button" className="sc-primary" onClick={() => onLeave()}>
              Pick another name
            </button>
          )}
        </div>
      )}

      {gone || stuck ? null : !room || !game ? (
        <>
          <WatchTools onStatus={openStatus} status={status} />
          <p className="sc-empty">{!room ? "Connecting…" : `Waiting for ${host?.name ?? "the host"} to put the game up…`}</p>
        </>
      ) : canRecord && copy ? (
        <RecordBoard game={copy} colors={room.colors} onChange={setCopy} onStatus={openStatus} entryBy={entryBy} />
      ) : (
        <WatchView game={game} colors={room.colors} room={room} store={store} setStore={setStore} onStatus={openStatus} status={status} entryBy={entryBy} />
      )}
      {statusOpen && (
        <Sheet
          title={
            <span className="ol-live-title">
              線上 <span className="ol-code">{code}</span>
            </span>
          }
          subtitle={
            <span className="ol-status-line">
              <span className={`ol-status is-${ended ? "closed" : status}`}>
                <span className="ol-dot" aria-hidden="true" />
                {ended ? "Final" : STATUS_TEXT[status]}
              </span>
              <span>{host ? `${host.name}'s game` : "Live game"}</span>
              {meHere && room?.phase === "live" && <span className={`ol-tag${canRecord ? " is-me" : ""}`}>{canRecord ? "You can record" : "Watching"}</span>}
            </span>
          }
          onClose={() => setStatusOpen(false)}
          actions={
            <button type="button" className="sc-secondary" onClick={() => onLeave()}>
              Leave
            </button>
          }
        >
          {room && (
            <>
              <h3 className="ol-people-head">Who's here</h3>
              <div className="sc-list">
                {room.people.map((p) => (
                  <div key={p.id} className="sc-row">
                    <span className="ol-seat-name">
                      <span className={`ol-dot${p.connected ? " is-on" : ""}`} aria-label={p.connected ? "connected" : "away"} />
                      {p.name}
                      {p.id === me?.id && <span className="ol-tag is-me">You</span>}
                    </span>
                    <span className="sc-help">{p.host ? "Host" : p.canRecord ? "Records" : "Watches"}</span>
                  </div>
                ))}
              </div>
              <ChangesList room={room} />
              <h3 className="ol-people-head">Invite</h3>
              <InviteBlock code={code} />
            </>
          )}
        </Sheet>
      )}
      <Toast toast={toast} />
    </>
  );
}

// A watcher's toolbar, in the 戰況 toolbar's style: jump to 最近 or 走勢, and
// 線上 for the room's status.
function WatchTools({ onStatus, status, onRecent, onTrend }: { onStatus: () => void; status: string; onRecent?: () => void; onTrend?: () => void }) {
  const tools = [
    ...(onRecent ? [{ label: "最近", icon: Icons.recent, onClick: onRecent }] : []),
    ...(onTrend ? [{ label: "走勢", icon: Icons.trend, onClick: onTrend }] : []),
    { label: "線上", icon: Icons.live, onClick: onStatus, on: status === "open" },
  ];
  return (
    <div className="sc-toolbar">
      <div className="sc-tools" role="toolbar" aria-label="Live game" style={{ gridTemplateColumns: `repeat(${tools.length}, minmax(0, 1fr))` }}>
        {tools.map((t) => (
          <button key={t.label} type="button" onClick={t.onClick} className={"on" in t && t.on ? "is-on" : undefined}>
            <span className="sc-tool-icon">{t.icon}</span>
            <span className="sc-tool-label">{t.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

// Recording: the full 戰況 board on this phone's copy, which GameSync sends.
function RecordBoard({
  game,
  colors,
  onChange,
  onStatus,
  entryBy,
}: {
  game: ScoreGame;
  colors: Record<string, number>;
  onChange: (g: ScoreGame) => void;
  onStatus: () => void;
  entryBy?: (index: number) => string | undefined;
}) {
  const store = useMemo(() => liveStore(game, colors), [game, colors]);
  const state = useMemo(() => replay(game), [game]);
  return (
    <Board
      store={store}
      game={game}
      state={state}
      update={(next) => onChange({ ...next, updatedAt: Date.now() })}
      onEndGame={() => {}}
      request={null}
      onRequestDone={() => {}}
      seatingResult={null}
      recorder
      live={{ on: true, onOpen: onStatus }}
      entryBy={entryBy}
    />
  );
}

// Watching: the board as it stands, every hand, and the trend.
function WatchView({
  game,
  colors,
  room,
  store,
  setStore,
  onStatus,
  status,
  entryBy,
}: {
  game: ScoreGame;
  colors: Record<string, number>;
  room: RoomView;
  store: ScoreStore;
  setStore: (s: ScoreStore) => void;
  onStatus: () => void;
  status: string;
  entryBy?: (index: number) => string | undefined;
}) {
  const recentRef = useRef<HTMLDivElement>(null);
  const trendRef = useRef<HTMLDivElement>(null);
  const jump = (el: HTMLElement | null) => el?.scrollIntoView({ behavior: "smooth", block: "start" });
  const shown = useMemo(() => liveStore(game, colors), [game, colors]);
  const state = useMemo(() => replay(game), [game]);
  const last = state.steps.at(-1);
  const kept = store.history.some((g) => g.id === game.id) || store.active?.id === game.id;
  const keep = () =>
    setStore({
      ...store,
      roster: withRoster(store, state.players),
      history: [{ ...game, endedAt: game.endedAt ?? Date.now() }, ...store.history].sort((a, b) => b.startedAt - a.startedAt),
    });
  const rows = game.events
    .map((ev, i) => ({ ev, i }))
    .reverse()
    .map(({ ev, i }) => {
      const by = entryBy?.(i);
      const row = ev.t === "win" || ev.t === "draw" ? (handAt(state, i) ? <HandRow h={handAt(state, i)!} store={shown} /> : null) : <EventRow ev={ev} deltas={stepAt(state, i)?.deltas ?? {}} />;
      return (
        row && (
          <div key={i} className="sc-recent-row">
            {row}
            {by && <span className="sc-entry-by">{by}</span>}
          </div>
        )
      );
    });
  const colorOf = (player: string) => shown.roster.find((r) => r.name === player)?.color ?? "x";

  return (
    <>
      <WatchTools onStatus={onStatus} status={room.phase === "ended" ? "closed" : status} onRecent={() => jump(recentRef.current)} onTrend={state.hands.length > 1 ? () => jump(trendRef.current) : undefined} />
      {room.phase === "ended" && (
        <div className="sc-banner" role="status">
          <span>
            <strong>Final</strong> · the host has stopped sharing - these are the scores as they ended.
          </span>
        </div>
      )}
      <div className="sc-board ol-board">
        <div className="sc-status">
          {game.name && <span className="sc-status-name">{game.name}</span>}
          <span className="sc-status-round">{state.label}</span>
          <span className="sc-status-meta sc-status-wrap">
            <span>局{state.hands.length + 1}</span>
            <span>東{state.east}</span>
            <span>圈{state.circle}</span>
          </span>
        </div>
        {state.seats.map((player, s) => {
          const total = state.totals[player] ?? 0;
          const delta = last?.deltas[player];
          const isDealer = s === state.dealer;
          return (
            <div key={s} className={`sc-seat sc-area-${SEAT_AREAS[s]}`}>
              <div className="sc-card-box">
                <div className={`sc-card sc-c${colorOf(player)}${isDealer ? " is-dealer" : ""}`}>
                  <span className={`sc-card-top${[...player].length >= 6 ? " is-long" : ""}`}>
                    <span className="sc-card-name">{player}</span>
                    {isDealer && <span className="sc-zhuang-tag">{state.streak > 0 ? `莊${state.streak}` : "莊"}</span>}
                  </span>
                  <span className="sc-card-score">
                    <span className={`sc-card-total ${tone(total)}`}>{fmt(total)}</span>
                    {delta !== undefined && delta !== 0 && (
                      <span key={last!.eventIndex} className={`sc-delta ${tone(delta)}`} title="Last change">
                        <span className="sc-delta-label">上局</span> {signed(delta)}
                      </span>
                    )}
                  </span>
                </div>
              </div>
            </div>
          );
        })}
        {state.settings.jackpot && (
          <div className="sc-center">
            <div className={`sc-jackpot${state.pot > 0 ? " is-live" : ""}`} aria-label={`Jackpot ${state.pot}`}>
              <span className="sc-jackpot-label">Jackpot</span>
              <span className="sc-jackpot-value">{fmt(state.pot)}</span>
            </div>
          </div>
        )}
      </div>

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

      {state.hands.length > 1 && (
        <>
          <div ref={trendRef} />
          <SectionHead zh="走勢" en="Trend" />
          <div className="card">
            <TrendChart store={shown} state={state} />
          </div>
        </>
      )}

      <div ref={recentRef} />
      <SectionHead zh="最近" en={game.events.length ? `${state.hands.length}局 · ${game.events.length} ${game.events.length === 1 ? "entry" : "entries"}` : "Nothing recorded yet"} />
      <div className="card">{game.events.length ? <div className="sc-list sc-list-hands">{rows}</div> : <p className="sc-empty">Hands show here as they're recorded.</p>}</div>

      {room.phase === "ended" && (
        <div className="ol-summary-actions">
          <button type="button" className="sc-primary" onClick={keep} disabled={kept}>
            {kept ? "Kept in 統計 ✓" : "存入統計 Keep in my Stats"}
          </button>
        </div>
      )}
    </>
  );
}
