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
| 底 (Base tai) | 5 | Always — applies unconditionally to every completed hand. | — | No shape requirement at all; this is the floor every hand starts from. |
| 門前清 (Concealed hand) | 5 | No declared run or triplet. An exposed kong (明槓/加槓) doesn't break this, only a declared run or triplet does. | — | There used to also be a stricter 門清 ("every meld concealed, kongs included") but that was scaffolding from the initial foundation work, never one of the user's own house rules, and was removed. |
| 槓 (Kong) | 2 each | Once per kong held, declared/exposed or concealed alike. | — | **Stacks** — up to 4 possible (one per tile kind quadded). Excluded by 五槓子. |

## Special hands

These don't fit the ordinary "5 melds + pair" shape at all, so they're detected up front in
`scoreParsedHand`, each via its own dedicated `scoreXxx` function that builds a purpose-fit
`ResolvedHand` rather than reusing the normal per-decomposition loop. 十三么 and 十六不搭 are true
short-circuits in practice (their tile shapes essentially never also admit a normal
melds+pair reading), but 嚦咕嚦咕 routinely does — see 嚦咕雙食 below for what happens when both
readings are simultaneously valid.

| Pattern | Tai | Criteria | Excludes | Notes |
|---|---|---|---|---|
| 十三么 (Thirteen Orphans) | 160 | All 13 orphan kinds (每個么九牌: 1/9 of each numbered suit, plus all 7 honors), one of them doubled as the pair, plus one ordinary meld (triplet or run) — 13 + 1 + 3 = 17 tiles. | — | Only recognized **fully concealed** (no declared melds at all) — reuses `mahjong.ts`'s own `isThirteenOrphansComplete`/`decomposeThirteenOrphans` (already relied on by the Calculator tab) rather than reimplementing the check. It **excludes 門前清** even though the shape trivially satisfies it (no declared melds) - 門前清 is about declared-meld structure, which is irrelevant here. It's otherwise **not** exclusive: 明/暗四歸, 混帶么, 混老頭, 自摸, and 獨獨 can all still apply, evaluated directly against the same special construction rather than through the normal per-decomposition loop. The `ResolvedHand` built for display represents each of the 12 unpaired orphan tiles as its own 1-tile "meld," a documented exception to the usual "exactly 5 melds" invariant, purely so the UI's Declared/Concealed breakdown has something to render. |
| 明四歸 (十三么: one kind held all 4 copies, open) | 5 | Applies only within a 十三么 hand: the "one ordinary meld" happens to be a triplet of an orphan kind that *also* shows up among the 12 singles — i.e. that kind is held all 4 copies (3 in the triplet, 1 as its normal single) — and the 食胡 tile completed that quad, not self-drawn. E.g. `19m19t19b1234567z777z1m` (13 orphan kinds, `1m` doubled as the pair, `7z` held 4 times) claimed on a `7z`. | — | A degenerate cousin of 明/暗四歸一: that pattern's 4th copy always sits in a *run* (only possible for numbered tiles); here the "4th copy" is just another single, since honors can never be part of a run at all — hence a separately-named pattern rather than reusing 四歸一's ids, even though the tai values (5/15) match. Works for numbered orphan tiles too (e.g. `9b`), not just honors. A quad on an orphan kind is structurally always *also* a triplet-of-orphan ordinary meld (the arithmetic only works out to 17 tiles that way), so 混老頭 below fires alongside this every time it does. |
| 暗四歸 (十三么: one kind held all 4 copies, concealed) | 15 | Same shape as 明四歸, but the quad wasn't completed by a claimed 食胡 tile (self-drawn, or no winning tile recorded, or the winning tile doesn't match the quad kind). | — | |
| 十六不搭 (Sixteen Unrelated Tiles) | 50 | All 7 honors, plus 3 mutually-unrelated ranks (no two within 3 of each other) from each of the 3 numbered suits — 16 distinct kinds, one doubled as the pair — 15 + 2 = 17 tiles. | — | Only recognized **fully concealed** (no declared melds at all), same as 十三么 — reuses `mahjong.ts`'s own `isSixteenUnrelatedComplete`/`decomposeSixteenUnrelated`. Unlike 十三么 there's no "ordinary meld" at all — every one of the 15 non-pair kinds becomes its own 1-tile "meld" in the display construction. Excluded by 十六不搭(十六飛) below when that applies. Not otherwise exclusive: 不搭三相逢, 不搭雜龍, 自摸, and 獨獨 can all still apply on top of it — see those rows below. |
| 十六不搭(十六飛) (16-way wait - the 食胡 tile completed the pair) | 60 | Same shape as 十六不搭, but the winning tile's kind is the one that ended up as the pair — meaning before it arrived, the hand was 16 genuinely unrelated singles with no pair formed at all, so *any* of the 16 kinds would have completed it (a 16-way wait, hence 十六飛). | 十六不搭 | Requires a 食胡 tile to be set (falls back to the base 50 tai otherwise, same as 獨獨). Detected by comparing the winning tile's kind against `hand.pair`, not by literally counting waits via `getWaits` (that would need re-deriving the pre-completion hand and calling it with the unusual "0 melds, 1 pair, 16 kinds" shape) — mathematically equivalent for this special hand, since the winning tile lands in the pair if and only if the pre-completion hand had no pair yet. |
| 不搭三相逢 (Same 3 ranks across all 3 suits) | 20 | The 3 unrelated ranks chosen are the *same* 3 ranks in all of m/t/b — e.g. `159m+159t+159b`. | — | **Additive bonus** — stacks with either 十六不搭 or 十六不搭(十六飛), not an alternative to them. Since this uses up all 9 numbered kinds with no repeats, the pair is necessarily one of the 7 honor kinds — a consequence of the shape, not a separately-checked condition. Mutually exclusive with 不搭雜龍 below by construction (the ranks' union can't be size 3 and size 9 at once), so no explicit exclude was needed between them. |
| 不搭雜龍 (Ranks span 1-9 across all 3 suits) | 20 | The 3 suits' unrelated ranks collectively cover 1-9 with no rank repeated across suits — e.g. `147m+258b+369t`. | — | **Additive bonus**, same framing as 不搭三相逢. Each suit already contributes exactly 3 distinct ranks in a valid 十六不搭 hand, so the ranks' union hitting all 9 possible values is only possible with zero overlap between suits. |
| 嚦咕嚦咕 (Eight Pairs / Liguligu) | 50 | 8 pairs of tile kinds (any suit/rank, mixed freely), one of them upgraded to a triplet by the 食胡 tile — 7×2 + 1×3 = 17 tiles. A kind held all 4 copies at once counts as 2 of the 8 pairs. | — | Only recognized **fully concealed**. Unlike 十三么/十六不搭, this one routinely **also** admits a normal melds+pair reading of the same 17 tiles (e.g. `123m123m123m123m` — 4 identical runs — also satisfies the per-kind-count check here); see 嚦咕雙食 below for what happens then, and the "special-hand-only" pattern-id exclusion list in `scoreParsedHand` for why this doesn't leak into an unrelated normal hand's score. Excluded by 嚦咕嚦咕八飛 when that applies. Not otherwise exclusive — see the "reused" table below for everything else that can stack on top. |
| 嚦咕嚦咕八飛 (More than 2 waits) | 60 | Same shape as 嚦咕嚦咕, but the pre-completion hand's 嚦咕嚦咕-*specific* wait count exceeds 2. | 嚦咕嚦咕 | The wait count here is **not** the general `getWaits` (that also counts completions via a totally unrelated normal-hand reading, which the user confirmed shouldn't factor in — a hand with a genuine 2-way 嚦咕嚦咕 wait turned out to also have several incidental normal-hand waits when checked with plain `getWaits`). Two rules instead: (1) if every kind in the pre-completion hand already sits at an **even** count (2 or 4 — a "clean" 8-pairs shape with nothing already tripled or dangling as a single), it's unconditionally treated as an 8-way wait, even if some of those kinds are already at all 4 copies and so can't literally be drawn again (e.g. `5555t7777t9999m1177z` only has 1z/7z left to literally draw, but still counts as 8 — verified against the user's own examples). (2) Otherwise, count how many of the 34 tile kinds — skipping any already at 4 copies — make `isEightPairsComplete(preTiles + candidate)` true when added; this recognizes only completions via the 嚦咕嚦咕 shape itself. Requires a 食胡 tile to be set (falls back to the base 50 tai otherwise). |
| 明四歸 / 暗四歸 (嚦咕嚦咕 context) | 5 / 15 | Reuses the same 明四歸/暗四歸 ids as 十三么's (see above) — a kind held all 4 copies at once counts as its own quad here too, open/concealed by the same 食胡-tile-match rule. | — | Structurally different detection from the 十三么 version (a 嚦咕嚦咕 quad is one 4-tile group, not a "triplet meld + matching single" split), so a dedicated `eightPairsQuadKind` finds it — `orphansQuadKind ?? eightPairsQuadKind` tries both in turn since the two special hands' fake-meld constructions differ. If more than one kind is held all 4 copies, whichever is found first is used. |
| 將眼 (嚦咕嚦咕 context) | 2 each | Every one of the 7 "pair" groups (not the upgraded triple) at rank 2, 5, or 8 (not honors) fires its own instance — **stacking**, unlike the normal single-pair version. A quad (4 copies, 2 of the 8 pairs) at a qualifying rank counts as 2 instances. | — | E.g. `2255m88t11224447766z` (pairs at 2m, 5m, 8t all qualify) scores 6 tai from this alone. |
| 斷么 / 缺五 / 大於五 / 小於五 / 缺一門 / 清老頭 / 混老頭 / 混一色 / 清一色 / 字一色 (嚦咕嚦咕 context) | *(unchanged)* | Same ids/tai/criteria as their normal-hand definitions (see Range restrictions, Suit coverage, Common rank, and Flush below) — reused as-is, not special-cased. | *(their own, per the normal-hand table entries — e.g. 清老頭 excludes 混老頭, 大於五/小於五 exclude 缺五)* | Every one of these conditions is either purely about the flat tile multiset already (斷么, 缺五, 大於五, 小於五, 缺一門, 混一色, 清一色, 字一色), or — for 清老頭/混老頭's "every meld is a triplet/kong" half — trivially true regardless here, since every group in this hand's display construction is tagged `"triplet"` no matter its actual tile count. Their exclude relationships are applied the same way the normal per-decomposition loop does, scoped to just this batch. |
| 三寶 (嚦咕嚦咕 context) | 40 | Same compound condition as the normal-hand version (see Compound patterns below): one of 缺五/小於五/大於五, 斷么, and one of 清一色/缺一門, all at once. | — | Reused as-is like the row above - its own condition is entirely `allHandTiles`/`numberedSuitsUsed`-based already, no meld structure involved. Additive, same as everywhere else it appears - stacks with its own constituents rather than excluding them. |
| 三元嚦咕 (嚦咕嚦咕: all 3 dragon kinds present) | 20 | All 3 dragon ranks (5z/6z/7z) present anywhere in the hand - as pairs, a triple, or a quad, no specific role required. | — | Half of 小三元's 40 tai, confirmed by the user against a worked example (`112233m22333t556677z` - all 3 dragons sitting as plain pairs, none upgraded to a triplet, none acting as "the pair" the way 小三元 itself requires) - the "small vs. big" distinction that normally hinges on meld/pair role doesn't structurally exist here, since every tile in an eight-pairs hand already belongs to some pair/triple/quad group. **Additive bonus**, stacks with 嚦咕嚦咕/嚦咕嚦咕八飛 and everything else. |
| 三風嚦咕 (嚦咕嚦咕: at least 3 wind kinds present) | 15 | At least 3 of the 4 wind ranks (1z-4z) present anywhere. | 四喜嚦咕 (below) | Half of 小三風's 30 tai, same "presence only" reasoning as 三元嚦咕. |
| 四喜嚦咕 (嚦咕嚦咕: all 4 wind kinds present) | 60 | All 4 wind ranks present anywhere. | — | Half of 小四喜's 120 tai. Excludes 三風嚦咕 (all 4 winds trivially includes "at least 3"). |
| 小五門齊 / 小七門齊 (嚦咕嚦咕 context) | 10 / 15 | Same "all 5 categories touched somewhere" condition as the normal-hand version (see Suit coverage below) — **no dedicated meld needed per category**. | — | The normal patterns' own score functions can't be reused directly here: their "not also 大 tier" guard (`categoriesWithFullMeld().size < 5`) assumes `hand.melds` holds genuine 3+-tile melds, but every group in a 嚦咕嚦咕 hand independently "covers" its own category, so that guard would never trip and 大五/七門齊 would wrongly fire instead. Dedicated presence-only helpers (`eightPairsSmallFiveSuitsTai`/`eightPairsSmallSevenSuitsTai`) are used instead, referencing the normal patterns' ids/names for display. |
| 自摸 / 獨獨 (嚦咕嚦咕 context) | 1 / 2 | Same as the 十三么 rows above. | 假獨 *(獨獨 only, never fires here)* | 獨獨's `getWaits`-based check is the *general* one (any hand type), not 嚦咕嚦咕八飛's narrow shape-specific count above — the two measure different things and can disagree on a given hand (e.g. a hand with a genuine 2-way 嚦咕嚦咕-specific wait might have a general wait count above 1, so 獨獨 correctly doesn't fire there). |
| 嚦咕雙食 (Same 17 tiles valid as both 嚦咕嚦咕 and an ordinary hand) | *(sum of both)* | When a hand is *simultaneously* a valid 嚦咕嚦咕 hand and a valid normal melds+pair hand — e.g. `112233m667788t777z55z` (either 3 identical-run pairs + a triplet + a pair, or 7 pairs + 1 triple) — both readings are scored independently and shown as two separate breakdowns in the summary tab, with the final total being their **sum**, not just the higher of the two. | — | `ScoreResult.second` carries the alternate reading's `{matched, hand}` when this applies; `total` already includes both. The combined result is added as one more candidate to the usual max-tai comparison (worth at least as much as either reading alone, so it naturally wins without needing to special-case the comparison itself). Only 嚦咕嚦咕-vs-normal overlap is handled this way — 十三么/十六不搭 essentially never admit a normal reading in practice, so this doesn't extend to them. |

## Bonus tiles (flowers/seasons)

| Pattern | Tai | Criteria | Excludes | Notes |
|---|---|---|---|---|
| 無花 (No flowers) | 2 | Zero bonus tiles in hand. | — | Excluded by 無字花 (and transitively by 無字花大平胡). |
| 正花 (Correct flower) | 2 each | Once per bonus tile (flower or season) whose rank equals your seat wind. | — | **Stacks** — up to 2 instances possible (the flower and the season for your wind position). |
| 爛花 (Wrong flower) | 2 each | Once per bonus tile (flower or season) whose rank does **not** equal your seat wind. | — | **Stacks.** Naturally disjoint from 無花/無字花 (both require zero bonus tiles), so no exclusion needed. |

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

## Completion shape (how the winning tile completes the hand)

Patterns in this category care about *how* the hand finished — the wait shape just before the
winning tile arrived, and/or whether it was self-drawn or claimed — rather than the finished
hand's meld shape. The wait-shape patterns (對碰/獨獨/假獨) read the 食胡 tile from
`GameContext.winningTile` the same way the [明/暗 concept](#the-明暗-openconcealed-concept) does;
the self-draw patterns (自摸 and everything below it) read `GameContext.selfDraw` directly.

| Pattern | Tai | Criteria | Excludes | Notes |
|---|---|---|---|---|
| 對碰 (Shanpon: dual-pair wait completed into a triplet) | 2 | The 食胡 tile landed in a **plain triplet** meld — e.g. tenpai on `44m+44t`, waiting for either pair to complete into a triplet. | — | Doesn't apply to kongs (that's not a pair-to-triplet completion) or when the winning tile instead completed a run. No self-draw restriction — the wait shape is what matters, not how it was won. A triplet's other 2 tiles are necessarily a pair right before the winning tile arrives, and the hand's actual pair is always a separate group by construction, so no separate "was there really a second pair" check is needed beyond "did the winning tile land in a triplet." |
| 獨獨 (Genuine single wait) | 2 | The pre-completion hand has **exactly one** tile kind that would complete it — computed by reusing the Calculator tab's own `getWaits` (kong melds excluded from the input and `meldsRequired` reduced accordingly, since kongs are already fixed and irrelevant to the wait). | 假獨 | Requires a 食胡 tile to be set (can't determine the pre-completion hand otherwise). Also applies to 十三么/十六不搭, unmodified — `getWaits` calls `isCompleteHand` per candidate tile, which already recognizes those special shapes as valid completions, so the true wait count comes out correct without any special-casing. 假獨 itself is *not* wired in for the special hands (not requested). |
| 假獨 (Fake single wait) | 2 | The 食胡 tile fills the **middle rank** of some run meld it belongs to (a kanchan/closed-wait shape) — e.g. `12334m` completed by `2m` can be read as `234m` (already complete) + `13m` waiting on `2m` only, even though the hand's *true* wait was also open to `5m` (`123m`+`34m`). | — | Checked directly against the meld list, not by exploring alternate decompositions: a duplicated rank can put the same tile kind in more than one meld at once (as in the `12334m` example, where `2m` sits in both `123m` and `234m`), so scanning every meld for "is this kind the middle rank here" already captures the alternate reading. This structural check also matches on a *genuine* kanchan wait (that's exactly what a kanchan is), so 獨獨 excludes it to keep the "genuine" and "fake" labels mutually exclusive on the same hand. |
| 自摸 (Self-drawn win) | 1 | `selfDraw` is true. | — | Excluded by 門清自摸. Also applies to 十三么/十六不搭 (門清自摸 itself never can, since both special hands exclude 門前清). |
| 門清自摸 (Self-drawn win while 門前清) | 3 | Self-drawn **and** 門前清 (see the Foundation section) both hold. | 自摸 | Upgrade of 自摸 - excludes it, but stacks with 門前清 itself (they measure different things: one about melds, one about how the tile arrived). |
| 全求人 (All melds declared, win claimed not self-drawn) | 30 | Every meld is declared/exposed (no concealed meld at all, kongs included) **and** the win wasn't self-drawn. | — | "No concealed kong" in the user's phrasing is redundant with "every meld declared" in this data model (a kong is only ever concealed or exposed, never a third state). |
| 半求人 (All melds declared, win self-drawn) | 15 | Same shape as 全求人, but self-drawn instead of claimed. | — | Mutually exclusive with 全求人 by construction (`selfDraw` can't be both), so no explicit exclusion either way. |
| 大雞 (Nothing but the base + at most one bonus tile) | 30 | No other named pattern would score for this hand, and at most 1 bonus tile is present. | — | Meta pattern: re-evaluates every other `PATTERNS` entry's raw score directly (not the already-filtered/excluded result) to check what *would* fire. Exempts only 底 itself and the bonus-tile patterns (正花/爛花/無花 - an allowed single bonus tile shouldn't disqualify this). Does **not** exempt 自摸/門清自摸: a self-drawn win is itself "a pattern detected," so 大雞 can never apply to a self-drawn hand - mirrors 全求人 requiring a claimed win. |
| 大鴨 (Nothing but the base + at most one bonus tile, self-drawn) | 15 | Same "nothing else fires" condition as 大雞, but self-drawn instead of claimed. | — | The self-drawn counterpart to 大雞 (mirrors 全求人/半求人) - mutually exclusive with 大雞 by construction, since being self-drawn always blocks 大雞 via 自摸. Its own exempt set specifically carves out 自摸/門清自摸 (since self-draw is exactly what it's checking for), so it stacks with them rather than being blocked. |

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
| 雙姊妹 (2 distinct 相逢 instances) | 5 | A flat bonus on top of 相逢, once per hand, when 2 *distinct* 相逢 instances exist — sharing no meld between them. E.g. `123m+123b` and `678t+678b`. | — | **Additive, not exclusive** — stacks with 相逢 itself (it's a bonus on top, not an alternative reading). A shape like `123m+123m+123t` only ever produces 1 相逢 instance in the first place (the 2nd `123m` has no 2nd `123t` to pair with), so it doesn't qualify — and even if 2 instances both reused the same meld, they wouldn't count as "distinct" either. |
| 全姊妹 (Every meld is part of a 相逢) | 20 | Every one of the hand's 5 melds is individually a run that shares its starting rank with some *other* run, in a different suit, somewhere in the hand — e.g. `123m+123m+123t+678b+678t` (both `123m`s count, since `123t` is a valid partner for either) or `345t+345t+345b+345b+345m`. | — | **Additive, not exclusive** — stacks with 相逢/雙姊妹 and fires independently of whether 相逢 itself ends up excluded (e.g. by 明/暗三/四/五相逢). This is a *per-meld existence* check, looser than the instance-counting used for 相逢's own stacking — a meld can "count" here even if the instance-counting algorithm wouldn't form a fresh stacking instance for it. A triplet/kong or honor meld can never satisfy this, so 全姊妹 implies an all-runs (平胡) hand. **Read "any meld... is part of a 相逢" in the user's phrasing as "every meld"** — matches both worked examples, where every single meld (not just one) qualifies; flag if that's not what was meant. |
| 樓梯 (5 runs, consecutive starting ranks, any suit) | 20 | All 5 melds are runs, and their starting ranks form 5 consecutive numbers (X..X+4) — suit is unrestricted (can repeat or vary freely across the 5 runs). E.g. `123t+234b+345t+456m+567m` (starts 1-5). | — | **Additive, not exclusive** — same "stacks with everything" framing as 雙/全姊妹, so it doesn't exclude 平胡 even though every 樓梯 hand is trivially also 平胡. Structurally can never overlap with 明/暗清龍/雜龍 (those need starts exactly 1, 4, *and* 7 simultaneously; 樓梯's 5-consecutive-start requirement can reach start 7 only from X=3, which excludes start 1), so no exclusion was needed between them either. |
| 五步高/全碟 (Stricter 樓梯: same suit or a fixed rotation) | 40 | Same 5-consecutive-starting-rank run shape as 樓梯, but reading the suits off in ascending-start order, they must either all match, or follow a fixed rotation: the first 3 positions are 3 different suits (one of each), the 4th repeats the 1st, and the 5th repeats the 2nd. E.g. `234t+345m+456b+567t+678m` → suits `t,m,b,t,m` (position 4 repeats `t`, position 5 repeats `m`) ✓. `234t+345m+456b+567m+678t` → `t,m,b,m,t` (position 4 is `m`, not `t`) ✗. | — | **Additive, not exclusive** — kept consistent with 樓梯/雙姊妹/全姊妹 (doesn't exclude 樓梯, even though every 五步高/全碟 hand is also a 樓梯); not explicitly confirmed either way, flag if it should exclude. |
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
| 混帶么 (Honor presence + terminal in every non-honor meld) | 40 | The hand has an honor presence (an honor meld, *or* the pair itself is honors) **and** every non-honor meld contains a terminal (rank 1 or 9). | — | Requires at least one non-honor meld — an all-honor hand (already 字一色) doesn't vacuously qualify. Also applies inside a 十三么 hand, unmodified: the 12 orphan singles are always non-honor-and-terminal already, so the check reduces to just the one real 3-tile "ordinary meld" — a terminal-containing run (e.g. `123m`) satisfies this, but a terminal *triplet* (e.g. `111m`) satisfies 混老頭 below too, which excludes this. |
| 全帶么 (No honors, terminal in every meld and the pair) | 80 | **No** honor meld and **no** honor pair, and every meld *and the pair itself* contains a terminal. | — | Mutually exclusive with 混帶么 by construction (that one requires honor presence). |
| 混老頭 (All triplets/kongs, terminals and/or honors) | 100 | Every meld is a triplet/kong, every tile in the hand (melds and pair) is a terminal (1/9) or an honor - the two may mix freely - **and at least one of those tiles is a terminal**, not honors only. | 混帶么, 全帶么 | Requires a terminal somewhere (meld or pair) so an all-honor hand (already 字一色) doesn't vacuously qualify too - same reasoning as 混帶么's own guard. Stacks with 對對胡/坎坎胡 (not excluded). Also applies inside a 十三么 hand, unmodified: fires whenever the one real "ordinary meld" is a triplet - terminal (`111m`) or honor (`777z`) alike, since every tile in an orphans hand is already terminal-or-honor by definition (and 十三么 always has terminals present regardless, so the new guard never blocks it there). Since that always means the triplet's kind is held 4 copies total (see 明/暗四歸 above), this and 四歸 fire together whenever either does. |
| 清老頭 (All triplets/kongs, terminals only) | 200 | Same shape, but **no** honors anywhere - terminals only. | 混帶么, 全帶么, 混老頭 | Every 清老頭 hand is trivially also a 混老頭 hand, so it's excluded here. Same "stacks with 對對胡/坎坎胡" note as above. |

## Suit coverage

| Pattern | Tai | Criteria | Excludes | Notes |
|---|---|---|---|---|
| 缺一門 (Missing one suit) | 10 | Exactly 2 of the 3 numbered suits (m/t/b) appear anywhere in the hand — the third is completely absent — **and** there's no honor tile anywhere in the hand, melds or pair. | — | Any honor presence disqualifies the hand, not just an honor pair — an honor *meld* (e.g. a wind/dragon triplet) alongside 2 non-honor suits still fails, even though the melds' suit-count alone would look like a match. |
| 小五門齊 (Small five suits complete) | 10 | All 5 categories (m, t, b, winds, dragons) are touched *somewhere* in the hand (melds or pair), but **not** every category has its own dedicated complete meld. | — | Excluded by 小七門齊. Mutually exclusive with 大五門齊 by construction (opposite full-meld condition). |
| 大五門齊 (Big five suits complete) | 15 | Every one of the 5 categories has its own dedicated complete meld — uses all 5 melds, one per category; pair can be anything. | — | Excluded by 大七門齊. |
| 小七門齊 (Small seven suits complete) | 15 | Same shape as 小五門齊, **plus** at least one flower **and** one season bonus tile present. | 小五門齊 | |
| 大七門齊 (Big seven suits complete) | 20 | Same shape as 大五門齊, **plus** at least one flower **and** one season bonus tile present. | 大五門齊 | |

## Range restrictions

| Pattern | Tai | Criteria | Excludes | Notes |
|---|---|---|---|---|
| 斷么 (All simples) | 10 | Every tile (melds and pair) is ranked 2–8 — no honors, no terminals (1 or 9). | — | |
| 缺五 (No fives) | 10 | No honor tile **and** no rank-5 tile in any numbered suit, anywhere in the hand. | — | Excluded by 大於五/小於五. |
| 大於五 (All 6–9) | 40 | Every tile (melds and pair) is a numbered tile ranked 6–9 — no honors, no ranks 1–5. | 缺五 | |
| 小於五 (All 1–4) | 40 | Every tile ranked 1–4 — no honors, no ranks 5–9. | 缺五 | |

## Pair shape

| Pattern | Tai | Criteria | Excludes | Notes |
|---|---|---|---|---|
| 將眼 (Pair is 2, 5, or 8 - not honors) | 2 | The hand's pair is rank 2, 5, or 8, and isn't an honor tile. | — | The honor exclusion matters because honor ranks overlap these numbers (e.g. rank 2 is also South wind) - the pair must be a genuine numbered tile. |

## Compound patterns

| Pattern | Tai | Criteria | Excludes | Notes |
|---|---|---|---|---|
| 三寶 (Range restriction + all-simples + suit purity/missing-one-suit) | 40 | All 3 at once: (1) one of 缺五/小於五/大於五, (2) 斷么, and (3) one of 清一色/缺一門. | — | **Additive, not exclusive** — a bonus that stacks with all 3 constituent patterns, same "stacks with everything" framing as 雙/全姊妹, 樓梯, and 五步高/全碟. Checked against each constituent's raw condition directly, same reasoning as 全姊妹. |

## Known gaps

- **Jokers** aren't supported by the scoring notation/UI at all yet (rejected with a clear error).
- **Added kong vs. called kong** aren't distinguished — both parse/score as a generic "exposed
  kong." Only matters for the rare robbing-the-kong (搶槓) pattern, not yet implemented.
- **十三么 with a declared meld isn't recognized**, even in the (very unusual) case where the
  "one ordinary meld" was called rather than held concealed — only the fully-concealed case is
  detected. Calling tiles doesn't help collect 13 different singles, so this shouldn't come up in
  practice, but it's an intentional scope cut, not a guarantee the shape is impossible.
- No point/currency conversion (base value, dealer doubling, caps) — this only totals tai.
- No dealer-status patterns yet, despite `GameContext` already tracking it (via `isDealer`).
- The 食胡-tile UI only lets you mark a tile in the **concealed** hand — there's no way to mark
  the winning tile as belonging to a declared meld (e.g. robbing a kong), since that scenario
  isn't relevant to any pattern implemented so far.
- **獨獨's wait-count can over-count available copies when a kong is also present.** It feeds only
  the non-kong tiles into `getWaits`, so `getWaits` can't see that some copies of the kong's rank
  are already locked away - a hand with both a kong and an independent wait on that exact same
  rank could think a tile is still available when it isn't. Rare in practice (needs a kong and a
  wait on the same rank at once); not worth the extra plumbing to fix yet.
- **嚦咕嚦咕 with a declared meld isn't recognized**, same intentional scope cut as 十三么/十六不搭
  above.
- **嚦咕雙食 only covers 嚦咕嚦咕-vs-normal overlap**, not 十三么/十六不搭-vs-normal (those pairs
  essentially never overlap in practice, so it wasn't requested) or 嚦咕嚦咕-vs-十三么/十六不搭
  (structurally impossible - the shapes are mutually exclusive at the tile-count level).
- **混帶么 was deliberately not wired into the 嚦咕嚦咕 context**, unlike 混老頭 - the user's list of
  "other patterns that fit the spirit" named 混老頭 but not 混帶么, and 混帶么's "every non-honor
  meld has a terminal" doesn't reduce as cleanly to a flat check for 嚦咕嚦咕 (there's no "ordinary
  meld" concept there the way 十三么 has one).

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
- **五步高/全碟 doesn't exclude 樓梯**, even though every 五步高/全碟 hand is also a 樓梯 - kept
  additive/stacking to match 樓梯/雙姊妹/全姊妹/三寶 (all explicitly confirmed or framed as "bonus"
  patterns by the user), but "a stricter version of 樓梯" could also have meant it should exclude
  樓梯 instead.
