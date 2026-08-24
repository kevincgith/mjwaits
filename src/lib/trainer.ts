// Waits trainer: generates random practice hands at a checkpoint size
// (3*level + 1 tiles) with guaranteed non-zero waits, for a quiz where the
// user tries to identify every tile kind that completes the hand.

import { type Suit, type Tile, getWaits, tileKey } from "./mahjong";

export const MIN_TRAINER_LEVEL = 1;
export const MAX_TRAINER_LEVEL = 5;

export function trainerHandSize(level: number): number {
  return level * 3 + 1;
}

export interface TrainerQuestion {
  level: number;
  flush: boolean;
  tiles: Tile[];
  waits: Tile[];
}

function randomInt(n: number): number {
  return Math.floor(Math.random() * n);
}

function randomSuit(flushSuit: Suit | null): Suit {
  if (flushSuit) return flushSuit;
  const suits: Suit[] = ["m", "t", "b", "z"];
  return suits[randomInt(suits.length)];
}

// One random meld (3 tiles: triplet or run) or the pair (2 tiles),
// respecting `counts` (copies of each kind already used elsewhere in the
// hand under construction) so the whole hand never exceeds the physical
// 4-copies-per-kind limit. Retries with a fresh random suit/rank on
// collision - with at most 16 tiles spread across 34 kinds (or 9 in flush
// mode), a handful of attempts is always enough in practice.
function randomGroup(size: 2 | 3, flushSuit: Suit | null, counts: Map<string, number>): Tile[] | null {
  for (let attempt = 0; attempt < 50; attempt++) {
    const suit = randomSuit(flushSuit);
    const maxRank = suit === "z" ? 7 : 9;
    const asRun = size === 3 && suit !== "z" && Math.random() < 0.5;

    if (asRun) {
      const startRank = 1 + randomInt(maxRank - 2);
      const tiles: Tile[] = [0, 1, 2].map((i) => ({ suit, rank: startRank + i }));
      if (tiles.every((t) => (counts.get(tileKey(t)) ?? 0) < 4)) return tiles;
    } else {
      const rank = 1 + randomInt(maxRank);
      const used = counts.get(tileKey({ suit, rank })) ?? 0;
      if (used + size <= 4) return Array.from({ length: size }, () => ({ suit, rank }));
    }
  }
  return null;
}

// Builds a complete (level melds + pair) hand, then removes one random tile
// so the remainder is a `level`-checkpoint training question. The removed
// tile is trivially always one valid wait (adding it back reconstructs the
// complete hand), so the result is guaranteed to have at least one wait
// without any accept/reject search over random hands.
function buildCompleteHand(level: number, flushSuit: Suit | null): Tile[] | null {
  const counts = new Map<string, number>();
  const groups: Tile[] = [];
  const addGroup = (group: Tile[]) => {
    for (const t of group) counts.set(tileKey(t), (counts.get(tileKey(t)) ?? 0) + 1);
    groups.push(...group);
  };

  for (let i = 0; i < level; i++) {
    const meld = randomGroup(3, flushSuit, counts);
    if (!meld) return null;
    addGroup(meld);
  }
  const pair = randomGroup(2, flushSuit, counts);
  if (!pair) return null;
  addGroup(pair);

  return groups;
}

// Generates a training question at `level` (hand size = level*3+1). In
// flush mode every tile comes from one randomly-chosen numbered suit (no
// honors); otherwise tiles are drawn from the full 34-kind pool.
export function generateTrainerQuestion(level: number, flush: boolean): TrainerQuestion {
  const flushSuits: Suit[] = ["m", "t", "b"];

  for (let attempt = 0; attempt < 200; attempt++) {
    const flushSuit = flush ? flushSuits[randomInt(flushSuits.length)] : null;
    const complete = buildCompleteHand(level, flushSuit);
    if (!complete) continue;

    const removeIndex = randomInt(complete.length);
    const tiles = [...complete.slice(0, removeIndex), ...complete.slice(removeIndex + 1)];
    const waits = getWaits(tiles, level);
    if (waits.length > 0) return { level, flush, tiles, waits };
  }

  throw new Error(`Failed to generate a trainer question for level ${level} (flush=${flush})`);
}
