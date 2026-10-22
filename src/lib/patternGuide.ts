// Plain-language descriptions for the printable rules reference (設定 →
// Export PDF): what each pattern asks of a hand, for players rather than
// developers. Only the *condition* - what it's worth, what it replaces and
// where it counts come from the rule set being printed. docs/scoring-rules.md
// has the full technical criteria; keep the two in step.
//
// UNCONFIRMED marks wording that isn't pinned down by the house rules given
// so far - the scorer only knows these as a declared 情況 button, so the
// text describes them as neutrally as it can. ROADMAP.md lists them under
// "Needs clarification"; settle the wording there before relying on a
// printed reference for them.

import type { PatternFamily } from "./taiCatalog";

/** One line under each family's heading. */
export const FAMILY_GUIDE: Record<PatternFamily, string> = {
  foundation: "What every winning hand starts from.",
  bonus: "Flowers (梅蘭菊竹) and seasons (春夏秋冬) set aside during play.",
  purity: "Whether honors (字) appear in the hand at all.",
  winds: "Melds of the wind tiles 東南西北, measured against your seat wind (門風) and the round wind (圈風).",
  dragons: "Melds of the dragon tiles 中發白.",
  shape: "The kind of melds the whole hand is built from.",
  hidden: "Triplets and kongs you formed yourself (暗刻), rather than called.",
  completion: "How the winning tile (食胡) completed the hand.",
  situation: "Declared on the Scoring tab's 情況 buttons - things the tiles alone can't show.",
  "four-returns": "All four copies of one tile spread across the hand's melds (四歸).",
  sequences: "Repeated or stepping runs within one suit.",
  consecutive: "Triplets or kongs at neighbouring ranks in one suit. The longest chain that has a value counts; a longer chain with no value of its own counts as overlapping shorter ones.",
  "cross-suit": "The same run or rank repeated across different suits.",
  flush: "Hands built from a single numbered suit.",
  straights: "Runs that join up into 1–9, or pair the ends of a suit.",
  "common-rank": "A rank, or terminals, running through every meld.",
  coverage: "Which of the five categories (萬, 筒, 索, winds, dragons) the hand touches.",
  range: "Which ranks the hand's tiles are limited to.",
  pair: "What the pair (將眼) is.",
  compound: "Several patterns holding at once.",
  meta: "For the plainest possible hands.",
  special: "Hands that aren't five melds and a pair.",
};

