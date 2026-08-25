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

**Notation note on 4-of-a-kind**: typing 4 copies of a rank in the concealed portion (e.g.
`222234t`) doesn't automatically mean a concealed kong — it might instead be a triplet plus one
tile borrowed into an adjacent run (`222` + `234`). Both readings are tried during decomposition,
and whichever is actually valid (or scores higher, if both are) wins. This only matters for the
text-notation path (`scoreHand`/`parseScoringHand`, used in tests) — the Scoring tab's UI always
declares kongs explicitly via 門前牌區, so this ambiguity never comes up there.

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

## Duplicate-instance counting (清龍/雜龍/老少上/老少碰/步步高/二步高)

These patterns can fire more than once on a single hand when a segment repeats — e.g.
`123m 456m 789m 789m` (an extra 789m) counts as **two** 清龍 instances, not one. The rule: look at
the melds matching each required segment (e.g. 清龍's three segments are 1-2-3, 4-5-6, 7-8-9 in one
suit; 步步高's are 3 consecutive starting ranks; 二步高's are 3 starting ranks 2 apart). If every
segment has at least one meld, the number of instances equals the **largest** count among the
segments — the segment(s) with only one copy get reused across every instance, while each extra
copy of whichever segment repeats forms its own separate instance. Each instance is classified
independently (open vs. concealed, for the patterns that split that way). All of these share one
`combineSegments` helper in the code.

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
| 正圈風 (Correct round wind) | 0 | Hand has a wind meld whose rank = round wind. | — | **Placeholder** — kept in the list (and still wired into the exclusion chain below) but worth 0 tai for now. 爛圈風 (the wrong-round-wind counterpart) was removed entirely rather than zeroed the same way. |
| 小三風 (Small three winds) | 30 | 2+ distinct wind melds, **and** the pair is the one remaining (4th) wind kind. | 爛位風, 正位風, 正圈風 | |
| 大三風 (Big three winds) | 60 | 3+ distinct wind melds (pair unrestricted). | the singles above, 小三風 | |
| 小四喜 (Small four winds) | 120 | 3+ distinct wind melds, **and** the pair is the one remaining (4th) wind kind. | the singles, 小三風, 大三風 | |
| 大四喜 (Big four winds) | 160 | All 4 wind kinds each have a complete meld. | the singles, 小三風, 大三風, 小四喜 | Pair is necessarily non-wind (no 5th wind kind exists). |

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

## Four returns (四歸一/二/四)

