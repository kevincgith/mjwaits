// How every scoring pattern is classified, so its tai and relations can be
// edited as data (see TaiRules in scoring.ts and the Scoring tab's 設定
// sheet). Pure data, no imports - scoring.ts builds the default ruleset
// from this plus PATTERNS' own `excludes`, so there's exactly one place a
// pattern's family/value lives.
//
// Five attributes per pattern (docs/scoring-rules.md, "Rule classification
// and customisation"):
// 1. family   - the docs section it belongs to; groups the editor.
// 2. value    - flat (N when it applies), per (N per instance), table
//               (tai by count, 槓摸/搶槓) or streak (莊: first + each extra).
// 3. shapes   - which hand shapes it may count on (inclusion) - built in
//               scoring.ts from the special-hand scorers' own lists.
// 4. replaces - ids it removes when both fire (exclusion) - PATTERNS'
//               `excludes`; any pair without an edge stacks.
// 5. 大雞/大鴨 ignore it - built in scoring.ts from the exempt lists.

export type PatternFamily =
  | "foundation"
  | "special"
  | "bonus"
  | "purity"
  | "winds"
  | "dragons"
  | "shape"
  | "hidden"
  | "completion"
  | "situation"
  | "four-returns"
  | "sequences"
  | "consecutive"
  | "cross-suit"
  | "flush"
  | "straights"
  | "common-rank"
  | "coverage"
  | "range"
  | "pair"
  | "compound"
  | "meta";

/** Editor order and labels. */
export const PATTERN_FAMILIES: { id: PatternFamily; label: string }[] = [
  { id: "foundation", label: "基本 Foundation" },
  { id: "bonus", label: "花 Bonus tiles" },
  { id: "purity", label: "字 Suit purity" },
  { id: "winds", label: "風 Wind melds" },
  { id: "dragons", label: "三元 Dragon melds" },
  { id: "shape", label: "胡型 Hand shape" },
  { id: "hidden", label: "暗刻 Concealed triplets" },
  { id: "completion", label: "食胡 Completion shape" },
  { id: "situation", label: "情況 Situation" },
  { id: "four-returns", label: "四歸 Four returns" },
  { id: "sequences", label: "般高/步步高 Sequences" },
  { id: "consecutive", label: "連刻 Consecutive triplets" },
  { id: "cross-suit", label: "相逢/兄弟 Cross-suit" },
  { id: "flush", label: "一色 Flush" },
  { id: "straights", label: "龍 Straights" },
  { id: "common-rank", label: "帶 Common rank" },
  { id: "coverage", label: "門齊 Suit coverage" },
  { id: "range", label: "範圍 Range" },
  { id: "pair", label: "將 Pair" },
  { id: "compound", label: "複合 Compound" },
  { id: "meta", label: "大雞/大鴨" },
  { id: "special", label: "特殊 Special hands" },
];

export type PatternValue =
  | { kind: "flat"; tai: number }
  | { kind: "per"; tai: number }
  // tai by count (index 1 = once, 2 = twice...); counts past the end use
  // the last entry.
  | { kind: "table"; table: number[] }
  // 莊: `first` for the first win as dealer, `tai` more per 連莊 after it.
  | { kind: "streak"; first: number; tai: number };

export interface PatternClass {
  family: PatternFamily;
  value: PatternValue;
  /** What score() returns per instance when it differs from the default
   *  tai - only 正圈風, whose detection returns 1 but which is worth 0. */
  rawUnit?: number;
}

const flat = (family: PatternFamily, tai: number): PatternClass => ({ family, value: { kind: "flat", tai } });
const per = (family: PatternFamily, tai: number): PatternClass => ({ family, value: { kind: "per", tai } });

export const FIVE_POWER_TABLE: readonly number[] = [0, 5, 25, 125, 250, 250];

