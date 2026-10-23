// Scores tab, 線上 Online: one shared scoreboard for a table where every
// player has their own phone. The room lives on the multiplayer server
// (worker/); this is its face.
//
// Start: a nickname, then 開枱 (make a table) or 加入 (join one by its code
// or a ?room= link). Lobby: take a seat, the host sets the table up and
// starts. Then the board - the same cards and 食胡 / 特別獎罰 sheets as 戰況,
// except an entry goes to the server and comes back to every phone, and
// 還原 needs a second player's yes. When the host ends it, the summary.
//
// The scores themselves are the server's: it replays the room's entries with
// the shared ledger and sends the board. This panel replays the same entries
// only for the sheets' previews and the history list.

import { useEffect, useMemo, useRef, useState } from "react";
import qrcode from "qrcode-generator";
import { handAt, replay, SEATS, stepAt, type ReplayState, type ScoreEvent, type ScoreGame, type ScoreStore } from "@mjwaits/shared/engine/ledger";
import type { ClientMessage, RoomSettings } from "@mjwaits/shared/protocol/client";
import { cleanNickname, NICKNAME_MAX, normalizeRoomCode, ROOM_CODE_LENGTH } from "@mjwaits/shared/protocol/limits";
import type { ErrorCode, RoomView } from "@mjwaits/shared/protocol/server";
import {
  createRoom,
  joinLink,
  loadOnline,
  RoomClient,
  roomInfo,
  saveOnline,
  tokenFor,
  withoutRoom,
  withToken,
  type ConnectionStatus,
  type OnlineMemory,
} from "../lib/online";
import { EventRow, HandRow } from "./board";
import { Confirm, HandSheet } from "./sheets";
import { fmt, Icons, NumberField, SEAT_AREAS, SectionHead, Segmented, Sheet, signed, Toggle, tone, WIND_CHARS, withRoster } from "./shared";

type Send = Exclude<ClientMessage, { t: "hello" }>;
type Problem = { code: ErrorCode | "offline"; message: string; at: number };

// ---- The connection, as React state -----------------------------------------

