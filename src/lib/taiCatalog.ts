// The house's tai rules as data: one row per scoring pattern, the single
// place its value and relations are written down. scoring.ts's PATTERNS only
// *detect* - each score() returns how many times a pattern applies (0 = not
// at all) - and the rules turn that into tai; DEFAULT_TAI_RULES (scoring.ts)
// is built from this file alone. The Scoring tab's 設定 sheet edits a copy.
//
// What a pattern's rule is made of (docs/scoring-rules.md, "Rule
// classification and customisation"):
// - family        - the docs section it belongs to; groups the editor.
// - value         - flat (N when it applies), per (N per instance), table
//                   (tai by count, 槓摸/搶槓) or streak (莊: first + each 連莊).
// - ladder        - LADDERS below: tiers where a higher rung replaces every
//                   lower one (大三元 over 小三元 over 三元牌).
// - replaces      - exclusion edges outside any ladder; any pair with no
//                   edge and no shared ladder stacks.
// - blocksChicken - whether its firing stops 大雞/大鴨 (default yes).
// - hand shapes   - which of normal/十三么/十六不搭/嚦咕嚦咕 it can count on.
//                   Not listed here: that's a fact about each special-hand
//                   scorer (what it knows how to evaluate), so it's derived
//                   in scoring.ts as eligibleShapes.

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
  /** Exclusion edges beyond its ladder. */
  replaces?: string[];
  /** false: 大雞/大鴨 still apply when this fires (purely declared state). */
  blocksChicken?: boolean;
}

// 槓摸/搶槓's default table - see FIVE_POWER_TAI_TABLE in scoring.ts for
// why it's a literal list rather than a formula.
export const FIVE_POWER_TABLE: readonly number[] = [0, 5, 25, 125, 250, 250];

const flat = (tai: number): PatternValue => ({ kind: "flat", tai });
const per = (tai: number): PatternValue => ({ kind: "per", tai });
const table = (t: readonly number[]): PatternValue => ({ kind: "table", table: [...t] });
const streak = (first: number, tai: number): PatternValue => ({ kind: "streak", first, tai });

