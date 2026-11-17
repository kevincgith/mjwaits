# Prompt for Grok — rebuild MJWaits (no camera scan, no Play)

> **How to use:** paste everything below the line into Grok, and attach:
> - **`docs/scoring-rules.md`** — the full farn/番 pattern list (~100 KB, too long to paste);
> - optionally the **`src/assets/tiles/`** SVGs (zip the folder) so Grok uses the same tile faces.
>
> Everything else Grok needs is in the prompt itself.

---

You are building a complete, production-quality web app from scratch. Work like a senior engineer:
plan first, then write real, runnable code — every file in full, no "..." placeholders, no
"implement the rest yourself". If the output gets long, split it into numbered parts and keep
going until the whole app is delivered.

## What the app is

**MJWaits** — a mobile-first browser toolkit for **16-tile Mahjong (Taiwanese / Hong Kong house
rules, 港式台牌)**. Five tabs: **Scoring**, **Waits**, **Drills**, **Ledger**, **Dice**. The UI
mixes English with the Chinese table terms shown below — keep the Chinese labels exactly as
written.

**Out of scope — do NOT build:** a camera / photo tile scanner (no vision model, no ONNX), and any
"Play" mode (no bots, no dealt game against computer opponents, no WebGL table).

## Tech stack and constraints

- React 19 + TypeScript (strict) + Vite. No UI framework; plain CSS with CSS variables (see
  **Visual design** below — follow it exactly).
- An npm workspace with a `shared/` package holding the **pure rules engine** (no DOM, no browser
  APIs, no dependencies) and the app in `src/`. Tests with **Vitest**.
- Everything runs client-side; persistence in `localStorage`. Installable PWA with a hand-written
  service worker so it works offline after one visit.
- Phone first: bottom tab bar on a phone (Scoring, Ledger, Waits, More → Drills, Dice, Credits);
  a segmented control on wide screens. Touch and mouse only — keyboard/screen-reader work is not
  required. Respect iPhone safe areas.
- **Tile art: SVG tile faces**, one file per tile — `m1`–`m9`, `t1`–`t9`, `b1`–`b9`, `z1`–`z7`,
  `flower1`–`4` (梅蘭菊竹), `season1`–`4` (春夏秋冬), `joker` — on a plain white face. Use the
  attached SVGs if provided; otherwise adapt the Wikimedia Commons "SVG Oblique illustrations of
  Mahjong tiles" set (CC BY-SA 4.0, by Cangjie6 et al. — crop to the face, credit it). Do not use
  Unicode Mahjong glyphs or emoji for tiles.
- **No emoji anywhere in the UI.** All icons (reset, share, undo/redo, settings, live, best/worst
  markers, etc.) are one consistent set of inline SVG stroke icons.

## Tiles and notation

- Suits: `m` 萬 (characters), `t` 筒 (circles/pin), `b` 索 (bamboo/sou), `z` honors 1–7 =
  東 南 西 北 中 發 白, `j` joker. 34 kinds, 4 copies each (jokers unlimited).
- Bonus tiles: 4 flowers + 4 seasons (花), only ever "declared", never in the concealed hand.
- Notation: digits before a suit letter are tiles of that suit — `123456789m111z11t22b`;
  jokers as bare `j`s — `jjjj`.
- A complete 16-tile hand = **5 melds + 1 pair** (17 tiles with the winning tile). Melds: 上
  chow (run of 3), 碰 pung (triplet), 明槓 exposed kong, 暗槓 concealed kong.

## The rules engine (`shared/engine/`) — get this right first

Build and unit-test this before any UI.

1. **Parsing / formatting** notation ↔ tile arrays.
2. **Shanten** — full numeric count (minimum discard+draw exchanges to tenpai) for the standard
   shape *and* the special hands below. Must be fast (memoized/DP, not brute force).
3. **Waits** — for a hand of 1, 4, 7, 10, 13 or 16 tiles, every tile kind that completes it, with
   remaining copies (4 minus those in hand) and a total. Flag a **universal wait** when all 34
   kinds complete it. Return every meld/pair decomposition per wait (a hand can be ambiguous).
