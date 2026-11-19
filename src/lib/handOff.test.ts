import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, dealerAmount, multiWinTai, newGame, previewWin, replay, type ScoreSettings } from "@mjwaits/shared/engine/ledger";
import { ledgerHandOff } from "./handOff";

// A dealer's hand at 連2 as Scoring reads it: 底 5, 莊連2 5 (1 + 2 × 2), 對對胡 30
// - 40 in all; and the same hand as one of a 雙響 (5 more).
const m = (id: string, tai: number) => ({ pattern: { id }, tai });
const HAND = [{ matched: [m("base-tai", 5), m("dealer-streak", 5), m("all-pungs", 30)] }];
const DOUBLE = [{ matched: [...HAND[0].matched, m("multi-win-double", 5)] }];

// What one payer pays the dealer (seat 0, 連2) for the hand once it's in the
// Ledger, with these 設定.
function paid(settings: ScoreSettings, readings: typeof HAND, total: number, winners = 1) {
  const off = ledgerHandOff(readings, total, settings);
  const state = { ...replay(newGame(["A", "B", "C", "D"], 0, settings)), streak: 2 };
  const pair = previewWin(state, [{ seat: 0, tai: off.tai }], 1, multiWinTai(settings, winners))[0];
  return { off, pays: pair.worth };
}

describe("a Scoring hand sent to the Ledger", () => {
  it("at the usual 設定: 莊 comes out and the Ledger puts the same back", () => {
    const { off, pays } = paid(DEFAULT_SETTINGS, HAND, 40);
    expect(off).toMatchObject({ tai: 35, removedDealerTai: 5, removedBaseTai: 0, removedMultiTai: 0 });
    expect(dealerAmount(DEFAULT_SETTINGS, 2)).toBe(5);
    expect(pays).toBe(40);
  });

  it("自動計算莊 and 連莊 off: 莊 stays in the tai, not 5 short", () => {
    const { off, pays } = paid({ ...DEFAULT_SETTINGS, dealerTai: 0, streakTai: 0 }, HAND, 40);
    expect(off).toMatchObject({ tai: 40, removedDealerTai: 0 });
    expect(off.ledgerAdds("dealer-streak")).toBe(false);
    expect(pays).toBe(40);
  });

  it("雙響 off: its 5 stays in", () => {
    const { off, pays } = paid({ ...DEFAULT_SETTINGS, fanXueDouble: 0 }, DOUBLE, 45, 2);
    expect(off).toMatchObject({ tai: 40, removedMultiTai: 0, removedDealerTai: 5 });
    expect(pays).toBe(45);
    // (On: out here, and the Ledger's own goes on each pair.)
    const on = paid(DEFAULT_SETTINGS, DOUBLE, 45, 2);
    expect(on.off).toMatchObject({ tai: 35, removedMultiTai: 5 });
    expect(on.pays).toBe(45);
  });

  it("自動計算底 5: 底 comes out, so it's paid once", () => {
    const { off, pays } = paid({ ...DEFAULT_SETTINGS, base: 5 }, HAND, 40);
    expect(off).toMatchObject({ tai: 30, removedBaseTai: 5, removedDealerTai: 5 });
    expect(off.ledgerAdds("base-tai")).toBe(true);
    expect(pays).toBe(40);
  });
});