export const PATTERN_CATALOG: Record<string, PatternClass> = {
  "base-tai": { family: "foundation", value: flat(5), blocksChicken: false },
  "concealed-except-kongs": { family: "foundation", value: flat(5) },
  kong: { family: "foundation", value: per(2) },
  "no-flowers": { family: "bonus", value: flat(2), blocksChicken: false },
  "correct-flower": { family: "bonus", value: per(2), blocksChicken: false },
  "wrong-flower": { family: "bonus", value: per(2), blocksChicken: false },
  "no-honors-no-flowers": { family: "purity", value: flat(10) },
  "no-honors": { family: "purity", value: flat(2) },
  "wrong-seat-wind": { family: "winds", value: per(2) },
  "correct-seat-wind": { family: "winds", value: flat(2) },
  "correct-round-wind": { family: "winds", value: flat(0) },
  "small-three-winds": { family: "winds", value: flat(30) },
  "big-three-winds": { family: "winds", value: flat(60) },
  "small-four-winds": { family: "winds", value: flat(120) },
  "big-four-winds": { family: "winds", value: flat(160) },
  "dragon-tile": { family: "dragons", value: per(2) },
  "small-three-dragons": { family: "dragons", value: flat(40) },
  "big-three-dragons": { family: "dragons", value: flat(80) },
  "all-honors": { family: "purity", value: flat(160) },
  "all-runs": { family: "shape", value: flat(5) },
  "all-runs-no-honors-no-flowers": { family: "shape", value: flat(20), replaces: ["all-runs", "no-honors-no-flowers"] },
  "missing-one-suit": { family: "coverage", value: flat(10) },
  "middle-tile-pair": { family: "pair", value: per(2) },
  "no-fives": { family: "range", value: flat(10) },
  "small-five-suits": { family: "coverage", value: flat(10) },
  "big-five-suits": { family: "coverage", value: flat(15) },
  "small-seven-suits": { family: "coverage", value: flat(15) },
  "big-seven-suits": { family: "coverage", value: flat(20) },
  "greater-than-five": { family: "range", value: flat(40), replaces: ["no-fives"] },
  "less-than-five": { family: "range", value: flat(40), replaces: ["no-fives"] },
  "all-simples": { family: "range", value: flat(10) },
  "three-treasures": { family: "compound", value: flat(40) },
  "all-triplets": { family: "shape", value: flat(40) },
  "five-concealed-triplets": { family: "shape", value: flat(160), replaces: ["all-triplets", "two-hidden-triplets", "three-hidden-triplets", "four-hidden-triplets", "five-hidden-triplets"] },
  "two-hidden-triplets": { family: "hidden", value: flat(5) },
  "three-hidden-triplets": { family: "hidden", value: flat(15) },
  "four-hidden-triplets": { family: "hidden", value: flat(30) },
  "five-hidden-triplets": { family: "hidden", value: flat(80) },
  "five-kongs": { family: "hidden", value: flat(240), replaces: ["kong", "four-hidden-triplets", "five-hidden-triplets"] },
  "pure-straight-open": { family: "straights", value: per(10) },
  "pure-straight-hidden": { family: "straights", value: per(20) },
  "mixed-straight-open": { family: "straights", value: per(8) },
  "mixed-straight-hidden": { family: "straights", value: per(15) },
  "old-young-run": { family: "straights", value: per(3) },
  "old-young-triplet": { family: "straights", value: per(5) },
  "mixed-common-rank": { family: "common-rank", value: flat(30) },
  "mixed-common-rank-pair": { family: "common-rank", value: flat(50) },
  "mixed-common-rank-triple": { family: "common-rank", value: flat(60) },
  "pure-common-rank": { family: "common-rank", value: flat(120), replaces: ["mixed-common-rank"] },
  "mixed-terminal": { family: "common-rank", value: flat(40) },
  "pure-terminal": { family: "common-rank", value: flat(80), replaces: ["no-fives"] },
  "mixed-terminal-honor-triplets": { family: "common-rank", value: flat(100) },
  "pure-terminal-triplets": { family: "common-rank", value: flat(200) },
  "four-returns-to-one-open": { family: "four-returns", value: per(5) },
  "four-returns-to-one-hidden": { family: "four-returns", value: per(15) },
  "four-returns-to-two-open": { family: "four-returns", value: flat(15) },
  "four-returns-to-two-hidden": { family: "four-returns", value: flat(30) },
  "four-returns-to-four-open": { family: "four-returns", value: per(30) },
  "four-returns-to-four-hidden": { family: "four-returns", value: per(60) },
  "identical-sequences-open": { family: "sequences", value: per(5) },
  "identical-sequences-hidden": { family: "sequences", value: per(8) },
  "small-twin-identical-sequences-open": { family: "sequences", value: flat(10), replaces: ["identical-sequences-open", "identical-sequences-hidden"] },
  "small-twin-identical-sequences-hidden": { family: "sequences", value: flat(15), replaces: ["identical-sequences-open", "identical-sequences-hidden"] },
  "triple-identical-sequences-open": { family: "sequences", value: flat(30) },
  "triple-identical-sequences-hidden": { family: "sequences", value: flat(60) },
  "quadruple-identical-sequences-open": { family: "sequences", value: flat(80) },
  "quadruple-identical-sequences-hidden": { family: "sequences", value: flat(160) },
  "two-separate-identical-sequences-open": { family: "sequences", value: flat(20), replaces: ["identical-sequences-open", "identical-sequences-hidden"] },
  "two-separate-identical-sequences-hidden": { family: "sequences", value: flat(40), replaces: ["identical-sequences-open", "identical-sequences-hidden"] },
  "same-suit-consecutive-open": { family: "sequences", value: per(15) },
  "same-suit-consecutive-hidden": { family: "sequences", value: per(30) },
  "same-suit-two-step-open": { family: "sequences", value: per(8) },
  "same-suit-two-step-hidden": { family: "sequences", value: per(15) },
  "consecutive-triplet-pair": { family: "consecutive", value: per(5) },
  "small-three-consecutive-triplets": { family: "consecutive", value: per(15) },
  "big-three-consecutive-triplets": { family: "consecutive", value: per(30) },
  // Longer chains: worth 0 in the house list, so a long chain still counts
  // as overlapping 大三連刻 windows until one of these is given a value
  // (see CHAIN_TIERS in scoring.ts).
  "small-four-consecutive-triplets": { family: "consecutive", value: per(0) },
  "big-four-consecutive-triplets": { family: "consecutive", value: per(0) },
  "small-five-consecutive-triplets": { family: "consecutive", value: per(0) },
  "big-five-consecutive-triplets": { family: "consecutive", value: per(0) },
  "small-six-consecutive-triplets": { family: "consecutive", value: per(0) },
  "twin-consecutive-triplet-pairs": { family: "consecutive", value: flat(0), replaces: ["consecutive-triplet-pair"] },
  "half-flush": { family: "flush", value: flat(40) },
  "full-flush": { family: "flush", value: flat(120) },
  "cross-suit-same-run": { family: "cross-suit", value: per(3) },
  "twin-cross-suit-runs": { family: "cross-suit", value: flat(5) },
  "full-cross-suit-runs": { family: "cross-suit", value: flat(20) },
  staircase: { family: "cross-suit", value: flat(20) },
  "rotating-staircase": { family: "cross-suit", value: flat(40) },
  "three-suit-same-run-open": { family: "cross-suit", value: flat(10) },
  "three-suit-same-run-hidden": { family: "cross-suit", value: flat(20) },
  "four-suit-same-run-open": { family: "cross-suit", value: flat(40), replaces: ["identical-sequences-open", "identical-sequences-hidden"] },
  "four-suit-same-run-hidden": { family: "cross-suit", value: flat(80), replaces: ["identical-sequences-open", "identical-sequences-hidden"] },
  "five-suit-same-run-open": { family: "cross-suit", value: flat(80), replaces: ["identical-sequences-open", "identical-sequences-hidden"] },
  "five-suit-same-run-hidden": { family: "cross-suit", value: flat(160), replaces: ["identical-sequences-open", "identical-sequences-hidden"] },
  "cross-suit-same-triplet": { family: "cross-suit", value: per(5) },
  "small-three-color-consecutive-triplets": { family: "cross-suit", value: per(10) },
  "big-three-color-consecutive-triplets": { family: "cross-suit", value: per(20) },
  "small-three-brothers": { family: "cross-suit", value: flat(20) },
  "big-three-brothers": { family: "cross-suit", value: flat(40) },
  "three-color-step-up-open": { family: "cross-suit", value: per(5) },
  "three-color-step-up-hidden": { family: "cross-suit", value: per(10) },
  "shanpon-wait": { family: "completion", value: flat(2) },
  "genuine-single-wait": { family: "completion", value: flat(2) },
  "fake-single-wait": { family: "completion", value: flat(2) },
  "visible-triple-win": { family: "completion", value: flat(5), blocksChicken: false },
  "visible-exhausted-multi-wait": { family: "completion", value: flat(10), blocksChicken: false },
  "self-draw": { family: "situation", value: flat(1) },
  riichi: { family: "situation", value: flat(5), blocksChicken: false },
  "concealed-riichi": { family: "situation", value: flat(10), replaces: ["riichi", "heavenly-riichi", "earthly-riichi"], blocksChicken: false },
  "heavenly-riichi": { family: "situation", value: flat(60), replaces: ["riichi", "concealed-riichi", "concealed-except-kongs"], blocksChicken: false },
  "earthly-riichi": { family: "situation", value: flat(50), replaces: ["riichi", "concealed-riichi", "concealed-except-kongs"], blocksChicken: false },
  "riichi-instant-win": { family: "situation", value: flat(5), blocksChicken: false },
  "riichi-eat": { family: "situation", value: flat(5), blocksChicken: false },
  "early-win-four": { family: "situation", value: flat(60), blocksChicken: false },
  "early-win-seven": { family: "situation", value: flat(30), blocksChicken: false },
  "early-win-ten": { family: "situation", value: flat(15), blocksChicken: false },
  "multi-win-double": { family: "situation", value: flat(5), blocksChicken: false },
  "multi-win-triple": { family: "situation", value: flat(10), blocksChicken: false },
  "heavenly-win": { family: "situation", value: flat(160), replaces: ["concealed-except-kongs", "riichi", "concealed-riichi", "heavenly-riichi", "earthly-riichi"], blocksChicken: false },
  "earthly-win": { family: "situation", value: flat(120), replaces: ["concealed-except-kongs", "riichi", "concealed-riichi", "heavenly-riichi", "earthly-riichi"], blocksChicken: false },
  "human-win": { family: "situation", value: flat(80), replaces: ["concealed-except-kongs", "riichi", "concealed-riichi", "heavenly-riichi", "earthly-riichi"], blocksChicken: false },
  "river-bottom-win": { family: "situation", value: flat(5), blocksChicken: false },
  "sea-bottom-win": { family: "situation", value: flat(10), blocksChicken: false },
  "sea-bottom-win-one-tong": { family: "situation", value: flat(20), blocksChicken: false },
  "flower-draw": { family: "situation", value: per(2) },
  "kong-draw": { family: "situation", value: table(FIVE_POWER_TABLE) },
  "rob-kong": { family: "situation", value: table(FIVE_POWER_TABLE), blocksChicken: false },
  "dealer-streak": { family: "situation", value: streak(1, 2), blocksChicken: false },
  "concealed-self-draw": { family: "situation", value: flat(3) },
  "everyone-else-completes-it": { family: "situation", value: flat(30) },
  "half-everyone-else-completes-it": { family: "situation", value: flat(15) },
  "big-chicken": { family: "meta", value: flat(30) },
  "big-duck": { family: "meta", value: flat(15) },
  "thirteen-orphans": { family: "special", value: flat(160) },
  "orphans-four-return-open": { family: "special", value: per(5) },
  "orphans-four-return-hidden": { family: "special", value: per(15) },
  "sixteen-unrelated": { family: "special", value: flat(50) },
  "sixteen-unrelated-flying": { family: "special", value: flat(60) },
  "sixteen-unrelated-same-ranks": { family: "special", value: flat(20) },
  "sixteen-unrelated-straight": { family: "special", value: flat(20) },
  "eight-pairs": { family: "special", value: flat(50) },
  "eight-pairs-flying": { family: "special", value: flat(60) },
  "eight-pairs-three-dragons": { family: "special", value: flat(20) },
  "eight-pairs-three-winds": { family: "special", value: flat(15) },
  "eight-pairs-four-winds": { family: "special", value: flat(60) },
};

