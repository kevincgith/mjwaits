// The Trainer's running stats: their shapes, reading them back from storage,
// and the Endless mode's add/undo arithmetic.

// Accumulated results for one (level, flush) combination - stats are kept
// separate per combination since difficulty varies a lot between them, and
// lumping e.g. Level 1 and Level 5 together would wash out both.
export interface TrainerStatsEntry {
  level: number;
  flush: boolean;
  total: number;
  correct: number;
  timeTotalMs: number;
}

// Same shape as TrainerStatsEntry plus regretTotal: the discard trainer grades
// on how much win probability an answer gave up versus the best discard, not
// just right/wrong, so it also tracks the running sum of that regret.
export interface DiscardTrainerStatsEntry {
  level: number;
  flush: boolean;
  total: number;
  correct: number;
  timeTotalMs: number;
  regretTotal: number;
}

// Endless mode is one running session, not per-level buckets: cumulative counts
// across every hand played this session.
export interface EndlessStats {
  hands: number;
  handsWon: number;
  turns: number; // discards made
  optimalCount: number; // discards that were a best pick
  looseCount: number; // discards that needlessly raised shanten
  regretTotal: number; // summed win-probability given up
  turnsToTenpaiTotal: number; // summed over hands that reached tenpai
  tenpaiReachedCount: number;
  turnsToWinTotal: number; // summed over won hands
}

export const EMPTY_ENDLESS_STATS: EndlessStats = {
  hands: 0,
  handsWon: 0,
  turns: 0,
  optimalCount: 0,
  looseCount: 0,
  regretTotal: 0,
  turnsToTenpaiTotal: 0,
  tenpaiReachedCount: 0,
  turnsToWinTotal: 0,
};

export interface SavedTrainerStats {
  waits: TrainerStatsEntry[];
  discards: DiscardTrainerStatsEntry[];
  endless: EndlessStats;
}

const isCount = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

function isWaitsEntry(e: unknown): e is TrainerStatsEntry {
  if (typeof e !== "object" || e === null) return false;
  const r = e as Record<string, unknown>;
  return isCount(r.level) && typeof r.flush === "boolean" && isCount(r.total) && isCount(r.correct) && isCount(r.timeTotalMs);
}

function isDiscardsEntry(e: unknown): e is DiscardTrainerStatsEntry {
  return isWaitsEntry(e) && isCount((e as unknown as Record<string, unknown>).regretTotal);
}

// The saved stats as stored (a JSON string, or null when nothing is saved).
// Anything that isn't a well-formed entry is dropped rather than trusted - a
// stray null would otherwise crash the app on load - and each Endless count
// must be a real number, so a saved "5" can't turn the next +1 into "51".
export function parseTrainerStats(raw: string | null): SavedTrainerStats {
  const empty: SavedTrainerStats = { waits: [], discards: [], endless: EMPTY_ENDLESS_STATS };
  if (!raw) return empty;
  let saved: unknown;
  try {
    saved = JSON.parse(raw);
  } catch {
    return empty;
  }
  if (typeof saved !== "object" || saved === null) return empty;
  const s = saved as Record<string, unknown>;
  const endlessIn = (typeof s.endless === "object" && s.endless !== null ? s.endless : {}) as Record<string, unknown>;
  const endless = { ...EMPTY_ENDLESS_STATS };
  for (const k of Object.keys(endless) as (keyof EndlessStats)[]) {
    const v = endlessIn[k];
    if (isCount(v)) endless[k] = v;
  }
  return {
    waits: Array.isArray(s.waits) ? s.waits.filter(isWaitsEntry) : [],
    discards: Array.isArray(s.discards) ? s.discards.filter(isDiscardsEntry) : [],
    endless,
  };
}

// Adds (sign +1) or subtracts (sign -1) one EndlessStats from another - used to
// apply a turn's deltas and to roll them back on undo/redo. Every count is
// clamped at 0, so an undo can never drive one negative (and float residue
// can't push regretTotal below 0).
export function addEndlessStats(a: EndlessStats, b: EndlessStats, sign: 1 | -1 = 1): EndlessStats {
  const out = { ...a };
  for (const k of Object.keys(out) as (keyof EndlessStats)[]) out[k] = Math.max(0, a[k] + sign * b[k]);
  return out;
}
