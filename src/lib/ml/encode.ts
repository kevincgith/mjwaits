// The machine-learning view of a decision: what one seat can see, as a
// fixed-length array of small integers, and every move it could make as one
// index in a fixed action space. The same encoder writes the training data
// (scripts/ml-data.ts) and feeds a trained network (policy.ts), in the arena
// and in the browser, so the two can never drift apart.
//
// Everything here is what a player at the table could know - no peeking at
// other hands or the wall. Values are small non-negative integers so a
// sample packs into a Uint8Array; the network scales them on the way in.

import {
  claimOptions,
  forbiddenDiscards,
  isWinningHand,
  kongOptions,
  lahAddOn,
  liveTilesLeft,
  meldsNeeded,
  riichiDiscards,
  riichiForcedDiscard,
  SEATS,
  seatWind,
  unseenCounts,
  type Claim,
  type GameState,
  type TurnMove,
} from "@mjwaits/shared/engine/game";
import { profileById, rateDiscardsFor } from "@mjwaits/shared/engine/bots";
import { allTileKinds, shanten, tileKey, type Tile } from "@mjwaits/shared/engine/mahjong";
import { matchScalars, NUM_MATCH_SCALARS, type MatchContext } from "./match";

export const KINDS = allTileKinds();
export const NUM_KINDS = KINDS.length; // 34
const KIND_INDEX = new Map(KINDS.map((t, i) => [tileKey(t), i]));
export const kindIndex = (t: Tile) => KIND_INDEX.get(tileKey(t)) ?? -1;

// ---- Action space ----------------------------------------------------------
//   0..33   discard tile k
//  34..67   discard tile k and declare 叮
//  68       self-draw win (自摸)
//  69       kong (the first kong the rules allow - concealed or added)
//  70       pass on a discard
//  71       win off the discard
//  72       pung
//  73       kong off the discard
//  74..76   chow with the claimed tile lowest / middle / highest in the run
export const A_DISCARD = 0;
export const A_RIICHI = 34;
export const A_SELF_DRAW = 68;
export const A_KONG = 69;
export const A_PASS = 70;
export const A_WIN = 71;
export const A_PUNG = 72;
export const A_CLAIM_KONG = 73;
export const A_CHOW = 74;
export const NUM_ACTIONS = 77;

// ---- Observation layout ----------------------------------------------------
// Per tile kind (34 each), in this order:
const PLANES = [
  "hand", // copies in our concealed hand (0-4)
  "drawn", // the tile we just drew (0/1)
  "myMelds", // copies in our melds (0-4)
  "myPond", // copies in our pond
  "unseen", // copies we can't see anywhere (0-4)
  "forbidden", // 食替: can't throw it now (0/1)
  "claimTile", // the discard up for a claim (0/1)
  // for each opponent, in turn order after us (right, across, left):
  "opp1Pond",
  "opp1Melds",
  "opp1Recent", // among their last 3 discards (0/1)
  "opp2Pond",
  "opp2Melds",
  "opp2Recent",
  "opp3Pond",
  "opp3Melds",
  "opp3Recent",
  // Computed facts about each possible discard (our turn only) - the search
  // a network finds hardest to learn from raw counts, handed to it the way
  // early Go networks were given liberties:
  "discardShanten", // shanten after throwing it, + 1 (0 = not ours to throw)
  "discardAccept", // unseen tiles that would then improve the hand, / 2
  "discardDanger", // the table read's deal-in danger of throwing it, x 40
  "discardValue", // where the hand's tai are heading after throwing it (flushes, all-pungs, honours, 門清), x 4
] as const;
export const NUM_PLANES = PLANES.length;
const PLANE = Object.fromEntries(PLANES.map((p, i) => [p, i])) as Record<(typeof PLANES)[number], number>;

// Then scalars:
const SCALARS = [
  "seatWind1", "seatWind2", "seatWind3", "seatWind4", // our seat wind, one-hot
  "roundWind1", "roundWind2", "roundWind3", "roundWind4",
  "dealerRel0", "dealerRel1", "dealerRel2", "dealerRel3", // dealer relative to us
  "streak", // 連莊, capped 10
  "liveTiles", // live wall left / 2
  "shanten", // our hand's shanten + 1, capped 9 (0 = complete)
  "myMeldCount",
  "myFlowers",
  "myRiichi",
  "phaseTurn", // 1 when it's our turn, 0 on a claim
  "claimFromRel", // who threw the claimable tile: 1 right .. 3 left
  // On a claim: our shanten now, and after the best pung / chow / kong of it
  // and the best discard after (each + 1; 0 = that claim isn't possible).
  "claimShantenNow",
  "claimShantenPung",
  "claimShantenChow",
  "claimShantenKong",
  "opp1Melds", "opp1Discards", "opp1Riichi", "opp1Flowers",
  "opp2Melds", "opp2Discards", "opp2Riichi", "opp2Flowers",
  "opp3Melds", "opp3Discards", "opp3Riichi", "opp3Flowers",
  // 拉 between us and each opponent: what a win of ours off them would add,
  // what a win of theirs off us would add (half the 拉, /2, capped 255),
  // and the chain length of a 拉 on us.
  "opp1LahIn", "opp1LahOut", "opp1LahCount",
  "opp2LahIn", "opp2LahOut", "opp2LahCount",
  "opp3LahIn", "opp3LahOut", "opp3LahCount",
] as const;
export const NUM_SCALARS = SCALARS.length;
export const OBS_SIZE = NUM_PLANES * NUM_KINDS + NUM_SCALARS;
// Encoding v2: the same, with the match-day inputs (match.ts) after it.
export const OBS_SIZE_MATCH = OBS_SIZE + NUM_MATCH_SCALARS;

