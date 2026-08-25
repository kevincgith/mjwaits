# Scoring rules (tai/番)

Reference for the house tai list implemented in [`src/lib/scoring.ts`](../src/lib/scoring.ts)'s
`PATTERNS` array, built up one pattern at a time. This is **not** a generic/configurable ruleset —
see that file's module doc comment for why — just documentation for the concrete list currently
implemented, kept in sync as patterns are added or adjusted.

Every pattern is evaluated against a fully resolved hand: 5 melds (each a triplet, run, or kong,
each concealed or exposed) + 1 pair, plus whatever bonus tiles (flowers/seasons) were drawn. Where
a hand has more than one valid meld/pair decomposition, scoring picks whichever reading yields the
highest total tai.

**Exclusion**: when a pattern in the "Excludes" column matches the same hand, it's suppressed
(doesn't add its tai) in favor of the pattern that names it — this models "the bigger pattern
already prices in the smaller one," not a general limit on stacking. Patterns with no listed
relationship in either direction stack freely.

## The 明/暗 (open/concealed) concept

Several patterns below (兩/三/四/五暗刻, 明清龍/暗清龍, 明雜龍/暗雜龍) care not just about whether a
meld is a triplet/run, but whether it counts as genuinely **暗** (concealed/hidden) or **明**
(open) — a finer distinction than the meld's own `concealed` flag. A meld is **明** if either:

- it's a declared/exposed meld (called via pon/chi, or an exposed kong), **or**
- it's the meld that the **食胡 tile** (the tile that completed the hand — set via long-press on a
  concealed-hand tile in the Scoring tab, tied to the existing Self-draw toggle) happens to
  complete, **and** the win wasn't self-drawn. Claiming the last tile of an otherwise-concealed
  meld off a discard still makes that specific meld count as open, even though it was never
  "called" in the pon/chi sense.

Otherwise the meld is **暗**. With no 食胡 tile recorded, the second condition simply never fires
(only physical declaration disqualifies a meld). **Kongs are a special case** for the 暗刻 chain
specifically: a kong always counts toward it regardless of open/concealed status (see that
section) — the 明/暗 distinction there only applies to plain triplets.

## Duplicate-instance counting (清龍/雜龍/老少上/老少碰)

These four patterns can fire more than once on a single hand when a segment repeats — e.g.
`123m 456m 789m 789m` (an extra 789m) counts as **two** 清龍 instances, not one. The rule: look at
the melds matching each required segment (e.g. 清龍's three segments are 1-2-3, 4-5-6, 7-8-9 in one
suit). If every segment has at least one meld, the number of instances equals the **largest**
count among the segments — the segment(s) with only one copy get reused across every instance,
while each extra copy of whichever segment repeats forms its own separate instance. Each instance
is classified independently (open vs. concealed, for the patterns that split that way).

## Foundation

| Pattern | Tai | Criteria | Excludes | Notes |
|---|---|---|---|---|
| 門清 (Concealed hand) | 1 | Every meld is concealed (no exposed triplet/run/kong). A *concealed* kong doesn't break this — only a called/exposed one does. | — | Placeholder value carried over from the initial foundation work — **not yet confirmed** against house rules. |
| 槓 (Kong) | 2 each | Once per kong held, declared/exposed or concealed alike. | — | **Stacks** — up to 4 possible (one per tile kind quadded). Excluded by 五槓子. |
| 斷么 (All simples) | 10 | Every tile (melds and pair) is ranked 2–8 — no honors, no terminals (1 or 9). | — | |

## Bonus tiles (flowers/seasons)

| Pattern | Tai | Criteria | Excludes | Notes |
|---|---|---|---|---|
| 無花 (No flowers) | 2 | Zero bonus tiles in hand. | — | Excluded by 無字花 (and transitively by 無字花大平胡). |
| 正花 (Correct flower) | 2 each | Once per bonus tile (flower or season) whose rank equals your seat wind. | — | **Stacks** — up to 2 instances possible (the flower and the season for your wind position). |

## Suit purity

| Pattern | Tai | Criteria | Excludes | Notes |
|---|---|---|---|---|
| 無字花 (No honors, no flowers) | 10 | No honor tile anywhere (melds or pair) **and** no bonus tiles at all. | 無字, 無花 | Excluded by 無字花大平胡. |
| 無字 (No honors) | 2 | No honor tile anywhere (melds or pair). Bonus tiles irrelevant. | — | Excluded by 無字花. |
| 字一色 (All honors) | 160 | Every tile (melds and pair) is an honor. | — | |

## Wind melds (東南西北, 1z–4z)

