// A playable 4-seat Taiwanese 16-tile hand: one human (seat 0) against three
// local bots (seats 1-3, counter-clockwise turn order 0 -> 1 -> 2 -> 3).
//
// Pure state + transitions, no React: every function takes a GameState and
// returns a new one (or a list of the moves open to a seat), so the Play tab
// just renders state and feeds back what the human or a bot picked.
//
// Rules modelled: 144 tiles (136 + 8 flowers/seasons), 16 tiles each, bonus
// tiles set aside and replaced from the back of the wall, chow (from the
// player on your left only), pung, exposed / concealed / added kong with a
// replacement draw, win off a discard or by self-draw, and an exhaustive draw
// once the live wall is down to its last DEAD_WALL_SIZE tiles. Claim priority
// is win > pung/kong > chow; two wins off one discard go to the first winner
// in turn order (截胡). 叮 (riichi): a ready player may declare with a
// discard, which locks the hand (see Riichi). Not modelled: robbing a kong
// and other purely declared house calls.
//
// Scoring hands the finished hand to scoring.ts's scoreParsedHand, with the
// context the table actually knows (seat/round wind, self-draw, the winning
// tile, last-tile / replacement-draw / heavenly wins, dealer).

import {
  allTileKinds,
  isCompleteHand,
  MELDS_REQUIRED,
  shanten,
  sortTiles,
  tileCount,
  tileKey,
  type Tile,
} from "./mahjong";
import { DEFAULT_SETTINGS, nextLahs, previewWin, type Lah, type PairPayment, type ScoreSettings } from "./ledger";
import {
  scoreParsedHand,
  type BonusTile,
  type GameContext,
  type MeldDeclaration,
  type RiichiState,
  type ScoreResult,
  type Wind,
} from "./scoring";

export const SEATS = 4;
export const HUMAN = 0;
// Tiles left unplayed at the back of the wall: once only these remain, the
// hand is an exhaustive draw (流局). Taiwanese tables commonly keep 16.
export const DEAD_WALL_SIZE = 16;

export type WallTile = { tile: Tile } | { bonus: BonusTile };

export interface GameMeld {
  kind: "run" | "triplet" | "kong";
  tiles: Tile[];
  concealed: boolean;
  // Who it was claimed from (null for concealed kongs). An added kong keeps
  // its original pung's source.
  from: number | null;
}

// 叮: declared with a discard that leaves the hand ready. From then on the
// hand is locked - every draw that doesn't win is thrown, and the player can
// call only a win. `state` is 天叮 (dealer) / 地叮 when declared with the
// player's first discard before any call, else plain 叮. `discard` is the
// index in the pond of the declaring tile (drawn sideways). `ippatsu` (一發)
// holds until the player's next discard or any call at the table.
export interface Riichi {
  state: Exclude<RiichiState, "none">;
  discard: number;
  ippatsu: boolean;
}

export interface Player {
  hand: Tile[];
  melds: GameMeld[];
  flowers: BonusTile[];
  discards: Tile[];
  riichi?: Riichi;
}

export type Phase =
  // `seat` holds a full hand (3k+2 tiles) and must discard, kong or win.
  // `forbidden`: 食替 - tiles that can't be discarded straight after a chow or
  // pung (see swapDiscardBan). Optional so games saved before it load as "none".
  | { kind: "turn"; seat: number; drawn: Tile | null; replacement: "flower" | "kong" | null; forbidden?: Tile[] }
  // `seat` just discarded `tile`; the others may claim it.
  | { kind: "claims"; from: number; tile: Tile }
  | { kind: "over"; result: HandResult };

export interface HandResult {
  winner: number | null; // null = exhaustive draw
  from: number | null; // discarder, null on self-draw / draw
  tile: Tile | null;
  score: ScoreResult | null;
  scoreError: string | null;
  // Tai change per seat: the winner gains what the payer(s) lose.
  deltas: number[];
  // Each payer's share, with any 拉/踢 add-on (see settleWin). Optional so
  // results saved before 拉 load.
  pairs?: PairPayment[];
}

export interface GameState {
  wall: WallTile[]; // live wall: draws come off the front, replacements off the back
  players: Player[];
  dealer: number;
  roundWind: Wind;
  dealerStreak: number; // consecutive dealer wins/draws before this hand (連莊)
  phase: Phase;
  // True until the first claim or the dealer's first discard round completes -
  // what heavenly/earthly wins need.
  firstGoAround: boolean;
  discardsMade: number;
  log: string[];
  // 拉 between seats ("0".."3"), carried from hand to hand - the house
  // rules the Scores tab keeps (see ledger.ts): a repeat win off the same
  // player adds half the 拉, winning back (踢) adds half and resets it, a
  // draw keeps every 拉 and any other win ends the holder's. Optional so
  // games saved before 拉 load.
  lahs?: Lah[];
  // The dealer's three dice for this deal (see rollDice); absent when the
  // wall was laid out in advance (the arena's duplicate deals).
  dice?: Dice;
  // What the dice pay before the first discard (圍骰), per seat, and whether
  // the table has already paid it - so a reload can't pay it twice.
  diceBonus?: { name: string; deltas: number[]; paid: boolean };
  // Bonuses paid at the table during the hand - flowers (花 / 草 / 花草 /
  // 八仙過海, 7搶1 / 1搶7, see flowerBonus), 暗槓 and 追 - in the order they
  // came, each marked once the table has paid it.
  tableBonuses?: TableBonus[];
  // The run of the same tile discarded seat after seat with no call between,
  // toward 追 (see CHASE_PENALTY).
  chase?: { seat: number; tile: Tile; run: number };
}