4. **Special hands**:
   - **十三么 Thirteen Orphans** — all 13 terminal/honor kinds, one doubled as the pair, plus one
     ordinary meld.
   - **嚦咕嚦咕 Eight Pairs** — seven pairs plus one tripled pair (a quad counts as two pairs).
   - **十六不搭 Sixteen Unrelated** — all 7 honors + 3 mutually "unrelated" ranks from each suit
     (no two could ever share a chow), plus one tile doubling any of them as the pair.
5. **Jokers** — any number of wildcards. Find every wait they unlock and what each joker resolves
   to, using a wildcard-budget search (not brute-forcing every substitution).
6. **Discard analysis** — rate each discard by a two-phase estimate over the next **8
   self-draws**: phase 1 reaches tenpai at (accepting tiles ÷ unseen tiles) per draw, phase 2
   wins at (wait tiles ÷ unseen) per draw. Give tenpai %, win %, the accepting tiles, and a
   two-step lookahead (useful draw → resulting waits, with counts). Takes optional "already
   discarded" tiles and "draws left" so the Endless drill can tighten the numbers as the wall
   runs down.
7. **Farn (番) scoring** — implement **every pattern in the attached `scoring-rules.md`**, with its
   farn value, criteria, exclusions, the 明/暗 (open/concealed) rules and the duplicate-instance
   counting rules exactly as written there. Algorithm: detect special hands first and score them
   with their own logic; otherwise enumerate **every** valid meld/pair decomposition and keep the
   one with the **highest total**. A matched "bigger" pattern suppresses the smaller ones it
   lists; unrelated patterns stack; repeatable patterns fire once per instance. A hand that is
   both valid Eight Pairs and a valid ordinary hand is reported scored both ways. Each match
   returns the exact tiles behind it.
8. **Ledger** — see the Ledger section; an append-only event log replayed into state.

Write thorough Vitest suites: shanten/waits cross-checked against a brute-force reference on
random hands, joker resolution, every special hand, and **at least one test per scoring pattern**
plus its exclusions.

## Tab 1 — Scoring (default tab)

Score a **complete** winning hand.

- **One shared tile picker** with a segmented mode control: **手牌** adds one concealed tile;
  **上 / 碰 / 明槓 / 暗槓** drop that whole declared meld starting at the tapped tile (long-press
  in 明槓 mode declares a 暗槓). Tiles that can't start the chosen meld grey out in place (grid
  never reflows). Flowers/seasons in their own row, always to 門前. Two picker layouts, remembered
  and shared with Waits: **Classic** (all suits at once) and **Numpad** (one group at a time:
  tabs 花 字 | 萬 筒 索; a 3×3 keypad for a suit, 東南西北 over 中發白 for honors).
- **Your hand** card: **門前 (Declared)** and **手牌 (Concealed)**. Tap a tile/meld to remove it;
  **long-press** a concealed tile to mark it as the **食胡 tile** (the winning tile). The picker
  folds away once the hand is complete. Enforce the 4-copies cap.
- **Situation**: 圈風 round wind and 門風 seat wind (rows of wind tiles); **莊** dealer button with
  a 連莊 streak (+/−); **自摸** toggle; and declaration buttons that cycle: 叮 → 天叮 → 地叮, 一發,
  食叮; 四子內 / 七子內 / 十子內; 雙響 / 三響; 天胡 / 地胡 / 人胡; 河底撈魚 / 海底撈月 /
  海底撈月(一筒); counted 花摸 / 槓摸 / 搶槓 (×N, capped by the flowers/kongs present); 明絕 / 絕絕.
  They interlock: 自摸 auto-turns-on with 花摸 / 槓摸, last-tile wins or 天胡, and is mutually
  exclusive with 搶槓 / 雙響 / 三響 / 地胡 / 食叮.
- **Result**: farn total + matched-pattern list (name, farn); tap a row to expand to the exact
  tiles per instance; sort toggle check-order / farn ↓ / farn ↑. A strip under the sticky toolbar
  shows the winning decomposition.
- **Projected scores**: when the concealed hand is exactly one tile short, list each wait with
  the score the hand would get if that tile completed it (no jokers / concealed kongs here).
- **Sticky toolbar**: Reset, tile count (or the total once it scores — tap to jump to it).
- **Share**: a link carrying tiles, flowers and only non-default situation fields; opening it
  loads the hand and tidies the URL. Copy link + system share sheet.
- **最近 Recent**: last 10 scored hands on the device; tap to reload; changing only the situation
  updates the entry instead of adding one. Clear (two taps).
