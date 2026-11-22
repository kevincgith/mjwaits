// Bots with personalities. Every bot runs the same decision engine - a
// discard is scored on speed (how close it leaves the hand to ready and how
// many tiles improve it), value (where the hand's tai are heading) and
// danger (how likely it is to feed someone who's ready) - and a profile
// sets how much each of those matters, how readily it calls, how well it
// reads the table and how often it plays a little loose, the way people do.
//
// Taiwanese 16-tile has no 振聽 (furiten): a player can win off a tile they
// threw earlier, so a player's own discards and their 筋 (suji) are only
// *safer*, never "genbutsu" as in riichi. Two kinds of tile are sure,
// though (see sureSafe): against a declared 叮, anything thrown since - and
// against anyone, the discard that's just gone by unclaimed.

import {
  claimOptions,
  forbiddenDiscards,
  canWin,
  kongOptions,
  lahAddOn,
  liveTilesLeft,
  meldsNeeded,
  riichiDiscards,
  riichiForcedDiscard,
  surrenderable,
  swapDiscardBan,
  sameTile,
  secondChanceFan,
  isWinningHand,
  SEATS,
  seatWind,
  unseenCounts,
  type Claim,
  type GameState,
  type KongMove,
  type Player,
  type TurnMove,
} from "./game";
import { allTileKinds, shanten as rawShanten, specialDistances, tileCount, tileKey, type SpecialRoutes, type Tile } from "./mahjong";
import { MYSTERY_SPEECH, SPEECH, type Speech } from "./speech";

export interface BotProfile {
  id: string;
  name: string;
  blurb: string;
  // ---- Offence ----
  // Weight on tile acceptance (how many draws improve the hand).
  speed: number;
  // 0..1: how much the hand's tai potential steers discards and calls.
  greed: number;
  // Won't take a win off a discard below this many tai while the wall is
  // still deep (0 = takes every win). The hand's whole score, 底 and all -
  // the smallest wins come to about 10. Never with 叮 declared: a 叮 hand
  // that passes a win up can't win again.
  minTai: number;
  // 0..1: how readily it declares 叮 when ready (it then can't fold or
  // change its wait, but scores 叮 / 門清叮 and maybe 一發).
  riichi: number;
  // 0..1: how readily it pungs and chows (and gives up 門清 for it).
  callAppetite: number;
  // ---- Defence ----
  // 0..1: how much a dangerous discard costs it.
  caution: number;
  // Folds (plays only for safety) when the biggest threat at the table is
  // above this and its own hand is 2+ from ready. 1 = never folds.
  foldAt: number;
  // 0..1: table reading - suji, walls (壁), flush reads, tenpai tells. At 0
  // it only knows "they threw that before".
  read: number;
  // Defend only against opponents at least this likely to be ready (0 =
  // everyone; 0.99 = only a declared 叮). Optional, default 0.
  focus?: number;
  // 0..1: how much of the other players' ponds it remembers (1 = every
  // discard; lower keeps only the most recent ones, as a person would).
  // Forgotten tiles count as unseen and can't inform its reads. Optional,
  // default 1.
  memory?: number;
  // 0..1: how much 拉 between players enters its decisions - the extra a
  // deal-in to a particular player would cost, and the extra a win would
  // collect. 0 plays as if there were no 拉. Optional, default 1.
  pullSense?: number;
  // 0..1: readiness to 投降 a 拉 once the rules allow it (3+ in a row,
  // straight after a hand the holder won from it). 1 concedes a 拉 of 30
  // or more; 0 never concedes. Optional, default 0.3.
  surrender?: number;
  // The special hands (十六不搭, 十三么, 嚦咕), from how far away. Each hand a
  // bot draws one mood; it counts a special hand as a route when that mood is
  // under its chance at the current distance. So the chance rises as the hand
  // gets closer, and a bot can come round to one, but won't flip back and
  // forth. `longShot`: the chance one tile from ready; `longShotFade`: what
  // each tile further multiplies that by; `longShotReach`: beyond this many
  // tiles, never. Ready, it always counts. Set by character, not evolved: in
  // the arena they made no personality clearly weaker.
  longShot?: number;
  longShotFade?: number;
  longShotReach?: number;
  // ---- Temper ----
  // How its play shifts with the game (Feel.form, see inMood): what's added
  // to each setting on a full losing run, and on a full winning one - less
  // in between. None: it plays the same whatever the score.
  temper?: { losing?: Shift; winning?: Shift };
  // 0..1: how much it plays at whoever it's sore at (Feel.sore) - dealing in
  // to them again costs it more, a win off them is never let go, and a 拉
  // of theirs is given up less readily. Optional, default 0.
  grudge?: number;
  // ---- Human feel ----
  // Softmax temperature over near-equal choices (0 = always the top pick).
  noise: number;
  // Chance per decision of a lazy pick - the second-best discard, or a call
  // it would normally pass on.
  slip: number;
}

// The settings a temper can move, and how far each may go.
const SHIFT_RANGE = {
  speed: [0.3, 2],
  greed: [0, 1],
  minTai: [0, 30],
  riichi: [0, 1],
  callAppetite: [0, 1],
  caution: [0, 1],
  foldAt: [0.2, 1],
  longShot: [0, 1],
  noise: [0, 0.5],
  slip: [0, 0.3],
} as const;
export type Shift = Partial<Record<keyof typeof SHIFT_RANGE, number>>;

