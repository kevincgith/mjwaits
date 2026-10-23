// 線上對局: a table of four - people on their own phones, or bots - played
// on the server (worker/src/table.ts), laid out for a phone held upright.
//
//   the three others along the top (left, across, right in turn order):
//     name, wind, score, tiles in hand, melds and flowers
//   the four ponds round a compass that lights whoever is to act, with the
//     discard up for claiming in the middle and the turn timer
//   your claim buttons, your melds, and your hand along the bottom: tap a
//     tile to lift it, tap it again to throw it
//
// The server holds the wall and every hand and sends this phone only what
// its seat may see; it checks every move, so this screen just shows the
// table, offers what the server says you may do (`options`), and sends it.
// Before the first deal, the lobby: the invite, the seats, bots, settings.

import { useEffect, useMemo, useRef, useState } from "react";
import { roundLabel, sameTile, seatWind, surrenderable, type Claim, type GameState, type TurnMove } from "@mjwaits/shared/engine/game";
import { sortTiles, tileKey, tileLabel, type Tile } from "@mjwaits/shared/engine/mahjong";
import type { MeldView, ResultView, TableView } from "@mjwaits/shared/engine/view";
import { profileById } from "@mjwaits/shared/engine/bots";
import { cleanNickname, normalizeRoomCode } from "@mjwaits/shared/protocol/limits";
import { TABLE_BOTS, TURN_TIMERS, type TableBot, type TableClientMessage, type TableSettings, type TableState } from "@mjwaits/shared/protocol/table";
import type { ConnectionStatus } from "./lib/online";
import { createTable, loadTables, saveTables, TableClient, tableLink, tableToken, withoutTable, withTable } from "./lib/onlineTable";
import { BonusGlyphSpan, TileGlyphSpan } from "./TileGlyphs";
import "./OnlineTable.css";

const WIND_CHARS = ["", "東", "南", "西", "北"];
const HOLDS = [30, 60, 120] as const;
const BURST_MS = 1300;
// A locked 叮 hand throws its draw by itself, after a beat.
const RIICHI_THROW_MS = 700;

type Send = Exclude<TableClientMessage, { t: "hello" }>;
// The engine's moves as the wire carries them (no jokers at a real table).
type WireMove = Extract<Send, { t: "move" }>["move"];
type WireClaim = Extract<Send, { t: "claim" }>["claim"];
type Welcome = { id: string; host: boolean };

const claimLabel = (c: Claim) => (c.kind === "win" ? "食" : c.kind === "kong" ? "槓" : c.kind === "pung" ? "碰" : "上");
const signed = (n: number) => (n > 0 ? `+${n}` : String(n));
const tone = (n: number) => (n > 0 ? " is-pos" : n < 0 ? " is-neg" : "");
const botName = (bot: TableBot) => profileById(bot).name;

// ---- Small pieces --------------------------------------------------------------------

function Melds({ melds, small }: { melds: MeldView[]; small?: boolean }) {
  return (
    <>
      {melds.map((m, i) => (
        <span key={i} className={`ot-meld${small ? " is-small" : ""}`}>
          {"hidden" in m
            ? [0, 1, 2, 3].map((j) => <span key={j} className="ot-back" />)
            : m.tiles.map((t, j) => (m.concealed && (j === 0 || j === 3) ? <span key={j} className="ot-back" /> : <TileGlyphSpan key={j} tile={t} />))}
        </span>
      ))}
    </>
  );
}

function Pond({ tiles, latest, riichiAt, side }: { tiles: Tile[]; latest: boolean; riichiAt?: number; side: string }) {
  return (
    <div className={`ot-pond ot-pond-${side}`}>
      {tiles.map((t, i) => (
        <span key={i} className={["ot-pond-tile", latest && i === tiles.length - 1 && "is-latest", i === riichiAt && "is-riichi"].filter(Boolean).join(" ")}>
          <TileGlyphSpan tile={t} />
        </span>
      ))}
    </div>
  );
}

// ---- The screen ------------------------------------------------------------------------

