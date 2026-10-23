// Scores tab, 線上 Online: someone else's 戰況 game, live on this phone.
//
// Join with the code (or a ?room= link, or the QR code) and the game shows
// here as the host keeps score - totals, the last change, 拉, every hand and
// the trend. If the host lets you record, you get the same 戰況 board they
// have, and what you enter goes to everyone. Sharing your own game is done
// from 戰況 (its 線上 button), not here.

import { useMemo, useState } from "react";
import { replay, handAt, stepAt, type ScoreGame, type ScoreStore } from "@mjwaits/shared/engine/ledger";
import { cleanNickname, NICKNAME_MAX, normalizeRoomCode, ROOM_CODE_LENGTH } from "@mjwaits/shared/protocol/limits";
import type { RoomView } from "@mjwaits/shared/protocol/server";
import { loadOnline, roomInfo, saveOnline, withoutRoom, type OnlineMemory } from "../lib/online";
import { Board, EventRow, HandRow } from "./board";
import { STATUS_TEXT, Toast, useLiveGame, useToast } from "./live";
import { fmt, Icons, SEAT_AREAS, SectionHead, signed, tone, withRoster } from "./shared";
import { TrendChart } from "./stats";

// The store the shared pieces expect, made up for a game that isn't this
// phone's: each player in the host's colour, the game's own settings.
function liveStore(game: ScoreGame, colors: Record<string, number>): ScoreStore {
  const roster = Object.entries(colors).map(([name, color]) => ({ name, color }));
  for (const [i, name] of game.seats.entries()) if (!roster.some((r) => r.name === name)) roster.push({ name, color: i });
  return { active: game, history: [], roster, settings: replay(game).settings };
}

// ---- The panel --------------------------------------------------------------------

export function OnlinePanel({ store, setStore, joinCode }: { store: ScoreStore; setStore: (s: ScoreStore) => void; joinCode: string | null }) {
  const [memory, setMemory] = useState<OnlineMemory>(() => loadOnline());
  const remember = (next: OnlineMemory) => {
    setMemory(next);
    saveOnline(next);
  };
  // A ?room= link wins over the game left open last time.
  const [current, setCurrent] = useState<string | null>(() => (joinCode && memory.rooms.some((r) => r.code === joinCode) ? joinCode : joinCode ? null : memory.current));
  const enter = (code: string, name: string) => {
    remember({ ...loadOnline(), name, current: code });
    setCurrent(code);
  };
  const leave = (forget = false) => {
    const now = loadOnline();
    remember(forget && current ? withoutRoom(now, current) : { ...now, current: null });
    setCurrent(null);
  };
  if (!current)
    return <OnlineStart memory={memory} joinCode={joinCode} onEnter={enter} onForget={(code) => remember(withoutRoom(loadOnline(), code))} />;
  return <LiveRoom key={current} code={current} name={memory.name} store={store} setStore={setStore} onLeave={leave} />;
}

// ---- Joining ------------------------------------------------------------------------

