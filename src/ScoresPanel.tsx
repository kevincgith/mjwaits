// Scores tab: keeps score of a real game at the table (港式台牌 house rules),
// with analytics. All the rules live in lib/ledger.ts and the numbers in
// lib/scoreStats.ts; this file is the board (戰況), its sheets, and the
// stats views (統計).
//
// The store - the game in progress, finished games and the player roster -
// is owned by App (so the Scoring tab can send a hand here) and saved to
// localStorage on every change.

import { Fragment, type RefObject, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import {
  DEFAULT_SETTINGS,
  PLAYER_COLORS,
  SEATS,
  newGame,
  previewFanXue,
  previewWin,
  canRedo,
  exportScores,
  half,
  mergeScores,
  parseBackup,
  redoEvent,
  replay,
  roundLabel,
  settle,
  deleteEvent,
  replaceEvent,
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
  SETTING_ON_VALUE,
  chipMoves,
  evenShares,
  playTimes,
  zhaHuKicks,
} from "./lib/ledger";
import { snapshotOf, snapshotUrl, type ScoreSnapshot } from "./lib/scoreShare";
import { drawSettleCard } from "./lib/settleImage";
import qrcode from "qrcode-generator";
import { createPortal } from "react-dom";
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
  // Set when the hand was started from a Scores 食胡 sheet (ScoreHandRequest):
  // straight back to that winner, with who dealt in and the Jackpot as picked.
  seat?: number;
  from?: number | null;
  jackpot?: boolean;
  // Cancelled on Scoring: just reopen that sheet as it was, with no tai.
  reopenOnly?: boolean;
  draft?: ScoreHandRequest["draft"]; // a 雙響/三響 sheet to put back together
  zhaHu?: ScoreHandRequest["zhaHu"]; // a 詐胡 sheet to put back together

  nonce: number;
}

