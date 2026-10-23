// 線上對局: a table of four - people on their own phones, or bots - played
// on the server (worker/src/table.ts). This screen is the way in - a
// nickname, a new table or a code - the lobby (the invite, the seats, bots,
// the table's rules) and the final scores. The hands themselves are played
// on the Play tab's table (PlayPanel, given `online`): the server holds the
// wall and every hand, sends this phone only what its seat may see, and
// checks every move.

import { useEffect, useRef, useState } from "react";
import { seatWind } from "@mjwaits/shared/engine/game";
import { MYSTERY_NAME, profileById } from "@mjwaits/shared/engine/bots";
import { cleanNickname, normalizeRoomCode } from "@mjwaits/shared/protocol/limits";
import { MYSTERY_BOT, TABLE_BOTS, TURN_TIMERS, type TableBot, type TableClientMessage, type TableSettings, type TableState } from "@mjwaits/shared/protocol/table";
import { defaultNickname, type ConnectionStatus } from "./lib/online";
import { createTable, loadTables, saveTables, TableClient, tableLink, tableToken, withoutTable, withTable } from "./lib/onlineTable";
import { PlayPanel } from "./PlayPanel";
import "./OnlineTable.css";

const WIND_CHARS = ["", "東", "南", "西", "北"];
const HOLDS = [30, 60, 120] as const;

type Send = Exclude<TableClientMessage, { t: "hello" }>;
type Welcome = { id: string; host: boolean };

const signed = (n: number) => (n > 0 ? `+${n}` : String(n));
const tone = (n: number) => (n > 0 ? " is-pos" : n < 0 ? " is-neg" : "");
const botName = (bot: TableBot) => profileById(bot).name;


// ---- The screen ------------------------------------------------------------------------

