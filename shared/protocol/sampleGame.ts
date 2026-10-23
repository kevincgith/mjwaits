// A test fixture: a Scores-tab game with one of every kind of entry, as the
// app writes them - for the protocol's tests and the Worker's.

import { DEFAULT_SETTINGS, newGame, withEvents, type ScoreEvent, type ScoreGame } from "../engine/ledger";

export function sampleGame(): ScoreGame {
  const g = newGame(["Amy", "Ben", "陳大文", "Dee"], 0, DEFAULT_SETTINGS);
  const at = g.startedAt;
  const events: ScoreEvent[] = [
    { t: "win", at, winners: [{ seat: 1, tai: 10, patterns: [{ id: "self-draw", name: "自摸", tai: 1 }] }], from: 2, source: "scoring" },
    { t: "draw", at },
    { t: "win", at, winners: [{ seat: 0, tai: 5 }, { seat: 3, tai: 8 }], from: 2, source: "quick", jackpotTo: "Amy" },
    { t: "bonus", at, seat: 2, kind: "獎", amount: 5, name: "花" },
    { t: "bonus", at, seat: 3, kind: "罰", amount: 30, other: 0 },
    { t: "zhaHu", at, seat: 1, pays: [{ player: "Amy", amount: 40 }] },
    { t: "surrender", at, holder: "Ben", pulled: "陳大文", batch: "b1" },
    { t: "jackpotIn", at, shares: [{ player: "Dee", amount: 5 }] },
    { t: "jackpot", at, shares: [{ player: "Dee", amount: 5 }] },
    { t: "dealer", at, seat: 2, streak: 1, resetRound: false, round: { wind: 1, hand: 2 } },
    { t: "settings", at, settings: { ...DEFAULT_SETTINGS, base: 2 } },
    { t: "swap", at, seats: ["Ben", "Amy", "陳大文", "Eve"] },
  ];
  return { ...withEvents(g, events), name: "Friday", location: "Kevin's", startTime: "20:00", updatedAt: at + 1 };
}
