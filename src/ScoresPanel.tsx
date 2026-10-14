// Scores tab: keeps score of a real game at the table (港式台牌 house rules),
// with analytics. All the rules live in lib/ledger.ts and the numbers in
// lib/scoreStats.ts; this file is the board (戰況), its sheets, and the
// stats views (統計).
//
// The store - the game in progress, finished games and the player roster -
// is owned by App (so the Scoring tab can send a hand here) and saved to
// localStorage on every change.

import { useEffect, useMemo, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import {
  DEFAULT_SETTINGS,
  PLAYER_COLORS,
  SEATS,
  newGame,
  previewWin,
  replay,
  settle,
  undoEvent,
  withEvent,
  type PatternNote,
  type ReplayState,
  type ScoreEvent,
  type ScoreGame,
  type ScoreSettings,
  type ScoreStore,
  type WinnerEntry,
} from "./lib/ledger";
import {
  careerStats,
  headToHead,
  marks,
  patternCounts,
  playerStats,
  trend,
  type PlayerStats,
} from "./lib/scoreStats";

const WIND_CHARS = ["東", "南", "西", "北"];
// Where each seat sits on the board, by seat index (turn order runs
// counter-clockwise: you along the bottom, then right, top, left).
const SEAT_AREAS = ["bottom", "right", "top", "left"] as const;

// A hand sent from the Scoring tab, waiting to be recorded.
export interface RecordRequest {
  seatWind: number; // 1-4, the winner's 門風 as entered in Scoring
  selfDraw: boolean;
  tai: number; // without 莊 - the ledger adds that
  patterns: PatternNote[];
  removedDealerTai: number;
  nonce: number;
}

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
const signed = (n: number) => (n > 0 ? `+${fmt(n)}` : fmt(n));
const pct = (r: number | null) => (r === null ? "–" : `${Math.round(r * 100)}%`);

// A player's palette slot; "x" (no colour class, so a neutral dot) for a
// name typed in a sheet that isn't on the roster yet.
function colorOf(store: ScoreStore, player: string): number | "x" {
  return store.roster.find((p) => p.name === player)?.color ?? "x";
}

// ---- Small building blocks ---------------------------------------------------

function Sheet({ title, onClose, children, actions }: { title: ReactNode; onClose: () => void; children: ReactNode; actions?: ReactNode }) {
  return (
    <div className="sc-backdrop" onClick={onClose}>
      <div className="sc-sheet" role="dialog" aria-label={typeof title === "string" ? title : undefined} onClick={(e) => e.stopPropagation()}>
        <h2 className="sc-sheet-title">{title}</h2>
        <div className="sc-sheet-body">{children}</div>
        {actions && <div className="sc-sheet-actions">{actions}</div>}
      </div>
    </div>
  );
}

function Keypad({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const press = (k: string) => {
    if (k === "⌫") onChange(value.slice(0, -1));
    else onChange(value === "0" ? k : (value + k).slice(0, 5));
  };
  return (
    <div className="sc-keypad">
      {["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0", "⌫"].map((k, i) =>
        k ? (
          <button key={i} type="button" onClick={() => press(k)} aria-label={k === "⌫" ? "Delete" : k}>
            {k}
          </button>
        ) : (
          <span key={i} />
        )
      )}
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

function Stepper({ value, onChange, min = 0 }: { value: number; onChange: (v: number) => void; min?: number }) {
  return (
    <span className="sc-stepper">
      <button type="button" onClick={() => onChange(Math.max(min, value - 1))} aria-label="Less">
        −
      </button>
      <span className="sc-stepper-value">{value}</span>
      <button type="button" onClick={() => onChange(value + 1)} aria-label="More">
        +
      </button>
    </span>
  );
}

function PlayerChip({ store, player, selected, onClick, children }: { store: ScoreStore; player: string; selected?: boolean; onClick?: () => void; children?: ReactNode }) {
  return (
    <button type="button" className={`sc-chip sc-c${colorOf(store, player)}${selected ? " is-on" : ""}`} aria-pressed={selected} onClick={onClick}>
      <span className="sc-dot" />
      {player}
      {children}
    </button>
  );
}

// ---- Setup -------------------------------------------------------------------

function Setup({ store, suggestion, onStart }: { store: ScoreStore; suggestion: readonly string[]; onStart: (seats: string[], dealer: number) => void }) {
  const last = store.history[0]?.seats;
  const [names, setNames] = useState<string[]>(() => (last ?? suggestion).slice(0, SEATS).map(String));
  const [dealer, setDealer] = useState(0);
  const trimmed = names.map((n) => n.trim());
  const valid = trimmed.every(Boolean) && new Set(trimmed).size === SEATS;
  return (
    <div className="card sc-setup">
      <h2 className="sc-h">新局 New game</h2>
      <p className="sc-muted">Players in turn order (counter-clockwise). Tap 莊 for who deals first.</p>
      {names.map((n, i) => (
        <div key={i} className="sc-setup-row">
          <span className="sc-setup-wind">{WIND_CHARS[(i - dealer + SEATS) % SEATS]}</span>
          <input
            className="sc-input"
            value={n}
            maxLength={12}
            onChange={(e) => setNames((prev) => prev.map((x, j) => (j === i ? e.target.value : x)))}
            aria-label={`Player ${i + 1}`}
            list="sc-roster"
          />
          <button type="button" className={`sc-dealer-pick${dealer === i ? " is-on" : ""}`} aria-pressed={dealer === i} onClick={() => setDealer(i)}>
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
      <button type="button" className="sc-primary" disabled={!valid} onClick={() => onStart(trimmed, dealer)}>
        開始 Start
      </button>
    </div>
  );
}

// ---- The 食胡 sheet ------------------------------------------------------------

function WinSheet({
  store,
  state,
  winnerSeat,
  initial,
  onDone,
  onClose,
}: {
  store: ScoreStore;
  state: ReplayState;
  winnerSeat: number;
  initial?: { selfDraw: boolean; tai: number; patterns: PatternNote[]; note?: string };
  onDone: (ev: ScoreEvent) => void;
  onClose: () => void;
}) {
  const seats = state.seats;
  const [multi, setMulti] = useState<1 | 2 | 3>(1);
  const [askMulti, setAskMulti] = useState(false);
  // -1 = not picked yet.
  const [from, setFrom] = useState<number | null>(initial?.selfDraw ? null : -1);
  // Each winner's tai as typed; the first is the tapped player.
  const [entries, setEntries] = useState<{ seat: number; tai: string }[]>([{ seat: winnerSeat, tai: initial ? String(initial.tai) : "" }]);
  const [focus, setFocus] = useState(0);
  const [jackpot, setJackpot] = useState(false);

  const others = [0, 1, 2, 3].filter((s) => s !== winnerSeat);
  const setMultiCount = (n: 1 | 2 | 3) => {
    setMulti(n);
    setAskMulti(false);
    if (n === 1) setEntries((e) => e.slice(0, 1));
    else if (from === null) setFrom(-1);
  };
  // Extra winners for 雙響/三響: picked from whoever isn't the discarder.
  const extraCandidates = [0, 1, 2, 3].filter((s) => s !== winnerSeat && s !== from);
  const toggleExtra = (seat: number) => {
    setEntries((prev) => {
      if (prev.some((e) => e.seat === seat)) return prev.filter((e) => e.seat !== seat);
      if (prev.length >= multi) return prev;
      return [...prev, { seat, tai: "" }];
    });
  };
  const winners: WinnerEntry[] = entries.map((e, i) => ({
    seat: e.seat,
    tai: Number(e.tai || 0),
    ...(i === 0 && initial?.patterns.length ? { patterns: initial.patterns } : {}),
  }));
  const fromValid = from === null ? multi === 1 : from >= 0;
  const complete = fromValid && entries.length === multi && entries.every((e) => e.tai !== "") && !entries.some((e) => e.seat === from);
  const pairs = complete ? previewWin(state, winners, from) : [];
  const high = state.settings.highScore !== null && pairs.some((p) => p.worth >= state.settings.highScore!);

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

  if (askMulti) {
    return (
      <Sheet title="一炮多響！" onClose={() => setAskMulti(false)}>
        <div className="sc-two">
          <button type="button" className="sc-primary" onClick={() => setMultiCount(2)}>
            雙響
          </button>
          <button type="button" className="sc-primary" onClick={() => setMultiCount(3)}>
            三響
          </button>
        </div>
        <button type="button" className="sc-link" onClick={() => setMultiCount(1)}>
          Back to one winner
        </button>
      </Sheet>
    );
  }

  return (
    <Sheet
      title={
        <>
          {seats[winnerSeat]} {multi === 1 ? (from === null ? "自摸！" : "食胡！") : multi === 2 ? "雙響！" : "三響！"}
          <button type="button" className="sc-multi-button" onClick={() => setAskMulti(true)}>
            一炮多響
          </button>
        </>
      }
      onClose={onClose}
      actions={
        <>
          <button type="button" className="sc-secondary" onClick={onClose}>
            取消
          </button>
          <button type="button" className="sc-primary" disabled={!complete} onClick={submit}>
            確定
          </button>
        </>
      }
    >
      {initial?.note && <p className="sc-note">{initial.note}</p>}
      <div className="sc-field">
        <span className="sc-label">輸家</span>
        <div className="sc-chips">
          {multi === 1 && (
            <button type="button" className={`sc-chip${from === null ? " is-on" : ""}`} aria-pressed={from === null} onClick={() => setFrom(null)}>
              自摸
            </button>
          )}
          {others.map((s) => (
            <PlayerChip key={s} store={store} player={seats[s]} selected={from === s} onClick={() => { setFrom(s); setEntries((e) => e.filter((x) => x.seat !== s)); }} />
          ))}
        </div>
      </div>
      {multi > 1 && (
        <div className="sc-field">
          <span className="sc-label">也胡</span>
          <div className="sc-chips">
            {extraCandidates.map((s) => (
              <PlayerChip key={s} store={store} player={seats[s]} selected={entries.some((e) => e.seat === s)} onClick={() => toggleExtra(s)} />
            ))}
          </div>
        </div>
      )}
      <div className="sc-field">
        <span className="sc-label">番</span>
        <div className="sc-tai-fields">
          {entries.map((e, i) => (
            <button key={e.seat} type="button" className={`sc-tai${focus === i ? " is-focus" : ""}`} onClick={() => setFocus(i)}>
              {multi > 1 && <span className="sc-tai-who">{seats[e.seat]}</span>}
              <span className="sc-tai-value">{e.tai || "0"}</span>
            </button>
          ))}
        </div>
      </div>
      <Keypad value={entries[focus]?.tai ?? ""} onChange={(v) => setEntries((prev) => prev.map((e, i) => (i === focus ? { ...e, tai: v } : e)))} />
      {state.pot > 0 && (
        <label className="sc-row">
          <span>Jackpot {fmt(state.pot)} → {seats[winnerSeat]}</span>
          <Toggle checked={jackpot} onChange={setJackpot} label="Winner takes the Jackpot" />
        </label>
      )}
      {pairs.length > 0 && (
        <table className="sc-breakdown">
          <thead>
            <tr>
              <th />
              <th>底</th>
              <th>番</th>
              <th>莊</th>
              <th>拉</th>
              <th>總</th>
            </tr>
          </thead>
          <tbody>
            {pairs.map((p, i) => (
              <tr key={i} className={state.settings.highScore !== null && p.worth >= state.settings.highScore ? "is-high" : undefined}>
                <th>
                  {multi > 1 ? `${p.winner} ← ` : ""}
                  {p.payer}
                </th>
                <td>{fmt(p.base)}</td>
                <td>{fmt(p.tai)}</td>
                <td>{fmt(p.dealer)}</td>
                <td title={p.lahKind ? `${p.lahKind} on ${fmt(p.lahBefore)}` : undefined}>
                  {p.lahKind ? `${p.lahKind === "踢" ? "踢" : ""}${fmt(p.lah)}` : 0}
                </td>
                <td className="sc-strong">{fmt(p.worth)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {high && <p className="sc-warn">高分 – a payment of {state.settings.highScore} or more. Double-check the tai.</p>}
    </Sheet>
  );
}

// ---- Other sheets --------------------------------------------------------------

function BonusSheet({ state, seat, onDone, onClose }: { state: ReplayState; seat: number; onDone: (ev: ScoreEvent) => void; onClose: () => void }) {
  const [kind, setKind] = useState<"獎" | "罰">("獎");
  const [amount, setAmount] = useState("");
  const n = Number(amount || 0);
  return (
    <Sheet
      title={`${state.seats[seat]} 特別獎罰`}
      onClose={onClose}
      actions={
        <>
          <button type="button" className="sc-secondary" onClick={onClose}>
            取消
          </button>
          <button type="button" className="sc-primary" disabled={n <= 0} onClick={() => onDone({ t: "bonus", at: Date.now(), seat, amount: n, kind })}>
            確定
          </button>
        </>
      }
    >
      <div className="segmented sc-seg">
        {(["獎", "罰"] as const).map((k) => (
          <button key={k} type="button" className={kind === k ? "toggle-on" : undefined} aria-pressed={kind === k} onClick={() => setKind(k)}>
            {k === "獎" ? "獎 – each other player pays" : "罰 – pays each other player"}
          </button>
        ))}
      </div>
      <div className="sc-tai sc-tai-wide">
        <span className="sc-tai-value">{amount || "0"}</span>
      </div>
      <Keypad value={amount} onChange={setAmount} />
      {n > 0 && (
        <p className="sc-muted">
          {kind === "獎" ? `${state.seats[seat]} +${n * 3}, everyone else −${n}` : `${state.seats[seat]} −${n * 3}, everyone else +${n}`}
        </p>
      )}
    </Sheet>
  );
}

function DealerSheet({ store, state, onDone, onClose }: { store: ScoreStore; state: ReplayState; onDone: (ev: ScoreEvent) => void; onClose: () => void }) {
  const [seat, setSeat] = useState(state.dealer);
  const [streak, setStreak] = useState(state.streak);
  const [reset, setReset] = useState(false);
  return (
    <Sheet
      title="莊家設定"
      onClose={onClose}
      actions={
        <>
          <button type="button" className="sc-secondary" onClick={onClose}>
            取消
          </button>
          <button type="button" className="sc-primary" onClick={() => onDone({ t: "dealer", at: Date.now(), seat, streak, resetRound: reset })}>
            確定
          </button>
        </>
      }
    >
      <div className="sc-mini-board">
        {state.seats.map((p, s) => (
          <div key={s} className={`sc-mini sc-area-${SEAT_AREAS[s]}`}>
            <PlayerChip store={store} player={p} selected={seat === s} onClick={() => setSeat(s)}>
              {seat === s && <span className="sc-zhuang">莊</span>}
            </PlayerChip>
          </div>
        ))}
      </div>
      <label className="sc-row">
        <span>重置風局 (back to 東風東局)</span>
        <Toggle checked={reset} onChange={setReset} label="Reset the round" />
      </label>
      <div className="sc-row">
        <span>連莊</span>
        <Stepper value={streak} onChange={setStreak} />
      </div>
    </Sheet>
  );
}

function SwapSheet({ store, state, onDone, onClose }: { store: ScoreStore; state: ReplayState; onDone: (seats: string[], newNames: string[]) => void; onClose: () => void }) {
  const [seats, setSeats] = useState(state.seats.slice());
  const [picked, setPicked] = useState<number | null>(null);
  const [newName, setNewName] = useState("");
  const [added, setAdded] = useState<string[]>([]);
  const bench = [...new Set([...store.roster.map((p) => p.name), ...state.players, ...added])].filter((p) => !seats.includes(p));
  const tapSeat = (s: number) => {
    if (picked === null) return setPicked(s);
    if (picked !== s) setSeats((prev) => prev.map((p, i) => (i === s ? prev[picked] : i === picked ? prev[s] : p)));
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
  return (
    <Sheet
      title="換人"
      onClose={onClose}
      actions={
        <>
          <button type="button" className="sc-secondary" onClick={onClose}>
            取消
          </button>
          <button type="button" className="sc-primary" onClick={() => onDone(seats, added)}>
            確定
          </button>
        </>
      }
    >
      <p className="sc-muted">Tap a seat, then another seat to swap them, or a 候補 player to sit them there.</p>
      <div className="sc-mini-board">
        {seats.map((p, s) => (
          <div key={s} className={`sc-mini sc-area-${SEAT_AREAS[s]}`}>
            <PlayerChip store={store} player={p} selected={picked === s} onClick={() => tapSeat(s)} />
          </div>
        ))}
      </div>
      <div className="sc-field">
        <span className="sc-label">候補玩家</span>
        <div className="sc-chips">
          {bench.map((p) => (
            <PlayerChip key={p} store={store} player={p} onClick={() => tapBench(p)} />
          ))}
          <span className="sc-add">
            <input className="sc-input" value={newName} maxLength={12} placeholder="New player" onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addName()} aria-label="New player name" />
            <button type="button" className="sc-chip" onClick={addName} aria-label="Add player">
              ＋
            </button>
          </span>
        </div>
      </div>
    </Sheet>
  );
}

function LahSheet({ state, onSurrender, onClose }: { state: ReplayState; onSurrender: (holder: string, pulled: string) => void; onClose: () => void }) {
  return (
    <Sheet
      title="拉踢"
      onClose={onClose}
      actions={
        <button type="button" className="sc-primary" onClick={onClose}>
          確定
        </button>
      }
    >
      {state.lahs.length === 0 && <p className="sc-muted">No 拉 on the table.</p>}
      {[...new Set(state.lahs.map((l) => l.holder))].map((holder) => (
        <div key={holder} className="sc-lah-group">
          <div className="sc-lah-holder">{holder} 拉</div>
          {state.lahs
            .filter((l) => l.holder === holder)
            .map((l) => (
              <div key={l.pulled} className="sc-lah-row">
                <span>
                  {l.pulled}: {fmt(l.value)}分 ({l.count}次)
                </span>
                <button type="button" className="sc-outline" onClick={() => onSurrender(l.holder, l.pulled)}>
                  投降
                </button>
              </div>
            ))}
        </div>
      ))}
    </Sheet>
  );
}

function JackpotSheet({ store, state, onDone, onClose }: { store: ScoreStore; state: ReplayState; onDone: (ev: ScoreEvent) => void; onClose: () => void }) {
  const [shares, setShares] = useState<number[]>(() => state.seats.map(() => 0));
  const total = shares.reduce((a, b) => a + b, 0);
  const evenly = () => {
    const each = Math.floor(state.pot / SEATS);
    setShares(state.seats.map((_, i) => each + (i === 0 ? state.pot - each * SEATS : 0)));
  };
  return (
    <Sheet
      title={`Jackpot ${fmt(state.pot)}`}
      onClose={onClose}
      actions={
        <>
          <button type="button" className="sc-secondary" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="sc-primary"
            disabled={total <= 0 || total > state.pot}
            onClick={() => onDone({ t: "jackpot", at: Date.now(), shares: state.seats.map((player, i) => ({ player, amount: shares[i] })).filter((s) => s.amount > 0) })}
          >
            確定
          </button>
        </>
      }
    >
      {state.seats.map((p, i) => (
        <div key={p} className="sc-row">
          <PlayerChip store={store} player={p} onClick={() => setShares((prev) => prev.map((_, j) => (j === i ? state.pot : 0)))} />
          <Stepper value={shares[i]} onChange={(v) => setShares((prev) => prev.map((x, j) => (j === i ? v : x)))} />
        </div>
      ))}
      <div className="sc-row">
        <span className={total > state.pot ? "sc-warn" : "sc-muted"}>
          {fmt(total)} of {fmt(state.pot)} handed out
        </span>
        <button type="button" className="sc-outline" onClick={evenly}>
          Split evenly
        </button>
      </div>
    </Sheet>
  );
}

function SettleSheet({ state, onEnd, onClose }: { state: ReplayState; onEnd: () => void; onClose: () => void }) {
  const [multiplier, setMultiplier] = useState("1");
  const m = Number(multiplier) || 0;
  const payments = settle(state.totals, m);
  return (
    <Sheet
      title="結帳詳情"
      onClose={onClose}
      actions={
        <>
          <button type="button" className="sc-secondary" onClick={onClose}>
            取消
          </button>
          <button type="button" className="sc-primary" onClick={onEnd}>
            完場 End game
          </button>
        </>
      }
    >
      <label className="sc-row">
        <span>倍數</span>
        <input className="sc-input sc-input-short" inputMode="decimal" value={multiplier} onChange={(e) => setMultiplier(e.target.value.replace(/[^0-9.]/g, ""))} aria-label="Multiplier" />
      </label>
      {state.pot > 0 && <p className="sc-muted">Jackpot {fmt(state.pot)} still in the pot – hand it out first if it should count.</p>}
      <div className="sc-settle">
        {payments.length === 0 && <p className="sc-muted">Everyone is level.</p>}
        {payments.map((p, i) => (
          <div key={i} className="sc-settle-row">
            <span>{p.from}</span>
            <span className="sc-settle-amount">
              ${fmt(p.amount)}
              <span aria-hidden="true">→</span>
            </span>
            <span>{p.to}</span>
          </div>
        ))}
      </div>
    </Sheet>
  );
}

const SETTING_ROWS: { key: keyof ScoreSettings; label: string; kind: "number" | "bool" | "nullable" | "round" }[] = [
  { key: "base", label: "自動計算底", kind: "number" },
  { key: "dealerTai", label: "自動計算莊", kind: "number" },
  { key: "streakTai", label: "自動計算連莊 (per 連)", kind: "number" },
  { key: "fanXue", label: "反雪", kind: "bool" },
  { key: "fanXueBonus", label: "反雪 extra", kind: "number" },
  { key: "drawKeepsDealer", label: "流局留莊", kind: "bool" },
  { key: "jackpot", label: "Jackpot", kind: "bool" },
  { key: "jackpotPerDraw", label: "Jackpot per player per 流局", kind: "number" },
  { key: "integerMode", label: "整數模式", kind: "bool" },
  { key: "lahRound", label: "拉 half", kind: "round" },
  { key: "tiRound", label: "踢 half", kind: "round" },
  { key: "showLah", label: "拉數提示", kind: "bool" },
  { key: "seatReminder", label: "執位提示", kind: "bool" },
  { key: "selfDrawKey", label: "自摸鍵", kind: "bool" },
  { key: "highScore", label: "高分提示", kind: "nullable" },
];

function SettingsSheet({ settings, onSave, onClose }: { settings: ScoreSettings; onSave: (s: ScoreSettings) => void; onClose: () => void }) {
  const [s, setS] = useState<ScoreSettings>(settings);
  const set = <K extends keyof ScoreSettings>(key: K, value: ScoreSettings[K]) => setS((prev) => ({ ...prev, [key]: value }));
  return (
    <Sheet
      title="港式台牌 設定"
      onClose={onClose}
      actions={
        <>
          <button type="button" className="sc-secondary" onClick={onClose}>
            取消
          </button>
          <button type="button" className="sc-primary" onClick={() => onSave(s)}>
            保存
          </button>
        </>
      }
    >
      {SETTING_ROWS.map(({ key, label, kind }) => {
        if (kind === "bool")
          return (
            <label key={key} className="sc-row">
              <span>{label}</span>
              <Toggle checked={s[key] as boolean} onChange={(v) => set(key, v as never)} label={label} />
            </label>
          );
        if (kind === "round")
          return (
            <div key={key} className="sc-row">
              <span>{label}</span>
              <span className="segmented sc-seg-small">
                {(["up", "down"] as const).map((r) => (
                  <button key={r} type="button" className={s[key] === r ? "toggle-on" : undefined} aria-pressed={s[key] === r} disabled={!s.integerMode} onClick={() => set(key, r as never)}>
                    {r === "up" ? "0.5進1" : "捨去"}
                  </button>
                ))}
              </span>
            </div>
          );
        if (kind === "nullable")
          return (
            <div key={key} className="sc-row">
              <span>{label}</span>
              <span className="sc-row-end">
                {s.highScore !== null && <Stepper value={s.highScore} onChange={(v) => set("highScore", v)} />}
                <Toggle checked={s.highScore !== null} onChange={(v) => set("highScore", v ? 50 : null)} label={label} />
              </span>
            </div>
          );
        return (
          <div key={key} className="sc-row">
            <span>{label}</span>
            <Stepper value={s[key] as number} onChange={(v) => set(key, v as never)} />
          </div>
        );
      })}
      <button type="button" className="sc-link" onClick={() => setS(DEFAULT_SETTINGS)}>
        Reset to defaults
      </button>
    </Sheet>
  );
}

function Confirm({ title, detail, onYes, onClose, yes = "確定" }: { title: string; detail?: string; onYes: () => void; onClose: () => void; yes?: string }) {
  return (
    <Sheet
      title={title}
      onClose={onClose}
      actions={
        <>
          <button type="button" className="sc-secondary" onClick={onClose}>
            取消
          </button>
          <button type="button" className="sc-primary" onClick={onYes}>
            {yes}
          </button>
        </>
      }
    >
      {detail && <p className="sc-muted">{detail}</p>}
    </Sheet>
  );
}

// ---- The board (戰況) -----------------------------------------------------------

type BoardSheet =
  | { kind: "card"; seat: number }
  | { kind: "win"; seat: number; initial?: { selfDraw: boolean; tai: number; patterns: PatternNote[]; note?: string } }
  | { kind: "bonus"; seat: number }
  | { kind: "draw" }
  | { kind: "dealer" }
  | { kind: "swap" }
  | { kind: "lah" }
  | { kind: "jackpot" }
  | { kind: "settle" }
  | { kind: "settings" }
  | { kind: "newGame" };

function describeEvent(ev: ScoreEvent, state: ReplayState, i: number): string {
  if (ev.t === "win" || ev.t === "draw") {
    const h = state.hands.find((x) => x.eventIndex === i);
    if (!h) return "";
    if (h.kind === "draw") return `第${h.hand}局 流局`;
    return `第${h.hand}局 ${h.winners.map((w) => w.player).join("、")} ${h.selfDraw ? "自摸" : `食 ${h.from}`}`;
  }
  if (ev.t === "bonus") return `${state.seats[ev.seat] ?? ""} 特別${ev.kind}`;
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
}: {
  store: ScoreStore;
  game: ScoreGame;
  state: ReplayState;
  update: (game: ScoreGame, extra?: Partial<ScoreStore>) => void;
  onEndGame: () => void;
  request: RecordRequest | null;
  onRequestDone: () => void;
}) {
  const [sheet, setSheet] = useState<BoardSheet | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const close = () => setSheet(null);
  const add = (ev: ScoreEvent) => {
    update(withEvent(game, ev));
    close();
  };
  const flash = (text: string) => {
    setToast(text);
    window.setTimeout(() => setToast((t) => (t === text ? null : t)), 1800);
  };

  // A hand sent from Scoring opens the 食胡 sheet for whoever has that 門風.
  useEffect(() => {
    if (!request) return;
    const seat = [0, 1, 2, 3].find((s) => ((s - state.dealer + SEATS) % SEATS) + 1 === request.seatWind) ?? 0;
    setSheet({
      kind: "win",
      seat,
      initial: {
        selfDraw: request.selfDraw,
        tai: request.tai,
        patterns: request.patterns,
        note: `From Scoring: ${request.tai} tai${request.removedDealerTai ? ` (莊 ${request.removedDealerTai} taken out – Scores adds it)` : ""}. Winner picked by 門風 ${WIND_CHARS[request.seatWind - 1]}.`,
      },
    });
    onRequestDone();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);

  const undo = () => {
    if (game.events.length === 0) return;
    const i = game.events.length - 1;
    flash(`還原: ${describeEvent(game.events[i], state, i)}`);
    update(undoEvent(game));
  };

  const tools: { label: string; icon: string; onClick: () => void; disabled?: boolean }[] = [
    { label: "新局", icon: "＋", onClick: () => setSheet({ kind: "newGame" }) },
    { label: "還原", icon: "↶", onClick: undo, disabled: game.events.length === 0 },
    { label: "莊家", icon: "莊", onClick: () => setSheet({ kind: "dealer" }) },
    { label: "換人", icon: "⇄", onClick: () => setSheet({ kind: "swap" }) },
    { label: "拉踢", icon: "拉", onClick: () => setSheet({ kind: "lah" }) },
    { label: "結帳", icon: "$", onClick: () => setSheet({ kind: "settle" }) },
    { label: "設定", icon: "⚙", onClick: () => setSheet({ kind: "settings" }) },
  ];

  return (
    <>
      <div className="sc-toolbar">
        {tools.map((t) => (
          <button key={t.label} type="button" onClick={t.onClick} disabled={t.disabled}>
            <span className="sc-tool-icon" aria-hidden="true">
              {t.icon}
            </span>
            {t.label}
          </button>
        ))}
      </div>

      <h2 className="sc-round">
        {state.label}
        {state.streak > 0 && <span className="sc-round-streak">連{state.streak}</span>}
        <span className="sc-round-hand">第{state.hands.length + 1}局</span>
      </h2>
      {state.seatChangeDue && <p className="sc-reminder">執位 – the round has moved on. Re-seat (換人) if you change places.</p>}

      <div className="sc-board">
        {state.seats.map((player, seat) => {
          const total = state.totals[player] ?? 0;
          const holds = state.lahs.filter((l) => l.holder === player);
          return (
            <div key={seat} className={`sc-card-wrap sc-area-${SEAT_AREAS[seat]}`}>
              <button type="button" className={`sc-card sc-c${colorOf(store, player)}`} onClick={() => setSheet({ kind: "card", seat })}>
                <span className="sc-card-name">
                  <span className="sc-card-wind">{WIND_CHARS[(seat - state.dealer + SEATS) % SEATS]}</span>
                  {player}
                </span>
                {seat === state.dealer && (
                  <span className="sc-zhuang">
                    莊{state.streak > 0 && <small>{state.streak}</small>}
                  </span>
                )}
                <span className={`sc-card-total${total < 0 ? " is-neg" : ""}`}>{fmt(total)}</span>
                {state.settings.showLah && holds.length > 0 && (
                  <span className="sc-lah-badges">
                    {holds.map((l) => (
                      <span key={l.pulled} className="sc-lah-badge" title={`${player} 拉 ${l.pulled} ${fmt(l.value)} (${l.count}次)`}>
                        拉{l.pulled} {fmt(l.value)}
                      </span>
                    ))}
                  </span>
                )}
              </button>
              {state.settings.selfDrawKey && (
                <button type="button" className="sc-selfdraw-key" onClick={() => setSheet({ kind: "win", seat, initial: { selfDraw: true, tai: 0, patterns: [] } })}>
                  自摸
                </button>
              )}
            </div>
          );
        })}
        <button type="button" className="sc-draw" onClick={() => setSheet({ kind: "draw" })}>
          流局
        </button>
        {state.settings.jackpot && (
          <button type="button" className="sc-jackpot" onClick={() => state.pot > 0 && setSheet({ kind: "jackpot" })} disabled={state.pot <= 0}>
            <span>Jackpot</span>
            <strong>{fmt(state.pot)}</strong>
          </button>
        )}
      </div>

      <RecentEvents game={game} state={state} store={store} />

      {toast && <div className="sc-toast">{toast}</div>}

      {sheet?.kind === "card" && (
        <Sheet title={state.seats[sheet.seat]} onClose={close}>
          <div className="sc-two">
            <button type="button" className="sc-primary" onClick={() => setSheet({ kind: "win", seat: sheet.seat })}>
              食胡
            </button>
            <button type="button" className="sc-danger" onClick={() => setSheet({ kind: "bonus", seat: sheet.seat })}>
              特別獎罰
            </button>
          </div>
        </Sheet>
      )}
      {sheet?.kind === "win" && (
        <WinSheet
          store={store}
          state={state}
          winnerSeat={sheet.seat}
          initial={sheet.initial}
          onClose={close}
          onDone={(ev) => {
            add(ev);
            flash("Recorded ✓");
          }}
        />
      )}
      {sheet?.kind === "bonus" && <BonusSheet state={state} seat={sheet.seat} onDone={add} onClose={close} />}
      {sheet?.kind === "draw" && (
        <Confirm
          title="流局？"
          detail={state.settings.jackpot && state.settings.jackpotPerDraw > 0 ? `Each player puts ${state.settings.jackpotPerDraw} into the Jackpot.` : undefined}
          onYes={() => add({ t: "draw", at: Date.now() })}
          onClose={close}
        />
      )}
      {sheet?.kind === "dealer" && <DealerSheet store={store} state={state} onDone={add} onClose={close} />}
      {sheet?.kind === "swap" && (
        <SwapSheet
          store={store}
          state={state}
          onClose={close}
          onDone={(seats, newNames) => {
            const roster = withRoster(store, [...seats, ...newNames]);
            update(seats.every((p, i) => p === state.seats[i]) ? game : withEvent(game, { t: "swap", at: Date.now(), seats }), { roster });
            close();
          }}
        />
      )}
      {sheet?.kind === "lah" && <LahSheet state={state} onClose={close} onSurrender={(holder, pulled) => update(withEvent(game, { t: "surrender", at: Date.now(), holder, pulled }))} />}
      {sheet?.kind === "jackpot" && <JackpotSheet store={store} state={state} onDone={add} onClose={close} />}
      {sheet?.kind === "settle" && (
        <SettleSheet
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
          }}
        />
      )}
      {sheet?.kind === "newGame" && (
        <Confirm
          title="新局？"
          detail="This game is saved to History and a new one starts."
          yes="新局"
          onYes={() => {
            close();
            onEndGame();
          }}
          onClose={close}
        />
      )}
    </>
  );
}

function RecentEvents({ game, state, store }: { game: ScoreGame; state: ReplayState; store: ScoreStore }) {
  const rows = state.hands.slice(-5).reverse();
  if (rows.length === 0) return <p className="sc-muted sc-center">Tap a player when they win, or 流局 for a draw.</p>;
  return (
    <div className="card sc-recent">
      {rows.map((h) => (
        <HandRow key={h.eventIndex} h={h} store={store} />
      ))}
      {game.events.length > 0 && <p className="sc-muted sc-small">Latest first · 還原 undoes the last entry</p>}
    </div>
  );
}

function HandRow({ h, store }: { h: ReplayState["hands"][number]; store: ScoreStore }) {
  return (
    <div className="sc-hand-row">
      <span className="sc-hand-no">
        第{h.hand}局
        <small>{h.label}</small>
      </span>
      <span className="sc-hand-what">
        {h.kind === "draw" ? (
          <>流局{h.jackpotFed > 0 && <small> · Jackpot +{fmt(h.jackpotFed)}</small>}</>
        ) : (
          <>
            {h.winners.map((w) => (
              <span key={w.player} className={`sc-name sc-c${colorOf(store, w.player)}`}>
                {w.player}
              </span>
            ))}{" "}
            {h.selfDraw ? "自摸" : `食 ${h.from}`}
            {h.multi > 1 && <small> · {h.multi === 2 ? "雙響" : "三響"}</small>}
            <small>
              {" "}
              · {h.winners.map((w) => `${fmt(w.tai)}番`).join(" / ")}
              {h.pairs.some((p) => p.lahKind === "拉") && " · 拉"}
              {h.pairs.some((p) => p.lahKind === "踢") && " · 踢"}
              {h.fanXue.length > 0 && " · 反雪"}
              {h.jackpotWon && ` · Jackpot ${fmt(h.jackpotWon.amount)}`}
            </small>
          </>
        )}
      </span>
      <span className="sc-hand-deltas">
        {Object.entries(h.deltas)
          .filter(([, d]) => d !== 0)
          .map(([p, d]) => (
            <span key={p} className={d > 0 ? "is-pos" : "is-neg"}>
              {p} {signed(d)}
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
  if (hands === 0) return <p className="sc-muted">No hands yet.</p>;
  const H = Math.round(Math.min(320, Math.max(220, W * 0.62)));
  const pad = { l: 40, r: 56, t: 12, b: 26 };
  const all = series.flatMap((s) => s.values.filter((v): v is number => v !== null));
  const lo = Math.min(0, ...all);
  const hi = Math.max(0, ...all);
  const span = hi - lo || 1;
  const step = niceStep(span / 4);
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
    const px = ((e.clientX - r.left) / r.width) * W;
    const i = Math.round(((px - pad.l) / (W - pad.l - pad.r)) * hands);
    setHover(Math.max(0, Math.min(hands, i)));
  };

  return (
    <div className="sc-chart" ref={setBox}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Running totals over ${hands} hands`}>
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
              s.values[hover] !== null && s.values[hover] !== undefined ? (
                <circle key={s.player} cx={x(hover)} cy={y(s.values[hover] as number)} r={4.5} className={`sc-marker sc-c${colorOf(store, s.player)}`} />
              ) : null
            )}
          </g>
        )}
        <rect x={pad.l} y={0} width={W - pad.l - pad.r} height={H} fill="transparent" onPointerMove={onMove} onPointerDown={onMove} onPointerLeave={() => setHover(null)} />
      </svg>
      {hover !== null && (
        <div className="sc-tooltip" style={{ left: `${(x(hover) / W) * 100}%` }}>
          <strong>{hover === 0 ? "Start" : `第${hover}局`}</strong>
          {series
            .filter((s) => s.values[hover] !== null && s.values[hover] !== undefined)
            .sort((a, b) => (b.values[hover] as number) - (a.values[hover] as number))
            .map((s) => (
              <span key={s.player}>
                <span className={`sc-dot sc-c${colorOf(store, s.player)}`} />
                {s.player} {fmt(s.values[hover] as number)}
              </span>
            ))}
        </div>
      )}
      <div className="sc-legend">
        {series
          .map((s) => ({ s, v: state.totals[s.player] ?? 0 }))
          .sort((a, b) => b.v - a.v)
          .map(({ s, v }) => (
            <span key={s.player} className="sc-legend-chip">
              <span className={`sc-dot sc-c${colorOf(store, s.player)}`} />
              {s.player}
              <strong className={v < 0 ? "is-neg" : "is-pos"}>{signed(v)}</strong>
            </span>
          ))}
      </div>
    </div>
  );
}

function niceStep(raw: number): number {
  if (raw <= 0) return 1;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const n = raw / mag;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * mag;
}

const STAT_ROWS: { key: keyof PlayerStats; label: string; show: (s: PlayerStats) => string }[] = [
  { key: "wins", label: "食胡", show: (s) => String(s.wins) },
  { key: "selfDraws", label: "自摸", show: (s) => String(s.selfDraws) },
  { key: "dealIns", label: "出銃", show: (s) => String(s.dealIns) },
  { key: "bonus", label: "獎罰", show: (s) => signed(s.bonus) },
  { key: "jackpot", label: "彩池", show: (s) => fmt(s.jackpot) },
  { key: "maxTai", label: "最高番數", show: (s) => (s.maxTai ? `${fmt(s.maxTai.value)} (第${s.maxTai.hand}局)` : "–") },
  { key: "avgWinTai", label: "平均食胡番", show: (s) => (s.avgWinTai === null ? "–" : s.avgWinTai.toFixed(1)) },
  { key: "avgDealInTai", label: "平均出銃番", show: (s) => (s.avgDealInTai === null ? "–" : s.avgDealInTai.toFixed(1)) },
  { key: "pulls", label: "拉人", show: (s) => String(s.pulls) },
  { key: "maxPull", label: "最高拉數", show: (s) => (s.maxPull ? `${s.maxPull.count} (${s.maxPull.times}次)` : "–") },
  { key: "pulled", label: "被拉", show: (s) => String(s.pulled) },
  { key: "maxPulled", label: "最高被拉", show: (s) => (s.maxPulled ? `${s.maxPulled.count} (${s.maxPulled.times}次)` : "–") },
  { key: "kicks", label: "踢人", show: (s) => String(s.kicks) },
  { key: "maxKicks", label: "最高踢數", show: (s) => (s.maxKicks ? `${s.maxKicks.count} (${s.maxKicks.times}次)` : "–") },
  { key: "kicked", label: "被踢", show: (s) => String(s.kicked) },
  { key: "maxKicked", label: "最高被踢", show: (s) => (s.maxKicked ? `${s.maxKicked.count} (${s.maxKicked.times}次)` : "–") },
  { key: "multiWins", label: "多響", show: (s) => String(s.multiWins) },
  { key: "fanXue", label: "反雪", show: (s) => String(s.fanXue) },
  { key: "bestHand", label: "最高得分", show: (s) => (s.bestHand ? `${fmt(s.bestHand.value)} (第${s.bestHand.hand}局)` : "–") },
  { key: "worstHand", label: "最高失分", show: (s) => (s.worstHand ? `${fmt(s.worstHand.value)} (第${s.worstHand.hand}局)` : "–") },
  { key: "selfDrawGain", label: "總自摸得分", show: (s) => fmt(s.selfDrawGain) },
  { key: "selfDrawLoss", label: "總自摸失分", show: (s) => fmt(s.selfDrawLoss) },
  { key: "discardGain", label: "總出銃得分", show: (s) => fmt(s.discardGain) },
  { key: "discardLoss", label: "總出銃失分", show: (s) => fmt(s.discardLoss) },
  { key: "winStreak", label: "連勝", show: (s) => String(s.winStreak) },
  { key: "assists", label: "助攻", show: (s) => String(s.assists) },
  { key: "assistRate", label: "助攻率", show: (s) => pct(s.assistRate) },
  { key: "positiveRate", label: "正分率", show: (s) => pct(s.positiveRate) },
  { key: "firstRate", label: "首名率", show: (s) => pct(s.firstRate) },
];

function PlayerCard({ store, stats, index, onIndex }: { store: ScoreStore; stats: PlayerStats[]; index: number; onIndex: (i: number) => void }) {
  const s = stats[index];
  const markFor = useMemo(() => Object.fromEntries(STAT_ROWS.map((r) => [r.key, marks(stats, r.key)])), [stats]);
  return (
    <div className="card sc-player">
      <div className="sc-player-head">
        <button type="button" className="sc-arrow" onClick={() => onIndex((index - 1 + stats.length) % stats.length)} aria-label="Previous player">
          ‹
        </button>
        <div className={`sc-player-name sc-c${colorOf(store, s.player)}`}>
          <span className="sc-dot" />
          {s.player}
          <span className={`sc-player-net${s.net < 0 ? " is-neg" : ""}`}>分數 {fmt(s.net)}</span>
        </div>
        <button type="button" className="sc-arrow" onClick={() => onIndex((index + 1) % stats.length)} aria-label="Next player">
          ›
        </button>
      </div>
      <div className="sc-stat-grid">
        {STAT_ROWS.map((r) => {
          const m = markFor[r.key]?.get(s.player);
          return (
            <div key={r.key} className="sc-stat">
              <span>
                {r.label}
                {m && <span title={m === "best" ? "Best at the table" : "Worst at the table"}>{m === "best" ? " 👑" : " 💀"}</span>}
              </span>
              <strong>{r.show(s)}</strong>
            </div>
          );
        })}
      </div>
      <p className="sc-muted sc-small">{s.hands} 局 played · 👑 best and 💀 worst at the table</p>
    </div>
  );
}

type StatsView = "list" | "trend" | "patterns" | "player" | "history";

function StatsPanel({ store, setStore }: { store: ScoreStore; setStore: (s: ScoreStore) => void }) {
  const games = useMemo(() => [...(store.active ? [store.active] : []), ...store.history], [store]);
  const [gameId, setGameId] = useState<string | null>(null);
  const game = games.find((g) => g.id === gameId) ?? games[0] ?? null;
  const [view, setView] = useState<StatsView>("trend");
  const [playerIndex, setPlayerIndex] = useState(0);
  const state = useMemo(() => (game ? replay(game) : null), [game]);
  const stats = useMemo(() => (game && state ? playerStats(state, game).filter((s) => s.hands > 0) : []), [game, state]);

  if (!game || !state) return <p className="sc-muted sc-center">No games yet – start one on 戰況.</p>;

  const views: { id: StatsView; label: string }[] = [
    { id: "list", label: "≡ 局" },
    { id: "trend", label: "↗ 走勢" },
    { id: "patterns", label: "牌型" },
    { id: "player", label: "玩家" },
    { id: "history", label: "🏆 紀錄" },
  ];

  return (
    <>
      <div className="sc-stats-head">
        <h2 className="sc-h">玩家統計</h2>
        <span className="sc-muted">
          {game === store.active ? "This game" : new Date(game.startedAt).toLocaleDateString()} · 局數 {state.hands.length}
        </span>
      </div>
      <div className="sc-summary">
        {stats
          .slice()
          .sort((a, b) => b.net - a.net)
          .map((s) => (
            <button
              key={s.player}
              type="button"
              className={`sc-summary-card sc-c${colorOf(store, s.player)}`}
              onClick={() => {
                setPlayerIndex(stats.findIndex((x) => x.player === s.player));
                setView("player");
              }}
            >
              <span className="sc-summary-name">
                <span className="sc-dot" />
                {s.player}
                <span className={s.net < 0 ? "is-neg" : "is-pos"}>({fmt(s.net)})</span>
              </span>
              <span className="sc-summary-nums">
                <span>
                  胡<strong>{s.wins + s.selfDraws}</strong>
                </span>
                <span>
                  摸<strong>{s.selfDraws}</strong>
                </span>
                <span>
                  銃<strong>{s.dealIns}</strong>
                </span>
                <span>
                  獎<strong>{fmt(s.bonus)}</strong>
                </span>
              </span>
            </button>
          ))}
      </div>
      <div className="segmented sub-tabs sc-views">
        {views.map((v) => (
          <button key={v.id} type="button" className={view === v.id ? "toggle-on" : undefined} aria-pressed={view === v.id} onClick={() => setView(v.id)}>
            {v.label}
          </button>
        ))}
      </div>

      {view === "list" && (
        <div className="card sc-recent">
          {state.hands.length === 0 && <p className="sc-muted">No hands yet.</p>}
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
            <h3>走勢</h3>
            <span className="sc-pill">{state.hands.length}局</span>
          </div>
          <TrendChart store={store} state={state} />
        </div>
      )}
      {view === "patterns" && <PatternsCard state={state} />}
      {view === "player" && stats.length > 0 && <PlayerCard store={store} stats={stats} index={Math.min(playerIndex, stats.length - 1)} onIndex={setPlayerIndex} />}
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
    </>
  );
}

function PatternsCard({ state }: { state: ReplayState }) {
  const rows = patternCounts(state);
  return (
    <div className="card">
      <div className="sc-card-head">
        <h3>牌型</h3>
      </div>
      {rows.length === 0 ? (
        <p className="sc-muted">Patterns show up here for hands sent from the Scoring tab (Record to Scores).</p>
      ) : (
        <ul className="sc-patterns">
          {rows.map((r) => (
            <li key={r.name}>
              <span>{r.name}</span>
              <span className="sc-muted">
                {Object.entries(r.byPlayer)
                  .map(([p, n]) => `${p} ${n}`)
                  .join(" · ")}
              </span>
              <strong>{r.count}</strong>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function HistoryCard({
  store,
  games,
  current,
  onPick,
  onDelete,
}: {
  store: ScoreStore;
  games: ScoreGame[];
  current: string;
  onPick: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const [confirm, setConfirm] = useState<string | null>(null);
  const career = useMemo(() => careerStats(games), [games]);
  const h2h = useMemo(() => headToHead(games), [games]);
  const names = career.map((c) => c.player);
  return (
    <>
      <div className="card">
        <div className="sc-card-head">
          <h3>紀錄 Games</h3>
        </div>
        {games.map((g) => {
          const st = replay(g);
          const ranked = st.players.filter((p) => st.hands.some((h) => h.seatsAfter.includes(p))).sort((a, b) => (st.totals[b] ?? 0) - (st.totals[a] ?? 0));
          return (
            <div key={g.id} className={`sc-history-row${g.id === current ? " is-current" : ""}`}>
              <button type="button" className="sc-history-main" onClick={() => onPick(g.id)}>
                <span className="sc-history-date">
                  {g === store.active ? "In progress" : new Date(g.startedAt).toLocaleDateString()}
                  <small>{st.hands.length}局</small>
                </span>
                <span className="sc-history-totals">
                  {ranked.map((p, i) => (
                    <span key={p} className={i === 0 ? "sc-strong" : undefined}>
                      {p} {signed(st.totals[p] ?? 0)}
                    </span>
                  ))}
                </span>
              </button>
              {g !== store.active && (
                <button type="button" className={`sc-outline${confirm === g.id ? " is-armed" : ""}`} onClick={() => (confirm === g.id ? onDelete(g.id) : setConfirm(g.id))}>
                  {confirm === g.id ? "Delete?" : "✕"}
                </button>
              )}
            </div>
          );
        })}
      </div>
      <div className="card">
        <div className="sc-card-head">
          <h3>Career</h3>
          <span className="sc-muted">{games.length} games</span>
        </div>
        <div className="sc-table-wrap">
          <table className="sc-table">
            <thead>
              <tr>
                <th>Player</th>
                <th>Games</th>
                <th>Net</th>
                <th>Avg</th>
                <th>1st</th>
                <th>Win%</th>
                <th>銃%</th>
                <th>Best</th>
              </tr>
            </thead>
            <tbody>
              {career.map((c) => (
                <tr key={c.player}>
                  <th>
                    <span className={`sc-dot sc-c${colorOf(store, c.player)}`} />
                    {c.player}
                  </th>
                  <td>{c.games}</td>
                  <td className={c.net < 0 ? "is-neg" : "is-pos"}>{signed(c.net)}</td>
                  <td>{c.avgNet.toFixed(1)}</td>
                  <td>{c.firsts}</td>
                  <td>{pct(c.winRate)}</td>
                  <td>{pct(c.dealInRate)}</td>
                  <td>{c.bestHand === null ? "–" : fmt(c.bestHand)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {names.length > 1 && (
        <div className="card">
          <div className="sc-card-head">
            <h3>Head-to-head</h3>
            <span className="sc-muted">row vs column, net tai</span>
          </div>
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
                    <th>{a}</th>
                    {names.map((b) => {
                      const v = a === b ? null : (h2h[a]?.[b] ?? 0);
                      return (
                        <td key={b} className={v === null ? "sc-muted" : v < 0 ? "is-neg" : v > 0 ? "is-pos" : undefined}>
                          {v === null ? "–" : signed(v)}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
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
  const start = (seats: string[], dealer: number) =>
    setStore({ ...store, roster: withRoster(store, seats), active: newGame(seats, dealer, store.settings) });

  return (
    <section className="panel scores-panel">
      <div className="segmented sub-tabs">
        <button type="button" className={sub === "board" ? "toggle-on" : undefined} aria-pressed={sub === "board"} onClick={() => setSub("board")}>
          戰況
        </button>
        <button type="button" className={sub === "stats" ? "toggle-on" : undefined} aria-pressed={sub === "stats"} onClick={() => setSub("stats")}>
          統計
        </button>
      </div>
      {sub === "board" &&
        (game && state ? (
          <Board store={store} game={game} state={state} update={update} onEndGame={endGame} request={request} onRequestDone={onRequestDone} />
        ) : (
          <>
            {request && <p className="sc-note">Start a game and the hand from Scoring opens to record.</p>}
            <Setup store={store} suggestion={seatNames} onStart={start} />
          </>
        ))}
      {sub === "stats" && <StatsPanel store={store} setStore={setStore} />}
    </section>
  );
}
