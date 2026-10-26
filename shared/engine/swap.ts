// 換牌 (swap tiles): a house rule played on some rounds. Everyone is dealt 16
// (bonus tiles set aside and replaced as usual) and the dealer holds back
// their first draw. The dealer throws two dice, one after the other: the
// first says how many swap rounds, the second how many tiles each (see
// SwapRules - both mappings are the table's to set). In a round everyone
// lays that many tiles face down in front of them; then, from the dealer
// round the table, each takes the same number back from the others' piles,
// face down - at least one from every other player, as evenly as it goes
// (5 is 1, 2, 2; 6 must be 2 from each - when it shares out exactly, that's
// the take). Lopsided takes (1, 1, 3) are allowed but frowned on, and
// a take that would leave someone after you no way to take from everyone
// isn't allowed at all. Once the rounds are done the dealer draws and the
// hand starts as usual.

import type { Tile } from "./mahjong";
import type { Wind } from "./scoring";

const SEATS = 4;

export interface SwapRules {
  winds: Wind[]; // the round winds that swap
  rounds: number[]; // by the first die (1-6): how many swap rounds
  tiles: number[]; // by the second die (1-6): how many tiles each
}

export const DEFAULT_SWAP_RULES: SwapRules = {
  winds: [2, 4],
  rounds: [1, 1, 2, 2, 3, 3],
  tiles: [3, 3, 3, 4, 5, 6],
};

// Tiles each, at most: one from each of the other three is the least a take
// can be, and a 16-tile hand can't give more than this and stay a hand.
// How an online table paces 換牌 (ms), so every phone can show each step as
// the Play table does: the deal's dice and then the swap's two dice, before
// anyone gives; a take's tiles flying, before the next taker's turn; and a
// round's rows held and then joining the hands, before the next round's
// give - or, the swap done, the dealer's first turn.
export const SWAP_PACE_MS = { dice: 4800, take: 1300, settle: 3400 };

// Each give and take has this long (seconds) - whatever the turn timer is,
// off included. Out of time, it's done for you as a bot would.
export const SWAP_TIMER_S = 30;

export const SWAP_MIN_TILES = 3;
export const SWAP_MAX_TILES = 8;
export const SWAP_MAX_ROUNDS = 5;

export interface SwapPhase {
  kind: "swap";
  dice: [number, number];
  rounds: number;
  count: number; // tiles each
  round: number; // 1-based
  stage: "give" | "take";
  // Each seat's face-down pile: null until they've laid it out this round.
  // A tile taken leaves its place empty (null) - the rest stay where they lie.
  piles: (Pile | null)[];
  // Whose turn to take (stage "take"), and who has taken this round.
  taker: number;
  took: number[];
  // Who took the tile from each place in each pile (null: still there) -
  // everyone sees whose hand reaches into which pile. Absent until the
  // round's first take.
  takenBy?: (number | null)[][];
}

export type Pile = (Tile | null)[];
// The tiles still in a pile.
export const pileLeft = (pile: Pile | null) => (pile ? pile.filter(Boolean).length : 0);

export const swapsOn = (rules: SwapRules | undefined, roundWind: Wind) => !!rules && rules.winds.includes(roundWind);
export const swapRounds = (rules: SwapRules, die: number) => rules.rounds[die - 1];
export const swapCount = (rules: SwapRules, die: number) => rules.tiles[die - 1];

// The order takes go in this round, from the dealer, counter-clockwise.
export const takeOrder = (dealer: number) => [0, 1, 2, 3].map((i) => (dealer + i) % SEATS);

// ---- Is this take all right? ------------------------------------------------------------

// A take: how many from each seat's pile (0 from your own).
export type Split = number[];

const isEven = (split: Split, taker: number) => {
  const parts = split.filter((_, g) => g !== taker);
  return Math.max(...parts) - Math.min(...parts) <= 1;
};

// A count that shares out exactly (3, 6): the same from each, and nothing else.
const exact = (count: number) => count % 3 === 0;

// Every take `taker` could make from piles of these sizes: `count` in all,
// at least one from every other seat, no more than a pile holds - and when
// the count shares out exactly, the same from each.
export function splitsFor(sizes: number[], taker: number, count: number): Split[] {
  const others = [0, 1, 2, 3].filter((g) => g !== taker);
  const out: Split[] = [];
  for (let a = 1; a <= sizes[others[0]]; a++)
    for (let b = 1; b <= sizes[others[1]]; b++) {
      const c = count - a - b;
      if (c < 1 || c > sizes[others[2]]) continue;
      const split = [0, 0, 0, 0];
      split[others[0]] = a;
      split[others[1]] = b;
      split[others[2]] = c;
      if (exact(count) && !isEven(split, taker)) continue;
      out.push(split);
    }
  return out;
}

// Can everyone still to take, in this order, take from everyone - and,
// with `even`, every one of them evenly?
function completes(sizes: number[], takers: number[], count: number, even: boolean): boolean {
  if (takers.length === 0) return sizes.every((n) => n === 0);
  const [t, ...rest] = takers;
  return splitsFor(sizes, t, count).some((split) => (!even || isEven(split, t)) && completes(sizes.map((n, g) => n - split[g]), rest, count, even));
}

