// Scores tab, live sharing: a 戰況 game on other phones as it happens.
//
// The host taps 線上 in 戰況 and Go live: the game goes up in a room on the
// live-scores server (worker/), and every change on the host's phone follows
// it there. Others join from Scores → 線上 with the code or link and watch;
// the host can let any of them record too, on the same 戰況 board. When the
// host ends the game (新局) its final state goes up and sharing stops.
//
// useLiveGame is the one connection to a room, for the host and everyone
// else alike: RoomClient for the socket, GameSync for keeping this phone's
// copy of the game in step with the room's.

import { useEffect, useMemo, useRef, useState } from "react";
import qrcode from "qrcode-generator";
import { replay, type ScoreGame, type ScoreStore } from "@mjwaits/shared/engine/ledger";
import { cleanNickname, NICKNAME_MAX, normalizeRoomCode, ROOM_CODE_LENGTH } from "@mjwaits/shared/protocol/limits";
import { describeChange } from "@mjwaits/shared/protocol/audit";
import type { ErrorCode, RoomView } from "@mjwaits/shared/protocol/server";
import { createRoom, defaultNickname, GameSync, joinLink, loadOnline, RoomClient, roomInfo, saveOnline, tokenFor, withoutRoom, withSharing, withToken, type ConnectionStatus } from "../lib/online";
import { colorOf, Sheet, Toggle } from "./shared";

export type Problem = { code: ErrorCode | "offline" | "lost"; message: string; at: number };

export const STATUS_TEXT: Record<ConnectionStatus, string> = {
  connecting: "Connecting…",
  open: "Live",
  reconnecting: "Reconnecting…",
  closed: "Offline",
};

// ---- The connection -----------------------------------------------------------------

// Told to slow down, an update waits this long (ms) before it goes again.
const RETRY_MS = 2000;