/** What each pattern asks of the hand. */
export const PATTERN_GUIDE: Record<string, string> = {
  "base-tai": "Every winning hand, whatever its shape.",
  "concealed-except-kongs": "No called (declared) run or triplet. An exposed kong doesn't break it.",
  kong: "Each kong held, exposed or concealed.",

  "no-flowers": "No flowers or seasons at all.",
  "correct-flower": "Each flower or season whose number matches your seat wind (東 1, 南 2, 西 3, 北 4).",
  "wrong-flower": "Each flower or season whose number doesn't match your seat wind.",

  "no-honors-no-flowers": "No honor tiles anywhere, and no flowers or seasons.",
  "no-honors": "No honor tiles anywhere in the hand.",
  "all-honors": "Every tile is an honor (winds and dragons only).",

  "wrong-seat-wind": "Each wind meld that isn't your seat wind.",
  "correct-seat-wind": "A meld of your own seat wind.",
  // UNCONFIRMED: worth 0 in the house list as a placeholder - the real value is still to come.
  "correct-round-wind": "A meld of the round wind.",
  "small-three-winds": "Melds of two winds, with a third wind as the pair.",
  "big-three-winds": "Melds of three different winds.",
  "small-four-winds": "Melds of three winds, with the fourth wind as the pair.",
  "big-four-winds": "Melds of all four winds.",

  "dragon-tile": "Each meld of a dragon (中, 發 or 白).",
  "small-three-dragons": "Melds of two dragons, with the third dragon as the pair.",
  "big-three-dragons": "Melds of all three dragons.",

  "all-runs": "All five melds are runs - no triplets or kongs.",
  "all-runs-no-honors-no-flowers": "All runs, with no honors and no flowers or seasons.",
  "all-triplets": "All five melds are triplets or kongs - no runs.",
  "five-concealed-triplets": "Five plain triplets, all concealed, won by self-draw.",

  "two-hidden-triplets": "Two concealed triplets (kongs count, exposed or not).",
  "three-hidden-triplets": "Three concealed triplets or kongs.",
  "four-hidden-triplets": "Four concealed triplets or kongs.",
  "five-hidden-triplets": "All five melds are concealed triplets or kongs.",
  "five-kongs": "All five melds are kongs.",

  "shanpon-wait": "Waiting on two pairs, and the winning tile turned one into a concealed triplet (對碰).",
  "genuine-single-wait": "Only one tile kind could have completed the hand.",
  "fake-single-wait": "The winning tile filled a narrow wait - the middle of a run (嵌張), the end of a 12 or 89 (邊張), or a pair (單吊) - though other tiles could have won too.",
  "visible-triple-win": "Won on a tile whose other three copies are already in your own declared melds.",
  "visible-exhausted-multi-wait": "A wait on several tiles, all but one already used up in your declared melds.",

  "self-draw": "You drew the winning tile yourself (自摸).",
  "concealed-self-draw": "Self-drawn with a concealed hand (門前清).",
  riichi: "叮 declared - waiting on your hand, committed to it.",
  "concealed-riichi": "叮 declared with a concealed hand (門前清).",
  "heavenly-riichi": "The dealer declared 叮 straight after their first discard, with a fully concealed hand.",
  "earthly-riichi": "Another player declared 叮 straight after their first discard, with a fully concealed hand.",
  // UNCONFIRMED: "one go-round" is the usual meaning of 一發; the house's exact window isn't recorded.
  "riichi-instant-win": "Won within one go-round of declaring 叮 (一發).",
  // UNCONFIRMED: what 食叮 means at this table isn't recorded - only that it counts without 叮.
  "riichi-eat": "食叮 declared - counts whether or not you declared 叮 yourself.",
  // UNCONFIRMED (四/七/十子內): whose discards count - everyone's, or the winner's own.
  "early-win-four": "Won while four or fewer tiles had been discarded.",
  "early-win-seven": "Won while seven or fewer tiles had been discarded.",
  "early-win-ten": "Won while ten or fewer tiles had been discarded.",
  "multi-win-double": "Two players won off the same discard (雙響).",
  "multi-win-triple": "Three players won off the same discard (三響).",
  "heavenly-win": "The dealer's starting hand was already complete (天胡), fully concealed.",
  // UNCONFIRMED (地胡/人胡): the house's definitions aren't recorded.
  "earthly-win": "地胡 declared - a win at the very start of the game, after 天胡 - with a fully concealed hand.",
  "human-win": "人胡 declared - a win at the very start of the game, after 地胡 - with a fully concealed hand.",
  "river-bottom-win": "Won by claiming the very last discard of the game (河底撈魚).",
  "sea-bottom-win": "Won by self-drawing the very last tile in the wall (海底撈月).",
  "sea-bottom-win-one-tong": "海底撈月, and that last tile was 一筒.",
  "flower-draw": "Each time a flower's replacement draw completed the hand (花摸).",
  "kong-draw": "Won on the replacement draw after a kong (槓摸), by how many kongs in a row.",
  "rob-kong": "Won by robbing a kong - claiming the tile another player added to a triplet (搶槓).",
  "dealer-streak": "Winning as dealer (莊), plus each consecutive dealer win before it (連莊).",
  "everyone-else-completes-it": "Every meld called, and won on a discard (全求人).",
  "half-everyone-else-completes-it": "Every meld called, and won by self-draw (半求人).",



  "consecutive-triplet-pair": "Two triplets or kongs at neighbouring ranks in one suit (e.g. 222 333).",
  "small-three-consecutive-triplets": "Three neighbouring ranks in one suit: two triplets and the pair at one end (e.g. 22 333 444).",
  "big-three-consecutive-triplets": "Three triplets or kongs at neighbouring ranks in one suit (e.g. 222 333 444).",
  "small-four-consecutive-triplets": "Four neighbouring ranks in one suit: three triplets and the pair (e.g. 22 333 444 555).",
  "big-four-consecutive-triplets": "Four triplets or kongs at neighbouring ranks in one suit (e.g. 222 333 444 555).",
  "small-five-consecutive-triplets": "Five neighbouring ranks in one suit: four triplets and the pair.",
  "big-five-consecutive-triplets": "Five triplets or kongs at neighbouring ranks in one suit - the whole hand.",
  "small-six-consecutive-triplets": "Six neighbouring ranks in one suit: five triplets and the pair - the whole hand.",
  "twin-consecutive-triplet-pairs": "Two separate 二連刻 sharing no rank (e.g. 222 333 and 777 888).",

  "cross-suit-same-run": "The same run in two different suits (e.g. 234萬 and 234筒).",
  "twin-cross-suit-runs": "Two separate 相逢, sharing no meld.",
  "full-cross-suit-runs": "Every meld is a run matched by the same run in another suit.",
  staircase: "Five runs whose starting ranks climb one at a time, in any suits (樓梯).",
  "rotating-staircase": "樓梯 with the suits either all the same, or rotating in a fixed order (五步高).",
  "cross-suit-same-triplet": "Triplets or kongs of the same rank in two suits (兩兄弟).",
  "small-three-color-consecutive-triplets": "Three neighbouring ranks, one in each suit: two triplets and the pair.",
  "big-three-color-consecutive-triplets": "Three neighbouring ranks, one in each suit, all triplets or kongs.",
  "small-three-brothers": "One rank in all three suits: two triplets and the pair.",
  "big-three-brothers": "One rank in all three suits, all triplets or kongs.",

  "half-flush": "One numbered suit only, with honors.",
  "full-flush": "One numbered suit only, no honors.",

  "old-young-run": "123 and 789 in the same suit, without the 456 that would make it 清龍.",
  "old-young-triplet": "Triplets or kongs of 1 and 9 in the same suit.",

  "mixed-common-rank": "One rank appears in every numbered meld and the pair (an honor pair is fine).",
  "mixed-common-rank-pair": "Two ranks appear in every numbered meld, with an honor pair.",
  "mixed-common-rank-triple": "Three ranks appear in every numbered meld, with an honor pair.",
  "pure-common-rank": "One rank in every meld and the pair, and no honors at all.",
  "mixed-terminal": "A 1 or 9 in every numbered meld and the pair, with honors somewhere in the hand.",
  "pure-terminal": "A 1 or 9 in every meld and the pair, and no honors.",
  "mixed-terminal-honor-triplets": "All triplets or kongs of 1s, 9s and honors, with at least one 1 or 9.",
  "pure-terminal-triplets": "All triplets or kongs of 1s and 9s only.",

  "missing-one-suit": "Only two of the three numbered suits, and no honors.",
  "small-five-suits": "Every category - 萬, 筒, 索, winds and dragons - somewhere in the hand, without a full meld of each.",
  "big-five-suits": "A full meld of each category: 萬, 筒, 索, a wind and a dragon.",
  "small-seven-suits": "小五門齊 plus at least one flower and one season.",
  "big-seven-suits": "大五門齊 plus at least one flower and one season.",

  "all-simples": "Every tile is 2 to 8 - no 1s, 9s or honors.",
  "no-fives": "No 5s and no honors anywhere.",
  "greater-than-five": "Every tile is 6 to 9.",
  "less-than-five": "Every tile is 1 to 4.",

  "middle-tile-pair": "The pair is a 2, 5 or 8 (not honors). In 嚦咕嚦咕, each such pair counts.",

  "three-treasures": "All at once: 缺五 or 大於五/小於五, plus 斷么, plus 清一色 or 缺一門.",

  "big-chicken": "Nothing else counts (besides what 大雞/大鴨 ignore), at most one flower, won on a discard.",
  "big-duck": "Nothing else counts (besides what 大雞/大鴨 ignore), at most one flower, won by self-draw.",

  "thirteen-orphans": "One of each 1 and 9 in every suit and all seven honors, one doubled as the pair, plus one ordinary meld.",
  "sixteen-unrelated": "All seven honors plus three unrelated ranks (each at least three apart) in every suit, one tile doubled as the pair.",
  "sixteen-unrelated-flying": "十六不搭 where the winning tile made the pair - a sixteen-way wait.",
  "sixteen-unrelated-same-ranks": "In 十六不搭: the same three ranks in every suit, with an honor pair.",
  "sixteen-unrelated-straight": "In 十六不搭: the three suits' ranks cover 1 to 9 between them, with an honor pair.",
  "eight-pairs": "Eight pairs, one turned into a triplet by the winning tile (four of a kind counts as two pairs).",
  "eight-pairs-flying": "嚦咕嚦咕 that was waiting on more than two tiles.",
  "eight-pairs-three-dragons": "In 嚦咕嚦咕: all three dragons present.",
  "eight-pairs-three-winds": "In 嚦咕嚦咕: three of the four winds present.",
  "eight-pairs-four-winds": "In 嚦咕嚦咕: all four winds present.",
};

