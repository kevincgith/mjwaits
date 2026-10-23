// Scores tab: the setup screen and the sheets opened from the board -
// recording a hand, 獎罰 and 詐胡, seats, 拉, Jackpot, the game's details,
// sharing, settling up and 設定.

import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { DEFAULT_SETTINGS, SEATS, previewFanXue, previewWin, half, roundLabel, settle, type PatternNote, type ReplayState, type ScoreEvent, type ScoreGame, type ScoreSettings, type ScoreStore, type WinnerEntry, bonusPresets, type BonusPreset, evenShares, zhaHuKicks } from "@mjwaits/shared/engine/ledger";
import { fullSnapshotOf, fullSnapshotUrl, snapshotOf, snapshotUrl } from "../lib/scoreShare";
import { drawSettleCard } from "../lib/settleImage";
import qrcode from "qrcode-generator";
import { createPortal } from "react-dom";
import { WIND_CHARS, SEAT_AREAS, fmt, signed, colorOf, Icons, SectionHead, Monogram, type SheetFrame, Sheet, Keypad, Toggle, Stepper, NumberField, Segmented, PlayerOption } from "./shared";

// ---- Setup -------------------------------------------------------------------

export function Setup({ store, suggestion, onStart, waitingHand }: { store: ScoreStore; suggestion: readonly string[]; onStart: (seats: string[], dealer: number) => void; waitingHand: boolean }) {
  const last = store.history[0]?.seats;
  // Each row keeps an id, so a drag moves the player (their typing and 莊
  // with them) while the 東南西北 labels stay with the seats.
  const [rows, setRows] = useState(() => (last ?? suggestion).slice(0, SEATS).map((name, id) => ({ id, name: String(name) })));
  const [dealerId, setDealerId] = useState(0);
  const dealer = Math.max(0, rows.findIndex((r) => r.id === dealerId));
  const trimmed = rows.map((r) => r.name.trim());
  const valid = trimmed.every(Boolean) && new Set(trimmed).size === SEATS;

  // Drag to reorder, by the grip: the row follows the finger, and the others
  // slide out of its way as it passes their middle.
  const listRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; startY: number; startIndex: number; rowH: number } | null>(null);
  const [dragging, setDragging] = useState<{ id: number; dy: number } | null>(null);
  const before = useRef<Map<number, number> | null>(null);
  const tops = () => new Map([...(listRef.current?.querySelectorAll<HTMLElement>("[data-row]") ?? [])].map((el) => [Number(el.dataset.row), el.getBoundingClientRect().top]));
  const grip = (id: number) => ({
    onPointerDown: (e: React.PointerEvent<HTMLSpanElement>) => {
      const row = (e.currentTarget as HTMLElement).closest<HTMLElement>("[data-row]");
      if (!row) return;
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      const gap = parseFloat(getComputedStyle(listRef.current!).rowGap) || 0;
      drag.current = { id, startY: e.clientY, startIndex: rows.findIndex((r) => r.id === id), rowH: row.offsetHeight + gap };
      setDragging({ id, dy: 0 });
    },
    onPointerMove: (e: React.PointerEvent<HTMLSpanElement>) => {
      const d = drag.current;
      if (!d) return;
      const dy = e.clientY - d.startY;
      const target = Math.min(SEATS - 1, Math.max(0, d.startIndex + Math.round(dy / d.rowH)));
      setRows((prev) => {
        const from = prev.findIndex((r) => r.id === d.id);
        if (from === target) return prev;
        before.current = tops();
        const next = prev.slice();
        const [moved] = next.splice(from, 1);
        next.splice(target, 0, moved);
        return next;
      });
      setDragging({ id: d.id, dy });
    },
    onPointerUp: () => {
      drag.current = null;
      setDragging(null);
    },
    onPointerCancel: () => {
      drag.current = null;
      setDragging(null);
    },
  });
  // The rows a drag pushed aside glide to their new places.
  useLayoutEffect(() => {
    const was = before.current;
    before.current = null;
    if (!was || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    listRef.current?.querySelectorAll<HTMLElement>("[data-row]").forEach((el) => {
      const id = Number(el.dataset.row);
      if (id === drag.current?.id) return;
      const from = was.get(id);
      const to = el.getBoundingClientRect().top;
      if (from !== undefined && Math.abs(from - to) > 0.5) el.animate([{ transform: `translateY(${from - to}px)` }, { transform: "translateY(0)" }], { duration: 160, easing: "ease-out" });
    });
  }, [rows]);

  return (
    <>
      <SectionHead zh="新局" en="New game" />
      <div className="card sc-setup">
        {waitingHand && <p className="sc-note">Start a game and the hand from Scoring opens to record.</p>}
        <p className="sc-help">Players in turn order, counter-clockwise round the table - drag ⠿ to reorder. Pick who deals first.</p>
        <div ref={listRef} className="sc-setup-list">
          {rows.map((r, i) => {
            const isDragging = dragging?.id === r.id;
            // Under the finger: where the finger is, less where the row now sits.
            const shift = isDragging && drag.current ? dragging.dy - (i - drag.current.startIndex) * drag.current.rowH : 0;
            return (
              <div key={r.id} data-row={r.id} className={`sc-setup-row${isDragging ? " is-dragging" : ""}`} style={isDragging ? { transform: `translateY(${shift}px)` } : undefined}>
                <span className="sc-setup-grip" role="button" aria-label={`Drag ${trimmed[i] || `player ${i + 1}`} to reorder`} {...grip(r.id)}>
                  ⠿
                </span>
                <span className="sc-setup-wind" aria-hidden="true">
                  {WIND_CHARS[(i - dealer + SEATS) % SEATS]}
                </span>
                <input
                  className="sc-input"
                  value={r.name}
                  maxLength={12}
                  autoComplete="off"
                  onChange={(e) => setRows((prev) => prev.map((x) => (x.id === r.id ? { ...x, name: e.target.value } : x)))}
                  aria-label={`Player ${i + 1}`}
                  list="sc-roster"
                />
                <button type="button" className={`sc-dealer-pick${dealer === i ? " is-on" : ""}`} aria-pressed={dealer === i} aria-label={`${trimmed[i] || `Player ${i + 1}`} deals first`} onClick={() => setDealerId(r.id)}>
                  莊
                </button>
              </div>
            );
          })}
        </div>
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
export type HandInitial = {
  selfDraw: boolean;
  tai?: number;
  patterns: PatternNote[];
  note?: string;
  from?: number | null;
  jackpot?: boolean;
  entries?: DraftEntry[];
  patternsFor?: number;
  rules?: string; // patternsFor's hand was scored under custom tai rules
  // Fixing a 特別獎罰 entry: the tab opens as it was recorded.
  bonus?: { kind: "獎" | "罰"; other: number | null; amount: number; name?: string };
  // Fixing a 詐胡 entry: each player's amount as recorded.
  zhaHu?: { player: string; amount: number }[];
};

// The 胡 sheet's views: 食胡, 特別獎罰, and 詐胡 - part of the 食胡 tab, opened
// from its foot when it's switched on in 設定.
export type HandMode = "win" | "bonus" | "zhaHu";

export type DraftEntry = { seat: number; tai: string };

// What the 食胡 sheet hands over when asking Scoring to work a hand out:
// `target` is the winner being scored, `entries` the whole draft.
export type ScoreHandAsk = { from: number | null; jackpot: boolean; scan: boolean; target: number; entries: DraftEntry[]; zhaHu?: { player: string; amount: number }[] };

export function HandSheet({
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

export function ModeTabs({ mode, onWin, onBonus }: { mode: HandMode; onWin?: () => void; onBonus?: () => void }) {
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

export function WinSheet({
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
    ...(e.seat === patternsFor && initial?.patterns.length ? { patterns: initial.patterns, ...(initial.rules ? { rules: initial.rules } : {}) } : {}),
  }));
  const fromValid = from === null ? multi === 1 : from >= 0;
  // Every winner needs a tai above 0.
  const complete = fromValid && entries.every((e) => Number(e.tai) > 0);
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
        {/* Fixed width, as on 特別獎罰 and 詐胡, so the field sits in the same place on every tab. */}
        <span className="sc-label sc-label-fixed">番 Tai</span>
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
      <Keypad
        max={state.settings.scoreCap}
        value={entries[focus]?.tai ?? ""}
        onChange={(v) => {
          setEntries((prev) => prev.map((e, i) => (i === focus ? { ...e, tai: v } : e)));
          // Tai typed before anyone's picked: take it as 自摸 (one winner), saving
          // a tap - a tap on whoever dealt in still turns it into 食胡.
          if (v && from === -1 && multi === 1) setFrom(null);
        }}
      />

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
export interface PayCol {
  key: string;
  label: string;
  wide?: boolean; // holds a name rather than a number
}

export interface PayRow {
  who: string;
  cells: Record<string, ReactNode>;
  total: number;
  high?: boolean;
}

// 詐胡: a called win that wasn't. Laid out like a 三響 on the 食胡 tab - the
// caller in the 胡 seat, an amount field for each of the other three (the 設定
// amount to start with, retyped from the keypad), and who pays whom below.
export function ZhaHuSheet({
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
  const each = state.settings.zhaHu ?? DEFAULT_SETTINGS.zhaHu ?? 40;
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
        <span className="sc-label sc-label-fixed">金額</span>
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

export function PayTable({ cols, rows, empty, highTitle }: { cols: PayCol[]; rows: PayRow[]; empty: ReactNode; highTitle?: string }) {
  return (
    <div className="sc-paytable" aria-live="polite">
      {rows.length === 0 ? (
        typeof empty === "string" ? <p className="sc-paytable-empty">{empty}</p> : empty
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

export function BonusSheet({
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
  // A 預設獎罰 picked (花, 暗槓…): its name goes on the entry, until the
  // amount or its way is changed by hand.
  const [preset, setPreset] = useState<string | null>(initial?.name ?? null);
  const presets = bonusPresets(state.settings);
  // A one-player pick (7搶1, 1搶7) waits for who: Confirm stays off till then.
  const [needsOne, setNeedsOne] = useState(false);
  // The quick picks in pages of eight (two rows of four), in bonusPresets'
  // order - each swipe lands on a whole page, with a sliver of the other
  // peeking in at the edge - so the box never grows.
  const shown = presets;
  const n = Number(amount || 0);
  const pick = (p: BonusPreset) => {
    setKind(p.kind);
    setOther(null);
    setAmount(String(p.amount));
    setPreset(p.name);
    setNeedsOne(p.one === true);
  };
  const waiting = needsOne && other === null;
  return (
    <Sheet
      title={
        <span className="sc-sheet-who">
          <Monogram store={store} player={player} />
          {player}
          <span className={`sc-sheet-verb${kind === "罰" ? " is-penalty" : ""}`}>{preset ?? `特別${kind}`}</span>
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
            disabled={n <= 0 || waiting}
            onClick={() => onDone({ t: "bonus", at: Date.now(), seat, amount: n, kind, ...(other !== null ? { other } : {}), ...(preset ? { name: preset } : {}) })}
          >
            {waiting ? (kind === "獎" ? "Tap who pays" : "Tap who's paid") : "Confirm"}
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
          center={{
            label: "全",
            sub: "Everyone",
            on: other === null && !needsOne,
            onPick: () => {
              setOther(null);
              // Everyone, by hand: not the one-player pick any more.
              if (needsOne) {
                setNeedsOne(false);
                setPreset(null);
              }
            },
            tone: kind === "罰" ? "lose" : "win",
          }}
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
              onClick={() => {
                if (k !== kind) {
                  setPreset(null);
                  setNeedsOne(false);
                }
                setKind(k);
              }}
            >
              {k}
            </button>
          ))}
        </span>
      </div>
      <Keypad
        max={state.settings.scoreCap}
        value={amount}
        onChange={(v) => {
          setAmount(v);
          setPreset(null);
          setNeedsOne(false);
        }}
      />
      {/* Who pays whom, in the same table as 食胡 - and the same size. Empty,
          it holds the 預設獎罰 quick picks instead, so they take no room. */}
      <PayTable
        cols={[{ key: "to", label: "To", wide: true }]}
        rows={
          n <= 0 || waiting
            ? []
            : (other === null ? state.seats.map((_, s2) => s2).filter((s2) => s2 !== seat) : [other]).map((s2) =>
                kind === "獎"
                  ? { who: state.seats[s2], cells: { to: player }, total: n }
                  : { who: player, cells: { to: state.seats[s2] }, total: n },
              )
        }
        empty={
          waiting ? (
            `${preset} - tap who ${kind === "獎" ? "pays" : "is paid"}, above`
          ) : presets.length > 0 ? (
            <div className={`sc-presets${shown.length > 8 ? " is-paged" : ""}`} role="group" aria-label="預設獎罰">
              {/* Four columns to a screenful, read across a row then down:
                  a tile's place is worked out, so the strip still reads 花 草
                  花草 … left to right however far it scrolls. */}
              {shown.map((p, i) => (
                <button
                  key={i}
                  type="button"
                  className={`sc-preset is-${p.kind === "獎" ? "reward" : "penalty"}${i % 8 === 0 ? " is-page" : ""}`}
                  style={{ gridRow: Math.floor((i % 8) / 4) + 1, gridColumn: Math.floor(i / 8) * 4 + (i % 4) + 1 }}
                  onClick={() => pick(p)}
                >
                  <strong>{p.name}</strong>
                  <span>
                    {p.kind === "獎" ? "+" : "−"}
                    {fmt(p.amount)}
                  </span>
                </button>
              ))}
            </div>
          ) : (
            "Enter an amount to see who pays what"
          )
        }
      />
    </Sheet>
  );
}

// ---- The other sheets --------------------------------------------------------

// Pick a player by where they sit: the four seats as on the board (seat 0
// along the bottom, then right, top, left), with an optional button in the
// middle of the table (自摸 / Everyone). `self` is the seat the sheet is about
// - shown, marked, not pickable.
export function TablePicker({
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
export function SeatDiamond({ children }: { children: (seat: number) => ReactNode }) {
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
export function RoundOption({ verb, label }: { verb: string; label: string }) {
  return (
    <span className="sc-round-option">
      <span>{verb}</span>
      <small>{label}</small>
    </span>
  );
}

// How long 座位's cards take to slide to new seats - the 莊 badge and the
// 起莊 corner fly on the same clock when they move with them.
export const SEAT_MOVE_MS = 800;
// ...and how much a card shrinks while it's lifted - the shadow does most of the lift.
export const SEAT_DIP = 0.08;

export function SeatsSheet({
  store,
  state,
  onDone,
  onClose,
  onOpenSeating,
  proposal,
}: {
  store: ScoreStore;
  state: ReplayState;
  onDone: (change: { seats: string[] | null; newNames: string[]; removedNames: string[]; dealer: ScoreEvent | null }) => void;
  onClose: () => void;
  onOpenSeating?: () => void;
  // The seat ceremony's result: the cards slide there once the sheet is up,
  // 東 becomes 莊 at 連0 and the round resets - all still to Confirm.
  proposal?: { seats: string[]; east: string };
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
  // Cards caught mid-slide by the next move, and how lifted they were (0-1).
  const midSlide = useRef<Map<string, number>>(new Map());
  const spots = () => {
    const map = new Map<string, DOMRect>();
    diamondRef.current?.querySelectorAll<HTMLElement>("[data-player]").forEach((el) => map.set(el.dataset.player!, el.getBoundingClientRect()));
    return map;
  };
  const moveSeats = (change: (prev: string[]) => string[]) => {
    // Where everything is on screen right now - mid-slide too, when taps come
    // fast - so the next slide starts from there, not from where the last one
    // was headed. A card caught mid-slide also keeps how lifted it was.
    before.current = spots();
    const lift = new Map<string, number>();
    diamondRef.current?.querySelectorAll<HTMLElement>("[data-player]").forEach((el) => {
      if (el.getAnimations().length === 0) return;
      const scale = new DOMMatrixReadOnly(getComputedStyle(el).transform).a;
      lift.set(el.dataset.player!, Math.min(1, Math.max(0, (1 - scale) / SEAT_DIP)));
    });
    midSlide.current = lift;
    qiFrom.current = qiSpot();
    setPicked(null);
    setSeats(change);
  };
  // A move on top of a move: the slides still running are dropped (their
  // start points are already noted above), so the new ones - and the 莊 and
  // 起莊 marks measured next - work from the cards' real seats.
  useLayoutEffect(() => {
    if (!before.current) return;
    diamondRef.current?.querySelectorAll<HTMLElement>("[data-player]").forEach((el) => el.getAnimations().forEach((a) => a.cancel()));
  }, [seats]);
  // 起莊's corner belongs to a seat, not a player. When the card that had it
  // slides to its new seat (a rotation, say), it simply rides along on that
  // card. Otherwise it flies there on its own (a copy, above the sheet, on the
  // 莊 badge's arc) rather than arriving on some other card - and when its seat
  // doesn't change but another player slides in, the copy holds still there
  // while they do. Measured against the map, before the cards start sliding
  // (so this runs first).
  const lastQi = useRef<{ seat: number; player: string; x: number; y: number } | null>(null);
  // The corner as it is on screen at the moment of a move (its copy, if one
  // is in flight), against the map.
  // scale: a copy caught in flight, and how big it was then.
  const qiFrom = useRef<{ x: number; y: number; scale?: number } | null>(null);
  const qiSpot = () => {
    const map = diamondRef.current;
    const flying = [...document.body.children].find((el) => el.classList.contains("sc-qi-corner")) as HTMLElement | undefined;
    const corner = flying ?? map?.querySelector<HTMLElement>(".sc-qi-corner");
    if (!map || !corner) return null;
    const box = map.getBoundingClientRect();
    const r = corner.getBoundingClientRect();
    // getBoundingClientRect is the scaled box; the copy is placed by its
    // unscaled top-left, so take the scale back out around its centre.
    const scale = flying ? new DOMMatrixReadOnly(getComputedStyle(flying).transform).a : 1;
    const w = r.width / scale;
    const h = r.height / scale;
    return { x: r.left + (r.width - w) / 2 - box.left, y: r.top + (r.height - h) / 2 - box.top, ...(flying ? { scale } : {}) };
  };
  const lastSeats = useRef(seats.join("|"));
  // The copy in flight - a later render mustn't cut it short, only a new move.
  const qiFlight = useRef<(() => void) | null>(null);
  useEffect(() => () => qiFlight.current?.(), []);
  useLayoutEffect(() => {
    const map = diamondRef.current;
    const corner = map?.querySelector<HTMLElement>(".sc-qi-corner");
    const card = corner?.closest<HTMLElement>("[data-player]");
    const prev = lastQi.current;
    const from = qiFrom.current;
    qiFrom.current = null;
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
    // Riding its card - unless its copy is still in the air from the last
    // move, which then carries on to the new spot rather than landing on the
    // old one first.
    if (prev.seat !== now.seat && seatsMoved && prev.player === now.player && from?.scale === undefined) return;
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
    const dx = (from ?? prev).x - now.x;
    const dy = (from ?? prev).y - now.y;
    const lift = -Math.min(48, Math.hypot(dx, dy) / 4);
    const frames: Keyframe[] = [];
    // A copy caught in flight carries on from where it is and as big as it
    // is, settling straight in - no second take-off.
    const s0 = from?.scale;
    for (let i = 0; i <= 20; i++) {
      const t = i / 20;
      if (s0 !== undefined) {
        const e = 1 - Math.pow(1 - t, 3);
        frames.push({ offset: t, transform: `translate(${dx * (1 - e)}px, ${dy * (1 - e)}px) scale(${s0 + (1 - s0) * e})` });
        continue;
      }
      const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      const rise = hold ? 0 : Math.sin(Math.PI * e);
      frames.push({ offset: t, transform: `translate(${dx * (1 - e)}px, ${dy * (1 - e) + lift * rise}px) scale(${1 + 0.25 * rise})` });
    }
    qiFlight.current?.();
    // Alongside the cards when they move too, so all of it lands together.
    const flight = flyer.animate(frames, { duration: seatsMoved ? SEAT_MOVE_MS : 600, easing: "linear" });
    corner.style.visibility = "hidden";
    const land = () => {
      flyer.remove();
      corner.style.visibility = "";
      if (qiFlight.current === land) qiFlight.current = null;
    };
    qiFlight.current = land;
    flight.finished.then(land, land);
  });
  // A new 莊: the badge flies from the old dealer's seat to the new one (a
  // copy of it, above the sheet, so no card clips it) and lands with a pop.
  // Measured where it ends up before the cards start sliding (so this runs
  // ahead of them), and in step with them when they move too - start state
  // to end state, every piece on the same clock.
  const badgeFrom = useRef<DOMRect | null>(null);
  useLayoutEffect(() => {
    const from = badgeFrom.current;
    badgeFrom.current = null;
    const cardsMoving = before.current !== null;
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
    const flight = flyer.animate(frames, { duration: cardsMoving ? SEAT_MOVE_MS : 600, easing: "linear" });
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
    const caught = midSlide.current;
    midSlide.current = new Map();
    paths.forEach(({ el, a0, turn, r0, r1, tx, ty }) => {
      // Mirror-image lanes: one bows out exactly as far as the other bows in.
      const lane = bothWays ? (turn > 0 ? 0.25 : -0.25) : 0;
      // Caught mid-slide: no pick-up pause - it stays up, already moving,
      // and eases into the new path from where it was.
      const lift0 = caught.get(el.dataset.player!);
      const frames: Keyframe[] = [];
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        // Pick up, move, set down: the card shrinks and lifts in the first
        // quarter, travels (smoothly, eased) mostly in the middle while
        // small, and grows back as it lands.
        const ease = (u: number) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);
        const easeOut = (u: number) => 1 - Math.pow(1 - u, 3);
        const e = lift0 === undefined ? ease(Math.min(1, Math.max(0, (t - 0.15) / 0.7))) : easeOut(Math.min(1, t / 0.85));
        const lifted =
          lift0 === undefined
            ? ease(Math.min(1, t / 0.25, (1 - t) / 0.25))
            : t < 0.75
              ? lift0 + (1 - lift0) * ease(Math.min(1, t / 0.2))
              : ease((1 - t) / 0.25);
        const bump = Math.sin(Math.PI * e);
        const angle = a0 + turn * e;
        const r = (r0 + (r1 - r0) * e) * (1 + lane * bump);
        const x = Math.cos(angle) * r * rx - tx;
        const y = Math.sin(angle) * r * ry - ty;
        frames.push({
          offset: t,
          transform: `translate(${x}px, ${y}px) scale(${1 - SEAT_DIP * lifted})`,
          boxShadow: `0 ${10 * lifted}px ${26 * lifted}px rgba(0, 0, 0, ${0.2 * lifted})`,
          zIndex: turn > 0 ? 2 : 1,
        });
      }
      el.animate(frames, { duration: SEAT_MOVE_MS, easing: "linear" });
    });
  }, [seats]);


  // From the seat ceremony: once the sheet has slid up, everyone slides to
  // the seat they drew and the 莊 badge flies to 東 - a new 東風東局 at 連0.
  useEffect(() => {
    if (!proposal) return;
    const timer = window.setTimeout(() => {
      roundTouched.current = true;
      setRound("reset");
      setStreak(0);
      if (proposal.east !== dealerName) {
        badgeFrom.current = diamondRef.current?.querySelector(".sc-zhuang")?.getBoundingClientRect() ?? null;
        setDealerName(proposal.east);
      }
      if (proposal.seats.some((p, i) => p !== seats[i])) moveSeats(() => proposal.seats.slice());
    }, 380);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
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
      // Always two lines tall, so the sheet doesn't jump as the hint changes.
      subtitle={
        <span className="sc-seats-hint">
          {benchPick !== null
            ? `Now tap the seat ${benchPick} takes`
            : picked !== null
              ? `Now tap another seat, or a 候補 player, for ${seats[picked]}'s place`
              : proposal
                ? "From the seat ceremony · Confirm to use it"
                : "Tap a seat to move or replace that player · hold one for 莊"}
        </span>
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

export function LahSheet({
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

export function JackpotSheet({
  store,
  state,
  initial,
  onDone,
  onClose,
}: {
  store: ScoreStore;
  state: ReplayState;
  initial?: { mode: "out" | "in"; shares: { player: string; amount: number }[] }; // fixing an older entry: as recorded
  onDone: (ev: ScoreEvent) => void;
  onClose: () => void;
}) {
  // Hand the pot out, or pay into it. An empty pot can only be paid into.
  const [mode, setMode] = useState<"out" | "in">(initial?.mode ?? (state.pot > 0 ? "out" : "in"));
  const [shares, setShares] = useState<number[]>(() => state.seats.map((p) => initial?.shares.find((x) => x.player === p)?.amount ?? 0));
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
export function ClearableInput({
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

export type GameLabel = { name: string; startedAt: number; startTime: string; endTime: string; location: string };

export function NameSheet({ initial, onSave, onClose }: { initial: GameLabel; onSave: (label: GameLabel) => void; onClose: () => void }) {
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
export function ShareLinkSheet({ store, game, onClose }: { store: ScoreStore; game: ScoreGame; onClose: () => void }) {
  // The whole game (so the other phone gets the Stats views too), compressed;
  // the totals-only link until that's ready, or where it can't be made.
  const totals = useMemo(() => snapshotUrl(snapshotOf(store, game)), [store, game]);
  const [url, setUrl] = useState(totals);
  useEffect(() => {
    let live = true;
    void fullSnapshotUrl(fullSnapshotOf(store, game)).then((u) => live && setUrl(u));
    return () => {
      live = false;
    };
  }, [store, game]);
  // A QR code holds about 2.9k characters: a game too long for that gets the
  // totals in its QR, the whole game still going by Copy / Share.
  const qrOf = (text: string) => {
    const qr = qrcode(0, "L");
    qr.addData(text);
    qr.make();
    return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  };
  const { svg, qrFull } = useMemo(() => {
    try {
      return { svg: qrOf(url), qrFull: true };
    } catch {
      return { svg: qrOf(totals), qrFull: false };
    }
  }, [url, totals]);
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
      <p className="sc-help sc-help-block">
        {qrFull
          ? "Scan to see the scores and stats on another phone. It won't update by itself - share again for the latest."
          : "This game is too long for a QR code's stats - scanning shows the scores; Copy or Share the link for the stats too."}
      </p>
    </Sheet>
  );
}

export function SettleSheet({
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

export const SETTING_GROUPS: { title: string; rows: { key: keyof ScoreSettings; label: string; help?: string; kind: "number" | "bool" | "nullable" | "round"; needs?: keyof ScoreSettings }[] }[] = [
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
    title: "特別獎罰 Bonuses",
    rows: [
      { key: "bonusPresets", label: "預設獎罰", help: "Quick picks on the 特別獎罰 tab", kind: "bool" },
      { key: "presetFlower", label: "花", help: "Receive from each player", kind: "number", needs: "bonusPresets" },
      { key: "presetGrass", label: "草", help: "Receive from each player", kind: "number", needs: "bonusPresets" },
      { key: "presetBoth", label: "花草", help: "Receive from each player", kind: "number", needs: "bonusPresets" },
      { key: "presetKong", label: "暗槓", help: "Receive from each player", kind: "number", needs: "bonusPresets" },
      { key: "presetSnake", label: "蛇骰", help: "Pay each player", kind: "number", needs: "bonusPresets" },
      { key: "presetTriple", label: "圍骰", help: "Receive from each player", kind: "number", needs: "bonusPresets" },
      { key: "presetChase", label: "追", help: "Receive from each player - the first", kind: "number", needs: "bonusPresets" },
      { key: "presetChaseBig", label: "追", help: "Receive from each player - the second", kind: "number", needs: "bonusPresets" },
      { key: "presetWrongCall", label: "嗌錯", help: "Pay each player", kind: "number", needs: "bonusPresets" },
      { key: "presetSevenOne", label: "7搶1", help: "Receive from one player", kind: "number", needs: "bonusPresets" },
      { key: "presetOneSeven", label: "1搶7", help: "Receive from one player", kind: "number", needs: "bonusPresets" },
      { key: "presetEightImmortals", label: "八仙過海", help: "Receive from each player", kind: "number", needs: "bonusPresets" },
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

export function SettingsSheet({ settings, onSave, onClose }: { settings: ScoreSettings; onSave: (s: ScoreSettings) => void; onClose: () => void }) {
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
                      <Toggle checked={value !== null} onChange={(v) => set(key, (v ? DEFAULT_SETTINGS[key] ?? 50 : null) as never)} label={label} />
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
                          value={value ?? (DEFAULT_SETTINGS[key] as number)}
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

export function Confirm({ title, detail, onYes, onClose, yes = "Confirm", danger }: { title: string; detail?: string; onYes: () => void; onClose: () => void; yes?: string; danger?: boolean }) {
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