const cap = (x: number, hi = 255) => Math.max(0, Math.min(hi, Math.round(x)));

// What `seat` sees at a decision point (its turn, or a discard it may claim)
// - and, given the match it's part of, the match-day inputs too (v2).
export function encodeObservation(s: GameState, seat: number, match?: MatchContext): Uint8Array {
  const out = new Uint8Array(match ? OBS_SIZE_MATCH : OBS_SIZE);
  const put = (plane: number, k: number, v: number) => {
    if (k >= 0) out[plane * NUM_KINDS + k] = cap(out[plane * NUM_KINDS + k] + v);
  };
  const me = s.players[seat];
  for (const t of me.hand) put(PLANE.hand, kindIndex(t), 1);
  if (s.phase.kind === "turn" && s.phase.seat === seat && s.phase.drawn) put(PLANE.drawn, kindIndex(s.phase.drawn), 1);
  for (const m of me.melds) for (const t of m.tiles) put(PLANE.myMelds, kindIndex(t), 1);
  for (const t of me.discards) put(PLANE.myPond, kindIndex(t), 1);
  const unseen = unseenCounts(s, seat);
  KINDS.forEach((k, i) => put(PLANE.unseen, i, Math.max(0, unseen.get(tileKey(k)) ?? 0)));
  if (s.phase.kind === "turn" && s.phase.seat === seat) for (const t of forbiddenDiscards(s)) out[PLANE.forbidden * NUM_KINDS + kindIndex(t)] = 1;
  if (s.phase.kind === "claims") out[PLANE.claimTile * NUM_KINDS + kindIndex(s.phase.tile)] = 1;
  if (s.phase.kind === "turn" && s.phase.seat === seat) {
    for (const c of rateDiscardsFor(s, seat, ANALYST)) {
      const k = kindIndex(c.tile);
      out[PLANE.discardShanten * NUM_KINDS + k] = cap(c.shanten + 1, 9);
      out[PLANE.discardAccept * NUM_KINDS + k] = cap(c.acceptance / 2);
      out[PLANE.discardDanger * NUM_KINDS + k] = cap(c.danger * 40);
      out[PLANE.discardValue * NUM_KINDS + k] = cap(c.value * 4);
    }
  }
  for (let r = 1; r < SEATS; r++) {
    const o = s.players[(seat + r) % SEATS];
    const [pond, melds, recent] = [PLANE.opp1Pond, PLANE.opp1Melds, PLANE.opp1Recent].map((p) => p + (r - 1) * 3);
    for (const t of o.discards) put(pond, kindIndex(t), 1);
    // A concealed kong is face down: only its count shows (as a scalar).
    for (const m of o.melds) if (!m.concealed) for (const t of m.tiles) put(melds, kindIndex(t), 1);
    for (const t of o.discards.slice(-3)) out[recent * NUM_KINDS + kindIndex(t)] = 1;
  }

  let i = NUM_PLANES * NUM_KINDS;
  const scalar = (v: number) => (out[i++] = cap(v));
  const wind = seatWind(seat, s.dealer);
  for (let w = 1; w <= 4; w++) scalar(wind === w ? 1 : 0);
  for (let w = 1; w <= 4; w++) scalar(s.roundWind === w ? 1 : 0);
  for (let r = 0; r < 4; r++) scalar((s.dealer - seat + SEATS) % SEATS === r ? 1 : 0);
  scalar(Math.min(10, s.dealerStreak));
  scalar(liveTilesLeft(s) / 2);
  scalar(Math.min(9, shanten(me.hand, meldsNeeded(me)) + 1));
  scalar(me.melds.length);
  scalar(me.flowers.length);
  scalar(me.riichi ? 1 : 0);
  scalar(s.phase.kind === "turn" ? 1 : 0);
  scalar(s.phase.kind === "claims" ? (s.phase.from - seat + SEATS) % SEATS : 0);
  const claim = claimShanten(s, seat);
  scalar(claim.now);
  scalar(claim.pung);
  scalar(claim.chow);
  scalar(claim.kong);
  for (let r = 1; r < SEATS; r++) {
    const o = s.players[(seat + r) % SEATS];
    scalar(o.melds.length);
    scalar(o.discards.length);
    scalar(o.riichi ? 1 : 0);
    scalar(o.flowers.length);
  }
  for (let r = 1; r < SEATS; r++) {
    const o = (seat + r) % SEATS;
    scalar(lahAddOn(s.lahs, seat, o).amount / 2);
    scalar(lahAddOn(s.lahs, o, seat).amount / 2);
    scalar(s.lahs?.find((l) => l.holder === String(o) && l.pulled === String(seat))?.count ?? 0);
  }
  if (match) for (const v of matchScalars(match, seat)) scalar(v);
  return out;
}