/** A 明/暗 pair's description (taiCatalog.ts OPEN_CONCEALED_PAIRS) - one
 *  for both halves; which applies is the general 明/暗 rule. */
export const PAIR_GUIDE: Record<string, string> = {
  "four-returns-to-one": "A triplet plus a run holding the fourth copy of the same tile.",
  "four-returns-to-two": "The pair plus two runs, together holding all four copies of the pair's tile.",
  "four-returns-to-four": "Four runs that each hold one copy of the same tile.",
  "identical-sequences": "Two identical runs, same suit and ranks (般高).",
  "small-twin-identical-sequences": "Two of each of four ranks in a row, read as the pair plus two identical runs (e.g. 22 334455).",
  "triple-identical-sequences": "Three identical runs.",
  "quadruple-identical-sequences": "Four identical runs.",
  "two-separate-identical-sequences": "Two different pairs of identical runs (e.g. 123 123 and 678 678).",
  "same-suit-consecutive": "Three runs in one suit, each starting one higher (e.g. 123 234 345).",
  "same-suit-two-step": "Three runs in one suit, each starting two higher (e.g. 123 345 567).",
  "three-suit-same-run": "The same run in all three suits.",
  "four-suit-same-run": "The same run four times across all three suits.",
  "five-suit-same-run": "The same run five times across all three suits.",
  "three-color-step-up": "One run in each suit, their starting ranks climbing one at a time.",
  "pure-straight": "123, 456 and 789 in one suit (清龍).",
  "mixed-straight": "123, 456 and 789, each in a different suit (雜龍).",
  "orphans-four-return": "In 十三么 or 嚦咕嚦咕: all four copies of one tile. 明 when the last copy was a claimed winning tile, otherwise 暗.",
};