// A hand to work out on the Scoring tab, asked for from a Scores 食胡 sheet -
// Scoring opens set up for it, and sends the result back as a RecordRequest.
export interface ScoreHandRequest {
  seat: number;
  player: string;
  from: number | null; // null = 自摸, -1 = not picked yet
  fromName: string | null;
  jackpot: boolean;
  roundWind: 1 | 2 | 3 | 4;
  seatWind: 1 | 2 | 3 | 4;
  scan: boolean; // open the camera straight away
  fromCard?: boolean; // a card's 快速掃描 button, not a 食胡 sheet
  // A 雙響/三響: the sheet's own winner and every winner's tai so far, so
  // the sheet comes back whole with just `seat`'s tai filled in.
  draft?: { sheetSeat: number; entries: { seat: number; tai: string }[] };
  // A 詐胡: each player's amount so far. The scored hand comes back as what
  // it would pay each of them off their discard, 詐胡's 設定 amount at least.
  zhaHu?: { player: string; amount: number }[];
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
  // A plus on a tile: a new game.
  newGame: (
    <svg {...ICON}>
      <rect x="4" y="4" width="16" height="16" rx="4" />
      <path d="M12 8.5v7M8.5 12h7" />
    </svg>
  ),
  // An armchair: who sits where (座位).
  seat: (
    <svg {...ICON}>
      <path d="M7 11V7.5A2.5 2.5 0 0 1 9.5 5h5A2.5 2.5 0 0 1 17 7.5V11" />
      <path d="M5 11a2 2 0 0 1 2 2v1h10v-1a2 2 0 1 1 4 0v3.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 16.5V13a2 2 0 0 1 2-2z" />
      <path d="M6 18v1.5M18 18v1.5" />
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
  dice: (
    <svg {...ICON} width={16} height={16}>
      {/* The Dice tab's own die: three. */}
      <rect x="4" y="4" width="16" height="16" rx="3.5" />
      <circle cx="8.5" cy="8.5" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="15.5" cy="15.5" r="1.3" fill="currentColor" stroke="none" />
    </svg>
  ),
  shuffle: (
    <svg {...ICON} width={16} height={16}>
      <path d="M4 7h3.5c2 0 3 1 4.5 3.5S14.5 17 16.5 17H20M4 17h3.5c1.2 0 2-.4 2.8-1.2M14 8.2c.7-.8 1.5-1.2 2.5-1.2H20" />
      <path d="M17.5 4.5 20 7l-2.5 2.5M17.5 14.5 20 17l-2.5 2.5" />
    </svg>
  ),
  rotate: (
    <svg {...ICON} width={16} height={16}>
      <path d="M19 12a7 7 0 1 1-2.05-4.95" />
      <path d="M19 4.5v4h-4" />
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
  camera: (
    <svg {...ICON} width={16} height={16}>
      <path d="M4 8.5A1.5 1.5 0 0 1 5.5 7h2l1.5-2h6l1.5 2h2A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z" />
      <circle cx="12" cy="13" r="3.5" />
    </svg>
  ),
  tiles: (
    <svg {...ICON} width={16} height={16}>
      <rect x="4" y="5" width="7" height="10" rx="1.5" />
      <rect x="13" y="5" width="7" height="10" rx="1.5" />
      <path d="M4 19h16" />
    </svg>
  ),
  // 特別獎罰: ±.
  plusMinus: (
    <svg {...ICON} width={14} height={14} strokeWidth={2.6}>
      <path d="M12 4v9M7.5 8.5h9M7.5 19h9" />
    </svg>
  ),
  // A clock turning back: what's happened (最近), not the time.
  recent: (
    <svg {...ICON}>
      <path d="M4.2 13A8 8 0 1 0 6.3 6.3L4 8.5" />
      <path d="M4 4.5v4h4" />
      <path d="M12 8v4l2.8 1.8" />
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

// The monogram's letters: the first, or - when someone else at the table (or
// on the roster) starts with the same one - the first plus the first letter
// where this name differs from theirs: Kevin "Kv" and Kelvin "Kl", KY "KY".
function initials(store: ScoreStore, player: string): string {
  const first = (n: string) => [...n][0]?.toUpperCase() ?? "";
  const others = new Set([...store.roster.map((p) => p.name), ...(store.active?.seats ?? [])]);
  others.delete(player);
  const clashing = [...others].filter((n) => first(n) === first(player)).map((n) => [...n.toLowerCase()]);
  const chars = [...player];
  if (clashing.length === 0 || chars.length < 2) return first(player);
  const lower = player.toLowerCase();
  const pick = chars.findIndex((c, i) => i > 0 && c.trim() !== "" && clashing.every((o) => o[i] !== [...lower][i]));
  const fallback = chars.findIndex((c, i) => i > 0 && c.trim() !== "");
  return chars[0].toUpperCase() + chars[pick > 0 ? pick : Math.max(1, fallback)];
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

// The 食胡 and 特別獎罰 tabs are two sheets kept mounted together: the one not
// showing is parked (invisible, inert), and both take the taller one's
// height, so switching tabs never moves anything.
interface SheetFrame {
  ref: RefObject<HTMLDivElement | null>;
  minHeight?: number;
  hidden: boolean;
}

function Sheet({
  title,
  subtitle,
  onClose,
  children,
  actions,
  tabs,
  still,
  frame,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  actions?: ReactNode;
  tabs?: ReactNode;
  // Already on screen (switching 食胡 / 特別獎罰): skip the entrance animation.
  still?: boolean;
  frame?: SheetFrame;
}) {
  const hidden = frame?.hidden ?? false;
  useEffect(() => {
    if (hidden) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, hidden]);
  return (
    <div className={`sc-backdrop${still ? " is-still" : ""}${hidden ? " is-parked" : ""}`} onClick={onClose} inert={hidden || undefined} aria-hidden={hidden || undefined}>
      <div
        ref={frame?.ref}
        className="sc-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === "string" ? title : undefined}
        style={frame?.minHeight ? { minHeight: frame.minHeight } : undefined}
        onClick={(e) => e.stopPropagation()}
      >
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

function Stepper({ value, onChange, min = 0, max, step = 1, label, disabled }: { value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number; label?: string; disabled?: boolean }) {
  return (
    <span className={`sc-stepper${disabled ? " is-disabled" : ""}`} role="group" aria-label={label} aria-disabled={disabled || undefined}>
      <button type="button" onClick={() => onChange(Math.max(min, value - step))} aria-label="Less" disabled={disabled || value <= min}>
        −
      </button>
      <span className="sc-stepper-value">{value}</span>
      <button type="button" onClick={() => onChange(max === undefined ? value + step : Math.min(max, value + step))} aria-label="More" disabled={disabled || (max !== undefined && value >= max)}>
        +
      </button>
    </span>
  );
}

function NumberField({ value, onChange, label, pill, disabled }: { value: number; onChange: (v: number) => void; label: string; pill?: boolean; disabled?: boolean }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  return (
    <input
      className={pill ? "sc-input sc-input-pill" : "sc-input sc-input-short"}
      inputMode="numeric"
      value={text}
      aria-label={label}
      disabled={disabled}
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
function PlayerOption({
  store,
  player,
  selected,
  onClick,
  disabled,
  press,
  dataPlayer,
  children,
}: {
  store: ScoreStore;
  player: string;
  selected?: boolean;
  onClick?: () => void;
  disabled?: boolean;
  press?: Record<string, unknown>; // pointer handlers for a hold
  dataPlayer?: string; // for the 座位 slide animation
  children?: ReactNode;
}) {
  return (
    <button
      type="button"
      className={`sc-option${selected ? " is-on" : ""}${press ? " can-hold" : ""}`}
      aria-pressed={selected}
      data-player={dataPlayer}
      {...press}
      onClick={onClick}
      disabled={disabled}
    >
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

// `entries`: a 雙響/三響 draft back from Scoring - every winner's tai so far,
// with `tai` and `patterns` belonging to `patternsFor` (that winner's seat).
type HandInitial = {
  selfDraw: boolean;
  tai?: number;
  patterns: PatternNote[];
  note?: string;
  from?: number | null;
  jackpot?: boolean;
  entries?: DraftEntry[];
  patternsFor?: number;
  // Fixing a 特別獎罰 entry: the tab opens as it was recorded.
  bonus?: { kind: "獎" | "罰"; other: number | null; amount: number };
  // Fixing a 詐胡 entry: each player's amount as recorded.
  zhaHu?: { player: string; amount: number }[];
};

// The 胡 sheet's views: 食胡, 特別獎罰, and 詐胡 - part of the 食胡 tab, opened
// from its foot when it's switched on in 設定.
type HandMode = "win" | "bonus" | "zhaHu";

type DraftEntry = { seat: number; tai: string };

// What the 食胡 sheet hands over when asking Scoring to work a hand out:
// `target` is the winner being scored, `entries` the whole draft.
type ScoreHandAsk = { from: number | null; jackpot: boolean; scan: boolean; target: number; entries: DraftEntry[]; zhaHu?: { player: string; amount: number }[] };

function HandSheet({
  store,
  state,
  seat,
  initial,
  startMode = "win",
  onDone,
  onClose,
  onScoreHand,
}: {
  store: ScoreStore;
  state: ReplayState;
  seat: number;
  initial?: HandInitial;
  startMode?: HandMode;
  onDone: (ev: ScoreEvent) => void;
  onClose: () => void;
  onScoreHand?: (ask: ScoreHandAsk) => void;
}) {
  const [mode, setMode] = useState<HandMode>(startMode);
  const player = state.seats[seat];
  const zhaHuOn = state.settings.zhaHu !== null || initial?.zhaHu !== undefined;
  const onZhaHu = zhaHuOn ? () => setMode("zhaHu") : undefined;
  const zhaHuRef = useRef<HTMLDivElement>(null);
  // Both sheets' natural heights, measured before paint (and again on a
  // resize); each then gets the taller as its min-height.
  const winRef = useRef<HTMLDivElement>(null);
  const bonusRef = useRef<HTMLDivElement>(null);
  const [minHeight, setMinHeight] = useState<number | undefined>(undefined);
  useLayoutEffect(() => {
    const measure = () => {
      const els = [winRef.current, bonusRef.current, zhaHuRef.current].filter((el): el is HTMLDivElement => el !== null);
      els.forEach((el) => (el.style.minHeight = ""));
      const tallest = Math.max(...els.map((el) => el.offsetHeight));
      els.forEach((el) => (el.style.minHeight = `${tallest}px`));
      setMinHeight(tallest);
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);
  return (
    <>
      <WinSheet
        store={store}
        state={state}
        winnerSeat={seat}
        initial={initial?.zhaHu ? undefined : initial}
        onDone={onDone}
        onClose={onClose}
        onBonus={() => setMode("bonus")}
        onZhaHu={onZhaHu}
        onScoreHand={onScoreHand}
        frame={{ ref: winRef, minHeight, hidden: mode !== "win" }}
      />
      <BonusSheet
        store={store}
        state={state}
        seat={seat}
        onDone={onDone}
        onClose={onClose}
        onWin={() => setMode("win")}
        player={player}
        initial={initial?.bonus}
        frame={{ ref: bonusRef, minHeight, hidden: mode !== "bonus" }}
      />
      {zhaHuOn && (
        <ZhaHuSheet
          store={store}
          state={state}
          seat={seat}
          player={player}
          initial={initial?.zhaHu}
          note={initial?.zhaHu ? initial.note : undefined}
          onDone={onDone}
          onClose={onClose}
          onWin={() => setMode("win")}
          onBonus={() => setMode("bonus")}
          onScoreHand={onScoreHand}
          frame={{ ref: zhaHuRef, minHeight, hidden: mode !== "zhaHu" }}
        />
      )}
    </>
  );
}

function ModeTabs({ mode, onWin, onBonus }: { mode: HandMode; onWin?: () => void; onBonus?: () => void }) {
  // 詐胡 lives on the 食胡 tab.
  return (
    <div className="sc-sheet-tabs">
      <Segmented
        value={mode === "bonus" ? "bonus" : "win"}
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
  onZhaHu,
  onScoreHand,
  frame,
}: {
  store: ScoreStore;
  state: ReplayState;
  winnerSeat: number;
  initial?: HandInitial;
  onDone: (ev: ScoreEvent) => void;
  onClose: () => void;
  onBonus: () => void;
  onZhaHu?: () => void;
  onScoreHand?: (ask: ScoreHandAsk) => void;
  frame?: SheetFrame;
}) {
  const seats = state.seats;
  // -1 = not picked yet.
  const [from, setFrom] = useState<number | null>(initial?.from !== undefined ? initial.from : initial?.selfDraw ? null : -1);
  // Each winner's tai as typed; the first is the tapped player.
  const [entries, setEntries] = useState<DraftEntry[]>(
    () => initial?.entries ?? [{ seat: winnerSeat, tai: initial?.tai !== undefined ? String(initial.tai) : "" }],
  );
  // Back from Scoring on a 雙響/三響: the winner just scored is in focus.
  const [focus, setFocus] = useState(() => Math.max(0, initial?.entries?.findIndex((e) => e.seat === initial.patternsFor) ?? 0));
  const patternsFor = initial?.patternsFor ?? winnerSeat;
  const [jackpot, setJackpot] = useState(initial?.jackpot ?? false);

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
  const winners: WinnerEntry[] = entries.map((e) => ({
    seat: e.seat,
    tai: Number(e.tai || 0),
    ...(e.seat === patternsFor && initial?.patterns.length ? { patterns: initial.patterns } : {}),
  }));
  const fromValid = from === null ? multi === 1 : from >= 0;
  const complete = fromValid && entries.every((e) => e.tai !== "");
  const pairs = fromValid ? previewWin(state, winners, from) : [];
  // 反雪 rides on the payer's line: the 自摸 after a 雙響/三響 they won.
  const fanXue = fromValid ? previewFanXue(state, winners, from) : [];
  const fanXueOf = (payer: string) => fanXue.find((f) => f.from === payer)?.amount ?? 0;
  const total = pairs.reduce((s, p) => s + p.worth + fanXueOf(p.payer), 0);
  // A part that's zero is left out of the row (a dash), and its column
  // only shows when some row has it.
  const payRows: PayRow[] = pairs.map((p) => ({
    who: multi > 1 ? `${p.payer} → ${p.winner}` : p.payer,
    cells: {
      ...(p.base ? { base: fmt(p.base) } : {}),
      tai: fmt(p.tai),
      ...(p.dealer ? { dealer: fmt(p.dealer) } : {}),
      ...(p.lahKind ? { lah: fmt(p.lah) } : {}),
      ...(fanXueOf(p.payer) ? { fanXue: fmt(fanXueOf(p.payer)) } : {}),
    },
    total: p.worth + fanXueOf(p.payer),
    high: state.settings.highScore !== null && p.worth >= state.settings.highScore,
  }));

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
      frame={frame}
      tabs={<ModeTabs mode="win" onBonus={onBonus} />}
      actions={
        <>
          <button type="button" className="sc-primary" disabled={!complete} onClick={submit}>
            {complete ? (jackpot && state.pot > 0 ? `Confirm · ${fmt(total)} + Jackpot ${fmt(state.pot)} = ${fmt(total + state.pot)}` : `Confirm · ${fmt(total)}`) : "Confirm"}
          </button>
        </>
      }
    >
      {initial?.note && <p className="sc-note">{initial.note}</p>}

      <div className="sc-field">
        <div className="sc-field-head">
          <span className="sc-label">Who dealt in?</span>
          <span className="sc-help">{onZhaHu ? "Hold a player for 多響 · 詐胡" : "Hold a player for 多響"}</span>
        </div>
        <TablePicker
          store={store}
          seats={seats}
          dealer={state.dealer}
          streak={state.streak}
          self={winnerSeat}
          selfLabel="胡"
          selfTone="win"
          isOn={(seat) => from === seat || entries.some((e) => e.seat === seat)}
          onPick={(seat) => pickFrom(from === seat ? -1 : seat)}
          onLongPress={toggleExtra}
          // 詐胡 - a called win that wasn't: hold the caller.
          onSelfLongPress={onZhaHu}
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
        {/* Work the tai out on the Scoring tab instead - by photo or by tiles -
            and come back here with it filled in. One winner only. */}
        {/* On a 雙響/三響 they score the winner whose tai is in focus. */}
        {onScoreHand && (
          <span className="sc-score-hand">
            <button
              type="button"
              className="sc-outline"
              onClick={() => onScoreHand({ from, jackpot, scan: true, target: entries[focus].seat, entries })}
              aria-label={multi > 1 ? `Scan ${seats[entries[focus].seat]}'s hand` : "Scan hand"}
              title="Scan hand"
            >
              {Icons.camera}
            </button>
            <button
              type="button"
              className="sc-secondary"
              onClick={() => onScoreHand({ from, jackpot, scan: false, target: entries[focus].seat, entries })}
              aria-label={multi > 1 ? `Score ${seats[entries[focus].seat]}'s tiles` : "Score tiles"}
              title="Score tiles"
            >
              {Icons.tiles}
            </button>
          </span>
        )}
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
              <span className="sc-jp-label">Jackpot</span>
              <span className="sc-jp-amount">{fmt(state.pot)}</span>
            </span>
          </button>
        )}
      </div>
      <Keypad max={state.settings.scoreCap} value={entries[focus]?.tai ?? ""} onChange={(v) => setEntries((prev) => prev.map((e, i) => (i === focus ? { ...e, tai: v } : e)))} />

      {/* What each payer owes, as a small table: a row per payer, with room
          for three (a 自摸) always kept, so nothing moves as the hand is
          filled in. Columns only for what's in play; 番 and the total always. */}
      <PayTable
        cols={[
          { key: "base", label: "底" },
          { key: "tai", label: "番" },
          { key: "dealer", label: "莊" },
          { key: "lah", label: "拉踢" },
          { key: "fanXue", label: "反雪" },
        ].filter((c) => c.key === "tai" || payRows.some((r) => r.cells[c.key] !== undefined))}
        rows={payRows}
        empty="Pick who dealt in to see who pays what"
        highTitle={`高分 — ${state.settings.highScore} or more. Double-check the tai.`}
      />
    </Sheet>
  );
}

// A who-pays-what table, shared by the 食胡 and 特別獎罰 tabs: a row per
// payer, always three rows tall (a 自摸, or everyone), payer on the left,
// the parts in narrow columns, and the total on the right.
interface PayCol {
  key: string;
  label: string;
  wide?: boolean; // holds a name rather than a number
}

interface PayRow {
  who: string;
  cells: Record<string, ReactNode>;
  total: number;
  high?: boolean;
}

// 詐胡: a called win that wasn't. Laid out like a 三響 on the 食胡 tab - the
// caller in the 胡 seat, an amount field for each of the other three (the 設定
// amount to start with, retyped from the keypad), and who pays whom below.
function ZhaHuSheet({
  store,
  state,
  seat,
  player,
  initial,
  onDone,
  onClose,
  onWin,
  onBonus,
  onScoreHand,
  frame,
  note,
}: {
  store: ScoreStore;
  state: ReplayState;
  seat: number;
  player: string;
  initial?: { player: string; amount: number }[];
  note?: string;
  onDone: (ev: ScoreEvent) => void;
  onClose: () => void;
  onWin: () => void;
  onBonus: () => void;
  onScoreHand?: (ask: ScoreHandAsk) => void;
  frame?: SheetFrame;
}) {
  const others = state.seats.map((_, s2) => s2).filter((s2) => s2 !== seat);
  const each = state.settings.zhaHu ?? SETTING_ON_VALUE.zhaHu ?? 40;
  const [amounts, setAmounts] = useState<string[]>(() =>
    others.map((s2) => String(initial?.find((x) => x.player === state.seats[s2])?.amount ?? each)),
  );
  const [focus, setFocus] = useState(0);
  // A field still showing its starting amount is replaced by the first digit
  // typed, not added to - the keypad (and its 封頂) sees it as empty.
  const [fresh, setFresh] = useState(() => others.map(() => true));
  const type = (v: string) => {
    setAmounts((a) => a.map((x, i) => (i === focus ? v : x)));
    setFresh((f) => f.map((x, i) => (i === focus ? false : x)));
  };
  const pick = (s2: number) => {
    const i = others.indexOf(s2);
    if (i >= 0) setFocus(i);
  };
  // Any 拉 the caller holds ends here, each pulled player paid its 踢 half.
  const kicks = zhaHuKicks(state, player);
  const kickOf = (p: string) => kicks.find((k) => k.player === p)?.amount ?? 0;
  const total = amounts.reduce((t, a) => t + Number(a || 0), 0);
  const kickTotal = kicks.reduce((t, k) => t + k.amount, 0);
  // Scan or score the called hand: it comes back as what it's worth to each.
  const scoreIt = (scan: boolean) =>
    onScoreHand?.({
      from: -1,
      jackpot: false,
      scan,
      target: seat,
      entries: [{ seat, tai: "" }],
      zhaHu: others.map((s2, i) => ({ player: state.seats[s2], amount: Number(amounts[i] || 0) })),
    });
  return (
    <Sheet
      title={
        <span className="sc-sheet-who">
          <Monogram store={store} player={player} />
          {player}
          <span className="sc-sheet-verb is-penalty">詐胡</span>
        </span>
      }
      onClose={onClose}
      frame={frame}
      tabs={<ModeTabs mode="zhaHu" onWin={onWin} onBonus={onBonus} />}
      actions={
        <>
          <button
            type="button"
            className="sc-danger"
            disabled={total <= 0}
            onClick={() => onDone({ t: "zhaHu", at: Date.now(), seat, pays: others.map((s2, i) => ({ player: state.seats[s2], amount: Number(amounts[i] || 0) })) })}
          >
            {total > 0 ? `Confirm · ${fmt(total + kickTotal)}` : "Confirm"}
          </button>
        </>
      }
    >
      {note && <p className="sc-note">{note}</p>}
      <div className="sc-field">
        <div className="sc-field-head">
          <span className="sc-label">Who gets paid?</span>
          <span className="sc-help">Tap one to change theirs</span>
        </div>
        <TablePicker
          store={store}
          seats={state.seats}
          dealer={state.dealer}
          streak={state.streak}
          self={seat}
          selfLabel="詐"
          selfTone="lose"
          isOn={(s2) => others[focus] === s2}
          onPick={pick}
          onSelfLongPress={onWin}
          tagFor={(s2) => (s2 !== seat ? { text: "收", tone: "win" } : undefined)}
          center={{ label: "詐胡", sub: `${fmt(each)} each`, on: true, tone: "lose" }}
        />
      </div>
      <div className="sc-tai-row">
        <span className="sc-label">金額</span>
        <div className="sc-tai-fields">
          {others.map((s2, i) => (
            <button key={s2} type="button" className={`sc-tai${focus === i ? " is-focus" : ""}`} onClick={() => setFocus(i)} aria-label={`${state.seats[s2]}'s amount`}>
              <span className="sc-tai-who">{state.seats[s2]}</span>
              <span className={`sc-tai-value${amounts[i] ? "" : " is-empty"}`}>{amounts[i] || "0"}</span>
            </button>
          ))}
        </div>
        {/* As on 食胡: work the called hand out on Scoring - by photo or by tiles. */}
        {onScoreHand && (
          <span className="sc-score-hand">
            <button type="button" className="sc-outline" onClick={() => scoreIt(true)} aria-label="Scan hand" title="Scan hand">
              {Icons.camera}
            </button>
            <button type="button" className="sc-secondary" onClick={() => scoreIt(false)} aria-label="Score tiles" title="Score tiles">
              {Icons.tiles}
            </button>
          </span>
        )}
      </div>
      {/* 封頂 holds here as on 食胡. */}
      <Keypad max={state.settings.scoreCap} value={fresh[focus] ? "" : (amounts[focus] ?? "")} onChange={type} />
      {/* The 踢 column: the caller's 拉 end here, each pulled player paid its 踢 half. */}
      <PayTable
        cols={[{ key: "to", label: "To", wide: true }, ...(kicks.length > 0 ? [{ key: "zha", label: "詐胡" }, { key: "kick", label: "踢" }] : [])]}
        rows={others
          .map((s2, i) => {
            const p = state.seats[s2];
            const amount = Number(amounts[i] || 0);
            return {
              who: player,
              cells: { to: p, ...(kicks.length > 0 ? { zha: fmt(amount), ...(kickOf(p) ? { kick: fmt(kickOf(p)) } : {}) } : {}) },
              total: amount + kickOf(p),
            };
          })
          .filter((r) => r.total > 0)}
        empty="Enter an amount to see who pays what"
      />
    </Sheet>
  );
}

function PayTable({ cols, rows, empty, highTitle }: { cols: PayCol[]; rows: PayRow[]; empty: string; highTitle?: string }) {
  return (
    <div className="sc-paytable" aria-live="polite">
      {rows.length === 0 ? (
        <p className="sc-paytable-empty">{empty}</p>
      ) : (
        <table aria-label="Who pays what">
          <colgroup>
            <col className="is-who" />
            {cols.map((c) => (
              <col key={c.key} className={c.wide ? "is-name" : undefined} />
            ))}
            <col className="is-total" />
          </colgroup>
          <thead>
            <tr>
              <th scope="col">Pays</th>
              {cols.map((c) => (
                <th key={c.key} scope="col" className={c.wide ? "is-name" : undefined}>
                  {c.label}
                </th>
              ))}
              <th scope="col">Total</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className={r.high ? "is-high" : undefined} title={r.high ? highTitle : undefined}>
                <th scope="row">{r.who}</th>
                {cols.map((c) => (
                  <td key={c.key} className={c.wide ? "is-name" : undefined}>
                    {r.cells[c.key] ?? "–"}
                  </td>
                ))}
                <td className="sc-paytable-total">{fmt(r.total)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
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
  frame,
  initial,
}: {
  store: ScoreStore;
  state: ReplayState;
  seat: number;
  player: string;
  initial?: HandInitial["bonus"];
  onDone: (ev: ScoreEvent) => void;
  onClose: () => void;
  onWin: () => void;
  frame?: SheetFrame;
}) {
  const [kind, setKind] = useState<"獎" | "罰">(initial?.kind ?? "獎");
  // null = everyone else.
  const [other, setOther] = useState<number | null>(initial?.other ?? null);
  const [amount, setAmount] = useState(initial ? String(initial.amount) : "");
  const n = Number(amount || 0);
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
      frame={frame}
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
      <div className="sc-field">
        <span className="sc-label">{kind === "獎" ? "From" : "To"}</span>
        <TablePicker
          store={store}
          seats={state.seats}
          dealer={state.dealer}
          streak={state.streak}
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
        {/* 獎 or 罰, in the row where 食胡 has its Scan / Jackpot - so the
            picker above sits where it does on the 食胡 tab. */}
        <span className="sc-kind" role="group" aria-label="Reward or penalty">
          {(["獎", "罰"] as const).map((k) => (
            <button
              key={k}
              type="button"
              className={`sc-kind-${k === "獎" ? "reward" : "penalty"}${kind === k ? " is-on" : ""}`}
              aria-pressed={kind === k}
              aria-label={k === "獎" ? "獎 Reward" : "罰 Penalty"}
              onClick={() => setKind(k)}
            >
              {k}
            </button>
          ))}
        </span>
      </div>
      <Keypad max={state.settings.scoreCap} value={amount} onChange={setAmount} />
      {/* Who pays whom, in the same table as 食胡 - and the same size. */}
      <PayTable
        cols={[{ key: "to", label: "To", wide: true }]}
        rows={
          n <= 0
            ? []
            : (other === null ? state.seats.map((_, s2) => s2).filter((s2) => s2 !== seat) : [other]).map((s2) =>
                kind === "獎"
                  ? { who: state.seats[s2], cells: { to: player }, total: n }
                  : { who: player, cells: { to: state.seats[s2] }, total: n },
              )
        }
        empty="Enter an amount to see who pays what"
      />
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
  onSelfLongPress,
  center,
  tagFor,
  selfTone,
  dealer,
  streak = 0,
}: {
  store: ScoreStore;
  seats: string[];
  dealer?: number; // marks that seat 莊 (連N), as on the 戰況 cards
  streak?: number;
  self?: number;
  selfLabel?: string;
  isOn: (seat: number) => boolean;
  isDisabled?: (seat: number) => boolean;
  onPick: (seat: number) => void;
  // A held press (about half a second) - its tap is then swallowed.
  onLongPress?: (seat: number) => void;
  onSelfLongPress?: () => void;
  center?: { label: ReactNode; sub?: ReactNode; on: boolean; onPick?: () => void; tone?: "win" | "lose" };
  selfTone?: "win" | "lose";
  tagFor?: (seat: number) => { text: string; tone: "win" | "discard" } | undefined;
}) {
  const hold = useRef<{ timer: number; fired: boolean } | null>(null);
  const release = () => {
    if (hold.current) window.clearTimeout(hold.current.timer);
  };
  const holdFor = (fire: (() => void) | undefined) =>
    fire
      ? {
          onPointerDown: () => {
            release();
            const h = { timer: 0, fired: false };
            h.timer = window.setTimeout(() => {
              h.fired = true;
              fire();
            }, 450);
            hold.current = h;
          },
          onPointerUp: release,
          onPointerLeave: release,
          onPointerCancel: release,
          onContextMenu: (e: { preventDefault: () => void }) => e.preventDefault(),
        }
      : {};
  const press = (seat: number) => holdFor(onLongPress && (() => onLongPress(seat)));
  return (
    <div className={`sc-table-pick${onLongPress ? " can-hold" : ""}`}>
      {seats.map((player, seat) => {
        const area = SEAT_AREAS[seat];
        if (seat === self)
          return (
            <span key={seat} className={`sc-pick sc-pick-self sc-area-${area}${selfTone ? ` is-self-${selfTone}` : ""}`} {...holdFor(onSelfLongPress)}>
              <Monogram store={store} player={player} size="sm" />
              <span className="sc-pick-name">{player}</span>
              {seat === dealer && <span className="sc-zhuang sc-pick-zhuang">{streak > 0 ? `莊${streak}` : "莊"}</span>}
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
            {seat === dealer && <span className="sc-zhuang sc-pick-zhuang">{streak > 0 ? `莊${streak}` : "莊"}</span>}
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

// 座位: who sits where and who's dealing, on one seat map - tap a seat to
// move or replace that player, hold one to make that seat 莊. One draft and
// one Confirm that applies the lot (each change still lands as its own
// entry, so 還原 takes them back one at a time).
// One 風局 choice: what it does, and the round it leaves you at.
function RoundOption({ verb, label }: { verb: string; label: string }) {
  return (
    <span className="sc-round-option">
      <span>{verb}</span>
      <small>{label}</small>
    </span>
  );
}

function SeatsSheet({
  store,
  state,
  onDone,
  onClose,
  onOpenSeating,
}: {
  store: ScoreStore;
  state: ReplayState;
  onDone: (change: { seats: string[] | null; newNames: string[]; removedNames: string[]; dealer: ScoreEvent | null }) => void;
  onClose: () => void;
  onOpenSeating?: () => void;
}) {
  // Seating draft.
  const [seats, setSeats] = useState(state.seats.slice());
  const [picked, setPicked] = useState<number | null>(null);
  const [newName, setNewName] = useState("");
  const [added, setAdded] = useState<string[]>([]);
  // Bench players taken off the roster - applied on Confirm.
  const [removed, setRemoved] = useState<string[]>([]);
  const [editBench, setEditBench] = useState(false);
  // The bench shows one row - its last tile "More" when there are more -
  // until More (then a "Less" tile folds it back) or Edit. How many fit a row depends on the phone, so it's
  // read off the grid.
  const [benchOpen, setBenchOpen] = useState(false);
  const benchRef = useRef<HTMLDivElement>(null);
  // More / Less glide the bench to its new height, and the players it
  // reveals fade in.
  const benchWrapRef = useRef<HTMLDivElement>(null);
  const benchFrom = useRef<number | null>(null);
  const toggleBench = (open: boolean) => {
    benchFrom.current = benchWrapRef.current?.offsetHeight ?? null;
    setBenchOpen(open);
  };
  useLayoutEffect(() => {
    const el = benchWrapRef.current;
    const from = benchFrom.current;
    benchFrom.current = null;
    if (!el || from === null || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const to = el.offsetHeight;
    const timing = { duration: 280, easing: "cubic-bezier(0.25, 0.8, 0.25, 1)" };
    el.animate([{ height: `${from}px`, overflow: "hidden" }, { height: `${to}px`, overflow: "hidden" }], timing);
    if (benchOpen)
      [...el.querySelectorAll<HTMLElement>(".sc-options > *, .sc-add")].slice(Math.max(0, perRow - 1)).forEach((tile) => tile.animate([{ opacity: 0 }, { opacity: 1 }], timing));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [benchOpen]);
  const [perRow, setPerRow] = useState(2);
  useLayoutEffect(() => {
    const el = benchRef.current;
    if (!el) return;
    const measure = () => setPerRow(Math.max(1, getComputedStyle(el).gridTemplateColumns.split(" ").filter(Boolean).length));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // Dealer draft - a seat, so it reads whoever the draft seating puts there.
  // 莊 is a player, not a seat: it moves with them when seats change (and
  // passes to whoever takes their place from the bench).
  const startDealer = state.seats[state.dealer];
  const [dealerName, setDealerName] = useState(startDealer);
  const [streak, setStreak] = useState(state.streak);
  // 風局: keep the round going, reset to 東風東局 from the dealer, or set any
  // 風 and 局. Keep until a new 莊 is picked - that's usually 執位, so it then
  // flips to Reset, unless it was chosen by hand.
  const [round, setRound] = useState<"keep" | "reset" | "set">("keep");
  const roundTouched = useRef(false);
  const [custom, setCustom] = useState({ wind: state.roundWind, hand: (state.dealer - state.roundStartDealer + SEATS) % SEATS });
  const reset = round !== "keep";
  // Holding a seat makes it 莊 (a new dealer starts at 連0); the tap that
  // ends the hold is swallowed.
  const hold = useRef<number | null>(null);
  const held = useRef(false);
  const cancelHold = () => {
    if (hold.current !== null) window.clearTimeout(hold.current);
    hold.current = null;
  };
  // Seat changes slide each player from where they were to where they now
  // sit: note every player's spot just before a change, then (before paint)
  // start each one there and let it glide home.
  const diamondRef = useRef<HTMLDivElement>(null);
  const before = useRef<Map<string, DOMRect> | null>(null);
  const spots = () => {
    const map = new Map<string, DOMRect>();
    diamondRef.current?.querySelectorAll<HTMLElement>("[data-player]").forEach((el) => map.set(el.dataset.player!, el.getBoundingClientRect()));
    return map;
  };
  const moveSeats = (change: (prev: string[]) => string[]) => {
    before.current = spots();
    setPicked(null);
    setSeats(change);
  };
  // 起莊's corner belongs to a seat, not a player. When the card that had it
  // slides to its new seat (a rotation, say), it simply rides along on that
  // card. Otherwise it flies there on its own (a copy, above the sheet, on the
  // 莊 badge's arc) rather than arriving on some other card - and when its seat
  // doesn't change but another player slides in, the copy holds still there
  // while they do. Measured against the map, before the cards start sliding
  // (so this runs first).
  const lastQi = useRef<{ seat: number; player: string; x: number; y: number } | null>(null);
  const lastSeats = useRef(seats.join("|"));
  // The copy in flight - a later render mustn't cut it short, only a new move.
  const qiFlight = useRef<(() => void) | null>(null);
  useEffect(() => () => qiFlight.current?.(), []);
  useLayoutEffect(() => {
    const map = diamondRef.current;
    const corner = map?.querySelector<HTMLElement>(".sc-qi-corner");
    const card = corner?.closest<HTMLElement>("[data-player]");
    const prev = lastQi.current;
    const seatsMoved = lastSeats.current !== seats.join("|");
    lastSeats.current = seats.join("|");
    if (!map || !corner || !card) return;
    const box = map.getBoundingClientRect();
    const to = corner.getBoundingClientRect();
    const now = { seat: seats.indexOf(card.dataset.player!), player: card.dataset.player!, x: to.left - box.left, y: to.top - box.top };
    lastQi.current = now;
    if (!prev || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const hold = prev.seat === now.seat && seatsMoved && prev.player !== now.player;
    if (prev.seat === now.seat && !hold) return;
    if (prev.seat !== now.seat && seatsMoved && prev.player === now.player) return;
    const style = getComputedStyle(corner);
    const flyer = corner.cloneNode(true) as HTMLElement;
    Object.assign(flyer.style, {
      position: "fixed",
      left: `${to.left}px`,
      top: `${to.top}px`,
      width: `${to.width}px`,
      height: `${to.height}px`,
      borderTopLeftRadius: style.borderTopLeftRadius,
      zIndex: "1000",
      pointerEvents: "none",
    });
    document.body.appendChild(flyer);
    const dx = prev.x - now.x;
    const dy = prev.y - now.y;
    const lift = -Math.min(48, Math.hypot(dx, dy) / 4);
    const frames: Keyframe[] = [];
    for (let i = 0; i <= 20; i++) {
      const t = i / 20;
      const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      const rise = hold ? 0 : Math.sin(Math.PI * e);
      frames.push({ offset: t, transform: `translate(${dx * (1 - e)}px, ${dy * (1 - e) + lift * rise}px) scale(${1 + 0.25 * rise})` });
    }
    qiFlight.current?.();
    // Alongside the cards when they move too, so all of it lands together.
    const flight = flyer.animate(frames, { duration: seatsMoved ? 800 : 600, easing: "linear" });
    corner.style.visibility = "hidden";
    const land = () => {
      flyer.remove();
      corner.style.visibility = "";
      if (qiFlight.current === land) qiFlight.current = null;
    };
    qiFlight.current = land;
    flight.finished.then(land, land);
  });
  useLayoutEffect(() => {
    const was = before.current;
    before.current = null;
    const map = diamondRef.current;
    if (!was || !map || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    // Each card travels round the map's centre, not across it, and shrinks
    // mid-way, so cards pass each other instead of piling up in the middle.
    // Clockwise ones take a wider lane than anticlockwise ones, so a swapped
    // pair passes side by side rather than head-on.
    const box = map.getBoundingClientRect();
    const cx = box.left + box.width / 2;
    const cy = box.top + box.height / 2;
    const steps = 24;
    const moves = [...map.querySelectorAll<HTMLElement>("[data-player]")].flatMap((el) => {
      const from = was.get(el.dataset.player!);
      if (!from) return [];
      const to = el.getBoundingClientRect();
      const fx = from.left + from.width / 2 - cx;
      const fy = from.top + from.height / 2 - cy;
      const tx = to.left + to.width / 2 - cx;
      const ty = to.top + to.height / 2 - cy;
      if (Math.abs(fx - tx) < 1 && Math.abs(fy - ty) < 1) return [];
      return [{ el, fx, fy, tx, ty }];
    });
    // The seats sit on a wide oval, not a circle: travel round that, so the
    // wide cards don't squeeze together at the diagonals.
    const rx = Math.max(1, ...moves.flatMap((m) => [Math.abs(m.fx), Math.abs(m.tx)]));
    const ry = Math.max(1, ...moves.flatMap((m) => [Math.abs(m.fy), Math.abs(m.ty)]));
    const paths = moves.map((m) => {
      const a0 = Math.atan2(m.fy / ry, m.fx / rx);
      let turn = Math.atan2(m.ty / ry, m.tx / rx) - a0;
      while (turn > Math.PI) turn -= 2 * Math.PI;
      while (turn <= -Math.PI) turn += 2 * Math.PI;
      if (Math.abs(Math.abs(turn) - Math.PI) < 0.01) turn = Math.PI; // straight across: go clockwise
      return { ...m, a0, turn, r0: Math.hypot(m.fx / rx, m.fy / ry), r1: Math.hypot(m.tx / rx, m.ty / ry) };
    });
    // Lanes only matter when cards pass going opposite ways; a plain
    // rotation keeps everyone on the same oval. Every card lifts (a gentle
    // dip in size and a soft shadow), glides and settles together - same
    // start, same pace, same landing.
    const bothWays = paths.some((m) => m.turn > 0) && paths.some((m) => m.turn < 0);
    // A lifted card only shrinks a touch - the shadow does most of the lift.
    const DIP = 0.08;
    paths.forEach(({ el, a0, turn, r0, r1, tx, ty }) => {
      // Mirror-image lanes: one bows out exactly as far as the other bows in.
      const lane = bothWays ? (turn > 0 ? 0.25 : -0.25) : 0;
      const frames: Keyframe[] = [];
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        // Pick up, move, set down: the card shrinks and lifts in the first
        // quarter, travels (smoothly, eased) mostly in the middle while
        // small, and grows back as it lands.
        const ease = (u: number) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);
        const e = ease(Math.min(1, Math.max(0, (t - 0.15) / 0.7)));
        const lifted = ease(Math.min(1, t / 0.25, (1 - t) / 0.25));
        const bump = Math.sin(Math.PI * e);
        const angle = a0 + turn * e;
        const r = (r0 + (r1 - r0) * e) * (1 + lane * bump);
        const x = Math.cos(angle) * r * rx - tx;
        const y = Math.sin(angle) * r * ry - ty;
        frames.push({
          offset: t,
          transform: `translate(${x}px, ${y}px) scale(${1 - DIP * lifted})`,
          boxShadow: `0 ${10 * lifted}px ${26 * lifted}px rgba(0, 0, 0, ${0.2 * lifted})`,
          zIndex: turn > 0 ? 2 : 1,
        });
      }
      el.animate(frames, { duration: 800, easing: "linear" });
    });
  }, [seats]);
  // A new 莊: the badge flies from the old dealer's seat to the new one (a
  // copy of it, above the sheet, so no card clips it) and lands with a pop.
  const badgeFrom = useRef<DOMRect | null>(null);
  useLayoutEffect(() => {
    const from = badgeFrom.current;
    badgeFrom.current = null;
    const badge = diamondRef.current?.querySelector<HTMLElement>(".sc-zhuang");
    if (!from || !badge || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const to = badge.getBoundingClientRect();
    const flyer = badge.cloneNode(true) as HTMLElement;
    Object.assign(flyer.style, { position: "fixed", left: `${to.left}px`, top: `${to.top}px`, margin: "0", zIndex: "1000", pointerEvents: "none" });
    document.body.appendChild(flyer);
    const dx = from.left - to.left;
    const dy = from.top - to.top;
    // A smooth arc: sampled along an eased path with a gentle rise (a sine,
    // so no sharp peak), growing a little mid-flight.
    const lift = -Math.min(48, Math.hypot(dx, dy) / 4);
    const frames: Keyframe[] = [];
    for (let i = 0; i <= 20; i++) {
      const t = i / 20;
      const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      const rise = Math.sin(Math.PI * e);
      frames.push({ offset: t, transform: `translate(${dx * (1 - e)}px, ${dy * (1 - e) + lift * rise}px) scale(${1 + 0.35 * rise})` });
    }
    const flight = flyer.animate(frames, { duration: 600, easing: "linear" });
    badge.style.visibility = "hidden";
    const land = () => {
      flyer.remove();
      badge.style.visibility = "";
      badge.animate([{ transform: "scale(1.35)" }, { transform: "scale(1)" }], { duration: 220, easing: "ease-out" });
    };
    flight.finished.then(land, land);
    return () => {
      flyer.remove();
      badge.style.visibility = "";
    };
  }, [dealerName]);

  const seatPress = (s2: number) => ({
    onPointerDown: () => {
      cancelHold();
      held.current = false;
      hold.current = window.setTimeout(() => {
        hold.current = null;
        held.current = true;
        setPicked(null);
        const name = seats[s2];
        if (name !== dealerName) {
          badgeFrom.current = diamondRef.current?.querySelector(".sc-zhuang")?.getBoundingClientRect() ?? null;
          setDealerName(name);
          setStreak(name === startDealer ? state.streak : 0);
          if (!roundTouched.current) setRound(name !== startDealer ? "reset" : "keep");
        }
      }, 500);
    },
    onPointerUp: cancelHold,
    onPointerLeave: cancelHold,
    onPointerCancel: cancelHold,
    onContextMenu: (e: { preventDefault: () => void }) => e.preventDefault(),
  });

  // The bench, most recent first: anyone added just now at the top (newest
  // first), then by the last game they sat in (this one counts as now), then
  // the roster's newest.
  const lastPlayed = useMemo(() => {
    const seen = new Map<string, number>();
    const games = [...store.history, ...(store.active ? [store.active] : [])];
    for (const g of games) {
      const when = g === store.active ? Infinity : (g.endedAt ?? g.startedAt);
      const names = [...g.seats, ...g.events.flatMap((ev) => (ev.t === "swap" ? ev.seats : []))];
      for (const n of names) seen.set(n, Math.max(seen.get(n) ?? 0, when));
    }
    return seen;
  }, [store]);
  const rosterIndex = (n: string) => store.roster.findIndex((p) => p.name === n);
  // Folded to one row with a More tile (only when there's more than a row).
  const bench = [...new Set([...store.roster.map((p) => p.name), ...state.players, ...added])]
    .filter((p) => !seats.includes(p) && !removed.includes(p))
    .sort((x, y) => {
      const ax = added.indexOf(x);
      const ay = added.indexOf(y);
      if (ax >= 0 || ay >= 0) return ay - ax;
      return (lastPlayed.get(y) ?? 0) - (lastPlayed.get(x) ?? 0) || rosterIndex(y) - rosterIndex(x);
    });
  const collapsed = !benchOpen && !editBench && bench.length > perRow;
  // Anyone who has played this game stays - their score is on the table.
  const canRemove = (name: string) => !state.players.includes(name);
  const removeBench = (name: string) => {
    if (added.includes(name)) setAdded((a) => a.filter((n) => n !== name));
    else setRemoved((r) => [...r, name]);
  };
  // Either order works: a seat then a 候補 player, or a 候補 player then a seat.
  const [benchPick, setBenchPick] = useState<string | null>(null);
  const seatBench = (seat: number, name: string) => {
    if (seats[seat] === dealerName) setDealerName(name);
    setSeats((prev) => prev.map((p, i) => (i === seat ? name : p)));
  };
  const tapSeat = (s2: number) => {
    if (benchPick !== null) {
      seatBench(s2, benchPick);
      return setBenchPick(null);
    }
    if (picked === null) return setPicked(s2);
    if (picked !== s2) moveSeats((prev) => prev.map((p, i) => (i === s2 ? prev[picked] : i === picked ? prev[s2] : p)));
    setPicked(null);
  };
  const tapBench = (name: string) => {
    if (picked === null) return setBenchPick((b) => (b === name ? null : name));
    seatBench(picked, name);
    setPicked(null);
  };
  const addName = () => {
    const n = newName.trim();
    if (!n || seats.includes(n) || bench.includes(n)) return;
    if (removed.includes(n)) setRemoved((r) => r.filter((x) => x !== n));
    else setAdded((a) => [...a, n]);
    setNewName("");
  };

  const seatsChanged = seats.some((p, i) => p !== state.seats[i]);
  const dealer = Math.max(0, seats.indexOf(dealerName));
  const dealerChanged = dealer !== state.dealer || streak !== state.streak;
  // Keep means the round as it stands, whichever seat 莊 now sits in.
  const hereHand = (state.dealer - state.roundStartDealer + SEATS) % SEATS;
  const anything = seatsChanged || dealerChanged || reset || added.length > 0 || removed.length > 0;
  // 起莊 as the drafted round would leave it, for the gold corner.
  const qiSeat = (dealer - (round === "reset" ? 0 : round === "set" ? custom.hand : hereHand) + SEATS) % SEATS;
  const submit = () =>
    onDone({
      seats: seatsChanged ? seats : null,
      newNames: added,
      removedNames: removed,
      dealer:
        dealerChanged || reset
          ? {
              t: "dealer",
              at: Date.now(),
              seat: dealer,
              streak,
              resetRound: round === "reset",
              ...(round === "set" ? { round: custom } : round === "keep" ? { round: { wind: state.roundWind, hand: hereHand } } : {}),
            }
          : null,
    });

  return (
    <Sheet
      title="座位 Seats"
      subtitle={
        benchPick !== null
          ? `Now tap the seat ${benchPick} takes`
          : picked === null
            ? "Tap a seat to move or replace that player · hold one for 莊"
            : `Now tap another seat, or a 候補 player, for ${seats[picked]}'s place`
      }
      onClose={onClose}
      actions={
        <>
          <button type="button" className="sc-primary" disabled={!anything} onClick={submit}>
            Confirm
          </button>
        </>
      }
    >
      <div ref={diamondRef}>
      <SeatDiamond>
        {(s2) => (
          <PlayerOption
            store={store}
            player={seats[s2]}
            selected={picked === s2}
            dataPlayer={seats[s2]}
            press={seatPress(s2)}
            onClick={() => {
              if (held.current) {
                held.current = false;
                return;
              }
              tapSeat(s2);
            }}
          >
            {qiSeat === s2 && <span className="sc-qi-corner" role="img" aria-label="起莊" title="起莊 - this 圈 started here" />}
            {dealer === s2 && <span className="sc-zhuang">{streak > 0 ? `莊${streak}` : "莊"}</span>}
          </PlayerOption>
        )}
      </SeatDiamond>
      </div>
      {/* The usual 執位 moves in one tap: everyone one seat round the map
          either way, 東 ⇄ 南 and 西 ⇄ 北, or a random seating. */}
      <div className="sc-seat-moves">
        <button
          type="button"
          className="sc-outline sc-seat-rotate is-ccw"
          aria-label="Everyone one seat counter-clockwise"
          title="Counter-clockwise"
          onClick={() => moveSeats((prev) => [prev[3], prev[0], prev[1], prev[2]])}
        >
          {Icons.rotate}
        </button>
        <button
          type="button"
          className="sc-outline sc-seat-rotate"
          aria-label="Everyone one seat clockwise"
          title="Clockwise"
          onClick={() => moveSeats((prev) => [prev[1], prev[2], prev[3], prev[0]])}
        >
          {Icons.rotate}
        </button>
        <button
          type="button"
          className="sc-outline sc-seat-rotate"
          aria-label="Swap 東 with 南, and 西 with 北"
          title="東⇄南 · 西⇄北"
          onClick={() => moveSeats((prev) => [prev[1], prev[0], prev[3], prev[2]])}
        >
          {Icons.swap}
        </button>
        <button
          type="button"
          className="sc-outline sc-seat-rotate"
          aria-label="Random seats"
          title="Random seats"
          onClick={() =>
            moveSeats((prev) => {
              // Shuffle until it's a new seating (there are 23 others).
              let next = prev;
              while (next.every((p, i) => p === prev[i])) {
                next = prev.slice();
                for (let i = next.length - 1; i > 0; i--) {
                  const j = Math.floor(Math.random() * (i + 1));
                  [next[i], next[j]] = [next[j], next[i]];
                }
              }
              return next;
            })
          }
        >
          {Icons.shuffle}
        </button>
        {/* The full seat ceremony: dice on the Dice tab's Seating. */}
        {onOpenSeating && (
          <button
            type="button"
            className="sc-outline sc-seat-rotate"
            onClick={onOpenSeating}
            aria-label="Seat ceremony on the Dice tab"
            title="Seat ceremony on the Dice tab"
          >
            {Icons.dice}
          </button>
        )}
      </div>
      <div className="sc-list">
        <div className="sc-row">
          <span>連莊</span>
          <Stepper value={streak} onChange={setStreak} label="連莊" />
        </div>
        {/* What each choice leaves the round at, with the dealer as drafted. */}
        <div className="sc-row sc-round-row">
          <Segmented
            value={round}
            onChange={(v) => {
              roundTouched.current = true;
              setRound(v);
            }}
            options={[
              { value: "keep", label: <RoundOption verb="Keep" label={state.label} /> },
              { value: "reset", label: <RoundOption verb="Reset" label={roundLabel(0, dealer, dealer)} /> },
              { value: "set", label: <RoundOption verb="Set" label={round === "set" ? `${WIND_CHARS[custom.wind]}風${WIND_CHARS[custom.hand]}局` : "any 風局"} /> },
            ]}
          />
          {round === "set" && (
            <div className="sc-round-set">
              <span className="sc-help">風</span>
              <Segmented value={custom.wind} onChange={(wind) => setCustom((c) => ({ ...c, wind }))} options={[0, 1, 2, 3].map((w) => ({ value: w, label: WIND_CHARS[w] }))} />
              <span className="sc-help">局</span>
              <Segmented value={custom.hand} onChange={(hand) => setCustom((c) => ({ ...c, hand }))} options={[0, 1, 2, 3].map((h) => ({ value: h, label: WIND_CHARS[h] }))} />
            </div>
          )}
        </div>
      </div>
      <div className="sc-field">
        <div className="sc-field-head">
          <span className="sc-label">候補 Bench</span>
          <span className="sc-field-head-end">
          {/* Like adding, editing the bench waits until it's open. */}
          {!collapsed && (editBench || bench.some(canRemove)) && (
            <button
              type="button"
              className="sc-text-button"
              onClick={() => {
                setPicked(null);
                setBenchPick(null);
                setEditBench((e) => !e);
              }}
            >
              {editBench ? "Done" : "Edit"}
            </button>
          )}
          </span>
        </div>
        <div ref={benchWrapRef} className="sc-bench-wrap">
        <div ref={benchRef} className={`sc-options${benchOpen || editBench ? "" : " is-one-row"}`}>
          {(collapsed ? bench.slice(0, perRow - 1) : bench).map((p) =>
            editBench ? (
              <button
                key={p}
                type="button"
                className="sc-option sc-option-remove"
                onClick={() => removeBench(p)}
                disabled={!canRemove(p)}
                aria-label={canRemove(p) ? `Remove ${p} from the bench` : `${p} is in this game`}
              >
                <Monogram store={store} player={p} size="sm" />
                <span className="sc-option-name">{p}</span>
                {canRemove(p) && <span className="sc-option-x">{Icons.close}</span>}
              </button>
            ) : (
              <PlayerOption key={p} store={store} player={p} selected={benchPick === p} onClick={() => tapBench(p)} />
            ),
          )}
          {collapsed && (
            <button type="button" className="sc-option sc-option-more" onClick={() => toggleBench(true)}>
              <span className="sc-option-name">More</span>
              <span className="sc-help">+{bench.length - (perRow - 1)}</span>
            </button>
          )}
          {benchOpen && !editBench && bench.length > perRow && (
            <button type="button" className="sc-option sc-option-more" onClick={() => toggleBench(false)}>
              <span className="sc-option-name">Less</span>
            </button>
          )}
          {bench.length === 0 && <span className="sc-help">Nobody on the bench yet.</span>}
        </div>
        {/* Adding someone is part of the open bench - hidden behind More. */}
        {!collapsed && (
        <div className="sc-add">
          <input className="sc-input" value={newName} maxLength={12} placeholder="Add a player" onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addName()} aria-label="New player name" />
          <button type="button" className="sc-secondary" onClick={addName} disabled={!newName.trim()}>
            Add
          </button>
        </div>
        )}
        </div>
      </div>
    </Sheet>
  );
}

function LahSheet({
  store,
  state,
  onSurrender,
  onSurrenderAll,
  onClose,
}: {
  store: ScoreStore;
  state: ReplayState;
  onSurrender: (holder: string, pulled: string) => void;
  onSurrenderAll: () => void;
  onClose: () => void;
}) {
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
  // 投降 takes two taps: the first arms it (確定), the second ends that 拉. A tap
  // anywhere else disarms it.
  const [armed, setArmed] = useState<string | null>(null);
  useEffect(() => {
    if (!armed) return;
    const disarm = (e: PointerEvent) => {
      if (!(e.target as Element).closest?.(".sc-lah-surrender.is-armed, .sc-lah-all.is-armed")) setArmed(null);
    };
    document.addEventListener("pointerdown", disarm, true);
    return () => document.removeEventListener("pointerdown", disarm, true);
  }, [armed]);
  return (
    <Sheet
      title="拉踢"
      onClose={onClose}
      actions={
        // Everyone 投降 at once - two taps, like each row's.
        state.lahs.length > 1 ? (
          <button
            type="button"
            className={`sc-lah-all ${armed === "all" ? "sc-danger is-armed" : "sc-secondary"}`}
            onClick={() => {
              if (armed !== "all") return setArmed("all");
              setArmed(null);
              onSurrenderAll();
            }}
          >
            {armed === "all" ? `確定 · end all ${state.lahs.length} 拉` : "全部投降 All surrender"}
          </button>
        ) : undefined
      }
    >
      {/* As tall as a sheet with a few 拉, so it doesn't open as a sliver. */}
      {groups.length === 0 && (
        <div className="sc-lah-empty">
          <span className="sc-lah-empty-icon" aria-hidden="true">
            {Icons.lah}
          </span>
          <strong>No 拉 on the table</strong>
          <span className="sc-help">A win starts a 拉 on everyone who paid it</span>
        </div>
      )}
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
                      {isArmed ? "確定" : "投降"}
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
  // Hand the pot out, or pay into it. An empty pot can only be paid into.
  const [mode, setMode] = useState<"out" | "in">(state.pot > 0 ? "out" : "in");
  const [shares, setShares] = useState<number[]>(() => state.seats.map(() => 0));
  const total = shares.reduce((a, b) => a + b, 0);
  // ± move by 1; handing out, + stops at what's left in the pot. The
  // shortcuts use the pot's own unit (what each player puts in per 流局).
  const unit = Math.max(1, state.settings.jackpotPerDraw || 1);
  const switchMode = (m: "out" | "in") => {
    setMode(m);
    setShares(state.seats.map(() => 0));
  };
  const evenly = () => setShares(evenShares(state.pot, state.roundStartDealer, state.settings.integerMode));
  const out = mode === "out";
  const ok = total > 0 && (!out || total <= state.pot);
  const sharesOf = () => state.seats.map((player, i) => ({ player, amount: shares[i] })).filter((x) => x.amount > 0);
  return (
    <Sheet
      title={`Jackpot ${fmt(state.pot)}`}
      subtitle={out ? "Tap a player to give them all of it, or set each share" : `What each player puts in - tap a name for ${fmt(unit)}`}
      onClose={onClose}
      tabs={
        <div className="sc-sheet-tabs">
          <Segmented
            value={mode}
            onChange={switchMode}
            options={[
              { value: "out", label: "派 Hand out" },
              { value: "in", label: "入 Pay in" },
            ]}
          />
        </div>
      }
      actions={
        <>
          <button
            type="button"
            className="sc-primary"
            disabled={!ok}
            onClick={() => onDone({ t: out ? "jackpot" : "jackpotIn", at: Date.now(), shares: sharesOf() })}
          >
            {out ? (total > 0 ? `Hand out ${fmt(total)}` : "Hand out") : total > 0 ? `Pay in ${fmt(total)}` : "Pay in"}
          </button>
        </>
      }
    >
      {out && state.pot <= 0 ? (
        <p className="sc-empty">The Jackpot is empty - switch to Pay in to add to it.</p>
      ) : (
        <>
          <div className="sc-list">
            {state.seats.map((p, i) => (
              <div key={p} className="sc-row">
                <button
                  type="button"
                  className="sc-row-main sc-row-button"
                  onClick={() => setShares(state.seats.map((_, j) => (j === i ? (out ? state.pot : unit) : out ? 0 : shares[j])))}
                >
                  <Monogram store={store} player={p} size="sm" />
                  {p}
                </button>
                <Stepper
                  value={shares[i]}
                  max={out ? shares[i] + Math.max(0, state.pot - total) : undefined}
                  onChange={(v) => setShares((prev) => prev.map((x, j) => (j === i ? v : x)))}
                  label={out ? `${p}'s share` : `What ${p} pays in`}
                />
              </div>
            ))}
          </div>
          <div className="sc-row">
            {out ? (
              <span className={total > state.pot ? "sc-warn" : "sc-help"}>
                {fmt(total)} of {fmt(state.pot)} handed out
              </span>
            ) : (
              <span className="sc-help">
                {fmt(total)} in · pot becomes {fmt(state.pot + total)}
              </span>
            )}
            {out ? (
              <button type="button" className="sc-outline" onClick={evenly}>
                Split evenly
              </button>
            ) : (
              <button type="button" className="sc-outline" onClick={() => setShares(state.seats.map(() => unit))}>
                Everyone {fmt(unit)}
              </button>
            )}
          </div>
        </>
      )}
    </Sheet>
  );
}

// The game's name, the day it was played and, if wanted, where and when play
// started and stopped - set from a long press on the game box. A new day
// keeps the time of day it started; anything left empty isn't shown.
// A field with a × to empty it, shown once there's something in it.
function ClearableInput({
  value,
  onChange,
  label,
  type = "text",
  maxLength,
  placeholder,
  autoFocus,
  onEnter,
}: {
  value: string;
  onChange: (v: string) => void;
  label: string;
  type?: "text" | "time";
  maxLength?: number;
  placeholder?: string;
  autoFocus?: boolean;
  onEnter?: () => void;
}) {
  return (
    <span className={`sc-input-clearable${value ? " has-value" : ""}`}>
      <input
        className="sc-input sc-input-full"
        type={type}
        value={value}
        maxLength={maxLength}
        placeholder={placeholder}
        autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && onEnter?.()}
      />
      {value && (
        <button
          type="button"
          className="sc-input-clear"
          aria-label={`Clear ${label}`}
          onClick={(e) => {
            e.preventDefault();
            onChange("");
          }}
        >
          {Icons.close}
        </button>
      )}
    </span>
  );
}

type GameLabel = { name: string; startedAt: number; startTime: string; endTime: string; location: string };

function NameSheet({ initial, onSave, onClose }: { initial: GameLabel; onSave: (label: GameLabel) => void; onClose: () => void }) {
  const [text, setText] = useState(initial.name);
  const trimmed = text.trim();
  const day = (at: number) => {
    const d = new Date(at);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  const [date, setDate] = useState(() => day(initial.startedAt));
  const [startTime, setStartTime] = useState(initial.startTime);
  const [endTime, setEndTime] = useState(initial.endTime);
  const [location, setLocation] = useState(initial.location);
  const nextStart = () => {
    const [y, m, d] = date.split("-").map(Number);
    if (!y || !m || !d) return initial.startedAt;
    const at = new Date(initial.startedAt);
    at.setFullYear(y, m - 1, d);
    return at.getTime();
  };
  const label = (name: string): GameLabel => ({ name, startedAt: nextStart(), startTime, endTime, location: location.trim() });
  const changed =
    trimmed !== initial.name ||
    day(nextStart()) !== day(initial.startedAt) ||
    startTime !== initial.startTime ||
    endTime !== initial.endTime ||
    location.trim() !== initial.location;
  const save = () => changed && onSave(label(trimmed));
  return (
    <Sheet
      title="Game details"
      subtitle="Shown on the table and in History - the name on the 結帳 image too"
      onClose={onClose}
      actions={
        <>
          {/* Empties every field but the date (a game always has one) - Save keeps it. */}
          {(text || location || startTime || endTime) && (
            <button
              type="button"
              className="sc-secondary"
              onClick={() => {
                setText("");
                setLocation("");
                setStartTime("");
                setEndTime("");
              }}
            >
              Clear
            </button>
          )}
          <button type="button" className="sc-primary" disabled={!changed} onClick={save}>
            Save
          </button>
        </>
      }
    >
      <label className="sc-field">
        <span className="sc-label">Name</span>
        <ClearableInput value={text} onChange={setText} label="name" maxLength={24} placeholder="Game name" autoFocus onEnter={save} />
      </label>
      <label className="sc-field">
        <span className="sc-label">Location</span>
        <ClearableInput value={location} onChange={setLocation} label="location" maxLength={32} placeholder="Optional" onEnter={save} />
      </label>
      <label className="sc-field">
        <span className="sc-label">Date</span>
        <input className="sc-input sc-input-full" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      </label>
      {/* Optional, each: left empty, it isn't shown. */}
      <div className="sc-time-pair">
        <label className="sc-field">
          <span className="sc-label">Start</span>
          <ClearableInput type="time" value={startTime} onChange={setStartTime} label="start time" />
        </label>
        <label className="sc-field">
          <span className="sc-label">End</span>
          <ClearableInput type="time" value={endTime} onChange={setEndTime} label="end time" />
        </label>
      </div>
      <span className="sc-help">Location, start and end are optional - left empty, they aren't shown.</span>
    </Sheet>
  );
}

// A read-only link to the game as it stands, and its QR code for the people
// at the table. A snapshot, not live - share a fresh one any time.
function ShareLinkSheet({ store, game, onClose }: { store: ScoreStore; game: ScoreGame; onClose: () => void }) {
  const url = useMemo(() => snapshotUrl(snapshotOf(store, game)), [store, game]);
  const svg = useMemo(() => {
    const qr = qrcode(0, "L");
    qr.addData(url);
    qr.make();
    return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  }, [url]);
  const [copied, setCopied] = useState(false);
  return (
    <Sheet
      title="Share the scores"
      subtitle="A read-only snapshot of this game as it is now"
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
                  await navigator.share({ title: game.name ?? "MJWaits scores", url });
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
      <div className="sc-qr" dangerouslySetInnerHTML={{ __html: svg }} role="img" aria-label="QR code for the scores link" />
      <p className="sc-help sc-help-block">Scan to see the scores on another phone. It won't update by itself - share again for the latest.</p>
    </Sheet>
  );
}

function SettleSheet({
  store,
  game,
  state,
  backedUpAt,
  onBackup,
  onEnd,
  onClose,
}: {
  store: ScoreStore;
  game: ScoreGame;
  state: ReplayState;
  backedUpAt: number | null;
  onBackup: () => void;
  onEnd: () => void;
  onClose: () => void;
}) {
  const [shareLink, setShareLink] = useState(false);
  const [imaging, setImaging] = useState(false);
  // Saved since the last thing recorded? Then the game is safe to end.
  const lastAt = game.events.length ? game.events[game.events.length - 1].at : game.startedAt;
  const backedUp = backedUpAt !== null && backedUpAt >= lastAt;
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
  // 結帳 as a picture: shared straight to the chat where the phone can, or
  // saved as a PNG.
  const shareImage = async () => {
    setImaging(true);
    try {
      const blob = await drawSettleCard(
        snapshotOf(store, game),
        payments,
        m !== 1 ? `×${multiplier}` : "",
      );
      if (!blob) return;
      const file = new File([blob], `mjwaits-${new Date().toISOString().slice(0, 10)}.png`, { type: "image/png" });
      if (navigator.canShare?.({ files: [file] })) {
        try {
          await navigator.share({ files: [file], title: game.name ?? "MJWaits 結帳" });
        } catch {
          // Dismissed.
        }
        return;
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = file.name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } finally {
      setImaging(false);
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
            Share text…
          </button>
        )}
        <button type="button" className="sc-outline" onClick={() => void shareImage()} disabled={imaging}>
          {imaging ? "Drawing…" : "Image"}
        </button>
        <button type="button" className="sc-outline" onClick={() => setShareLink(true)}>
          Link · QR
        </button>
      </div>
      {/* Before ending: the game only lives on this phone. */}
      {!backedUp && game.events.length > 0 && (
        <div className="sc-row sc-row-boxed sc-backup-nudge">
          <span className="sc-help">Not backed up since the last hand - save a file before you end the game.</span>
          <button type="button" className="sc-secondary" onClick={onBackup}>
            儲存 Save
          </button>
        </div>
      )}
      {/* Over everything, not inside this sheet. */}
      {shareLink && createPortal(<ShareLinkSheet store={store} game={game} onClose={() => setShareLink(false)} />, document.body)}
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

const SETTING_GROUPS: { title: string; rows: { key: keyof ScoreSettings; label: string; help?: string; kind: "number" | "bool" | "nullable" | "round"; needs?: keyof ScoreSettings }[] }[] = [
  {
    title: "計分 Scoring",
    rows: [
      { key: "base", label: "自動計算底", help: "Added to every payment", kind: "number" },
      { key: "dealerTai", label: "自動計算莊", help: "When the dealer wins or pays", kind: "number" },
      { key: "streakTai", label: "自動計算連莊", help: "Per 連莊", kind: "number" },
      { key: "drawKeepsDealer", label: "流局留莊", help: "The dealer stays after a 流局", kind: "bool" },
      { key: "scoreCap", label: "封頂", help: "The highest tai or amount you can type", kind: "nullable" },
      { key: "zhaHu", label: "詐胡", help: "A false win - the caller pays each player", kind: "nullable" },
    ],
  },
  {
    title: "拉踢 Pull & kick",
    rows: [
      { key: "integerMode", label: "整數模式", help: "Whole numbers only", kind: "bool" },
      { key: "lahRound", label: "拉減半", help: "Rounding when a 拉 halves", kind: "round" },
      { key: "tiRound", label: "踢減半", help: "Rounding when a 踢 halves", kind: "round" },
      { key: "fanXue", label: "反雪", help: "Paid back by each winner", kind: "bool" },
      { key: "fanXueDouble", label: "雙響反雪", help: "反雪 after a 雙響", kind: "number", needs: "fanXue" },
      { key: "fanXueTriple", label: "三響反雪", help: "反雪 after a 三響", kind: "number", needs: "fanXue" },
      { key: "surrenderPrompt", label: "投降提示", help: "Prompt once a 拉 runs this many hands in a row", kind: "nullable" },
    ],
  },
  {
    title: "Jackpot",
    rows: [
      { key: "jackpot", label: "Jackpot", kind: "bool" },
      { key: "jackpotPerDraw", label: "每人每流局", help: "Each player pays in when a hand is drawn", kind: "number", needs: "jackpot" },
    ],
  },
  {
    title: "顯示 Display",
    rows: [
      { key: "showLah", label: "拉數提示", help: "拉 on the player cards", kind: "bool" },
      { key: "seatReminder", label: "執位提示", help: "After 北風北局", kind: "bool" },
      { key: "highScore", label: "高分提示", help: "Flag a payment this big", kind: "nullable" },
      { key: "showTally", label: "胡摸銃數", help: "Counts on the cards: 胡 black, 摸 green, 銃 red", kind: "bool" },
      { key: "quickScan", label: "快速掃描", help: "A Scan button on each player's card", kind: "bool" },
      { key: "chipsPrompt", label: "籌碼提示", help: "Who hands whom chips, after each entry", kind: "bool" },
      { key: "tipsAutoHide", label: "提示自動隱藏", help: "籌碼 and the other notices go by themselves", kind: "nullable" },
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
            {g.rows.map(({ key, label, help, kind, needs }) => {
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
                // The amount gets its own row, lined up with the steppers, so the
                // switch stays in the same column as every other switch.
                return (
                  <Fragment key={key}>
                    <label className="sc-row">
                      {text}
                      <Toggle checked={value !== null} onChange={(v) => set(key, (v ? DEFAULT_SETTINGS[key] ?? SETTING_ON_VALUE[key] ?? 50 : null) as never)} label={label} />
                    </label>
                    {/* Greyed out while the switch is off, like the other dependent rows. */}
                    <div className={`sc-row${value === null ? " is-off" : ""}`}>
                      <span className="sc-row-main sc-row-stack">
                        {key === "scoreCap" ? "上限" : key === "surrenderPrompt" ? "局數" : key === "zhaHu" ? "每人" : key === "tipsAutoHide" ? "秒數" : "門檻"}
                        <span className="sc-help">{key === "scoreCap" ? "Up to" : key === "surrenderPrompt" ? "Hands in a row" : key === "zhaHu" ? "To each player, to start with" : key === "tipsAutoHide" ? "Before each goes" : "From"}</span>
                      </span>
                      {/* 高分提示, 詐胡 and 提示自動隱藏 step in 5s, 投降提示 in 1s; 封頂 is typed. */}
                      {key !== "scoreCap" ? (
                        <Stepper
                          value={value ?? ((DEFAULT_SETTINGS[key] ?? SETTING_ON_VALUE[key]) as number)}
                          onChange={(v) => set(key, v as never)}
                          label={label}
                          min={key === "highScore" || key === "zhaHu" || key === "tipsAutoHide" ? 5 : 1}
                          step={key === "highScore" || key === "zhaHu" || key === "tipsAutoHide" ? 5 : 1}
                          disabled={value === null}
                        />
                      ) : (
                        <NumberField value={value ?? (DEFAULT_SETTINGS[key] as number)} onChange={(v) => set(key, v as never)} label={label} pill disabled={value === null} />
                      )}
                    </div>
                  </Fragment>
                );
              }
              // Greyed out while the switch it belongs to is off.
              const off = needs !== undefined && !s[needs];
              return (
                <div key={key} className={`sc-row${off ? " is-off" : ""}`}>
                  {text}
                  <Stepper value={s[key] as number} onChange={(v) => set(key, v as never)} label={label} disabled={off} />
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
  // editIndex: correcting that older entry from 最近, not recording a new one.
  | { kind: "hand"; seat: number; initial?: HandInitial; mode?: HandMode; editIndex?: number }
  | { kind: "entry"; index: number }
  | { kind: "recent" }
  | { kind: "draw" }
  | { kind: "seats" }
  | { kind: "name" }
  | { kind: "lah" }
  | { kind: "jackpot" }
  | { kind: "settle" }
  | { kind: "settings" }
;

// 籌碼提示: the chips to hand over for each change (see chipMoves) - a new
// entry, or an undo / redo / fix / delete, which hands back the difference.
// Stays up until dismissed or the next change that moves chips replaces it.
function useChipMoves(game: ScoreGame, state: ReplayState) {
  const last = useRef<{ id: string; events: ScoreEvent[]; state: ReplayState } | null>(null);
  // 投降 after 投降 (one by one in 拉踢) add up on the one card, from the
  // state before the first of them - until the card is dismissed or something
  // else goes in.
  const surrenders = useRef<ReplayState | null>(null);
  const [moves, setMoves] = useState<{ at: number; verb: string; list: { from: string; to: string; amount: number }[] } | null>(null);
  useEffect(() => {
    const prev = last.current;
    last.current = { id: game.id, events: game.events, state };
    if (!prev || prev.id !== game.id) {
      surrenders.current = null;
      return setMoves(null);
    }
    if (prev.events === game.events) return;
    // What happened: entries added, the last ones taken back, or an older
    // one fixed or deleted.
    const n = game.events.length;
    const m = prev.events.length;
    const grew = n > m && (m === 0 || game.events[m - 1] === prev.events[m - 1]);
    const shrank = n < m && (n === 0 || prev.events[n - 1] === game.events[n - 1]);
    const surrendered = grew && game.events.slice(m).every((ev) => ev.t === "surrender");
    if (!surrendered) surrenders.current = null;
    else if (!surrenders.current) surrenders.current = prev.state;
    const list = chipMoves(surrendered ? surrenders.current! : prev.state, state);
    if (list.length === 0) return;
    setMoves({ at: Date.now(), verb: grew ? (surrendered ? "投降" : "") : shrank ? "還原" : "改正", list });
  }, [game, state]);
  return {
    moves,
    dismiss: () => {
      surrenders.current = null;
      setMoves(null);
    },
  };
}

// "A → B 10" for A pays B, each receiver on a line of their own, every
// arrow (and amount) in one column down the card: "Kelvin → 凱文 9", then
// "→ Mandy 2", "→ Ah Wing 2". Names are never cut: when the widest payer and
// receiver don't fit side by side, each payer takes a line of their own above
// their arrows. 彩池 is the Jackpot pile.
// 提示自動隱藏 for a banner: closed for you (as its × or Got it would) after
// that many seconds, a bar along its foot running down. null: until closed.
function AutoHide({ seconds, onHide, children }: { seconds: number | null; onHide: () => void; children: ReactNode }) {
  const hide = useRef(onHide);
  hide.current = onHide;
  useEffect(() => {
    if (seconds === null) return;
    const timer = window.setTimeout(() => hide.current(), seconds * 1000);
    return () => window.clearTimeout(timer);
  }, [seconds]);
  return (
    <div className="sc-autohide">
      {children}
      {seconds !== null && <span className="sc-timer" style={{ animationDuration: `${seconds}s` }} aria-hidden="true" />}
    </div>
  );
}

function ChipsCard({ verb, list, autoHide, onDone }: { verb: string; list: { from: string; to: string; amount: number }[]; autoHide: number | null; onDone: () => void }) {
  const payers = [...new Set(list.map((m) => m.from))];
  // 提示自動隱藏: gone by itself after that many seconds (a bar along the foot
  // runs down); off, it stays until dismissed. A new change brings a new card
  // and a fresh count.
  useEffect(() => {
    if (autoHide === null) return;
    const timer = window.setTimeout(onDone, autoHide * 1000);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoHide]);
  const gridRef = useRef<HTMLSpanElement>(null);
  const [stacked, setStacked] = useState(false);
  // Measured side by side, before paint, whenever the list changes.
  useLayoutEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;
    const was = grid.classList.contains("is-stacked");
    grid.classList.remove("is-stacked");
    const tooWide = grid.scrollWidth > grid.clientWidth + 1;
    grid.classList.toggle("is-stacked", was);
    setStacked(tooWide);
  }, [list]);
  const label = `籌碼${verb ? ` ${verb}` : ""}: ${list.map((m) => `${m.from} pays ${m.to} ${fmt(m.amount)}`).join(", ")}. Tap to dismiss.`;
  return (
    <button type="button" className="sc-chips" onClick={onDone} aria-label={label}>
      <span className="sc-chips-head" aria-hidden="true">
        <span className="sc-chips-title">籌碼{verb && ` · ${verb}`}</span>
        <span className="sc-chips-close">{Icons.close}</span>
      </span>
      <span ref={gridRef} className={`sc-chips-grid${stacked ? " is-stacked" : ""}`} aria-hidden="true">
        {payers.map((payer) => {
          const mine = list.filter((m) => m.from === payer);
          return (
            <Fragment key={payer}>
              <span className="sc-chips-who" style={{ gridRow: stacked ? undefined : `span ${mine.length}` }}>
                {payer}
              </span>
              {mine.map((m) => (
                <Fragment key={m.to}>
                  <span className="sc-chips-arrow">→</span>
                  <span className="sc-chips-to">{m.to}</span>
                  <strong className="sc-chips-amount">{fmt(m.amount)}</strong>
                </Fragment>
              ))}
            </Fragment>
          );
        })}
      </span>
      {autoHide !== null && <span className="sc-timer" style={{ animationDuration: `${autoHide}s` }} aria-hidden="true" />}
    </button>
  );
}

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
              : ev.t === "jackpotIn"
                ? "Paid into the Jackpot"
                : ev.t === "zhaHu"
                  ? `詐胡 · ${ev.pays.map((x) => fmt(x.amount)).join(" / ")}`
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
  onPick,
  onUndo,
  onRedo,
  onClose,
}: {
  store: ScoreStore;
  game: ScoreGame;
  state: ReplayState;
  onPick: (index: number) => void; // tap an entry to fix or delete it
  onUndo: () => void;
  onRedo: () => void;
  onClose: () => void;
}) {
  const lastIndex = game.events.length - 1;
  const undoLabel = lastIndex >= 0 ? describeEvent(game.events[lastIndex], state, lastIndex) : "";
  const rows = game.events
    .map((ev, i) => ({ ev, i }))
    .reverse()
    .map(({ ev, i }) => {
      let row: ReactNode = null;
      if (ev.t === "win" || ev.t === "draw") {
        const h = state.hands.find((x) => x.eventIndex === i);
        if (h) row = <HandRow h={h} store={store} />;
      } else {
        const step = state.steps.find((x) => x.eventIndex === i);
        row = <EventRow ev={ev} deltas={step?.deltas ?? {}} />;
      }
      return (
        row && (
          <div key={i} className="sc-recent-row" role="button" tabIndex={0} onClick={() => onPick(i)} onKeyDown={(e) => e.key === "Enter" && onPick(i)}>
            {row}
          </div>
        )
      );
    });
  return (
    <Sheet
      title="最近 Recent"
      subtitle={game.events.length ? `${state.hands.length}局 · ${game.events.length} ${game.events.length === 1 ? "entry" : "entries"} · tap one to fix it` : "Nothing recorded yet"}
      onClose={onClose}
    >
      {/* 還原 / 重做 in the app's segmented style, on their own row above
          the list they change. */}
      <div className="segmented sc-recent-moves" role="group" aria-label="Undo and redo">
        <button type="button" onClick={onUndo} disabled={lastIndex < 0} title={undoLabel ? `還原 · ${undoLabel}` : "還原"}>
          {Icons.undo}
          還原
        </button>
        <button type="button" onClick={onRedo} disabled={!canRedo(game)} title="重做">
          {Icons.redo}
          重做
        </button>
      </div>
      {game.events.length === 0 ? (
        <p className="sc-empty">Tap the winner on the table to record a hand, or 流局 for a draw.</p>
      ) : (
        <div className="sc-list sc-list-hands">{rows}</div>
      )}
    </Sheet>
  );
}

// The 食胡 sheet set up as a recorded win was, for fixing it.
function winInitial(ev: Extract<ScoreEvent, { t: "win" }>): HandInitial {
  const first = ev.winners[0];
  const base = { from: ev.from, jackpot: ev.jackpotTo !== undefined, patterns: first.patterns ?? [], patternsFor: first.seat };
  return ev.winners.length > 1
    ? { ...base, selfDraw: false, entries: ev.winners.map((w) => ({ seat: w.seat, tai: String(w.tai) })) }
    : { ...base, selfDraw: ev.from === null, tai: first.tai };
}

// One entry picked in 最近: fix it (a hand) or delete it. Delete takes a
// second tap; either way everything after it replays.
function EntrySheet({ label, canEdit, onEdit, onDelete, onClose }: { label: string; canEdit: boolean; onEdit: () => void; onDelete: () => void; onClose: () => void }) {
  const [armed, setArmed] = useState(false);
  return (
    <Sheet
      title={label || "Entry"}
      subtitle="Changes here replay every entry after it"
      onClose={onClose}
      actions={
        <>
          <button type="button" className={armed ? "sc-danger" : "sc-secondary"} onClick={() => (armed ? onDelete() : setArmed(true))}>
            {armed ? "Tap again to delete" : "Delete"}
          </button>
          {canEdit && (
            <button type="button" className="sc-primary" onClick={onEdit}>
              Edit
            </button>
          )}
        </>
      }
    >
      <p className="sc-help sc-help-block">
        {canEdit ? "Edit opens it as it was recorded, with the table as it stood then." : "This entry can be deleted; to change it, delete it and add it again."}
      </p>
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
  if (ev.t === "jackpotIn") return "Paid into the Jackpot";
  if (ev.t === "zhaHu") return `${state.seats[ev.seat] ?? ""} 詐胡 ${fmt(ev.pays.reduce((t, x) => t + x.amount, 0))}`.trim();
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
  onScoreHand,
  onOpenSeating,
}: {
  store: ScoreStore;
  game: ScoreGame;
  state: ReplayState;
  update: (game: ScoreGame, extra?: Partial<ScoreStore>) => void;
  onEndGame: () => void;
  request: RecordRequest | null;
  onRequestDone: () => void;
  onScoreHand?: (req: Omit<ScoreHandRequest, "nonce">) => void;
  onOpenSeating?: (names: string[]) => void;
}) {
  const [sheet, setSheet] = useState<BoardSheet | null>(null);
  // Holding a player's card opens 食胡 already on 自摸; the tap that ends
  // the hold is then swallowed.
  const cardHold = useRef<number | null>(null);
  const cardHeld = useRef(false);
  const cancelCardHold = () => {
    if (cardHold.current !== null) window.clearTimeout(cardHold.current);
    cardHold.current = null;
  };
  const cardPress = (seat: number) => ({
    onPointerDown: () => {
      cancelCardHold();
      cardHeld.current = false;
      cardHold.current = window.setTimeout(() => {
        cardHold.current = null;
        cardHeld.current = true;
        setSheet({ kind: "hand", seat, initial: { selfDraw: true, patterns: [], from: null } });
      }, 500);
    },
    onPointerUp: cancelCardHold,
    onPointerLeave: cancelCardHold,
    onPointerCancel: cancelCardHold,
    onContextMenu: (e: { preventDefault: () => void }) => e.preventDefault(),
  });
  // Half a second's hold on the round box opens the name sheet.
  const nameHold = useRef<number | null>(null);
  const cancelNameHold = () => {
    if (nameHold.current !== null) window.clearTimeout(nameHold.current);
    nameHold.current = null;
  };
  const namePress = {
    onPointerDown: () => {
      cancelNameHold();
      nameHold.current = window.setTimeout(() => {
        nameHold.current = null;
        setSheet({ kind: "name" });
      }, 500);
    },
    onPointerUp: cancelNameHold,
    onPointerLeave: cancelNameHold,
    onPointerCancel: cancelNameHold,
    onContextMenu: (e: { preventDefault: () => void }) => e.preventDefault(),
  };
  const [toast, setToast] = useState<{ text: string; id: number } | null>(null);
  const [reminderHidden, setReminderHidden] = useState(false);
  const chips = useChipMoves(game, state);
  const [backedUpAt, setBackedUpAt] = useState(readBackedUpAt);
  // The card footer's key, once: after the first hand, until "Got it".
  const [footerKeySeen, setFooterKeySeen] = useState(() => {
    try {
      return window.localStorage.getItem(FOOTER_KEY_SEEN) === "1";
    } catch {
      return true;
    }
  });
  const seeFooterKey = () => {
    setFooterKeySeen(true);
    try {
      window.localStorage.setItem(FOOTER_KEY_SEEN, "1");
    } catch {
      // Then it shows again next time - harmless.
    }
  };
  const [backupNudgeAt, setBackupNudgeAt] = useState(BACKUP_NUDGE_HANDS);
  // 投降 prompts dismissed, by "holder>pulled@count" - a chain that grows
  // again prompts again.
  const [surrenderSeen, setSurrenderSeen] = useState<string[]>([]);
  const close = () => setSheet(null);
  const flash = (text: string) => {
    const id = Date.now();
    setToast({ text, id });
    window.setTimeout(() => setToast((t) => (t?.id === id ? null : t)), 2200);
  };
  // Fixing an older hand: the sheet sees the table as it stood just before it.
  const sheetState = useMemo(
    () => (sheet?.kind === "hand" && sheet.editIndex !== undefined ? replay({ ...game, events: game.events.slice(0, sheet.editIndex) }) : state),
    [sheet, game, state],
  );
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
    // Started from this sheet: back to the same winner. Otherwise the winner
    // is whoever has the 門風 entered in Scoring.
    const seat = request.seat ?? [0, 1, 2, 3].find((s) => ((s - state.dealer + SEATS) % SEATS) + 1 === request.seatWind) ?? 0;
    const dealerNote = request.removedDealerTai ? ` (莊 ${request.removedDealerTai} taken out — Scores adds its own)` : "";
    // A 雙響/三響: the sheet comes back whole, with only the scored winner's
    // tai (and patterns) new. Who dealt in stands - one discard, several
    // winners, so Scoring's 自摸 doesn't apply.
    // A 詐胡: back to it, each player's amount now what the hand would pay
    // them off their own discard (not 拉 - nothing was won), never under
    // the 設定 amount. Cancelled: the amounts as they were.
    if (request.zhaHu && request.seat !== undefined) {
      const caller = request.seat;
      const floor = state.settings.zhaHu ?? SETTING_ON_VALUE.zhaHu ?? 40;
      const worth = (payer: number) => {
        const pair = previewWin(state, [{ seat: caller, tai: request.tai }], payer)[0];
        return pair ? pair.base + pair.tai + pair.dealer : 0;
      };
      setSheet({
        kind: "hand",
        seat: caller,
        mode: "zhaHu",
        initial: {
          selfDraw: false,
          patterns: [],
          zhaHu: request.reopenOnly
            ? request.zhaHu
            : request.zhaHu.map((x) => ({ player: x.player, amount: Math.max(floor, worth(state.seats.indexOf(x.player))) })),
          ...(request.reopenOnly ? {} : { note: `From Scoring: ${request.tai} tai${dealerNote} - each pays what it's worth to them, ${fmt(floor)} at least.` }),
        },
      });
      onRequestDone();
      return;
    }
    const draft = request.draft;
    if (draft && request.seat !== undefined) {
      const scored = request.seat;
      setSheet({
        kind: "hand",
        seat: draft.sheetSeat,
        initial: {
          selfDraw: false,
          patterns: request.reopenOnly ? [] : request.patterns,
          from: request.from ?? -1,
          jackpot: request.jackpot,
          entries: request.reopenOnly ? draft.entries : draft.entries.map((e) => (e.seat === scored ? { ...e, tai: String(request.tai) } : e)),
          patternsFor: scored,
          ...(request.reopenOnly ? {} : { note: `From Scoring: ${state.seats[scored]} ${request.tai} tai${dealerNote}.` }),
        },
      });
      onRequestDone();
      return;
    }
    if (request.reopenOnly) {
      setSheet({ kind: "hand", seat, initial: { selfDraw: request.from === null, patterns: [], from: request.from ?? -1, jackpot: request.jackpot } });
      onRequestDone();
      return;
    }
    setSheet({
      kind: "hand",
      seat,
      initial: {
        selfDraw: request.selfDraw,
        tai: request.tai,
        patterns: request.patterns,
        // Scoring has the last word on 自摸; who dealt in carries over otherwise.
        ...(request.seat !== undefined ? { from: request.selfDraw ? null : request.from === null || request.from === undefined ? -1 : request.from, jackpot: request.jackpot } : {}),
        note:
          request.seat !== undefined
            ? `From Scoring: ${request.tai} tai${dealerNote}.`
            : `From Scoring: ${request.tai} tai${dealerNote}. Winner picked by 門風 ${WIND_CHARS[request.seatWind - 1]}.`,
      },
    });
    onRequestDone();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);

  // A card too short for its total and 上局 both (a small phone with a
  // banner up) drops the 上局 rather than letting it slide under the footer.
  // Checked after every render and on resize; Recent still has every hand.
  useLayoutEffect(() => {
    const check = () =>
      document.querySelectorAll<HTMLElement>(".sc-board .sc-card-score").forEach((el) => {
        el.classList.remove("is-tight");
        if (el.scrollHeight > el.clientHeight + 1) el.classList.add("is-tight");
      });
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  });

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

  // quiet: from 最近, where the list itself shows what changed (a toast
  // would only sit on top of it).
  const undo = (quiet = false) => {
    if (game.events.length === 0) return;
    const i = game.events.length - 1;
    if (!quiet) flash(`還原 · ${describeEvent(game.events[i], state, i)}`);
    update(undoEvent(game));
  };
  const redo = (quiet = false) => {
    const next = game.undone?.[game.undone.length - 1];
    if (!next) return;
    const redone = redoEvent(game);
    const after = replay(redone);
    if (!quiet) flash(`重做 · ${describeEvent(next, after, redone.events.length - 1)}`);
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
    { label: "還原", icon: Icons.undo, onClick: () => undo(), disabled: game.events.length === 0 },
    { label: "重做", icon: Icons.redo, onClick: () => redo(), disabled: !canRedo(game) },
    { label: "座位", icon: Icons.seat, onClick: () => setSheet({ kind: "seats" }) },
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

      {/* One banner at a time, the most pressing first: 投降 (a choice to make
          now), 執位 (re-seat), 備份 (save a file), then the footer's one-off
          tip. The rest wait their turn. Each goes by itself after 提示自動隱藏. */}
      {[
        // 投降提示: someone's been 拉'd the set number of times in a row (3 by
        // default). Only a prompt - whether 投降 is allowed is house rule.
        (() => {
        const at = state.settings.surrenderPrompt;
        if (at === null) return null;
        const due = state.lahs.filter((l) => l.count >= at && !surrenderSeen.includes(`${l.holder}>${l.pulled}@${l.count}`)).sort((a, b) => b.value - a.value);
        if (due.length === 0) return null;
        const l = due[0];
        const seen = () => setSurrenderSeen((was) => [...was, ...due.map((d) => `${d.holder}>${d.pulled}@${d.count}`)]);
        return (
          <AutoHide key={`surrender-${l.holder}>${l.pulled}@${l.count}`} seconds={state.settings.tipsAutoHide} onHide={seen}>
          <div className="sc-banner is-surrender" role="status">
            <span>
              <strong>投降</strong> · {l.pulled} has been 拉 {l.count} times by {l.holder} ({fmt(l.value)}) - surrender is available
              {due.length > 1 && ` (+${due.length - 1} more)`}
            </span>
            <button type="button" className="sc-banner-action" onClick={() => setSheet({ kind: "lah" })}>
              拉踢
            </button>
            <button type="button" className="sc-icon-button" onClick={seen} aria-label="Dismiss">
              {Icons.close}
            </button>
          </div>
          </AutoHide>
        );
      })(),
        // 執位: 北風北 is done.
        state.seatChangeDue && !reminderHidden && (
        <AutoHide key="seat" seconds={state.settings.tipsAutoHide} onHide={() => setReminderHidden(true)}>
        <div className="sc-banner" role="status">
          <span>
            <strong>執位</strong> · 北風北 done — re-seat with 座位
          </span>
          <button type="button" className="sc-banner-action" onClick={() => setSheet({ kind: "seats" })}>
            座位
          </button>
          <button type="button" className="sc-icon-button" onClick={() => setReminderHidden(true)} aria-label="Dismiss">
            {Icons.close}
          </button>
        </div>
        </AutoHide>
      ),
        // 備份: every 16 hands without a backup file - the scores only live
        // on this phone. Save from here, or dismiss for 16 more.
        handsSinceBackup(game, backedUpAt) >= backupNudgeAt && (
        <AutoHide key="backup" seconds={state.settings.tipsAutoHide} onHide={() => setBackupNudgeAt(handsSinceBackup(game, backedUpAt) + BACKUP_NUDGE_HANDS)}>
        <div className="sc-banner is-backup" role="status">
          <span>
            <strong>備份</strong> · {handsSinceBackup(game, backedUpAt)} hands since your last backup
          </span>
          <button
            type="button"
            className="sc-banner-action"
            onClick={() => {
              setBackedUpAt(saveBackupFile(store));
              setBackupNudgeAt(BACKUP_NUDGE_HANDS);
              flash("Backup saved");
            }}
          >
            儲存 Save
          </button>
          <button type="button" className="sc-icon-button" onClick={() => setBackupNudgeAt(handsSinceBackup(game, backedUpAt) + BACKUP_NUDGE_HANDS)} aria-label="Dismiss">
            {Icons.close}
          </button>
        </div>
        </AutoHide>
      ),
        // The footer explained, once - its numbers have no labels.
        !footerKeySeen && state.hands.length > 0 && state.settings.showTally && (
        <AutoHide key="tip" seconds={state.settings.tipsAutoHide} onHide={seeFooterKey}>
        <div className="sc-banner is-tip" role="status">
          <span>
            Card footer: <strong className="is-win">胡</strong> · <strong className="is-self">摸</strong> · <strong className="is-dealin">銃</strong> - wins, self-draws, deal-ins. ± opens 特別獎罰.
          </span>
          <button type="button" className="sc-banner-action" onClick={seeFooterKey}>
            Got it
          </button>
        </div>
        </AutoHide>
      ),
      ].find(Boolean) ?? null}

      <div className="sc-board">
        {/* Where the game is - round and deal, the 局 count, and 第幾圈 /
            第幾個東 (連莊 is on the dealer's badge) - in the empty corner
            beside the top seat. */}
        {/* A long press opens the game's details: name, place, date, times. */}
        <div
          className="sc-status"
          role="button"
          tabIndex={0}
          aria-label={`${game.name ? `${game.name}, ` : ""}${state.label}. Long-press for this game's details`}
          {...namePress}
          onKeyDown={(e) => e.key === "Enter" && setSheet({ kind: "name" })}
        >
          {game.name && <span className="sc-status-name">{game.name}</span>}
          <span className="sc-status-round">{state.label}</span>
          <span className="sc-status-meta">局{state.hands.length + 1}</span>
          <span className="sc-status-meta sc-status-wrap">
            <span>東{state.east}</span>
            <span>圈{state.circle}</span>
          </span>
          {/* The day this game started - today, for tonight's game. */}
          <span className="sc-status-meta">{new Date(game.startedAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}</span>
          {playTimes(game) && <span className="sc-status-meta">{playTimes(game)}</span>}
          {game.location && <span className="sc-status-meta sc-status-place">{game.location}</span>}
        </div>
        {/* 籌碼: who hands whom chips for what just went in (or back out) - in
            the other corner beside the top seat. A tap once they're handed over. */}
        {chips.moves && state.settings.chipsPrompt && (
          <ChipsCard key={chips.moves.at} {...chips.moves} autoHide={state.settings.tipsAutoHide} onDone={chips.dismiss} />
        )}
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
              <button
                type="button"
                className={`sc-card sc-c${colorOf(store, player)}${isDealer ? " is-dealer" : ""}`}
                {...cardPress(seat)}
                onClick={() => {
                  // A hold already opened it, as 自摸.
                  if (cardHeld.current) {
                    cardHeld.current = false;
                    return;
                  }
                  setSheet({ kind: "hand", seat });
                }}
                aria-label={`${player}, ${fmt(total)}. Record a hand for ${player} - hold for 自摸`}
              >
                {/* 起莊: a gold corner on the seat this 圈 started from, so it's clear when 北風北 comes. */}
                {isQi && (
                  <span className="sc-qi-corner" role="img" aria-label="起莊" title="起莊 - this 圈 started here" />
                )}
                {/* A long name gets a little smaller, so it isn't cut off. 莊N: N = 連莊. */}
                <span className={`sc-card-top${[...player].length >= 6 ? " is-long" : ""}`}>
                  <span className="sc-card-name">{player}</span>
                  {isDealer && (
                    <span className="sc-zhuang-tag" aria-label={state.streak > 0 ? `莊連${state.streak}` : "莊"}>
                      {state.streak > 0 ? `莊${state.streak}` : "莊"}
                    </span>
                  )}
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
              {/* The card opens 食胡. Its footer: ± and 胡 · 摸 · 銃 open 特別獎罰,
                  and with 快速掃描 on, the camera scans a hand this player won. */}
              <div className="sc-card-foot">
                <button
                  type="button"
                  className="sc-card-bonus"
                  onClick={() => setSheet({ kind: "hand", seat, mode: "bonus" })}
                  aria-label={`${tally.wins} wins, ${tally.selfDraws} self-draws, ${tally.dealIns} deal-ins. 特別獎罰 for ${player}`}
                >
                  <span className="sc-card-bonus-mark">{Icons.plusMinus}</span>
                  {/* Numbers only, told apart by colour: 胡 black, 摸 green, 銃 red. */}
                  {state.settings.showTally ? (
                    <span className="sc-card-counts" aria-hidden="true">
                      <strong className="is-win">{tally.wins}</strong>·<strong className="is-self">{tally.selfDraws}</strong>·<strong className="is-dealin">{tally.dealIns}</strong>
                    </span>
                  ) : (
                    <span aria-hidden="true">獎罰</span>
                  )}
                </button>
                {state.settings.quickScan && onScoreHand && (
                  <button
                    type="button"
                    className="sc-card-scan"
                    aria-label={`Scan a hand ${player} won`}
                    onClick={() =>
                      onScoreHand({
                        seat,
                        player,
                        from: -1,
                        fromName: null,
                        jackpot: false,
                        roundWind: (state.roundWind + 1) as 1 | 2 | 3 | 4,
                        seatWind: (((seat - state.dealer + SEATS) % SEATS) + 1) as 1 | 2 | 3 | 4,
                        scan: true,
                        fromCard: true,
                      })
                    }
                  >
                    {Icons.camera}
                  </button>
                )}
              </div>
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
            <button type="button" className={`sc-jackpot${state.pot > 0 ? " is-live" : ""}`} onClick={() => setSheet({ kind: "jackpot" })} aria-label={`Jackpot ${state.pot}, tap to hand it out or pay in`}>
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
            <button type="button" onClick={() => undo()}>
              還原
            </button>
          )}
          {toast.text.startsWith("還原") && canRedo(game) && (
            <button type="button" onClick={() => redo()}>
              重做
            </button>
          )}
        </div>
      )}

      {sheet?.kind === "hand" && (
        <HandSheet
          key={`${sheet.seat}-${sheet.mode ?? "win"}-${sheet.editIndex ?? "new"}`}
          store={store}
          state={sheetState}
          seat={sheet.seat}
          initial={sheet.initial}
          startMode={sheet.mode}
          onScoreHand={
            onScoreHand && sheet.editIndex === undefined
              ? (ask) => {
              // The winner being scored - on a 雙響/三響, maybe not the sheet's own.
              const seat = ask.target;
              onScoreHand({
                seat,
                player: state.seats[seat],
                from: ask.from,
                fromName: ask.from !== null && ask.from >= 0 ? state.seats[ask.from] : null,
                jackpot: ask.jackpot,
                roundWind: (state.roundWind + 1) as 1 | 2 | 3 | 4,
                seatWind: (((seat - state.dealer + SEATS) % SEATS) + 1) as 1 | 2 | 3 | 4,
                scan: ask.scan,
                ...(ask.entries.length > 1 ? { draft: { sheetSeat: sheet.seat, entries: ask.entries } } : {}),
                ...(ask.zhaHu ? { zhaHu: ask.zhaHu } : {}),
              });
              close();
            }
              : undefined
          }
          onClose={close}
          onDone={(ev) => {
            if (sheet.editIndex === undefined) return add(ev, ev.t === "bonus" ? `Recorded 特別${ev.kind}` : ev.t === "zhaHu" ? "Recorded 詐胡" : "Recorded ✓");
            update(replaceEvent(game, sheet.editIndex, ev));
            close();
            flash("Entry fixed - later hands updated");
          }}
        />
      )}
      {sheet?.kind === "entry" && (
        <EntrySheet
          label={describeEvent(game.events[sheet.index], state, sheet.index)}
          canEdit={["win", "bonus", "zhaHu"].includes(game.events[sheet.index]?.t ?? "")}
          onEdit={() => {
            const ev = game.events[sheet.index];
            if (ev?.t === "win") setSheet({ kind: "hand", seat: ev.winners[0].seat, initial: winInitial(ev), editIndex: sheet.index });
            if (ev?.t === "bonus")
              setSheet({
                kind: "hand",
                seat: ev.seat,
                mode: "bonus",
                initial: { selfDraw: false, patterns: [], bonus: { kind: ev.kind, other: ev.other ?? null, amount: ev.amount } },
                editIndex: sheet.index,
              });
            if (ev?.t === "zhaHu")
              setSheet({ kind: "hand", seat: ev.seat, mode: "zhaHu", initial: { selfDraw: false, patterns: [], zhaHu: ev.pays }, editIndex: sheet.index });
          }}
          onDelete={() => {
            const what = describeEvent(game.events[sheet.index], state, sheet.index);
            update(deleteEvent(game, sheet.index));
            close();
            flash(`Deleted · ${what}`);
          }}
          onClose={() => setSheet({ kind: "recent" })}
        />
      )}
      {sheet?.kind === "recent" && (
        <RecentSheet
          store={store}
          game={game}
          state={state}
          onPick={(index) => setSheet({ kind: "entry", index })}
          onUndo={() => undo(true)}
          onRedo={() => redo(true)}
          onClose={close}
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
      {sheet?.kind === "name" && (
        <NameSheet
          initial={{ name: game.name ?? "", startedAt: game.startedAt, startTime: game.startTime ?? "", endTime: game.endTime ?? "", location: game.location ?? "" }}
          onClose={close}
          onSave={({ name, startedAt, startTime, endTime, location }) => {
            update({ ...game, name: name || undefined, startedAt, startTime: startTime || undefined, endTime: endTime || undefined, location: location || undefined });
            close();
            flash(name !== (game.name ?? "") ? (name ? `Named “${name}”` : "Name cleared") : "Saved");
          }}
        />
      )}
      {sheet?.kind === "seats" && (
        <SeatsSheet
          store={store}
          state={state}
          onClose={close}
          onOpenSeating={
            onOpenSeating &&
            (() => {
              close();
              onOpenSeating(state.seats);
            })
          }
          onDone={({ seats, newNames, removedNames, dealer }) => {
            const roster = withRoster(store, [...(seats ?? state.seats), ...newNames]).filter((p) => !removedNames.includes(p.name));
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
            // The last 拉 gone: back to the table, where the 籌碼 card is.
            if (state.lahs.length === 1) close();
            flash(`${pulled} 投降`);
          }}
          onSurrenderAll={() => {
            const at = Date.now();
            update(state.lahs.reduce((g, l) => withEvent(g, { t: "surrender", at, holder: l.holder, pulled: l.pulled }), game));
            close();
            flash(`全部投降 · ${state.lahs.length} 拉 ended`);
          }}
        />
      )}
      {sheet?.kind === "jackpot" && <JackpotSheet store={store} state={state} onDone={(ev) => add(ev, ev.t === "jackpotIn" ? "Paid into the Jackpot" : "Jackpot handed out")} onClose={close} />}
      {sheet?.kind === "settle" && (
        <SettleSheet
          store={store}
          game={game}
          state={state}
          backedUpAt={backedUpAt}
          onBackup={() => setBackedUpAt(saveBackupFile(store))}
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
        {/* The share of hands spent top of the table. */}
        <span title="Hands spent in 1st place">
          <strong>{pct(s.firstRate)}</strong>領先
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

// Save the whole store as a dated file, and note when - for the reminders.
function saveBackupFile(store: ScoreStore): number {
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
  return now;
}

// Hands recorded since the last backup file (all of them, if never).
const handsSinceBackup = (game: ScoreGame, backedUpAt: number | null) =>
  game.events.filter((ev) => (ev.t === "win" || ev.t === "draw") && (backedUpAt === null || ev.at > backedUpAt)).length;

const FOOTER_KEY_SEEN = "mjwaits.footerKeySeen";

// The board's nudge comes every this many hands without a backup.
const BACKUP_NUDGE_HANDS = 16;

function BackupCard({ store, setStore }: { store: ScoreStore; setStore: (s: ScoreStore) => void }) {
  const [backedUpAt, setBackedUpAt] = useState(readBackedUpAt);
  const [incoming, setIncoming] = useState<{ name: string; store: ScoreStore } | null>(null);
  const [message, setMessage] = useState<{ text: string; bad?: boolean } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const count = (s: ScoreStore) => s.history.length + (s.active ? 1 : 0);
  const games = (n: number) => `${n} game${n === 1 ? "" : "s"}`;
  const players = (n: number) => `${n} player${n === 1 ? "" : "s"}`;

  const download = () => {
    setBackedUpAt(saveBackupFile(store));
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
      <SectionHead zh="玩家統計" en={game.name ?? (isActive ? "This game" : new Date(game.startedAt).toLocaleDateString())}>
        <span className="sc-help">{state.hands.length}局</span>
      </SectionHead>
      {/* In full - sparklines and 胡·摸·銃 - above 走勢; a line each above the other views, which have their own detail. */}
      <div className={`card sc-board-table${view === "trend" ? "" : " is-compact"}`}>
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
                {/* As on the 戰況 cards: 胡 black, 摸 green, 銃 red. */}
                <span className="sc-card-counts" aria-label={`${s.wins + s.selfDraws} wins, ${s.selfDraws} self-draws, ${s.dealIns} deal-ins`}>
                  <strong className="is-win">{s.wins + s.selfDraws}</strong>·<strong className="is-self">{s.selfDraws}</strong>·<strong className="is-dealin">{s.dealIns}</strong>
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

      {view === "hands" && <HandsTable store={store} game={game} state={state} />}
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

// 局 as a score sheet: a row per hand, oldest first, each player's change in
// their own column - 胡 / 摸 on the winner's number, 銃 on the discarder's -
// and the total at the foot. A tap opens who paid whom. 特別獎罰 are their
// own rows, or folded into the hand they happened during.
type SheetRow =
  | { kind: "hand"; key: string; h: HandResult; deltas: Record<string, number>; bonuses: number; payIns: number }
  | { kind: "bonus"; key: string; label: "獎" | "罰" | "獎罰" | "詐胡"; deltas: Record<string, number> }
  | { kind: "jackpot"; key: string; deltas: Record<string, number> };

const shortName = (n: string) => {
  const chars = [...n.replace(/\s+/g, "")];
  return /[\u3400-\u9fff]/.test(n) ? chars.slice(0, 2).join("") : chars.slice(0, 3).join("");
};

const SHEET_VIEW_KEY = "mjwaits.sheetView";

function HandsTable({ store, game, state }: { store: ScoreStore; game: ScoreGame; state: ReplayState }) {
  // Detailed: 獎罰 and Jackpot pay-ins as their own rows, with every tag and
  // 胡 / 摸 / 銃 mark. Simple: all folded into the hands, numbers only (the
  // winner's in bold). Remembered on this phone.
  const [detailed, setDetailedState] = useState(() => {
    try {
      return window.localStorage.getItem(SHEET_VIEW_KEY) !== "simple";
    } catch {
      return true;
    }
  });
  const setDetailed = (on: boolean) => {
    setDetailedState(on);
    try {
      window.localStorage.setItem(SHEET_VIEW_KEY, on ? "detailed" : "simple");
    } catch {
      // Just this visit, then.
    }
  };
  const merge = !detailed;
  const tags = detailed;
  const [open, setOpen] = useState<string | null>(null);
  const players = state.players.filter((p) => state.hands.some((h) => h.seatsAfter.includes(p)) || (state.totals[p] ?? 0) !== 0);
  const rows = useMemo(() => {
    const out: SheetRow[] = [];
    // 獎罰 and Jackpot pay-ins waiting to fold into the next hand (Merged).
    let pending: { deltas: Record<string, number>; count: number; payIns: number } | null = null;
    const fold = (deltas: Record<string, number>, payIn: boolean) => {
      const acc = pending ?? { deltas: {}, count: 0, payIns: 0 };
      for (const [p, d] of Object.entries(deltas)) acc.deltas[p] = (acc.deltas[p] ?? 0) + d;
      if (payIn) acc.payIns++;
      else acc.count++;
      pending = acc;
    };
    game.events.forEach((ev, i) => {
      const step = state.steps.find((x) => x.eventIndex === i);
      const deltas = step?.deltas ?? {};
      if (ev.t === "win" || ev.t === "draw") {
        const h = state.hands.find((x) => x.eventIndex === i);
        if (!h) return;
        const merged = { ...deltas };
        if (pending) for (const [p, d] of Object.entries(pending.deltas)) merged[p] = (merged[p] ?? 0) + d;
        const folded = pending as { count: number; payIns: number } | null;
        out.push({ kind: "hand", key: `h${i}`, h, deltas: merged, bonuses: folded?.count ?? 0, payIns: folded?.payIns ?? 0 });
        pending = null;
      } else if (ev.t === "bonus" || ev.t === "zhaHu") {
        if (merge) fold(deltas, false);
        else out.push({ kind: "bonus", key: `b${i}`, label: ev.t === "zhaHu" ? "詐胡" : ev.kind, deltas });
      } else if (ev.t === "jackpotIn" && merge) {
        fold(deltas, true);
      } else if ((ev.t === "jackpot" || ev.t === "jackpotIn") && Object.values(deltas).some((d) => d !== 0)) {
        out.push({ kind: "jackpot", key: `j${i}`, deltas });
      }
    });
    // A bonus after the last hand has no hand to join yet.
    if (pending) {
      const left = pending as { deltas: Record<string, number>; count: number };
      out.push(left.count > 0 ? { kind: "bonus", key: "b-pending", label: "獎罰", deltas: left.deltas } : { kind: "jackpot", key: "j-pending", deltas: left.deltas });
    }
    return out;
  }, [game, state, merge]);
  const cols = { gridTemplateColumns: `1.5rem 2.7rem repeat(${players.length}, minmax(0, 1fr))` };
  const cell = (row: SheetRow, p: string) => {
    const d = row.deltas[p] ?? 0;
    let mark: string | null = null;
    if (row.kind === "hand" && row.h.kind === "win" && tags) {
      if (row.h.winners.some((w) => w.player === p)) mark = row.h.selfDraw ? "摸" : "胡";
      else if (row.h.from === p) mark = "銃";
    }
    const won = row.kind === "hand" && row.h.winners.some((w) => w.player === p);
    return (
      <span key={p} className={`sc-sheet-cell ${d ? tone(d) : "is-zero"}${won ? " is-winner" : ""}`}>
        {mark && <span className={`sc-sheet-mark${mark === "銃" ? " is-dealin" : ""}`}>{mark}</span>}
        {d ? signed(d) : "·"}
      </span>
    );
  };
  const what = (row: SheetRow) => {
    if (row.kind === "bonus") return <span className="sc-sheet-what is-muted">{row.label}</span>;
    if (row.kind === "jackpot") return <span className="sc-sheet-what is-muted">JP</span>;
    const h = row.h;
    if (h.kind === "draw") return <span className="sc-sheet-what is-muted">流局</span>;
    const tag = h.pairs.some((x) => x.lahKind === "拉") ? "拉" : h.pairs.some((x) => x.lahKind === "踢") ? "踢" : null;
    return (
      <span className="sc-sheet-what">
        {h.multi > 1 ? (h.multi === 2 ? "雙" : "三") : fmt(h.winners[0].tai)}
        {tags && tag && <small>{tag}</small>}
        {tags && row.bonuses > 0 && <small>獎罰</small>}
        {tags && row.payIns > 0 && <small>JP</small>}
      </span>
    );
  };
  if (state.hands.length === 0) return <div className="card"><p className="sc-empty">No hands yet.</p></div>;
  return (
    <div className="card sc-sheet-card">
      <div className="sc-card-head">
        <h3>局 Hands</h3>
        <Segmented
          small
          value={detailed ? "detailed" : "simple"}
          onChange={(v) => setDetailed(v === "detailed")}
          options={[
            { value: "detailed", label: "Detailed" },
            { value: "simple", label: "Simple" },
          ]}
        />
      </div>
      <div className="sc-sheet-table" role="table" aria-label="Every hand, and what each player won or paid">
        <div className="sc-sheet-row is-head" style={cols} role="row">
          <span>#</span>
          <span>番</span>
          {players.map((p) => (
            <span key={p} className={`sc-sheet-name sc-c${colorOf(store, p)}`} title={p}>
              {shortName(p)}
            </span>
          ))}
        </div>
        {rows.map((row) => {
          const isOpen = open === row.key;
          return (
            <Fragment key={row.key}>
              <div
                className={`sc-sheet-row is-${row.kind}${isOpen ? " is-open" : ""}`}
                style={cols}
                role="row"
                tabIndex={row.kind === "hand" ? 0 : undefined}
                onClick={() => row.kind === "hand" && setOpen(isOpen ? null : row.key)}
              >
                <span className="sc-sheet-no">{row.kind === "hand" ? row.h.hand : ""}</span>
                {what(row)}
                {players.map((p) => cell(row, p))}
              </div>
              {isOpen && row.kind === "hand" && <HandDetail h={row.h} bonuses={row.bonuses} payIns={row.payIns} />}
            </Fragment>
          );
        })}
        <div className="sc-sheet-row is-total" style={cols} role="row">
          <span />
          <span>Total</span>
          {players.map((p) => (
            <span key={p} className={`sc-sheet-cell ${tone(state.totals[p] ?? 0)}`}>
              {signed(state.totals[p] ?? 0)}
            </span>
          ))}
        </div>
      </div>
      <p className="sc-help sc-help-block">Tap a hand for who paid whom.{merge ? " 獎罰 and Jackpot pay-ins are folded into the hand they happened during." : ""}</p>
    </div>
  );
}

// One hand opened in the 局 sheet: the round, each payment and its parts,
// and anything else that moved (反雪, the Jackpot).
function HandDetail({ h, bonuses, payIns }: { h: HandResult; bonuses: number; payIns: number }) {
  const lines: string[] = h.pairs.map((p) => {
    const parts = [p.base ? `底${fmt(p.base)}` : null, `番${fmt(p.tai)}`, p.dealer ? `莊${fmt(p.dealer)}` : null, p.lahKind ? `${p.lahKind}${fmt(p.lah)}` : null].filter(Boolean);
    return `${p.payer} → ${p.winner} ${fmt(p.worth)} · ${parts.join(" ")}`;
  });
  for (const f of h.fanXue) lines.push(`${f.from} → ${f.to} ${fmt(f.amount)} · 反雪`);
  if (h.jackpotWon) lines.push(`${h.jackpotWon.player} takes the Jackpot ${fmt(h.jackpotWon.amount)}`);
  if (h.jackpotFed > 0) lines.push(`Jackpot +${fmt(h.jackpotFed)}`);
  if (bonuses > 0) lines.push(`Includes ${bonuses} 特別獎罰`);
  if (payIns > 0) lines.push(`Includes ${payIns} Jackpot pay-in${payIns > 1 ? "s" : ""}`);
  return (
    <div className="sc-sheet-detail">
      <span className="sc-help">
        {h.label} · 莊 {h.dealer}
        {h.streak > 0 ? ` 連${h.streak}` : ""}
        {h.multi > 1 ? ` · ${h.winners.map((w) => `${w.player} ${fmt(w.tai)}番`).join(", ")}` : ""}
      </span>
      {lines.map((l, i) => (
        <span key={i}>{l}</span>
      ))}
    </div>
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
                  {g.name && <strong>{g.name} · </strong>}
                  {g === store.active ? "In progress" : new Date(g.startedAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}
                  {playTimes(g) && ` · ${playTimes(g)}`}
                  {g.location && ` · ${g.location}`}
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

// What a shared link opens: the game as it stood when it was shared,
// read-only, in the board's colours. Nothing here touches this phone's own
// scores.
export function SharedScoresView({ snap, onClose }: { snap: ScoreSnapshot; onClose: () => void }) {
  const ranked = [...snap.players].sort((a, b) => b.t - a.t);
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
      <button type="button" className="sc-primary sc-shared-open" onClick={onClose}>
        Open MJWaits
      </button>
    </section>
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
}: {
  store: ScoreStore;
  setStore: (s: ScoreStore) => void;
  seatNames: readonly string[];
  request: RecordRequest | null;
  onRequestDone: () => void;
  onScoreHand?: (req: Omit<ScoreHandRequest, "nonce">) => void;
  onOpenSeating?: (names: string[]) => void; // the Dice tab's Seating, for the seat ceremony
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
            onScoreHand={onScoreHand}
            onOpenSeating={onOpenSeating}
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
