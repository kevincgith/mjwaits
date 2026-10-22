// Logic behind a few Scores views, kept out of the components so it can be
// tested on its own: the 局 sheet's rows, the seat ceremony's provisional
// East, and what kind of change just happened (for the 籌碼 card).

import { handAt, stepAt, SEATS, type HandResult, type ReplayState, type ScoreEvent, type ScoreGame } from "./ledger";

// ---- 局: the score sheet's rows ---------------------------------------------

export type SheetRow =
  | { kind: "hand"; key: string; h: HandResult; deltas: Record<string, number>; bonuses: number; payIns: number }
  | { kind: "bonus"; key: string; label: string; deltas: Record<string, number> } // 獎 / 罰, a 預設獎罰's name, 獎罰 or 詐胡
  | { kind: "jackpot"; key: string; deltas: Record<string, number> };

// A row per hand, oldest first. Detailed (merge off): 獎罰, 詐胡 and Jackpot
// entries are rows of their own. Simple (merge on): 獎罰, 詐胡 and Jackpot
// pay-ins fold into the next hand, counted on it; any after the last hand
// wait in one row at the foot.
export function sheetRows(game: ScoreGame, state: ReplayState, merge: boolean): SheetRow[] {
  const out: SheetRow[] = [];
  let pending: { deltas: Record<string, number>; count: number; payIns: number } | null = null;
  const fold = (deltas: Record<string, number>, payIn: boolean) => {
    const acc = pending ?? { deltas: {}, count: 0, payIns: 0 };
    for (const [p, d] of Object.entries(deltas)) acc.deltas[p] = (acc.deltas[p] ?? 0) + d;
    if (payIn) acc.payIns++;
    else acc.count++;
    pending = acc;
  };
  game.events.forEach((ev, i) => {
    const deltas = stepAt(state, i)?.deltas ?? {};
    if (ev.t === "win" || ev.t === "draw") {
      const h = handAt(state, i);
      if (!h) return;
      const merged = { ...deltas };
      const folded = pending as { deltas: Record<string, number>; count: number; payIns: number } | null;
      if (folded) for (const [p, d] of Object.entries(folded.deltas)) merged[p] = (merged[p] ?? 0) + d;
      out.push({ kind: "hand", key: `h${i}`, h, deltas: merged, bonuses: folded?.count ?? 0, payIns: folded?.payIns ?? 0 });
      pending = null;
    } else if (ev.t === "bonus" || ev.t === "zhaHu") {
      if (merge) fold(deltas, false);
      else out.push({ kind: "bonus", key: `b${i}`, label: ev.t === "zhaHu" ? "詐胡" : (ev.name ?? ev.kind), deltas });
    } else if (ev.t === "jackpotIn" && merge) {
      fold(deltas, true);
    } else if ((ev.t === "jackpot" || ev.t === "jackpotIn") && Object.values(deltas).some((d) => d !== 0)) {
      out.push({ kind: "jackpot", key: `j${i}`, deltas });
    }
  });
  const left = pending as { deltas: Record<string, number>; count: number } | null;
  if (left) out.push(left.count > 0 ? { kind: "bonus", key: "b-pending", label: "獎罰", deltas: left.deltas } : { kind: "jackpot", key: "j-pending", deltas: left.deltas });
  return out;
}

// ---- 座位: the seat ceremony's provisional East -------------------------------

// Whoever won last - of a 雙響 / 三響, the winner first counting round from
// that hand's 莊 (莊 themself if they won). No win yet: 莊. As a seat.
export function provisionalEast(state: Pick<ReplayState, "hands" | "seats" | "dealer">): number {
  const lastWin = [...state.hands].reverse().find((h) => h.kind === "win");
  if (!lastWin) return state.dealer;
  const dealerSeat = Math.max(0, state.seats.indexOf(lastWin.dealer));
  const fromDealer = (p: string) => (state.seats.indexOf(p) - dealerSeat + SEATS) % SEATS;
  const winner = lastWin.winners.map((w) => w.player).filter((p) => state.seats.includes(p)).sort((x, y) => fromDealer(x) - fromDealer(y))[0];
  return winner ? state.seats.indexOf(winner) : state.dealer;
}

// ---- 籌碼: what kind of change just happened ---------------------------------

// Entries added on the end, the last ones taken back (還原), or an older one
// fixed or deleted - and whether what was added is all 投降.
export function changeKind(before: ScoreEvent[], after: ScoreEvent[]): { kind: "added" | "undone" | "fixed"; surrenders: boolean } {
  const n = after.length;
  const m = before.length;
  if (n > m && (m === 0 || after[m - 1] === before[m - 1])) return { kind: "added", surrenders: after.slice(m).every((ev) => ev.t === "surrender") };
  if (n < m && (n === 0 || before[n - 1] === after[n - 1])) return { kind: "undone", surrenders: false };
  return { kind: "fixed", surrenders: false };
}