function OnlineStart({
  memory,
  joinCode,
  onEnter,
  onForget,
}: {
  memory: OnlineMemory;
  joinCode: string | null;
  onEnter: (code: string, name: string) => void;
  onForget: (code: string) => void;
}) {
  const [name, setName] = useState(memory.name);
  const [code, setCode] = useState(joinCode ?? "");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const clean = cleanNickname(name);
  const join = async (joining = normalizeRoomCode(code)) => {
    if (!clean) return setProblem("Pick a name first, so the host knows who's watching");
    if (!joining) return setProblem(`A code is ${ROOM_CODE_LENGTH} letters and numbers`);
    setBusy(true);
    setProblem(null);
    try {
      const info = await roomInfo(joining);
      if (!info) setProblem(`No game ${joining} - check the code (a shared game closes two days after its last change)`);
      else onEnter(joining, clean);
    } catch {
      setProblem("Couldn't reach the server - check the connection");
    } finally {
      setBusy(false);
    }
  };
  const mine = memory.sharing?.code;
  const followed = memory.rooms.filter((r) => r.code !== mine);
  return (
    <>
      <div className="card ol-start">
        <div className="sc-card-head">
          <h3>線上 Live scores</h3>
          <span className="sc-help">Follow a game on your own phone as it's scored</span>
        </div>
        <label className="ol-field">
          <span className="ol-field-label">暱稱 Your name</span>
          <input className="sc-input" value={name} maxLength={NICKNAME_MAX * 2} placeholder="So the host knows who's watching" autoComplete="nickname" onChange={(e) => setName(e.target.value)} />
        </label>
        <div className="ol-join">
          <input
            className="sc-input ol-code-input"
            value={code}
            placeholder="CODE"
            aria-label="Game code"
            autoCapitalize="characters"
            autoComplete="off"
            spellCheck={false}
            maxLength={ROOM_CODE_LENGTH + 2}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            onKeyDown={(e) => e.key === "Enter" && void join()}
          />
          <button type="button" className="sc-primary" onClick={() => void join()} disabled={busy}>
            {busy ? "Joining…" : "加入 Join"}
          </button>
        </div>
        {problem && (
          <p className="ol-problem" role="alert">
            {problem}
          </p>
        )}
        <p className="sc-help sc-help-block">{mine ? `Your 戰況 game is live as ${mine} - manage it with 線上 on 戰況.` : "To share your own game, tap 線上 on 戰況."}</p>
      </div>
      {followed.length > 0 && (
        <>
          <SectionHead zh="最近" en="Games you've followed" />
          <div className="card">
            <div className="sc-list">
              {followed.map((r) => (
                <div key={r.code} className="sc-row">
                  <span className="ol-code-small">{r.code}</span>
                  <span className="ol-row-actions">
                    <button type="button" className="sc-secondary" onClick={() => void join(r.code)} disabled={busy}>
                      Open
                    </button>
                    <button type="button" className="sc-icon-button" onClick={() => onForget(r.code)} aria-label={`Forget ${r.code}`}>
                      {Icons.close}
                    </button>
                  </span>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </>
  );
}

// ---- A live game ------------------------------------------------------------------

function LiveRoom({
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

  return (
    <>
      <div className="card ol-head">
        <div className="ol-head-main">
          <span className="ol-head-label">{host ? `${host.name}'s game` : "Live game"}</span>
          <span className="ol-code">{code}</span>
        </div>
        <span className={`ol-status is-${ended ? "closed" : status}`} role="status">
          <span className="ol-dot" aria-hidden="true" />
          {ended ? "Final" : STATUS_TEXT[status]}
        </span>
        <div className="ol-head-actions">
          {meHere && room?.phase === "live" && <span className={`ol-tag ol-role${canRecord ? " is-me" : ""}`}>{canRecord ? "You can record" : "Watching"}</span>}
          <button type="button" className="sc-secondary" onClick={() => onLeave()}>
            Leave
          </button>
        </div>
      </div>

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

      {gone || stuck ? null : !room ? (
        <p className="sc-empty">Connecting…</p>
      ) : !game ? (
        <p className="sc-empty">Waiting for {host?.name ?? "the host"} to put the game up…</p>
      ) : canRecord && copy ? (
        <RecordBoard game={copy} colors={room.colors} onChange={setCopy} />
      ) : (
        <WatchView game={game} colors={room.colors} room={room} store={store} setStore={setStore} />
      )}
      <Toast toast={toast} />
    </>
  );
}

// Recording: the full 戰況 board on this phone's copy, which GameSync sends.
function RecordBoard({ game, colors, onChange }: { game: ScoreGame; colors: Record<string, number>; onChange: (g: ScoreGame) => void }) {
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
    />
  );
}

// Watching: the board as it stands, every hand, and the trend.
function WatchView({ game, colors, room, store, setStore }: { game: ScoreGame; colors: Record<string, number>; room: RoomView; store: ScoreStore; setStore: (s: ScoreStore) => void }) {
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
      if (ev.t === "win" || ev.t === "draw") {
        const h = handAt(state, i);
        return h ? <HandRow key={i} h={h} store={shown} /> : null;
      }
      return <EventRow key={i} ev={ev} deltas={stepAt(state, i)?.deltas ?? {}} />;
    });
  const colorOf = (player: string) => shown.roster.find((r) => r.name === player)?.color ?? "x";

  return (
    <>
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
          <SectionHead zh="走勢" en="Trend" />
          <div className="card">
            <TrendChart store={shown} state={state} />
          </div>
        </>
      )}

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
