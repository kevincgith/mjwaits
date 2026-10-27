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
import { BOT_SPEEDS, JACKPOTS, MYSTERY_BOT, TABLE_BOTS, type BotSpeed, TURN_TIMERS, type TableBot, type TableClientMessage, type TableSettings, type TableState } from "@mjwaits/shared/protocol/table";
import { DEFAULT_SWAP_RULES } from "@mjwaits/shared/engine/swap";
import { SWAP_PRESETS } from "./PlaySwap";
import { defaultNickname, type ConnectionStatus } from "./lib/online";
import {
  codeFromInvite,
  createTable,
  isAppleMobile,
  isInstalledApp,
  loadTables,
  saveTables,
  TableClient,
  tableLink,
  tableScores,
  tableToken,
  withoutTable,
  withTable,
} from "./lib/onlineTable";
import type { ScoreGame } from "@mjwaits/shared/engine/ledger";
import { PlayScores } from "./scores/playScores";
import { PlayPanel, type OnlinePlay } from "./PlayPanel";
import type { Tile } from "@mjwaits/shared/engine/mahjong";
import { TileGlyphSpan } from "./TileGlyphs";
import "./OnlineTable.css";

const WIND_CHARS = ["", "東", "南", "西", "北"];
const HOLDS = [30, 60, 120] as const;

type Send = Exclude<TableClientMessage, { t: "hello" }>;
type Welcome = { id: string; host: boolean };

const signed = (n: number) => (n > 0 ? `+${n}` : String(n));
const tone = (n: number) => (n > 0 ? " is-pos" : n < 0 ? " is-neg" : "");
const botName = (bot: TableBot) => profileById(bot).name;
// A name's first letter (or character), for its round token.
const initial = (name: string) => [...name.trim()][0]?.toUpperCase() ?? "?";
const PLACINGS = ["冠", "亞", "季", "殿"];

// 東 南 西 北, fanned over the title.
const WIND_TILES: Tile[] = [1, 2, 3, 4].map((rank) => ({ suit: "z", rank }));

function BackButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button type="button" className="play-icon-button ot-back" onClick={onClick} aria-label={label}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
        <path d="M15 5l-7 7 7 7" />
      </svg>
    </button>
  );
}

function Chevron() {
  return (
    <svg className="ph-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
      <path d="M9 5l7 7-7 7" />
    </svg>
  );
}