export const BOT_PROFILES: BotProfile[] = [
  {
    // From the species evolution (evolution/species1, 112 generations):
    // the evolved Gambler's settings with full memory and table reading.
    // It and the evolved Gambler are about level (each won one of two
    // 1,200-hand tables against the evolved roster); against three original
    // efficiency-only bots it scores +2.4 tai a hand. Veteran, Speedster, Iron Wall, Gambler and Casual below are
    // their species' evolved champions; the Hunter keeps its original
    // settings (its evolved champion only tied them).
    id: "grandmaster",
    name: "宗師 Grandmaster",
    blurb: "Evolution's strongest: plays at full speed, calls freely, chases value, declares 叮 almost every time and barely defends - forgetting no discard.",
    speed: 1.6,
    greed: 0.556,
    minTai: 0,
    riichi: 0.941,
    callAppetite: 0.882,
    caution: 0.035,
    foldAt: 1,
    // (Arena, after the safe-tile fixes: 0.5 scored about 0.6 tai a hand over
    // 0.95 in 25,600 hands of self-play, and drew level with the Veteran
    // against the Hunter and Iron Wall, where 0.95 trailed it.)
    read: 0.5,
    noise: 0,
    slip: 0,
    focus: 0,
    surrender: 0.5,
    longShot: 0.9,
    longShotFade: 0.55,
    longShotReach: 3,
    // Ice: the score doesn't move it, and it holds nothing against anyone.
    grudge: 0,
  },
  {
    id: "veteran",
    name: "老手 Veteran",
    blurb: "Quick and sharp: calls freely, usually declares 叮, lets a small win go early in the hand and defends a little.",
    speed: 1.477,
    greed: 0.05,
    minTai: 12,
    riichi: 0.796,
    callAppetite: 0.95,
    caution: 0.224,
    foldAt: 0.947,
    read: 0.505,
    noise: 0.003,
    slip: 0.003,
    focus: 0,
    surrender: 0.5,
    longShot: 0.7,
    longShotFade: 0.5,
    longShotReach: 3,
    // Steady: a little more careful when it's been losing.
    temper: { losing: { caution: 0.12, minTai: -12 } },
    grudge: 0.3,
  },
  {
    id: "speedster",
    name: "快手 Speedster",
    blurb: "Races to ready and calls almost everything; always declares 叮; defends only against a player who looks ready.",
    speed: 1.225,
    greed: 0.002,
    minTai: 0,
    riichi: 1,
    callAppetite: 0.968,
    caution: 0.321,
    foldAt: 0.778,
    read: 0.181,
    noise: 0,
    slip: 0.04,
    memory: 0.7,
    focus: 0.324,
    surrender: 0.3,
    longShot: 0.5,
    longShotFade: 0.4,
    longShotReach: 2,
    // Behind, it wants any win at all, sooner: calls everything.
    temper: { losing: { callAppetite: 0.03, speed: 0.3, caution: -0.2 }, winning: { caution: 0.15 } },
    grudge: 0.4,
  },
  {
    id: "hunter",
    name: "大牌 Hunter",
    blurb: "Chases flushes, all-pungs and honours; passes on small wins early.",
    speed: 0.7,
    greed: 0.95,
    minTai: 14,
    riichi: 0.7,
    callAppetite: 0.5,
    caution: 0.5,
    foldAt: 0.5,
    read: 0.7,
    noise: 0.06,
    slip: 0.02,
    surrender: 0.4,
    longShot: 0.95,
    longShotFade: 0.75,
    longShotReach: 4,
    // Behind, only a big hand will do; ahead, it takes what comes.
    temper: { losing: { minTai: 6, longShot: 0.05, callAppetite: -0.2 }, winning: { minTai: -14, callAppetite: 0.2 } },
    grudge: 0.6,
  },
  {
    id: "wall",
    name: "鐵壁 Iron Wall",
    blurb: "Keeps 門清, rarely declares 叮, and shuts down completely against anyone who looks ready - deals in almost never.",
    speed: 1.094,
    greed: 0.209,
    minTai: 0,
    riichi: 0.198,
    callAppetite: 0.081,
    caution: 0.877,
    foldAt: 0.296,
    read: 0.72,
    noise: 0,
    slip: 0.068,
    focus: 0.876,
    surrender: 0.9,
    longShot: 0.7,
    longShotFade: 0.5,
    longShotReach: 3,
    // Ahead, it sits on its lead; behind, it has to come out and play.
    temper: { losing: { riichi: 0.4, callAppetite: 0.35, foldAt: 0.25 }, winning: { caution: 0.12, foldAt: -0.08, riichi: -0.15 } },
    grudge: 0.2,
  },
  {
    id: "gambler",
    name: "賭徒 Gambler",
    blurb: "Never folds: chases big hands at full speed, calls freely and declares 叮 almost every time - without a glance at anyone else's discards.",
    speed: 1.6,
    greed: 0.556,
    minTai: 0,
    riichi: 0.941,
    callAppetite: 0.882,
    caution: 0.035,
    foldAt: 1,
    read: 0,
    noise: 0,
    slip: 0,
    memory: 0.5,
    focus: 0,
    surrender: 0,
    longShot: 1,
    longShotFade: 0.85,
    longShotReach: 4,
    // Tilts: losing, it chases bigger and wilder still - and never forgets who took its money.
    temper: { losing: { greed: 0.4, speed: -0.4, slip: 0.06 }, winning: { greed: 0.2 } },
    grudge: 0.9,
  },
  {
    id: "casual",
    name: "街坊 Casual",
    blurb: "A friendly club player: calls freely and loves 叮, plays carefully, but forgets older discards and makes the odd lazy throw.",
    speed: 0.692,
    greed: 0.028,
    minTai: 0,
    riichi: 0.994,
    callAppetite: 0.915,
    caution: 0.687,
    foldAt: 0.569,
    read: 0.299,
    noise: 0.28,
    slip: 0.068,
    memory: 0.3,
    focus: 0.108,
    surrender: 0.6,
    longShot: 0.5,
    longShotFade: 0.5,
    longShotReach: 2,
    // Loses heart when it's losing: plays safe, declares less. Winning, it gets careless.
    temper: { losing: { caution: 0.25, foldAt: -0.2, riichi: -0.35 }, winning: { slip: 0.06, caution: -0.25 } },
    grudge: 0.5,
  },
];

// What each personality says at the table (its speech bubbles): see speech.ts.
export { SPEECH, MYSTERY_SPEECH, callLines, type CallKind, type Speech } from "./speech";

export const speechOf = (p: BotProfile): Speech => (mysteryStyle(p) ? MYSTERY_SPEECH : (SPEECH[learnedStyle(p) ?? p.id] ?? SPEECH.veteran));

// A mystery bot: one of the personalities, picked at random and not shown -
// its name, avatar and lines are the same whichever it is. Its id carries
// the personality ("mystery-<id>"), which is how this device plays it; the
// online table keeps the id on the server and sends only "mystery".
export const MYSTERY_PREFIX = "mystery-";
export const MYSTERY_NAME = "神秘 Mystery";
export const mysteryStyle = (p: BotProfile): string | null => (p.id.startsWith(MYSTERY_PREFIX) ? p.id.slice(MYSTERY_PREFIX.length) : null);
export function mysteryProfile(style: string): BotProfile {
  return { ...profileById(style), id: MYSTERY_PREFIX + style, name: MYSTERY_NAME, blurb: "One of the personalities, picked at random - which one is for you to work out." };
}
// A personality for a new mystery bot.
export const randomStyle = (random: () => number = Math.random) => BOT_PROFILES[Math.floor(random() * BOT_PROFILES.length)].id;