// 明/暗 pairs: a pattern scored separately when an instance is open (明 -
// any meld called, or completed by a claimed winning tile) or concealed
// (暗). They stay two patterns in the engine - two ids, two values, two
// breakdown rows, since a hand can score both - and are shown as one row
// with two values in 設定 and the printed reference. Every pattern whose id
// ends "-open" has a "-hidden" partner (checked in taiRules.test.ts).
export interface OpenConcealedPair {
  /** The shared id stem, e.g. "identical-sequences". */
  id: string;
  open: string;
  concealed: string;
}

export const OPEN_CONCEALED_PAIRS: OpenConcealedPair[] = Object.keys(PATTERN_CATALOG)
  .filter((id) => id.endsWith("-open"))
  .map((open) => {
    const id = open.slice(0, -"-open".length);
    return { id, open, concealed: `${id}-hidden` };
  });

const PAIR_BY_PATTERN = new Map(OPEN_CONCEALED_PAIRS.flatMap((p) => [[p.open, p] as const, [p.concealed, p] as const]));

/** The 明/暗 pair a pattern belongs to, if any. */
export const pairOf = (id: string): OpenConcealedPair | undefined => PAIR_BY_PATTERN.get(id);

// Tier families, lowest rung first. A rung can hold several patterns that
// are alternatives at the same tier (明/暗 versions, 小/大 連刻, or
// 正位風/爛位風/正圈風). Two kinds, one rule - the highest tier that has a
// value wins:
// - "count" (the default): a pattern that fires replaces every pattern on a
//   lower rung, so only the highest rung that fires counts (暗刻: 兩 → 三 →
//   四 → 五). The rule set can switch a count family to stacking.
// - "windows": rungs are lengths of a run of melds (連刻: 2, 3, 4… ranks).
//   A window counts unless a longer tier with a value covers it, so a long
//   run whose own tier is 0 counts as overlapping shorter windows. Found by
//   the family's detector in scoring.ts (CHAIN_TIERS for 連刻); never
//   switched to stacking - giving the longer tiers a value is the switch.
export interface Ladder {
  id: string;
  label: string;
  rungs: string[][];
  kind?: "count" | "windows";
}