A "wind meld" is any triplet or kong of a wind tile — kongs count the same as triplets here.

| Pattern | Tai | Criteria | Excludes | Notes |
|---|---|---|---|---|
| 爛位風 (Wrong seat wind) | 2 | Hand has a wind meld whose rank ≠ seat wind. | — | Excluded by 小三風/大三風/小四喜/大四喜. |
| 正位風 (Correct seat wind) | 2 | Hand has a wind meld whose rank = seat wind. | — | Same exclusion as above. |
| 爛圈風 (Wrong round wind) | 2 | Hand has a wind meld whose rank ≠ round wind. | — | Same exclusion as above. |
| 正圈風 (Correct round wind) | 2 | Hand has a wind meld whose rank = round wind. | — | Same exclusion as above. |
| 小三風 (Small three winds) | 30 | 2+ distinct wind melds, **and** the pair is the one remaining (4th) wind kind. | 爛位風, 正位風, 爛圈風, 正圈風 | |
| 大三風 (Big three winds) | 60 | 3+ distinct wind melds (pair unrestricted). | the 4 singles above, 小三風 | |
| 小四喜 (Small four winds) | 120 | 3+ distinct wind melds, **and** the pair is the one remaining (4th) wind kind. | the 4 singles, 小三風, 大三風 | |
| 大四喜 (Big four winds) | 160 | All 4 wind kinds each have a complete meld. | the 4 singles, 小三風, 大三風, 小四喜 | Pair is necessarily non-wind (no 5th wind kind exists). |

## Dragon melds (中發白, 5z–7z)

| Pattern | Tai | Criteria | Excludes | Notes |
|---|---|---|---|---|
| 三元牌 (Dragon meld) | 2 each | Once per dragon meld (triplet/kong) held. | — | **Stacks.** Excluded by 小三元/大三元. |
| 小三元 (Small three dragons) | 40 | 2 distinct dragon melds, **and** the pair is the one remaining (3rd) dragon kind. | 三元牌 | |
| 大三元 (Big three dragons) | 80 | All 3 dragon kinds each have a complete meld. | 三元牌, 小三元 | Pair is necessarily non-dragon (no 4th dragon kind exists). |

## Hand shape

| Pattern | Tai | Criteria | Excludes | Notes |
|---|---|---|---|---|
| 平胡 (All runs) | 5 | All 5 melds are runs — no triplet or kong anywhere. Pair unrestricted. | — | Excluded by 無字花大平胡. |
| 無字花大平胡 (All runs, no honors, no flowers) | 20 | Simultaneously 平胡 **and** 無字花 (all runs + no honors + no bonus tiles). | 平胡, 無字花 | Compound pattern - 無字花's own exclusion of 無字/無花 also cascades through once this fires, so none of the four smaller patterns count. |
| 對對胡 (All triplets) | 40 | All 5 melds are triplets or kongs — no runs anywhere. Pair unrestricted, concealed status irrelevant. | — | |
| 坎坎胡 (Five concealed triplets, self-draw) | 160 | All 5 melds are **plain triplets** (kongs not eligible here), all physically concealed, **and** the win is self-drawn. | 對對胡, 兩/三/四/五暗刻 (the whole chain) | "Special" pattern — excludes the whole 暗刻 chain, not just the two components it's built from. Since self-draw is required, the 明/暗 winning-tile carve-out never applies here (checking the meld's plain `concealed` flag is equivalent). |

## Concealed triplets/kongs (暗刻)

