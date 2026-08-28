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

- **門清's tai value (1) is a placeholder**, not yet confirmed against house rules.
- **No self-draw (自摸) or dealer-status patterns yet**, despite `GameContext` already tracking
  both - the house list given so far hasn't needed them.
- **No point/currency conversion** (base value, dealer doubling, caps) - this only totals tai.
- **Jokers aren't supported** in the scoring notation/UI at all yet.
- **Added kong vs. called kong** aren't distinguished (both score as a generic "exposed kong") -
  only matters for the rare robbing-the-kong (搶槓) pattern, not yet requested.