// Learned bots (src/lib/ml): a trained network playing as one of the
// personalities. Their profile is the personality's, renamed - it's what
// the table shows, and what they fall back to if the network can't load.
export const LEARNED_PREFIX = "net-";
export const learnedStyle = (p: BotProfile): string | null => (p.id.startsWith(LEARNED_PREFIX) ? p.id.slice(LEARNED_PREFIX.length) : null);
export function learnedProfile(style: string): BotProfile {
  const base = profileById(style);
  const [zh, ...en] = base.name.split(" ");
  return {
    ...base,
    id: LEARNED_PREFIX + base.id,
    name: `學${zh} ${en.join(" ")} AI`,
    blurb: `A neural network trained to play like the ${en.join(" ")} - experimental, and still learning.`,
  };
}

export const profileById = (id: string): BotProfile => BOT_PROFILES.find((p) => p.id === id) ?? BOT_PROFILES.find((p) => p.id === "veteran")!;

// The profile as it plays right now: its settings moved by its temper, by
// how far its game has swung (Feel.form). A small swing moves nothing.
export function inMood(profile: BotProfile, s: GameState, seat: number): BotProfile {
  const form = s.feel?.form[seat] ?? 0;
  const shift = form < 0 ? profile.temper?.losing : profile.temper?.winning;
  const by = Math.abs(form);
  if (!shift || by < MOOD_FROM) return profile;
  const out = { ...profile };
  for (const k of Object.keys(shift) as (keyof Shift)[]) {
    const [lo, hi] = SHIFT_RANGE[k];
    out[k] = clamp((profile[k] ?? 0) + shift[k]! * by, lo, hi);
  }
  return out;
}
const MOOD_FROM = 0.2;

// How sore `seat` is at `o` right now, 0..1 (see Feel).
export const soreAt = (s: GameState, seat: number, o: number): number => s.feel?.sore[seat]?.[o] ?? 0;

// ---- Helpers ------------------------------------------------------------

// Shanten is the hot path (every discard x every improving draw), and the
// same hands recur turn to turn, so results are memoised by sorted hand.
const shantenCache = new Map<string, number>();
const KIND_BASE: Record<string, number> = { m: 0, t: 9, b: 18, z: 27 };
const handCounts = new Uint8Array(34);
// The hand as a count per kind - the same multiset as sorting, quicker.
function handKey(tiles: Tile[], melds: number): string {
  handCounts.fill(0);
  for (const t of tiles) {
    const base = KIND_BASE[t.suit];
    if (base === undefined || !Number.isInteger(t.rank) || t.rank < 1 || t.rank > (t.suit === "z" ? 7 : 9)) return melds + ":" + tiles.map(tileKey).sort().join("");
    handCounts[base + t.rank - 1]++;
  }
  return melds + "|" + String.fromCharCode.apply(null, handCounts as unknown as number[]);
}
function shanten(tiles: Tile[], melds: number, routes: SpecialRoutes = USUAL): number {
  const key = routes === USUAL ? handKey(tiles, melds) : `${handKey(tiles, melds)}:${routes.sixteen ? 1 : 0}${routes.pairs ? 1 : 0}${routes.orphans ? 1 : 0}`;
  let v = shantenCache.get(key);
  if (v === undefined) {
    v = rawShanten(tiles, melds, routes);
    if (shantenCache.size > 400_000) shantenCache.clear();
    shantenCache.set(key, v);
  }
  return v;
}

const ALL_KINDS = allTileKinds();
const USUAL: SpecialRoutes = { sixteen: true, pairs: true, orphans: false };

function removeTiles(hand: Tile[], tiles: Tile[]): Tile[] {
  const rest = hand.slice();
  for (const t of tiles) {
    const i = rest.findIndex((h) => sameTile(h, t));
    if (i >= 0) rest.splice(i, 1);
  }
  return rest;
}

// Only tiles next to (or matching) something in the hand can improve it,
// so acceptance needn't try all 34 kinds.
function improvers(hand: Tile[]): Tile[] {
  const keys = new Set<string>();
  for (const t of hand) {
    if (t.suit === "z") keys.add(tileKey(t));
    else for (let r = t.rank - 2; r <= t.rank + 2; r++) if (r >= 1 && r <= 9) keys.add(`${t.suit}${r}`);
  }
  return ALL_KINDS.filter((k) => keys.has(tileKey(k)));
}

function acceptance(rest: Tile[], melds: number, sh: number, unseen: Map<string, number>, routes: SpecialRoutes, anyKind: boolean): number {
  let n = 0;
  // (A special hand can want a kind nothing in the hand is near.)
  for (const k of anyKind ? ALL_KINDS : improvers(rest)) {
    const left = unseen.get(tileKey(k)) ?? 0;
    if (left > 0 && shanten([...rest, k], melds, routes) < sh) n += left;
  }
  return n;
}

// A bot's chance of counting a special hand this many tiles from ready.
export function longShotChance(profile: BotProfile, away: number): number {
  if (away <= 0) return 1;
  if (away > (profile.longShotReach ?? 2)) return 0;
  return (profile.longShot ?? 0.6) * (profile.longShotFade ?? 0.5) ** (away - 1);
}

const NO_ROUTES: SpecialRoutes = { sixteen: false, pairs: false, orphans: false };
const ORPHANS: Tile[] = [...(["m", "t", "b"] as const).flatMap((suit) => [1, 9].map((rank) => ({ suit, rank }))), ...[1, 2, 3, 4, 5, 6, 7].map((rank) => ({ suit: "z" as const, rank }))];
const HONOURS = ORPHANS.filter((t) => t.suit === "z");

// The special hands this bot is playing toward right now. A hand needing a
// kind with no copies left, as far as it can tell, is no route at all.
export function specialRoutes(s: GameState, seat: number, profile: BotProfile, unseen: Map<string, number>): SpecialRoutes {
  const p = s.players[seat];
  if (p.melds.length) return NO_ROUTES;
  const mood = s.moods?.[seat] ?? 0.5;
  const away = specialDistances(p.hand);
  const possible = (kinds: Tile[]) => kinds.every((k) => tileCount(p.hand, k) > 0 || (unseen.get(tileKey(k)) ?? 0) > 0);
  return {
    sixteen: mood < longShotChance(profile, away.sixteen) && possible(HONOURS),
    pairs: mood < longShotChance(profile, away.pairs),
    orphans: mood < longShotChance(profile, away.orphans) && possible(ORPHANS),
  };
}

