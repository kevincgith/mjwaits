// Scores tab: the board (戰況) - the seats and totals, the 籌碼 card, the
// recent entries, and the sheets it opens.

import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { DEFAULT_SETTINGS, SEATS, previewWin, canRedo, redoEvent, replay, deleteEvent, replaceEvent, undoEvent, stepAt, handAt, withEvent, withEvents, type HandResult, type ReplayState, type ScoreEvent, type ScoreGame, type ScoreStore, chipMoves, playTimes } from "@mjwaits/shared/engine/ledger";
import { changeKind, provisionalEast } from "../lib/scoreViews";
import { WIND_CHARS, SEAT_AREAS, facing, FIT_MIN, FIT_GAP, type RecordRequest, type ScoreHandRequest, type SeatingResult, fmt, signed, tone, colorOf, Icons, Monogram, Sheet, withRoster } from "./shared";
import { type HandInitial, type HandMode, HandSheet, SeatsSheet, LahSheet, JackpotSheet, NameSheet, SettleSheet, SettingsSheet, Confirm } from "./sheets";
import { readBackedUpAt, saveBackupFile, handsSinceBackup, FOOTER_KEY_SEEN, BACKUP_NUDGE_HANDS } from "./stats";

// ---- The board (戰況) -----------------------------------------------------------

export type BoardSheet =
  // editIndex: correcting that older entry from 最近, not recording a new one.
  | { kind: "hand"; seat: number; initial?: HandInitial; mode?: HandMode; editIndex?: number }
  | { kind: "entry"; index: number }
  | { kind: "recent" }
  | { kind: "draw" }
  | { kind: "seats"; proposal?: { seats: string[]; east: string } } // proposal: from the seat ceremony
  | { kind: "name" }
  | { kind: "lah" }
  | { kind: "jackpot"; editIndex?: number; initial?: { mode: "out" | "in"; shares: { player: string; amount: number }[] } } // editIndex: fixing that older entry
  | { kind: "settle" }
  | { kind: "settings" }
;