function useRoom(code: string, name: string) {
  const [room, setRoom] = useState<RoomView | null>(null);
  const [me, setMe] = useState<{ name: string; host: boolean } | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [problem, setProblem] = useState<Problem | null>(null);
  const client = useRef<RoomClient | null>(null);
  useEffect(() => {
    const c = new RoomClient({
      code,
      name,
      token: tokenFor(loadOnline(), code),
      onWelcome: (w) => {
        setMe({ name: w.name, host: w.host });
        saveOnline({ ...withToken(loadOnline(), code, w.token), current: code });
      },
      onRoom: setRoom,
      onStatus: setStatus,
      onError: (code, message) => setProblem({ code, message, at: Date.now() }),
    });
    client.current = c;
    // Back to the front, or back online: try now rather than at the next backoff.
    const nudge = () => document.visibilityState === "visible" && c.nudge();
    document.addEventListener("visibilitychange", nudge);
    window.addEventListener("online", nudge);
    return () => {
      document.removeEventListener("visibilitychange", nudge);
      window.removeEventListener("online", nudge);
      c.stop();
      client.current = null;
    };
    // The name only matters for the first hello; changing it later mustn't reconnect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);
  const send = (msg: Send) => {
    if (client.current?.send(msg)) return true;
    setProblem({ code: "offline", message: "Not connected - try again in a moment", at: Date.now() });
    return false;
  };
  return { room, me, status, problem, send };
}

// The store the shared sheets expect, made up for this room: each seat its
// own colour, and the room's ledger settings.
function roomStore(game: ScoreGame): ScoreStore {
  return { active: game, history: [], roster: game.seats.map((name, color) => ({ name, color })), settings: game.settings };
}

// What a sheet's finished entry is as a message to the room. 詐胡 is off in
// online rooms, so it never comes up.
function entryMessage(ev: ScoreEvent): Send | null {
  if (ev.t === "win")
    return { t: "win", winners: ev.winners.map((w) => ({ seat: w.seat, tai: w.tai })), from: ev.from, ...(ev.jackpotTo ? { jackpot: true } : {}) };
  if (ev.t === "bonus") return { t: "bonus", seat: ev.seat, kind: ev.kind, amount: ev.amount, ...(ev.other === undefined ? {} : { other: ev.other }) };
  return null;
}

// ---- The panel --------------------------------------------------------------------

export function OnlinePanel({ store, setStore, joinCode }: { store: ScoreStore; setStore: (s: ScoreStore) => void; joinCode: string | null }) {
  const [memory, setMemory] = useState<OnlineMemory>(() => loadOnline());
  const remember = (next: OnlineMemory) => {
    setMemory(next);
    saveOnline(next);
  };
  // A ?room= link wins over the room left open last time.
  const [current, setCurrent] = useState<string | null>(() => (joinCode && tokenFor(memory, joinCode) ? joinCode : joinCode ? null : memory.current));
  const enter = (code: string, name: string) => {
    remember({ ...memory, name, current: code });
    setCurrent(code);
  };
  const leave = () => {
    remember({ ...loadOnline(), current: null });
    setMemory(loadOnline());
    setCurrent(null);
  };
  if (!current) return <OnlineStart memory={memory} joinCode={joinCode} onEnter={enter} onForget={(code) => remember(withoutRoom(memory, code))} />;
  return <OnlineRoom key={current} code={current} name={memory.name} store={store} setStore={setStore} onLeave={leave} />;
}

// ---- Start: make or join a table -------------------------------------------------

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
  const [busy, setBusy] = useState<"create" | "join" | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const clean = cleanNickname(name);
  const parsed = normalizeRoomCode(code);
  const needName = () => {
    if (clean) return false;
    setProblem("Pick a nickname first");
    return true;
  };
  const create = async () => {
    if (needName()) return;
    setBusy("create");
    setProblem(null);
    try {
      onEnter(await createRoom(), clean!);
    } catch (e) {
      setProblem(e instanceof Error && e.message !== "Failed to fetch" ? e.message : "Couldn't reach the server - check the connection");
    } finally {
      setBusy(null);
    }
  };
  const join = async (joining = parsed) => {
    if (needName()) return;
    if (!joining) return setProblem(`A table code is ${ROOM_CODE_LENGTH} letters and numbers`);
    setBusy("join");
    setProblem(null);
    try {
      const info = await roomInfo(joining);
      if (!info) setProblem(`No table ${joining} - check the code (tables close after two idle days)`);
      else onEnter(joining, clean!);
    } catch {
      setProblem("Couldn't reach the server - check the connection");
    } finally {
      setBusy(null);
    }
  };
  return (
    <>
      <div className="card ol-start">
        <div className="sc-card-head">
          <h3>線上 Online table</h3>
          <span className="sc-help">Everyone at the table on their own phone, one live scoreboard</span>
        </div>
        <label className="ol-field">
          <span className="ol-field-label">暱稱 Nickname</span>
          <input
            className="sc-input"
            value={name}
            maxLength={NICKNAME_MAX * 2}
            placeholder="What the table calls you"
            autoComplete="nickname"
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <div className="ol-start-actions">
          <button type="button" className="sc-primary" onClick={() => void create()} disabled={busy !== null}>
            {busy === "create" ? "Opening…" : "開枱 Create a table"}
          </button>
        </div>
        <div className="ol-join">
          <input
            className="sc-input ol-code-input"
            value={code}
            placeholder="CODE"
            aria-label="Table code"
            autoCapitalize="characters"
            autoComplete="off"
            spellCheck={false}
            maxLength={ROOM_CODE_LENGTH + 2}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            onKeyDown={(e) => e.key === "Enter" && void join()}
          />
          <button type="button" className="sc-secondary" onClick={() => void join()} disabled={busy !== null}>
            {busy === "join" ? "Joining…" : "加入 Join"}
          </button>
        </div>
        {problem && (
          <p className="ol-problem" role="alert">
            {problem}
          </p>
        )}
      </div>
      {memory.rooms.length > 0 && (
        <>
          <SectionHead zh="最近" en="Your tables" />
          <div className="card">
            <div className="sc-list">
              {memory.rooms.map((r) => (
                <div key={r.code} className="sc-row">
                  <span className="ol-code-small">{r.code}</span>
                  <span className="ol-row-actions">
                    <button type="button" className="sc-secondary" onClick={() => void join(r.code)} disabled={busy !== null}>
                      Rejoin
                    </button>
                    <button type="button" className="sc-icon-button" onClick={() => onForget(r.code)} aria-label={`Forget table ${r.code}`}>
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

// ---- A room ------------------------------------------------------------------------

const STATUS_TEXT: Record<ConnectionStatus, string> = {
  connecting: "Connecting…",
  open: "Live",
  reconnecting: "Reconnecting…",
  closed: "Offline",
};

function OnlineRoom({ code, name, store, setStore, onLeave }: { code: string; name: string; store: ScoreStore; setStore: (s: ScoreStore) => void; onLeave: () => void }) {
  const { room, me, status, problem, send } = useRoom(code, name);
  const [share, setShare] = useState(false);
  const [toast, setToast] = useState<Problem | null>(null);
  useEffect(() => {
    if (!problem) return;
    setToast(problem);
    const id = window.setTimeout(() => setToast((t) => (t?.at === problem.at ? null : t)), 3500);
    return () => window.clearTimeout(id);
  }, [problem]);
  const mySeat = room && me ? room.seats.findIndex((s) => s?.name === me.name) : -1;
  const seat = mySeat >= 0 ? mySeat : null;
  // Fatal for this page: a name clash or an out-of-date page.
  const stuck = status === "closed" && problem && (problem.code === "nameTaken" || problem.code === "version");

  return (
    <>
      <div className="card ol-head">
        <div className="ol-head-main">
          <span className="ol-head-label">枱號 Table</span>
          <span className="ol-code" aria-label={`Table code ${code.split("").join(" ")}`}>
            {code}
          </span>
        </div>
        <span className={`ol-status is-${status}`} role="status">
          <span className="ol-dot" aria-hidden="true" />
          {STATUS_TEXT[status]}
        </span>
        <div className="ol-head-actions">
          <button type="button" className="sc-secondary" onClick={() => setShare(true)}>
            Invite
          </button>
          <button type="button" className="sc-secondary" onClick={onLeave}>
            Leave
          </button>
        </div>
      </div>

      {stuck && (
        <div className="card ol-stuck" role="alert">
          <p>{problem.message}</p>
          {problem.code === "version" ? (
            <button type="button" className="sc-primary" onClick={() => window.location.reload()}>
              Reload
            </button>
          ) : (
            <button type="button" className="sc-primary" onClick={onLeave}>
              Pick another nickname
            </button>
          )}
        </div>
      )}

      {!room ? (
        !stuck && <p className="sc-empty">Connecting to the table…</p>
      ) : room.phase === "lobby" ? (
        <Lobby room={room} seat={seat} host={me?.host ?? false} send={send} onInvite={() => setShare(true)} />
      ) : room.phase === "playing" && room.game && room.board ? (
        <LiveBoard room={room} game={room.game} seat={seat} host={me?.host ?? false} send={send} />
      ) : room.summary && room.game ? (
        <Summary room={room} game={room.game} store={store} setStore={setStore} onLeave={onLeave} />
      ) : null}

      {share && <InviteSheet code={code} onClose={() => setShare(false)} />}
      {toast && (
        <div key={toast.at} className="sc-toast" role="status">
          <span className="sc-toast-text">{toast.message}</span>
        </div>
      )}
    </>
  );
}

function InviteSheet({ code, onClose }: { code: string; onClose: () => void }) {
  const url = joinLink(code);
  const svg = useMemo(() => {
    const qr = qrcode(0, "M");
    qr.addData(url);
    qr.make();
    return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  }, [url]);
  const [copied, setCopied] = useState(false);
  return (
    <Sheet
      title="Invite to the table"
      subtitle={`Scan, open the link, or type ${code} on 線上`}
      onClose={onClose}
      actions={
        <>
          <button
            type="button"
            className="sc-secondary"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(url);
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1500);
              } catch {
                window.prompt("Copy the link", url);
              }
            }}
          >
            {copied ? "Copied ✓" : "Copy link"}
          </button>
          {"share" in navigator && (
            <button
              type="button"
              className="sc-primary"
              onClick={async () => {
                try {
                  await navigator.share({ title: `MJWaits table ${code}`, url });
                } catch {
                  // Dismissed.
                }
              }}
            >
              Share link…
            </button>
          )}
        </>
      }
    >
      <div className="sc-qr" dangerouslySetInnerHTML={{ __html: svg }} role="img" aria-label={`QR code to join table ${code}`} />
      <p className="ol-code ol-code-sheet">{code}</p>
    </Sheet>
  );
}

// ---- Lobby: seats and the table's settings -------------------------------------------

// Each seat's wind, counted from the first dealer (東).
const windOf = (seat: number, firstDealer: number) => WIND_CHARS[(seat - firstDealer + SEATS) % SEATS];

function Lobby({ room, seat, host, send, onInvite }: { room: RoomView; seat: number | null; host: boolean; send: (m: Send) => boolean; onInvite: () => void }) {
  const s = room.settings;
  const seated = room.seats.filter(Boolean).length;
  const set = (patch: Partial<RoomSettings>) => send({ t: "setup", settings: { ...s, ...patch } });
  return (
    <>
      <SectionHead zh="座位" en="Seats" />
      <div className="card">
        <div className="sc-list">
          {room.seats.map((p, i) => (
            <div key={i} className={`sc-row ol-seat${i === seat ? " is-me" : ""}`}>
              <span className="ol-wind" aria-label={`${windOf(i, s.firstDealer)} seat`}>
                {windOf(i, s.firstDealer)}
              </span>
              <span className="ol-seat-name">
                {p ? (
                  <>
                    <span className={`ol-dot${p.connected ? " is-on" : ""}`} aria-label={p.connected ? "connected" : "away"} />
                    {p.name}
                    {p.host && <span className="ol-tag">Host</span>}
                    {i === seat && <span className="ol-tag is-me">You</span>}
                  </>
                ) : (
                  <span className="ol-empty">Empty</span>
                )}
              </span>
              {i === seat ? (
                <button type="button" className="sc-secondary" onClick={() => send({ t: "stand" })}>
                  Stand
                </button>
              ) : (
                !p && (
                  <button type="button" className="sc-primary" onClick={() => send({ t: "sit", seat: i })}>
                    Sit here
                  </button>
                )
              )}
            </div>
          ))}
        </div>
        <p className="sc-help sc-help-block">
          Sit in turn order, counter-clockwise from 東.{room.watching > 0 && ` ${room.watching} watching.`}{" "}
          {seated < SEATS && (
            <button type="button" className="ol-link" onClick={onInvite}>
              Invite players
            </button>
          )}
        </p>
      </div>

      <SectionHead zh="設定" en={host ? "Table settings" : "Table settings · set by the host"} />
      <div className="card">
        <div className="sc-list">
          <div className="sc-row">
            <span>起始籌碼 Starting chips</span>
            <NumberField value={s.startChips} onChange={(v) => set({ startChips: v })} label="Starting chips" pill disabled={!host} />
          </div>
          <div className="sc-row">
            <span>底 Base</span>
            <NumberField value={s.base} onChange={(v) => set({ base: v })} label="Base" disabled={!host} />
          </div>
          <div className="sc-row">
            <span>莊 Dealer</span>
            <NumberField value={s.dealerTai} onChange={(v) => set({ dealerTai: v })} label="Dealer" disabled={!host} />
          </div>
          <div className="sc-row">
            <span>連莊 Per streak</span>
            <NumberField value={s.streakTai} onChange={(v) => set({ streakTai: v })} label="Per streak" disabled={!host} />
          </div>
          <div className="sc-row">
            <span>
              一炮多響
              <span className="sc-help ol-sub">{s.multiWin === "all" ? "Every winner off one discard is paid" : "截胡: the first winner in turn takes it"}</span>
            </span>
            {host ? <Toggle checked={s.multiWin === "all"} onChange={(v) => set({ multiWin: v ? "all" : "first" })} label="一炮多響" /> : <span>{s.multiWin === "all" ? "On" : "Off"}</span>}
          </div>
          <div className="sc-row">
            <span>
              Host can undo alone
              <span className="sc-help ol-sub">Otherwise another player agrees to each 還原</span>
            </span>
            {host ? <Toggle checked={s.hostCanUndo} onChange={(v) => set({ hostCanUndo: v })} label="Host can undo alone" /> : <span>{s.hostCanUndo ? "On" : "Off"}</span>}
          </div>
        </div>
        <div className="ol-first-dealer">
          <span>起莊 First dealer</span>
          {host ? (
            <Segmented
              small
              value={s.firstDealer}
              onChange={(v) => set({ firstDealer: v })}
              options={room.seats.map((p, i) => ({ value: i, label: p?.name ?? `Seat ${i + 1}` }))}
            />
          ) : (
            <strong>{room.seats[s.firstDealer]?.name ?? `Seat ${s.firstDealer + 1}`}</strong>
          )}
        </div>
      </div>

      {host ? (
        <button type="button" className="sc-primary ol-start-game" disabled={seated < SEATS} onClick={() => send({ t: "start" })}>
          {seated < SEATS ? `開始 Start · waiting for ${SEATS - seated} more` : "開始 Start the game"}
        </button>
      ) : (
        <p className="sc-hint">Waiting for the host to start</p>
      )}
    </>
  );
}

// ---- The live board ---------------------------------------------------------------

type BoardSheet = { kind: "hand"; seat: number; mode?: "bonus" } | { kind: "draw" } | { kind: "recent" } | { kind: "end" };

function LiveBoard({ room, game, seat, host, send }: { room: RoomView; game: ScoreGame; seat: number | null; host: boolean; send: (m: Send) => boolean }) {
  const board = room.board!;
  const store = useMemo(() => roomStore(game), [game]);
  const state = useMemo(() => replay(game), [game]);
  const [sheet, setSheet] = useState<BoardSheet | null>(null);
  const close = () => setSheet(null);
  const playing = seat !== null; // watchers see the board but don't record
  const pending = room.pendingUndo;
  const last = state.steps.at(-1);
  const showChips = room.settings.startChips > 0;
  // Turn the table so this phone's seat is at the bottom.
  const areaOf = (s: number) => SEAT_AREAS[(s - (seat ?? 0) + SEATS) % SEATS];
  const lastLabel = game.events.length ? describe(game.events[game.events.length - 1], state, game.events.length - 1) : "";
  const asker = pending ? room.seats[pending.by]?.name ?? "A player" : null;

  return (
    <>
      <div className="sc-toolbar">
        <div className="sc-tools" role="toolbar" aria-label="Table actions">
          <button type="button" onClick={() => send({ t: "undo" })} disabled={!playing || game.events.length === 0 || pending !== null}>
            <span className="sc-tool-icon">{Icons.undo}</span>
            <span className="sc-tool-label">還原</span>
          </button>
          <button type="button" onClick={() => setSheet({ kind: "recent" })}>
            <span className="sc-tool-icon">{Icons.recent}</span>
            <span className="sc-tool-label">最近</span>
          </button>
          {host && (
            <button type="button" onClick={() => setSheet({ kind: "end" })} disabled={pending !== null}>
              <span className="sc-tool-icon">{Icons.newGame}</span>
              <span className="sc-tool-label">結束</span>
            </button>
          )}
        </div>
      </div>

      {pending && (
        <div className="sc-banner ol-undo" role="status">
          <span>
            <strong>還原?</strong> {pending.by === seat ? "You asked" : `${asker} asked`} to take back {lastLabel || "the last entry"}
          </span>
          {pending.by === seat ? (
            <button type="button" className="sc-banner-action" onClick={() => send({ t: "undoVote", approve: false })}>
              Withdraw
            </button>
          ) : (
            playing && (
              <span className="ol-row-actions">
                <button type="button" className="sc-banner-action" onClick={() => send({ t: "undoVote", approve: true })}>
                  Agree
                </button>
                <button type="button" className="sc-banner-action" onClick={() => send({ t: "undoVote", approve: false })}>
                  No
                </button>
              </span>
            )
          )}
        </div>
      )}

      <div className="sc-board ol-board">
        <div className="sc-status">
          <span className="sc-status-round">{board.label}</span>
          <span className="sc-status-meta sc-status-wrap">
            <span>局{board.hands + 1}</span>
            {!playing && <span>Watching</span>}
          </span>
        </div>
        {game.seats.map((player, s) => {
          const isDealer = s === board.dealer;
          const delta = last?.deltas[player];
          const online = room.seats[s]?.connected ?? false;
          const shown = showChips ? board.chips[s] : board.net[s];
          return (
            <div key={s} className={`sc-seat sc-area-${areaOf(s)}`}>
              <div className="sc-card-box">
                <button
                  type="button"
                  className={`sc-card sc-c${s}${isDealer ? " is-dealer" : ""}${s === seat ? " ol-is-me" : ""}`}
                  onClick={() => playing && pending === null && setSheet({ kind: "hand", seat: s })}
                  disabled={!playing}
                  aria-label={`${player}${s === seat ? " (you)" : ""}, ${fmt(shown)}${online ? "" : ", away"}. Record a hand for ${player}`}
                >
                  <span className={`sc-card-top${[...player].length >= 6 ? " is-long" : ""}`}>
                    <span className={`ol-dot${online ? " is-on" : ""}`} aria-hidden="true" />
                    <span className="sc-card-name">{player}</span>
                    {isDealer && <span className="sc-zhuang-tag">{board.streak > 0 ? `莊${board.streak}` : "莊"}</span>}
                  </span>
                  <span className="sc-card-score">
                    <span className={`sc-card-total ${showChips ? "" : tone(shown)}`}>{fmt(shown)}</span>
                    {delta !== undefined && delta !== 0 && (
                      <span key={last!.eventIndex} className={`sc-delta ${tone(delta)}`} title="Last entry">
                        <span className="sc-delta-label">上局</span> {signed(delta)}
                      </span>
                    )}
                  </span>
                </button>
                {playing && (
                  <div className="sc-card-foot">
                    <button type="button" className="sc-card-bonus" onClick={() => pending === null && setSheet({ kind: "hand", seat: s, mode: "bonus" })} aria-label={`特別獎罰 for ${player}`}>
                      <span className="sc-card-bonus-mark">{Icons.plusMinus}</span>
                      <span aria-hidden="true">獎罰</span>
                    </button>
                  </div>
                )}
              </div>
            </div>
          );
        })}
        <div className="sc-center">
          <button type="button" className="sc-draw" onClick={() => setSheet({ kind: "draw" })} disabled={!playing || pending !== null}>
            <span className="sc-draw-zh">流局</span>
            <span className="sc-draw-en">Draw</span>
          </button>
          <div className={`sc-jackpot${board.pot > 0 ? " is-live" : ""}`} aria-label={`Jackpot ${board.pot}`}>
            <span className="sc-jackpot-label">Jackpot</span>
            <span className="sc-jackpot-value">{fmt(board.pot)}</span>
          </div>
        </div>
      </div>
      {board.hands === 0 && playing && <p className="sc-hint">Tap the winner to record a hand · 流局 for a draw</p>}

      {board.lahs.length > 0 && (
        <div className="card ol-lahs">
          {board.lahs.map((l) => (
            <span key={`${l.holder}>${l.pulled}`} className="ol-lah">
              {l.holder} 拉 {l.pulled} <strong>{fmt(l.value)}</strong>
              {l.count > 1 && ` ×${l.count}`}
            </span>
          ))}
        </div>
      )}

      {sheet?.kind === "hand" && (
        <HandSheet
          key={`${sheet.seat}-${sheet.mode ?? "win"}`}
          store={store}
          state={state}
          seat={sheet.seat}
          startMode={sheet.mode}
          onClose={close}
          onDone={(ev) => {
            const msg = entryMessage(ev);
            if (msg && send(msg)) close();
          }}
        />
      )}
      {sheet?.kind === "draw" && (
        <Confirm
          title="流局 Draw"
          detail={game.settings.jackpot ? `No winner this hand. Each player puts ${fmt(game.settings.jackpotPerDraw)} into the Jackpot.` : "No winner this hand."}
          yes="Record the draw"
          onClose={close}
          onYes={() => send({ t: "draw" }) && close()}
        />
      )}
      {sheet?.kind === "end" && (
        <Confirm
          title="End the session?"
          detail="Everyone sees the final scores and who pays whom. Nothing more can be recorded at this table."
          yes="End and settle up"
          danger
          onClose={close}
          onYes={() => send({ t: "end" }) && close()}
        />
      )}
      {sheet?.kind === "recent" && <History game={game} state={state} store={store} onClose={close} />}
    </>
  );
}

// A one-line description of an entry, for the undo banner.
function describe(ev: ScoreEvent, state: ReplayState, index: number): string {
  if (ev.t === "draw") return "the 流局";
  if (ev.t === "bonus") return `${state.seats[ev.seat]}'s 特別${ev.kind} of ${fmt(ev.amount)}`;
  if (ev.t === "win") {
    const h = handAt(state, index);
    const who = ev.winners.map((w) => `${state.seats[w.seat]} ${fmt(w.tai)}`).join(", ");
    return `${who} ${ev.from === null ? "自摸" : `off ${state.seats[ev.from]}`}${h ? ` (局${h.hand})` : ""}`;
  }
  return "the last entry";
}

function History({ game, state, store, onClose }: { game: ScoreGame; state: ReplayState; store: ScoreStore; onClose: () => void }) {
  const rows = game.events
    .map((ev, i) => ({ ev, i }))
    .reverse()
    .map(({ ev, i }) => {
      if (ev.t === "win" || ev.t === "draw") {
        const h = handAt(state, i);
        return h ? <HandRow key={i} h={h} store={store} /> : null;
      }
      return <EventRow key={i} ev={ev} deltas={stepAt(state, i)?.deltas ?? {}} />;
    });
  return (
    <Sheet title="最近 Recent" subtitle={game.events.length ? `${state.hands.length}局 · ${game.events.length} ${game.events.length === 1 ? "entry" : "entries"}` : "Nothing recorded yet"} onClose={onClose}>
      {game.events.length === 0 ? <p className="sc-empty">Tap the winner on the table to record a hand, or 流局 for a draw.</p> : <div className="sc-list sc-list-hands">{rows}</div>}
    </Sheet>
  );
}

// ---- The summary ----------------------------------------------------------------------

function Summary({ room, game, store, setStore, onLeave }: { room: RoomView; game: ScoreGame; store: ScoreStore; setStore: (s: ScoreStore) => void; onLeave: () => void }) {
  const s = room.summary!;
  const showChips = room.settings.startChips > 0;
  const ranked = game.seats.map((name, i) => ({ name, net: s.net[i], chips: s.chips[i] })).sort((a, b) => b.net - a.net);
  const kept = store.history.some((g) => g.id === game.id) || store.active?.id === game.id;
  const keep = () =>
    setStore({
      ...store,
      roster: withRoster(store, game.seats),
      history: [{ ...game, endedAt: s.endedAt, updatedAt: s.endedAt }, ...store.history].sort((a, b) => b.startedAt - a.startedAt),
    });
  return (
    <>
      <SectionHead zh="結果" en={`Final · ${s.hands}局`} />
      <div className="card sc-list-card">
        {ranked.map((p, i) => (
          <div key={p.name} className="sc-leader ol-leader">
            <span className={`sc-leader-rank is-${i + 1}`}>{i + 1}</span>
            <span className="sc-leader-id">
              <span className="sc-leader-name">{p.name}</span>
              {showChips && <span className="sc-leader-sub">籌碼 {fmt(p.chips)}</span>}
            </span>
            <strong className={`sc-leader-total ${tone(p.net)}`}>{signed(p.net)}</strong>
          </div>
        ))}
      </div>
      <SectionHead zh="結帳" en="Settle up" />
      <div className="card">
        {s.settle.length === 0 ? (
          <p className="sc-empty">Everyone is level.</p>
        ) : (
          <div className="sc-list">
            {s.settle.map((p, i) => (
              <div key={i} className="sc-row">
                <span>
                  {game.seats[p.from]} → {game.seats[p.to]}
                </span>
                <strong>{fmt(p.amount)}</strong>
              </div>
            ))}
          </div>
        )}
        {s.pot > 0 && <p className="sc-help sc-help-block">{fmt(s.pot)} is still in the Jackpot - paid in by the players, so it isn't in the payments above.</p>}
      </div>
      <div className="ol-summary-actions">
        <button type="button" className="sc-primary" onClick={keep} disabled={kept}>
          {kept ? "Kept in 統計 ✓" : "存入統計 Keep in my Stats"}
        </button>
        <button type="button" className="sc-secondary" onClick={onLeave}>
          New table
        </button>
      </div>
    </>
  );
}