function BotFace() {
  return (
    <svg width="58%" height="58%" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <rect x="4" y="7" width="16" height="12" rx="3.5" />
      <path d="M12 3v4M9 12.5v1M15 12.5v1M2 12v3M22 12v3" />
    </svg>
  );
}


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
  // The table's record (for 戰況), fetched again whenever it grows.
  const [scores, setScores] = useState<ScoreGame | null>(null);
  const [reaction, setReaction] = useState<OnlinePlay["reaction"]>(null);
  const scoreCount = table?.scores ?? 0;
  const started = !!table && table.phase !== "lobby";
  useEffect(() => {
    if (!code || !started) return;
    let live = true;
    tableScores(code)
      .then((g) => live && setScores(g))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [code, scoreCount, started]);

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
      onReaction: (seat, r) => setReaction({ seat, r, id: Date.now() }),
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
        <PlayPanel onExit={leave} online={{ table, send, host: me.host, scores, reaction }} />
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
      <div className="ph-glow" aria-hidden="true" />
      {!code ? (
        <Entry
          name={name}
          setName={setName}
          joinCode={joinCode}
          setJoinCode={setJoinCode}
          invited={initialCode}
          recent={memory.tables.map((t) => t.code)}
          onForget={(c) => setMemory((m) => withoutTable(m, c))}
          busy={busy}
          onEnter={enter}
          onExit={onExit}
        />
      ) : !table || !me ? (
        <div className="ot-center-card">
          <span className="ot-dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <p>{status === "reconnecting" ? "Reconnecting…" : `Joining table ${code}…`}</p>
          <button type="button" className="ot-chip-button" onClick={leave}>
            Cancel
          </button>
        </div>
      ) : table.phase === "lobby" ? (
        <Lobby table={table} me={me} send={send} onLeave={leave} />
      ) : table.phase === "ended" ? (
        <Ended table={table} scores={scores} onLeave={leave} host={me.host} onRematch={() => send({ t: "rematch" })} />
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

const INSTALL_TIP_KEY = "mjwaits.installTip";

function Entry({
  name,
  setName,
  joinCode,
  setJoinCode,
  invited,
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
  invited: string | null; // opened from an invite link to this table
  recent: string[];
  onForget: (code: string) => void;
  busy: boolean;
  onEnter: (code: string | "new") => void;
  onExit: () => void;
}) {
  const normalized = normalizeRoomCode(joinCode);
  // In a browser tab or the app on the home screen: on iPhone a link always
  // opens the browser, so an invite is carried over by copy and paste.
  const installed = isInstalledApp();
  const apple = isAppleMobile();
  const [note, setNote] = useState<string | null>(null);
  const [installTip, setInstallTip] = useState(() => {
    try {
      return !installed && localStorage.getItem(INSTALL_TIP_KEY) !== "dismissed";
    } catch {
      return !installed;
    }
  });
  const dismissInstallTip = () => {
    setInstallTip(false);
    try {
      localStorage.setItem(INSTALL_TIP_KEY, "dismissed");
    } catch {
      // Private mode: it just comes back next time.
    }
  };
  const copyInvite = async () => {
    if (!invited) return;
    try {
      await navigator.clipboard.writeText(tableLink(invited));
      setNote("Invite copied - now open MJWaits from your home screen and tap Paste invite.");
    } catch {
      setNote(`Couldn't copy - the table code is ${invited}.`);
    }
  };
  const pasteInvite = async () => {
    try {
      const code = codeFromInvite(await navigator.clipboard.readText());
      if (!code) return setNote("No invite copied - copy the link or the table code first.");
      setJoinCode(code);
      onEnter(code);
    } catch {
      setNote("Couldn't read what you copied - type the table code instead.");
    }
  };
  return (
    <div className="ot-page ot-entry">
      <BackButton onClick={onExit} label="Back" />
      <div className="ot-hero">
        <div className="ot-winds" aria-hidden="true">
          {WIND_TILES.map((t, i) => (
            <span key={i} className={`ot-wind-tile is-${i}`}>
              <TileGlyphSpan tile={t} />
            </span>
          ))}
        </div>
        <h1 className="ot-title">
          <span className="ot-title-zh">線上對局</span>
          <span className="ot-title-en">Online table</span>
        </h1>
        <p className="ot-tagline">Four seats · friends on their own phones, or bots</p>
      </div>

      <div className="ot-panel">
        <label className="ot-name">
          <span className="ot-avatar" aria-hidden="true">
            {initial(name)}
          </span>
          <span className="ot-name-text">
            <small>Playing as</small>
            <input value={name} maxLength={24} onChange={(e) => setName(e.target.value)} placeholder="Your name" autoComplete="nickname" />
          </span>
        </label>

        <button type="button" className="ph-item is-primary" disabled={busy} onClick={() => onEnter("new")}>
          <span className="ph-item-zh">開枱</span>
          <span className="ph-item-text">
            <strong>{busy ? "Making a table…" : "New table"}</strong>
            <small>You host · invite friends with a code</small>
          </span>
          <Chevron />
        </button>

        <div className="ot-join">
          <span className="ph-item-zh">入座</span>
          <input
            value={joinCode}
            onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
            onKeyDown={(e) => e.key === "Enter" && normalized && onEnter(normalized)}
            placeholder="CODE"
            aria-label="Table code"
            maxLength={8}
            autoCapitalize="characters"
            autoComplete="off"
            spellCheck={false}
          />
          <button type="button" className="ot-go" disabled={!normalized} onClick={() => normalized && onEnter(normalized)}>
            Join
          </button>
        </div>
        {installed && (
          <button type="button" className="ot-chip-button" onClick={pasteInvite}>
            Paste invite
          </button>
        )}
        {note && <p className="ot-note">{note}</p>}

        {recent.length > 0 && (
          <section className="ot-recent">
            <h2>Your tables</h2>
            <div className="ot-recent-list">
              {recent.map((c) => (
                <span key={c} className="ot-recent-chip">
                  <button type="button" onClick={() => onEnter(c)} aria-label={`Back to ${c}`}>
                    {c}
                  </button>
                  <button type="button" className="ot-recent-x" aria-label={`Dismiss ${c}`} title="Dismiss" onClick={() => onForget(c)}>
                    ×
                  </button>
                </span>
              ))}
            </div>
          </section>
        )}

        {/* Opened from an invite in the browser: if they've the app, how to take it there. */}
        {!installed && invited && (
          <section className="ot-tip">
            <h2>Got MJWaits on your home screen?</h2>
            <p>
              Links always open in the browser{apple ? " on iPhone" : ""}. To play this table in the app: tap <strong>Copy invite</strong>, open MJWaits
              from your home screen, hold its logo to open the Play table, then <strong>線上 Play online</strong> and <strong>Paste invite</strong>.
            </p>
            <button type="button" className="ot-chip-button" onClick={copyInvite}>
              Copy invite
            </button>
          </section>
        )}
        {installTip && (
          <section className="ot-tip">
            <button type="button" className="ot-tip-close" aria-label="Dismiss" onClick={dismissInstallTip}>
              ×
            </button>
            <h2>Install MJWaits</h2>
            <p>
              {apple ? (
                <>
                  Tap <strong>Share</strong> in Safari, then <strong>Add to Home Screen</strong>.
                </>
              ) : (
                <>
                  Open the browser menu, then <strong>Install app</strong> (or <strong>Add to Home screen</strong>).
                </>
              )}{" "}
              It opens full screen like an app, and keeps your tables and games on this phone.
              {invited && " Install from this page and the app opens straight at this table."}
            </p>
          </section>
        )}
      </div>
    </div>
  );
}

// ---- The lobby ------------------------------------------------------------------------------

// Seats drawn round the table as you'd sit at it: yours at the near edge,
// the next to play on your right, across, then on your left.
const PLACES = ["bottom", "right", "top", "left"] as const;
const NO_BOT = "-";

function Lobby({ table, me, send, onLeave }: { table: TableState; me: Welcome; send: (m: Send) => void; onLeave: () => void }) {
  const mySeat = table.seats.findIndex((s) => s?.kind === "human" && s.id === me.id);
  const full = table.seats.every(Boolean);
  const filled = table.seats.filter(Boolean).length;
  const s = table.settings;
  const setup = (patch: Partial<TableSettings>) => send({ t: "setup", settings: { ...s, ...patch } });
  const link = tableLink(table.code);
  const [shared, setShared] = useState(false);
  const share = async () => {
    try {
      if (navigator.share) await navigator.share({ title: "MJWaits table", text: `Join my mahjong table ${table.code}`, url: link });
      else {
        await navigator.clipboard.writeText(link);
        setShared(true);
        window.setTimeout(() => setShared(false), 2000);
      }
    } catch {
      // Dismissed.
    }
  };
  const near = mySeat >= 0 ? mySeat : 0;
  return (
    <div className="ot-page ot-lobby">
      <BackButton onClick={onLeave} label="Leave" />
      <div className="ot-room">
        <div className="ot-table">
          <div className="ot-felt" aria-hidden="true" />
          <div className="ot-center">
            <span className="ot-center-label">枱號 Table code</span>
            <span className="ot-code" aria-label={`Table code ${table.code}`}>
              {[...table.code].map((ch, i) => (
                <span key={i}>{ch}</span>
              ))}
            </span>
            <button type="button" className="ot-share" onClick={share}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 3v12M7 8l5-5 5 5M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6" />
              </svg>
              {shared ? "Link copied" : "Invite"}
            </button>
            {table.watching > 0 && <span className="ot-watching">{table.watching} watching</span>}
          </div>
          {[0, 1, 2, 3].map((k) => {
            const i = (near + k) % 4;
            const seat = table.seats[i];
            const wind = seatWind(i, s.firstDealer);
            return (
              <div
                key={i}
                aria-label={seat ? undefined : "Empty seat"}
                className={`ot-chair is-${PLACES[k]}${seat ? "" : " is-empty"}${i === mySeat ? " is-me" : ""}${seat?.kind === "human" && !seat.connected ? " is-away" : ""}`}
              >
                <span className="ot-avatar">
                  {seat ? (seat.kind === "bot" ? <BotFace /> : initial(seat.name)) : "+"}
                  <span className="ot-wind">{WIND_CHARS[wind]}</span>
                  {s.firstDealer === i && <span className="ot-dealer">莊</span>}
                </span>
                {seat && <span className="ot-chair-name">{seat.name}</span>}
                <span className="ot-chair-tags">
                  {i === mySeat && <span className="ot-tag is-you">you</span>}
                  {seat?.kind === "human" && seat.host && <span className="ot-tag">host</span>}
                  {seat?.kind === "bot" && <span className="ot-tag">bot</span>}
                  {seat?.kind === "human" && !seat.connected && <span className="ot-tag is-away">away</span>}
                </span>
                <span className="ot-chair-actions">
                  {!seat && (
                    <button type="button" className={`ot-mini${mySeat >= 0 ? "" : " is-gold"}`} onClick={() => send({ t: "sit", seat: i })}>
                      {mySeat >= 0 ? "Move" : "Sit"}
                    </button>
                  )}
                  {i === mySeat && (
                    <button type="button" className="ot-mini" onClick={() => send({ t: "stand" })}>
                      Stand
                    </button>
                  )}
                  {me.host && seat?.kind !== "human" && (
                    <select
                      className="ot-mini ot-select"
                      aria-label={`Bot in seat ${i + 1}`}
                      value=""
                      onChange={(e) => send({ t: "setBot", seat: i, bot: (e.target.value === NO_BOT ? null : e.target.value) as TableBot | null })}
                    >
                      <option value="" disabled hidden>
                        {seat ? "Swap" : "+ Bot"}
                      </option>
                      {seat && <option value={NO_BOT}>Remove the bot</option>}
                      {TABLE_BOTS.map((b) => (
                        <option key={b} value={b}>
                          {botName(b)}
                        </option>
                      ))}
                      <option value={MYSTERY_BOT}>{MYSTERY_NAME} (random)</option>
                    </select>
                  )}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      <div className="ot-side">
        <section className="ot-rules">
          <h2>
            枱例 Table rules
            {!me.host && <small> · set by the host</small>}
          </h2>
          <Setting label="One discard, several winners" note={s.multiWin ? "一炮多響: everyone who can win, wins" : "截糊: the first in turn takes it"}>
            {[false, true].map((on) => (
              <Seg key={String(on)} on={s.multiWin === on} disabled={!me.host} onClick={() => setup({ multiWin: on })}>
                {on ? "一炮多響" : "截糊"}
              </Seg>
            ))}
          </Setting>
          <Setting
            label="Losing hands at a hand's end"
            note={s.reveal === false ? "only the winner's is shown - each other player chooses whether to show theirs" : "everyone's hand is shown"}
          >
            {[true, false].map((on) => (
              <Seg key={String(on)} on={(s.reveal !== false) === on} disabled={!me.host} onClick={() => setup({ reveal: on })}>
                {on ? "Shown" : "Players choose"}
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
          {/* 換牌, as the Play table has it: off, or a preset - and which round winds swap. */}
          <Setting
            label="換牌 Swap tiles"
            note={
              s.swapRules
                ? `${SWAP_PRESETS.find((p) => p.rounds.join() === s.swapRules!.rounds.join() && p.tiles.join() === s.swapRules!.tiles.join())?.label ?? "your own dice"} · before each hand of the rounds below`
                : "no swapping"
            }
          >
            <Seg on={!s.swapRules} disabled={!me.host} onClick={() => setup({ swapRules: undefined })}>
              Off
            </Seg>
            {SWAP_PRESETS.map((p) => (
              <Seg
                key={p.name}
                on={!!s.swapRules && p.rounds.join() === s.swapRules.rounds.join() && p.tiles.join() === s.swapRules.tiles.join()}
                disabled={!me.host}
                onClick={() => setup({ swapRules: { winds: s.swapRules?.winds ?? DEFAULT_SWAP_RULES.winds, rounds: p.rounds, tiles: p.tiles } })}
              >
                {p.name}
              </Seg>
            ))}
          </Setting>
          {s.swapRules && (
            <Setting label="Rounds that swap">
              {[1, 2, 3, 4].map((w) => {
                const on = s.swapRules!.winds.includes(w);
                return (
                  <Seg
                    key={w}
                    on={on}
                    disabled={!me.host}
                    onClick={() => setup({ swapRules: { ...s.swapRules!, winds: on ? s.swapRules!.winds.filter((x) => x !== w) : [...s.swapRules!.winds, w].sort() } })}
                  >
                    {"東南西北"[w - 1]}圈
                  </Seg>
                );
              })}
            </Setting>
          )}
          <Setting label="獎池 Jackpot" note={s.jackpot ? `each puts ${s.jackpot} in on a draw; a 自摸 takes it all` : "off"}>
            {JACKPOTS.map((j) => (
              <Seg key={j} on={(s.jackpot ?? 0) === j} disabled={!me.host} onClick={() => setup({ jackpot: j })}>
                {j ? j : "Off"}
              </Seg>
            ))}
          </Setting>
          <Setting label="Bot speed">
            {(Object.keys(BOT_SPEEDS) as BotSpeed[]).map((sp) => (
              <Seg key={sp} on={(s.botSpeed ?? "normal") === sp} disabled={!me.host} onClick={() => setup({ botSpeed: sp })}>
                {sp[0].toUpperCase() + sp.slice(1)}
              </Seg>
            ))}
          </Setting>
          <Setting label="No claim back" note={s.runBack ? "off: any claim may be made" : "threw 1m: no pung, kong or run with it till you draw (from 123m, no 4m run either)"}>
            {[true, false].map((on) => (
              <Seg key={String(on)} on={!s.runBack === on} disabled={!me.host} onClick={() => setup({ runBack: !on })}>
                {on ? "On" : "Off"}
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

        <div className="ot-start">
          <span className="ot-pips" aria-label={`${filled} of 4 seats filled`}>
            {table.seats.map((seat, i) => (
              <span key={i} className={seat ? "is-on" : undefined} />
            ))}
          </span>
          {me.host ? (
            <button type="button" className={`ph-item is-primary${full ? " is-ready" : ""}`} disabled={!full} onClick={() => send({ t: "start" })}>
              <span className="ph-item-zh">開局</span>
              <span className="ph-item-text">
                <strong>{full ? "Start the game" : `${4 - filled} seat${filled === 3 ? "" : "s"} to fill`}</strong>
                <small>{full ? "Everyone's seated" : "Invite friends or add bots"}</small>
              </span>
              <Chevron />
            </button>
          ) : (
            <p className="ot-wait-note">
              <span className="ot-dots" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
              Waiting for the host to start
            </p>
          )}
        </div>
      </div>
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

// `onRematch` (the host): the same seats and rules back in the lobby.
function Ended({
  table,
  scores,
  onLeave,
  host,
  onRematch,
}: {
  table: TableState;
  scores: ScoreGame | null;
  onLeave: () => void;
  host: boolean;
  onRematch: () => void;
}) {
  const order = [0, 1, 2, 3].sort((a, b) => table.totals[b] - table.totals[a]);
  const [open, setOpen] = useState(false);
  return (
    <div className="ot-page ot-ended">
      <div className="ot-hero">
        <span className="ot-trophy" aria-hidden="true">
          {initial(table.seats[order[0]]?.name ?? "?")}
        </span>
        <h1 className="ot-title">
          <span className="ot-title-zh">終局</span>
          <span className="ot-title-en">
            Table {table.code} · {table.hand} hand{table.hand === 1 ? "" : "s"}
          </span>
        </h1>
        <p className="ot-tagline">{table.seats[order[0]]?.name ?? "?"} takes the table</p>
      </div>
      <div className="ot-panel">
        <ol className="ot-final">
          {order.map((seat, rank) => (
            <li key={seat} className={`is-${rank}`} style={{ animationDelay: `${0.1 + rank * 0.08}s` }}>
              <span className="ot-place">{PLACINGS[rank]}</span>
              <span className="ot-final-name">{table.seats[seat]?.name ?? "?"}</span>
              <span className={`ot-final-score${tone(table.totals[seat])}`}>{signed(table.totals[seat])}</span>
            </li>
          ))}
        </ol>
        {scores && (
          <button type="button" className="ph-item" onClick={() => setOpen(true)}>
            <span className="ph-item-zh">戰況</span>
            <span className="ph-item-text">
              <strong>Every hand</strong>
              <small>And each player's stats</small>
            </span>
            <Chevron />
          </button>
        )}
        {host ? (
          <button type="button" className="ph-item is-primary" onClick={onRematch}>
            <span className="ph-item-zh">再來</span>
            <span className="ph-item-text">
              <strong>Rematch</strong>
              <small>Same seats, same rules</small>
            </span>
            <Chevron />
          </button>
        ) : (
          <p className="ot-wait-note">Waiting for the host - they can start a rematch with the same seats.</p>
        )}
        <button type="button" className="ot-chip-button" onClick={onLeave}>
          Done
        </button>
      </div>
      {open && scores && <PlayScores game={scores} onClose={() => setOpen(false)} />}
    </div>
  );
}