// One room, kept up while `code` is set. `local` is this phone's copy of the
// game (null for someone who only watches, or before the game is up);
// `onAdopt` is called with the room's game whenever someone else changed it.
export function useLiveGame({
  code,
  name,
  local,
  onAdopt,
  colors,
}: {
  code: string | null;
  name: string;
  local: ScoreGame | null;
  onAdopt: (game: ScoreGame) => void;
  colors?: Record<string, number>;
}) {
  const [room, setRoom] = useState<RoomView | null>(null);
  const [me, setMe] = useState<{ id: string; name: string; host: boolean } | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [problem, setProblem] = useState<Problem | null>(null);
  const [gone, setGone] = useState(false);
  const client = useRef<RoomClient | null>(null);
  const sync = useRef<GameSync | null>(null);
  // The latest callbacks and colours, for the long-lived client to call.
  const adopt = useRef(onAdopt);
  adopt.current = onAdopt;
  const colorsRef = useRef(colors);
  colorsRef.current = colors;

  useEffect(() => {
    // A different room (or none): nothing seen of the last one carries over.
    setRoom(null);
    setMe(null);
    setGone(false);
    if (!code) return;
    const s = new GameSync({
      send: (base, game) => client.current?.send({ t: "update", base, game, ...(colorsRef.current ? { colors: colorsRef.current } : {}) }) ?? false,
      adopt: (game) => adopt.current(game),
      lost: () =>
        setProblem({ code: "lost", message: "Someone else recorded at the same moment - yours wasn't saved, please enter it again", at: Date.now() }),
    });
    sync.current = s;
    const c = new RoomClient({
      code,
      name,
      token: tokenFor(loadOnline(), code),
      onWelcome: (w) => {
        setMe({ id: w.id, name: w.name, host: w.host });
        saveOnline(withToken(loadOnline(), code, w.token));
      },
      onRoom: (view) => {
        setRoom(view);
        s.room(view);
      },
      onStatus: (st) => {
        setStatus(st);
        if (st !== "open") s.reset();
      },
      onError: (errCode, message, rid) => {
        // The update on its way, if that's what it was turned down (or may
        // have been - no rid): let go of. One the room can't take isn't sent
        // again as it is; told to slow down, it goes again in a moment.
        s.refused(rid, !(errCode === "badGame" || errCode === "tooLarge" || errCode === "badMessage"));
        if (errCode === "rateLimited") window.setTimeout(() => sync.current === s && s.retry(), RETRY_MS);
        // A conflict is settled by the room view that follows (GameSync
        // reports a lost change itself); everything else is worth saying.
        if (errCode !== "conflict") setProblem({ code: errCode, message, at: Date.now() });
      },
      onGone: () => setGone(true),
    });
    client.current = c;
    const nudge = () => document.visibilityState === "visible" && c.nudge();
    document.addEventListener("visibilitychange", nudge);
    window.addEventListener("online", nudge);
    return () => {
      document.removeEventListener("visibilitychange", nudge);
      window.removeEventListener("online", nudge);
      c.stop();
      client.current = null;
      sync.current = null;
    };
    // The name only matters for the first hello; changing it later mustn't reconnect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);

  useEffect(() => {
    if (local) sync.current?.local(local);
  }, [local]);

  const send = (msg: Parameters<RoomClient["send"]>[0]) => {
    if (client.current?.send(msg)) return true;
    setProblem({ code: "offline", message: "Not connected - try again in a moment", at: Date.now() });
    return false;
  };
  return { room, me, status, problem, gone, send };
}

// A problem shown for a few seconds as a toast.
export function useToast(problem: Problem | null): Problem | null {
  const [toast, setToast] = useState<Problem | null>(null);
  useEffect(() => {
    if (!problem) return;
    setToast(problem);
    const id = window.setTimeout(() => setToast((t) => (t?.at === problem.at ? null : t)), problem.code === "lost" ? 6000 : 3500);
    return () => window.clearTimeout(id);
  }, [problem]);
  return toast;
}

export function Toast({ toast }: { toast: Problem | null }) {
  return toast ? (
    <div key={toast.at} className="sc-toast" role="status">
      <span className="sc-toast-text">{toast.message}</span>
    </div>
  ) : null;
}

// ---- The audit trail -----------------------------------------------------------------

// Who entered an entry (and who last changed it), as 最近 shows it.
export function entryByOf(room: RoomView | null): ((index: number) => string | undefined) | undefined {
  if (!room) return undefined;
  return (i) => {
    const a = room.authors[i];
    return a ? (a.editedBy ? `by ${a.by} · edited by ${a.editedBy}` : `by ${a.by}`) : undefined;
  };
}

// The latest changes to the shared game, newest first: who, what, when.
export function ChangesList({ room }: { room: RoomView }) {
  const time = (at: number) => new Date(at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return (
    <>
      <h3 className="ol-people-head">Changes</h3>
      {room.changes.length === 0 ? (
        <p className="sc-help">Nothing recorded yet.</p>
      ) : (
        <div className="sc-list ol-changes">
          {room.changes
            .slice()
            .reverse()
            .map((c) => (
              <div key={c.v} className="sc-row ol-change">
                <span>
                  <strong>{c.by}</strong> {describeChange(c)}
                </span>
                <span className="sc-help">{time(c.at)}</span>
              </div>
            ))}
        </div>
      )}
    </>
  );
}

// ---- The host's side ---------------------------------------------------------------

// Each player's colour on this phone, for everyone else's.
export function colorsOf(store: ScoreStore, game: ScoreGame): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of replay(game).players) {
    const c = colorOf(store, p);
    if (c !== "x") out[p] = c;
  }
  return out;
}

// Sharing this phone's 戰況 game: which room (if any) it's live in, and the
// connection that keeps it there. Ending the game (新局) sends its final
// state and stops sharing. A game shared before can be shared again in its
// old room (resume) - reopened from 統計's history first if it had ended.
export function useHostLive(store: ScoreStore, setStore: (s: ScoreStore) => void) {
  const [sharing, setSharing] = useState(() => loadOnline().sharing);
  const remember = (code: string | null, gameId?: string) => {
    const now = loadOnline();
    saveOnline(code && gameId ? withSharing(now, code, gameId) : { ...now, sharing: null });
    setSharing(code && gameId ? { code, gameId } : null);
  };
  // Asked to share a stopped room again: the `resume` goes once the room is back.
  const [resuming, setResuming] = useState(false);
  const [notice, setNotice] = useState<Problem | null>(null);
  const active = store.active;
  // The game being shared: in progress, or just ended (moved to history).
  const shared = sharing ? (active?.id === sharing.gameId ? active : (store.history.find((g) => g.id === sharing.gameId) ?? null)) : null;
  const code = sharing && shared ? sharing.code : null;
  const storeRef = useRef(store);
  storeRef.current = store;
  const colors = useMemo(() => (shared ? colorsOf(store, shared) : undefined), [store, shared]);
  const live = useLiveGame({
    code,
    name: loadOnline().name || "Host",
    local: shared,
    colors,
    // A recorder's change: into the game in progress, as if made here.
    onAdopt: (game) => {
      const now = storeRef.current;
      if (now.active?.id === game.id) setStore({ ...now, active: game });
    },
  });
  const { room, send, me, gone } = live;
  // The game ended here: once its final state is up, stop sharing.
  const ended = shared !== null && shared !== active;
  useEffect(() => {
    if (!ended || !room) return;
    if (room.phase === "ended") return remember(null);
    if (room.game?.endedAt) send({ t: "stop" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ended, room]);
  // Stopped elsewhere (or before this phone noticed): it isn't being shared -
  // 線上 offers Resume instead.
  useEffect(() => {
    if (!ended && !resuming && room?.code === code && room?.phase === "ended") remember(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room]);
  // Resuming: once connected as host, reopen the room; done when it's live.
  useEffect(() => {
    if (!resuming || !room || room.code !== code || !me?.host) return;
    if (room.phase === "ended") send({ t: "resume" });
    else setResuming(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resuming, room, me]);
  // The old room has closed meanwhile: share it in a new one.
  useEffect(() => {
    if (!gone || !shared || !code) return;
    const old = code;
    void createRoom()
      .then((fresh) => {
        remember(fresh, shared.id);
        setResuming(false);
        setNotice({ code: "offline", message: `Room ${old} had closed - shared again as ${fresh}`, at: Date.now() });
      })
      .catch(() => remember(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gone]);

  const goLive = async (name: string) => {
    if (!active) return;
    saveOnline({ ...loadOnline(), name });
    remember(await createRoom(), active.id);
  };
  const stop = () => {
    send({ t: "stop" });
    remember(null);
  };
  // Share a game again in its old room. One that has ended comes back out of
  // the history into 戰況 first - only when no other game is in progress.
  const resume = (entry: { code: string; gameId: string }, name: string) => {
    const now = storeRef.current;
    saveOnline({ ...loadOnline(), name });
    if (now.active?.id !== entry.gameId) {
      const old = now.history.find((g) => g.id === entry.gameId);
      if (!old || now.active) return;
      const { endedAt: _, ...reopened } = old;
      setStore({ ...now, active: { ...reopened, updatedAt: Date.now() }, history: now.history.filter((g) => g.id !== entry.gameId) });
    }
    setResuming(true);
    remember(entry.code, entry.gameId);
  };
  return { ...live, problem: notice && (!live.problem || notice.at > live.problem.at) ? notice : live.problem, code, goLive, stop, resume };
}

export type HostLive = ReturnType<typeof useHostLive>;

// A short label for a game: its name, or its players, and the day.
export function gameLabel(game: ScoreGame): string {
  const day = new Date(game.startedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return `${game.name ?? game.seats.join(" · ")} · ${day}`;
}

// The one 線上 sheet, from the 線上 button. Sharing: the code, who's here and
// who may record, the changes, Stop sharing. Otherwise: share this game (or
// share it again in its old room), reopen an earlier shared game, follow
// someone else's with a code, or open one followed before.
export function LiveSheet({
  live,
  store,
  joinCode,
  onFollow,
  onClose,
}: {
  live: HostLive;
  store: ScoreStore;
  joinCode?: string | null;
  onFollow: (code: string, name: string) => void;
  onClose: () => void;
}) {
  const [memory, setMemory] = useState(() => loadOnline());
  const [name, setName] = useState(() => memory.name || defaultNickname());
  // Dismiss a game from the lists below: this phone forgets it (and its way back in).
  const forget = (code: string) => {
    const next = withoutRoom(loadOnline(), code);
    saveOnline(next);
    setMemory(next);
  };
  const [code, setCode] = useState(joinCode ?? "");
  const [busy, setBusy] = useState<"share" | "join" | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [confirmStop, setConfirmStop] = useState(false);
  const clean = cleanNickname(name);
  const needName = () => {
    if (clean) return false;
    setProblem("Pick a name first - it's how the others see you");
    return true;
  };
  const failed = (e: unknown) => setProblem(e instanceof Error && e.message !== "Failed to fetch" ? e.message : "Couldn't reach the server - check the connection");

  const active = store.active;
  const resumable = active ? memory.hosted.find((h) => h.gameId === active.id) : undefined;
  const reopenable = memory.hosted
    .map((h) => ({ ...h, game: store.history.find((g) => g.id === h.gameId) }))
    .filter((h): h is typeof h & { game: ScoreGame } => !!h.game);
  const followed = memory.rooms.filter((r) => !memory.hosted.some((h) => h.code === r.code));
  const follow = async (joining = normalizeRoomCode(code)) => {
    if (needName()) return;
    if (!joining) return setProblem(`A code is ${ROOM_CODE_LENGTH} letters and numbers`);
    setBusy("join");
    setProblem(null);
    try {
      const info = await roomInfo(joining);
      if (!info) setProblem(`No game ${joining} - check the code (a shared game closes two days after its last change)`);
      else onFollow(joining, clean!);
    } catch (e) {
      failed(e);
    } finally {
      setBusy(null);
    }
  };
  // Following someone else's game, from either view of the sheet.
  const followBlock = (
    <>
      <h3 className="ol-people-head">Follow a game</h3>
      {live.code && (
        <label className="ol-field">
          <span className="ol-field-label">Your name, as the others will see it</span>
          <input className="sc-input" value={name} maxLength={NICKNAME_MAX * 2} placeholder="Your name" autoComplete="nickname" onChange={(e) => setName(e.target.value)} />
        </label>
      )}
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
          onKeyDown={(e) => e.key === "Enter" && void follow()}
        />
        <button type="button" className="sc-primary" onClick={() => void follow()} disabled={busy !== null}>
          {busy === "join" ? "Joining…" : "加入 Join"}
        </button>
      </div>
      {followed.length > 0 && (
        <div className="sc-list ol-followed">
          {followed.map((r) => (
            <div key={r.code} className="sc-row">
              <span className="ol-code-small">{r.code}</span>
              <button type="button" className="sc-secondary" onClick={() => void follow(r.code)} disabled={busy !== null}>
                Open
              </button>
              <button type="button" className="sc-icon-button" aria-label={`Dismiss ${r.code}`} title="Dismiss" onClick={() => forget(r.code)}>
                ×
              </button>
            </div>
          ))}
        </div>
      )}
      {problem && (
        <p className="ol-problem" role="alert">
          {problem}
        </p>
      )}
    </>
  );

  if (live.code) {
    const room = live.room;
    const others = room?.people.filter((p) => !p.host) ?? [];
    return (
      <Sheet
        title={
          <span className="ol-live-title">
            線上 <span className="ol-code">{live.code}</span>
          </span>
        }
        subtitle={
          <span className={`ol-status is-${live.status}`}>
            <span className="ol-dot" aria-hidden="true" />
            {STATUS_TEXT[live.status]}
          </span>
        }
        onClose={onClose}
        actions={
          confirmStop ? (
            <button type="button" className="sc-danger" onClick={() => (live.stop(), onClose())}>
              Stop sharing - you can resume it later
            </button>
          ) : (
            <button type="button" className="sc-secondary" onClick={() => setConfirmStop(true)}>
              Stop sharing
            </button>
          )
        }
      >
        <InviteBlock code={live.code} />
        <h3 className="ol-people-head">{others.length ? "Who's here" : "No one has joined yet"}</h3>
        <div className="sc-list">
          {others.map((p) => (
            <div key={p.id} className="sc-row">
              <span className="ol-seat-name">
                <span className={`ol-dot${p.connected ? " is-on" : ""}`} aria-label={p.connected ? "connected" : "away"} />
                {p.name}
              </span>
              <span className="ol-record">
                <span className="sc-help">{p.canRecord ? "Records" : "Watches"}</span>
                <Toggle checked={p.canRecord} onChange={(allow) => live.send({ t: "setRecorder", person: p.id, allow })} label={`Let ${p.name} record`} />
              </span>
            </div>
          ))}
        </div>
        {room && <ChangesList room={room} />}
        {followBlock}
      </Sheet>
    );
  }

  const share = async (how: () => Promise<void> | void) => {
    if (needName()) return;
    setBusy("share");
    setProblem(null);
    try {
      await how();
    } catch (e) {
      failed(e);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Sheet title="線上 Live scores" subtitle="This game on everyone's phone as it's scored - or follow someone else's" onClose={onClose}>
      <label className="ol-field">
        <span className="ol-field-label">Your name, as the others will see it</span>
        <input className="sc-input" value={name} maxLength={NICKNAME_MAX * 2} placeholder="Your name" autoComplete="nickname" onChange={(e) => setName(e.target.value)} />
      </label>

      {active && (
        <>
          <h3 className="ol-people-head">Share this game</h3>
          {resumable ? (
            <div className="ol-actions">
              <button type="button" className="sc-primary" disabled={busy !== null} onClick={() => void share(() => live.resume(resumable, clean!))}>
                Resume as {resumable.code}
              </button>
              <button type="button" className="sc-secondary" disabled={busy !== null} onClick={() => void share(() => live.goLive(clean!))}>
                New code
              </button>
            </div>
          ) : (
            <button type="button" className="sc-primary ol-wide" disabled={busy !== null} onClick={() => void share(() => live.goLive(clean!))}>
              {busy === "share" ? "Opening…" : "Go live"}
            </button>
          )}
          <p className="sc-help sc-help-block">
            {resumable ? "Resume keeps the code, so everyone's link still works and recorders can still record." : "The others scan the QR code or enter the code to follow along; you choose who may record."}
          </p>
        </>
      )}

      {reopenable.length > 0 && (
        <>
          <h3 className="ol-people-head">Your shared games</h3>
          <div className="sc-list">
            {reopenable.map((h) => (
              <div key={h.gameId} className="sc-row">
                <span className="ol-seat-name">{gameLabel(h.game)}</span>
                <button type="button" className="sc-secondary" disabled={busy !== null || !!active} onClick={() => void share(() => live.resume(h, clean!))}>
                  Reopen
                </button>
                <button type="button" className="sc-icon-button" aria-label={`Dismiss ${gameLabel(h.game)}`} title="Dismiss" onClick={() => forget(h.code)}>
                  ×
                </button>
              </div>
            ))}
          </div>
          <p className="sc-help sc-help-block">
            {active ? "To reopen one, end or file the game in progress first (新局)." : "Reopen brings the game back to 戰況 and shares it again under its old code."}
          </p>
        </>
      )}

      {followBlock}
    </Sheet>
  );
}

// The room's code, QR code and link, to join from another phone.
export function InviteBlock({ code }: { code: string }) {
  const url = joinLink(code);
  const svg = useMemo(() => {
    const qr = qrcode(0, "M");
    qr.addData(url);
    qr.make();
    return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  }, [url]);
  const [copied, setCopied] = useState(false);
  return (
    <div className="ol-invite">
      <div className="sc-qr ol-qr" dangerouslySetInnerHTML={{ __html: svg }} role="img" aria-label={`QR code to join ${code}`} />
      <div className="ol-invite-side">
        <span className="sc-help">Scan, or open Ledger → 線上 and enter</span>
        <span className="ol-code ol-code-big">{code}</span>
        <span className="ol-row-actions">
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
              className="sc-secondary"
              onClick={async () => {
                try {
                  await navigator.share({ title: `MJWaits live scores ${code}`, url });
                } catch {
                  // Dismissed.
                }
              }}
            >
              Share…
            </button>
          )}
        </span>
      </div>
    </div>
  );
}