export function OnlineTable({ initialCode, onExit }: { initialCode: string | null; onExit: () => void }) {
  const [memory, setMemory] = useState(loadTables);
  useEffect(() => saveTables(memory), [memory]);
  const [code, setCode] = useState<string | null>(initialCode && tableToken(loadTables(), initialCode) ? initialCode : null);
  const [joinCode, setJoinCode] = useState(initialCode ?? "");
  const [name, setName] = useState(() => memory.name || defaultNickname());
  const [table, setTable] = useState<TableState | null>(null);
  const [me, setMe] = useState<Welcome | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [toast, setToast] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const client = useRef<TableClient | null>(null);

  const say = (text: string) => {
    setToast(text);
    window.setTimeout(() => setToast((t) => (t === text ? null : t)), 3500);
  };

  // The table stays in the address (?table=…), so a reload comes straight back.
  useEffect(() => {
    const url = new URL(window.location.href);
    if (code) url.searchParams.set("table", code);
    else url.searchParams.delete("table");
    window.history.replaceState(null, "", url.pathname + url.search + url.hash);
  }, [code]);
  useEffect(
    () => () => {
      const url = new URL(window.location.href);
      url.searchParams.delete("table");
      window.history.replaceState(null, "", url.pathname + url.search + url.hash);
    },
    []
  );

  // One connection per table this screen is at.
  useEffect(() => {
    if (!code) return;
    const mem = loadTables();
    setTable(null);
    setMe(null);
    const c = new TableClient({
      code,
      name: mem.name,
      token: tableToken(mem, code),
      onWelcome: (w) => {
        setMe({ id: w.id, host: w.host });
        setMemory((m) => withTable(m, code, w.token));
      },
      onTable: setTable,
      onStatus: setStatus,
      onError: (errorCode, message) => {
        if (errorCode === "nameTaken" || errorCode === "version") {
          say(message);
          setCode(null);
          return;
        }
        say(message);
      },
      onGone: () => {
        say(`Table ${code} has closed`);
        setMemory((m) => withoutTable(m, code));
        setCode(null);
      },
    });
    client.current = c;
    const wake = () => document.visibilityState === "visible" && c.nudge();
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("online", wake);
    return () => {
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("online", wake);
      c.stop();
      client.current = null;
    };
  }, [code]);

  const send = (msg: Send) => {
    if (client.current?.send(msg) === false) say("Not connected - wait a moment");
  };

  // Joining: the nickname first, kept for next time.
  const enter = async (target: string | "new") => {
    const nick = cleanNickname(name);
    if (!nick) return say("Pick a nickname first");
    setMemory((m) => ({ ...m, name: nick }));
    saveTables({ ...loadTables(), name: nick });
    if (target !== "new") return setCode(target);
    setBusy(true);
    try {
      setCode(await createTable());
    } catch (e) {
      say(e instanceof Error ? e.message : "Couldn't make a table");
    } finally {
      setBusy(false);
    }
  };

  const leave = () => {
    setCode(null);
    setTable(null);
  };

  // The hand itself: the Play tab's table.
  if (code && table?.phase === "playing" && table.view && me)
    return (
      <>
        <PlayPanel onExit={leave} online={{ table, send, host: me.host }} />
        {status !== "open" && <div className="ot-status">{status === "closed" ? "Disconnected" : "Reconnecting…"}</div>}
        {toast && (
          <div className="ot-toast" role="status">
            {toast}
          </div>
        )}
      </>
    );

  return (
    <div className="play-screen ot-screen">
      {!code ? (
        <Entry
          name={name}
          setName={setName}
          joinCode={joinCode}
          setJoinCode={setJoinCode}
          recent={memory.tables.map((t) => t.code)}
          onForget={(c) => setMemory((m) => withoutTable(m, c))}
          busy={busy}
          onEnter={enter}
          onExit={onExit}
        />
      ) : !table || !me ? (
        <div className="ot-center-card">
          <p>{status === "reconnecting" ? "Reconnecting…" : `Joining table ${code}…`}</p>
          <button type="button" className="ot-button" onClick={leave}>
            Cancel
          </button>
        </div>
      ) : table.phase === "lobby" ? (
        <Lobby table={table} me={me} send={send} onLeave={leave} />
      ) : table.phase === "ended" ? (
        <Ended table={table} onLeave={leave} />
      ) : null}
      {code && table && status !== "open" && <div className="ot-status">{status === "closed" ? "Disconnected" : "Reconnecting…"}</div>}
      {toast && (
        <div className="ot-toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );
}

// ---- Before joining ---------------------------------------------------------------------

function Entry({
  name,
  setName,
  joinCode,
  setJoinCode,
  recent,
  onForget,
  busy,
  onEnter,
  onExit,
}: {
  name: string;
  setName: (s: string) => void;
  joinCode: string;
  setJoinCode: (s: string) => void;
  recent: string[];
  onForget: (code: string) => void;
  busy: boolean;
  onEnter: (code: string | "new") => void;
  onExit: () => void;
}) {
  const normalized = normalizeRoomCode(joinCode);
  return (
    <div className="ot-page">
      <header className="ot-head">
        <button type="button" className="ot-icon" onClick={onExit} aria-label="Back">
          ‹
        </button>
        <h1>線上對局 Online table</h1>
      </header>
      <label className="ot-field">
        <span className="ot-muted">Name</span>
        <input value={name} maxLength={24} onChange={(e) => setName(e.target.value)} placeholder="Name" autoComplete="nickname" />
      </label>
      <button type="button" className="ot-button is-primary" disabled={busy} onClick={() => onEnter("new")}>
        {busy ? "Making a table…" : "New table"}
      </button>
      <div className="ot-join">
        <input
          value={joinCode}
          onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
          placeholder="Table code"
          aria-label="Table code"
          maxLength={8}
          autoCapitalize="characters"
        />
        <button type="button" className="ot-button" disabled={!normalized} onClick={() => normalized && onEnter(normalized)}>
          Join
        </button>
      </div>
      {recent.length > 0 && (
        <section className="ot-recent">
          <h2>Your tables</h2>
          {recent.map((c) => (
            <div key={c} className="ot-recent-row">
              <button type="button" className="ot-button" onClick={() => onEnter(c)}>
                Back to {c}
              </button>
              <button type="button" className="ot-icon" aria-label={`Dismiss ${c}`} title="Dismiss" onClick={() => onForget(c)}>
                ×
              </button>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}

// ---- The lobby ------------------------------------------------------------------------------

function Lobby({ table, me, send, onLeave }: { table: TableState; me: Welcome; send: (m: Send) => void; onLeave: () => void }) {
  const mySeat = table.seats.findIndex((s) => s?.kind === "human" && s.id === me.id);
  const full = table.seats.every(Boolean);
  const s = table.settings;
  const setup = (patch: Partial<TableSettings>) => send({ t: "setup", settings: { ...s, ...patch } });
  const link = tableLink(table.code);
  const share = async () => {
    try {
      if (navigator.share) await navigator.share({ title: "MJWaits table", text: `Join my mahjong table ${table.code}`, url: link });
      else await navigator.clipboard.writeText(link);
    } catch {
      // Dismissed.
    }
  };
  return (
    <div className="ot-page">
      <header className="ot-head">
        <button type="button" className="ot-icon" onClick={onLeave} aria-label="Leave">
          ‹
        </button>
        <h1>Table {table.code}</h1>
      </header>
      <section className="ot-invite">
        <span className="ot-code">{table.code}</span>
        <button type="button" className="ot-button" onClick={share}>
          Share invite
        </button>
      </section>

      <section className="ot-seats">
        {table.seats.map((seat, i) => (
          <div key={i} className={`ot-seat-row${i === mySeat ? " is-me" : ""}`}>
            <span className="ot-wind">{WIND_CHARS[seatWind(i, s.firstDealer)]}</span>
            <span className="ot-seat-who">
              {seat ? (
                <>
                  {seat.name}
                  {seat.kind === "human" && seat.host && <span className="ot-tag">host</span>}
                  {seat.kind === "bot" && <span className="ot-tag">bot</span>}
                  {seat.kind === "human" && !seat.connected && <span className="ot-tag is-away">away</span>}
                </>
              ) : (
                <span className="ot-muted">Empty</span>
              )}
            </span>
            {!seat && (
              <button type="button" className="ot-button is-small" onClick={() => send({ t: "sit", seat: i })}>
                {mySeat >= 0 ? "Move here" : "Sit"}
              </button>
            )}
            {i === mySeat && (
              <button type="button" className="ot-button is-small" onClick={() => send({ t: "stand" })}>
                Stand
              </button>
            )}
            {me.host && seat?.kind !== "human" && (
              <select
                className="ot-select"
                aria-label={`Bot in seat ${i + 1}`}
                value={seat?.kind === "bot" ? seat.bot : ""}
                onChange={(e) => send({ t: "setBot", seat: i, bot: (e.target.value || null) as TableBot | null })}
              >
                <option value="">{seat ? "Remove bot" : "Add a bot…"}</option>
                {TABLE_BOTS.map((b) => (
                  <option key={b} value={b}>
                    {botName(b)}
                  </option>
                ))}
                <option value={MYSTERY_BOT}>{MYSTERY_NAME} (random)</option>
              </select>
            )}
          </div>
        ))}
        {table.watching > 0 && <p className="ot-muted">{table.watching} watching</p>}
      </section>

      <section className="ot-settings">
        <h2>Table rules</h2>
        <Setting label="One discard, several winners" note={s.multiWin ? "一炮多響: everyone who can win, wins" : "截糊: the first in turn takes it"}>
          {[false, true].map((on) => (
            <Seg key={String(on)} on={s.multiWin === on} disabled={!me.host} onClick={() => setup({ multiWin: on })}>
              {on ? "一炮多響" : "截糊"}
            </Seg>
          ))}
        </Setting>
        <Setting label="Turn timer">
          {TURN_TIMERS.map((t) => (
            <Seg key={t} on={s.timer === t} disabled={!me.host} onClick={() => setup({ timer: t })}>
              {t ? `${t}s` : "Off"}
            </Seg>
          ))}
        </Setting>
        <Setting label="If someone drops" note={`their seat waits ${s.hold}s, then plays itself until they're back`}>
          {HOLDS.map((h) => (
            <Seg key={h} on={s.hold === h} disabled={!me.host} onClick={() => setup({ hold: h })}>
              {h < 60 ? `${h}s` : `${h / 60}m`}
            </Seg>
          ))}
        </Setting>
        <Setting label="First dealer (莊)">
          {[0, 1, 2, 3].map((d) => (
            <Seg key={d} on={s.firstDealer === d} disabled={!me.host} onClick={() => setup({ firstDealer: d })}>
              {table.seats[d]?.name.split(" ")[0] ?? `Seat ${d + 1}`}
            </Seg>
          ))}
        </Setting>
      </section>

      {me.host ? (
        <button type="button" className="ot-button is-primary" disabled={!full} onClick={() => send({ t: "start" })}>
          {full ? "Start" : "Fill every seat to start"}
        </button>
      ) : (
        <p className="ot-muted ot-wait-note">Waiting for the host to start</p>
      )}
    </div>
  );
}

function Setting({ label, note, children }: { label: string; note?: string; children: React.ReactNode }) {
  return (
    <div className="ot-setting">
      <span>
        {label}
        {note && <span className="ot-muted"> · {note}</span>}
      </span>
      <span className="ot-seg">{children}</span>
    </div>
  );
}

function Seg({ on, disabled, onClick, children }: { on: boolean; disabled: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" className={on ? "toggle-on" : undefined} aria-pressed={on} disabled={disabled && !on} onClick={onClick}>
      {children}
    </button>
  );
}

// ---- The table's done -----------------------------------------------------------------------

function Ended({ table, onLeave }: { table: TableState; onLeave: () => void }) {
  const order = [0, 1, 2, 3].sort((a, b) => table.totals[b] - table.totals[a]);
  return (
    <div className="ot-page">
      <header className="ot-head">
        <h1>Table {table.code} · finished</h1>
      </header>
      <p className="ot-muted">{table.hand} hands played</p>
      <ol className="ot-final">
        {order.map((seat) => (
          <li key={seat}>
            <span>{table.seats[seat]?.name ?? "?"}</span>
            <span className={tone(table.totals[seat]).trim() || undefined}>{signed(table.totals[seat])}</span>
          </li>
        ))}
      </ol>
      <button type="button" className="ot-button is-primary" onClick={onLeave}>
        Done
      </button>
    </div>
  );
}