- **Record to Ledger** button while a Ledger game is in progress: opens the Ledger's 食胡 sheet
  with the winner picked by 門風, 自摸 set, and farn minus any 莊/連莊 (the Ledger adds its own).

## Tab 2 — Waits

- Tap tiles or **type notation** — kept in sync. Sort toggle (off restores entry order). Tap a
  tile to remove; long-press empty hand area to clear.
- Show **shanten** badge; at tenpai, the **waits** with remaining copies and total; universal-wait
  banner. **Breakdown** toggle shows each wait's decomposition with the winning tile highlighted
  (amber) and joker stand-ins highlighted (purple); a `↔` switch for pair-first vs tile-order.
- **Discard efficiency** (not tenpai, at a checkpoint size) and **Discard options** (one tile past
  a checkpoint — just drew): every discard ranked by win %, with tenpai %, accepting tiles and the
  two-step lookahead. A winning hand is called out as such.
- Share link + its own 最近 Recent list (building a hand tile by tile updates one entry).

## Tab 3 — Drills

Three sub-tabs; all stats saved in localStorage with a Reset.

- **Waits drill**: 5 levels (hand of 3·level + 1 tiles, guaranteed ≥1 wait), optional **Flush
  mode** (one random suit). Answer picker shows only suits in the question. Pick, submit → each
  pick marked hit (green) / wrong (red) / missed (amber), plus the full breakdown. Stats per level
  and flush mode: answered, correct, wrong, %, avg time.
- **Discards drill**: hand of 3·level + 2 (a tenpai hand + one drawn tile). Pick one tile to
  throw; graded against Discard options (best = highest win %). Highlight the pick and all
  equally-best discards; show the ranked list. Stats: best-discard rate and **average regret**
  (win-% points given up).