// The facts are computed by a neutral reader: the Veteran's table reading
// with a full memory - only shanten, acceptance and danger are used, never
// a personality's weights, so every style sees the same facts.
const ANALYST = { ...profileById("veteran"), memory: 1 };

// On a claim: shanten now and after the best version of each claim (each +1,
// 0 when that claim isn't offered).
function claimShanten(s: GameState, seat: number): { now: number; pung: number; chow: number; kong: number } {
  const none = { now: 0, pung: 0, chow: 0, kong: 0 };
  if (s.phase.kind !== "claims" || seat === s.phase.from) return none;
  const opts = claimOptions(s, seat);
  if (opts.length === 0) return none;
  const p = s.players[seat];
  const melds = meldsNeeded(p);
  const tile = s.phase.tile;
  const remove = (hand: Tile[], used: Tile[]) => {
    const rest = hand.slice();
    for (const u of used) {
      const i = rest.findIndex((h) => h.suit === u.suit && h.rank === u.rank);
      if (i >= 0) rest.splice(i, 1);
    }
    return rest;
  };
  const bestAfter = (used: Tile[]) => {
    const rest = remove(p.hand, used);
    let best = 99;
    for (const t of rest) best = Math.min(best, shanten(remove(rest, [t]), melds - 1));
    return Math.min(9, best + 1);
  };
  const out = { ...none, now: Math.min(9, shanten(p.hand, melds) + 1) };
  for (const o of opts) {
    if (o.kind === "pung") out.pung = bestAfter([tile, tile]);
    if (o.kind === "kong") out.kong = Math.min(9, shanten(remove(p.hand, [tile, tile, tile]), melds - 1) + 1);
    if (o.kind === "chow") out.chow = out.chow ? Math.min(out.chow, bestAfter(o.tiles)) : bestAfter(o.tiles);
  }
  return out;
}

// ---- Actions <-> moves -------------------------------------------------------

// Which actions are legal for `seat` right now (1 = legal). An all-zero mask
// means the seat has no decision to make.
export function legalActions(s: GameState, seat: number): Uint8Array {
  const mask = new Uint8Array(NUM_ACTIONS);
  if (s.phase.kind === "turn" && s.phase.seat === seat) {
    const p = s.players[seat];
    if (isWinningHand(p)) mask[A_SELF_DRAW] = 1;
    const forced = riichiForcedDiscard(s);
    if (forced) {
      mask[A_DISCARD + kindIndex(forced)] = 1;
      return mask;
    }
    const banned = new Set(forbiddenDiscards(s).map(kindIndex));
    for (const t of p.hand) if (!banned.has(kindIndex(t))) mask[A_DISCARD + kindIndex(t)] = 1;
    for (const t of riichiDiscards(s, seat)) mask[A_RIICHI + kindIndex(t)] = 1;
    if (liveTilesLeft(s) > 0 && kongOptions(p).length) mask[A_KONG] = 1;
  } else if (s.phase.kind === "claims" && seat !== s.phase.from) {
    const opts = claimOptions(s, seat);
    if (opts.length === 0) return mask;
    mask[A_PASS] = 1;
    for (const o of opts) mask[claimAction(s, o)] = 1;
  }
  return mask;
}

function claimAction(s: GameState, c: Claim): number {
  if (c.kind === "win") return A_WIN;
  if (c.kind === "pung") return A_PUNG;
  if (c.kind === "kong") return A_CLAIM_KONG;
  // Chow: where the claimed tile sits in the run.
  const tile = s.phase.kind === "claims" ? s.phase.tile : c.tiles[0];
  const lower = c.tiles.filter((t) => t.rank < tile.rank).length;
  return A_CHOW + lower;
}

// The action index a move or claim corresponds to (for recording what a bot
// or a person did).
export function turnMoveAction(move: TurnMove): number {
  if (move.kind === "selfDraw") return A_SELF_DRAW;
  if (move.kind === "discard") return (move.riichi ? A_RIICHI : A_DISCARD) + kindIndex(move.tile);
  return A_KONG;
}

export function claimDecisionAction(s: GameState, c: Claim | null): number {
  return c ? claimAction(s, c) : A_PASS;
}

// Back from an action index to a move the engine accepts.
export function actionToTurnMove(s: GameState, a: number): TurnMove {
  if (a === A_SELF_DRAW) return { kind: "selfDraw" };
  if (a === A_KONG) return kongOptions(s.players[(s.phase as { seat: number }).seat])[0];
  const riichi = a >= A_RIICHI && a < A_RIICHI + NUM_KINDS;
  return { kind: "discard", tile: { ...KINDS[a - (riichi ? A_RIICHI : A_DISCARD)] }, ...(riichi ? { riichi: true } : {}) };
}

export function actionToClaim(s: GameState, seat: number, a: number): Claim | null {
  if (a === A_PASS) return null;
  return claimOptions(s, seat).find((c) => claimAction(s, c) === a) ?? null;
}
