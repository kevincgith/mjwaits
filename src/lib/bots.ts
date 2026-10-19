// Bots with personalities. Every bot runs the same decision engine - a
// discard is scored on speed (how close it leaves the hand to ready and how
// many tiles improve it), value (where the hand's tai are heading) and
// danger (how likely it is to feed someone who's ready) - and a profile
// sets how much each of those matters, how readily it calls, how well it
// reads the table and how often it plays a little loose, the way people do.
//
// Taiwanese 16-tile has no 振聽 (furiten): a player can win off a tile they
// threw earlier, so nothing is ever fully safe. A player's own discards and
// their 筋 (suji) are only *safer*, never "genbutsu" as in riichi.

import {
  claimOptions,
  forbiddenDiscards,
  isWinningHand,
  kongOptions,
  liveTilesLeft,
  meldsNeeded,
  riichiDiscards,
  riichiForcedDiscard,
  sameTile,
  scoreWin,
  SEATS,
  seatWind,
  unseenCounts,
  type Claim,
  type GameState,
  type Player,
  type TurnMove,
} from "./game";
import { allTileKinds, shanten as rawShanten, tileCount, tileKey, type Tile } from "./mahjong";

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
  // still deep (0 = takes every win).
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
  // ---- Human feel ----
  // Softmax temperature over near-equal choices (0 = always the top pick).
  noise: number;
  // Chance per decision of a lazy pick - the second-best discard, or a call
  // it would normally pass on.
  slip: number;
}

export const BOT_PROFILES: BotProfile[] = [
  {
    id: "veteran",
    name: "老手 Veteran",
    blurb: "The strongest: fast and eager to call, always declares 叮 when ready, defends lightly - the settings that won the arena runs.",
    speed: 1,
    greed: 0,
    minTai: 0,
    riichi: 1,
    callAppetite: 1,
    caution: 0.35,
    foldAt: 1,
    read: 0.95,
    noise: 0.04,
    slip: 0.01,
  },
  {
    id: "speedster",
    name: "快手 Speedster",
    blurb: "Calls everything and races to ready; cheap, fast wins.",
    speed: 1.3,
    greed: 0,
    minTai: 0,
    riichi: 0.9,
    callAppetite: 1,
    caution: 0.15,
    foldAt: 0.7,
    read: 0.5,
    noise: 0.08,
    slip: 0.03,
  },
  {
    id: "hunter",
    name: "大牌 Hunter",
    blurb: "Chases flushes, all-pungs and honours; passes on small wins early.",
    speed: 0.7,
    greed: 0.95,
    minTai: 5,
    riichi: 0.7,
    callAppetite: 0.5,
    caution: 0.5,
    foldAt: 0.5,
    read: 0.7,
    noise: 0.06,
    slip: 0.02,
  },
  {
    id: "wall",
    name: "鐵壁 Iron Wall",
    blurb: "Keeps 門清, deals in almost never and folds at the first sign of danger.",
    speed: 0.9,
    greed: 0.35,
    minTai: 0,
    riichi: 0.3,
    callAppetite: 0.15,
    caution: 1,
    foldAt: 0.3,
    read: 1,
    noise: 0.03,
    slip: 0.01,
  },
  {
    id: "gambler",
    name: "賭徒 Gambler",
    blurb: "Never folds, pushes every hand, likes a big swing.",
    speed: 1,
    greed: 0.6,
    minTai: 0,
    riichi: 1,
    callAppetite: 0.7,
    caution: 0,
    foldAt: 1,
    read: 0.2,
    noise: 0.15,
    slip: 0.04,
  },
  {
    id: "casual",
    name: "街坊 Casual",
    blurb: "A friendly club player: decent tile sense, loose reads, the odd lazy throw.",
    speed: 0.8,
    greed: 0.4,
    minTai: 0,
    riichi: 0.6,
    callAppetite: 0.6,
    caution: 0.4,
    foldAt: 0.6,
    read: 0.3,
    noise: 0.35,
    slip: 0.08,
  },
];

