// A hand scored on the Scoring tab, on its way to the Ledger. Both count 底,
// 莊/連莊 and 雙響/三響; whichever of them this Ledger game is set to add
// itself comes out of the Scoring total, and the rest stays in - so each is
// paid once, whatever the game's 設定.

import type { ScoreSettings } from "@mjwaits/shared/engine/ledger";

type Reading = { matched: { pattern: { id: string }; tai: number }[] };
type Adds = Pick<ScoreSettings, "base" | "dealerTai" | "streakTai" | "fanXueDouble" | "fanXueTriple">;

export interface HandOff {
  tai: number; // what the Ledger records
  removedBaseTai: number;
  removedDealerTai: number;
  removedMultiTai: number;
  ledgerAdds: (patternId: string) => boolean; // this pattern is the Ledger's to add
}

export function ledgerHandOff(readings: Reading[], total: number, settings: Adds): HandOff {
  const ledgerAdds = (id: string) =>
    id === "base-tai"
      ? settings.base > 0
      : id === "dealer-streak"
        ? settings.dealerTai > 0 || settings.streakTai > 0
        : id === "multi-win-double"
          ? settings.fanXueDouble > 0
          : id === "multi-win-triple"
            ? settings.fanXueTriple > 0
            : false;
  const taiOf = (ids: string[]) =>
    readings
      .flatMap((r) => r.matched)
      .filter((m) => ids.includes(m.pattern.id) && ledgerAdds(m.pattern.id))
      .reduce((sum, m) => sum + m.tai, 0);
  const removedBaseTai = taiOf(["base-tai"]);
  const removedDealerTai = taiOf(["dealer-streak"]);
  const removedMultiTai = taiOf(["multi-win-double", "multi-win-triple"]);
  return { tai: total - removedBaseTai - removedDealerTai - removedMultiTai, removedBaseTai, removedDealerTai, removedMultiTai, ledgerAdds };
}
