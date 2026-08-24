# Roadmap

Ideas for future work, roughly in the order they've come up. None of this is committed or scheduled — just a reference so context isn't lost between sessions.

## Camera-based tile input — shipped

Done: see the "Camera scan" section in [README.md](README.md) and
[training/README.md](training/README.md) for the model/pipeline details.
Ideas for extending it, not yet started:

- **Model picker.** A YOLOv8n ("nano") model is being trained on the same
  merged dataset alongside the deployed YOLOv8s ("small") one, so a visitor
  could pick nano (smaller download, faster inference, likely lower
  accuracy) vs. small (current default). Would need `vision.ts` to accept a
  model path/name instead of a hardcoded one, a small UI control to choose
  before scanning, and probably a persisted preference (localStorage) so
  it's not re-chosen every scan.
- **Live camera feed instead of photo-then-crop**, using `getUserMedia`
  directly, if the photo-upload-and-crop flow turns out to be more friction
  than just pointing a live viewfinder at the hand.

## Near-term fixes

Smaller and more concrete than the two feature ideas above.

- **Joker handling is incomplete outside the plain waits list.** Shanten, discard-efficiency, and discard-choice/complete-hand-breakdown analysis all currently bail out entirely when a hand contains jokers (see the `hasJokers` checks in `App.tsx` — no shanten badge, "Discard analysis isn't available yet for hands with jokers"). The plain waits list already shows what each joker resolves to for a given wait (the `joker-hint`, 🀪=tile); the fix is extending that same "what does the joker assume" resolution into shanten/discard-analysis/breakdown instead of just disabling them.
- **Rethink the Breakdown button further.** The current on/off toggle + `↔` order-icon split (see recent commits) is an improvement over the old 3-way text cycle, but isn't necessarily the final design.

## Scoring calculator (tai/fan)

Given a winning hand, calculate its actual score under Taiwanese 16-tile scoring rules, not just confirm it's complete.

- Biggest complexity driver isn't the individual scoring patterns (~30-40 named tai bonuses, each a fairly simple pattern check) — it's that Taiwanese scoring rules vary by table/region (different tai values, caps, which patterns count at all). Building a configurable/universal ruleset from day one is the trap; better to hard-code one concrete ruleset first and only generalize once that works end to end.
- Needs game context the app doesn't currently track: seat wind, round wind, self-draw vs. won-off-discard, flowers drawn, kongs declared, dealer status.
- `decomposeHand` currently returns *one* valid meld/pair decomposition; scoring needs *all* valid decompositions enumerated, since which decomposition you pick can change the tai total (e.g. a triplet read one way vs. folded into a run-based reading), and the correct score is the max over all valid readings.