export interface TableBonus {
  seat: number;
  name: "花" | "草" | "花草" | "八仙過海" | "7搶1" | "1搶7" | "暗槓" | "追";
  deltas: number[];
  paid: boolean;
}

// Seats as the ledger names players, and its settlement with everything
// the tai list already counts (底, 莊, 連莊) switched off so nothing is
// counted twice - leaving the 拉/踢 add-on.
const SEAT_IDS = ["0", "1", "2", "3"];
const PLAY_LAH_SETTINGS: ScoreSettings = { ...DEFAULT_SETTINGS, base: 0, dealerTai: 0, streakTai: 0, integerMode: true, lahRound: "up", tiRound: "up" };

// What one winner collects, per payer, given the 拉 in play - the same
// numbers the Scores tab's 食胡 sheet would show.
export function settleWin(lahs: Lah[], dealer: number, winner: number, from: number | null, tai: number): PairPayment[] {
  return previewWin({ seats: SEAT_IDS, dealer, streak: 0, lahs, settings: PLAY_LAH_SETTINGS }, [{ seat: winner, tai }], from);
}

// The 拉/踢 add-on `winner` would get from `payer` right now (0 if none).
export function lahAddOn(lahs: Lah[] | undefined, winner: number, payer: number): { amount: number; kind: "拉" | "踢" | null; value: number } {
  const pull = lahs?.find((l) => l.holder === SEAT_IDS[winner] && l.pulled === SEAT_IDS[payer]);
  if (pull) return { amount: Math.ceil(pull.value / 2), kind: "拉", value: pull.value };
  const kick = lahs?.find((l) => l.holder === SEAT_IDS[payer] && l.pulled === SEAT_IDS[winner]);
  if (kick) return { amount: Math.ceil(kick.value / 2), kind: "踢", value: kick.value };
  return { amount: 0, kind: null, value: 0 };
}

// 投降: a player 拉'd 3 or more times in a row by the same holder may end
// that 拉 between hands, paying nothing - giving up the chance to 踢 it back -
// but only straight after a hand that involved them: the holder has just
// won from them (their discard, or the holder's self-draw). After a draw,
// or a hand the holder won off someone else, the 拉 stands.
// This is the Play table's house rule; the Scores tab leaves 投降 to the
// players (house rules vary).
export const SURRENDER_AFTER = 3;

// The 拉 `pulled` may surrender right now: its chain against them is long
// enough, and the hand is over (surrender happens between hands).
export function surrenderable(s: GameState, pulled: number): Lah[] {
  if (s.phase.kind !== "over") return [];
  const paid = s.phase.result.pairs ?? [];
  return (s.lahs ?? []).filter(
    (l) => l.pulled === SEAT_IDS[pulled] && l.count >= SURRENDER_AFTER && paid.some((p) => p.winner === l.holder && p.payer === l.pulled)
  );
}

export function surrender(s: GameState, holder: number, pulled: number): GameState {
  if (!surrenderable(s, pulled).some((l) => l.holder === SEAT_IDS[holder])) throw new Error("投降 needs a 拉 of 3 or more, between hands");
  return { ...s, lahs: (s.lahs ?? []).filter((l) => !(l.holder === SEAT_IDS[holder] && l.pulled === SEAT_IDS[pulled])) };
}

// ---- Wall ---------------------------------------------------------------

function randomInt(n: number): number {
  return Math.floor(Math.random() * n);
}