const isValueHonor = (t: Tile, s: GameState, seat: number) =>
  t.suit === "z" && (t.rank >= 5 || t.rank === s.roundWind || t.rank === seatWind(seat, s.dealer));

// Where the hand's tai are heading, roughly in tai: flushes, all-pungs,
// honour pungs and 門清. Looks at the concealed tiles and the melds.
export function handValue(s: GameState, seat: number, hand: Tile[], p: Player): number {
  const all = [...hand, ...p.melds.flatMap((m) => m.tiles)];
  const bySuit = { m: 0, t: 0, b: 0, z: 0 } as Record<string, number>;
  for (const t of all) bySuit[t.suit]++;
  const top = Math.max(bySuit.m, bySuit.t, bySuit.b);
  const n = all.length || 1;
  const mixed = (top + bySuit.z) / n; // 混一色 4 tai
  const pure = top / n; // 清一色 8 tai
  let v = 0;
  v += 4 * clamp((mixed - 0.62) / 0.33);
  v += 4 * clamp((pure - 0.72) / 0.26);
  // 碰碰胡 (4 tai): pairs and triplets, and no runs called.
  if (!p.melds.some((m) => m.kind === "run")) {
    const groups = new Map<string, number>();
    for (const t of hand) groups.set(tileKey(t), (groups.get(tileKey(t)) ?? 0) + 1);
    let sets = p.melds.length;
    for (const c of groups.values()) if (c >= 2) sets++;
    v += 4 * clamp((sets - 3) / 3);
  }
  // Honour pungs: a value honour pair is half a tai, a triplet one.
  const counted = new Set<string>();
  for (const t of all) {
    if (!isValueHonor(t, s, seat) || counted.has(tileKey(t))) continue;
    counted.add(tileKey(t));
    const c = tileCount(all, t);
    v += c >= 3 ? 1 : c === 2 ? 0.5 : 0;
  }
  if (p.melds.every((m) => m.concealed)) v += 1;
  return v;
}

const clamp = (x: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, x));

// ---- Reading the table --------------------------------------------------

// How likely `o` is to be ready, 0..1 - a logistic fit to how often seats
// were really ready in arena play against quick, calling players (npm run
// arena -- --bots basic,speedster,veteran,casual --calibrate): with nothing
// called about 1 in 10 by the 8th discard and 1 in 5 by the 14th; each
// called meld adds about one to the log-odds (two melds by the 11th: an
// even chance). A reader also adds the flush tell and a late run of middle
// tiles.
export function threat(s: GameState, o: number, read: number): number {
  const p = s.players[o];
  // A declared 叮 is ready by definition.
  if (p.riichi) return 1;
  const d = p.discards.length;
  const m = p.melds.filter((x) => !x.concealed).length + 0.6 * p.melds.filter((x) => x.concealed).length;
  let logit = -4.2 + 0.3 * d - 0.006 * d * d + 1.0 * m;
  if (read > 0) {
    if (flushSuit(s, o)) logit += 0.6 * read;
    const middles = p.discards.slice(-3).filter((x) => x.suit !== "z" && x.rank >= 3 && x.rank <= 7).length;
    if (d >= 8) logit += 0.15 * read * middles;
  }
  return 1 / (1 + Math.exp(-logit));
}

// The suit `o` looks to be collecting: every called meld in it (honours
// allowed), or a pond that's thrown almost none of it.
export function flushSuit(s: GameState, o: number): string | null {
  const p = s.players[o];
  const meldSuits = new Set(p.melds.filter((m) => !m.concealed).map((m) => m.tiles[0].suit).filter((x) => x !== "z"));
  if (meldSuits.size === 1 && p.melds.filter((m) => !m.concealed).length >= 2) return [...meldSuits][0];
  if (p.discards.length >= 8) {
    const nums = p.discards.filter((d) => d.suit !== "z");
    for (const suit of ["m", "t", "b"]) {
      const inSuit = nums.filter((d) => d.suit === suit).length;
      if (inSuit === 0 && nums.length >= 6) return suit;
    }
  }
  return null;
}

// How risky `tile` is against `o` specifically, about 0..1.5.
// Which reads tileRisk applies - all by default; the arena's calibration
// switches them one at a time to measure each.
export interface Reads {
  suji: boolean;
  kabe: boolean;
  scarce: boolean;
  flush: boolean;
}
const ALL_READS: Reads = { suji: false, kabe: true, scarce: true, flush: true };

export function tileRisk(s: GameState, viewer: number, o: number, tile: Tile, read: number, unseen: Map<string, number>, reads: Reads = ALL_READS): number {
  const pond = s.players[o].discards;
  const left = unseen.get(tileKey(tile)) ?? 0;
  // Their own discard: safer (no furiten here, so not safe).
  const own = pond.some((d) => sameTile(d, tile)) ? 0.3 : 1;
  if (tile.suit === "z") {
    // Honours only wait as a pair or single: dead once the copies are out.
    const base = left === 0 ? 0.02 : left === 1 ? 0.25 : left === 2 ? 0.45 : 0.6;
    return base * own * (read > 0 && flushSuit(s, o) ? 1.3 : 1);
  }
  const r = tile.rank;
  let risk = r === 1 || r === 9 ? 0.55 : r === 2 || r === 8 ? 0.8 : 1;
  if (read > 0) {
    // 筋 (suji) is measured but off by default: with no furiten a player
    // happily waits on r with r±3 in their own pond, and in arena play
    // suji tiles won about as often as any other (one-sided: more often).
    const threw = (rank: number) => rank >= 1 && rank <= 9 && pond.some((d) => d.suit === tile.suit && d.rank === rank);
    const low = r - 3 < 1 ? true : threw(r - 3);
    const high = r + 3 > 9 ? true : threw(r + 3);
    const suji = !reads.suji ? 1 : low && high ? 0.6 : 1;
    // 壁: with every copy of a neighbour visible, runs through it can't wait
    // on r - the strongest read measured (such tiles won 2-4% vs 9%).
    const gone = (rank: number) => rank < 1 || rank > 9 || (unseen.get(`${tile.suit}${rank}`) ?? 4) === 0;
    const kabe = !reads.kabe ? 1 : (gone(r - 1) || gone(r - 2)) && (gone(r + 1) || gone(r + 2)) ? 0.3 : gone(r + 1) || gone(r - 1) ? 0.7 : 1;
    // Few copies left: shanpon and single waits are less likely too.
    const scarce = !reads.scarce ? 1 : left === 0 ? 0.3 : left === 1 ? 0.75 : 1;
    const flush = reads.flush ? flushSuit(s, o) : null;
    // The flush read is a weak one (off-suit tiles still won 8% of the time).
    const suitRead = flush ? (flush === tile.suit ? 1.25 : 0.8) : 1;
    const informed = risk * suji * kabe * scarce * suitRead;
    risk = risk * (1 - read) + informed * read;
  }
  void viewer;
  return risk * own;
}

