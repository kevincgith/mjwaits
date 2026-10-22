// Scores tab: the small pieces every part of it uses - number formats, the
// player colours and monograms, icons, and the sheet, toggle, stepper and
// segmented controls.

import { type RefObject, useEffect, useState, type ReactNode } from "react";
import { PLAYER_COLORS, type PatternNote, type ScoreStore } from "../lib/ledger";

export const WIND_CHARS = ["東", "南", "西", "北"];
// Where each seat sits on the board, by seat index (turn order runs
// counter-clockwise: seat 0 along the bottom, then right, top, left).
export const SEAT_AREAS = ["bottom", "right", "top", "left"] as const;
// Each area's place on the table, for pointing from one seat at another.
export const AREA_XY: Record<(typeof SEAT_AREAS)[number], [number, number]> = { bottom: [0, 1], right: [1, 0], top: [0, -1], left: [-1, 0] };

// Which side of seat `from`'s card faces seat `to` - always one of the four
// sides, never a corner. The top and bottom cards point sideways at the side
// seats and straight down/up at each other; the side cards point up/down at
// the top and bottom seats and across at each other. So each of a card's
// three other players gets a side of its own.
export function facing(from: number, to: number): "top" | "bottom" | "left" | "right" {
  const [ax, ay] = AREA_XY[SEAT_AREAS[from]];
  const [bx, by] = AREA_XY[SEAT_AREAS[to]];
  const dx = bx - ax;
  const dy = by - ay;
  const sideways = ax === 0 ? dx !== 0 : dy === 0;
  return sideways ? (dx < 0 ? "left" : "right") : dy < 0 ? "top" : "bottom";
}

// The board view fits the screen when at least this much height is left for
// it (px), keeping FIT_GAP clear above the tab bar.
export const FIT_MIN = 470;
export const FIT_GAP = 10;

// A hand sent from the Scoring tab, waiting to be recorded.
export interface RecordRequest {
  seatWind: number; // 1-4, the winner's 門風 as entered in Scoring
  selfDraw: boolean;
  tai: number; // without 莊 - the ledger adds that
  patterns: PatternNote[];
  removedDealerTai: number;
  // Scored under custom tai rules: their fingerprint (see WinnerEntry.rules).
  rules?: string;
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

// The Dice tab's seat ceremony, back from Seating: who sits at each seat
// (bottom, right, top, left - the board's own order) and who drew 東.
export interface SeatingResult {
  seats: string[];
  east: string;
  nonce: number;
}

// Numbers: a true minus sign, one decimal only when 整數模式 is off.
export const fmt = (n: number) => {
  const s = Number.isInteger(n) ? String(Math.abs(n)) : Math.abs(n).toFixed(1);
  return n < 0 ? `−${s}` : s;
};
export const signed = (n: number) => (n > 0 ? `+${fmt(n)}` : fmt(n));
export const pct = (r: number | null) => (r === null ? "–" : `${Math.round(r * 100)}%`);
export const tone = (n: number) => (n > 0 ? "is-pos" : n < 0 ? "is-neg" : "is-zero");

// A player's palette slot; "x" (no colour class, so neutral) for a name
// typed in a sheet that isn't on the roster yet.
export function colorOf(store: ScoreStore, player: string): number | "x" {
  return store.roster.find((p) => p.name === player)?.color ?? "x";
}

// ---- Icons (24px line art, the same stroke style as the tab bar) -----------

export const ICON = {
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

export const Icons = {
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
  // 玩家's best / lowest at the table.
  thumbUp: (
    <svg {...ICON} width={14} height={14} strokeWidth={2}>
      <path d="M7 10v11" />
      <path d="M15 5.9 14 10h5.8a2 2 0 0 1 1.9 2.6l-2.3 7A2 2 0 0 1 17.5 21H4.5A1.5 1.5 0 0 1 3 19.5v-8A1.5 1.5 0 0 1 4.5 10h2.8a2 2 0 0 0 1.8-1.1L12 3a3 3 0 0 1 3 2.9Z" />
    </svg>
  ),
  thumbDown: (
    <svg {...ICON} width={14} height={14} strokeWidth={2}>
      <path d="M17 14V3" />
      <path d="M9 18.1 10 14H4.2a2 2 0 0 1-1.9-2.6l2.3-7A2 2 0 0 1 6.5 3h13A1.5 1.5 0 0 1 21 4.5v8a1.5 1.5 0 0 1-1.5 1.5h-2.8a2 2 0 0 0-1.8 1.1L12 21a3 3 0 0 1-3-2.9Z" />
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

export function SectionHead({ zh, en, children }: { zh: string; en?: string; children?: ReactNode }) {
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
export function initials(store: ScoreStore, player: string): string {
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
export function Monogram({ store, player, size = "md" }: { store: ScoreStore; player: string; size?: "sm" | "md" | "lg" }) {
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
export interface SheetFrame {
  ref: RefObject<HTMLDivElement | null>;
  minHeight?: number;
  hidden: boolean;
}

export function Sheet({
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
export function Keypad({ value, onChange, max }: { value: string; onChange: (v: string) => void; max?: number | null }) {
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

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} className={`sc-switch${checked ? " is-on" : ""}`} onClick={() => onChange(!checked)}>
      <span />
    </button>
  );
}

export function Stepper({ value, onChange, min = 0, max, step = 1, label, disabled }: { value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number; label?: string; disabled?: boolean }) {
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

export function NumberField({ value, onChange, label, pill, disabled }: { value: number; onChange: (v: number) => void; label: string; pill?: boolean; disabled?: boolean }) {
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

export function Segmented<T extends string | number>({ value, options, onChange, small }: { value: T; options: { value: T; label: ReactNode }[]; onChange: (v: T) => void; small?: boolean }) {
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
export function PlayerOption({
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

export function Sparkline({ values, className }: { values: (number | null)[]; className: string }) {
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

// The roster with any new names added, each in the first colour not yet taken.
export function withRoster(store: ScoreStore, names: string[]) {
  const roster = store.roster.slice();
  for (const name of names) {
    if (roster.some((p) => p.name === name)) continue;
    const used = new Set(roster.map((p) => p.color));
    const color = [...Array(PLAYER_COLORS).keys()].find((c) => !used.has(c)) ?? roster.length % PLAYER_COLORS;
    roster.push({ name, color });
  }
  return roster;
}
