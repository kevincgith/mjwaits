# Roadmap

Ideas for future work, roughly in the order they've come up. None of this is committed or scheduled — just a reference so context isn't lost between sessions.

## Camera-based tile input

Let the user point a camera at their hand and have tiles recognized automatically instead of tapping/typing every one.

- Not really "OCR" — tile faces aren't text, so this is an object-detection/classification problem: segmenting individual tiles from a held (angled, overlapping) hand, then classifying each against the ~40 tile designs (including jokers/flowers, which aren't part of any standard OCR or common tile-recognition training set).
- Would need either a pretrained/fine-tunable model (TensorFlow.js or ONNX running client-side, to keep the app a static/no-backend site) or a from-scratch dataset — the dataset is the hard part, so a relevant existing repo/model would be a meaningful head start if one turns up.
- Suggested first step, before any ML: camera feed (`getUserMedia`) + manual tap-to-crop-and-confirm per tile, to validate the input flow independent of recognition accuracy.

## Near-term fixes

Smaller and more concrete than the two feature ideas above.

- **Joker handling is incomplete outside the plain waits list.** Shanten, discard-efficiency, and discard-choice/complete-hand-breakdown analysis all currently bail out entirely when a hand contains jokers (see the `hasJokers` checks in `App.tsx` — no shanten badge, "Discard analysis isn't available yet for hands with jokers"). The plain waits list already shows what each joker resolves to for a given wait (the `joker-hint`, 🀪=tile); the fix is extending that same "what does the joker assume" resolution into shanten/discard-analysis/breakdown instead of just disabling them.
- **Rethink the Breakdown button further.** The current on/off toggle + `↔` order-icon split (see recent commits) is an improvement over the old 3-way text cycle, but isn't necessarily the final design.

## Scoring calculator (tai/fan)

Given a winning hand, calculate its actual score under Taiwanese 16-tile scoring rules, not just confirm it's complete.

- Biggest complexity driver isn't the individual scoring patterns (~30-40 named tai bonuses, each a fairly simple pattern check) — it's that Taiwanese scoring rules vary by table/region (different tai values, caps, which patterns count at all). Building a configurable/universal ruleset from day one is the trap; better to hard-code one concrete ruleset first and only generalize once that works end to end.
- Needs game context the app doesn't currently track: seat wind, round wind, self-draw vs. won-off-discard, flowers drawn, kongs declared, dealer status.
- `decomposeHand` currently returns *one* valid meld/pair decomposition; scoring needs *all* valid decompositions enumerated, since which decomposition you pick can change the tai total (e.g. a triplet read one way vs. folded into a run-based reading), and the correct score is the max over all valid readings.