// A tile `o` certainly can't win on right now - anyone at the table can
// tell, no reading needed:
// - `o` has declared 叮: any tile thrown since (the declaring discard
//   included). A 叮 hand's wait is fixed, and one that lets a win go by can
//   never win again - so a tile that's been by it is safe for good.
// - the discard that's just gone by unclaimed (過水): `o` didn't win on it,
//   and hasn't thrown since.
// `view`: the ponds as this player remembers them (see rememberedView) - a
// forgotten discard gives nothing away.
export function sureSafe(s: GameState, o: number, tile: Tile, view: GameState = s): boolean {
  const last = s.chase;
  if (last && sameTile(last.tile, tile) && s.phase.kind === "turn") return true;
  const r = s.players[o].riichi;
  if (!r) return false;
  for (let i = 0; i < SEATS; i++) {
    const pond = s.players[i].discards;
    const since = i === o ? r.discard : r.ponds?.[i];
    if (since === undefined) continue;
    const from = Math.max(since, pond.length - view.players[i].discards.length);
    for (let j = from; j < pond.length; j++) if (sameTile(pond[j], tile)) return true;
  }
  return false;
}

// The total danger of throwing `tile`: each opponent's risk weighted by how
// likely they are to be ready, and by how much they'd collect (the dealer
// adds 莊).
// `view`: the table as this player remembers it (see rememberedView) - pond
// reads come from it, while threat still counts every discard (how long a
// pond is, anyone can see).
export function danger(s: GameState, seat: number, tile: Tile, read: number, unseen: Map<string, number>, focus = 0, view: GameState = s, pullSense = 1, grudge = 0): number {
  let d = 0;
  for (let o = 0; o < SEATS; o++) {
    if (o === seat) continue;
    const t = threat(s, o, read);
    if (t <= Math.max(0.02, focus)) continue;
    if (sureSafe(s, o, tile, view)) continue;
    d += t * dealInStake(s, seat, o, pullSense, grudge) * tileRisk(view, seat, o, tile, read, unseen);
  }
  return d;
}

// How much dealing into `o` costs relative to an average deal-in (~26 tai):
// the dealer adds 莊, and 拉 between the two can add a lot. If `o` is
// pulling us, they collect half the 拉 on top and it keeps growing; if we're
// pulling `o`, it's a 踢 - half the 拉 on top, and we lose the 拉 itself
// (counted at a third of its value, what it was likely to earn us). So a
// tile `o` might want is far more dangerous than the same tile against a
// player with no 拉 on us - defence becomes targeted.
// And a grudge: feeding the one it's sore at again stings past the tai.
export function dealInStake(s: GameState, seat: number, o: number, sense = 1, grudge = 0): number {
  const dealer = o === s.dealer || seat === s.dealer ? 1.25 : 1;
  const add = lahAddOn(s.lahs, o, seat);
  const lost = add.kind === "踢" ? add.value / 3 : 0;
  return dealer * (1 + (sense * (add.amount + lost)) / 26) * (1 + GRUDGE_STAKE * grudge * soreAt(s, seat, o));
}
const GRUDGE_STAKE = 0.8;

// What 拉 adds to a win of ours, averaged over who might pay: each pull or
// kick we hold an add-on for counts once (a self-draw collects them all).
export function lahGain(s: GameState, seat: number): number {
  let sum = 0;
  for (let o = 0; o < SEATS; o++) if (o !== seat) sum += lahAddOn(s.lahs, seat, o).amount;
  return sum / 3;
}

// The table as a player with imperfect memory sees it: everyone else's
// pond cut to its most recent discards (memory 1 keeps all; 0 keeps the
// last 3). Your own pond, your hand and every called meld stay in view.
export function rememberedView(s: GameState, seat: number, memory = 1): GameState {
  if (memory >= 1) return s;
  const keep = Math.max(3, Math.round(3 + memory * 17));
  return { ...s, players: s.players.map((p, i) => (i === seat || p.discards.length <= keep ? p : { ...p, discards: p.discards.slice(-keep) })) };
}

// ---- Decisions ----------------------------------------------------------

export interface DiscardChoice {
  tile: Tile;
  shanten: number;
  acceptance: number;
  value: number;
  danger: number;
  score: number;
}

// A deterministic-by-default random source; the arena seeds it.
export type Rng = () => number;

function pick<T extends { score: number; shanten: number }>(options: T[], profile: BotProfile, rng: Rng): T {
  const sorted = options.slice().sort((a, b) => b.score - a.score);
  // A lazy throw: the next-best - but never one that sets the hand back (a
  // ready hand broken up is no slip).
  if (sorted.length > 1 && rng() < profile.slip) return sorted.slice(1).find((o) => o.shanten <= sorted[0].shanten) ?? sorted[0];
  if (profile.noise <= 0) return sorted[0];
  // Softmax over the options, so only near-equal ones get picked by chance.
  const top = sorted[0].score;
  // Scores are in tai, so the temperature is scaled to match.
  const weights = sorted.map((o) => Math.exp((o.score - top) / (profile.noise * 2)));
  const total = weights.reduce((a, b) => a + b, 0);
  let x = rng() * total;
  for (let i = 0; i < sorted.length; i++) {
    x -= weights[i];
    if (x <= 0) return sorted[i];
  }
  return sorted[0];
}

// Are we folding? When someone looks ready, our hand is far off, and this
// player is the folding kind.
function folding(s: GameState, seat: number, sh: number, profile: BotProfile): boolean {
  if (profile.foldAt >= 1) return false;
  let top = 0;
  for (let o = 0; o < SEATS; o++) if (o !== seat) top = Math.max(top, threat(s, o, profile.read));
  // Only a hand that's 2+ from ready, or 1 from it with the wall nearly gone.
  return (sh >= 2 || (sh === 1 && liveTilesLeft(s) < 20)) && top >= profile.foldAt;
}