export const profileById = (id: string) => BOT_PROFILES.find((p) => p.id === id) ?? BOT_PROFILES[0];

// ---- Helpers ------------------------------------------------------------

// Shanten is the hot path (every discard x every improving draw), and the
// same hands recur turn to turn, so results are memoised by sorted hand.
const shantenCache = new Map<string, number>();
function shanten(tiles: Tile[], melds: number): number {
  const key = melds + ":" + tiles.map(tileKey).sort().join("");
  let v = shantenCache.get(key);
  if (v === undefined) {
    v = rawShanten(tiles, melds);
    if (shantenCache.size > 400_000) shantenCache.clear();
    shantenCache.set(key, v);
  }
  return v;
}

const ALL_KINDS = allTileKinds();

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

function acceptance(rest: Tile[], melds: number, sh: number, unseen: Map<string, number>): number {
  let n = 0;
  for (const k of improvers(rest)) {
    const left = unseen.get(tileKey(k)) ?? 0;
    if (left > 0 && shanten([...rest, k], melds) < sh) n += left;
  }
  return n;
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

// The total danger of throwing `tile`: each opponent's risk weighted by how
// likely they are to be ready, and by how much they'd collect (the dealer
// adds 莊).
export function danger(s: GameState, seat: number, tile: Tile, read: number, unseen: Map<string, number>, focus = 0): number {
  let d = 0;
  for (let o = 0; o < SEATS; o++) {
    if (o === seat) continue;
    const t = threat(s, o, read);
    if (t <= Math.max(0.02, focus)) continue;
    const stake = o === s.dealer || seat === s.dealer ? 1.25 : 1;
    d += t * stake * tileRisk(s, seat, o, tile, read, unseen);
  }
  return d;
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

function pick<T extends { score: number }>(options: T[], profile: BotProfile, rng: Rng): T {
  const sorted = options.slice().sort((a, b) => b.score - a.score);
  if (sorted.length > 1 && rng() < profile.slip) return sorted[1];
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
  // Most players fold only a hand that's 2+ from ready (or 1 from it with
  // the wall nearly gone); the very cautious fold a 1-from-ready hand too,
  // and drop even a ready one against a seat that's clearly ready.
  if (sh >= 2 || (sh === 1 && (liveTilesLeft(s) < 20 || profile.caution >= 0.9))) return top >= profile.foldAt;
  if (sh <= 0 && profile.caution >= 0.9) return top >= Math.min(0.9, profile.foldAt * 3);
  return false;
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
const winWorth = (value: number, profile: BotProfile) => 1.7 * (7 + value * (0.6 + 0.8 * profile.greed));

// What dealing in costs as this player feels it: the measured average loss
// (~26 tai), scaled by caution squared (none at all at 0, double for the
// Iron Wall), and more
// while the hand is far off - pushing a far hand means many more risky
// throws to come.
const dealInCost = (sh: number, profile: BotProfile) => 26 * 2 * profile.caution * profile.caution * (1 + 0.25 * Math.max(0, sh));

// In arena play a tile at risk 1 against a ready seat won it about 1 time
// in 9, so danger (risk x readiness, summed) converts to a deal-in chance.
const DEAL_IN_PER_DANGER = 0.11;

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
  const unseen = unseenCounts(s, seat);
  let unseenTotal = 0;
  for (const v of unseen.values()) unseenTotal += Math.max(0, v);
  const forbidden = s.phase.kind === "turn" && s.phase.seat === seat ? forbiddenDiscards(s) : [];
  const seen = new Set<string>();
  const out: (DiscardChoice & { build: number })[] = [];
  for (const t of p.hand) {
    if (seen.has(tileKey(t)) || forbidden.some((f) => sameTile(f, t))) continue;
    seen.add(tileKey(t));
    const rest = removeTiles(p.hand, [t]);
    const sh = shanten(rest, melds);
    const acc = acceptance(rest, melds, sh, unseen);
    const value = handValue(s, seat, rest, p);
    const d = danger(s, seat, t, profile.read, unseen, profile.focus);
    // In shanten steps: one step = 1.
    const build = -sh + 0.5 * profile.speed * (acc / (acc + 25)) + 0.07 * profile.greed * value;
    out.push({ tile: t, shanten: sh, acceptance: acc, value, danger: d, score: 0, build });
  }
  const best = out.reduce((a, b) => (b.build > a.build ? b : a));
  const worth = winWorth(best.value, profile);
  const stepTai = Math.max(
    0.4,
    worth * (winChance(s, best.shanten, best.acceptance, unseenTotal, profile) - winChance(s, best.shanten + 1, best.acceptance, unseenTotal, profile))
  );
  for (const o of out) o.score = o.build * stepTai - DEAL_IN_PER_DANGER * o.danger * dealInCost(o.shanten, profile);
  return out.sort((a, b) => b.score - a.score);
}


export function botTurnMoveFor(s: GameState, profile: BotProfile, rng: Rng = Math.random): TurnMove {
  if (s.phase.kind !== "turn") throw new Error("Not a turn");
  const seat = s.phase.seat;
  const p = s.players[seat];
  if (isWinningHand(p)) return { kind: "selfDraw" };
  const forced = riichiForcedDiscard(s);
  if (forced) return { kind: "discard", tile: forced };
  const options = rateDiscardsFor(s, seat, profile);
  const best = options[0];
  if (liveTilesLeft(s) > 0 && !folding(s, seat, best.shanten, profile)) {
    for (const k of kongOptions(p)) {
      // An added kong costs nothing; a concealed one only if it doesn't set the hand back.
      if (k.kind === "addedKong") return k;
      const rest = removeTiles(p.hand, [k.tile, k.tile, k.tile, k.tile]);
      if (shanten(rest, meldsNeeded(p) - 1) <= best.shanten) return k;
    }
  }
  const choice = pick(options, profile, rng);
  return { kind: "discard", tile: choice.tile, ...(shouldRiichi(s, seat, choice, profile, rng) ? { riichi: true } : {}) };
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

// The tai a win off this discard would score.
function winTai(s: GameState, seat: number, tile: Tile, from: number): number {
  const trial: GameState = { ...s, players: s.players.map((pl, i) => (i === seat ? { ...pl, hand: [...pl.hand, tile] } : pl)) };
  try {
    return scoreWin(trial, seat, from, tile, null).total;
  } catch {
    return 0;
  }
}

export function botClaimFor(s: GameState, seat: number, profile: BotProfile, rng: Rng = Math.random): Claim | null {
  const options = claimOptions(s, seat);
  if (options.length === 0 || s.phase.kind !== "claims") return null;
  const { tile, from } = s.phase;
  const p = s.players[seat];
  if (options.some((o) => o.kind === "win")) {
    // The Hunter lets a small win go by while the wall is deep.
    if (profile.minTai > 0 && liveTilesLeft(s) > 36 && winTai(s, seat, tile, from) < profile.minTai) return null;
    return { kind: "win" };
  }
  const melds = meldsNeeded(p);
  const now = shanten(p.hand, melds);
  if (folding(s, seat, now, profile)) return null;
  const valueNow = handValue(s, seat, p.hand, p);
  const concealed = p.melds.every((m) => m.concealed);

  // Shanten and value after the call and its best discard.
  const after = (used: Tile[], kind: "run" | "triplet" | "kong") => {
    const rest = removeTiles(p.hand, used);
    const meld = { kind, tiles: [...used, tile], concealed: false, from };
    const p2: Player = { ...p, melds: [...p.melds, meld] };
    if (kind === "kong") return { sh: shanten(rest, melds - 1), value: handValue(s, seat, rest, p2) };
    let sh = Infinity;
    let value = 0;
    for (const t of rest) {
      if (sameTile(t, tile)) continue; // 食替
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