The hand holds **all 4 copies** of some rank X (one suit), split across melds a different way each
time rather than as a kong. 明/暗 here means 明 = at least one of the melds involved is open, 暗 =
all of them are concealed — see the [明/暗 concept](#the-明暗-openconcealed-concept). The pair
itself is never "declared," so it never factors into the openness check (only 四歸二 involves the
pair at all, and only to identify which rank/suit is in play).

| Pattern | Tai | Criteria | Excludes | Notes |
|---|---|---|---|---|
| 明四歸一 (Triplet + run, open) | 5 each | A triplet of X plus a run containing X (3 + 1 = the 4 copies), instance is 明. E.g. `123m222m` — the 4th 2m is in the run. | — | **Stacks** — different ranks/suits can each independently form their own pair, hand-size permitting. |
| 暗四歸一 (Triplet + run, concealed) | 15 each | Same shape, instance is 暗. | — | **Stacks.** |
| 明四歸二 (Pair + 2 runs, open) | 15 | The pair itself is X, plus 2 runs each containing X (2 + 1 + 1 = the 4 copies), instance is 明. | — | At most 1 instance — a hand only has one pair. |
| 暗四歸二 (Pair + 2 runs, concealed) | 30 | Same shape, instance is 暗. | — | At most 1 instance. |
| 明四歸四 (4 runs, open) | 30 | 4 separate runs, each containing X (1×4 = the 4 copies), instance is 明. | — | At most 1 instance — needs 4 of the hand's 5 melds. Doesn't exclude 般高 even though such a group usually contains an identical-run pair too (not yet confirmed whether it should). |
| 暗四歸四 (4 runs, concealed) | 60 | Same shape, instance is 暗. | — | At most 1 instance. Same open note as above. |

## Identical & ascending sequences

明/暗 again means 明 = at least one meld in the instance is open, 暗 = all are concealed. Several of
these use [duplicate-instance counting](#duplicate-instance-counting-清龍雜龍老少上老少碰步步高二步高).

| Pattern | Tai | Criteria | Excludes | Notes |
|---|---|---|---|---|
| 明般高 (Identical sequences, open) | 5 each | 2 runs that are exact duplicates (same suit, same 3 ranks), instance is 明. | — | **Stacks per instance.** |
| 暗般高 (Identical sequences, concealed) | 8 each | Same shape, instance is 暗. | — | **Stacks per instance.** |
| 明小雙般高 (Twin sequences, pair at one end, open) | 10 | E.g. `22334455m` — 2 copies each of 4 consecutive ranks. The pair can be read as *either* end (22 + two 345 runs, or 55 + two 234 runs) — both are genuinely valid decompositions, so scoring just checks whichever pair the current reading actually has against both directions and lets max-tai surface the better one. | 明般高, 暗般高 | At most 1 instance (one pair per hand). |
| 暗小雙般高 (same, concealed) | 15 | Same shape, instance is 暗. | 明般高, 暗般高 | |
| 明真雙般高 (2 separate identical-sequence pairs, open) | 20 | Two *different* 般高 pairs at once (4 runs total, 2 shapes) — e.g. `123123m + 678678t`. | 明般高, 暗般高 | |
| 暗真雙般高 (same, concealed) | 40 | Same shape, instance is 暗. | 明般高, 暗般高 | |
| 明一色三同順 (3 identical sequences, open) | 30 each | 3 fully identical runs (same suit, same 3 ranks). | — | Excludes 般高 (a 3-identical group contains an identical-run pair too). At most 1 group of 3 per rank/suit (4-copy cap). |
| 暗一色三同順 (same, concealed) | 60 each | Same shape, instance is 暗. | — | Same exclusion note. |
| 明一色四同順 (4 identical sequences, open) | 80 each | 4 fully identical runs — the maximum possible. | — | Excludes 般高 and 一色三同順 (both open/concealed). |
| 暗一色四同順 (same, concealed) | 160 each | Same shape, instance is 暗. | — | Same exclusion note. |
| 明單色步步高 (3 ascending sequences, gap 1, open) | 15 each | 3 same-suit runs at consecutive starting ranks — e.g. `123m+234m+345m`. | — | **Stacks per instance** — an extra `345m` reuses the shared `123m`/`234m` and forms a 2nd instance. |
| 暗單色步步高 (same, concealed) | 30 each | Same shape, instance is 暗. | — | **Stacks.** |
| 明單色二步高 (3 sequences, gap 2, open) | 8 each | 3 same-suit runs 2 apart — e.g. `123m+345m+567m`. | — | **Stacks per instance**, same duplicate-segment logic. |
| 暗單色二步高 (same, concealed) | 15 each | Same shape, instance is 暗. | — | **Stacks.** |

## Consecutive triplets

| Pattern | Tai | Criteria | Excludes | Notes |
|---|---|---|---|---|
| 二連刻 (2 consecutive triplets/kongs) | 5 each | 2 triplets/kongs at consecutive ranks in one suit (e.g. `222m+333m`, triplet/kong mixed freely). No 明/暗 split. | — | **Stacks per adjacent pair** — 3 consecutive triplets (`222+333+444`) counts as 2 instances. |
| 小三連刻 (3 consecutive ranks, pair at one end) | 15 | 3 consecutive ranks in one suit where the hand's pair sits at one end and the other 2 are triplets/kongs — e.g. `22m+333m+444m`. | — | Structurally different from 大三連刻 (needs the pair), so not mutually exclusive with it. |
| 大三連刻 (3 consecutive triplets/kongs) | 30 | Same 3-consecutive-rank shape, but all 3 are full triplets/kongs — pair not involved. | — | |

## Cross-suit patterns

These are the cross-suit versions of several single-suit patterns above (相逢/相逢's higher tiers
mirror 般高/一色三同順/一色四同順's "identical run" idea but across suits instead of within one;
兩兄弟/小三兄弟/大三兄弟 mirror 二連刻/小三連刻/大三連刻's triplet grouping but by same rank across
suits instead of consecutive ranks in one suit; 小/大三色連刻 are the direct 3-suit extension of
小/大三連刻; 明/暗三色步步高 is the 3-suit extension of 明/暗單色步步高). 明/暗 splits use the same
convention as elsewhere: 明 = at least one meld in the group is open, 暗 = all are concealed — see
the [明/暗 concept](#the-明暗-openconcealed-concept).

| Pattern | Tai | Criteria | Excludes | Notes |
|---|---|---|---|---|
| 相逢 (Same run, different suits) | 3 each | 2 runs with the same 3 ranks but in different suits — e.g. `234m+234t`. No 明/暗 split. | — | **Stacks per instance**, paired by suit-index so a within-suit duplicate (a 般高 concern) doesn't get double-counted as 相逢 against itself. |
| 明三相逢 (Same run in all 3 suits, open) | 10 | All 3 suits have a run at the same rank — e.g. `567m+567t+567b` — instance is 明. | 相逢 | |
| 暗三相逢 (same, concealed) | 20 | Same shape, instance is 暗. | 相逢 | |
| 明四相逢 (4 runs across all 3 suits, one suit doubled, open) | 40 | The 3-suit group plus one extra run in whichever suit has it twice — e.g. `456m456m456t456b` — instance is 明. | 相逢, 明三相逢, 暗三相逢 | |
| 暗四相逢 (same, concealed) | 80 | Same shape, instance is 暗. | 相逢, 明三相逢, 暗三相逢 | |
| 明五相逢 (5 runs across all 3 suits, open) | 80 | All 3 suits present with 5 runs total spread across them however they fall (2+2+1, 3+1+1, etc.) — e.g. `234234m234234t234b` or `234234234m234t234b` — instance is 明. | 相逢, 明/暗三相逢, 明/暗四相逢 | |
| 暗五相逢 (same, concealed) | 160 | Same shape, instance is 暗. | 相逢, 明/暗三相逢, 明/暗四相逢 | |
| 兩兄弟 (Same triplet/kong rank, different suits) | 5 each | 2 triplets/kongs at the same rank but different suits — e.g. `555t+555b`. No 明/暗 split. | — | **Stacks per instance**, same suit-index pairing as 相逢. |
| 小三兄弟 (Same rank across 3 suits, pair at one) | 20 | One rank held as the pair (in its own suit), with the other 2 suits each holding a triplet/kong at that *same* rank — e.g. `33t+333m+3333b`. | 兩兄弟 | Structurally different from 大三兄弟 (needs the pair), so not mutually exclusive with it — same precedent as 小/大三連刻. |
| 大三兄弟 (Same rank across all 3 suits, all triplets/kongs) | 40 | All 3 suits hold a triplet/kong at the same rank — e.g. `555m+555t+555b`. Pair not involved. | 兩兄弟 | |
| 小三色連刻 (3 consecutive ranks across 3 suits, pair at one) | 10 | 3 consecutive ranks, one per suit, with the hand's pair sitting at one of the 3 positions (in its own suit) and the other 2 positions each a triplet/kong in one of the other 2 suits — e.g. `33m+444t+555b`. | — | Structurally different from 大三色連刻 (needs the pair), not mutually exclusive. |
| 大三色連刻 (3 consecutive ranks across 3 suits, all triplets/kongs) | 20 | Same 3-consecutive-rank shape, but all 3 are full triplets/kongs, one per suit — pair not involved — e.g. `333t+4444m+555b`. | — | |
| 明三色步步高 (3 suits, runs increasing by 1, open) | 5 | 3 suits, each holding one run, with the runs' starting ranks increasing by 1 across suits in some order — e.g. `456t+567m+678b` or `234m+345t+456b`. Instance is 明. | — | |
| 暗三色步步高 (same, concealed) | 10 | Same shape, instance is 暗. | — | |

## Flush

| Pattern | Tai | Criteria | Excludes | Notes |
|---|---|---|---|---|
| 混一色 (One numbered suit + honors) | 40 | The hand uses exactly one numbered suit (m/t/b) — honors may mix in freely. | — | Excluded by 清一色. |
| 清一色 (One numbered suit, no honors) | 120 | Same, but **no** honors anywhere. | 混一色 | |

## Straights

明/暗 here means 明 = at least one meld in the instance is open, 暗 = every meld in the instance is
concealed — see the [明/暗 concept](#the-明暗-openconcealed-concept). All four patterns use
[duplicate-instance counting](#duplicate-instance-counting-清龍雜龍老少上老少碰步步高二步高).

| Pattern | Tai | Criteria | Excludes | Notes |
|---|---|---|---|---|
| 明清龍 (Pure straight, open) | 10 each | An instance of 1-2-3 + 4-5-6 + 7-8-9, all in **one suit**, where the instance is 明. | — | **Stacks per instance.** |
| 暗清龍 (Pure straight, concealed) | 20 each | Same shape, instance is 暗. | — | **Stacks per instance.** Mutually exclusive per-instance with 明清龍 (each instance is one or the other). |
| 明雜龍 (Mixed straight across suits, open) | 8 each | An instance of 1-2-3 + 4-5-6 + 7-8-9, each segment in a **different** suit (any suit-to-segment assignment), instance is 明. | — | **Stacks per instance**, across all 6 possible suit-role assignments. |
| 暗雜龍 (Mixed straight across suits, concealed) | 15 each | Same shape, instance is 暗. | — | **Stacks per instance.** |
| 老少上 (Terminal runs, 123 + 789) | 3 each | A 1-2-3 run and a 7-8-9 run in the **same suit** — but only if that suit doesn't *also* have a 4-5-6 run (that would be 清龍 instead). | — | **Stacks per instance** (2 segments, not 3 — no 明/暗 split). Self-contained condition rather than an explicit exclude against 清龍. |
| 老少碰 (Terminal triplets/kongs, 111 + 999) | 5 each | A rank-1 triplet/kong and a rank-9 triplet/kong in the same suit. | — | **Stacks per instance**, no 明/暗 split. In practice can't exceed 1 instance (a suit can only ever hold one rank-1 triplet-or-kong at a time), but uses the same general counting rule. |

## Common rank

| Pattern | Tai | Criteria | Excludes | Notes |
|---|---|---|---|---|
| 混帶X (Common rank across every non-honor meld) | 30 | There's some single rank 1–9 that every *non-honor* meld in the hand contains a tile of, **and** the pair also contains that rank (or the pair is itself honors). E.g. `123234345m333b123t11z` — every meld contains a 3, and the pair (`11z`) is honors so it's exempt. | — | Excluded by 混帶XY. Honor melds are exempt from the rank check (no numeric rank to match); the pair must either match the shared rank too or be honors — a non-honor pair that doesn't match the rank fails the whole pattern. A hand with zero non-honor melds (e.g. 字一色) doesn't vacuously qualify. |
| 混帶XY (Common rank pair across every non-honor meld) | 50 | There's some pair of distinct ranks that every non-honor meld contains *both* of, **and** the pair contains one of those two ranks (or is itself honors). E.g. `123234m123t123b11122z` — every meld contains a 2 and a 3. | 混帶X | Same exemptions as 混帶X (honor melds exempt from the rank check; pair must match one of the shared ranks or be honors). |
| 混帶XYZ (Common rank triple across every non-honor meld) | 60 | There's some triple of distinct ranks every non-honor meld contains all of, **and** the pair contains one of the three ranks (or is itself honors). E.g. `123m123b123m11122233z` — every meld contains 1, 2, and 3. | 混帶XY | A run always has exactly 3 distinct ranks, so a hand with only a *single* non-honor meld still qualifies trivially (using that meld's own 3 ranks) — but a lone triplet/kong (only 1 distinct rank) never can. Same pair rule as 混帶X/XY. |
| 全帶X (Common rank across every meld and the pair, no honors) | 120 | The ultimate extension: **no** honor meld and **no** honor pair, and every meld *and the pair itself* all contain the same rank X. E.g. `123234m222234t123b22b` — everything contains a 2 (`222234t` splits as triplet 222 + run 234, not a kong — see the notation note below). | 混帶X | |
| 混帶么 (Honor presence + terminal in every non-honor meld) | 40 | The hand has an honor presence (an honor meld, *or* the pair itself is honors) **and** every non-honor meld contains a terminal (rank 1 or 9). | — | Requires at least one non-honor meld — an all-honor hand (already 字一色) doesn't vacuously qualify. |
| 全帶么 (No honors, terminal in every meld and the pair) | 80 | **No** honor meld and **no** honor pair, and every meld *and the pair itself* contains a terminal. | — | Mutually exclusive with 混帶么 by construction (that one requires honor presence). |
| 混老頭 (All triplets/kongs, terminals and/or honors) | 100 | Every meld is a triplet/kong, and every tile in the hand (melds and pair) is a terminal (1/9) or an honor - the two may mix freely. | 混帶么, 全帶么 | Stacks with 對對胡/坎坎胡 (not excluded). |
| 清老頭 (All triplets/kongs, terminals only) | 200 | Same shape, but **no** honors anywhere - terminals only. | 混帶么, 全帶么, 混老頭 | Every 清老頭 hand is trivially also a 混老頭 hand, so it's excluded here. Same "stacks with 對對胡/坎坎胡" note as above. |

## Suit coverage

| Pattern | Tai | Criteria | Excludes | Notes |
|---|---|---|---|---|
| 缺一門 (Missing one suit) | 10 | Exactly 2 of the 3 numbered suits (m/t/b) appear anywhere in the hand — the third is completely absent — **and** the pair itself is not honors. | — | An honor pair disqualifies the hand even if the melds only touch 2 suits: the shape has to be "2 suits, eyes included," not 2 suits in the melds with honor eyes sitting outside it. |
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

### Assumptions made without explicit confirmation (flag if wrong)

A batch of patterns went in quickly enough that a few exclusion/stacking decisions were made by
inference from precedent rather than direct confirmation - implemented and tested either way, but
worth double-checking:

- **明/暗四歸四 doesn't exclude 般高**, even though a 4-runs-all-containing-X group usually also
  contains an identical-run pair (e.g. two `234m`s) that would independently satisfy 般高 too.
  Every other "bigger pattern absorbs the smaller ones it's built from" case in this list does
  exclude - this one was left alone only because it wasn't explicitly mentioned.
- **清一色 excludes 混一色** - inferred from the same "pure version subsumes the mixed version"
  pattern as 清老頭/混老頭, not separately confirmed.
- **小三連刻 and 大三連刻 don't exclude each other** - reasoned as structurally different (one
  needs the pair, one doesn't), not confirmed.
- **二連刻 stacks** (3 consecutive triplets = 2 instances) - inferred from the same precedent as
  老少上/二步高 rather than stated outright for this specific pattern.
- **小/大三色連刻, 明/暗三色步步高, and 小/大三兄弟 don't exclude each other across families**
  (e.g. 小三色連刻 doesn't exclude 兩兄弟) - they check different shapes (consecutive vs. same
  rank, triplet vs. run) that can't structurally overlap, so no exclusion was added between them.