// The chance this hand wins from here, given its shanten after the discard
// and how many unseen tiles move it on. Each step to ready mostly comes
// from our own draws (calls help the callers), and the last step - the win
// itself - can come off anyone's discard. The 0.8 allows for someone else
// winning first. Rough, but it ranks discards and sets push-or-fold.
export function winChance(s: GameState, sh: number, acc: number, unseenTotal: number, profile: BotProfile): number {
  if (sh < 0) return 1;
  const live = liveTilesLeft(s);
  if (live <= 0 || acc <= 0) return 0;
  const steps = sh + 1;
  const draws = live / SEATS / steps;
  const p = acc / Math.max(1, unseenTotal);
  // When not yet ready, `acc` is the tiles that improve; the final wait is
  // assumed to be a typical 6 tiles.
  const improve = 1 - Math.pow(1 - p, draws * (1 + 0.8 * profile.callAppetite));
  const pw = sh === 0 ? p : 6 / Math.max(1, unseenTotal);
  const finish = 1 - Math.pow(1 - pw, draws * SEATS);
  return Math.pow(improve, sh) * finish * 0.8;
}

// What a win is worth, in tai collected: 底 + typical extras + where the
// hand is heading (counted more by the greedy), times about 1.7 for the
// self-draws, which every player pays.
const winWorth = (value: number, profile: BotProfile, lah = 0) => 1.7 * (7 + value * (0.6 + 0.8 * profile.greed) + lah);

// What dealing in costs as this player feels it: the measured average loss
// (~26 tai), scaled by caution squared (none at all at 0, double for the
// Iron Wall), and more
// while the hand is far off - pushing a far hand means many more risky
// throws to come.
const dealInCost = (sh: number, profile: BotProfile) => 26 * 2 * profile.caution * profile.caution * (1 + 0.25 * Math.max(0, sh));

// In arena play a tile at risk 1 against a ready seat won it about 1 time
// in 9, so danger (risk x readiness, summed) converts to a deal-in chance.
const DEAL_IN_PER_DANGER = 0.11;
// About what a kong brings, in tai: its own, and the replacement draw.
const KONG_WORTH = 3;

// Every distinct legal discard, scored in tai. Building the hand is ranked
// shanten-first (acceptance, then value, break ties) - in arena play that
// finished hands far faster than ranking purely on estimated win chance,
// which let a promising flush outbid a step toward ready. Expected value
// then sets the exchange rate against danger: a step toward ready is worth
// what it adds to win chance x the hand's worth right now, and a throw
// costs its deal-in chance x what dealing in costs. Folding needs no
// special case - with the hand far off and the table hot, the safest tile
// simply scores best.
export function rateDiscardsFor(s: GameState, seat: number, profile: BotProfile): DiscardChoice[] {
  const p = s.players[seat];
  const melds = meldsNeeded(p);
  const view = rememberedView(s, seat, profile.memory);
  const unseen = unseenCounts(view, seat);
  let unseenTotal = 0;
  for (const v of unseen.values()) unseenTotal += Math.max(0, v);
  const routes = specialRoutes(s, seat, profile, unseen);
  const anyKind = routes.sixteen || routes.orphans;
  const forbidden = s.phase.kind === "turn" && s.phase.seat === seat ? forbiddenDiscards(s) : [];
  const seen = new Set<string>();
  const out: (DiscardChoice & { build: number })[] = [];
  for (const t of p.hand) {
    if (seen.has(tileKey(t)) || forbidden.some((f) => sameTile(f, t))) continue;
    seen.add(tileKey(t));
    const rest = removeTiles(p.hand, [t]);
    const sh = shanten(rest, melds, routes);
    const acc = acceptance(rest, melds, sh, unseen, routes, anyKind);
    const value = handValue(s, seat, rest, p);
    const d = danger(s, seat, t, profile.read, unseen, profile.focus, view, profile.pullSense ?? 1, profile.grudge ?? 0);
    // In shanten steps: one step = 1.
    const build = -sh + 0.5 * profile.speed * (acc / (acc + 25)) + 0.07 * profile.greed * value;
    out.push({ tile: t, shanten: sh, acceptance: acc, value, danger: d, score: 0, build });
  }
  const best = out.reduce((a, b) => (b.build > a.build ? b : a));
  // A win is worth more when we hold 拉 or 踢 add-ons, so pushing pays more.
  const worth = winWorth(best.value, profile, (profile.pullSense ?? 1) * lahGain(s, seat));
  const stepTai = Math.max(
    0.4,
    worth * (winChance(s, best.shanten, best.acceptance, unseenTotal, profile) - winChance(s, best.shanten + 1, best.acceptance, unseenTotal, profile))
  );
  for (const o of out) o.score = o.build * stepTai - DEAL_IN_PER_DANGER * o.danger * dealInCost(o.shanten, profile);
  return out.sort((a, b) => b.score - a.score);
}


export function botTurnMoveFor(s: GameState, profile: BotProfile, rng: Rng = Math.random): TurnMove {
  return botTurnFor(s, profile, rng).move;
}

// The kongs a bot will make this turn: an added kong (加槓) only with the
// tile it's just drawn - never straight after claiming the pung, nor with a
// fourth it kept in hand (it kept that for its hand), as no player would.
export function botKongs(s: GameState): KongMove[] {
  if (s.phase.kind !== "turn") return [];
  const { drawn } = s.phase;
  return kongOptions(s.players[s.phase.seat], s.phase).filter((k) => k.kind !== "addedKong" || (drawn !== null && sameTile(drawn, k.tile)));
}