export interface TakeCheck {
  ok: boolean; // allowed (warnings or not)
  error?: string; // why not
  warning?: string; // allowed, but frowned on
}

// `split` taken by `taker` from piles of these sizes, with `after` still to
// take this round: all right, frowned on (lopsided, or leaves someone after
// no even take), or not allowed.
export function checkTake(sizes: number[], taker: number, after: number[], count: number, split: Split): TakeCheck {
  const total = split.reduce((a, b) => a + b, 0);
  if (split[taker] > 0) return { ok: false, error: "Not from your own pile" };
  if (split.some((n, g) => n > sizes[g])) return { ok: false, error: "More than that pile has" };
  if (total !== count) return { ok: false, error: `Take ${count} in all` };
  if ([0, 1, 2, 3].some((g) => g !== taker && split[g] < 1)) return { ok: false, error: "Take at least one from everyone" };
  if (exact(count) && !isEven(split, taker)) return { ok: false, error: `Take ${count / 3} from each` };
  const left = sizes.map((n, g) => n - split[g]);
  if (!completes(left, after, count, false)) return { ok: false, error: "That leaves someone after you unable to take from everyone" };
  if (!isEven(split, taker)) return { ok: true, warning: "Lopsided - an even take is the custom" };
  if (!completes(left, after, count, true)) return { ok: true, warning: "That leaves someone after you a lopsided take" };
  return { ok: true };
}

// ---- Bots -------------------------------------------------------------------------------

// A bot's take: an even one that leaves everyone after an even one too, if
// there is one; else the fairest it can.
export function botSplit(sizes: number[], taker: number, after: number[], count: number, rng: () => number = Math.random): Split {
  const all = splitsFor(sizes, taker, count).map((split) => ({ split, check: checkTake(sizes, taker, after, count, split) }));
  const rank = (c: TakeCheck) => (!c.ok ? 3 : c.warning ? (isEvenWarning(c) ? 1 : 2) : 0);
  const best = Math.min(...all.map((x) => rank(x.check)));
  const choices = all.filter((x) => rank(x.check) === best);
  return choices[Math.floor(rng() * choices.length)].split;
}
const isEvenWarning = (c: TakeCheck) => c.warning?.startsWith("That leaves") ?? false;

