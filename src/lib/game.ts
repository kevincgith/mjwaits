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
// in turn order (截胡). Not modelled: robbing a kong, 叮 (riichi), and other
// purely declared house calls.
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
import {
  scoreParsedHand,
  type BonusTile,
  type GameContext,
  type MeldDeclaration,
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

export interface Player {
  hand: Tile[];
  melds: GameMeld[];
  flowers: BonusTile[];
  discards: Tile[];
}

export type Phase =
  // `seat` holds a full hand (3k+2 tiles) and must discard, kong or win.
  | { kind: "turn"; seat: number; drawn: Tile | null; replacement: "flower" | "kong" | null }
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
    })),
    log: s.log.slice(),
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

export function newGame(): GameState {
  return dealHand({ dealer: 0, roundWind: 1, dealerStreak: 0 });
}

export function dealHand(opts: { dealer: number; roundWind: Wind; dealerStreak: number }, wall?: WallTile[]): GameState {
  const s: GameState = {
    wall: wall ?? shuffled(fullWall()),
    players: Array.from({ length: SEATS }, () => ({ hand: [], melds: [], flowers: [], discards: [] })),
    dealer: opts.dealer,
    roundWind: opts.roundWind,
    dealerStreak: opts.dealerStreak,
    phase: { kind: "turn", seat: opts.dealer, drawn: null, replacement: null },
    firstGoAround: true,
    discardsMade: 0,
    log: [],
  };
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
  | { kind: "discard"; tile: Tile }
  | { kind: "selfDraw" }
  | { kind: "concealedKong"; tile: Tile }
  | { kind: "addedKong"; tile: Tile };

export type KongMove = Extract<TurnMove, { kind: "concealedKong" | "addedKong" }>;

export function kongOptions(p: Player): KongMove[] {
  const moves: KongMove[] = [];
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
  // Claims other than a win need a tile left to draw afterwards.
  if (liveTilesLeft(s) === 0) return opts;
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
      p.hand = removeTiles(p.hand, [move.tile]);
      p.discards.push(move.tile);
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
      if (move.kind === "concealedKong") {
        p.hand = removeTiles(p.hand, [move.tile, move.tile, move.tile, move.tile]);
        p.melds.push({ kind: "kong", tiles: [move.tile, move.tile, move.tile, move.tile], concealed: true, from: null });
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
  if (claim.kind === "win") {
    p.hand.push(tile);
    return finishWin(s, best, from, tile, null);
  }
  if (claim.kind === "chow") {
    p.hand = removeTiles(p.hand, claim.tiles);
    p.melds.push({ kind: "run", tiles: sortTiles([...claim.tiles, tile]), concealed: false, from });
    s.phase = { kind: "turn", seat: best, drawn: null, replacement: null };
    return s;
  }
  if (claim.kind === "pung") {
    p.hand = removeTiles(p.hand, [tile, tile]);
    p.melds.push({ kind: "triplet", tiles: [tile, tile, tile], concealed: false, from });
    s.phase = { kind: "turn", seat: best, drawn: null, replacement: null };
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
    riichi: "none",
    instantWin: false,
    eatRiichi: false,
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
  const deltas = [0, 0, 0, 0];
  if (from === null) {
    for (let i = 0; i < SEATS; i++) if (i !== winner) deltas[i] = -tai;
    deltas[winner] = tai * (SEATS - 1);
  } else {
    deltas[from] = -tai;
    deltas[winner] = tai;
  }
  s.phase = { kind: "over", result: { winner, from, tile, score, scoreError, deltas } };
  return s;
}

// The next hand: the dealer stays on a dealer win or a draw (連莊), otherwise
// the deal passes on; a full lap of dealers moves the round wind.
export function nextHand(s: GameState): GameState {
  if (s.phase.kind !== "over") throw new Error("Hand not over");
  const { winner } = s.phase.result;
  if (winner === null || winner === s.dealer) {
    return dealHand({ dealer: s.dealer, roundWind: s.roundWind, dealerStreak: s.dealerStreak + 1 });
  }
  const dealer = (s.dealer + 1) % SEATS;
  const roundWind = (dealer === 0 ? (s.roundWind % 4) + 1 : s.roundWind) as Wind;
  return dealHand({ dealer, roundWind, dealerStreak: 0 });
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
  for (const t of p.hand) {
    if (seen.has(tileKey(t))) continue;
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