// The move, and how hard it was to choose, 0..1 - the Play table uses it to
// pace the bot like a person: an obvious throw goes at once, a close or
// dangerous one gets a pause.
export function botTurnFor(s: GameState, own: BotProfile, rng: Rng = Math.random): { move: TurnMove; difficulty: number } {
  if (s.phase.kind !== "turn") throw new Error("Not a turn");
  const seat = s.phase.seat;
  const profile = inMood(own, s, seat);
  const p = s.players[seat];
  if (canWin(p)) return { move: { kind: "selfDraw" }, difficulty: 0.2 };
  const forced = riichiForcedDiscard(s);
  if (forced) return { move: { kind: "discard", tile: forced }, difficulty: 0 };
  const options = rateDiscardsFor(s, seat, profile);
  const best = options[0];
  if (liveTilesLeft(s) > 0 && !folding(s, seat, best.shanten, profile)) {
    for (const k of botKongs(s)) {
      if (k.kind === "addedKong") {
        // Not when the tile does more kept (it gets the hand a step closer),
        // nor when it's too likely to be robbed (搶槓) for what a kong brings.
        const kept = options.find((o) => sameTile(o.tile, k.tile));
        const without = shanten(removeTiles(p.hand, [k.tile]), meldsNeeded(p));
        if (best.shanten < without) continue;
        if (kept && DEAL_IN_PER_DANGER * kept.danger * dealInCost(without, profile) > KONG_WORTH) continue;
        return { move: k, difficulty: 0.3 };
      }
      // A concealed one only if it doesn't set the hand back.
      const rest = removeTiles(p.hand, [k.tile, k.tile, k.tile, k.tile]);
      if (shanten(rest, meldsNeeded(p) - 1) <= best.shanten) return { move: k, difficulty: 0.6 };
    }
  }
  const choice = pick(options, profile, rng);
  const riichi = shouldRiichi(s, seat, choice, profile, rng);
  // Close: the top two options nearly tied. Tense: the pick is a risky throw.
  const gap = options.length > 1 ? options[0].score - options[1].score : 9;
  const close = Math.max(0, 1 - gap / 1.2);
  const tense = Math.min(1, choice.danger * 1.5);
  const difficulty = Math.min(1, 0.65 * close + 0.35 * tense + (riichi ? 0.5 : 0));
  return { move: { kind: "discard", tile: choice.tile, ...(riichi ? { riichi: true } : {}) }, difficulty };
}

// Declare 叮 with this discard? Only when it leaves the hand ready on a
// wait with live tiles; a wider wait and a concealed hand (門清叮 is 10
// tai, plain 叮 5) make it likelier, scaled by the profile's appetite.
function shouldRiichi(s: GameState, seat: number, choice: DiscardChoice, profile: BotProfile, rng: Rng): boolean {
  if (profile.riichi <= 0 || choice.shanten !== 0 || choice.acceptance < 2) return false;
  if (!riichiDiscards(s, seat).some((t) => sameTile(t, choice.tile))) return false;
  const concealed = s.players[seat].melds.every((m) => m.concealed);
  const wide = Math.min(1, choice.acceptance / 8);
  const want = profile.riichi * (0.35 + 0.65 * wide) * (concealed ? 1 : 0.6);
  return rng() < want;
}

// The tai a win off the tile up for claiming would score - worked out as the
// table would score it (secondChanceFan): the tile out of the discarder's
// pond first (left there, the ponds read one tile fuller - a 四/七/十子內
// win at its last tile read as past it, and 明絕 counted the winning tile
// among those in sight), and a kong robbed scored as one. (On its own: who
// else wins off it isn't known yet.)
function winTai(s: GameState, seat: number): number {
  return secondChanceFan(s, seat, 0) ?? 0;
}

export function botClaimFor(s: GameState, seat: number, own: BotProfile, rng: Rng = Math.random): Claim | null {
  const profile = inMood(own, s, seat);
  const options = claimOptions(s, seat);
  if (options.length === 0 || s.phase.kind !== "claims") return null;
  const { tile, from } = s.phase;
  const p = s.players[seat];
  if (options.some((o) => o.kind === "win")) {
    // The Hunter lets a small win go by while the wall is deep - never with
    // 叮 declared (that hand couldn't win again), nor off someone it has a
    // score to settle with.
    // (A 拉 or 踢 on the discarder counts toward it.)
    if (profile.minTai > 0 && !p.riichi && !bearsGrudge(s, seat, from, profile) && liveTilesLeft(s) > 36 && winTai(s, seat) + lahAddOn(s.lahs, seat, from).amount < profile.minTai) return null;
    return { kind: "win" };
  }
  const melds = meldsNeeded(p);
  const now = shanten(p.hand, melds, specialRoutes(s, seat, profile, unseenCounts(rememberedView(s, seat, profile.memory), seat)));
  if (folding(s, seat, now, profile)) return null;
  const valueNow = handValue(s, seat, p.hand, p);
  const concealed = p.melds.every((m) => m.concealed);

  // Shanten and value after the call and its best discard.
  const after = (used: Tile[], kind: "run" | "triplet" | "kong") => {
    const rest = removeTiles(p.hand, used);
    // 食替, as the table bars it (waived when it leaves nothing to throw).
    const ban = swapDiscardBan(tile, kind === "run" ? used : undefined);
    const barred = (t: Tile) => ban.some((b) => sameTile(b, t));
    const waived = rest.every(barred);
    const meld = { kind, tiles: [...used, tile], concealed: false, from };
    const p2: Player = { ...p, melds: [...p.melds, meld] };
    if (kind === "kong") return { sh: shanten(rest, melds - 1), value: handValue(s, seat, rest, p2) };
    let sh = Infinity;
    let value = 0;
    for (const t of rest) {
      if (!waived && barred(t)) continue;
      const r2 = removeTiles(rest, [t]);
      const s2 = shanten(r2, melds - 1);
      const v2 = handValue(s, seat, r2, p2);
      if (s2 < sh || (s2 === sh && v2 > value)) {
        sh = s2;
        value = v2;
      }
    }
    return { sh, value };
  };

  let best: { claim: Claim; score: number } | null = null;
  for (const o of options) {
    if (o.kind === "win") continue;
    const used = o.kind === "chow" ? o.tiles : o.kind === "kong" ? [tile, tile, tile] : [tile, tile];
    const res = after(used, o.kind === "chow" ? "run" : o.kind === "kong" ? "kong" : "triplet");
    const gain = now - res.sh;
    let score = gain * (0.55 + 0.45 * profile.callAppetite) + 0.25 * profile.greed * (res.value - valueNow);
    // Giving up 門清 costs a tai (more with a self-draw); the patient player feels it.
    if (concealed) score -= (1 - profile.callAppetite) * 0.7 + 0.1;
    if (o.kind === "chow") score -= 0.15;
    if (o.kind === "kong") score += 0.6; // 槓 scores and draws a replacement
    if (isValueHonor(tile, s, seat) && o.kind !== "chow") score += 0.5;
    if (gain < 0) score -= 1;
    if (!best || score > best.score) best = { claim: o, score };
  }
  if (!best) return null;
  const threshold = 0.15 - (rng() < profile.slip ? 0.5 : 0);
  return best.score > threshold ? best.claim : null;
}