export const PATTERN_CATALOG: Record<string, PatternClass> = {
  "base-tai": flat("foundation", 5),
  "concealed-except-kongs": flat("foundation", 5),
  kong: per("foundation", 2),

  "no-flowers": flat("bonus", 2),
  "correct-flower": per("bonus", 2),
  "wrong-flower": per("bonus", 2),

  "no-honors-no-flowers": flat("purity", 10),
  "no-honors": flat("purity", 2),
  "all-honors": flat("purity", 160),

  "wrong-seat-wind": per("winds", 2),
  "correct-seat-wind": flat("winds", 2),
  "correct-round-wind": { family: "winds", value: { kind: "flat", tai: 0 }, rawUnit: 1 },
  "small-three-winds": flat("winds", 30),
  "big-three-winds": flat("winds", 60),
  "small-four-winds": flat("winds", 120),
  "big-four-winds": flat("winds", 160),

  "dragon-tile": per("dragons", 2),
  "small-three-dragons": flat("dragons", 40),
  "big-three-dragons": flat("dragons", 80),

  "all-runs": flat("shape", 5),
  "all-runs-no-honors-no-flowers": flat("shape", 20),
  "all-triplets": flat("shape", 40),
  "five-concealed-triplets": flat("shape", 160),

  "two-hidden-triplets": flat("hidden", 5),
  "three-hidden-triplets": flat("hidden", 15),
  "four-hidden-triplets": flat("hidden", 30),
  "five-hidden-triplets": flat("hidden", 80),
  "five-kongs": flat("hidden", 240),

  "shanpon-wait": flat("completion", 2),
  "genuine-single-wait": flat("completion", 2),
  "fake-single-wait": flat("completion", 2),
  "visible-triple-win": flat("completion", 5),
  "visible-exhausted-multi-wait": flat("completion", 10),

  "self-draw": flat("situation", 1),
  "concealed-self-draw": flat("situation", 3),
  riichi: flat("situation", 5),
  "concealed-riichi": flat("situation", 10),
  "heavenly-riichi": flat("situation", 60),
  "earthly-riichi": flat("situation", 50),
  "riichi-instant-win": flat("situation", 5),
  "riichi-eat": flat("situation", 5),
  "early-win-four": flat("situation", 60),
  "early-win-seven": flat("situation", 30),
  "early-win-ten": flat("situation", 15),
  "multi-win-double": flat("situation", 5),
  "multi-win-triple": flat("situation", 10),
  "heavenly-win": flat("situation", 160),
  "earthly-win": flat("situation", 120),
  "human-win": flat("situation", 80),
  "river-bottom-win": flat("situation", 5),
  "sea-bottom-win": flat("situation", 10),
  "sea-bottom-win-one-tong": flat("situation", 20),
  "flower-draw": per("situation", 2),
  "kong-draw": { family: "situation", value: { kind: "table", table: [...FIVE_POWER_TABLE] } },
  "rob-kong": { family: "situation", value: { kind: "table", table: [...FIVE_POWER_TABLE] } },
  "dealer-streak": { family: "situation", value: { kind: "streak", first: 1, tai: 2 } },
  "everyone-else-completes-it": flat("situation", 30),
  "half-everyone-else-completes-it": flat("situation", 15),

  "four-returns-to-one-open": per("four-returns", 5),
  "four-returns-to-one-hidden": per("four-returns", 15),
  "four-returns-to-two-open": flat("four-returns", 15),
  "four-returns-to-two-hidden": flat("four-returns", 30),
  "four-returns-to-four-open": per("four-returns", 30),
  "four-returns-to-four-hidden": per("four-returns", 60),

  "identical-sequences-open": per("sequences", 5),
  "identical-sequences-hidden": per("sequences", 8),
  "small-twin-identical-sequences-open": flat("sequences", 10),
  "small-twin-identical-sequences-hidden": flat("sequences", 15),
  "triple-identical-sequences-open": flat("sequences", 30),
  "triple-identical-sequences-hidden": flat("sequences", 60),
  "quadruple-identical-sequences-open": flat("sequences", 80),
  "quadruple-identical-sequences-hidden": flat("sequences", 160),
  "two-separate-identical-sequences-open": flat("sequences", 20),
  "two-separate-identical-sequences-hidden": flat("sequences", 40),
  "same-suit-consecutive-open": per("sequences", 15),
  "same-suit-consecutive-hidden": per("sequences", 30),
  "same-suit-two-step-open": per("sequences", 8),
  "same-suit-two-step-hidden": per("sequences", 15),

  "consecutive-triplet-pair": per("consecutive", 5),
  "small-three-consecutive-triplets": per("consecutive", 15),
  "big-three-consecutive-triplets": per("consecutive", 30),

  "cross-suit-same-run": per("cross-suit", 3),
  "twin-cross-suit-runs": flat("cross-suit", 5),
  "full-cross-suit-runs": flat("cross-suit", 20),
  staircase: flat("cross-suit", 20),
  "rotating-staircase": flat("cross-suit", 40),
  "three-suit-same-run-open": flat("cross-suit", 10),
  "three-suit-same-run-hidden": flat("cross-suit", 20),
  "four-suit-same-run-open": flat("cross-suit", 40),
  "four-suit-same-run-hidden": flat("cross-suit", 80),
  "five-suit-same-run-open": flat("cross-suit", 80),
  "five-suit-same-run-hidden": flat("cross-suit", 160),
  "cross-suit-same-triplet": per("cross-suit", 5),
  "small-three-color-consecutive-triplets": per("cross-suit", 10),
  "big-three-color-consecutive-triplets": per("cross-suit", 20),
  "small-three-brothers": flat("cross-suit", 20),
  "big-three-brothers": flat("cross-suit", 40),
  "three-color-step-up-open": per("cross-suit", 5),
  "three-color-step-up-hidden": per("cross-suit", 10),

  "half-flush": flat("flush", 40),
  "full-flush": flat("flush", 120),

  "pure-straight-open": per("straights", 10),
  "pure-straight-hidden": per("straights", 20),
  "mixed-straight-open": per("straights", 8),
  "mixed-straight-hidden": per("straights", 15),
  "old-young-run": per("straights", 3),
  "old-young-triplet": per("straights", 5),

  "mixed-common-rank": flat("common-rank", 30),
  "mixed-common-rank-pair": flat("common-rank", 50),
  "mixed-common-rank-triple": flat("common-rank", 60),
  "pure-common-rank": flat("common-rank", 120),
  "mixed-terminal": flat("common-rank", 40),
  "pure-terminal": flat("common-rank", 80),
  "mixed-terminal-honor-triplets": flat("common-rank", 100),
  "pure-terminal-triplets": flat("common-rank", 200),

  "missing-one-suit": flat("coverage", 10),
  "small-five-suits": flat("coverage", 10),
  "big-five-suits": flat("coverage", 15),
  "small-seven-suits": flat("coverage", 15),
  "big-seven-suits": flat("coverage", 20),

  "all-simples": flat("range", 10),
  "no-fives": flat("range", 10),
  "greater-than-five": flat("range", 40),
  "less-than-five": flat("range", 40),

  // Normal hands have one pair; 嚦咕嚦咕 scores it once per 2/5/8 pair.
  "middle-tile-pair": per("pair", 2),

  "three-treasures": flat("compound", 40),

  "big-chicken": flat("meta", 30),
  "big-duck": flat("meta", 15),

  "thirteen-orphans": flat("special", 160),
  "orphans-four-return-open": per("special", 5),
  "orphans-four-return-hidden": per("special", 15),
  "sixteen-unrelated": flat("special", 50),
  "sixteen-unrelated-flying": flat("special", 60),
  "sixteen-unrelated-same-ranks": flat("special", 20),
  "sixteen-unrelated-straight": flat("special", 20),
  "eight-pairs": flat("special", 50),
  "eight-pairs-flying": flat("special", 60),
  "eight-pairs-three-dragons": flat("special", 20),
  "eight-pairs-three-winds": flat("special", 15),
  "eight-pairs-four-winds": flat("special", 60),
};