export const LADDERS: Ladder[] = [
  {
    id: "consecutive",
    label: "連刻 Consecutive triplets",
    kind: "windows",
    rungs: [
      ["consecutive-triplet-pair"],
      ["small-three-consecutive-triplets", "big-three-consecutive-triplets"],
      ["small-four-consecutive-triplets", "big-four-consecutive-triplets"],
      ["small-five-consecutive-triplets", "big-five-consecutive-triplets"],
      ["small-six-consecutive-triplets"],
    ],
  },
  {
    id: "winds",
    label: "風 Winds",
    rungs: [
      ["wrong-seat-wind", "correct-seat-wind", "correct-round-wind"],
      ["small-three-winds"],
      ["big-three-winds"],
      ["small-four-winds"],
      ["big-four-winds"],
    ],
  },
  {
    id: "dragons",
    label: "三元 Dragons",
    rungs: [
      ["dragon-tile"],
      ["small-three-dragons"],
      ["big-three-dragons"],
    ],
  },
  {
    id: "purity",
    label: "無字/無花",
    rungs: [
      ["no-honors", "no-flowers"],
      ["no-honors-no-flowers"],
    ],
  },
  {
    id: "hidden",
    label: "暗刻",
    rungs: [
      ["two-hidden-triplets"],
      ["three-hidden-triplets"],
      ["four-hidden-triplets"],
      ["five-hidden-triplets"],
    ],
  },
  {
    id: "small-suits",
    label: "小五/七門齊",
    rungs: [
      ["small-five-suits"],
      ["small-seven-suits"],
    ],
  },
  {
    id: "big-suits",
    label: "大五/七門齊",
    rungs: [
      ["big-five-suits"],
      ["big-seven-suits"],
    ],
  },
  {
    id: "common-rank",
    label: "混帶X/XY/XYZ",
    rungs: [
      ["mixed-common-rank"],
      ["mixed-common-rank-pair"],
      ["mixed-common-rank-triple"],
    ],
  },
  {
    id: "terminals",
    label: "帶么/老頭",
    rungs: [
      ["mixed-terminal", "pure-terminal"],
      ["mixed-terminal-honor-triplets"],
      ["pure-terminal-triplets"],
    ],
  },
  {
    id: "identical",
    label: "般高/同順",
    rungs: [
      ["identical-sequences-open", "identical-sequences-hidden"],
      ["triple-identical-sequences-open", "triple-identical-sequences-hidden"],
      ["quadruple-identical-sequences-open", "quadruple-identical-sequences-hidden"],
    ],
  },
  {
    id: "same-run",
    label: "三/四/五相逢",
    rungs: [
      ["three-suit-same-run-open", "three-suit-same-run-hidden"],
      ["four-suit-same-run-open", "four-suit-same-run-hidden"],
      ["five-suit-same-run-open", "five-suit-same-run-hidden"],
    ],
  },
  {
    id: "sisters",
    label: "姊妹",
    rungs: [
      ["twin-cross-suit-runs"],
      ["full-cross-suit-runs"],
    ],
  },
  {
    id: "staircase",
    label: "樓梯",
    rungs: [
      ["staircase"],
      ["rotating-staircase"],
    ],
  },
  {
    id: "flush",
    label: "一色",
    rungs: [
      ["half-flush"],
      ["full-flush"],
    ],
  },
  {
    id: "single-wait",
    label: "獨獨",
    rungs: [
      ["fake-single-wait"],
      ["genuine-single-wait"],
    ],
  },
  {
    id: "visible",
    label: "明絕/絕絕",
    rungs: [
      ["visible-triple-win"],
      ["visible-exhausted-multi-wait"],
    ],
  },
  {
    id: "self-draw",
    label: "自摸",
    rungs: [
      ["self-draw"],
      ["concealed-self-draw"],
    ],
  },
  {
    id: "sea-bottom",
    label: "海底撈月",
    rungs: [
      ["sea-bottom-win"],
      ["sea-bottom-win-one-tong"],
    ],
  },
  {
    id: "sixteen",
    label: "十六不搭",
    rungs: [
      ["sixteen-unrelated"],
      ["sixteen-unrelated-flying"],
    ],
  },
  {
    id: "eight-pairs",
    label: "嚦咕嚦咕",
    rungs: [
      ["eight-pairs"],
      ["eight-pairs-flying"],
    ],
  },
  {
    id: "eight-pairs-winds",
    label: "嚦咕風",
    rungs: [
      ["eight-pairs-three-winds"],
      ["eight-pairs-four-winds"],
    ],
  },
];