// Between hands: the holders this bot concedes a 拉 to (投降). Only 拉 the
// rules allow; it gives up one once the 拉 is big enough for its taste -
// keeping it means paying half again (and more) if the holder wins from it
// once more, against the chance of 踢-ing it back for half.
// (To someone it bears a grudge against, only a bigger one still.)
export function botSurrenders(s: GameState, seat: number, profile: BotProfile): number[] {
  const eager = profile.surrender ?? 0.3;
  if (eager <= 0) return [];
  const threshold = 30 + (1 - eager) * 150;
  return surrenderable(s, seat)
    .filter((l) => l.value >= threshold * (1 + (profile.grudge ?? 0) * soreAt(s, seat, Number(l.holder))))
    .map((l) => Number(l.holder));
}

// Sore enough at `o`, and the kind to act on it.
export const GRUDGE_FROM = 0.3;
export const bearsGrudge = (s: GameState, seat: number, o: number, profile: BotProfile) => (profile.grudge ?? 0) * soreAt(s, seat, o) >= GRUDGE_FROM;

// ---- After the hand: what it was up to -----------------------------------
//
// A line or two for the result card, from what's now face up: its hand, the
// table, and - where its personality is known - why. With `profile` null (a
// mystery bot, a person) only what the tiles themselves say.

export type Aim = "flush" | "pungs" | "十六不搭" | "嚦咕嚦咕" | "十三么";
export type Thought =
  | { kind: "passed" } // let a win go by, and couldn't win after
  | { kind: "ready"; waits: Tile[]; left: number } // waiting, and on how many still to come
  | { kind: "folded"; against: number } // gave its hand up, afraid of that seat
  | { kind: "away"; away: number; aim: Aim | null } // this far from ready, and what it was building
  | { kind: "mood"; form: "losing" | "winning" } // its temper was up
  | { kind: "sore"; at: number }; // it had a score to settle

export function botThoughts(s: GameState, seat: number, own: BotProfile | null): Thought[] {
  if (s.phase.kind !== "over") return [];
  const r = s.phase.result;
  if (r.winner === seat || r.alsoWon?.some((w) => w.winner === seat)) return [];
  const p = s.players[seat];
  const melds = meldsNeeded(p);
  // (Face up, and a hand between turns.)
  if (p.hand.length !== melds * 3 + 1 || p.hand.some((t) => t.rank === 0)) return [];
  const profile = own && inMood(own, s, seat);
  const out: Thought[] = [];
  const sh = rawShanten(p.hand, melds);
  if (p.overWater || p.riichi?.passed) out.push({ kind: "passed" });
  if (sh <= 0) {
    const unseen = unseenCounts(s, seat);
    const waits = ALL_KINDS.filter((k) => isWinningHand(p, k));
    out.push({ kind: "ready", waits, left: waits.reduce((n, k) => n + Math.max(0, unseen.get(tileKey(k)) ?? 0), 0) });
  } else {
    let against = -1;
    for (let o = 0; o < SEATS; o++) if (o !== seat && (against < 0 || threat(s, o, profile?.read ?? 0) > threat(s, against, profile?.read ?? 0))) against = o;
    if (profile && folding(s, seat, sh, profile)) out.push({ kind: "folded", against });
    out.push({ kind: "away", away: sh, aim: aimOf(p, sh) });
  }
  if (own && profile !== own) out.push({ kind: "mood", form: (s.feel?.form[seat] ?? 0) < 0 ? "losing" : "winning" });
  if (own) {
    let at = -1;
    for (let o = 0; o < SEATS; o++) if (o !== seat && bearsGrudge(s, seat, o, own) && (at < 0 || soreAt(s, seat, o) > soreAt(s, seat, at))) at = o;
    if (at >= 0) out.push({ kind: "sore", at });
  }
  return out;
}

// What a hand that isn't ready was being built into, if it shows.
function aimOf(p: Player, sh: number): Aim | null {
  if (!p.melds.length) {
    const d = specialDistances(p.hand);
    if (d.orphans <= sh && d.orphans <= 3) return "十三么";
    if (d.sixteen <= sh && d.sixteen <= 3) return "十六不搭";
    if (d.pairs <= sh && d.pairs <= 2) return "嚦咕嚦咕";
  }
  const all = [...p.hand, ...p.melds.flatMap((m) => m.tiles)];
  const suited = all.filter((t) => t.suit !== "z");
  const top = Math.max(...["m", "t", "b"].map((suit) => suited.filter((t) => t.suit === suit).length));
  if (suited.length >= 8 && top / suited.length >= 0.85) return "flush";
  if (!p.melds.some((m) => m.kind === "run")) {
    const counts = new Map<string, number>();
    for (const t of p.hand) counts.set(tileKey(t), (counts.get(tileKey(t)) ?? 0) + 1);
    if (p.melds.length + [...counts.values()].filter((c) => c >= 2).length >= 5) return "pungs";
  }
  return null;
}

const SUIT_WORD: Record<string, string> = { m: "萬", t: "筒", b: "索" };
const tileWord = (t: Tile) => (t.suit === "z" ? "東南西北中發白"[t.rank - 1] : `${t.rank}${SUIT_WORD[t.suit] ?? ""}`);

// A thought in words. `name`: what to call a seat ("you", a bot's name).
export function thoughtLine(t: Thought, name: (seat: number) => string): string {
  switch (t.kind) {
    case "passed":
      return "Let a win go by - and couldn't win after";
    case "ready":
      return t.waits.length ? `Ready, waiting on ${t.waits.map(tileWord).join(" ")} - ${t.left ? `${t.left} left` : "none left"}` : "Ready";
    case "folded":
      return `Gave the hand up - wary of ${name(t.against)}`;
    case "away":
      return `${t.away} from ready${t.aim ? `, building ${t.aim === "flush" ? "a flush" : t.aim === "pungs" ? "all pungs (對對胡)" : t.aim}` : ""}`;
    case "mood":
      return t.form === "losing" ? "On a losing run - and playing like it" : "On a winning run - and playing like it";
    case "sore":
      return `Had a score to settle with ${name(t.at)}`;
  }
}

// A small seeded PRNG (mulberry32) for repeatable arena runs.
export function seededRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
