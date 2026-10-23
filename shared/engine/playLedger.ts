// A Play table's hands as a Scores-tab game: the same ScoreGame the Scores
// tab keeps (ledger.ts), so everything it shows - the standings, 胡·摸·銃,
// the 拉 / 踢 in play, every hand, the trend, each player's stats - works for
// a game against bots or at an online table too.
//
// Play already settles the way the ledger does (settleWins is previewWin
// with 底 / 莊 / 連莊 off - its tai count them), so a hand is just its winners'
// tai and who paid; the table's bonuses (flowers, dice, 暗槓, 追, 嗌錯) are
// 特別獎罰, and 投降 is 投降. playEvents reads them off one step of the game,
// before -> after, so whoever runs the game - this phone, or the server -
// keeps the record as it goes.

import { PLAY_LAH_SETTINGS, SEATS, type GameState, type TableBonus } from "./game";
import type { ScoreEvent, ScoreGame, ScoreSettings } from "./ledger";
import { scoreView } from "./view";

// The Scores tab's settings for a Play game: what Play settles by (no 反雪,
// no Jackpot; the dealer keeps the deal on a 流局, as at the table).
export const PLAY_SCORE_SETTINGS: ScoreSettings = { ...PLAY_LAH_SETTINGS, fanXue: false, jackpot: false, drawKeepsDealer: true };

// Each name once: a second "Casual" becomes "Casual 2".
export function uniqueNames(names: string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((n) => {
    const k = (seen.get(n) ?? 0) + 1;
    seen.set(n, k);
    return k === 1 ? n : `${n} ${k}`;
  });
}

export function newPlayLedger(seats: string[], firstDealer: number, now = Date.now(), id = `play-${now}`): ScoreGame {
  return { id, startedAt: now, seats: uniqueNames(seats), firstDealer, settings: PLAY_SCORE_SETTINGS, events: [], updatedAt: now };
}

// One payment pattern, as 特別獎罰: `seat` collects from (or pays) each of
// the others, or just one (`other`).
function bonusEvents(seat: number, deltas: number[], name: string, at: number): ScoreEvent[] {
  const others = [0, 1, 2, 3].filter((i) => i !== seat);
  const paying = others.filter((i) => deltas[i] !== 0);
  if (paying.length === 0) return [];
  const label = { name };
  if (paying.length === 1) {
    const other = paying[0];
    const amount = Math.abs(deltas[other]);
    return [{ t: "bonus", at, seat, amount, kind: deltas[seat] > 0 ? "獎" : "罰", other, ...label }];
  }
  // From (or to) each: one event if they're all the same, else one each.
  if (paying.length === 3 && paying.every((i) => deltas[i] === deltas[paying[0]]))
    return [{ t: "bonus", at, seat, amount: Math.abs(deltas[paying[0]]), kind: deltas[seat] > 0 ? "獎" : "罰", ...label }];
  return paying.map((other) => ({ t: "bonus", at, seat, amount: Math.abs(deltas[other]), kind: deltas[other] < 0 ? "獎" : "罰", other, ...label }) as ScoreEvent);
}

const bonusOf = (b: TableBonus, at: number) => bonusEvents(b.seat, b.deltas, b.name, at);
// A bonus taken back (嗌錯 hands back what the call earned): the same, the other way.
const reversed = (b: TableBonus, at: number) => bonusEvents(b.seat, b.deltas.map((d) => -d), `${b.name} 退`, at);

// What changed in one step of a Play game, as Scores-tab entries. `seats`:
// the ledger's player names by seat (for 投降, which names them). A step
// is one move, one claim resolved, a 投降, or the next deal - never more
// than a hand.
export function playEvents(before: GameState | null, after: GameState, seats: string[], at = Date.now()): ScoreEvent[] {
  const out: ScoreEvent[] = [];
  const newDeal = !before || (before.phase.kind === "over" && after.phase.kind !== "over");
  // Dice and the table's bonuses, as they come up.
  if (newDeal && after.diceBonus) out.push(...bonusEvents(after.dealer, after.diceBonus.deltas, after.diceBonus.name, at));
  const was = newDeal ? [] : (before?.tableBonuses ?? []);
  const now = after.tableBonuses ?? [];
  for (const b of now.slice(was.length)) out.push(...bonusOf(b, at));
  for (const b of was.slice(now.length)) out.push(...reversed(b, at));
  // A hand's end.
  if (after.phase.kind === "over" && before?.phase.kind !== "over") {
    const r = after.phase.result;
    if (r.winner === null) out.push({ t: "draw", at });
    else {
      const winners = [{ winner: r.winner, score: r.score }, ...(r.alsoWon ?? [])].map((w) => ({
        seat: w.winner,
        tai: w.score?.total ?? 0,
        ...(w.score ? { patterns: scoreView(w.score).patterns } : {}),
      }));
      out.push({ t: "win", at, winners, from: r.from, source: "scoring" });
    }
  }
  // 投降: a 拉 gone between hands - whether the next deal is in the same
  // step or not (a deal carries every 拉 over, so one that's gone was given up).
  if (before?.phase.kind === "over") {
    for (const l of before.lahs ?? [])
      if (!(after.lahs ?? []).some((x) => x.holder === l.holder && x.pulled === l.pulled))
        out.push({ t: "surrender", at, holder: seats[Number(l.holder)], pulled: seats[Number(l.pulled)] });
  }
  return out;
}

// A game already under way (a Play game saved before its record was kept):
// a record starting from these totals, carried over as 承上 between seat 0
// and each of the others.
export function carriedOver(seats: string[], dealer: number, totals: number[], now = Date.now()): ScoreGame {
  const g = newPlayLedger(seats, dealer, now);
  for (let seat = 1; seat < SEATS; seat++)
    if (totals[seat]) g.events.push({ t: "bonus", at: now, seat, amount: Math.abs(totals[seat]), kind: totals[seat] > 0 ? "獎" : "罰", other: 0, name: "承上" });
  return g;
}
