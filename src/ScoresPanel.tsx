// Scores tab: keeps score of a real game at the table (港式台牌 house rules),
// with analytics. All the rules live in lib/ledger.ts and the numbers in
// lib/scoreStats.ts; this file is the board (戰況), its sheets, and the
// stats views (統計).
//
// The store - the game in progress, finished games and the player roster -
// is owned by App (so the Scoring tab can send a hand here) and saved to
// localStorage on every change.

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import {
  DEFAULT_SETTINGS,
  PLAYER_COLORS,
  SEATS,
  newGame,
  previewWin,
  canRedo,
  exportScores,
  half,
  mergeScores,
  parseBackup,
  redoEvent,
  replay,
  settle,
  undoEvent,
  withEvent,
  type HandResult,
  type PatternNote,
  type ReplayState,
  type ScoreEvent,
  type ScoreGame,
  type ScoreSettings,
  type ScoreStore,
  type WinnerEntry,
} from "./lib/ledger";
import { careerStats, headToHead, marks, patternCounts, playerStats, trend, type PlayerStats } from "./lib/scoreStats";

const WIND_CHARS = ["東", "南", "西", "北"];
// Where each seat sits on the board, by seat index (turn order runs
// counter-clockwise: seat 0 along the bottom, then right, top, left).
const SEAT_AREAS = ["bottom", "right", "top", "left"] as const;
// Each area's place on the table, for pointing from one seat at another.
const AREA_XY: Record<(typeof SEAT_AREAS)[number], [number, number]> = { bottom: [0, 1], right: [1, 0], top: [0, -1], left: [-1, 0] };

// Which side of seat `from`'s card faces seat `to` - always one of the four
// sides, never a corner. The top and bottom cards point sideways at the side
// seats and straight down/up at each other; the side cards point up/down at
// the top and bottom seats and across at each other. So each of a card's
// three other players gets a side of its own.
function facing(from: number, to: number): "top" | "bottom" | "left" | "right" {
  const [ax, ay] = AREA_XY[SEAT_AREAS[from]];
  const [bx, by] = AREA_XY[SEAT_AREAS[to]];
  const dx = bx - ax;
  const dy = by - ay;
  const sideways = ax === 0 ? dx !== 0 : dy === 0;
  return sideways ? (dx < 0 ? "left" : "right") : dy < 0 ? "top" : "bottom";
}

// The board view fits the screen when at least this much height is left for
// it (px), keeping FIT_GAP clear above the tab bar.
const FIT_MIN = 470;
const FIT_GAP = 10;

// A hand sent from the Scoring tab, waiting to be recorded.
export interface RecordRequest {
  seatWind: number; // 1-4, the winner's 門風 as entered in Scoring
  selfDraw: boolean;
  tai: number; // without 莊 - the ledger adds that
  patterns: PatternNote[];
  removedDealerTai: number;
  nonce: number;
}

// Numbers: a true minus sign, one decimal only when 整數模式 is off.
const fmt = (n: number) => {
  const s = Number.isInteger(n) ? String(Math.abs(n)) : Math.abs(n).toFixed(1);
  return n < 0 ? `−${s}` : s;
};
const signed = (n: number) => (n > 0 ? `+${fmt(n)}` : fmt(n));
const pct = (r: number | null) => (r === null ? "–" : `${Math.round(r * 100)}%`);
const tone = (n: number) => (n > 0 ? "is-pos" : n < 0 ? "is-neg" : "is-zero");

// A player's palette slot; "x" (no colour class, so neutral) for a name
// typed in a sheet that isn't on the roster yet.
function colorOf(store: ScoreStore, player: string): number | "x" {
  return store.roster.find((p) => p.name === player)?.color ?? "x";
}

// ---- Icons (24px line art, the same stroke style as the tab bar) -----------

const ICON = {
  width: 22,
  height: 22,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
} as const;

const Icons = {
  newGame: (
    <svg {...ICON}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 8.5v7M8.5 12h7" />
    </svg>
  ),
  undo: (
    <svg {...ICON}>
      <path d="M9 14 4 9l5-5" />
      <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
    </svg>
  ),
  redo: (
    <svg {...ICON}>
      <path d="M15 14l5-5-5-5" />
      <path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13" />
    </svg>
  ),
  swap: (
    <svg {...ICON}>
      <path d="M7 4 3.5 7.5 7 11M3.5 7.5H17" />
      <path d="M17 13l3.5 3.5L17 20M20.5 16.5H7" />
    </svg>
  ),
  lah: (
    <svg {...ICON}>
      <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" />
      <path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
    </svg>
  ),
  settings: (
    <svg {...ICON}>
      <path d="M4 7h9M17 7h3M4 12h3M11 12h9M4 17h11M19 17h1" />
      <circle cx="15" cy="7" r="2" />
      <circle cx="9" cy="12" r="2" />
      <circle cx="17" cy="17" r="2" />
    </svg>
  ),
  plusMinus: (
    <svg {...ICON} width={11} height={11} strokeWidth={2.2}>
      <path d="M12 4v9M7.5 8.5h9M7.5 19h9" />
    </svg>
  ),
  recent: (
    <svg {...ICON} width={18} height={18}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </svg>
  ),
  close: (
    <svg {...ICON} width={18} height={18}>
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  ),
  back: (
    <svg {...ICON} width={18} height={18}>
      <path d="M15 5l-7 7 7 7" />
    </svg>
  ),
  forward: (
    <svg {...ICON} width={18} height={18}>
      <path d="M9 5l7 7-7 7" />
    </svg>
  ),
  backspace: (
    <svg {...ICON}>
      <path d="M9 5h10.5A1.5 1.5 0 0 1 21 6.5v11a1.5 1.5 0 0 1-1.5 1.5H9l-6-7z" />
      <path d="M12 9.5l5 5M17 9.5l-5 5" />
    </svg>
  ),
};

// ---- Small building blocks ---------------------------------------------------

function SectionHead({ zh, en, children }: { zh: string; en?: string; children?: ReactNode }) {
  return (
    <div className="section-head sc-section-head">
      <span className="section-title">
        {zh}
        {en && <span className="section-title-en">{en}</span>}
      </span>
      {children && <span className="section-head-actions">{children}</span>}
    </div>
  );
}

// The monogram's letters: the first, or the first two when someone else at
// the table (or on the roster) starts with the same one - Kevin "Ke", KY "KY".
function initials(store: ScoreStore, player: string): string {
  const first = (n: string) => [...n][0]?.toUpperCase() ?? "";
  const others = new Set([...store.roster.map((p) => p.name), ...(store.active?.seats ?? [])]);
  others.delete(player);
  const clash = [...others].some((n) => first(n) === first(player));
  const chars = [...player];
  return clash && chars.length > 1 ? chars[0].toUpperCase() + chars[1] : first(player);
}

// A round monogram in the player's colour - names and colours, no avatars.
function Monogram({ store, player, size = "md" }: { store: ScoreStore; player: string; size?: "sm" | "md" | "lg" }) {
  const text = initials(store, player);
  return (
    <span className={`sc-mono sc-mono-${size} sc-c${colorOf(store, player)}${[...text].length > 1 ? " is-two" : ""}`} aria-hidden="true">
      {text}
    </span>
  );
}

function Sheet({
  title,
  subtitle,
  onClose,
  children,
  actions,
  tabs,
  still,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  actions?: ReactNode;
  tabs?: ReactNode;
  // Already on screen (switching 食胡 / 特別獎罰): skip the entrance animation.
  still?: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className={`sc-backdrop${still ? " is-still" : ""}`} onClick={onClose}>
      <div className="sc-sheet" role="dialog" aria-modal="true" aria-label={typeof title === "string" ? title : undefined} onClick={(e) => e.stopPropagation()}>
        <span className="sc-grabber" aria-hidden="true" />
        <div className="sc-sheet-head">
          <div className="sc-sheet-heading">
            <h2 className="sc-sheet-title">{title}</h2>
            {subtitle && <div className="sc-sheet-subtitle">{subtitle}</div>}
          </div>
          <button type="button" className="sc-icon-button" onClick={onClose} aria-label="Close">
            {Icons.close}
          </button>
        </div>
        {tabs}
        <div className="sc-sheet-body">{children}</div>
        {actions && <div className="sc-sheet-actions">{actions}</div>}
      </div>
    </div>
  );
}

// A number pad. With `max` (the score cap), a key that would push the number
// past it is refused - the pad gives a short shake instead.
function Keypad({ value, onChange, max }: { value: string; onChange: (v: string) => void; max?: number | null }) {
  const [refused, setRefused] = useState(0);
  const press = (k: string) => {
    if (k === "⌫") return onChange(value.slice(0, -1));
    const next = value === "0" ? k : (value + k).slice(0, 5);
    if (max !== undefined && max !== null && Number(next) > max) {
      setRefused((n) => n + 1);
      return;
    }
    onChange(next);
  };
  return (
    <div key={refused} className={`sc-keypad${refused ? " is-refused" : ""}`}>
      {["1", "2", "3", "4", "5", "6", "7", "8", "9", "C", "0", "⌫"].map((k) => (
        <button
          key={k}
          type="button"
          className={k === "C" || k === "⌫" ? "is-aux" : undefined}
          onClick={() => (k === "C" ? onChange("") : press(k))}
          aria-label={k === "⌫" ? "Delete" : k === "C" ? "Clear" : k}
        >
          {k === "⌫" ? Icons.backspace : k}
        </button>
      ))}
    </div>
  );
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} className={`sc-switch${checked ? " is-on" : ""}`} onClick={() => onChange(!checked)}>
      <span />
    </button>
  );
}

function Stepper({ value, onChange, min = 0, max, step = 1, label }: { value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number; label?: string }) {
  return (
    <span className="sc-stepper" role="group" aria-label={label}>
      <button type="button" onClick={() => onChange(Math.max(min, value - step))} aria-label="Less" disabled={value <= min}>
        −
      </button>
      <span className="sc-stepper-value">{value}</span>
      <button type="button" onClick={() => onChange(max === undefined ? value + step : Math.min(max, value + step))} aria-label="More" disabled={max !== undefined && value >= max}>
        +
      </button>
    </span>
  );
}

function NumberField({ value, onChange, label }: { value: number; onChange: (v: number) => void; label: string }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  return (
    <input
      className="sc-input sc-input-short"
      inputMode="numeric"
      value={text}
      aria-label={label}
      onChange={(e) => {
        const t = e.target.value.replace(/[^0-9]/g, "").slice(0, 5);
        setText(t);
        if (t !== "") onChange(Number(t));
      }}
      onBlur={() => setText(String(value))}
    />
  );
}