/** General rules, for the reference's closing page. */
export const GENERAL_RULES: { title: string; text: string }[] = [
  {
    title: "The best reading counts",
    text: "When a hand can be split into melds more than one way, it scores the way that's worth the most.",
  },
  {
    title: "明 open and 暗 concealed",
    text: "A meld is 明 if it was called, or if a claimed winning tile completed it. Otherwise it's 暗. A pattern marked 明 counts when any meld in it is open; 暗 only when all of them are concealed.",
  },
  {
    title: "Tiers: only the highest counts",
    text: "Within a tier (大三元 over 小三元 over 三元牌, for example), only the highest that applies is counted, unless the rule set lets the tiers stack.",
  },
  {
    title: "Replaces",
    text: "Some patterns replace others outside their tier: when both apply, the replaced one isn't counted. Anything not replaced adds up.",
  },
  {
    title: "Special hands",
    text: "十三么, 十六不搭 and 嚦咕嚦咕 aren't five melds and a pair, so only some patterns count on them. 底, the flowers, the situations and the waits always do; beyond those it depends on the hand, and 嚦咕嚦咕 allows the most (斷么, 清一色 and the like).",
  },
  {
    title: "Situations",
    text: "自摸, 叮, 莊 and the other situations are declared on the Scoring tab's 情況 buttons. They can't be seen in the tiles.",
  },
];
