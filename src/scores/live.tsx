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
import { cleanNickname, NICKNAME_MAX } from "@mjwaits/shared/protocol/limits";
import type { ErrorCode, RoomView } from "@mjwaits/shared/protocol/server";
import { createRoom, GameSync, joinLink, loadOnline, RoomClient, saveOnline, tokenFor, withToken, type ConnectionStatus } from "../lib/online";
import { colorOf, Sheet, Toggle } from "./shared";

export type Problem = { code: ErrorCode | "offline" | "lost"; message: string; at: number };

export const STATUS_TEXT: Record<ConnectionStatus, string> = {
  connecting: "Connecting…",
  open: "Live",
  reconnecting: "Reconnecting…",
  closed: "Offline",
};

// ---- The connection -----------------------------------------------------------------

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
    if (!code) return;
    setRoom(null);
    setGone(false);
    const s = new GameSync({
      send: (base, game) => client.current?.send({ t: "update", base, game, ...(colorsRef.current ? { colors: colorsRef.current } : {}) }) !== false,
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
      onError: (errCode, message) => {
        if (errCode === "conflict" || errCode === "notAllowed") s.refused();
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
// state and stops sharing.
export function useHostLive(store: ScoreStore, setStore: (s: ScoreStore) => void) {
  const [sharing, setSharing] = useState(() => loadOnline().sharing);
  const remember = (next: { code: string; gameId: string } | null) => {
    saveOnline({ ...loadOnline(), sharing: next });
    setSharing(next);
  };
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
  // The game ended here: once its final state is up, stop sharing.
  const ended = shared !== null && shared !== active;
  const { room, send } = live;
  useEffect(() => {
    if (!ended || !room) return;
    if (room.phase === "ended") return remember(null);
    if (room.game?.endedAt) send({ t: "stop" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ended, room]);

  const goLive = async (name: string) => {
    if (!active) return;
    saveOnline({ ...loadOnline(), name });
    const roomCode = await createRoom();
    remember({ code: roomCode, gameId: active.id });
  };
  const stop = () => {
    send({ t: "stop" });
    remember(null);
  };
  return { ...live, code, goLive, stop };
}

export type HostLive = ReturnType<typeof useHostLive>;

export function LiveSheet({ live, onClose }: { live: HostLive; onClose: () => void }) {
  const [name, setName] = useState(() => loadOnline().name);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [confirmStop, setConfirmStop] = useState(false);
  const clean = cleanNickname(name);
  if (!live.code)
    return (
      <Sheet
        title="線上 Go live"
        subtitle="This game on everyone's phone, as it happens"
        onClose={onClose}
        actions={
          <button
            type="button"
            className="sc-primary"
            disabled={!clean || busy}
            onClick={async () => {
              if (!clean) return;
              setBusy(true);
              setProblem(null);
              try {
                await live.goLive(clean);
              } catch (e) {
                setProblem(e instanceof Error && e.message !== "Failed to fetch" ? e.message : "Couldn't reach the server - check the connection");
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "Opening…" : "Go live"}
          </button>
        }
      >
        <p className="sc-help sc-help-block">
          The others open Scores → 線上 and join with a code (or scan the QR code) to watch the scores update live. You choose who may record hands too.
        </p>
        <label className="ol-field">
          <span className="ol-field-label">Your name, as the others will see it</span>
          <input className="sc-input" value={name} maxLength={NICKNAME_MAX * 2} placeholder="Host" onChange={(e) => setName(e.target.value)} />
        </label>
        {problem && (
          <p className="ol-problem" role="alert">
            {problem}
          </p>
        )}
      </Sheet>
    );
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
            Stop sharing - the others keep the scores as they are now
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
        <span className="sc-help">Scan, or open Scores → 線上 and enter</span>
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