// Which tiles a pile gives up for a take (places in it, of those still
// there): blind, so any - a bot, or a one-tap take, picks at random.
export function blindPicks(pile: Pile, n: number, rng: () => number = Math.random): number[] {
  const idx = pile.flatMap((t, i) => (t ? [i] : []));
  for (let i = idx.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  return idx.slice(0, n).sort((a, b) => a - b);
}

// What a bot gives away: its loneliest tiles - no pair, no neighbours to
// make a run with - one at a time, so taking one out can make another lonely.
export function botGive(hand: Tile[], count: number, rng: () => number = Math.random): Tile[] {
  return pickGive(hand, count, () => false, rng);
}

// Loneliest first, as botGive - but the tiles a plan keeps (`keep`, asked
// of each tile with what's still left in hand) only once there's nothing
// else left to give.
function pickGive(hand: Tile[], count: number, keep: (t: Tile, left: Tile[]) => boolean, rng: () => number): Tile[] {
  const left = hand.slice();
  const out: Tile[] = [];
  const worth = (t: Tile, i: number) => {
    let w = 0;
    left.forEach((o, j) => {
      if (j === i || o.suit !== t.suit) return;
      const d = Math.abs(o.rank - t.rank);
      if (d === 0) w += 3;
      else if (t.suit !== "z" && d === 1) w += 2;
      else if (t.suit !== "z" && d === 2) w += 1;
    });
    // Ends of a suit make fewer runs.
    if (t.suit !== "z" && (t.rank === 1 || t.rank === 9)) w -= 0.3;
    return w + rng() * 0.1;
  };
  for (let n = 0; n < count && left.length; n++) {
    const spare = left.some((t) => !keep(t, left));
    let pick = -1;
    let low = Infinity;
    left.forEach((t, i) => {
      if (spare && keep(t, left)) return;
      const w = worth(t, i);
      if (w < low) [low, pick] = [w, i];
    });
    out.push(left.splice(pick, 1)[0]);
  }
  return out;
}

// What you might give, by what you're going for: a few plans, each giving
// first what it has no use for (loneliest first), only then what it keeps.
// 孤張 (your loneliest tiles, as the bots give) always comes first; after it
// the plans your hand is likeliest to make, best first:
//   斷么 all simples; 混一色 your strongest suit and the honours; 么九
//   terminals and honours; 對對 pairs and triplets - each by how much of
//   your hand already fits it;
//   步步高 runs stepping up one (across the three suits, or in one);
//   三節高 three pungs in a row in one suit (連碰); 三色 the same run in all
//   three suits; 一條龍 1-9 in one suit - each the one your hand is
//   nearest, by how much of it you hold already, and keeping just its
//   tiles (copies counted).
// A plan that gives the very same tiles as one before it is left out.
export interface GivePlan {
  id: string;
  name: string; // as shown: 孤張, 斷么, 混萬, 步步高...
  tiles: Tile[];
}
const SUIT_CHAR: Record<string, string> = { m: "萬", t: "筒", b: "索" };
const SUITS = ["m", "t", "b"] as const;
const key = (t: Tile) => `${t.suit}${t.rank}`;
const countIn = (tiles: Tile[], k: string) => tiles.filter((t) => key(t) === k).length;
// A pattern's tiles: runs (n, n+1, n+2) and pungs (n x3), each in a suit.
const run = (suit: string, n: number): Tile[] => [0, 1, 2].map((d) => ({ suit, rank: n + d }) as Tile);
const pung = (suit: string, n: number): Tile[] => [0, 1, 2].map(() => ({ suit, rank: n }) as Tile);
export const MAX_GIVE_PLANS = 5;
export function givePlans(hand: Tile[], count: number, rng: () => number = Math.random): GivePlan[] {
  const terminalOrHonour = (t: Tile) => t.suit === "z" || t.rank === 1 || t.rank === 9;
  const held = (suit: string) => hand.filter((t) => t.suit === suit).length;
  const best = [...SUITS].sort((p, q) => held(q) - held(p))[0];
  const share = (fits: (t: Tile) => boolean) => hand.filter(fits).length / Math.max(1, hand.length);
  type Plan = { id: string; name: string; keep: (t: Tile, left: Tile[]) => boolean; fit: number };
  const plans: Plan[] = [
    { id: "simples", name: "斷么", keep: (t) => !terminalOrHonour(t), fit: share((t) => !terminalOrHonour(t)) },
    { id: "flush", name: `混${SUIT_CHAR[best]}`, keep: (t) => t.suit === "z" || t.suit === best, fit: share((t) => t.suit === "z" || t.suit === best) },
    { id: "terminals", name: "么九", keep: terminalOrHonour, fit: share(terminalOrHonour) },
    { id: "pungs", name: "對對", keep: (t, left) => countIn(left, key(t)) >= 2, fit: share((t) => countIn(hand, key(t)) >= 2) },
  ];
  // A pattern, as the one instance of it your hand is nearest: keep its
  // tiles (no more copies of each than it needs).
  const pattern = (id: string, name: string, shapes: Tile[][]) => {
    let top: Tile[] | null = null;
    let have = -1;
    for (const shape of shapes) {
      if (shape.some((t) => t.rank < 1 || t.rank > 9)) continue;
      const need = new Map<string, number>();
      shape.forEach((t) => need.set(key(t), (need.get(key(t)) ?? 0) + 1));
      let h = 0;
      need.forEach((n, k) => (h += Math.min(n, countIn(hand, k))));
      if (h > have) [have, top] = [h, shape];
    }
    if (!top) return;
    const need = new Map<string, number>();
    top.forEach((t) => need.set(key(t), (need.get(key(t)) ?? 0) + 1));
    plans.push({ id, name, keep: (t, left) => countIn(left, key(t)) <= (need.get(key(t)) ?? 0), fit: have / top.length });
  };
  const perms = [
    ["m", "t", "b"],
    ["m", "b", "t"],
    ["t", "m", "b"],
    ["t", "b", "m"],
    ["b", "m", "t"],
    ["b", "t", "m"],
  ];
  const ns = [1, 2, 3, 4, 5, 6, 7];
  // 步步高: three runs each a step up - one in each suit, or all in one.
  pattern("stepUp", "步步高", [
    ...perms.flatMap(([a, b, c]) => ns.map((n) => [...run(a, n), ...run(b, n + 1), ...run(c, n + 2)])),
    ...SUITS.flatMap((s) => ns.map((n) => [...run(s, n), ...run(s, n + 1), ...run(s, n + 2)])),
  ]);
  // 三節高 (連碰): three pungs a step apart, in one suit.
  pattern("pungsUp", "三節高", SUITS.flatMap((s) => ns.map((n) => [...pung(s, n), ...pung(s, n + 1), ...pung(s, n + 2)])));
  // 三色: the same run in all three suits.
  pattern("triple", "三色", ns.map((n) => SUITS.flatMap((s) => run(s, n))));
  // 一條龍: 1-9 in one suit.
  pattern("dragon", "一條龍", SUITS.map((s) => [...run(s, 1), ...run(s, 4), ...run(s, 7)]));

  // (Not one your hand barely touches - under a third of it held.)
  const ranked = [{ id: "lone", name: "孤張", keep: () => false, fit: Infinity } as Plan, ...plans.filter((p) => p.fit >= 1 / 3).sort((p, q) => q.fit - p.fit)];
  const out: GivePlan[] = [];
  const seen = new Set<string>();
  for (const p of ranked) {
    if (out.length >= MAX_GIVE_PLANS) break;
    const tiles = pickGive(hand, count, p.keep, rng);
    const k = tiles.map(key).sort().join();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ id: p.id, name: p.name, tiles });
  }
  return out;
}
