# Roadmap

Ideas for future work, roughly in the order they've come up. None of this is committed or scheduled — just a reference so context isn't lost between sessions.

## Camera-based tile input — shipped

Done: see the "Camera scan" section in [README.md](README.md) and
[training/README.md](training/README.md) for the model/pipeline details.
Currently deployed model is a fine-tuned YOLOv8n (nano), trained further on
real photos of a physical set after the base nano model (itself swapped in
from an earlier YOLOv8s) proved noticeably weaker on unseen tile designs
than its own validation metrics suggested. Ideas for extending the feature
further, not yet started:

- **Live camera feed instead of photo-then-crop**, using `getUserMedia`
  directly, if the photo-upload-and-crop flow turns out to be more friction
  than just pointing a live viewfinder at the hand.

## Near-term fixes

Smaller and more concrete than the two feature ideas above.

- **Joker handling is incomplete outside the plain waits list.** Shanten, discard-efficiency, and discard-choice/complete-hand-breakdown analysis all currently bail out entirely when a hand contains jokers (see the `hasJokers` checks in `App.tsx` — no shanten badge, "Discard analysis isn't available yet for hands with jokers"). The plain waits list already shows what each joker resolves to for a given wait (the `joker-hint`, 🀪=tile); the fix is extending that same "what does the joker assume" resolution into shanten/discard-analysis/breakdown instead of just disabling them.
- **Rethink the Breakdown button further.** The current on/off toggle + `↔` order-icon split (see recent commits) is an improvement over the old 3-way text cycle, but isn't necessarily the final design.

## Scoring calculator (tai/番) — foundation shipped, patterns in progress

The Scoring tab scores a complete hand against a concrete house tai list, built up one pattern
at a time rather than as a configurable/universal ruleset (confirmed as the right call - see
[`src/lib/scoring.ts`](src/lib/scoring.ts)'s module doc comment). 27 patterns implemented so
far; see [docs/scoring-rules.md](docs/scoring-rules.md) for the full list with tai values,
criteria, and exclusions.

When the concealed hand is exactly one tile short, the Scoring tab now reuses the waits
calculator's `getWaits` on the concealed tiles and shows, per wait, the score the whole hand
would land on if that tile completed it (each wait taken as its own 食胡 tile) - a collapsible
tai-descending list. Kept deliberately narrow: no jokers (the scoring picker can't enter one)
and no concealed kongs (the exact-size score gate already excludes those).

Still open:

- **Tai values, exclusions and special-hand inclusions are editable** in the Scoring tab's 設定
  sheet (see docs/scoring-rules.md, "Rule classification and customisation"). The frozen
  `scoringLegacy.ts` copy can be retired once the configurable engine has proven itself.
- **Rule sets travel by their own link or file** (設定 → Share / Export), not with a hand link - a
  shared hand opens under the receiver's own rules - and the Scores tab's backup doesn't include them.
- **No self-draw (自摸) or dealer-status patterns yet**, despite `GameContext` already tracking
  both - the house list given so far hasn't needed them.
- **No point/currency conversion** (base value, dealer doubling, caps) - this only totals tai.
- **Jokers aren't supported** in the scoring notation/UI at all yet.
- **Added kong vs. called kong** aren't distinguished (both score as a generic "exposed kong") -
  only matters for the rare robbing-the-kong (搶槓) pattern, not yet requested.

## Needs clarification (rules reference wording)

設定 → Export PDF prints a plain-language description of every pattern
([`src/lib/patternGuide.ts`](src/lib/patternGuide.ts)). Most come straight from the house rules
already given, but these aren't pinned down - the scorer only knows them as a declared 情況 button
or a placeholder - so the printed wording is neutral or a best guess (each is marked `UNCONFIRMED`
in that file). Confirm the definitions and the text can be made exact:

- **食叮** - what it means at this table. Only known: it counts with or without 叮 being declared.
- **地胡 / 人胡** - the house definitions (who wins, on which tile, how early). Printed as "a win at
  the very start of the game, after 天胡 / 地胡".
- **一發** - the exact window after declaring 叮. Printed as "within one go-round".
- **四子內 / 七子內 / 十子內** - whether the count is every player's discards or only the winner's.
  Printed as "four or fewer tiles had been discarded".
- **正圈風** - worth 0 as a placeholder; the real value hasn't been given.
- **設定 examples and descriptions still to fix** (reported, not yet done):
  - **明絕** - description should say the other three copies are in your own declared melds, *or*
    seen elsewhere and declared with the 明絕 button; its example uses that manual button on a hand
    whose declared melds are unrelated winds, so it shows nothing - pick an auto-detected hand (e.g.
    declared 333萬 + concealed 345萬, won on 3萬) and show the declared copies.
  - **絕絕** - description is vague; its example should show the waiting shape, the declared melds
    holding the waiting tiles, and the wait list (as 假獨/獨獨 now do).
  - **對碰** - its example shows only the finished triplet; it should show the two pairs it was
    waiting on (the completed triplet plus the pair) and the wait list.
- Still open from [docs/scoring-rules.md](docs/scoring-rules.md) ("Assumptions made without
  explicit confirmation"): whether the 三色連刻 / 三色步步高 / 三兄弟 families really never replace one
  another. (二連刻 / 小三連刻 stacking is settled: 連刻 are now tiers.)