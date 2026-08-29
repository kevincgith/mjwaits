# mjwaits

A toolkit for Taiwanese (16-tile) Mahjong, built around a waits calculator: build a hand and it tells you what you're waiting on, how close you are, and which discard gives you the best odds of getting there. Four tabs across the top switch between the **Calculator**, a **Trainer** quiz mode, a **Scoring** (tai/番) calculator for completed hands, and a **Dice rolling** tab that also draws the wall and the break.

**Live app: [app.kevinlhc.com/mjwaits](https://app.kevinlhc.com/mjwaits/)**

![A tenpai hand — 123456789m111z11t22b — with breakdown and waits count both enabled, showing a shanpon (dual pair) wait on 1 Pin / 2 Sou](docs/preview.png)

## Features

### Hand input

- **Tap tiles** on the picker, or **type algebraic notation** directly (e.g. `123456789m111z11t22b`) — the two stay in sync.
- Suits: `m` (man/characters), `t` (pin/circles), `b` (sou/bamboo), `z` (honors, 1–7 for East/South/West/North/Red/Green/White), `j` (joker).
- **Sort mode** toggle: on, new tiles are kept in sorted order as you add them; off, they stay exactly in the order you entered them — and toggling back off reverts to that original order.
- A 4-copies-per-kind cap is enforced automatically (jokers excluded — see below).

### Waits

- Enter a hand at any checkpoint size (1, 4, 7, 10, 13, 16 tiles) to see what completes it.
- **Universal wait** is flagged explicitly when literally any of the 34 tile kinds would complete the hand.
- Remaining copies of each waiting tile are always shown (4 minus what's already in your hand), plus a running total across all waits.
- **Breakdown** toggle shows the exact meld/pair decomposition for each wait, with the completing tile highlighted; a small `↔` button (shown once Breakdown is on) switches between pair-first and tile-order display. A hand that's genuinely ambiguous between two shapes (e.g. a standard hand that's also valid Eight Pairs) shows every valid reading, not just one.

### Jokers (🀪)

Jokers are wildcards standing in for any tile. Add any number of them to a hand and the calculator works out every wait they unlock, along with what each joker resolves to for a given wait — using a wildcard-budget search rather than brute-forcing every possible substitution, so it stays fast even with many jokers in hand. With Breakdown on, the tile a joker is assumed to be is highlighted in purple within its meld/pair group, distinct from the amber highlight on the tile you'd actually draw.

![1m + 3 jokers, showing the universal wait banner and all 34 waits with joker resolution hints](docs/jokers.png)

Discard analysis (both kinds, below) isn't available yet for hands containing jokers.

### Shanten

A full numeric shanten calculator (not just tenpai/not-tenpai) — the minimum number of discard+draw exchanges needed to reach tenpai. Covers the standard meld+pair shape plus Eight Pairs and Sixteen Unrelated Tiles.

### Discard analysis

Two related but distinct tools, depending on where you are in the hand:

- **Discard efficiency** — at any checkpoint size that *isn't* tenpai, the app ranks every discard by a weighted score: for each one, a two-step lookahead shows every useful follow-up draw (with how many copies remain) and what the hand would then be waiting on (with its own remaining count). This surfaces the discard with the best actual odds of reaching a win, not just whichever reaches tenpai fastest.

  ![Discarding 5 Pin from 1278m555t111333777z scores highest: drawing 3m (4 copies left) leads to a wait on 6m/9m worth 8 tiles](docs/discard-efficiency.png)

- **Discard options** — right after drawing (one tile past a checkpoint), the app shows what discarding each distinct tile leaves you with: tenpai and its waits, or a shanten value and which draws would improve it further, each with remaining-copy counts. If you already have a winning hand, it says so — and, with Breakdown on, still shows the full decomposition plus what discarding anyway (instead of winning) would leave you waiting on.

### Special hands

Beyond the standard 5-melds-plus-a-pair shape, the calculator recognizes:

- **Thirteen Orphans** — all 13 terminal/honor kinds, one doubled as the pair, plus one ordinary meld.
- **Eight Pairs ("Liguligu")** — seven pairs plus one tripled pair (a full quad also counts as two pairs).
- **Sixteen Unrelated Tiles** — all 7 honors plus 3 mutually "unrelated" ranks from each of man/pin/sou (no two close enough to ever share a chow), plus one tile doubling any of them for the pair.

Breakdown mode understands all three shapes, not just the standard one — Thirteen Orphans groups the pair, the 12 remaining singles, and the extra meld separately; Eight Pairs shows the tripled kind first, then the other 7 pairs; Sixteen Unrelated shows the pair and the other 15 singles.

![A tenpai Sixteen Unrelated Tiles hand (147t258m369b1234567z), waiting on all 16 of its own kinds for 48 tiles total](docs/special-hand.png)

### Camera scan (📷)

Point a camera at a hand (or upload a photo) and have the tiles filled in automatically instead of tapping/typing every one. Detection runs entirely client-side — a YOLOv8n (nano) model, quantized to INT8 ONNX (3.4MB) and run in-browser via [onnxruntime-web](https://github.com/microsoft/onnxruntime) (WASM). No image is ever uploaded anywhere.

After picking a photo, you can drag to crop out anything that isn't the hand (with counterclockwise/clockwise rotate buttons for sideways shots) before scanning; overlapping duplicate detections are dropped with non-max suppression, and the review step shows a box over each detected tile (bonus tiles like flowers/seasons are boxed but greyed out and excluded from the hand) and lets you confirm or cancel before it replaces your current hand.

The **Scoring** tab has the same scanner, extended to two crops for the two physical piles — one for the 手牌區 concealed hand, one for the 門前牌區 declared melds — each labelled on its box, and each read back into the right region. Before the crop screen appears, a quick "Analyzing photo layout…" pass runs detection on the whole photo and, if it finds two clearly separated rows of tiles, seeds the two crop boxes to already roughly cover them (declared on top, concealed below) instead of always starting from fixed default positions — silently falling back to those defaults if the photo doesn't split cleanly into two rows. The Scoring tab's Reset button also cancels a scan that's still in progress.

The model was trained on a merged dataset combining [MahjongVis](https://github.com/Andy8647/MahjongVis) (MIT) and [MJOD-2136](https://github.com/jaheel/MJOD-2136) (CC BY-NC-SA), across 42 tile classes (34 mjwaits recognizes plus 8 bonus-tile classes), then fine-tuned on real photos of a physical set to close the gap between the training data's tile designs and what a visitor's actual tiles look like. On the full validation split, the deployed checkpoint scores mAP50 0.944 / mAP50-95 0.752 / precision 0.973 / recall 0.913. See [training/README.md](training/README.md) for the full training/export pipeline and reproducibility details.

### Trainer

A quiz mode for practicing waits recognition, separate from the calculator (switch between them with the tabs at the top). Each question is a randomly generated hand at one of 5 difficulty levels — Level 1 is 4 tiles (1 meld + pair), Level 5 is the full 16-tile tenpai size — guaranteed to have at least one wait. The answer picker only shows suits actually present in the question, since a wait can never come from a suit that isn't already there. Tap tiles to mark your guess, then submit: the picker highlights each pick as a correct hit, a wrong guess, or a wait you missed, and a full breakdown (same as the calculator's) reveals how each actual wait completes the hand. **Flush mode** restricts every generated hand to a single random suit for extra difficulty.

A live timer runs per question and freezes at submit. Results accumulate into a stats table broken down by level and flush mode (since difficulty varies a lot between them) — answered, correct, wrong, % correct, and average time, with an overall total row and a Reset Stats button. Stats persist across switching back to the Calculator tab and back.

### Scoring calculator

A separate tab (the waits Calculator itself stays always-concealed) that scores a complete winning
hand against one concrete house tai (番) list — nearly 140 patterns, built up one at a time rather
than as a configurable ruleset. It totals tai only; there's no point/currency conversion yet.

**Entering the hand.** The input models the physical table rather than a text string, as two
tap-based tile regions plus a row of declaration buttons:

- **門前牌區 (Declared melds)** — anything laid out in front of you. Pick a kind (上 chow / 碰 pung
  / 暗槓 concealed kong / 明槓 exposed kong), then tap a tile to add that meld; a separate
  collapsible sub-picker adds bonus tiles (flowers/seasons). The picker greys out invalid run
  starts, disables itself once 5 melds are declared, and collapses once you're done with it.
- **手牌區 (Concealed hand)** — the tiles still in your hand, as a plain multiset the scorer
  decomposes. **Long-press** a tile here to mark it as the **食胡 tile** (the one that completed
  the hand); several patterns score differently depending on whether the completing meld was
  self-drawn or claimed off a discard.
- **Round wind** and **seat wind** (東 / 南 / 西 / 北 buttons, round shown first), a **自摸**
  (self-draw) toggle, and a strip of manual declaration buttons for situational patterns that the
  tiles alone can't show. Most cycle through their states on each tap: **叮 → 天叮 → 地叮** (riichi
  and its upgrades) with a **一發** and a **食叮** button, **四子內 / 七子內 / 十子內** (won within
  the first N discards), **雙響 / 三響** (multiple winners on one discard), **天胡 / 地胡 / 人胡**,
  **河底撈魚 / 海底撈月 / 海底撈月(一筒)** (won on the very last tile), count-based **花摸 / 槓摸 /
  搶槓** (×N, capped at the bonus tiles / kongs actually in the hand), and a shared **明絕 / 絕絕**
  button. These buttons wire each other up the way the real rules interact — e.g. 自摸
  auto-activates with 花摸/槓摸, any last-tile win, or 天胡, and is mutually exclusive with
  搶槓/雙響/三響/地胡/食叮 (turning one on turns the others off); 天胡/地胡/人胡 exclude the
  last-tile group; and so on. **Reset** clears the hand, the winds, and every one of these toggles,
  and cancels an in-progress scan.

**Scoring.** Special hands (十三么 Thirteen Orphans, 嚦咕嚦咕 Eight Pairs, 十六不搭 Sixteen
Unrelated) are detected and scored by their own dedicated logic; everything else is run through
every valid meld/pair decomposition of the hand, and the **highest total tai over all readings**
wins — which reading you pick can change the score. When a pattern lists an exclusion, a matching
"bigger" pattern suppresses the smaller one it names; unrelated patterns stack freely, and several
(清龍, 步步高, 四歸, …) can fire more than once when a segment repeats. A hand that's
simultaneously a valid Eight Pairs and a valid ordinary hand (嚦咕雙食) shows both scored
readings. The result shows the tai total and a full meld/pair breakdown with the 食胡 tile
highlighted.

**Projected scores.** When the concealed hand is exactly one tile short of complete, the tab
reuses the waits calculator on it and shows, per wait, the score the whole hand would land on if
that tile completed it (each wait taken as its own 食胡 tile) — a collapsible list, best score
first. Kept deliberately narrow: no jokers, no concealed kongs.

See [docs/scoring-rules.md](docs/scoring-rules.md) for the full pattern list — every tai value,
its criteria, its exclusions, the 明/暗 (open/concealed) distinction, and the duplicate-instance
counting rules — kept in sync with the code.

### Dice rolling

A standalone tab with two sub-tabs:

- **Dice & wall** — three tappable d6 (tap a die to nudge its face, or hit **Roll the dice** for
  an animated tumble that settles on one result). The total is shown in a box tinted green for a
  three-of-a-kind and red for a 1-2-3. Below it, the full built wall is drawn as four 2×18
  tile-back bars in a pinwheel offset, and the dice sum breaks it: the app counts round to the
  right seat and marks where the wall opens, with a 👉 on the break and a caption spelling out
  which side and how many stacks are counted off.
- **Exchange tiles** — a two-die roller for the pre-deal tile exchange. One die (in a labelled
  "Round" box) picks a round 1–3, the other ("Tiles") a count with a floor of 3, and the tab shows
  Round, Tiles, and their product.

## Notation reference

```
123456789m111z11t22b   5 melds + a pair
1278m555t111333777z    mixed suits and honors
jjjj                    4 jokers, no rank needed
```

Digits before a suit letter are that many tiles of that suit; jokers are written as a run of bare `j` characters since they have no rank.

## Development

```bash
npm install
npm run dev      # start the dev server
npm test         # run the test suite (vitest)
npm run build    # typecheck + production build
```

The core engine (parsing, shanten, waits, joker resolution, discard analysis) lives in [`src/lib/mahjong.ts`](src/lib/mahjong.ts) and is covered by an extensive test suite in [`src/lib/mahjong.test.ts`](src/lib/mahjong.test.ts), including brute-force cross-validation for the trickier joker and shanten logic. Trainer question generation lives in [`src/lib/trainer.ts`](src/lib/trainer.ts), tested with property-based checks across all levels and flush mode in [`src/lib/trainer.test.ts`](src/lib/trainer.test.ts). The scoring engine (notation parsing, the all-decompositions search, the `PATTERNS` tai list) lives in [`src/lib/scoring.ts`](src/lib/scoring.ts), tested in [`src/lib/scoring.test.ts`](src/lib/scoring.test.ts) — see [docs/scoring-rules.md](docs/scoring-rules.md) for what each pattern actually does. The client-side tile detector (letterboxing, ONNX inference, non-max suppression) lives in [`src/lib/vision.ts`](src/lib/vision.ts).

Built with React, TypeScript, and Vite; deployed to GitHub Pages via GitHub Actions on every push to `main`.

See [ROADMAP.md](ROADMAP.md) for ideas on future work (a live camera viewfinder instead of photo-then-crop, extending joker resolution into shanten/discard analysis, and point/currency conversion for the scoring calculator).