function shuffled<T>(arr: T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function fullWall(): WallTile[] {
  const wall: WallTile[] = [];
  for (const kind of allTileKinds()) for (let i = 0; i < 4; i++) wall.push({ tile: { ...kind } });
  for (const kind of ["flower", "season"] as const)
    for (const rank of [1, 2, 3, 4] as const) wall.push({ bonus: { kind, rank } });
  return wall;
}

export function seatWind(seat: number, dealer: number): Wind {
  return (((seat - dealer + SEATS) % SEATS) + 1) as Wind;
}

export const sameTile = (a: Tile, b: Tile) => a.suit === b.suit && a.rank === b.rank;

function removeTiles(hand: Tile[], tiles: Tile[]): Tile[] {
  const out = hand.slice();
  for (const t of tiles) {
    const i = out.findIndex((h) => sameTile(h, t));
    if (i < 0) throw new Error(`Tile ${tileKey(t)} not in hand`);
    out.splice(i, 1);
  }
  return out;
}

function cloneState(s: GameState): GameState {
  return {
    ...s,
    wall: s.wall.slice(),
    players: s.players.map((p) => ({
      hand: p.hand.slice(),
      melds: p.melds.map((m) => ({ ...m, tiles: m.tiles.slice() })),
      flowers: p.flowers.slice(),
      discards: p.discards.slice(),
      ...(p.riichi ? { riichi: { ...p.riichi } } : {}),
    })),
    log: s.log.slice(),
    ...(s.tableBonuses ? { tableBonuses: s.tableBonuses.slice() } : {}),
  };
}

export const liveTilesLeft = (s: GameState) => Math.max(0, s.wall.length - DEAD_WALL_SIZE);

// Draws one tile for `seat` (front of the wall, or the back for a
// replacement), setting aside any bonus tiles and replacing them from the
// back. Returns the ordinary tile that ends up in hand, or null if the live
// wall ran out first. Mutates `s`.
function drawInto(s: GameState, seat: number, fromBack: boolean): { tile: Tile | null; flowered: boolean } {
  let back = fromBack;
  let flowered = false;
  while (s.wall.length > DEAD_WALL_SIZE) {
    const w = back ? s.wall.pop()! : s.wall.shift()!;
    if ("bonus" in w) {
      s.players[seat].flowers.push(w.bonus);
      const earned = flowerBonus(s.players[seat].flowers, (s.tableBonuses ?? []).filter((b) => b.seat === seat).map((b) => b.name));
      for (const name of earned) (s.tableBonuses ??= []).push({ seat, name, deltas: collectFromEach(seat, FLOWER_BONUS[name]), paid: false });
      const rob = flowerRobbery(s.players.map((p) => p.flowers.length), seat);
      if (rob) (s.tableBonuses ??= []).push({ seat: rob.seat, name: rob.name, deltas: collectFromOne(rob.seat, rob.from, FLOWER_ROBBERY), paid: false });
      flowered = true;
      back = true;
      continue;
    }
    s.players[seat].hand.push(w.tile);
    return { tile: w.tile, flowered };
  }
  return { tile: null, flowered };
}

// ---- Dealing --------------------------------------------------------------

// ---- Dice ---------------------------------------------------------------------

export type Dice = [number, number, number];

// The wall: 144 tiles in 72 stacks of two, 18 stacks in front of each seat.
const STACKS_PER_SIDE = 18;

// 圍骰: all three dice the same - the dealer collects this from each player.
export const TRIPLE_DICE_BONUS = 5;
// 蛇骰: a 1-2-3 (in any order) - the dealer, who rolled it, pays this to each.
export const SNAKE_DICE_PENALTY = 5;

// What a roll pays, per seat, before the hand is played (null if nothing).
export function diceBonus(dice: Dice, dealer: number): { name: string; deltas: number[] } | null {
  if (dice[0] === dice[1] && dice[1] === dice[2]) {
    const deltas = Array.from({ length: SEATS }, (_, seat) => (seat === dealer ? TRIPLE_DICE_BONUS * (SEATS - 1) : -TRIPLE_DICE_BONUS));
    return { name: "圍骰", deltas };
  }
  if ([...dice].sort((a, b) => a - b).join("") === "123") {
    const deltas = Array.from({ length: SEATS }, (_, seat) => (seat === dealer ? -SNAKE_DICE_PENALTY * (SEATS - 1) : SNAKE_DICE_PENALTY));
    return { name: "蛇骰", deltas };
  }
  return null;
}

// ---- Flower bonuses -----------------------------------------------------------

// What each other player pays the one who completes:
//   草 - a 1-2-3-4 from both sets mixed (1f 2f 3s 4s)
//   花 - a 1-2-3-4 of one set (梅蘭菊竹 or 春夏秋冬)
//   花草 - one flower completing both at once (5 + 3)
//   八仙過海 - all eight
// At most one 花 and one 草 per player per hand, however many more form.
export const FLOWER_BONUS = { 草: 3, 花: 5, 花草: 8, 八仙過海: 100 } as const;

// 暗槓: a concealed kong collects this from each player when declared.
export const CONCEALED_KONG_BONUS = 5;

// 追: four players in a row discard the same tile, with no call between -
// the fourth pays each of the others this (an honour tile, or m/t/b).
export const CHASE_PENALTY = { honour: 5, suited: 10 };

// 7搶1 / 1搶7: the last of the eight flowers out, split seven and one - paid
// by the other of the two only.
export const FLOWER_ROBBERY = 30;

const collectFromOne = (seat: number, from: number, amount: number) =>
  Array.from({ length: SEATS }, (_, i) => (i === seat ? amount : i === from ? -amount : 0));

// Given each seat's flower count just after `drew` took one: the eighth out,
// with one seat holding seven and another one. Drawing it into the seven is
// 7搶1 (collects off the one); drawing it as the lone one is 1搶7 (collects
// off the seven).
export function flowerRobbery(counts: number[], drew: number): { seat: number; from: number; name: "7搶1" | "1搶7" } | null {
  if (counts.reduce((a, b) => a + b, 0) !== 8) return null;
  const seven = counts.indexOf(7);
  const one = counts.indexOf(1);
  if (seven < 0 || one < 0) return null;
  if (drew === seven) return { seat: seven, from: one, name: "7搶1" };
  if (drew === one) return { seat: one, from: seven, name: "1搶7" };
  return null;
}

const collectFromEach = (seat: number, amount: number) =>
  Array.from({ length: SEATS }, (_, i) => (i === seat ? amount * (SEATS - 1) : -amount));

// What a seat's flowers newly earn, given what it has already collected.
export function flowerBonus(flowers: BonusTile[], had: TableBonus["name"][]): (keyof typeof FLOWER_BONUS)[] {
  const ranks = (kind: BonusTile["kind"]) => new Set(flowers.filter((f) => f.kind === kind).map((f) => f.rank));
  const fl = ranks("flower");
  const se = ranks("season");
  const hua = fl.size === 4 || se.size === 4;
  // Every rank, with both sets among them: a mixed 1-2-3-4 can always be picked.
  const cao = new Set([...fl, ...se]).size === 4 && fl.size > 0 && se.size > 0;
  const hadHua = had.includes("花") || had.includes("花草");
  const hadCao = had.includes("草") || had.includes("花草");
  const out: (keyof typeof FLOWER_BONUS)[] = [];
  const newHua = hua && !hadHua;
  const newCao = cao && !hadCao;
  if (newHua && newCao) out.push("花草");
  else if (newHua) out.push("花");
  else if (newCao) out.push("草");
  if (fl.size === 4 && se.size === 4 && !had.includes("八仙過海")) out.push("八仙過海");
  return out;
}

export const rollDice = (rng: () => number = Math.random): Dice => [1, 2, 3].map(() => 1 + Math.floor(rng() * 6)) as Dice;

// Where the dice break the wall, as at a real table: the total, counted
// round from the dealer (1 = the dealer's own wall, 2 the next seat's, 3
// across, 4 the one before), picks whose wall; that many stacks are counted
// in from its end, and the deal starts from the break. Same rule as the
// Dice tab.
export function wallBreak(dice: Dice, dealer: number): { seat: number; stacks: number } {
  const total = dice[0] + dice[1] + dice[2];
  return { seat: (dealer + total - 1) % SEATS, stacks: total };
}

// The shuffled wall turned so drawing starts at the break (replacements come
// off the other end of the same break). Every arrangement is equally likely
// either way - this makes the deal work like the real thing.
function breakWall(wall: WallTile[], dice: Dice, dealer: number): WallTile[] {
  const { seat, stacks } = wallBreak(dice, dealer);
  const at = (((seat * STACKS_PER_SIDE + stacks) * 2) % wall.length + wall.length) % wall.length;
  return [...wall.slice(at), ...wall.slice(0, at)];
}

export function newGame(): GameState {
  return dealHand({ dealer: 0, roundWind: 1, dealerStreak: 0 });
}

export function dealHand(opts: { dealer: number; roundWind: Wind; dealerStreak: number; lahs?: Lah[] }, wall?: WallTile[]): GameState {
  // A table-made wall: shuffled, the dice rolled, broken where they say. A
  // wall passed in (the arena, tests) is dealt as it is.
  const dice = wall ? undefined : rollDice();
  const s: GameState = {
    wall: wall ?? breakWall(shuffled(fullWall()), dice!, opts.dealer),
    players: Array.from({ length: SEATS }, () => ({ hand: [], melds: [], flowers: [], discards: [] })),
    dealer: opts.dealer,
    roundWind: opts.roundWind,
    dealerStreak: opts.dealerStreak,
    phase: { kind: "turn", seat: opts.dealer, drawn: null, replacement: null },
    firstGoAround: true,
    discardsMade: 0,
    log: [],
    lahs: opts.lahs ?? [],
    ...(dice ? { dice } : {}),
  };
  const bonus = dice ? diceBonus(dice, opts.dealer) : null;
  if (bonus) s.diceBonus = { ...bonus, paid: false };
  // 16 each, in deal order from the dealer; bonus tiles are replaced as they come.
  for (let i = 0; i < SEATS; i++) {
    const seat = (opts.dealer + i) % SEATS;
    for (let n = 0; n < MELDS_REQUIRED * 3 + 1; n++) drawInto(s, seat, false);
  }
  // The dealer's 17th tile: their first draw.
  const { tile, flowered } = drawInto(s, opts.dealer, false);
  s.phase = { kind: "turn", seat: opts.dealer, drawn: tile, replacement: flowered ? "flower" : null };
  return s;
}

// ---- What a seat can do ---------------------------------------------------

export const meldsNeeded = (p: Player) => MELDS_REQUIRED - p.melds.length;

export function isWinningHand(p: Player, extra?: Tile): boolean {
  const hand = extra ? [...p.hand, extra] : p.hand;
  return isCompleteHand(hand, meldsNeeded(p));
}

export type TurnMove =
  // `riichi`: declare 叮 with this discard (see riichiDiscards).
  | { kind: "discard"; tile: Tile; riichi?: boolean }
  | { kind: "selfDraw" }
  | { kind: "concealedKong"; tile: Tile }
  | { kind: "addedKong"; tile: Tile };

export type KongMove = Extract<TurnMove, { kind: "concealedKong" | "addedKong" }>;

export function kongOptions(p: Player): KongMove[] {
  const moves: KongMove[] = [];
  // A locked 叮 hand can't kong.
  if (p.riichi) return moves;
  const seen = new Set<string>();
  for (const t of p.hand) {
    const key = tileKey(t);
    if (seen.has(key)) continue;
    seen.add(key);
    if (tileCount(p.hand, t) === 4) moves.push({ kind: "concealedKong", tile: t });
    if (p.melds.some((m) => m.kind === "triplet" && sameTile(m.tiles[0], t))) moves.push({ kind: "addedKong", tile: t });
  }
  return moves;
}

export type Claim =
  | { kind: "win" }
  | { kind: "kong" }
  | { kind: "pung" }
  // `tiles` are the two from hand that go with the discard.
  | { kind: "chow"; tiles: [Tile, Tile] };

export function claimOptions(s: GameState, seat: number): Claim[] {
  if (s.phase.kind !== "claims" || seat === s.phase.from) return [];
  const { from, tile } = s.phase;
  const p = s.players[seat];
  const opts: Claim[] = [];
  if (isWinningHand(p, tile)) opts.push({ kind: "win" });
  // Claims other than a win need a tile left to draw afterwards, and a
  // locked 叮 hand can only win.
  if (liveTilesLeft(s) === 0 || p.riichi) return opts;
  const held = tileCount(p.hand, tile);
  if (held >= 3) opts.push({ kind: "kong" });
  if (held >= 2) opts.push({ kind: "pung" });
  if (seat === (from + 1) % SEATS && tile.suit !== "z") {
    const has = (r: number) => r >= 1 && r <= 9 && p.hand.some((h) => h.suit === tile.suit && h.rank === r);
    const t = (r: number): Tile => ({ suit: tile.suit, rank: r });
    for (const [a, b] of [
      [tile.rank - 2, tile.rank - 1],
      [tile.rank - 1, tile.rank + 1],
      [tile.rank + 1, tile.rank + 2],
    ]) {
      if (has(a) && has(b)) opts.push({ kind: "chow", tiles: [t(a), t(b)] });
    }
  }
  return opts;
}

// ---- 叮 ----------------------------------------------------------------------

// The discards that would leave `seat` ready, i.e. the tiles it may declare
// 叮 with - empty if it isn't its turn, it has already declared, or no tile
// is left to draw after it.
export function riichiDiscards(s: GameState, seat: number): Tile[] {
  if (s.phase.kind !== "turn" || s.phase.seat !== seat || liveTilesLeft(s) === 0) return [];
  const p = s.players[seat];
  if (p.riichi) return [];
  const forbidden = forbiddenDiscards(s);
  const out: Tile[] = [];
  for (const t of p.hand) {
    if (out.some((o) => sameTile(o, t)) || forbidden.some((f) => sameTile(f, t))) continue;
    if (shanten(removeTiles(p.hand, [t]), meldsNeeded(p)) === 0) out.push(t);
  }
  return out;
}

// The tile a locked 叮 hand must throw: the one just drawn.
export function riichiForcedDiscard(s: GameState): Tile | null {
  if (s.phase.kind !== "turn") return null;
  const p = s.players[s.phase.seat];
  if (!p.riichi) return null;
  return s.phase.drawn ?? p.hand[p.hand.length - 1];
}

// ---- Transitions ----------------------------------------------------------

function nextTurn(s: GameState, seat: number): GameState {
  const { tile, flowered } = drawInto(s, seat, false);
  if (!tile) return endInDraw(s);
  s.phase = { kind: "turn", seat, drawn: tile, replacement: flowered ? "flower" : null };
  return s;
}

function endInDraw(s: GameState): GameState {
  s.log.push("Wall exhausted - draw (流局)");
  s.phase = {
    kind: "over",
    result: { winner: null, from: null, tile: null, score: null, scoreError: null, deltas: [0, 0, 0, 0] },
  };
  return s;
}

export function applyTurnMove(state: GameState, move: TurnMove): GameState {
  if (state.phase.kind !== "turn") throw new Error("Not a turn");
  const s = cloneState(state);
  const phase = state.phase;
  const seat = phase.seat;
  const p = s.players[seat];

  switch (move.kind) {
    case "discard": {
      if (forbiddenDiscards(state).some((t) => sameTile(t, move.tile))) throw new Error("食替: can't discard that now");
      if (p.riichi) {
        const forced = riichiForcedDiscard(state);
        if (!forced || !sameTile(forced, move.tile)) throw new Error("叮: a locked hand throws what it draws");
        // The first discard after declaring ends 一發.
        p.riichi.ippatsu = false;
      }
      if (move.riichi && !riichiDiscards(state, seat).some((t) => sameTile(t, move.tile))) throw new Error("叮: that discard doesn't leave the hand ready");
      if (move.riichi) {
        const first = p.discards.length === 0 && p.melds.length === 0 && s.firstGoAround;
        p.riichi = { state: first ? (seat === s.dealer ? "heavenly-riichi" : "earthly-riichi") : "riichi", discard: p.discards.length, ippatsu: true };
      }
      p.hand = removeTiles(p.hand, [move.tile]);
      p.discards.push(move.tile);
      // 追: the fourth player in a row to throw the same tile pays the rest.
      const run = s.chase && sameTile(s.chase.tile, move.tile) && (s.chase.seat + 1) % SEATS === seat ? s.chase.run + 1 : 1;
      if (run === SEATS) {
        const penalty = move.tile.suit === "z" ? CHASE_PENALTY.honour : CHASE_PENALTY.suited;
        (s.tableBonuses ??= []).push({ seat, name: "追", deltas: collectFromEach(seat, -penalty), paid: false });
        s.chase = undefined;
      } else s.chase = { seat, tile: move.tile, run };
      s.discardsMade++;
      if (s.discardsMade >= SEATS) s.firstGoAround = false;
      s.phase = { kind: "claims", from: seat, tile: move.tile };
      return s;
    }
    case "selfDraw": {
      if (!isWinningHand(p)) throw new Error("Not a winning hand");
      return finishWin(s, seat, null, phase.drawn ?? p.hand[p.hand.length - 1], phase.replacement);
    }
    case "concealedKong":
    case "addedKong": {
      if (p.riichi) throw new Error("叮: a locked hand can't kong");
      // Any kong ends everyone's 一發.
      for (const pl of s.players) if (pl.riichi) pl.riichi.ippatsu = false;
      if (move.kind === "concealedKong") {
        p.hand = removeTiles(p.hand, [move.tile, move.tile, move.tile, move.tile]);
        p.melds.push({ kind: "kong", tiles: [move.tile, move.tile, move.tile, move.tile], concealed: true, from: null });
        (s.tableBonuses ??= []).push({ seat, name: "暗槓", deltas: collectFromEach(seat, CONCEALED_KONG_BONUS), paid: false });
      } else {
        p.hand = removeTiles(p.hand, [move.tile]);
        const m = p.melds.find((m) => m.kind === "triplet" && sameTile(m.tiles[0], move.tile))!;
        m.kind = "kong";
        m.tiles.push(move.tile);
      }
      s.firstGoAround = false;
      const { tile, flowered } = drawInto(s, seat, true);
      if (!tile) return endInDraw(s);
      s.phase = { kind: "turn", seat, drawn: tile, replacement: flowered ? "flower" : "kong" };
      return s;
    }
  }
}

// Resolves a discard: `decisions[seat]` is that seat's claim, or null to pass
// (the discarder's own entry is ignored). Picks by priority, then turn order.
export function winningClaimSeat(state: GameState, decisions: (Claim | null)[]): number | null {
  if (state.phase.kind !== "claims") return null;
  const order = [1, 2, 3].map((i) => (state.phase.kind === "claims" ? state.phase.from + i : i) % SEATS);
  const rank = (c: Claim | null) => (!c ? 0 : c.kind === "win" ? 3 : c.kind === "chow" ? 1 : 2);
  let best: number | null = null;
  for (const seat of order) {
    if (rank(decisions[seat]) > (best === null ? 0 : rank(decisions[best]))) best = seat;
  }
  return best;
}

// 食替: straight after a call you can't throw the tile you just claimed - nor,
// after a chow taken at one end of the run, the tile at the run's far side
// that the same two tiles also wait on (claim 7 with 89: 6 is barred too;
// claim 7 with 68: only 7). Pass `with` only for a chow.
export function swapDiscardBan(claimed: Tile, withTiles?: Tile[]): Tile[] {
  const ban = [claimed];
  if (withTiles) {
    const ranks = withTiles.map((t) => t.rank).sort((a, b) => a - b);
    const far = claimed.rank < ranks[0] ? claimed.rank + 3 : claimed.rank > ranks[1] ? claimed.rank - 3 : null;
    if (far !== null && far >= 1 && far <= 9) ban.push({ suit: claimed.suit, rank: far });
  }
  return ban;
}

// The discards barred right now - empty unless the seat to act just called.
// Waived when it would leave nothing legal to throw.
export function forbiddenDiscards(s: GameState): Tile[] {
  if (s.phase.kind !== "turn" || !s.phase.forbidden?.length) return [];
  const ban = s.phase.forbidden;
  const hand = s.players[s.phase.seat].hand;
  return hand.every((t) => ban.some((b) => sameTile(b, t))) ? [] : ban;
}

const WIND_CHARS = ["", "東", "南", "西", "北"];

// "東圈南局": the round wind, then which of the four deals in it this is -
// counted from seat 0, who deals first in every round.
export function roundLabel(s: GameState): string {
  return `${WIND_CHARS[s.roundWind]}圈${WIND_CHARS[s.dealer + 1]}局`;
}

export function resolveClaims(state: GameState, decisions: (Claim | null)[]): GameState {
  if (state.phase.kind !== "claims") throw new Error("No discard to claim");
  const { from, tile } = state.phase;
  const best = winningClaimSeat(state, decisions);

  const s = cloneState(state);
  if (best === null) {
    if (liveTilesLeft(s) === 0) return endInDraw(s);
    return nextTurn(s, (from + 1) % SEATS);
  }

  const claim = decisions[best]!;
  const p = s.players[best];
  // The claimed tile leaves the discarder's pond.
  s.players[from].discards.pop();
  s.firstGoAround = false;
  s.chase = undefined;
  // A call ends everyone's 一發 (a win ends the hand anyway).
  if (claim.kind !== "win") for (const pl of s.players) if (pl.riichi) pl.riichi.ippatsu = false;
  if (claim.kind === "win") {
    p.hand.push(tile);
    return finishWin(s, best, from, tile, null);
  }
  if (claim.kind === "chow") {
    p.hand = removeTiles(p.hand, claim.tiles);
    p.melds.push({ kind: "run", tiles: sortTiles([...claim.tiles, tile]), concealed: false, from });
    s.phase = { kind: "turn", seat: best, drawn: null, replacement: null, forbidden: swapDiscardBan(tile, claim.tiles) };
    return s;
  }
  if (claim.kind === "pung") {
    p.hand = removeTiles(p.hand, [tile, tile]);
    p.melds.push({ kind: "triplet", tiles: [tile, tile, tile], concealed: false, from });
    s.phase = { kind: "turn", seat: best, drawn: null, replacement: null, forbidden: [tile] };
    return s;
  }
  // Exposed kong: replacement draw.
  p.hand = removeTiles(p.hand, [tile, tile, tile]);
  p.melds.push({ kind: "kong", tiles: [tile, tile, tile, tile], concealed: false, from });
  const { tile: drawn, flowered } = drawInto(s, best, true);
  if (!drawn) return endInDraw(s);
  s.phase = { kind: "turn", seat: best, drawn, replacement: flowered ? "flower" : "kong" };
  return s;
}

export function scoreWin(
  s: GameState,
  winner: number,
  from: number | null,
  tile: Tile,
  replacement: "flower" | "kong" | null
): ScoreResult {
  const p = s.players[winner];
  const declaredMelds: MeldDeclaration[] = p.melds.map((m) => ({ tiles: m.tiles, kind: m.kind, concealed: m.concealed }));
  const selfDraw = from === null;
  const isDealer = winner === s.dealer;
  const lastTile = liveTilesLeft(s) === 0;
  const ctx: GameContext = {
    seatWind: seatWind(winner, s.dealer),
    roundWind: s.roundWind,
    selfDraw,
    winningTile: tile,
    riichi: p.riichi?.state ?? "none",
    instantWin: p.riichi?.ippatsu ?? false,
    // 食叮: winning off a discard from a player who has declared 叮.
    eatRiichi: from !== null && !!s.players[from].riichi,
    earlyWin: "none",
    multiWin: "none",
    heavenlyWin:
      s.firstGoAround && selfDraw && s.discardsMade === 0 && isDealer
        ? "heaven"
        : s.firstGoAround && selfDraw && !isDealer
          ? "earth"
          : s.firstGoAround && !selfDraw && !isDealer
            ? "man"
            : "none",
    lastTileWin: lastTile ? (selfDraw ? "sea-bottom" : "river-bottom") : "none",
    flowerDraw: selfDraw && replacement === "flower" ? 1 : 0,
    kongDraw: selfDraw && replacement === "kong" ? 1 : 0,
    robKong: 0,
    // 莊 counts when the dealer wins or pays; 連莊 adds the streak.
    dealerStreak: isDealer || from === s.dealer ? s.dealerStreak + 1 : 0,
    manualVisibleTripleWin: false,
    manualVisibleExhaustedMultiWait: false,
  };
  return scoreParsedHand({ declaredMelds, freeTiles: p.hand, bonusTiles: p.flowers }, ctx);
}

function finishWin(
  s: GameState,
  winner: number,
  from: number | null,
  tile: Tile,
  replacement: "flower" | "kong" | null
): GameState {
  let score: ScoreResult | null = null;
  let scoreError: string | null = null;
  try {
    score = scoreWin(s, winner, from, tile, replacement);
  } catch (e) {
    scoreError = e instanceof Error ? e.message : String(e);
  }
  const tai = score?.total ?? 0;
  // Each payer pays the tai plus any 拉/踢 add-on between the two of them.
  const pairs = settleWin(s.lahs ?? [], s.dealer, winner, from, tai);
  const deltas = [0, 0, 0, 0];
  for (const p of pairs) {
    deltas[Number(p.winner)] += p.worth;
    deltas[Number(p.payer)] -= p.worth;
  }
  s.lahs = nextLahs(s.lahs ?? [], pairs, new Set([SEAT_IDS[winner]]));
  s.phase = { kind: "over", result: { winner, from, tile, score, scoreError, deltas, pairs } };
  return s;
}

// The next hand: the dealer stays on a dealer win or a draw (連莊), otherwise
// the deal passes on; a full lap of dealers moves the round wind.
// 拉 carries over. `wall` is for the arena, which deals set walls.
export function nextHand(s: GameState, wall?: WallTile[]): GameState {
  if (s.phase.kind !== "over") throw new Error("Hand not over");
  const { winner } = s.phase.result;
  const lahs = s.lahs ?? [];
  if (winner === null || winner === s.dealer) {
    return dealHand({ dealer: s.dealer, roundWind: s.roundWind, dealerStreak: s.dealerStreak + 1, lahs }, wall);
  }
  const dealer = (s.dealer + 1) % SEATS;
  const roundWind = (dealer === 0 ? (s.roundWind % 4) + 1 : s.roundWind) as Wind;
  return dealHand({ dealer, roundWind, dealerStreak: 0, lahs }, wall);
}

// ---- Bots -------------------------------------------------------------------

// Copies of each tile kind a seat can't see anywhere: 4 minus its own hand,
// every pond and every exposed meld.
export function unseenCounts(s: GameState, seat: number): Map<string, number> {
  const counts = new Map<string, number>();
  for (const k of allTileKinds()) counts.set(tileKey(k), 4);
  const see = (t: Tile) => counts.set(tileKey(t), (counts.get(tileKey(t)) ?? 0) - 1);
  s.players[seat].hand.forEach(see);
  for (let i = 0; i < SEATS; i++) {
    const p = s.players[i];
    p.discards.forEach(see);
    for (const m of p.melds) if (!m.concealed || i === seat) m.tiles.forEach(see);
  }
  return counts;
}

export interface DiscardRating {
  tile: Tile;
  shanten: number;
  // Unseen copies of the tiles that would bring the hand one step closer.
  acceptance: number;
}

// Rates every distinct discard from a full hand: shanten after it, then how
// many unseen tiles would improve on that. Best first.
export function rateDiscards(s: GameState, seat: number): DiscardRating[] {
  const p = s.players[seat];
  const melds = meldsNeeded(p);
  const unseen = unseenCounts(s, seat);
  const out: DiscardRating[] = [];
  const seen = new Set<string>();
  const forbidden = s.phase.kind === "turn" && s.phase.seat === seat ? forbiddenDiscards(s) : [];
  for (const t of p.hand) {
    if (seen.has(tileKey(t)) || forbidden.some((f) => sameTile(f, t))) continue;
    seen.add(tileKey(t));
    const rest = removeTiles(p.hand, [t]);
    const sh = shanten(rest, melds);
    let acceptance = 0;
    for (const k of allTileKinds()) {
      const left = unseen.get(tileKey(k)) ?? 0;
      if (left <= 0) continue;
      if (shanten([...rest, k], melds) < sh) acceptance += left;
    }
    out.push({ tile: t, shanten: sh, acceptance });
  }
  // Ties: throw what's already safe-looking (seen in a pond), then isolated honors.
  const pondCount = (t: Tile) => s.players.reduce((n, pl) => n + tileCount(pl.discards, t), 0);
  return out.sort(
    (a, b) =>
      a.shanten - b.shanten ||
      b.acceptance - a.acceptance ||
      pondCount(b.tile) - pondCount(a.tile) ||
      Number(b.tile.suit === "z") - Number(a.tile.suit === "z")
  );
}

export function botTurnMove(s: GameState): TurnMove {
  if (s.phase.kind !== "turn") throw new Error("Not a turn");
  const p = s.players[s.phase.seat];
  if (isWinningHand(p)) return { kind: "selfDraw" };
  const forced = riichiForcedDiscard(s);
  if (forced) return { kind: "discard", tile: forced };
  const best = rateDiscards(s, s.phase.seat);
  if (liveTilesLeft(s) > 0) {
    // Kong when it doesn't set the hand back.
    for (const k of kongOptions(p)) {
      if (k.kind === "addedKong") return k;
      const rest = removeTiles(p.hand, [k.tile, k.tile, k.tile, k.tile]);
      // After a kong the replacement draw arrives, so compare at the same size as now-minus-a-discard.
      if (shanten(rest, meldsNeeded(p) - 1) <= best[0].shanten) return k;
    }
  }
  return { kind: "discard", tile: best[0].tile };
}

const isValueHonor = (t: Tile, s: GameState, seat: number) =>
  t.suit === "z" && (t.rank >= 5 || t.rank === s.roundWind || t.rank === seatWind(seat, s.dealer));

export function botClaim(s: GameState, seat: number): Claim | null {
  const options = claimOptions(s, seat);
  if (options.length === 0 || s.phase.kind !== "claims") return null;
  if (options.some((o) => o.kind === "win")) return { kind: "win" };
  const tile = s.phase.tile;
  const p = s.players[seat];
  const now = shanten(p.hand, meldsNeeded(p));
  // Shanten after taking the claim and making the best discard.
  const after = (used: Tile[]): number => {
    const rest = removeTiles(p.hand, used);
    const melds = meldsNeeded(p) - 1;
    let best = Infinity;
    for (const t of rest) best = Math.min(best, shanten(removeTiles(rest, [t]), melds));
    return best;
  };
  for (const o of options) {
    if (o.kind === "kong" && shanten(removeTiles(p.hand, [tile, tile, tile]), meldsNeeded(p) - 1) <= now) return o;
  }
  for (const o of options) {
    if (o.kind === "pung" && (after([tile, tile]) < now || (isValueHonor(tile, s, seat) && after([tile, tile]) <= now)))
      return o;
  }
  for (const o of options) {
    if (o.kind === "chow" && after(o.tiles) < now) return o;
  }
  return null;
}