- **Endless**: Start → a full random hand from a shuffled wall; tap a tile to discard, it's
  graded, a tile is drawn, repeat. HUD: turn, shanten, best-discard rate, "loose" discards
  (needlessly raised shanten), avg regret, turns to tenpai, turns to win, hands won. Analysis
  accounts for your discard pile and the wall remaining. **Undo / Redo** through the whole hand
  (⌘Z / ⇧⌘Z too); **N** deals a new hand (confirm if there's progress to lose).

## Tab 4 — Ledger (計分) — score keeping for a real game

Store in localStorage (`mjwaits.scores`): current game, finished games, player roster. The game
is an **append-only event log** (wins, draws, bonuses, seat swaps, dealer/settings changes);
every number is computed by **replaying** the log, so undo = drop the last event, redo = put it
back.

**Payment rule** — what one payer owes one winner for a hand of `farn`:
`base + farn + 莊 + 雙響/三響 + 拉/踢 add-on`, where 莊 = `dealerTai + streakTai × 連莊`, applied
only when the winner or that payer is the dealer.

- **拉** (lives between two players): once A wins off B there's a 拉 of value V on B. A wins off
  B again → that hand is worth its value + ½V, and the 拉 grows to V + that worth (11, then a 20
  is worth 26, 拉 37). **踢**: B wins off A → worth its value + ½V; A's 拉 is gone and B's 拉 on A
  starts at the plain value (29, then a 20 back is worth 35, B's 拉 20). A 自摸 counts pair by
  pair. A 流局 keeps every 拉; a hand the holder doesn't win ends all their 拉. **投降** ends a 拉
  with nothing paid. Halves round per setting (0.5進1 = up, default) under 整數模式.
- **反雪**: a player who dealt into a 雙響/三響 and 自摸s the next won hand (draws in between don't
  count) gets 5 (after 雙響) / 10 (after 三響) from each of those winners, folded into their new
  拉 on that winner.
- **Jackpot**: each 流局 every player puts in `jackpotPerDraw`; a win can take it, or it's handed
  out by hand.
- **Dealer**: stays on a dealer win or a 流局 (with 流局留莊 on); otherwise passes on. A full lap
  advances the round wind; label as 東風東局 etc. 執位提示 reminds to re-seat after 北圈北局.
- **Defaults**: base 0, dealerTai 1, streakTai 2, 反雪 on (5/10), 封頂 999 (input cap only — never
  changes a payment), 流局留莊 on, jackpot on at 5, 整數模式 on, 拉/踢 round up, 高分提示 50,
  投降提示 3, 詐胡 40. Bonus presets for 特別獎罰: 花 5, 草 3, 花草 8, 暗槓 5, 追 5/10, 蛇骰 5 (pay),
  圍骰 5, 7搶1 30, 1搶7 30, 八仙過海 100, 嗌錯 5 (pay). All editable in **設定**.

**UI.** Setup: four players in turn order and the first dealer. **戰況 board** fits the screen
without scrolling: a status row (round/deal, 局 count, 連莊, **最近** button), a toolbar of icons,
and the four players as a diamond of coloured cards — name, 莊 tag, running total (green up / red
down), last hand's change, and 拉 badges (+V green on the holder's card, −V red on the pulled
player's, on the side facing each other). 流局 button and Jackpot in the middle. Tap a player →
bottom sheet with two tabs:
- **食胡**: pick the 輸家 or 自摸, type farn on a keypad; show what each payer owes split into
  底 · 番 · 莊 · 拉 · 總, flag payments ≥ 高分. **一炮多響** mode for 雙響/三響 (discarder, other
  winners, each one's farn). Jackpot toggle when the pot isn't empty.
- **特別獎罰**: free-form reward/penalty, with everyone or From/To one player, plus the presets.
- After each entry a toast offers one-tap 還原 (undo).

Toolbar: **新局** (settle: the fewest payments that square everyone, × a $-per-farn multiplier,
shareable as text or an image; file the game in History, start a new one), **還原 / 重做**,
**座位** (swap seats or bring in a substitute — totals stay with the player; set dealer/連莊/round),
**拉踢** (every live 拉, each with 投降), **最近** (every hand, newest first, with 還原), **設定**.

**統計 stats**: per-player cards (net, 胡 / 摸 / 銃 / 獎) and views — **局** (each hand's changes),
**走勢** (running-total line chart with crosshair tooltip, end-of-line labels; hand-drawn SVG, no
chart library), **牌型** (patterns from hands sent from Scoring), **玩家** (one player's full stat
grid: wins, self-draws, deal-ins, bonuses, best farn, avg farn won/dealt-in, 拉/踢 counts and
records, best/worst hand, win streak, positive-game rate, first-place rate — a thumbs-up SVG
icon marks the best at the table, thumbs-down the lowest), **紀錄** (every game, career stats, head-to-head net).

*(Optional phase 2, only after everything else works: **線上** live sharing — a Cloudflare Worker
with one Durable Object per game, a 5-character room code + QR link `?room=CODE`, followers see
the board live, the host can grant "Can record", first write wins on conflicts, auto-reconnect
with a stored token, room closes 2 days after its last change.)*

## Tab 5 — Dice

Three sub-tabs: **擲骰 Dice**, **換牌 Swap**, **座位 Seats**. The 擲骰 and 座位 tables are drawn as a
3D-looking green felt tipped back slightly (~12°) with a wooden rim, with real tiles (the SVG
faces / tile backs) on it; the dice are thrown onto the felt and land on the result. Use
Three.js or CSS 3D transforms — your choice — and keep it smooth on a phone.

- **擲骰 Dice**: three tappable d6 (tap to step a face, or Roll to throw them). Total in a box
  tinted green for three-of-a-kind, red for 1-2-3. The wall is four walls of 18 two-high stacks
  in a spinning-wheel pinwheel, turned ~15° on the table. The dice total counts round from the
  dealer to the wall that breaks: rim the counted run of stacks in gold, ease the gap open,
  point at it with a small gold triangle, and caption it in two lines — "Break the left wall"
  (bold) over "count 12 stacks clockwise · 6 stay on that wall" (muted). Tile backs are green
  (`#35a84a`, edge `#1f7a32`) with an ivory (`#e6dfcb`) side.
- **換牌 Swap**: two dice for the pre-deal exchange — "Round" (1–3) and "Tiles" (floor of 3) —
  showing both and their product.
- **座位 Seats** — the seating ceremony, for four players A B C D (long-press a player to rename
  to 1–2 letters, saved; double-tap two players to swap them; tap one to make them the
  provisional East). Turn order is counter-clockwise; "count n from player x" lands on
  (x + n − 1) mod 4. Six face-down tiles in a shuffled row: 東 南 西 北 + 一筒 + 二筒. Steps, each
  driven by a button naming the next step, with a caption and a progress bar:
  1. **First throw** — the provisional East throws three dice.
  2. **Count to the real East** — the total, counted from the provisional East, picks the real
     East seat.
  3. **Second throw** — the player at the real East seat throws.
  4. **Turn the tiles over** — all six face up.
  5. **一筒 / 二筒 to the ends** — the 筒 that appears first in the row slides to the left end,
     the other to the right; the winds keep their order in the middle.
  6. **Count to the first pick** — the second total, counted from the real East, picks who
     takes the first wind.
  7. **Deal the winds** — read the four winds from the 二筒 end if the second total is even, the
     一筒 end if odd, and deal them counter-clockwise starting at that player (tiles travel to
     each player at full size).
  8. **Take your seats** — everyone moves to the seat of the wind they were dealt (東 at the
     bottom), carrying their tile.

  A **Run all** button plays every step with a pause between (~1 s, longer after a throw), with
  **Pause** to stop. The Ledger's **座位** sheet can run this ceremony and take the result as the
  new seating — then turn the table so whoever is at the bottom (holding the phone) stays at the
  bottom, everyone keeping their neighbours.

## Visual design — match this exactly

The look is **iOS's grouped-list style**: a light grey page with white cards, translucent grey
controls, and a single green accent taken from the app logo. **Light only** — no dark mode; set
`color-scheme: light`. Define every colour once as a CSS custom property on `:root` and use only
the tokens.

**Font**: `16px/1.5 -apple-system, BlinkMacSystemFont, system-ui, "Segoe UI", Roboto, sans-serif`,
antialiased. CJK falls back to `"PingFang HK", "PingFang TC", "Noto Sans TC", "Microsoft JhengHei"`.
Type scale: 11px (tab labels, captions), 13px (secondary, badges), 15px (controls, list text),
17px (body, primary buttons), 22px (small headings), 30px (app title, weight 700, letter-spacing
−0.02em).

**Colour tokens**:

| Token | Value | Use |
|---|---|---|
| `--bg` | `#f2f2f7` | page |
| `--surface` | `#fff` | cards, sheets, the selected segment |
| `--fill` / `--fill-strong` | `rgba(118,118,128,.12)` / `.24` | every ordinary button and segmented track |
| `--separator` | `rgba(60,60,67,.13)` | hairlines |
| `--border` | `#d1d1d6` | borders where needed |
| `--text` | `#1c1c1e` | body text |
| `--text-secondary` / `--text-tertiary` / `--text-muted` | `#3a3a3c` / `#636366` / `#6e6e73` | captions, inactive tabs |
| `--accent` | `#1d7f45` (pressed `#156337`) | the one green |
| `--accent-tint` | `#d3ebdb` | an **on** toggle's fill (text in `--accent`, weight 600) |
| `--accent-bg` | `#e6f4eb` | light green panels |
| `--red` / `--danger-text` | `#b3261e` / `#c42b1c` (bg `#fdecea`) | destructive, armed two-tap buttons, negative |
| `--warning` | text `#9a6700`, accent `#e8a400`, bg `#fdf3e7` | amber highlights (a winning tile, a missed wait) |
| `--purple` | `#8b5cf6` (bg `#f2eefc`) | a joker's stand-in tile |
| `--success` | border `#34a862`, text `#1e7a41`, bg `#e8f7ee` | correct answers |
| `--felt` | `radial-gradient(90% 75% at 50% 45%, #1f6b43 0%, #164f30 70%, #0f3b23 100%)`, edge `#0c2f1c` | the Dice tables |
| gold | `#ffd166` / `#e29a1c` | the counted wall run on the felt |

**Radii**: 4px (highlight boxes, meld groups), 6px (tiles), 10px (controls, inset boxes), 14px
(cards), 18px (sheets, dialogs), 999px (pills). **Shadows**: segment
`0 1px 3px rgba(0,0,0,.12), 0 1px 1px rgba(0,0,0,.04)`; floating sheet `0 8px 28px rgba(0,0,0,.18)`.

**Components**:
- **Page**: max-width 760px, centred, padding `calc(1.75rem + safe-area-top) 1.25rem 1.25rem`.
  Header: the app icon (44px, rounded 22%, small shadow — a green rounded square with two glass
  tiles) then the title "MJWaits" with the muted 15px tagline "HKTW mahjong scoring, waits &
  trainer" under it. Wide-screen tab order: Scoring, Ledger, Drills, Waits, Dice (each an SVG
  line icon + label). Footer: a GitHub icon + "Made by …" credit line.
- **Cards**: white, radius 14px, padding 1rem, 0.75rem apart, no border or shadow. Above each
  card a small **section head**: the Chinese name then the English one (15px, weight 600,
  `--text-secondary`), with an optional collapse chevron on the right.
- **Buttons**: no border, `--fill` background, radius 10px, padding 0.5rem 0.85rem, 15px weight
  500. An on toggle is **tinted** (`--accent-tint` + green text), never solid green. **Solid
  green** (`--accent`, white text, 17px weight 600, padding 0.7rem 1.25rem) is kept for the
  **one** primary action on a screen (Submit, Roll, New hand). Disabled = opacity 0.35 (a
  disabled primary goes grey, not faded green). Two-tap destructive buttons turn solid red when
  armed.
- **Segmented control** (iOS UISegmentedControl): a `--fill` track with 2px padding and 2px gaps,
  radius 10px; equal-width segments; the selected one is a raised white pill with the segment
  shadow and weight 600. Used for every sub-tab row, the picker mode, winds, levels.
- **Tab bar**: on wide screens, a segmented control under the title — icon (20px SVG) + label,
  inactive `--text-tertiary`, selected white pill with `--accent` text. On phones (≤700px) a
  fixed bar along the bottom, 56px + safe-area, icon over an 11px label, background
  `rgba(249,249,251,.86)` with `backdrop-filter: saturate(180%) blur(20px)` and a top hairline
  `0 -0.5px 0 rgba(0,0,0,.18)`.
- **Sticky toolbar** (Scoring, Waits): 52px (60px on phones) under the top safe area, same
  translucent blur as the tab bar.
- **Sheets**: white, radius 18px, the float shadow, over a `rgba(0,0,0,.35)` backdrop; centred
  dialogs on wide screens, **rising from the bottom** on phones.
- **Tiles**: the SVG face drawn plain white with its own edge so it shows on a white card —
  `box-shadow: 0 0 0 .5px rgba(0,0,0,.3), 0 .035em 0 .5px rgba(0,0,0,.14)`, radius 0.08em, in a
  0.78em × 1em box. Sizes: picker 2.4rem, hand 2.3rem, any row of tiles 1.75rem (every tile in
  a row the same size), the drill question 2.6rem; phones go to 1.95rem hand / 1.875rem row /
  3rem question. Highlights draw a tinted rounded box behind the tile (amber for the winning
  tile, purple for a joker stand-in).
- **Ledger player colours** (the 8-slot categorical palette, in seat order): `#2a78d6`,
  `#eb6834`, `#1baf7a`, `#eda100`, `#e87ba4`, `#8d5b2c`, `#4a3aa7`, `#e34948`. A colour never
  identifies a player alone — always show the name (and a monogram) next to it, and label chart
  lines directly. **Totals are coloured by sign** — `#1d7f45` up, `#c42b1c` down, `#8e8e93` at
  zero — never by player colour. Toasts: `rgba(28,28,30,.92)` with white text. 座位 player
  tokens: A green-tint, B `#e3eefc`, C red-tint, D purple-tint; the active one gets a 4px
  `--accent` ring.
- Buttons: `touch-action: manipulation`, no tap highlight, no text selection or callout (so
  long-presses work). Transitions 0.15s. Press feedback: a slight darken/scale.

Big tap targets, no layout shift when tiles grey out, iPhone safe areas respected. A footer
**Credits** page.

## Deliverables, in this order

1. A short plan: folder tree, the engine's main types and function signatures.
2. `shared/engine/` (tiles, notation, shanten, waits, jokers, discard analysis, scoring with every
   pattern from `scoring-rules.md`, ledger) **with its Vitest tests**.
3. The React app, tab by tab: Scoring, Waits, Drills, Ledger, Dice.
4. PWA bits (manifest, icons as SVG, service worker).
5. A README: how to run (`npm install`, `npm run dev`, `npm test`, `npm run build`) and a list of
   any rule in `scoring-rules.md` you were unsure about and how you resolved it.

Before you finish, re-read `scoring-rules.md` and confirm every pattern is implemented and
tested; list any you skipped.
