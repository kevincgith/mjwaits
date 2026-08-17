# mjwaits

A waits calculator for Taiwanese (16-tile) Mahjong. Build a hand, and it tells you what you're waiting on, how close you are, and which discard gives you the best odds of getting there.

**Live app: [app.kevinlhc.com/mjwaits](https://app.kevinlhc.com/mjwaits/)**

![A tenpai hand — 123456789m111z11t22s — with breakdown and waits count both enabled, showing a shanpon (dual pair) wait on 1 Pin / 2 Sou](docs/preview.png)

## Features

### Hand input

- **Tap tiles** on the picker, or **type algebraic notation** directly (e.g. `123456789m111z11t22s`) — the two stay in sync.
- Suits: `m` (man/characters), `t` (pin/circles), `s` (sou/bamboo), `z` (honors, 1–7 for East/South/West/North/Red/Green/White), `j` (joker).
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

![A tenpai Sixteen Unrelated Tiles hand (147t258m369s1234567z), waiting on all 16 of its own kinds for 48 tiles total](docs/special-hand.png)

### Trainer

A quiz mode for practicing waits recognition, separate from the calculator (switch between them with the tabs at the top). Each question is a randomly generated hand at one of 5 difficulty levels — Level 1 is 4 tiles (1 meld + pair), Level 5 is the full 16-tile tenpai size — guaranteed to have at least one wait. The answer picker only shows suits actually present in the question, since a wait can never come from a suit that isn't already there. Tap tiles to mark your guess, then submit: the picker highlights each pick as a correct hit, a wrong guess, or a wait you missed, and a full breakdown (same as the calculator's) reveals how each actual wait completes the hand. **Flush mode** restricts every generated hand to a single random suit for extra difficulty.

A live timer runs per question and freezes at submit. Results accumulate into a stats table broken down by level and flush mode (since difficulty varies a lot between them) — answered, correct, wrong, % correct, and average time, with an overall total row and a Reset Stats button. Stats persist across switching back to the Calculator tab and back.

## Notation reference

```
123456789m111z11t22s   5 melds + a pair
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

The core engine (parsing, shanten, waits, joker resolution, discard analysis) lives in [`src/lib/mahjong.ts`](src/lib/mahjong.ts) and is covered by an extensive test suite in [`src/lib/mahjong.test.ts`](src/lib/mahjong.test.ts), including brute-force cross-validation for the trickier joker and shanten logic. Trainer question generation lives in [`src/lib/trainer.ts`](src/lib/trainer.ts), tested with property-based checks across all levels and flush mode in [`src/lib/trainer.test.ts`](src/lib/trainer.test.ts).

Built with React, TypeScript, and Vite; deployed to GitHub Pages via GitHub Actions on every push to `main`.

See [ROADMAP.md](ROADMAP.md) for ideas on future work (camera-based tile input, a scoring calculator).