"Concealed" here means 暗 per the [明/暗 concept](#the-明暗-openconcealed-concept) above — except a
**kong always counts toward this chain regardless of open/concealed status**; only plain triplets
go through the full open/concealed check.

| Pattern | Tai | Criteria | Excludes | Notes |
|---|---|---|---|---|
| 兩暗刻 (Two concealed triplets/kongs) | 5 | ≥2 melds are a concealed triplet or any kong. | — | Excluded by 三/四/五暗刻. |
| 三暗刻 (Three concealed triplets/kongs) | 15 | ≥3. | 兩暗刻 | Excluded by 四/五暗刻. |
| 四暗刻 (Four concealed triplets/kongs) | 30 | ≥4. | 兩暗刻, 三暗刻 | Excluded by 五暗刻 and by 五槓子. |
| 五暗刻 (Five concealed triplets/kongs) | 80 | All 5. | 兩暗刻, 三暗刻, 四暗刻 | Excluded by 坎坎胡 and by 五槓子. |
| 五槓子 (Five kongs) | 240 | All 5 melds are kongs. | 槓, 四暗刻, 五暗刻 | Does **not** exclude 對對胡 (a kong still satisfies "triplet or kong," so it stacks). |

## Straights

明/暗 here means 明 = at least one meld in the instance is open, 暗 = every meld in the instance is
concealed — see the [明/暗 concept](#the-明暗-openconcealed-concept). All four patterns use
[duplicate-instance counting](#duplicate-instance-counting-清龍雜龍老少上老少碰).

| Pattern | Tai | Criteria | Excludes | Notes |
|---|---|---|---|---|
| 明清龍 (Pure straight, open) | 10 each | An instance of 1-2-3 + 4-5-6 + 7-8-9, all in **one suit**, where the instance is 明. | — | **Stacks per instance.** |
| 暗清龍 (Pure straight, concealed) | 20 each | Same shape, instance is 暗. | — | **Stacks per instance.** Mutually exclusive per-instance with 明清龍 (each instance is one or the other). |
| 明雜龍 (Mixed straight across suits, open) | 8 each | An instance of 1-2-3 + 4-5-6 + 7-8-9, each segment in a **different** suit (any suit-to-segment assignment), instance is 明. | — | **Stacks per instance**, across all 6 possible suit-role assignments. |
| 暗雜龍 (Mixed straight across suits, concealed) | 15 each | Same shape, instance is 暗. | — | **Stacks per instance.** |
| 老少上 (Terminal runs, 123 + 789) | 3 each | A 1-2-3 run and a 7-8-9 run in the **same suit** — but only if that suit doesn't *also* have a 4-5-6 run (that would be 清龍 instead). | — | **Stacks per instance** (2 segments, not 3 — no 明/暗 split). Self-contained condition rather than an explicit exclude against 清龍. |
| 老少碰 (Terminal triplets/kongs, 111 + 999) | 5 each | A rank-1 triplet/kong and a rank-9 triplet/kong in the same suit. | — | **Stacks per instance**, no 明/暗 split. In practice can't exceed 1 instance (a suit can only ever hold one rank-1 triplet-or-kong at a time), but uses the same general counting rule. |

## Suit coverage

| Pattern | Tai | Criteria | Excludes | Notes |
|---|---|---|---|---|
| 缺一門 (Missing one suit) | 10 | Exactly 2 of the 3 numbered suits (m/t/b) appear anywhere in the hand — the third is completely absent. Honors don't affect this. | — | |
| 小五門齊 (Small five suits complete) | 10 | All 5 categories (m, t, b, winds, dragons) are touched *somewhere* in the hand (melds or pair), but **not** every category has its own dedicated complete meld. | — | Excluded by 小七門齊. Mutually exclusive with 大五門齊 by construction (opposite full-meld condition). |
| 大五門齊 (Big five suits complete) | 15 | Every one of the 5 categories has its own dedicated complete meld — uses all 5 melds, one per category; pair can be anything. | — | Excluded by 大七門齊. |
| 小七門齊 (Small seven suits complete) | 15 | Same shape as 小五門齊, **plus** at least one flower **and** one season bonus tile present. | 小五門齊 | |
| 大七門齊 (Big seven suits complete) | 20 | Same shape as 大五門齊, **plus** at least one flower **and** one season bonus tile present. | 大五門齊 | |

## Range restrictions

| Pattern | Tai | Criteria | Excludes | Notes |
|---|---|---|---|---|
| 缺五 (No fives) | 10 | No honor tile **and** no rank-5 tile in any numbered suit, anywhere in the hand. | — | Excluded by 大於五/小於五. |
| 大於五 (All 6–9) | 40 | Every tile (melds and pair) is a numbered tile ranked 6–9 — no honors, no ranks 1–5. | 缺五 | |
| 小於五 (All 1–4) | 40 | Every tile ranked 1–4 — no honors, no ranks 5–9. | 缺五 | |

## Known gaps

- **門清's tai value (1) is a placeholder**, not yet confirmed against house rules.
- **Jokers** aren't supported by the scoring notation/UI at all yet (rejected with a clear error).
- **Added kong vs. called kong** aren't distinguished — both parse/score as a generic "exposed
  kong." Only matters for the rare robbing-the-kong (搶槓) pattern, not yet implemented.
- No point/currency conversion (base value, dealer doubling, caps) — this only totals tai.
- No dealer-status patterns yet, despite `GameContext` already tracking it (via `isDealer`).
- The 食胡-tile UI only lets you mark a tile in the **concealed** hand — there's no way to mark
  the winning tile as belonging to a declared meld (e.g. robbing a kong), since that scenario
  isn't relevant to any pattern implemented so far.