function Segmented<T extends string | number>({ value, options, onChange, small }: { value: T; options: { value: T; label: ReactNode }[]; onChange: (v: T) => void; small?: boolean }) {
  return (
    <div className={`segmented sc-seg${small ? " sc-seg-small" : ""}`}>
      {options.map((o) => (
        <button key={String(o.value)} type="button" className={value === o.value ? "toggle-on" : undefined} aria-pressed={value === o.value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

// A player as a selectable option: monogram + name.
function PlayerOption({ store, player, selected, onClick, disabled, children }: { store: ScoreStore; player: string; selected?: boolean; onClick?: () => void; disabled?: boolean; children?: ReactNode }) {
  return (
    <button type="button" className={`sc-option${selected ? " is-on" : ""}`} aria-pressed={selected} onClick={onClick} disabled={disabled}>
      <Monogram store={store} player={player} size="sm" />
      <span className="sc-option-name">{player}</span>
      {children}
    </button>
  );
}

function Sparkline({ values, className }: { values: (number | null)[]; className: string }) {
  const pts = values.map((v, i) => [i, v] as const).filter((p): p is readonly [number, number] => p[1] !== null);
  if (pts.length < 2) return <svg className="sc-spark" viewBox="0 0 64 22" aria-hidden="true" />;
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const [x0, x1] = [Math.min(...xs), Math.max(...xs)];
  const lo = Math.min(0, ...ys);
  const hi = Math.max(0, ...ys);
  const x = (i: number) => 1 + ((i - x0) / (x1 - x0 || 1)) * 62;
  const y = (v: number) => 20 - ((v - lo) / (hi - lo || 1)) * 18;
  return (
    <svg className={`sc-spark ${className}`} viewBox="0 0 64 22" aria-hidden="true">
      <line x1="1" x2="63" y1={y(0)} y2={y(0)} className="sc-spark-zero" />
      <polyline points={pts.map(([i, v]) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ")} />
    </svg>
  );
}

// ---- Setup -------------------------------------------------------------------

function Setup({ store, suggestion, onStart, waitingHand }: { store: ScoreStore; suggestion: readonly string[]; onStart: (seats: string[], dealer: number) => void; waitingHand: boolean }) {
  const last = store.history[0]?.seats;
  const [names, setNames] = useState<string[]>(() => (last ?? suggestion).slice(0, SEATS).map(String));
  const [dealer, setDealer] = useState(0);
  const trimmed = names.map((n) => n.trim());
  const valid = trimmed.every(Boolean) && new Set(trimmed).size === SEATS;
  return (
    <>
      <SectionHead zh="新局" en="New game" />
      <div className="card sc-setup">
        {waitingHand && <p className="sc-note">Start a game and the hand from Scoring opens to record.</p>}
        <p className="sc-help">Players in turn order, counter-clockwise round the table. Pick who deals first.</p>
        {names.map((n, i) => (
          <div key={i} className="sc-setup-row">
            <span className="sc-setup-wind" aria-hidden="true">
              {WIND_CHARS[(i - dealer + SEATS) % SEATS]}
            </span>
            <input
              className="sc-input"
              value={n}
              maxLength={12}
              autoComplete="off"
              onChange={(e) => setNames((prev) => prev.map((x, j) => (j === i ? e.target.value : x)))}
              aria-label={`Player ${i + 1}`}
              list="sc-roster"
            />
            <button type="button" className={`sc-dealer-pick${dealer === i ? " is-on" : ""}`} aria-pressed={dealer === i} aria-label={`${trimmed[i] || `Player ${i + 1}`} deals first`} onClick={() => setDealer(i)}>
              莊
            </button>
          </div>
        ))}
        <datalist id="sc-roster">
          {store.roster.map((p) => (
            <option key={p.name} value={p.name} />
          ))}
        </datalist>
        {!valid && <p className="sc-warn">Four different names, please.</p>}
        <button type="button" className="sc-primary sc-wide" disabled={!valid} onClick={() => onStart(trimmed, dealer)}>
          開始 Start game
        </button>
      </div>
    </>
  );
}

// ---- Recording a hand: the 食胡 / 特別獎罰 sheet --------------------------------

type HandInitial = { selfDraw: boolean; tai: number; patterns: PatternNote[]; note?: string };

function HandSheet({
  store,
  state,
  seat,
  initial,
  startMode = "win",
  onDone,
  onClose,
}: {
  store: ScoreStore;
  state: ReplayState;
  seat: number;
  initial?: HandInitial;
  startMode?: "win" | "bonus";
  onDone: (ev: ScoreEvent) => void;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<"win" | "bonus">(startMode);
  const [switched, setSwitched] = useState(false);
  const player = state.seats[seat];
  const switchTo = (m: "win" | "bonus") => {
    setSwitched(true);
    setMode(m);
  };
  return mode === "win" ? (
    <WinSheet store={store} state={state} winnerSeat={seat} initial={initial} onDone={onDone} onClose={onClose} onBonus={() => switchTo("bonus")} still={switched} />
  ) : (
    <BonusSheet store={store} state={state} seat={seat} onDone={onDone} onClose={onClose} onWin={() => switchTo("win")} player={player} still={switched} />
  );
}

function ModeTabs({ mode, onWin, onBonus }: { mode: "win" | "bonus"; onWin?: () => void; onBonus?: () => void }) {
  return (
    <div className="sc-sheet-tabs">
      <Segmented
        value={mode}
        onChange={(v) => (v === "win" ? onWin?.() : onBonus?.())}
        options={[
          { value: "win", label: "食胡 Win" },
          { value: "bonus", label: "特別獎罰 Bonus" },
        ]}
      />
    </div>
  );
}

function WinSheet({
  store,
  state,
  winnerSeat,
  initial,
  onDone,
  onClose,
  onBonus,
  still,
}: {
  store: ScoreStore;
  state: ReplayState;
  winnerSeat: number;
  initial?: HandInitial;
  onDone: (ev: ScoreEvent) => void;
  onClose: () => void;
  onBonus: () => void;
  still?: boolean;
}) {
  const seats = state.seats;
  // -1 = not picked yet.
  const [from, setFrom] = useState<number | null>(initial?.selfDraw ? null : -1);
  // Each winner's tai as typed; the first is the tapped player.
  const [entries, setEntries] = useState<{ seat: number; tai: string }[]>([{ seat: winnerSeat, tai: initial ? String(initial.tai) : "" }]);
  const [focus, setFocus] = useState(0);
  const [jackpot, setJackpot] = useState(false);

  // One winner, or two or three (雙響/三響) - however many have been picked.
  const multi = entries.length;
  // A tap picks (or moves) who dealt in; 自摸 (null) is one winner only.
  const pickFrom = (s: number | null) => {
    setFrom(s);
    setEntries((e) => (s === null ? e.slice(0, 1) : e.filter((x, i) => i === 0 || x.seat !== s)));
    setFocus(0);
  };
  // A long-press adds (or drops) another winner off the same discard - rarer
  // than a mis-tapped 銃, so it doesn't take a plain tap. With three winners
  // the last player must be the one who dealt in.
  const toggleExtra = (s: number) => {
    if (s === from) return;
    const has = entries.some((e) => e.seat === s);
    if (!has && entries.length >= 3) return;
    const next = has ? entries.filter((e) => e.seat !== s) : [...entries, { seat: s, tai: "" }];
    setEntries(next);
    setFocus(has ? 0 : next.length - 1);
    if (next.length === 3) setFrom([0, 1, 2, 3].find((x) => !next.some((e) => e.seat === x))!);
    else if (from === null) setFrom(-1);
  };
  const winners: WinnerEntry[] = entries.map((e, i) => ({
    seat: e.seat,
    tai: Number(e.tai || 0),
    ...(i === 0 && initial?.patterns.length ? { patterns: initial.patterns } : {}),
  }));
  const fromValid = from === null ? multi === 1 : from >= 0;
  const complete = fromValid && entries.every((e) => e.tai !== "");
  const pairs = fromValid ? previewWin(state, winners, from) : [];
  const total = pairs.reduce((s, p) => s + p.worth, 0);

  const submit = () => {
    if (!complete) return;
    onDone({
      t: "win",
      at: Date.now(),
      winners,
      from,
      source: initial?.patterns.length ? "scoring" : "quick",
      ...(jackpot && state.pot > 0 ? { jackpotTo: seats[winnerSeat] } : {}),
    });
  };

  const verb = multi === 1 ? (from === null ? "自摸" : "食胡") : multi === 2 ? "雙響" : "三響";

  return (
    <Sheet
      title={
        <span className="sc-sheet-who">
          <Monogram store={store} player={seats[winnerSeat]} />
          {seats[winnerSeat]}
          <span className="sc-sheet-verb">{verb}</span>
        </span>
      }
      onClose={onClose}
      still={still}
      tabs={<ModeTabs mode="win" onBonus={onBonus} />}
      actions={
        <>
          <button type="button" className="sc-primary" disabled={!complete} onClick={submit}>
            {complete ? `Confirm · ${fmt(total)}` : "Confirm"}
          </button>
        </>
      }
    >
      {initial?.note && <p className="sc-note">{initial.note}</p>}

      <div className="sc-field">
        <div className="sc-field-head">
          <span className="sc-label">Who dealt in?</span>
          <span className="sc-help">Hold a player for 雙響</span>
        </div>
        <TablePicker
          store={store}
          seats={seats}
          self={winnerSeat}
          selfLabel="胡"
          selfTone="win"
          isOn={(seat) => from === seat || entries.some((e) => e.seat === seat)}
          onPick={(seat) => pickFrom(from === seat ? -1 : seat)}
          onLongPress={toggleExtra}
          tagFor={(seat) =>
            seat === from && from !== null && from >= 0
              ? { text: "銃", tone: "discard" }
              : entries.some((e) => e.seat === seat)
                ? { text: "胡", tone: "win" }
                : undefined
          }
          center={
            multi === 1
              ? { label: "自摸", sub: "Self-draw", on: from === null, onPick: () => pickFrom(null) }
              : { label: multi === 2 ? "雙響" : "三響", sub: from === null || from < 0 ? "Tap who dealt in" : `${multi} winners`, on: false }
          }
        />
      </div>

      <div className="sc-tai-row">
        <span className="sc-label">番 Tai</span>
        <div className="sc-tai-fields">
          {entries.map((e, i) => (
            <button key={e.seat} type="button" className={`sc-tai${focus === i ? " is-focus" : ""}`} onClick={() => setFocus(i)} aria-label={`${seats[e.seat]}'s tai`}>
              {multi > 1 && <span className="sc-tai-who">{seats[e.seat]}</span>}
              <span className={`sc-tai-value${e.tai ? "" : " is-empty"}`}>{e.tai || "0"}</span>
            </button>
          ))}
        </div>
        {state.pot > 0 && (
          // A checkbox, so it reads as "this win takes the Jackpot" on or off.
          <button type="button" role="switch" className={`sc-jp-pill${jackpot ? " is-on" : ""}`} aria-checked={jackpot} onClick={() => setJackpot((j) => !j)} aria-label={`${seats[winnerSeat]} takes the Jackpot of ${fmt(state.pot)}`}>
            <span className="sc-jp-box" aria-hidden="true">
              {jackpot && (
                <svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M2.5 6.2 5 8.5l4.5-5" />
                </svg>
              )}
            </span>
            <span className="sc-jp-text">
              <span className="sc-jp-label">Take JP</span>
              <span className="sc-jp-amount">{fmt(state.pot)}</span>
            </span>
          </button>
        )}
      </div>
      <Keypad max={state.settings.scoreCap} value={entries[focus]?.tai ?? ""} onChange={(v) => setEntries((prev) => prev.map((e, i) => (i === focus ? { ...e, tai: v } : e)))} />

      {/* One row of what each payer owes, always there and always the same
          height, so nothing above it moves as the hand is filled in. */}
      <ul className="sc-paylines" aria-label="What each payer owes" aria-live="polite">
        {pairs.length === 0 && <li className="is-empty">Pick who dealt in to see who pays what</li>}
        {pairs.map((p, i) => {
          const parts = [
            p.base ? `底${fmt(p.base)}` : null,
            `番${fmt(p.tai)}`,
            p.dealer ? `莊${fmt(p.dealer)}` : null,
            p.lahKind ? `${p.lahKind}${fmt(p.lah)}` : null,
          ].filter(Boolean);
          const isHigh = state.settings.highScore !== null && p.worth >= state.settings.highScore;
          return (
            <li key={i} className={isHigh ? "is-high" : undefined} title={isHigh ? `高分 — ${state.settings.highScore} or more. Double-check the tai.` : undefined}>
              <span className="sc-payline-top">
                <span className="sc-payline-who">
                  {p.payer}
                  {multi > 1 && <span className="sc-help"> → {p.winner}</span>}
                </span>
                <strong className="sc-payline-total">{fmt(p.worth)}</strong>
              </span>
              <span className="sc-payline-parts">{isHigh ? `高分 · ${parts.join(" · ")}` : parts.join(" · ")}</span>
            </li>
          );
        })}
      </ul>
    </Sheet>
  );
}

function BonusSheet({
  store,
  state,
  seat,
  player,
  onDone,
  onClose,
  onWin,
  still,
}: {
  store: ScoreStore;
  state: ReplayState;
  seat: number;
  player: string;
  onDone: (ev: ScoreEvent) => void;
  onClose: () => void;
  onWin: () => void;
  still?: boolean;
}) {
  const [kind, setKind] = useState<"獎" | "罰">("獎");
  // null = everyone else.
  const [other, setOther] = useState<number | null>(null);
  const [amount, setAmount] = useState("");
  const n = Number(amount || 0);
  const count = other === null ? 3 : 1;
  const who = other === null ? "everyone else" : state.seats[other];
  return (
    <Sheet
      title={
        <span className="sc-sheet-who">
          <Monogram store={store} player={player} />
          {player}
          <span className={`sc-sheet-verb${kind === "罰" ? " is-penalty" : ""}`}>特別{kind}</span>
        </span>
      }
      onClose={onClose}
      still={still}
      tabs={<ModeTabs mode="bonus" onWin={onWin} />}
      actions={
        <>
          <button
            type="button"
            className={kind === "獎" ? "sc-primary" : "sc-danger"}
            disabled={n <= 0}
            onClick={() => onDone({ t: "bonus", at: Date.now(), seat, amount: n, kind, ...(other !== null ? { other } : {}) })}
          >
            Confirm
          </button>
        </>
      }
    >
      <Segmented
        value={kind}
        onChange={setKind}
        options={[
          { value: "獎", label: "獎 Reward" },
          { value: "罰", label: "罰 Penalty" },
        ]}
      />
      <div className="sc-field">
        <span className="sc-label">{kind === "獎" ? "From" : "To"}</span>
        <TablePicker
          store={store}
          seats={state.seats}
          self={seat}
          selfLabel={kind}
          selfTone={kind === "罰" ? "lose" : "win"}
          isOn={(s2) => other === s2}
          onPick={setOther}
          tagFor={(s2) => (other === s2 ? (kind === "獎" ? { text: "付", tone: "discard" } : { text: "收", tone: "win" }) : undefined)}
          center={{ label: "全", sub: "Everyone", on: other === null, onPick: () => setOther(null), tone: kind === "罰" ? "lose" : "win" }}
        />
      </div>
      <div className="sc-tai-row">
        {/* Fixed width, so the field doesn't shift as "Each" ↔ "Amount" swap. */}
        <span className="sc-label sc-label-fixed">{other === null ? "Each" : "Amount"}</span>
        <div className="sc-tai-fields">
          <div className="sc-tai sc-tai-static is-focus">
            <span className={`sc-tai-value${amount ? "" : " is-empty"}`}>{amount || "0"}</span>
          </div>
        </div>
      </div>
      <Keypad max={state.settings.scoreCap} value={amount} onChange={setAmount} />
      {/* Always there and one line tall, so the keypad above never moves. */}
      <p className={`sc-summary-line${n > 0 ? "" : " is-empty"}`} aria-live="polite">
        {n <= 0 ? (
          "Enter an amount to see who pays what"
        ) : kind === "獎" ? (
            <>
              <strong>{player}</strong> <span className="is-pos">+{fmt(n * count)}</span> · {who} <span className="is-neg">−{fmt(n)}</span>
              {count > 1 && " each"}
            </>
          ) : (
            <>
              <strong>{player}</strong> <span className="is-neg">−{fmt(n * count)}</span> · {who} <span className="is-pos">+{fmt(n)}</span>
              {count > 1 && " each"}
            </>
          )}
      </p>
    </Sheet>
  );
}

// ---- The other sheets --------------------------------------------------------

// Pick a player by where they sit: the four seats as on the board (seat 0
// along the bottom, then right, top, left), with an optional button in the
// middle of the table (自摸 / Everyone). `self` is the seat the sheet is about
// - shown, marked, not pickable.
function TablePicker({
  store,
  seats,
  self,
  selfLabel,
  isOn,
  isDisabled,
  onPick,
  onLongPress,
  center,
  tagFor,
  selfTone,
}: {
  store: ScoreStore;
  seats: string[];
  self?: number;
  selfLabel?: string;
  isOn: (seat: number) => boolean;
  isDisabled?: (seat: number) => boolean;
  onPick: (seat: number) => void;
  // A held press (about half a second) - its tap is then swallowed.
  onLongPress?: (seat: number) => void;
  center?: { label: ReactNode; sub?: ReactNode; on: boolean; onPick?: () => void; tone?: "win" | "lose" };
  selfTone?: "win" | "lose";
  tagFor?: (seat: number) => { text: string; tone: "win" | "discard" } | undefined;
}) {
  const hold = useRef<{ timer: number; fired: boolean } | null>(null);
  const release = () => {
    if (hold.current) window.clearTimeout(hold.current.timer);
  };
  const press = (seat: number) =>
    onLongPress
      ? {
          onPointerDown: () => {
            release();
            const h = { timer: 0, fired: false };
            h.timer = window.setTimeout(() => {
              h.fired = true;
              onLongPress(seat);
            }, 450);
            hold.current = h;
          },
          onPointerUp: release,
          onPointerLeave: release,
          onPointerCancel: release,
          onContextMenu: (e: { preventDefault: () => void }) => e.preventDefault(),
        }
      : {};
  return (
    <div className={`sc-table-pick${onLongPress ? " can-hold" : ""}`}>
      {seats.map((player, seat) => {
        const area = SEAT_AREAS[seat];
        if (seat === self)
          return (
            <span key={seat} className={`sc-pick sc-pick-self sc-area-${area}${selfTone ? ` is-self-${selfTone}` : ""}`}>
              <Monogram store={store} player={player} size="sm" />
              <span className="sc-pick-name">{player}</span>
              {selfLabel && <span className={`sc-pick-tag${selfTone === "lose" ? " is-discard" : ""}`}>{selfLabel}</span>}
            </span>
          );
        return (
          <button
            key={seat}
            type="button"
            className={`sc-pick sc-area-${area}${isOn(seat) ? " is-on" : ""}${tagFor?.(seat)?.tone === "discard" ? " is-lose" : ""}`}
            aria-pressed={isOn(seat)}
            disabled={isDisabled?.(seat)}
            {...press(seat)}
            onClick={() => {
              if (hold.current?.fired) {
                hold.current = null;
                return;
              }
              onPick(seat);
            }}
          >
            <Monogram store={store} player={player} size="sm" />
            <span className="sc-pick-name">{player}</span>
            {tagFor?.(seat) && <span className={`sc-pick-tag is-${tagFor(seat)!.tone}`}>{tagFor(seat)!.text}</span>}
          </button>
        );
      })}
      {center &&
        (center.onPick ? (
          <button type="button" className={`sc-pick-center${center.on ? " is-on" : ""}${center.on && center.tone === "lose" ? " is-lose" : ""}`} aria-pressed={center.on} onClick={center.onPick}>
            <span className="sc-pick-center-label">{center.label}</span>
            {center.sub && <span className="sc-pick-center-sub">{center.sub}</span>}
          </button>
        ) : (
          <span className="sc-pick-center is-label">
            <span className="sc-pick-center-label">{center.label}</span>
            {center.sub && <span className="sc-pick-center-sub">{center.sub}</span>}
          </span>
        ))}
    </div>
  );
}

// A seat picker laid out like the table.
function SeatDiamond({ children }: { children: (seat: number) => ReactNode }) {
  return (
    <div className="sc-diamond">
      {[0, 1, 2, 3].map((s) => (
        <div key={s} className={`sc-diamond-seat sc-area-${SEAT_AREAS[s]}`}>
          {children(s)}
        </div>
      ))}
    </div>
  );
}

// 座位: who sits where (換人) and who's dealing (莊家). One draft across both
// tabs - a swap made under 換人 shows straight away under 莊家 - and one 確定
// that applies the lot (each change still lands as its own entry, so 還原
// takes them back one at a time).
function SeatsSheet({
  store,
  state,
  onDone,
  onClose,
}: {
  store: ScoreStore;
  state: ReplayState;
  onDone: (change: { seats: string[] | null; newNames: string[]; dealer: ScoreEvent | null }) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<"swap" | "dealer">("swap");
  const [switched, setSwitched] = useState(false);
  // Seating draft.
  const [seats, setSeats] = useState(state.seats.slice());
  const [picked, setPicked] = useState<number | null>(null);
  const [newName, setNewName] = useState("");
  const [added, setAdded] = useState<string[]>([]);
  // Dealer draft - a seat, so it reads whoever the draft seating puts there.
  const [dealer, setDealer] = useState(state.dealer);
  const [streak, setStreak] = useState(state.streak);
  const [reset, setReset] = useState(true);

  const bench = [...new Set([...store.roster.map((p) => p.name), ...state.players, ...added])].filter((p) => !seats.includes(p));
  const tapSeat = (s2: number) => {
    if (picked === null) return setPicked(s2);
    if (picked !== s2) setSeats((prev) => prev.map((p, i) => (i === s2 ? prev[picked] : i === picked ? prev[s2] : p)));
    setPicked(null);
  };
  const tapBench = (name: string) => {
    if (picked === null) return;
    setSeats((prev) => prev.map((p, i) => (i === picked ? name : p)));
    setPicked(null);
  };
  const addName = () => {
    const n = newName.trim();
    if (!n || seats.includes(n) || bench.includes(n)) return;
    setAdded((a) => [...a, n]);
    setNewName("");
  };

  const seatsChanged = seats.some((p, i) => p !== state.seats[i]);
  // 重置風局 (on by default) only rides along with a real dealer or 連莊 change.
  const dealerChanged = dealer !== state.dealer || streak !== state.streak;
  const anything = seatsChanged || dealerChanged || added.length > 0;
  const submit = () =>
    onDone({
      seats: seatsChanged ? seats : null,
      newNames: added,
      dealer: dealerChanged ? { t: "dealer", at: Date.now(), seat: dealer, streak, resetRound: reset } : null,
    });

  const pending = [seatsChanged && "seating", dealerChanged && "dealer"].filter(Boolean).join(" and ");

  return (
    <Sheet
      title="座位 Seats"
      subtitle={
        tab === "swap"
          ? picked === null
            ? "Tap a seat to move or replace that player"
            : `Now tap another seat, or a 候補 player, for ${seats[picked]}'s place`
          : "Who's dealing, the 連莊, or restart the round"
      }
      onClose={onClose}
      still={switched}
      tabs={
        <div className="sc-sheet-tabs">
          <Segmented
            value={tab}
            onChange={(v) => {
              setSwitched(true);
              setPicked(null);
              setTab(v);
            }}
            options={[
              { value: "swap", label: `換人 Players${seatsChanged ? " •" : ""}` },
              { value: "dealer", label: `莊家 Dealer${dealerChanged ? " •" : ""}` },
            ]}
          />
        </div>
      }
      actions={
        <>
          <button type="button" className="sc-primary" disabled={!anything} onClick={submit}>
            {pending ? `Confirm ${pending}` : "Confirm"}
          </button>
        </>
      }
    >
      {tab === "swap" ? (
        <>
          <SeatDiamond>{(s2) => <PlayerOption store={store} player={seats[s2]} selected={picked === s2} onClick={() => tapSeat(s2)} />}</SeatDiamond>
          <div className="sc-field">
            <span className="sc-label">候補 Bench</span>
            <div className="sc-options">
              {bench.map((p) => (
                <PlayerOption key={p} store={store} player={p} onClick={() => tapBench(p)} disabled={picked === null} />
              ))}
              {bench.length === 0 && <span className="sc-help">Nobody on the bench yet.</span>}
            </div>
            <div className="sc-add">
              <input className="sc-input" value={newName} maxLength={12} placeholder="Add a player" onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addName()} aria-label="New player name" />
              <button type="button" className="sc-secondary" onClick={addName} disabled={!newName.trim()}>
                Add
              </button>
            </div>
          </div>
        </>
      ) : (
        <>
          <SeatDiamond>
            {(s2) => (
              <PlayerOption store={store} player={seats[s2]} selected={dealer === s2} onClick={() => setDealer(s2)}>
                {dealer === s2 && <span className="sc-zhuang">莊</span>}
              </PlayerOption>
            )}
          </SeatDiamond>
          <div className="sc-list">
            <div className="sc-row">
              <span>連莊</span>
              <Stepper value={streak} onChange={setStreak} label="連莊" />
            </div>
            <label className="sc-row">
              <span>重置風局</span>
              <Toggle checked={reset} onChange={setReset} label="Reset the round" />
            </label>
          </div>
        </>
      )}
    </Sheet>
  );
}

function LahSheet({ store, state, onSurrender, onClose }: { store: ScoreStore; state: ReplayState; onSurrender: (holder: string, pulled: string) => void; onClose: () => void }) {
  // One table per holder, biggest first. Usually there's just one (the last
  // winner); a 雙響/三響 can leave several, each also keeping what they held.
  const groups = [...new Set(state.lahs.map((l) => l.holder))]
    .map((holder) => {
      const rows = state.lahs.filter((l) => l.holder === holder).sort((x, y) => y.value - x.value);
      return { holder, rows, total: rows.reduce((t, l) => t + l.value, 0) };
    })
    .sort((x, y) => y.total - x.total);
  // What the next hand between the two adds, whoever wins it: half the 拉
  // (拉 and 踢 take the same half, give or take a rounding setting).
  const next = (value: number) => half(value, state.settings.lahRound, state.settings.integerMode);
  // 投降 takes two taps: the first arms it, the second ends that 拉. A tap
  // anywhere else disarms it.
  const [armed, setArmed] = useState<string | null>(null);
  useEffect(() => {
    if (!armed) return;
    const disarm = (e: PointerEvent) => {
      if (!(e.target as Element).closest?.(".sc-lah-surrender.is-armed")) setArmed(null);
    };
    document.addEventListener("pointerdown", disarm, true);
    return () => document.removeEventListener("pointerdown", disarm, true);
  }, [armed]);
  return (
    <Sheet
      title="拉踢"
      onClose={onClose}
    >
      {groups.length === 0 && <p className="sc-empty">No 拉 on the table.</p>}
      {groups.map(({ holder, rows, total }) => (
        <div key={holder} className="sc-lah-group">
          <div className="sc-lah-head">
            <Monogram store={store} player={holder} size="sm" />
            <strong>{holder}</strong>
            <span className="sc-help">holds {fmt(total)}</span>
          </div>
          {groups.length === 1 && <p className="sc-lah-note">Ends unless {holder} wins the next hand</p>}
          <div className="sc-lah-table" role="table" aria-label={`${holder}'s 拉`}>
            <div className="sc-lah-row is-head" role="row">
              <span role="columnheader">On</span>
              <span role="columnheader">拉</span>
              <span role="columnheader">Streak</span>
              <span role="columnheader">Next</span>
              <span role="columnheader" />
            </div>
            {rows.map((l) => {
              const key = `${l.holder}>${l.pulled}`;
              const isArmed = armed === key;
              return (
                <div key={key} role="row" className="sc-lah-row">
                  <span className="sc-lah-who" role="cell">
                    <span className={`sc-dot sc-c${colorOf(store, l.pulled)}`} aria-hidden="true" />
                    {l.pulled}
                  </span>
                  <strong role="cell">{fmt(l.value)}</strong>
                  <span role="cell">{l.count}</span>
                  <span role="cell">+{fmt(next(l.value))}</span>
                  <span role="cell">
                    <button
                      type="button"
                      className={`sc-outline sc-lah-surrender${isArmed ? " is-armed" : ""}`}
                      onClick={() => {
                        if (!isArmed) return setArmed(key);
                        setArmed(null);
                        onSurrender(l.holder, l.pulled);
                      }}
                      aria-label={isArmed ? `Confirm ${l.pulled} surrenders to ${l.holder}` : `${l.pulled} surrenders to ${l.holder}`}
                    >
                      {isArmed ? "Confirm?" : "投降"}
                    </button>
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      ))}
      {groups.length > 0 && (
        <p className="sc-help sc-lah-key">
          {groups.length > 1 && "A holder's 拉 end when they don't win the next hand. "}
          Next is what the next hand between the two adds, whoever wins it.
        </p>
      )}
    </Sheet>
  );
}

function JackpotSheet({ store, state, onDone, onClose }: { store: ScoreStore; state: ReplayState; onDone: (ev: ScoreEvent) => void; onClose: () => void }) {
  const [shares, setShares] = useState<number[]>(() => state.seats.map(() => 0));
  const total = shares.reduce((a, b) => a + b, 0);
  // ± move in the pot's own unit (what each player puts in per 流局), and +
  // stops at what's left to hand out.
  const step = Math.max(1, state.settings.jackpotPerDraw || 1);
  const evenly = () => {
    const each = Math.floor(state.pot / SEATS);
    setShares(state.seats.map((_, i) => each + (i === 0 ? state.pot - each * SEATS : 0)));
  };
  return (
    <Sheet
      title={`Jackpot ${fmt(state.pot)}`}
      subtitle={`Tap a player to give them all of it, or set shares in steps of ${fmt(step)}`}
      onClose={onClose}
      actions={
        <>
          <button
            type="button"
            className="sc-primary"
            disabled={total <= 0 || total > state.pot}
            onClick={() => onDone({ t: "jackpot", at: Date.now(), shares: state.seats.map((player, i) => ({ player, amount: shares[i] })).filter((s) => s.amount > 0) })}
          >
            {total > 0 ? `Hand out ${fmt(total)}` : "Hand out"}
          </button>
        </>
      }
    >
      <div className="sc-list">
        {state.seats.map((p, i) => (
          <div key={p} className="sc-row">
            <button type="button" className="sc-row-main sc-row-button" onClick={() => setShares(state.seats.map((_, j) => (j === i ? state.pot : 0)))}>
              <Monogram store={store} player={p} size="sm" />
              {p}
            </button>
            <Stepper
              value={shares[i]}
              step={step}
              max={shares[i] + Math.max(0, state.pot - total)}
              onChange={(v) => setShares((prev) => prev.map((x, j) => (j === i ? v : x)))}
              label={`${p}'s share`}
            />
          </div>
        ))}
      </div>
      <div className="sc-row">
        <span className={total > state.pot ? "sc-warn" : "sc-help"}>
          {fmt(total)} of {fmt(state.pot)} handed out
        </span>
        <button type="button" className="sc-outline" onClick={evenly}>
          Split evenly
        </button>
      </div>
    </Sheet>
  );
}

function SettleSheet({ store, state, onEnd, onClose }: { store: ScoreStore; state: ReplayState; onEnd: () => void; onClose: () => void }) {
  const [multiplier, setMultiplier] = useState("1");
  const m = Number(multiplier) || 0;
  const payments = settle(state.totals, m);
  const [confirm, setConfirm] = useState(false);
  const [copied, setCopied] = useState(false);
  // The settlement as plain text, for the group chat.
  const text = [
    `MJWaits 結帳 · ${state.label} · ${state.hands.length}局${m !== 1 ? ` · ×${multiplier}` : ""}`,
    ...state.players
      .filter((p) => state.hands.some((h) => h.seatsAfter.includes(p)))
      .sort((a, b) => (state.totals[b] ?? 0) - (state.totals[a] ?? 0))
      .map((p) => `${p} ${signed(state.totals[p] ?? 0)}`),
    "",
    ...(payments.length ? payments.map((p) => `${p.from} → ${p.to} $${fmt(p.amount)}`) : ["Everyone is level."]),
  ].join("\n");
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      window.prompt("Copy the settlement", text);
    }
  };
  const share = async () => {
    try {
      await navigator.share({ title: "MJWaits 結帳", text });
    } catch {
      // Dismissed.
    }
  };
  return (
    <Sheet
      title="結帳 · 新局"
      subtitle="Settle up, then end this game and start a new one"
      onClose={onClose}
      actions={
        <>
          <button type="button" className={confirm ? "sc-danger" : "sc-primary"} onClick={() => (confirm ? onEnd() : setConfirm(true))}>
            {confirm ? "Tap again to confirm" : "End game"}
          </button>
        </>
      }
    >
      <div className="sc-row sc-row-boxed">
        <span>
          倍數<span className="sc-help"> · $ per tai</span>
        </span>
        <input className="sc-input sc-input-short" inputMode="decimal" value={multiplier} onChange={(e) => setMultiplier(e.target.value.replace(/[^0-9.]/g, ""))} aria-label="Multiplier" />
      </div>
      {state.pot > 0 && <p className="sc-note">Jackpot {fmt(state.pot)} is still in the pot — hand it out first if it should count.</p>}
      <div className="sc-share-row">
        <button type="button" className="sc-outline" onClick={copy}>
          {copied ? "Copied ✓" : "Copy as text"}
        </button>
        {"share" in navigator && (
          <button type="button" className="sc-outline" onClick={share}>
            Share…
          </button>
        )}
      </div>
      <div className="sc-list">
        {payments.length === 0 && <p className="sc-empty">Everyone is level.</p>}
        {payments.map((p, i) => (
          <div key={i} className="sc-pay">
            <span className="sc-pay-who">
              <Monogram store={store} player={p.from} size="sm" />
              {p.from}
            </span>
            <span className="sc-pay-arrow">
              <strong>${fmt(p.amount)}</strong>
              <svg width="44" height="10" viewBox="0 0 44 10" aria-hidden="true">
                <path d="M1 5h40M36 1l5 4-5 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
            <span className="sc-pay-who is-to">
              <Monogram store={store} player={p.to} size="sm" />
              {p.to}
            </span>
          </div>
        ))}
      </div>
    </Sheet>
  );
}

const SETTING_GROUPS: { title: string; rows: { key: keyof ScoreSettings; label: string; help?: string; kind: "number" | "bool" | "nullable" | "round" }[] }[] = [
  {
    title: "計分 Scoring",
    rows: [
      { key: "base", label: "自動計算底", help: "Added to every payment", kind: "number" },
      { key: "dealerTai", label: "自動計算莊", help: "When the dealer wins or pays", kind: "number" },
      { key: "streakTai", label: "自動計算連莊", help: "Per 連莊", kind: "number" },
      { key: "drawKeepsDealer", label: "流局留莊", kind: "bool" },
      { key: "scoreCap", label: "封頂", help: "The highest tai or amount you can type", kind: "nullable" },
    ],
  },
  {
    title: "拉踢 Pull & kick",
    rows: [
      { key: "integerMode", label: "整數模式", help: "Whole numbers only", kind: "bool" },
      { key: "lahRound", label: "拉 half", kind: "round" },
      { key: "tiRound", label: "踢 half", kind: "round" },
      { key: "fanXue", label: "反雪", help: "Paid back by each winner", kind: "bool" },
      { key: "fanXueDouble", label: "反雪 after 雙響", kind: "number" },
      { key: "fanXueTriple", label: "反雪 after 三響", kind: "number" },
    ],
  },
  {
    title: "Jackpot",
    rows: [
      { key: "jackpot", label: "Jackpot", kind: "bool" },
      { key: "jackpotPerDraw", label: "Per player per 流局", kind: "number" },
    ],
  },
  {
    title: "顯示 Display",
    rows: [
      { key: "showLah", label: "拉數提示", help: "拉 on the player cards", kind: "bool" },
      { key: "seatReminder", label: "執位提示", help: "After 北風北局", kind: "bool" },
      { key: "highScore", label: "高分提示", help: "Flag a payment this big", kind: "nullable" },
    ],
  },
];

function SettingsSheet({ settings, onSave, onClose }: { settings: ScoreSettings; onSave: (s: ScoreSettings) => void; onClose: () => void }) {
  const [s, setS] = useState<ScoreSettings>(settings);
  const set = <K extends keyof ScoreSettings>(key: K, value: ScoreSettings[K]) => setS((prev) => ({ ...prev, [key]: value }));
  return (
    <Sheet
      title="設定"
      subtitle="港式台牌 house rules · applies from the next entry"
      onClose={onClose}
      actions={
        <>
          <button type="button" className="sc-secondary" onClick={() => setS(DEFAULT_SETTINGS)}>
            Defaults
          </button>
          <button type="button" className="sc-primary" onClick={() => onSave(s)}>
            Save
          </button>
        </>
      }
    >
      {SETTING_GROUPS.map((g) => (
        <div key={g.title} className="sc-settings-group">
          <div className="sc-settings-title">{g.title}</div>
          <div className="sc-list">
            {g.rows.map(({ key, label, help, kind }) => {
              const text = (
                <span className="sc-row-main sc-row-stack">
                  {label}
                  {help && <span className="sc-help">{help}</span>}
                </span>
              );
              if (kind === "bool")
                return (
                  <label key={key} className="sc-row">
                    {text}
                    <Toggle checked={s[key] as boolean} onChange={(v) => set(key, v as never)} label={label} />
                  </label>
                );
              if (kind === "round")
                return (
                  <div key={key} className="sc-row">
                    {text}
                    <Segmented
                      small
                      value={s[key] as "up" | "down"}
                      onChange={(v) => set(key, v as never)}
                      options={[
                        { value: "up", label: "0.5進1" },
                        { value: "down", label: "捨去" },
                      ]}
                    />
                  </div>
                );
              if (kind === "nullable") {
                const value = s[key] as number | null;
                return (
                  <div key={key} className="sc-row">
                    {text}
                    <span className="sc-row-end">
                      {value !== null && <NumberField value={value} onChange={(v) => set(key, v as never)} label={label} />}
                      <Toggle checked={value !== null} onChange={(v) => set(key, (v ? DEFAULT_SETTINGS[key] ?? 50 : null) as never)} label={label} />
                    </span>
                  </div>
                );
              }
              return (
                <div key={key} className="sc-row">
                  {text}
                  <Stepper value={s[key] as number} onChange={(v) => set(key, v as never)} label={label} />
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </Sheet>
  );
}

function Confirm({ title, detail, onYes, onClose, yes = "Confirm", danger }: { title: string; detail?: string; onYes: () => void; onClose: () => void; yes?: string; danger?: boolean }) {
  return (
    <Sheet
      title={title}
      onClose={onClose}
      actions={
        <>
          <button type="button" className={danger ? "sc-danger" : "sc-primary"} onClick={onYes}>
            {yes}
          </button>
        </>
      }
    >
      {detail && <p className="sc-help sc-help-block">{detail}</p>}
    </Sheet>
  );
}

// ---- The board (戰況) -----------------------------------------------------------

type BoardSheet =
  | { kind: "hand"; seat: number; initial?: HandInitial; mode?: "win" | "bonus" }
  | { kind: "recent" }
  | { kind: "draw" }
  | { kind: "seats" }
  | { kind: "lah" }
  | { kind: "jackpot" }
  | { kind: "settle" }
  | { kind: "settings" }
;

// One non-hand entry (特別獎罰, 投降, 換人, 莊家, Jackpot, 設定) in the Recent list,
// with whatever it changed.
function EventRow({ ev, deltas }: { ev: ScoreEvent; deltas: Record<string, number> }) {
  const label =
    ev.t === "bonus"
      ? `特別${ev.kind} · ${fmt(ev.amount)}${ev.other === undefined ? " each" : ""}`
      : ev.t === "surrender"
        ? `${ev.pulled} 投降 · ${ev.holder}'s 拉 ended`
        : ev.t === "swap"
          ? `換人 · ${ev.seats.join(" · ")}`
          : ev.t === "dealer"
            ? `莊家設定${ev.streak > 0 ? ` · 連${ev.streak}` : ""}${ev.resetRound ? " · back to 東風東局" : ""}`
            : ev.t === "jackpot"
              ? "Jackpot handed out"
              : "設定 changed";
  const moved = Object.entries(deltas).filter(([, d]) => d !== 0);
  return (
    <div className="sc-hand sc-event">
      <span className="sc-hand-no">
        <span className="sc-event-dot" aria-hidden="true" />
      </span>
      <span className="sc-hand-main">
        <span className="sc-hand-what">
          <span className="sc-hand-how">{label}</span>
        </span>
      </span>
      {moved.length > 0 && (
        <span className="sc-hand-deltas">
          {moved
            .sort((a, b) => b[1] - a[1])
            .map(([p, d]) => (
              <span key={p} className={tone(d)}>
                <span className="sc-hand-delta-who">{p}</span> {signed(d)}
              </span>
            ))}
        </span>
      )}
    </div>
  );
}

function RecentSheet({
  store,
  game,
  state,
  onUndo,
  onClose,
  onSeeStats,
}: {
  store: ScoreStore;
  game: ScoreGame;
  state: ReplayState;
  onUndo: () => void;
  onClose: () => void;
  onSeeStats: () => void;
}) {
  const lastIndex = game.events.length - 1;
  const undoLabel = lastIndex >= 0 ? describeEvent(game.events[lastIndex], state, lastIndex) : "";
  const rows = game.events
    .map((ev, i) => ({ ev, i }))
    .reverse()
    .map(({ ev, i }) => {
      if (ev.t === "win" || ev.t === "draw") {
        const h = state.hands.find((x) => x.eventIndex === i);
        return h ? <HandRow key={i} h={h} store={store} /> : null;
      }
      const step = state.steps.find((x) => x.eventIndex === i);
      return <EventRow key={i} ev={ev} deltas={step?.deltas ?? {}} />;
    });
  return (
    <Sheet
      title="最近 Recent"
      subtitle={game.events.length ? `${state.hands.length}局 · ${game.events.length} entries · newest first` : "Nothing recorded yet"}
      onClose={onClose}
      actions={
        <>
          <button type="button" className="sc-secondary sc-undo-button" onClick={onUndo} disabled={lastIndex < 0}>
            還原
            {undoLabel && <span className="sc-undo-what">{undoLabel}</span>}
          </button>
          <button type="button" className="sc-primary" onClick={onSeeStats}>
            統計 Stats
          </button>
        </>
      }
    >
      {game.events.length === 0 ? (
        <p className="sc-empty">Tap the winner on the table to record a hand, or 流局 for a draw.</p>
      ) : (
        <div className="sc-list sc-list-hands">{rows}</div>
      )}
    </Sheet>
  );
}

function describeEvent(ev: ScoreEvent, state: ReplayState, i: number): string {
  if (ev.t === "win" || ev.t === "draw") {
    const h = state.hands.find((x) => x.eventIndex === i);
    if (!h) return "";
    if (h.kind === "draw") return `第${h.hand}局 流局`;
    return `第${h.hand}局 ${h.winners.map((w) => w.player).join("、")} ${h.selfDraw ? "自摸" : `食 ${h.from}`}`;
  }
  if (ev.t === "bonus") {
    const step = state.steps.find((x) => x.eventIndex === i);
    const me = Object.entries(step?.deltas ?? {}).find(([, d]) => (ev.kind === "獎" ? d > 0 : d < 0))?.[0];
    return `${me ?? ""} 特別${ev.kind} ${fmt(ev.amount)}`.trim();
  }
  if (ev.t === "surrender") return `${ev.pulled} 投降`;
  if (ev.t === "jackpot") return "Jackpot handed out";
  if (ev.t === "swap") return "換人";
  if (ev.t === "dealer") return "莊家設定";
  return "設定";
}

function Board({
  store,
  game,
  state,
  update,
  onEndGame,
  request,
  onRequestDone,
  onSeeAll,
}: {
  store: ScoreStore;
  game: ScoreGame;
  state: ReplayState;
  update: (game: ScoreGame, extra?: Partial<ScoreStore>) => void;
  onEndGame: () => void;
  request: RecordRequest | null;
  onRequestDone: () => void;
  onSeeAll: () => void;
}) {
  const [sheet, setSheet] = useState<BoardSheet | null>(null);
  const [toast, setToast] = useState<{ text: string; id: number } | null>(null);
  const [reminderHidden, setReminderHidden] = useState(false);
  const close = () => setSheet(null);
  const flash = (text: string) => {
    const id = Date.now();
    setToast({ text, id });
    window.setTimeout(() => setToast((t) => (t?.id === id ? null : t)), 2200);
  };
  const add = (ev: ScoreEvent, message?: string) => {
    update(withEvent(game, ev));
    close();
    if (message) flash(message);
    // A short buzz to confirm it went in - phones that support it only.
    try {
      navigator.vibrate?.(12);
    } catch {
      // Not available here.
    }
  };

  // A hand sent from Scoring opens the 食胡 sheet for whoever has that 門風.
  useEffect(() => {
    if (!request) return;
    const seat = [0, 1, 2, 3].find((s) => ((s - state.dealer + SEATS) % SEATS) + 1 === request.seatWind) ?? 0;
    setSheet({
      kind: "hand",
      seat,
      initial: {
        selfDraw: request.selfDraw,
        tai: request.tai,
        patterns: request.patterns,
        note: `From Scoring: ${request.tai} tai${request.removedDealerTai ? ` (莊 ${request.removedDealerTai} taken out — Scores adds its own)` : ""}. Winner picked by 門風 ${WIND_CHARS[request.seatWind - 1]}.`,
      },
    });
    onRequestDone();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);

  // The table fills exactly the space between the header and the tab bar, so
  // the board view never scrolls: measure what's left and hand it to the
  // .sc-fit column, which shares it out (the seats take the rest). On a
  // screen too short for that (under FIT_MIN) it just scrolls as normal.
  const fitRef = useRef<HTMLDivElement>(null);
  const [fitHeight, setFitHeight] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = fitRef.current;
    if (!el) return;
    const root = document.documentElement;
    const measure = () => {
      const top = el.getBoundingClientRect().top + window.scrollY;
      const bar = document.querySelector<HTMLElement>(".tab-bar");
      const barHeight = bar && getComputedStyle(bar).position === "fixed" ? bar.getBoundingClientRect().height : 0;
      const room = Math.floor(window.innerHeight - top - barHeight - FIT_GAP);
      const fits = room >= FIT_MIN;
      setFitHeight(fits ? room : null);
      root.classList.toggle("sc-fit-mode", fits);
    };
    window.scrollTo(0, 0);
    measure();
    window.addEventListener("resize", measure);
    return () => {
      window.removeEventListener("resize", measure);
      root.classList.remove("sc-fit-mode");
    };
  }, []);

  // The 執位 reminder comes back after each 北風北局.
  useEffect(() => setReminderHidden(false), [state.roundWind]);

  const undo = () => {
    if (game.events.length === 0) return;
    const i = game.events.length - 1;
    flash(`還原 · ${describeEvent(game.events[i], state, i)}`);
    update(undoEvent(game));
  };
  const redo = () => {
    const next = game.undone?.[game.undone.length - 1];
    if (!next) return;
    const redone = redoEvent(game);
    const after = replay(redone);
    flash(`重做 · ${describeEvent(next, after, redone.events.length - 1)}`);
    update(redone);
  };

  const last = state.hands[state.hands.length - 1];
  // This game's 胡 / 摸 / 銃 per player, for the line at the foot of each card.
  const counts = useMemo(() => {
    const m = new Map<string, { wins: number; selfDraws: number; dealIns: number }>();
    const get = (p: string) => m.get(p) ?? m.set(p, { wins: 0, selfDraws: 0, dealIns: 0 }).get(p)!;
    for (const h of state.hands) {
      if (h.kind !== "win") continue;
      for (const w of h.winners) {
        get(w.player).wins++;
        if (h.selfDraw) get(w.player).selfDraws++;
      }
      if (h.from) get(h.from).dealIns++;
    }
    return m;
  }, [state.hands]);

  const tools: { label: string; icon: ReactNode; onClick: () => void; disabled?: boolean; badge?: number }[] = [
    { label: "新局", icon: Icons.newGame, onClick: () => setSheet({ kind: "settle" }) },
    { label: "還原", icon: Icons.undo, onClick: undo, disabled: game.events.length === 0 },
    { label: "重做", icon: Icons.redo, onClick: redo, disabled: !canRedo(game) },
    { label: "座位", icon: Icons.swap, onClick: () => setSheet({ kind: "seats" }) },
    { label: "拉踢", icon: Icons.lah, onClick: () => setSheet({ kind: "lah" }), badge: state.lahs.length || undefined },
    { label: "最近", icon: Icons.recent, onClick: () => setSheet({ kind: "recent" }) },
    { label: "設定", icon: Icons.settings, onClick: () => setSheet({ kind: "settings" }) },
  ];

  return (
    <>
      <div className="sc-fit" ref={fitRef} style={fitHeight !== null ? { height: fitHeight } : undefined}>
      {/* The game actions. Where the game is sits in the table's corner. */}
      <div className="sc-toolbar">
        <div className="sc-tools" role="toolbar" aria-label="Game actions">
          {tools.map((t) => (
            <button key={t.label} type="button" onClick={t.onClick} disabled={t.disabled}>
              <span className="sc-tool-icon">
                {t.icon}
                {t.badge && <span className="sc-tool-badge">{t.badge}</span>}
              </span>
              <span className="sc-tool-label">{t.label}</span>
            </button>
          ))}
        </div>
      </div>

      {state.seatChangeDue && !reminderHidden && (
        <div className="sc-banner" role="status">
          <span>
            <strong>執位</strong> · 北風北 done — re-seat with 座位
          </span>
          <button type="button" className="sc-icon-button" onClick={() => setReminderHidden(true)} aria-label="Dismiss">
            {Icons.close}
          </button>
        </div>
      )}

      <div className="sc-board">
        {/* Where the game is - round and deal, the 局 count (連莊 is on the
            dealer's badge) - in the empty corner beside the top seat. */}
        <div className="sc-status">
          <span className="sc-status-round">{state.label}</span>
          <span className="sc-status-meta">第{state.hands.length + 1}局</span>
        </div>
        {state.seats.map((player, seat) => {
          const total = state.totals[player] ?? 0;
          const tally = counts.get(player) ?? { wins: 0, selfDraws: 0, dealIns: 0 };
          // Every 拉 this player is in, either side, with the seat of the other player.
          const pins = state.lahs
            .filter((l) => l.holder === player || l.pulled === player)
            .map((l) => {
              const mine = l.holder === player;
              const other = mine ? l.pulled : l.holder;
              return { other, otherSeat: state.seats.indexOf(other), sign: mine ? 1 : -1, value: l.value, count: l.count };
            })
            .filter((pin) => pin.otherSeat >= 0);
          const delta = last?.deltas[player];
          const isDealer = seat === state.dealer;
          const isQi = seat === state.roundStartDealer;
          return (
            <div key={seat} className={`sc-seat sc-area-${SEAT_AREAS[seat]}`}>
              <div className="sc-card-box">
              <button type="button" className={`sc-card sc-c${colorOf(store, player)}${isDealer ? " is-dealer" : ""}`} onClick={() => setSheet({ kind: "hand", seat })} aria-label={`${player}, ${fmt(total)}. Record a hand for ${player}`}>
                {/* 起莊: a gold corner on the seat this 圈 started from, so it's clear when 北風北 comes. */}
                {isQi && (
                  <span className="sc-qi-corner" role="img" aria-label="起莊" title="起莊 - this 圈 started here" />
                )}
                <span className="sc-card-top">
                  <span className="sc-card-name">{player}</span>
                  {isDealer && <span className="sc-zhuang-tag">{state.streak > 0 ? `莊連${state.streak}` : "莊"}</span>}
                </span>
                <span className="sc-card-score" data-anchor="score">
                  <span className={`sc-card-total ${tone(total)}`}>{fmt(total)}</span>
                  {delta !== undefined && delta !== 0 && (
                    <span key={last.eventIndex} className={`sc-delta ${tone(delta)}`} title="Last hand">
                      <span className="sc-delta-label">上局</span> {signed(delta)}
                    </span>
                  )}
                </span>
              </button>
              {/* The card opens 食胡; its 胡 · 摸 · 銃 footer opens 特別獎罰. */}
              <button
                type="button"
                className="sc-card-bonus"
                onClick={() => setSheet({ kind: "hand", seat, mode: "bonus" })}
                aria-label={`${tally.wins} wins, ${tally.selfDraws} self-draws, ${tally.dealIns} deal-ins. 特別獎罰 for ${player}`}
              >
                <span>
                  胡<strong>{tally.wins}</strong>
                </span>
                <span>
                  摸<strong>{tally.selfDraws}</strong>
                </span>
                <span>
                  銃<strong>{tally.dealIns}</strong>
                </span>
                <span className="sc-card-bonus-mark">{Icons.plusMinus}</span>
              </button>
              {/* 拉 pins on the edge facing the other player: + on the holder's card,
                  − on the pulled player's. */}
              {state.settings.showLah &&
                pins.map((pin) => (
                  <button
                    type="button"
                    key={`${pin.other}`}
                    className={`sc-pin at-${facing(seat, pin.otherSeat)} ${pin.sign > 0 ? "is-pos" : "is-neg"}`}
                    onClick={() => setSheet({ kind: "lah" })}
                    title={pin.sign > 0 ? `${player} 拉 ${pin.other}: ${fmt(pin.value)} (${pin.count}次)` : `${pin.other} 拉 ${player}: ${fmt(pin.value)} (${pin.count}次)`}
                    aria-label={`${pin.sign > 0 ? `${player} has 拉 ${fmt(pin.value)} on ${pin.other}` : `${pin.other} has 拉 ${fmt(pin.value)} on ${player}`}. Open 拉踢`}
                  >
                    {pin.sign > 0 ? "+" : "−"}
                    {fmt(pin.value)}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
        {/* The middle of the table: 流局, and the Jackpot under it. */}
        <div className="sc-center">
          <button type="button" className="sc-draw" onClick={() => setSheet({ kind: "draw" })}>
            <span className="sc-draw-zh">流局</span>
            <span className="sc-draw-en">Draw</span>
          </button>
          {state.settings.jackpot && (
            <button type="button" className={`sc-jackpot${state.pot > 0 ? " is-live" : ""}`} onClick={() => state.pot > 0 && setSheet({ kind: "jackpot" })} disabled={state.pot <= 0} aria-label={`Jackpot ${state.pot}${state.pot > 0 ? ", tap to hand it out" : ""}`}>
              <span className="sc-jackpot-label">Jackpot</span>
              <span className="sc-jackpot-value">{fmt(state.pot)}</span>
            </button>
          )}
        </div>
      </div>
      {state.hands.length === 0 && <p className="sc-hint">Tap the winner to record a hand · 流局 for a draw</p>}
      </div>

      {toast && (
        <div key={toast.id} className="sc-toast" role="status">
          {toast.text}
          {toast.text.startsWith("Recorded") && (
            <button type="button" onClick={undo}>
              還原
            </button>
          )}
          {toast.text.startsWith("還原") && canRedo(game) && (
            <button type="button" onClick={redo}>
              重做
            </button>
          )}
        </div>
      )}

      {sheet?.kind === "hand" && (
        <HandSheet
          key={`${sheet.seat}-${sheet.mode ?? "win"}`}
          store={store}
          state={state}
          seat={sheet.seat}
          initial={sheet.initial}
          startMode={sheet.mode}
          onClose={close}
          onDone={(ev) => add(ev, ev.t === "bonus" ? `Recorded 特別${ev.kind}` : "Recorded ✓")}
        />
      )}
      {sheet?.kind === "recent" && (
        <RecentSheet
          store={store}
          game={game}
          state={state}
          onUndo={undo}
          onClose={close}
          onSeeStats={() => {
            close();
            onSeeAll();
          }}
        />
      )}
      {sheet?.kind === "draw" && (
        <Confirm
          title="流局？"
          detail={
            (state.settings.jackpot && state.settings.jackpotPerDraw > 0 ? `Each player puts ${state.settings.jackpotPerDraw} into the Jackpot. ` : "") +
            (state.settings.drawKeepsDealer ? `${state.seats[state.dealer]} stays dealer (連${state.streak + 1}).` : `The deal passes to ${state.seats[(state.dealer + 1) % SEATS]}.`)
          }
          yes="流局"
          onYes={() => add({ t: "draw", at: Date.now() }, "Recorded 流局")}
          onClose={close}
        />
      )}
      {sheet?.kind === "seats" && (
        <SeatsSheet
          store={store}
          state={state}
          onClose={close}
          onDone={({ seats, newNames, dealer }) => {
            const roster = withRoster(store, [...(seats ?? state.seats), ...newNames]);
            let next = game;
            if (seats) next = withEvent(next, { t: "swap", at: Date.now(), seats });
            if (dealer) next = withEvent(next, dealer);
            update(next, { roster });
            close();
            if (seats || dealer) flash(seats && dealer ? "座位 and 莊家 updated" : seats ? "座位 updated" : "莊家 updated");
          }}
        />
      )}
      {sheet?.kind === "lah" && (
        <LahSheet
          store={store}
          state={state}
          onClose={close}
          onSurrender={(holder, pulled) => {
            update(withEvent(game, { t: "surrender", at: Date.now(), holder, pulled }));
            flash(`${pulled} 投降`);
          }}
        />
      )}
      {sheet?.kind === "jackpot" && <JackpotSheet store={store} state={state} onDone={(ev) => add(ev, "Jackpot handed out")} onClose={close} />}
      {sheet?.kind === "settle" && (
        <SettleSheet
          store={store}
          state={state}
          onClose={close}
          onEnd={() => {
            close();
            onEndGame();
          }}
        />
      )}
      {sheet?.kind === "settings" && (
        <SettingsSheet
          settings={state.settings}
          onClose={close}
          onSave={(settings) => {
            update(withEvent(game, { t: "settings", at: Date.now(), settings }), { settings });
            close();
            flash("設定 saved");
          }}
        />
      )}
    </>
  );
}

function HandRow({ h, store }: { h: HandResult; store: ScoreStore }) {
  const tags = [
    h.multi > 1 ? (h.multi === 2 ? "雙響" : "三響") : null,
    h.pairs.some((p) => p.lahKind === "拉") ? "拉" : null,
    h.pairs.some((p) => p.lahKind === "踢") ? "踢" : null,
    h.fanXue.length > 0 ? "反雪" : null,
    h.jackpotWon ? `Jackpot ${fmt(h.jackpotWon.amount)}` : null,
    h.jackpotFed > 0 ? `Jackpot +${fmt(h.jackpotFed)}` : null,
  ].filter(Boolean);
  return (
    <div className="sc-hand">
      <span className="sc-hand-no">
        <strong>{h.hand}</strong>
        <small>{h.label}</small>
      </span>
      <span className="sc-hand-main">
        <span className="sc-hand-what">
          {h.kind === "draw" ? (
            <span className="sc-hand-draw">流局</span>
          ) : (
            <>
              {h.winners.map((w) => (
                <span key={w.player} className="sc-hand-winner">
                  <Monogram store={store} player={w.player} size="sm" />
                  {w.player}
                </span>
              ))}
              <span className="sc-hand-how">{h.selfDraw ? "自摸" : `食 ${h.from}`}</span>
              <span className="sc-hand-tai">{h.winners.map((w) => `${fmt(w.tai)}番`).join(" / ")}</span>
            </>
          )}
        </span>
        {tags.length > 0 && (
          <span className="sc-tags">
            {tags.map((t) => (
              <span key={t} className="sc-tag">
                {t}
              </span>
            ))}
          </span>
        )}
      </span>
      <span className="sc-hand-deltas">
        {Object.entries(h.deltas)
          .filter(([, d]) => d !== 0)
          .sort((a, b) => b[1] - a[1])
          .map(([p, d]) => (
            <span key={p} className={tone(d)}>
              <span className="sc-hand-delta-who">{p}</span> {signed(d)}
            </span>
          ))}
      </span>
    </div>
  );
}

// ---- 統計 ------------------------------------------------------------------------

function TrendChart({ store, state }: { store: ScoreStore; state: ReplayState }) {
  const { hands, series } = trend(state);
  const [hover, setHover] = useState<number | null>(null);
  // Drawn at the container's real width, so text keeps its pixel size.
  const [box, setBox] = useState<HTMLDivElement | null>(null);
  const [W, setW] = useState(640);
  useEffect(() => {
    if (!box) return;
    const observer = new ResizeObserver(([entry]) => setW(Math.max(260, Math.round(entry.contentRect.width))));
    observer.observe(box);
    return () => observer.disconnect();
  }, [box]);
  if (hands === 0) return <p className="sc-empty">No hands yet.</p>;
  const H = Math.round(Math.min(320, Math.max(220, W * 0.62)));
  const pad = { l: 40, r: 56, t: 12, b: 26 };
  const all = series.flatMap((s) => s.values.filter((v): v is number => v !== null));
  const lo = Math.min(0, ...all);
  const hi = Math.max(0, ...all);
  const step = niceStep((hi - lo || 1) / 4);
  const yTicks: number[] = [];
  for (let v = Math.floor(lo / step) * step; v <= Math.ceil(hi / step) * step + 1e-9; v += step) yTicks.push(v);
  const yMin = Math.min(lo, yTicks[0]);
  const yMax = Math.max(hi, yTicks[yTicks.length - 1]);
  const x = (i: number) => pad.l + (i / Math.max(1, hands)) * (W - pad.l - pad.r);
  const y = (v: number) => pad.t + (1 - (v - yMin) / (yMax - yMin || 1)) * (H - pad.t - pad.b);
  const xStep = niceStep(hands / 5) || 1;
  const xTicks: number[] = [];
  for (let i = 0; i <= hands; i += xStep) xTicks.push(i);
  const path = (values: (number | null)[]) =>
    values.reduce((d, v, i) => (v === null ? d : `${d}${d === "" || values[i - 1] === null ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`), "");
  // Direct labels at each line's end, nudged apart so they don't overlap.
  const ends = series
    .map((s) => {
      const lastIdx = s.values.reduce<number>((a, v, i) => (v !== null ? i : a), -1);
      return { s, lastIdx, v: lastIdx >= 0 ? (s.values[lastIdx] as number) : 0 };
    })
    .filter((e) => e.lastIdx >= 0)
    .sort((a, b) => y(a.v) - y(b.v));
  let prevY = -Infinity;
  const labelYs = ends.map((e) => {
    const yy = Math.max(y(e.v), prevY + 14);
    prevY = yy;
    return yy;
  });

  const onMove = (e: ReactPointerEvent<SVGRectElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * (W - pad.l - pad.r);
    setHover(Math.max(0, Math.min(hands, Math.round((px / (W - pad.l - pad.r)) * hands))));
  };

  return (
    <div className="sc-chart" ref={setBox}>
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" aria-label={`Running totals over ${hands} hands`}>
        {yTicks.map((v) => (
          <g key={v}>
            <line x1={pad.l} x2={W - pad.r} y1={y(v)} y2={y(v)} className={v === 0 ? "sc-axis-zero" : "sc-grid"} />
            <text x={pad.l - 8} y={y(v)} className="sc-tick" textAnchor="end" dominantBaseline="middle">
              {fmt(v)}
            </text>
          </g>
        ))}
        {xTicks.map((i) => (
          <text key={i} x={x(i)} y={H - 8} className="sc-tick" textAnchor="middle">
            {i}
          </text>
        ))}
        {series.map((s) => (
          <path key={s.player} d={path(s.values)} className={`sc-line sc-c${colorOf(store, s.player)}`} />
        ))}
        {ends.map((e, k) => (
          <text key={e.s.player} x={x(e.lastIdx) + 6} y={labelYs[k]} className="sc-end-label" dominantBaseline="middle">
            {e.s.player}
          </text>
        ))}
        {hover !== null && (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={H - pad.b} className="sc-crosshair" />
            {series.map((s) =>
              s.values[hover] !== null && s.values[hover] !== undefined ? <circle key={s.player} cx={x(hover)} cy={y(s.values[hover] as number)} r={4.5} className={`sc-marker sc-c${colorOf(store, s.player)}`} /> : null
            )}
          </g>
        )}
        <rect x={pad.l} y={0} width={W - pad.l - pad.r} height={H} fill="transparent" onPointerMove={onMove} onPointerDown={onMove} onPointerLeave={() => setHover(null)} />
      </svg>
      {hover !== null && (
        <div className={`sc-tooltip${x(hover) > W * 0.6 ? " is-left" : ""}`} style={{ left: x(hover) }}>
          <strong>{hover === 0 ? "Start" : `第${hover}局`}</strong>
          {series
            .filter((s) => s.values[hover] !== null && s.values[hover] !== undefined)
            .sort((a, b) => (b.values[hover] as number) - (a.values[hover] as number))
            .map((s) => (
              <span key={s.player}>
                <span className={`sc-dot sc-c${colorOf(store, s.player)}`} />
                {s.player}
                <span className="sc-num">{fmt(s.values[hover] as number)}</span>
              </span>
            ))}
        </div>
      )}
    </div>
  );
}

function niceStep(raw: number): number {
  if (raw <= 0) return 1;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const n = raw / mag;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * mag;
}

type StatRow = { key: keyof PlayerStats; label: string; show: (s: PlayerStats) => string; tone?: (s: PlayerStats) => number };

// Which hand a stat happened on, and how many times a chain record was hit.
const atHand = (h: { value: number; hand: number }, show: (v: number) => string) => `${show(h.value)} · hand ${h.hand}`;
const chain = (c: { count: number; times: number } | null) => (c ? `${c.count}${c.times > 1 ? ` ×${c.times}` : ""}` : "–");

// English for the words, Chinese for the mahjong terms.
const STAT_GROUPS: { title: string; rows: StatRow[] }[] = [
  {
    title: "Record",
    rows: [
      { key: "wins", label: "食胡", show: (s) => String(s.wins) },
      { key: "selfDraws", label: "自摸", show: (s) => String(s.selfDraws) },
      { key: "dealIns", label: "出銃", show: (s) => String(s.dealIns) },
      { key: "multiWins", label: "雙響 / 三響", show: (s) => String(s.multiWins) },
      { key: "winStreak", label: "Win streak", show: (s) => String(s.winStreak) },
      { key: "assists", label: "Others' 自摸", show: (s) => String(s.assists) },
    ],
  },
  {
    title: "Rates",
    rows: [
      { key: "winRate", label: "Win rate", show: (s) => pct(s.winRate) },
      { key: "dealInRate", label: "Deal-in rate", show: (s) => pct(s.dealInRate) },
      { key: "perHand", label: "Per hand", show: (s) => (s.perHand === null ? "–" : signed(Math.round(s.perHand * 10) / 10)), tone: (s) => s.perHand ?? 0 },
      { key: "firstRate", label: "In 1st", show: (s) => pct(s.firstRate) },
      { key: "positiveRate", label: "In the plus", show: (s) => pct(s.positiveRate) },
      { key: "assistRate", label: "Others' 自摸 rate", show: (s) => pct(s.assistRate) },
    ],
  },
  {
    title: "Tai",
    rows: [
      { key: "maxTai", label: "Top tai", show: (s) => (s.maxTai ? atHand(s.maxTai, fmt) : "–") },
      { key: "avgWinTai", label: "Avg tai won", show: (s) => (s.avgWinTai === null ? "–" : s.avgWinTai.toFixed(1)) },
      { key: "avgDealInTai", label: "Avg tai dealt in", show: (s) => (s.avgDealInTai === null ? "–" : s.avgDealInTai.toFixed(1)) },
    ],
  },
  {
    title: "Points",
    rows: [
      { key: "bestHand", label: "Best hand", show: (s) => (s.bestHand ? atHand(s.bestHand, signed) : "–"), tone: () => 1 },
      { key: "worstHand", label: "Worst hand", show: (s) => (s.worstHand ? atHand(s.worstHand, fmt) : "–"), tone: () => -1 },
      { key: "selfDrawGain", label: "Won by 自摸", show: (s) => signed(s.selfDrawGain), tone: (s) => s.selfDrawGain },
      { key: "selfDrawLoss", label: "Paid on 自摸", show: (s) => fmt(s.selfDrawLoss), tone: (s) => s.selfDrawLoss },
      { key: "discardGain", label: "Won by 食胡", show: (s) => signed(s.discardGain), tone: (s) => s.discardGain },
      { key: "discardLoss", label: "Lost to 出銃", show: (s) => fmt(s.discardLoss), tone: (s) => s.discardLoss },
      { key: "bonus", label: "獎罰", show: (s) => signed(s.bonus), tone: (s) => s.bonus },
      { key: "jackpot", label: "Jackpot", show: (s) => fmt(s.jackpot) },
    ],
  },
  {
    title: "拉踢",
    rows: [
      { key: "pulls", label: "拉 others", show: (s) => String(s.pulls) },
      { key: "pulled", label: "Got 拉", show: (s) => String(s.pulled) },
      { key: "maxPull", label: "Longest 拉", show: (s) => chain(s.maxPull) },
      { key: "maxPulled", label: "Longest got 拉", show: (s) => chain(s.maxPulled) },
      { key: "kicks", label: "踢 others", show: (s) => String(s.kicks) },
      { key: "kicked", label: "Got 踢", show: (s) => String(s.kicked) },
      { key: "maxKicks", label: "Most 踢 at once", show: (s) => chain(s.maxKicks) },
      { key: "maxKicked", label: "Most got 踢", show: (s) => chain(s.maxKicked) },
      { key: "fanXue", label: "反雪", show: (s) => String(s.fanXue) },
    ],
  },
];

// Where a player's points came from and went: gains to the right of the
// middle, losses to the left, each split by how.
function PointsBar({ s }: { s: PlayerStats }) {
  const gains = [
    { label: "自摸", value: s.selfDrawGain, cls: "is-g1" },
    { label: "食胡", value: s.discardGain, cls: "is-g2" },
    { label: "獎罰", value: Math.max(0, s.bonus), cls: "is-g3" },
  ].filter((x) => x.value > 0);
  const losses = [
    { label: "出銃", value: -s.discardLoss, cls: "is-l1" },
    { label: "Paid 自摸", value: -s.selfDrawLoss, cls: "is-l2" },
    { label: "獎罰", value: Math.max(0, -s.bonus), cls: "is-l3" },
  ].filter((x) => x.value > 0);
  const gain = gains.reduce((t, x) => t + x.value, 0);
  const loss = losses.reduce((t, x) => t + x.value, 0);
  const scale = Math.max(gain, loss, 1);
  if (gain === 0 && loss === 0) return null;
  return (
    <div className="sc-pointsbar">
      <div className="sc-pointsbar-track" role="img" aria-label={`Won ${fmt(gain)}, lost ${fmt(loss)}`}>
        <div className="sc-pointsbar-half is-loss">
          {losses.map((x) => (
            <span key={x.label} className={x.cls} style={{ width: `${(x.value / scale) * 100}%` }} />
          ))}
        </div>
        <div className="sc-pointsbar-half is-gain">
          {gains.map((x) => (
            <span key={x.label} className={x.cls} style={{ width: `${(x.value / scale) * 100}%` }} />
          ))}
        </div>
      </div>
      <div className="sc-pointsbar-legend">
        <span className="is-neg">
          {losses.map((x) => (
            <span key={x.label}>
              <i className={x.cls} />
              {x.label} {fmt(x.value)}
            </span>
          ))}
        </span>
        <span className="is-pos">
          {gains.map((x) => (
            <span key={x.label}>
              <i className={x.cls} />
              {x.label} {fmt(x.value)}
            </span>
          ))}
        </span>
      </div>
    </div>
  );
}

function PlayerCard({ store, stats, state, index, onIndex }: { store: ScoreStore; stats: PlayerStats[]; state: ReplayState; index: number; onIndex: (i: number) => void }) {
  const s = stats[index];
  const markFor = useMemo(() => Object.fromEntries(STAT_GROUPS.flatMap((g) => g.rows).map((r) => [r.key, marks(stats, r.key)])), [stats]);
  const series = trend(state).series.find((x) => x.player === s.player);
  const rank = stats.slice().sort((a, b) => b.net - a.net).findIndex((x) => x.player === s.player) + 1;
  return (
    <div className="card sc-profile">
      <div className="sc-profile-head">
        <button type="button" className="sc-icon-button sc-icon-button-fill" onClick={() => onIndex((index - 1 + stats.length) % stats.length)} aria-label="Previous player">
          {Icons.back}
        </button>
        <div className="sc-profile-id">
          <Monogram store={store} player={s.player} size="lg" />
          <span className="sc-profile-name">{s.player}</span>
          <span className="sc-profile-sub">
            #{rank} of {stats.length} · {s.hands}局
          </span>
        </div>
        <button type="button" className="sc-icon-button sc-icon-button-fill" onClick={() => onIndex((index + 1) % stats.length)} aria-label="Next player">
          {Icons.forward}
        </button>
      </div>
      <div className="sc-profile-score">
        <span className={`sc-profile-net ${tone(s.net)}`}>{signed(s.net)}</span>
        {series && <Sparkline values={series.values} className={`sc-c${colorOf(store, s.player)}`} />}
      </div>
      <div className="sc-kpis">
        <span>
          <strong>{s.wins + s.selfDraws}</strong>胡
        </span>
        <span>
          <strong>{s.selfDraws}</strong>摸
        </span>
        <span>
          <strong>{s.dealIns}</strong>銃
        </span>
        <span>
          <strong>{pct(s.firstRate)}</strong>1st
        </span>
      </div>
      <PointsBar s={s} />
      <p className="sc-help sc-stat-key">👑 best and 💀 lowest at the table for that stat</p>
      {/* The first two groups open; the rest fold away until wanted. */}
      {STAT_GROUPS.map((g, gi) => (
        <details key={g.title} className="sc-stat-group" open={gi < 2}>
          <summary className="sc-stat-title">{g.title}</summary>
          <div className="sc-stat-grid">
            {g.rows.map((r) => {
              const m = markFor[r.key]?.get(s.player);
              const t = r.tone?.(s);
              return (
                <div key={r.key} className="sc-stat">
                  <span className="sc-stat-label">
                    {r.label}
                    {m && (
                      <span className="sc-mark" title={m === "best" ? "Best at the table" : "Lowest at the table"}>
                        {m === "best" ? "👑" : "💀"}
                      </span>
                    )}
                  </span>
                  <strong className={t !== undefined ? tone(t) : undefined}>{r.show(s)}</strong>
                </div>
              );
            })}
          </div>
        </details>
      ))}
    </div>
  );
}

type StatsView = "trend" | "hands" | "player" | "patterns" | "history";

// 備份: the whole store as a file to keep, and a file to bring back - for a
// new phone, or if an update ever loses something.
const BACKED_UP_KEY = "mjwaits.scoresBackedUpAt";

function readBackedUpAt(): number | null {
  try {
    const n = Number(window.localStorage.getItem(BACKED_UP_KEY));
    return n > 0 ? n : null;
  } catch {
    return null;
  }
}

function BackupCard({ store, setStore }: { store: ScoreStore; setStore: (s: ScoreStore) => void }) {
  const [backedUpAt, setBackedUpAt] = useState(readBackedUpAt);
  const [incoming, setIncoming] = useState<{ name: string; store: ScoreStore } | null>(null);
  const [message, setMessage] = useState<{ text: string; bad?: boolean } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const count = (s: ScoreStore) => s.history.length + (s.active ? 1 : 0);
  const games = (n: number) => `${n} game${n === 1 ? "" : "s"}`;
  const players = (n: number) => `${n} player${n === 1 ? "" : "s"}`;

  const download = () => {
    const now = Date.now();
    const blob = new Blob([exportScores(store, now)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const d = new Date(now);
    const pad = (n: number) => String(n).padStart(2, "0");
    a.href = url;
    a.download = `mjwaits-scores-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    try {
      window.localStorage.setItem(BACKED_UP_KEY, String(now));
    } catch {
      // Just the reminder - the file is saved either way.
    }
    setBackedUpAt(now);
    setMessage(null);
  };

  const pick = async (file: File | undefined) => {
    if (fileRef.current) fileRef.current.value = "";
    if (!file) return;
    const parsed = parseBackup(await file.text());
    if (!parsed) return setMessage({ text: `${file.name} isn't a Scores backup.`, bad: true });
    setIncoming({ name: file.name, store: parsed });
  };

  const apply = (next: ScoreStore, how: string) => {
    setStore(next);
    setIncoming(null);
    setMessage({ text: `${how} · ${games(count(next))} here now.` });
  };

  return (
    <>
      <SectionHead zh="備份" en="Backup" />
      <div className="card">
        <p className="sc-help sc-backup-status">
          {games(count(store))} · {players(store.roster.length)} ·{" "}
          {backedUpAt ? `last saved ${new Date(backedUpAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}` : "never backed up"}
        </p>
        <div className="sc-backup-actions">
          <button type="button" className="sc-primary" onClick={download} disabled={count(store) === 0 && store.roster.length === 0}>
            儲存 Save file
          </button>
          <button type="button" className="sc-secondary" onClick={() => fileRef.current?.click()}>
            還原 Restore
          </button>
          <input ref={fileRef} type="file" accept="application/json,.json" hidden onChange={(e) => void pick(e.target.files?.[0])} />
        </div>
        {message && <p className={message.bad ? "sc-warn sc-backup-message" : "sc-help sc-backup-message"}>{message.text}</p>}
      </div>
      {incoming && (
        <Sheet
          title="還原 Restore"
          subtitle={incoming.name}
          onClose={() => setIncoming(null)}
          actions={
            <>
              <button type="button" className="sc-danger" onClick={() => apply(incoming.store, "Replaced")}>
                取代 Replace
              </button>
              <button type="button" className="sc-primary" onClick={() => apply(mergeScores(store, incoming.store), "Merged")}>
                合併 Merge
              </button>
            </>
          }
        >
          <p className="sc-note">
            The file has {games(count(incoming.store))} and {players(incoming.store.roster.length)}; this phone has {games(count(store))}.
            <br />
            <strong>Merge</strong> keeps everything from both. <strong>Replace</strong> throws away what's here and uses only the file.
          </p>
        </Sheet>
      )}
    </>
  );
}

function StatsPanel({ store, setStore, view, setView }: { store: ScoreStore; setStore: (s: ScoreStore) => void; view: StatsView; setView: (v: StatsView) => void }) {
  const games = useMemo(() => [...(store.active ? [store.active] : []), ...store.history], [store]);
  const [gameId, setGameId] = useState<string | null>(null);
  const game = games.find((g) => g.id === gameId) ?? games[0] ?? null;
  const [playerIndex, setPlayerIndex] = useState(0);
  const state = useMemo(() => (game ? replay(game) : null), [game]);
  const stats = useMemo(() => (game && state ? playerStats(state, game).filter((s) => s.hands > 0) : []), [game, state]);
  const series = useMemo(() => (state ? trend(state).series : []), [state]);

  if (!game || !state)
    return (
      <>
        <div className="card sc-empty-card">
          <p className="sc-empty">No games yet — start one on 戰況.</p>
        </div>
        <BackupCard store={store} setStore={setStore} />
      </>
    );

  const views: { value: StatsView; label: string }[] = [
    { value: "trend", label: "走勢" },
    { value: "hands", label: "局" },
    { value: "player", label: "玩家" },
    { value: "patterns", label: "牌型" },
    { value: "history", label: "紀錄" },
  ];
  const ranked = stats.slice().sort((a, b) => b.net - a.net);
  const isActive = game === store.active;

  return (
    <>
      <SectionHead zh="玩家統計" en={isActive ? "This game" : new Date(game.startedAt).toLocaleDateString()}>
        <span className="sc-help">{state.hands.length}局</span>
      </SectionHead>
      <div className="card sc-board-table">
        {ranked.length === 0 && <p className="sc-empty">No hands yet.</p>}
        {ranked.map((s, i) => (
          <button
            key={s.player}
            type="button"
            className="sc-leader"
            onClick={() => {
              setPlayerIndex(stats.findIndex((x) => x.player === s.player));
              setView("player");
            }}
          >
            <span className={`sc-leader-rank is-${i + 1}`}>{i + 1}</span>
            <Monogram store={store} player={s.player} />
            <span className="sc-leader-id">
              <span className="sc-leader-name">{s.player}</span>
              <span className="sc-leader-sub">
                <span>
                  胡{s.wins + s.selfDraws} 摸{s.selfDraws} 銃{s.dealIns}
                </span>
                {s.bonus !== 0 && <span>獎{signed(s.bonus)}</span>}
              </span>
            </span>
            <Sparkline values={series.find((x) => x.player === s.player)?.values ?? []} className={`sc-c${colorOf(store, s.player)}`} />
            <span className={`sc-leader-net ${tone(s.net)}`}>{signed(s.net)}</span>
          </button>
        ))}
      </div>

      <div className="sc-views">
        <Segmented value={view} onChange={setView} options={views} />
      </div>

      {view === "hands" && (
        <div className="card sc-list-card">
          {state.hands.length === 0 && <p className="sc-empty">No hands yet.</p>}
          {state.hands
            .slice()
            .reverse()
            .map((h) => (
              <HandRow key={h.eventIndex} h={h} store={store} />
            ))}
        </div>
      )}
      {view === "trend" && (
        <div className="card">
          <div className="sc-card-head">
            <h3>走勢 Trend</h3>
            <span className="sc-help">Running totals · touch for 局 detail</span>
          </div>
          <TrendChart store={store} state={state} />
        </div>
      )}
      {view === "patterns" && <PatternsCard state={state} store={store} />}
      {view === "player" && stats.length > 0 && <PlayerCard store={store} stats={stats} state={state} index={Math.min(playerIndex, stats.length - 1)} onIndex={setPlayerIndex} />}
      {view === "history" && (
        <HistoryCard
          store={store}
          games={games}
          current={game.id}
          onPick={(id) => {
            setGameId(id);
            setView("trend");
          }}
          onDelete={(id) => setStore({ ...store, history: store.history.filter((g) => g.id !== id) })}
        />
      )}
      {view === "history" && <BackupCard store={store} setStore={setStore} />}
    </>
  );
}

function PatternsCard({ state, store }: { state: ReplayState; store: ScoreStore }) {
  const rows = patternCounts(state);
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <div className="card">
      <div className="sc-card-head">
        <h3>牌型 Patterns</h3>
        <span className="sc-help">From hands sent from Scoring</span>
      </div>
      {rows.length === 0 ? (
        <p className="sc-empty">Use Record to Scores on the Scoring tab, and the patterns behind each hand show up here.</p>
      ) : (
        <ul className="sc-patterns">
          {rows.map((r) => (
            <li key={r.name}>
              <span className="sc-pattern-name">{r.name}</span>
              <span className="sc-pattern-bar" aria-hidden="true">
                <span style={{ width: `${(r.count / max) * 100}%` }} />
              </span>
              <strong className="sc-num">{r.count}</strong>
              <span className="sc-pattern-who">
                {Object.entries(r.byPlayer).map(([p, n]) => (
                  <span key={p}>
                    <span className={`sc-dot sc-c${colorOf(store, p)}`} />
                    {p} {n}
                  </span>
                ))}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function HistoryCard({ store, games, current, onPick, onDelete }: { store: ScoreStore; games: ScoreGame[]; current: string; onPick: (id: string) => void; onDelete: (id: string) => void }) {
  const [confirm, setConfirm] = useState<string | null>(null);
  const career = useMemo(() => careerStats(games), [games]);
  const h2h = useMemo(() => headToHead(games), [games]);
  const names = career.map((c) => c.player);
  return (
    <>
      <div className="card sc-list-card">
        {games.map((g) => {
          const st = replay(g);
          const ranked = st.players.filter((p) => st.hands.some((h) => h.seatsAfter.includes(p))).sort((a, b) => (st.totals[b] ?? 0) - (st.totals[a] ?? 0));
          return (
            <div key={g.id} className={`sc-game${g.id === current ? " is-current" : ""}`}>
              <button type="button" className="sc-game-main" onClick={() => onPick(g.id)}>
                <span className="sc-game-date">
                  {g === store.active ? "In progress" : new Date(g.startedAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}
                  <span className="sc-help"> · {st.hands.length}局</span>
                  {g.id === current && <span className="sc-chip-accent">Showing</span>}
                </span>
                <span className="sc-game-totals">
                  {ranked.map((p, i) => (
                    <span key={p} className={i === 0 ? "is-first" : undefined}>
                      {i === 0 && "🏆 "}
                      {p} <span className={tone(st.totals[p] ?? 0)}>{signed(st.totals[p] ?? 0)}</span>
                    </span>
                  ))}
                </span>
              </button>
              {g !== store.active && (
                <button type="button" className={`sc-icon-button${confirm === g.id ? " is-armed" : ""}`} onClick={() => (confirm === g.id ? onDelete(g.id) : setConfirm(g.id))} aria-label={confirm === g.id ? "Tap again to delete this game" : "Delete this game"}>
                  {confirm === g.id ? <span className="sc-armed-text">Delete</span> : Icons.close}
                </button>
              )}
            </div>
          );
        })}
      </div>
      <SectionHead zh="生涯" en="Career" />
      <div className="card sc-table-card">
        <div className="sc-table-wrap">
          <table className="sc-table">
            <thead>
              <tr>
                <th>Player</th>
                <th>Games</th>
                <th>Net</th>
                <th className="sc-opt">Avg</th>
                <th>1st</th>
                <th>Win</th>
                <th>銃</th>
                <th className="sc-opt">Best</th>
              </tr>
            </thead>
            <tbody>
              {career.map((c) => (
                <tr key={c.player}>
                  <th>
                    <span className="sc-table-player">
                      <Monogram store={store} player={c.player} size="sm" />
                      {c.player}
                    </span>
                  </th>
                  <td>{c.games}</td>
                  <td className={tone(c.net)}>{signed(c.net)}</td>
                  <td className="sc-opt">{fmt(Math.round(c.avgNet * 10) / 10)}</td>
                  <td>{c.firsts}</td>
                  <td>{pct(c.winRate)}</td>
                  <td>{pct(c.dealInRate)}</td>
                  <td className="sc-opt">{c.bestHand === null ? "–" : fmt(c.bestHand)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {names.length > 1 && (
        <>
          <SectionHead zh="對戰" en="Head-to-head">
            <span className="sc-help">Row vs column</span>
          </SectionHead>
          <div className="card sc-table-card">
            <div className="sc-table-wrap">
              <table className="sc-table sc-h2h">
                <thead>
                  <tr>
                    <th />
                    {names.map((n) => (
                      <th key={n}>{n}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {names.map((a) => (
                    <tr key={a}>
                      <th>
                        <span className="sc-table-player">
                          <Monogram store={store} player={a} size="sm" />
                          {a}
                        </span>
                      </th>
                      {names.map((b) => {
                        const v = a === b ? null : (h2h[a]?.[b] ?? 0);
                        return (
                          <td key={b} className={v === null ? "sc-cell-self" : tone(v)}>
                            {v === null ? "" : signed(v)}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </>
  );
}

// ---- The tab ------------------------------------------------------------------------

function withRoster(store: ScoreStore, names: string[]) {
  const roster = store.roster.slice();
  for (const name of names) {
    if (roster.some((p) => p.name === name)) continue;
    const used = new Set(roster.map((p) => p.color));
    const color = [...Array(PLAYER_COLORS).keys()].find((c) => !used.has(c)) ?? roster.length % PLAYER_COLORS;
    roster.push({ name, color });
  }
  return roster;
}

export function ScoresPanel({
  store,
  setStore,
  seatNames,
  request,
  onRequestDone,
}: {
  store: ScoreStore;
  setStore: (s: ScoreStore) => void;
  seatNames: readonly string[];
  request: RecordRequest | null;
  onRequestDone: () => void;
}) {
  const [sub, setSub] = useState<"board" | "stats">("board");
  const [view, setView] = useState<StatsView>("trend");
  useEffect(() => {
    if (request) setSub("board");
  }, [request]);
  const game = store.active;
  const state = useMemo(() => (game ? replay(game) : null), [game]);

  const update = (next: ScoreGame, extra: Partial<ScoreStore> = {}) => setStore({ ...store, ...extra, active: next });
  const endGame = () => {
    if (!game) return;
    const finished = { ...game, endedAt: Date.now() };
    setStore({ ...store, active: null, history: game.events.length > 0 ? [finished, ...store.history] : store.history });
  };
  const start = (seats: string[], dealer: number) => setStore({ ...store, roster: withRoster(store, seats), active: newGame(seats, dealer, store.settings) });

  return (
    <section className="panel scores-panel">
      <div className="segmented sub-tabs">
        <button type="button" className={sub === "board" ? "toggle-on" : undefined} aria-pressed={sub === "board"} onClick={() => setSub("board")}>
          戰況 Table
        </button>
        <button type="button" className={sub === "stats" ? "toggle-on" : undefined} aria-pressed={sub === "stats"} onClick={() => setSub("stats")}>
          統計 Stats
        </button>
      </div>
      {sub === "board" &&
        (game && state ? (
          <Board
            store={store}
            game={game}
            state={state}
            update={update}
            onEndGame={endGame}
            request={request}
            onRequestDone={onRequestDone}
            onSeeAll={() => {
              setView("hands");
              setSub("stats");
            }}
          />
        ) : (
          <>
            <Setup store={store} suggestion={seatNames} onStart={start} waitingHand={request !== null} />
            <BackupCard store={store} setStore={setStore} />
          </>
        ))}
      {sub === "stats" && <StatsPanel store={store} setStore={setStore} view={view} setView={setView} />}
    </section>
  );
}
