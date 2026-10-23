import { describe, expect, it } from "vitest";
import { applyTurnMove, botClaim, botTurnMove, newGame, nextHand, resolveClaims, surrender, SEATS, type GameState } from "./game";
import { botSurrenders, profileById, seededRng } from "./bots";
import { replay, type ScoreGame } from "./ledger";
import { carriedOver, newPlayLedger, playEvents, uniqueNames } from "./playLedger";

// Bot hands at a table, the record kept step by step as the table would,
// next to what the table itself paid.
function play(hands: number, seed: number, multiWin: boolean) {
  const real = Math.random;
  Math.random = seededRng(seed);
  try {
    let s: GameState = { ...newGame(), multiWin };
    const names = ["You", "Casual", "Casual", "Hunter"];
    let ledger: ScoreGame = newPlayLedger(names, s.dealer, 0);
    const seats = ledger.seats;
    const totals = [0, 0, 0, 0];
    // Bots that give up every 拉 they may.
    const quitter = { ...profileById("casual"), surrender: 1 };
    const step = (next: GameState) => {
      ledger = { ...ledger, events: [...ledger.events, ...playEvents(s, next, seats, 0)] };
      s = next;
    };
    // The first deal's own bonuses.
    ledger.events.push(...playEvents(null, s, seats, 0));
    // A new deal's dice and bonuses (`from` = null), or those since bonus `from`.
    const paid = (g: GameState, from: number | null = null) => {
      if (from === null && g.diceBonus) g.diceBonus.deltas.forEach((d, i) => (totals[i] += d));
      for (const b of (g.tableBonuses ?? []).slice(from ?? 0)) b.deltas.forEach((d, i) => (totals[i] += d));
    };
    paid(s);
    for (let hand = 0; hand < hands; hand++) {
      for (let i = 0; i < 1000 && s.phase.kind !== "over"; i++) {
        const had = s.tableBonuses?.length ?? 0;
        const next = s.phase.kind === "turn" ? applyTurnMove(s, botTurnMove(s)) : resolveClaims(s, Array.from({ length: SEATS }, (_, seat) => botClaim(s, seat)));
        step(next);
        paid(s, had);
      }
      if (s.phase.kind === "over") s.phase.result.deltas.forEach((d, i) => (totals[i] += d));
      // Bots give up a long 拉, as at the table.
      let given = s;
      for (let seat = 0; seat < SEATS; seat++) for (const holder of botSurrenders(given, seat, quitter)) {
        given = surrender(given, holder, seat);
      }
      step(given);
      // The ledger and the table agree, hand by hand.
      const r = replay(ledger);
      expect(seats.map((p) => r.totals[p])).toEqual(totals);
      expect(r.lahs.map((l) => `${l.holder}>${l.pulled}:${l.value}`).sort()).toEqual((s.lahs ?? []).map((l) => `${seats[+l.holder]}>${seats[+l.pulled]}:${l.value}`).sort());
      step(nextHand(s));
      paid(s);
      const after = replay(ledger);
      expect(after.dealer).toBe(s.dealer);
      expect(after.streak).toBe(s.dealerStreak);
    }
    return { ledger, s };
  } finally {
    Math.random = real;
  }
}

describe("a Play game as a Scores game", () => {
  it("names each player once", () => {
    expect(uniqueNames(["You", "Casual", "Casual", "Casual"])).toEqual(["You", "Casual", "Casual 2", "Casual 3"]);
  });

  it("keeps the same totals, 拉 and dealer as the table, 截胡", () => {
    const { ledger } = play(10, 3, false);
    const r = replay(ledger);
    expect(r.hands.length).toBe(10);
  }, 120_000);

  it("and with 一炮多響", () => {
    play(10, 11, true);
  }, 120_000);

  it("catches 投降 made with the next deal in one step, as the Play tab does", () => {
    // A finished hand with a 拉 in play.
    let s = play(1, 2, false).s;
    for (let i = 0; i < 40 && !(s.phase.kind === "over" && s.lahs?.length); i++) {
      if (s.phase.kind === "over") s = nextHand(s);
      for (let k = 0; k < 1000 && s.phase.kind !== "over"; k++)
        s = s.phase.kind === "turn" ? applyTurnMove(s, botTurnMove(s)) : resolveClaims(s, Array.from({ length: SEATS }, (_, seat) => botClaim(s, seat)));
    }
    const lah = s.lahs![0];
    const seats = ["A", "B", "C", "D"];
    // Given up, then dealt, in one step.
    const dealt = nextHand({ ...s, lahs: s.lahs!.filter((l) => l !== lah) });
    expect(playEvents(s, dealt, seats, 0)).toContainEqual({ t: "surrender", at: 0, holder: seats[+lah.holder], pulled: seats[+lah.pulled] });
    // Dealt with every 拉 kept: no 投降.
    expect(playEvents(s, nextHand(s), seats, 0).some((e) => e.t === "surrender")).toBe(false);
  }, 120_000);

  it("carries over a game already under way", () => {
    const g = carriedOver(["You", "A", "B", "C"], 1, [-30, 50, -5, -15], 0);
    const r = replay(g);
    expect(["You", "A", "B", "C"].map((p) => r.totals[p])).toEqual([-30, 50, -5, -15]);
    expect(r.dealer).toBe(1);
  });
});