export function OnlineTable({ initialCode, onExit }: { initialCode: string | null; onExit: () => void }) {
  const [memory, setMemory] = useState(loadTables);
  useEffect(() => saveTables(memory), [memory]);
  const [code, setCode] = useState<string | null>(initialCode && tableToken(loadTables(), initialCode) ? initialCode : null);
  const [joinCode, setJoinCode] = useState(initialCode ?? "");
  const [name, setName] = useState(memory.name);
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

  return (
    <div className="play-screen ot-screen">
      {!code ? (
        <Entry
          name={name}
          setName={setName}
          joinCode={joinCode}
          setJoinCode={setJoinCode}
          recent={memory.tables.map((t) => t.code)}
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
      ) : (
        <Playing table={table} me={me} send={send} onLeave={leave} />
      )}
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
  busy,
  onEnter,
  onExit,
}: {
  name: string;
  setName: (s: string) => void;
  joinCode: string;
  setJoinCode: (s: string) => void;
  recent: string[];
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
        <span>Your nickname</span>
        <input value={name} maxLength={24} onChange={(e) => setName(e.target.value)} placeholder="e.g. Kevin" autoComplete="nickname" />
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
            <button key={c} type="button" className="ot-button" onClick={() => onEnter(c)}>
              Back to {c}
            </button>
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

// ---- Playing ----------------------------------------------------------------------------------

function Playing({ table, me, send, onLeave }: { table: TableState; me: Welcome; send: (m: Send) => void; onLeave: () => void }) {
  const view = table.view!;
  const you = table.you;
  // Watching: seat 0 along the bottom, its hand hidden.
  const bottom = you ?? 0;
  const at = (offset: number) => (bottom + offset) % 4;
  const name = (seat: number) => (seat === you ? "You" : (table.seats[seat]?.name ?? "?"));
  const short = (seat: number) => (seat === you ? "You" : name(seat).split(" ")[0]);
  const phase = view.phase;
  const options = table.options;
  const turn = options?.turn ?? null;
  const claims = options?.claims ?? [];
  const mine = you === null ? null : view.players[you];

  const [selected, setSelected] = useState<number | null>(null);
  const [riichiArmed, setRiichiArmed] = useState(false);
  const [chowChoice, setChowChoice] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [resultHidden, setResultHidden] = useState(false);
  const [surrenderArmed, setSurrenderArmed] = useState<number | null>(null);
  // Each new decision starts clean.
  useEffect(() => {
    setSelected(null);
    setRiichiArmed(false);
    setChowChoice(false);
  }, [table.step]);
  useEffect(() => {
    if (phase.kind !== "over") setResultHidden(false);
  }, [phase.kind]);

  // The burst for what just happened (a call, a kong, a win, 叮).
  const [burst, setBurst] = useState<{ seat: number; label: string; id: number } | null>(null);
  const lastSeen = useRef<string | null>(null);
  useEffect(() => {
    const last = table.last;
    const key = JSON.stringify([table.hand, view.discardsMade, last]);
    if (!last || lastSeen.current === key) return;
    const first = lastSeen.current === null;
    lastSeen.current = key;
    if (first) return; // not for what happened before this phone looked
    let b: { seat: number; label: string } | null = null;
    if (last.kind === "call") b = { seat: last.seat, label: last.call === "chow" ? "上" : last.call === "pung" ? "碰" : "槓" };
    else if (last.kind === "kong") b = { seat: last.seat, label: "槓" };
    else if (last.kind === "discard" && last.riichi) b = { seat: last.seat, label: "叮" };
    else if (last.kind === "win") b = { seat: last.seats[0], label: last.robKong ? "搶槓" : last.from === null ? "自摸" : last.seats.length > 1 ? (last.seats.length === 2 ? "雙響" : "三響") : "食糊" };
    if (!b) return;
    const id = Date.now();
    setBurst({ ...b, id });
    window.setTimeout(() => setBurst((x) => (x?.id === id ? null : x)), BURST_MS);
  }, [table.last, table.hand, view.discardsMade]);

  // The turn timer, from the server's deadline.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (table.deadline === null) return;
    // From now, not from wherever the clock stopped at the last deadline.
    const tick = () => setNow(Date.now());
    tick();
    const id = window.setInterval(tick, 250);
    return () => window.clearInterval(id);
  }, [table.deadline]);
  const secondsLeft = table.deadline === null ? null : Math.max(0, Math.ceil((table.deadline - now) / 1000));

  // Your hand: sorted, the drawn tile split off at the right.
  const drawn = phase.kind === "turn" && phase.seat === you ? phase.drawn : null;
  const handTiles = useMemo(() => {
    const tiles = (mine?.hand ?? []).slice();
    let d: Tile | null = null;
    if (drawn) {
      const i = tiles.findIndex((t) => sameTile(t, drawn));
      if (i >= 0) d = tiles.splice(i, 1)[0];
    }
    return { tiles: d ? [...sortTiles(tiles), d] : sortTiles(tiles), hasDrawn: d !== null };
  }, [mine?.hand, drawn]);

  // A locked 叮 hand: only the draw may go, and it goes by itself.
  const locked = !!mine?.riichi;
  useEffect(() => {
    if (!turn || !locked || turn.selfDraw || !drawn || turn.kongs.length) return;
    const id = window.setTimeout(() => send({ t: "move", step: table.step, move: { kind: "discard", tile: drawn } as WireMove }), RIICHI_THROW_MS);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [table.step, !!turn, locked]);

  const barred = (t: Tile) =>
    !turn ||
    turn.forbidden.some((f) => sameTile(f, t)) ||
    (locked && !(drawn && sameTile(drawn, t))) ||
    (riichiArmed && !turn.riichi.some((r) => sameTile(r, t)));

  const move = (m: TurnMove) => send({ t: "move", step: table.step, move: m as WireMove });
  const claim = (c: Claim | null) => send({ t: "claim", step: table.step, claim: c as WireClaim });
  const tap = (i: number) => {
    const t = handTiles.tiles[i];
    if (barred(t)) return;
    if (selected === i) move({ kind: "discard", tile: t, ...(riichiArmed ? { riichi: true } : {}) });
    else setSelected(i);
  };

  const activeSeat = phase.kind === "turn" ? phase.seat : phase.kind === "claims" ? phase.from : null;
  const claimFrom = phase.kind === "claims" ? phase.from : null;
  const chows = claims.filter((c): c is Extract<Claim, { kind: "chow" }> => c.kind === "chow");
  const others = claims.filter((c) => c.kind !== "chow");
  const waitingNames = table.waitingOn.filter((s) => s !== you).map(short);

  const opponent = (seat: number, side: string) => {
    const p = view.players[seat];
    const info = table.seats[seat];
    const away = info?.kind === "human" && !info.connected;
    return (
      <div key={seat} className={`ot-opp ot-opp-${side}${activeSeat === seat ? " is-active" : ""}`}>
        <div className="ot-opp-head">
          <span className="ot-wind">{WIND_CHARS[seatWind(seat, view.dealer)]}</span>
          <span className="ot-opp-name">{short(seat)}</span>
          {seat === view.dealer && <span className="ot-dealer">莊</span>}
          {p.riichi && <span className="ot-riichi">叮</span>}
        </div>
        <div className="ot-opp-sub">
          <span className={`ot-total${tone(table.totals[seat])}`}>{signed(table.totals[seat])}</span>
          <span className="ot-count" aria-label={`${p.handCount} tiles`}>
            <span className="ot-back" />×{p.handCount}
          </span>
          {table.auto.includes(seat) ? <span className="ot-tag is-away">auto</span> : away && <span className="ot-tag is-away">away</span>}
          {info?.kind === "bot" && <span className="ot-tag">bot</span>}
        </div>
        {(p.melds.length > 0 || p.flowers.length > 0 || (phase.kind === "over" && p.hand)) && (
          <div className="ot-opp-melds">
            {/* The hand's over: everyone's tiles are face up. */}
            {phase.kind === "over" && p.hand && (
              <span className="ot-meld is-small is-open">
                {sortTiles(p.hand).map((t, i) => (
                  <TileGlyphSpan key={i} tile={t} />
                ))}
              </span>
            )}
            <Melds melds={p.melds} small />
            {p.flowers.map((f, i) => (
              <BonusGlyphSpan key={i} tile={f} />
            ))}
          </div>
        )}
      </div>
    );
  };

  const center = secondsLeft !== null ? String(secondsLeft).padStart(2, "0") : String(view.wallLeft).padStart(2, "0");

  return (
    <div className="ot-play">
      <header className="ot-bar">
        <button type="button" className="ot-icon" onClick={() => setMenuOpen((o) => !o)} aria-label="Table menu" aria-expanded={menuOpen}>
          ☰
        </button>
        <span className="ot-bar-round">
          {roundLabel(view as unknown as GameState)}
          {view.dealerStreak > 0 && ` · 連${view.dealerStreak}`}
        </span>
        <span className="ot-bar-left">剩 {view.wallLeft}</span>
        <span className="ot-bar-code">{table.code}</span>
        {menuOpen && (
          <div className="ot-menu">
            <p className="ot-muted">
              {table.settings.multiWin ? "一炮多響" : "截糊"} · timer {table.settings.timer ? `${table.settings.timer}s` : "off"}
              {table.watching > 0 && ` · ${table.watching} watching`}
            </p>
            <button type="button" className="ot-button" onClick={onLeave}>
              Leave (your seat waits for you)
            </button>
            {me.host && (
              <button type="button" className={`ot-button${confirmEnd ? " is-danger" : ""}`} onClick={() => (confirmEnd ? send({ t: "end" }) : setConfirmEnd(true))}>
                {confirmEnd ? "Tap again to end the table" : "End the table"}
              </button>
            )}
          </div>
        )}
      </header>

      <div className="ot-opps">
        {opponent(at(3), "left")}
        {opponent(at(2), "top")}
        {opponent(at(1), "right")}
      </div>

      <div className="ot-felt">
        <div className="ot-felt-top">
          <Pond tiles={view.players[at(2)].discards} riichiAt={view.players[at(2)].riichi?.discard} latest={claimFrom === at(2)} side="top" />
        </div>
        <div className="ot-felt-mid">
          <Pond tiles={view.players[at(3)].discards} riichiAt={view.players[at(3)].riichi?.discard} latest={claimFrom === at(3)} side="left" />
          <div className="ot-compass" aria-hidden="true">
            {(["bottom", "right", "top", "left"] as const).map((side, k) => (
              <span key={side} className={`ot-compass-q at-${side}${activeSeat === at(k) && phase.kind !== "over" ? " is-active" : ""}`}>
                {WIND_CHARS[seatWind(at(k), view.dealer)]}
              </span>
            ))}
            <span className={`ot-compass-center${secondsLeft !== null && secondsLeft <= 5 ? " is-hurry" : ""}`}>{center}</span>
          </div>
          <Pond tiles={view.players[at(1)].discards} riichiAt={view.players[at(1)].riichi?.discard} latest={claimFrom === at(1)} side="right" />
        </div>
        <div className="ot-felt-bottom">
          <Pond tiles={view.players[bottom].discards} riichiAt={view.players[bottom].riichi?.discard} latest={claimFrom === bottom} side="bottom" />
        </div>
        {phase.kind === "claims" && (
          <span className="ot-spotlight" aria-label={`Up for claiming: ${tileLabel(phase.tile)}`}>
            <TileGlyphSpan tile={phase.tile} />
          </span>
        )}
        {burst && (
          <span key={burst.id} className={`ot-burst at-${["bottom", "right", "top", "left"][(burst.seat - bottom + 4) % 4]}`}>
            {burst.label}
          </span>
        )}
      </div>

      <div className="ot-me">
        <div className="ot-prompt">
          {you === null
            ? "Watching"
            : turn
              ? locked
                ? "叮 - your hand is locked"
                : riichiArmed
                  ? "叮: choose the tile to throw"
                  : selected !== null
                    ? "Tap again to discard"
                    : "Your turn"
              : claims.length
                ? "Claim it?"
                : phase.kind !== "over" && waitingNames.length
                  ? `Waiting for ${waitingNames.join(", ")}`
                  : ""}
          {you !== null && table.auto.includes(you) && " · the table is playing for you"}
        </div>
        <div className="ot-calls">
          {chowChoice ? (
            <>
              {chows.map((c, i) => (
                <button key={i} type="button" className="play-call is-chow-shape" onClick={() => claim(c)} aria-label={`Chow with ${c.tiles.map(tileLabel).join(" and ")}`}>
                  {sortTiles([...c.tiles, phase.kind === "claims" ? phase.tile : c.tiles[0]]).map((t, j) => (
                    <TileGlyphSpan key={j} tile={t} />
                  ))}
                </button>
              ))}
              <button type="button" className="play-call is-pass" onClick={() => setChowChoice(false)} aria-label="Back">
                ‹
              </button>
            </>
          ) : (
            <>
              {phase.kind === "over" && resultHidden && (
                <button type="button" className="ot-button" onClick={() => setResultHidden(false)}>
                  Show result
                </button>
              )}
              {turn?.selfDraw && (
                <button type="button" className="play-call is-win is-long" onClick={() => move({ kind: "selfDraw" })}>
                  自摸
                </button>
              )}
              {turn && !locked && turn.riichi.length > 0 && (
                <button
                  type="button"
                  className={`play-call is-riichi${riichiArmed ? " is-armed" : ""}`}
                  aria-pressed={riichiArmed}
                  onClick={() => {
                    setSelected(null);
                    setRiichiArmed((a) => !a);
                  }}
                >
                  叮
                </button>
              )}
              {turn?.kongs.map((k) => (
                <button key={`${k.kind}${tileKey(k.tile)}`} type="button" className="play-call has-tile" onClick={() => move(k)} aria-label={`Kong ${tileLabel(k.tile)}`}>
                  槓
                  <span className="play-call-tile">
                    <TileGlyphSpan tile={k.tile} />
                  </span>
                </button>
              ))}
              {others.map((c, i) => (
                <button key={i} type="button" className={`play-call${c.kind === "win" ? " is-win" : ""}`} onClick={() => claim(c)}>
                  {claimLabel(c)}
                </button>
              ))}
              {chows.length > 0 && (
                <button type="button" className="play-call" onClick={() => (chows.length === 1 ? claim(chows[0]) : setChowChoice(true))}>
                  上
                </button>
              )}
              {claims.length > 0 && (
                <button type="button" className="play-call is-pass" onClick={() => claim(null)}>
                  過
                </button>
              )}
            </>
          )}
        </div>
        <div className="ot-me-row">
          <span className={`ot-wind${activeSeat === you ? " is-active" : ""}`}>{WIND_CHARS[seatWind(bottom, view.dealer)]}</span>
          <span className="ot-me-name">{you === null ? short(bottom) : "You"}</span>
          {bottom === view.dealer && <span className="ot-dealer">莊</span>}
          <span className={`ot-total${tone(table.totals[bottom])}`}>{signed(table.totals[bottom])}</span>
          {view.players[bottom].melds.length + view.players[bottom].flowers.length > 0 && (
            <span className="ot-me-melds">
              <Melds melds={view.players[bottom].melds} small />
              {view.players[bottom].flowers.map((f, i) => (
                <BonusGlyphSpan key={i} tile={f} />
              ))}
            </span>
          )}
        </div>
        <div className={`ot-hand${turn ? " is-turn" : ""}`}>
          {mine
            ? handTiles.tiles.map((t, i) => {
                const no = barred(t);
                return (
                  <button
                    key={i}
                    type="button"
                    className={["ot-hand-tile", handTiles.hasDrawn && i === handTiles.tiles.length - 1 && "is-drawn", selected === i && "is-selected", turn && no && "is-barred"]
                      .filter(Boolean)
                      .join(" ")}
                    disabled={!turn || no}
                    onClick={() => tap(i)}
                    aria-label={selected === i ? `Discard ${tileLabel(t)}` : tileLabel(t)}
                  >
                    <TileGlyphSpan tile={t} />
                  </button>
                );
              })
            : Array.from({ length: view.players[bottom].handCount }, (_, i) => <span key={i} className="ot-back is-hand" />)}
        </div>
      </div>

      {phase.kind === "over" && !resultHidden && (
          <Result
            table={table}
            view={view}
            result={phase.result}
            name={name}
            onHide={() => setResultHidden(true)}
            surrenderArmed={surrenderArmed}
            onSurrender={(holder) => {
              if (surrenderArmed !== holder) return setSurrenderArmed(holder);
              setSurrenderArmed(null);
              send({ t: "surrender", holder });
            }}
            onReady={() => send({ t: "ready" })}
          />
      )}
    </div>
  );
}

// ---- A finished hand -------------------------------------------------------------------------

function Result({
  table,
  view,
  result,
  name,
  onHide,
  surrenderArmed,
  onSurrender,
  onReady,
}: {
  table: TableState;
  view: TableView;
  result: ResultView;
  name: (seat: number) => string;
  onHide: () => void;
  surrenderArmed: number | null;
  onSurrender: (holder: number) => void;
  onReady: () => void;
}) {
  const you = table.you;
  const winners = result.winner === null ? [] : [{ winner: result.winner, score: result.score, scoreError: result.scoreError }, ...(result.alsoWon ?? [])];
  const title =
    result.winner === null
      ? "流局 · the wall ran out"
      : `${winners.map((w) => name(w.winner)).join(" and ")} ${winners.length > 1 ? "won" : you === result.winner ? "won" : "wins"}${
          result.robKong ? ` by robbing ${name(result.from!)}'s kong (搶槓)` : result.from === null ? " by self-draw (自摸)" : ` off ${result.from === you ? "your" : `${name(result.from)}'s`} discard`
        }`;
  // 投降: the 拉 others hold on you, long enough to give up.
  const canSurrender = you === null ? [] : surrenderable({ phase: { kind: "over", result }, lahs: view.lahs } as unknown as GameState, you);
  const ready = you !== null && table.ready.includes(you);
  const waiting = table.waitingOn.filter((s) => s !== you).map((s) => name(s));
  return (
    <div className="ot-result" role="dialog" aria-label="Hand result">
      <div className="ot-result-card">
        <h2>{title}</h2>
        {winners.map((w) => (
          <div key={w.winner} className="ot-result-winner">
            {winners.length > 1 && <h3>{name(w.winner)}</h3>}
            <div className="ot-result-hand">
              <Melds melds={view.players[w.winner].melds} small />
              <span className="ot-meld is-small">
                {sortTiles(view.players[w.winner].hand ?? []).map((t, i) => (
                  <TileGlyphSpan key={i} tile={t} highlight={!!result.tile && sameTile(t, result.tile) && i === sortTiles(view.players[w.winner].hand ?? []).findIndex((x) => sameTile(x, result.tile!))} />
                ))}
              </span>
              {view.players[w.winner].flowers.map((f, i) => (
                <BonusGlyphSpan key={i} tile={f} />
              ))}
            </div>
            {w.score && (
              <ul className="ot-result-patterns">
                {w.score.patterns.map((p) => (
                  <li key={p.id}>
                    <span>{p.name}</span>
                    <span>{p.tai}</span>
                  </li>
                ))}
                <li className="ot-result-total">
                  <span>Total</span>
                  <span>{w.score.total} 台</span>
                </li>
              </ul>
            )}
            {w.scoreError && <p className="ot-muted">Couldn't score this hand: {w.scoreError}</p>}
          </div>
        ))}
        <div className="ot-result-deltas">
          {result.deltas.map((d, seat) => (
            <span key={seat} className={d < 0 ? "is-neg" : d > 0 ? "is-pos" : undefined}>
              {name(seat)} {signed(d)} <span className="ot-muted">({signed(table.totals[seat])})</span>
            </span>
          ))}
        </div>
        {canSurrender.map((l) => {
          const holder = Number(l.holder);
          return (
            <div key={l.holder} className="ot-surrender">
              <span>
                {name(holder)} has 拉'd you {l.count} in a row ({l.value}). 投降 ends it.
              </span>
              <button type="button" className={`ot-button is-small${surrenderArmed === holder ? " is-danger" : ""}`} onClick={() => onSurrender(holder)}>
                {surrenderArmed === holder ? "Tap again" : "投降"}
              </button>
            </div>
          );
        })}
        <div className="ot-result-actions">
          <button type="button" className="ot-button" onClick={onHide}>
            View table
          </button>
          {you !== null && (
            <button type="button" className="ot-button is-primary" disabled={ready} onClick={onReady}>
              {ready ? "Ready ✓" : "Next hand"}
            </button>
          )}
        </div>
        {waiting.length > 0 && <p className="ot-muted">Waiting for {waiting.join(", ")}</p>}
      </div>
    </div>
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