// 籌碼提示: the chips to hand over for each change (see chipMoves) - a new
// entry, or an undo / redo / fix / delete, which hands back the difference.
// Stays up until dismissed or the next change that moves chips replaces it.
export function useChipMoves(game: ScoreGame, state: ReplayState) {
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
    const { kind, surrenders: surrendered } = changeKind(prev.events, game.events);
    if (!surrendered) surrenders.current = null;
    else if (!surrenders.current) surrenders.current = prev.state;
    const list = chipMoves(surrendered ? surrenders.current! : prev.state, state);
    if (list.length === 0) return;
    setMoves({ at: Date.now(), verb: kind === "added" ? (surrendered ? "投降" : "") : kind === "undone" ? "還原" : "改正", list });
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
export function AutoHide({ seconds, onHide, children }: { seconds: number | null; onHide: () => void; children: ReactNode }) {
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

export function ChipsCard({ verb, list, autoHide, onDone }: { verb: string; list: { from: string; to: string; amount: number }[]; autoHide: number | null; onDone: () => void }) {
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
    // Too wide: the card overflows, or a receiver's name doesn't fit its column.
    const tooWide = grid.scrollWidth > grid.clientWidth + 1 || [...grid.querySelectorAll(".sc-chips-to")].some((el) => el.scrollWidth > el.clientWidth + 1);
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
export function EventRow({ ev, deltas }: { ev: ScoreEvent; deltas: Record<string, number> }) {
  const label =
    ev.t === "bonus"
      ? `${ev.name ?? `特別${ev.kind}`} · ${fmt(ev.amount)}${ev.other === undefined ? " each" : ""}`
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

export function RecentSheet({
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
        const h = handAt(state, i);
        if (h) row = <HandRow h={h} store={store} />;
      } else {
        const step = stepAt(state, i);
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
export function winInitial(ev: Extract<ScoreEvent, { t: "win" }>): HandInitial {
  const first = ev.winners[0];
  const base = { from: ev.from, jackpot: ev.jackpotTo !== undefined, patterns: first.patterns ?? [], patternsFor: first.seat, rules: first.rules };
  return ev.winners.length > 1
    ? { ...base, selfDraw: false, entries: ev.winners.map((w) => ({ seat: w.seat, tai: String(w.tai) })) }
    : { ...base, selfDraw: ev.from === null, tai: first.tai };
}

// One entry picked in 最近: fix it (a hand) or delete it. Delete takes a
// second tap; either way everything after it replays.
export function EntrySheet({ label, canEdit, onEdit, onDelete, onClose }: { label: string; canEdit: boolean; onEdit: () => void; onDelete: () => void; onClose: () => void }) {
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

export function describeEvent(ev: ScoreEvent, state: ReplayState, i: number): string {
  if (ev.t === "win" || ev.t === "draw") {
    const h = handAt(state, i);
    if (!h) return "";
    if (h.kind === "draw") return `第${h.hand}局 流局`;
    return `第${h.hand}局 ${h.winners.map((w) => w.player).join("、")} ${h.selfDraw ? "自摸" : `食 ${h.from}`}`;
  }
  if (ev.t === "bonus") {
    const step = stepAt(state, i);
    const me = Object.entries(step?.deltas ?? {}).find(([, d]) => (ev.kind === "獎" ? d > 0 : d < 0))?.[0];
    return `${me ?? ""} ${ev.name ?? `特別${ev.kind}`} ${fmt(ev.amount)}`.trim();
  }
  if (ev.t === "surrender") return `${ev.pulled} 投降`;
  if (ev.t === "jackpot") return "Jackpot handed out";
  if (ev.t === "jackpotIn") return "Paid into the Jackpot";
  if (ev.t === "zhaHu") return `${state.seats[ev.seat] ?? ""} 詐胡 ${fmt(ev.pays.reduce((t, x) => t + x.amount, 0))}`.trim();
  if (ev.t === "swap") return "換人";
  if (ev.t === "dealer") return "莊家設定";
  return "設定";
}

export function Board({
  store,
  game,
  state,
  update,
  onEndGame,
  request,
  onRequestDone,
  onScoreHand,
  onOpenSeating,
  seatingResult,
  onSeatingResultDone,
  live,
  recorder = false,
}: {
  store: ScoreStore;
  game: ScoreGame;
  state: ReplayState;
  update: (game: ScoreGame, extra?: Partial<ScoreStore>) => void;
  onEndGame: () => void;
  request: RecordRequest | null;
  onRequestDone: () => void;
  onScoreHand?: (req: Omit<ScoreHandRequest, "nonce">) => void;
  onOpenSeating?: (names: string[], east: number | null) => void;
  seatingResult: SeatingResult | null;
  onSeatingResultDone?: () => void;
  // 線上: the host's button for sharing this game live (on: it is).
  live?: { on: boolean; onOpen: () => void };
  // Recording into someone else's live game: ending it (新局) is theirs.
  recorder?: boolean;
}) {
  const [sheet, setSheet] = useState<BoardSheet | null>(null);
  // Back from the seat ceremony: 座位 opens with its seating, to confirm.
  useEffect(() => {
    if (!seatingResult) return;
    // Only the same four players - the bench may have changed meanwhile.
    const same = seatingResult.seats.length === SEATS && seatingResult.seats.every((p) => state.seats.includes(p));
    if (same) setSheet({ kind: "seats", proposal: { seats: seatingResult.seats, east: seatingResult.east } });
    onSeatingResultDone?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seatingResult]);
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
    () =>
      (sheet?.kind === "hand" || sheet?.kind === "jackpot") && sheet.editIndex !== undefined ? replay({ ...game, events: game.events.slice(0, sheet.editIndex) }) : state,
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
    const rulesNote = request.rules ? " · scored under custom tai rules" : "";
    // A 雙響/三響: the sheet comes back whole, with only the scored winner's
    // tai (and patterns) new. Who dealt in stands - one discard, several
    // winners, so Scoring's 自摸 doesn't apply.
    // A 詐胡: back to it, each player's amount now what the hand would pay
    // them off their own discard (not 拉 - nothing was won), never under
    // the 設定 amount. Cancelled: the amounts as they were.
    if (request.zhaHu && request.seat !== undefined) {
      const caller = request.seat;
      const floor = state.settings.zhaHu ?? DEFAULT_SETTINGS.zhaHu ?? 40;
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
          rules: request.reopenOnly ? undefined : request.rules,
          from: request.from ?? -1,
          jackpot: request.jackpot,
          entries: request.reopenOnly ? draft.entries : draft.entries.map((e) => (e.seat === scored ? { ...e, tai: String(request.tai) } : e)),
          patternsFor: scored,
          ...(request.reopenOnly ? {} : { note: `From Scoring: ${state.seats[scored]} ${request.tai} tai${dealerNote}${rulesNote}.` }),
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
        rules: request.rules,
        // Scoring has the last word on 自摸; who dealt in carries over otherwise.
        ...(request.seat !== undefined ? { from: request.selfDraw ? null : request.from === null || request.from === undefined ? -1 : request.from, jackpot: request.jackpot } : {}),
        note:
          request.seat !== undefined
            ? `From Scoring: ${request.tai} tai${dealerNote}${rulesNote}.`
            : `From Scoring: ${request.tai} tai${dealerNote}${rulesNote}. Winner picked by 門風 ${WIND_CHARS[request.seatWind - 1]}.`,
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

  const tools: { label: string; icon: ReactNode; onClick: () => void; disabled?: boolean; badge?: number; on?: boolean }[] = [
    ...(recorder ? [] : [{ label: "新局", icon: Icons.newGame, onClick: () => setSheet({ kind: "settle" }) }]),
    { label: "還原", icon: Icons.undo, onClick: () => undo(), disabled: game.events.length === 0 },
    { label: "重做", icon: Icons.redo, onClick: () => redo(), disabled: !canRedo(game) },
    { label: "座位", icon: Icons.seat, onClick: () => setSheet({ kind: "seats" }) },
    { label: "拉踢", icon: Icons.lah, onClick: () => setSheet({ kind: "lah" }), badge: state.lahs.length || undefined },
    { label: "最近", icon: Icons.recent, onClick: () => setSheet({ kind: "recent" }) },
    { label: "設定", icon: Icons.settings, onClick: () => setSheet({ kind: "settings" }) },
    ...(live ? [{ label: "線上", icon: Icons.live, onClick: live.onOpen, on: live.on }] : []),
  ];

  return (
    <>
      <div className="sc-fit" ref={fitRef} style={fitHeight !== null ? { height: fitHeight } : undefined}>
      {/* The game actions. Where the game is sits in the table's corner. */}
      <div className="sc-toolbar">
        <div className="sc-tools" role="toolbar" aria-label="Game actions" style={{ gridTemplateColumns: `repeat(${tools.length}, minmax(0, 1fr))` }}>
          {tools.map((t) => (
            <button key={t.label} type="button" onClick={t.onClick} disabled={t.disabled} className={t.on ? "is-on" : undefined} aria-pressed={t.on}>
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
          <span className="sc-status-meta sc-status-wrap">
            <span>局{state.hands.length + 1}</span>
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
          <span className="sc-toast-text">{toast.text}</span>
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
            if (sheet.editIndex === undefined) return add(ev, ev.t === "bonus" ? `Recorded ${ev.name ?? `特別${ev.kind}`}` : ev.t === "zhaHu" ? "Recorded 詐胡" : "Recorded ✓");
            update(replaceEvent(game, sheet.editIndex, ev));
            close();
            flash("Entry fixed - later hands updated");
          }}
        />
      )}
      {sheet?.kind === "entry" && (
        <EntrySheet
          label={describeEvent(game.events[sheet.index], state, sheet.index)}
          canEdit={["win", "bonus", "zhaHu", "jackpot", "jackpotIn"].includes(game.events[sheet.index]?.t ?? "")}
          onEdit={() => {
            const ev = game.events[sheet.index];
            if (ev?.t === "win") setSheet({ kind: "hand", seat: ev.winners[0].seat, initial: winInitial(ev), editIndex: sheet.index });
            if (ev?.t === "bonus")
              setSheet({
                kind: "hand",
                seat: ev.seat,
                mode: "bonus",
                initial: { selfDraw: false, patterns: [], bonus: { kind: ev.kind, other: ev.other ?? null, amount: ev.amount, ...(ev.name ? { name: ev.name } : {}) } },
                editIndex: sheet.index,
              });
            if (ev?.t === "zhaHu")
              setSheet({ kind: "hand", seat: ev.seat, mode: "zhaHu", initial: { selfDraw: false, patterns: [], zhaHu: ev.pays }, editIndex: sheet.index });
            if (ev?.t === "jackpot" || ev?.t === "jackpotIn")
              setSheet({ kind: "jackpot", editIndex: sheet.index, initial: { mode: ev.t === "jackpot" ? "out" : "in", shares: ev.shares } });
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
          proposal={sheet.proposal}
          onClose={close}
          onOpenSeating={
            onOpenSeating &&
            (() => {
              close();
              onOpenSeating(state.seats, provisionalEast(state));
            })
          }
          onDone={({ seats, newNames, removedNames, dealer }) => {
            const roster = withRoster(store, [...(seats ?? state.seats), ...newNames]).filter((p) => !removedNames.includes(p.name));
            let next = game;
            // New seats and 莊 together are one change - one 還原 takes both back.
            next = withEvents(next, [...(seats ? [{ t: "swap" as const, at: Date.now(), seats }] : []), ...(dealer ? [dealer] : [])]);
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
            update(withEvents(game, state.lahs.map((l) => ({ t: "surrender" as const, at, holder: l.holder, pulled: l.pulled }))));
            close();
            flash(`全部投降 · ${state.lahs.length} 拉 ended`);
          }}
        />
      )}
      {sheet?.kind === "jackpot" && (
        <JackpotSheet
          store={store}
          state={sheetState}
          initial={sheet.initial}
          onDone={(ev) => {
            if (sheet.editIndex === undefined) return add(ev, ev.t === "jackpotIn" ? "Paid into the Jackpot" : "Jackpot handed out");
            update(replaceEvent(game, sheet.editIndex, ev));
            close();
            flash("Entry fixed - later hands updated");
          }}
          onClose={close}
        />
      )}
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

export function HandRow({ h, store }: { h: HandResult; store: ScoreStore }) {
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