// Patterns keyed to one value of a single situation choice (the Scoring
// tab's cycling buttons): two with the same choice but different values can
// never fire on the same hand, so a replace loop between them is harmless -
// the house list itself has 門清叮 and 天叮/地叮 replacing each other. Read
// by replaceCycles (taiRules.ts) so only loops that can bite are flagged.
export const SITUATION_CHOICE: Record<string, { choice: string; value: string }> = {
  riichi: { choice: "riichi", value: "riichi" },
  "concealed-riichi": { choice: "riichi", value: "riichi" },
  "heavenly-riichi": { choice: "riichi", value: "heavenly-riichi" },
  "earthly-riichi": { choice: "riichi", value: "earthly-riichi" },
  "early-win-four": { choice: "earlyWin", value: "four" },
  "early-win-seven": { choice: "earlyWin", value: "seven" },
  "early-win-ten": { choice: "earlyWin", value: "ten" },
  "multi-win-double": { choice: "multiWin", value: "double" },
  "multi-win-triple": { choice: "multiWin", value: "triple" },
  "heavenly-win": { choice: "heavenlyWin", value: "heaven" },
  "earthly-win": { choice: "heavenlyWin", value: "earth" },
  "human-win": { choice: "heavenlyWin", value: "man" },
  "river-bottom-win": { choice: "lastTileWin", value: "river-bottom" },
  "sea-bottom-win": { choice: "lastTileWin", value: "sea-bottom" },
  "sea-bottom-win-one-tong": { choice: "lastTileWin", value: "sea-bottom" },
};
