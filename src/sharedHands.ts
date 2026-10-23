// A Scoring hand in a form that can travel: as a share link's query
// (?h=notation&b=bonus&c=situation) and as an entry in the Recent list
// (localStorage). The situation is stored as just what differs from the
// defaults, so a plain hand's link stays short.

import { parseHand, type Tile } from "@mjwaits/shared/engine/mahjong";
import { parseScoringHand, type BonusTile, type GameContext } from "@mjwaits/shared/engine/scoring";
import { TEST_HAND_BASE_CONTEXT } from "@mjwaits/shared/engine/testHands";

export interface SharedHand {
  /** Scoring notation - "(123m)" declared, "[1111z]" 暗槓, the rest concealed. */
  hand: string;
  bonus: BonusTile[];
  /** The situation, as overrides on TEST_HAND_BASE_CONTEXT. */
  ctx: Partial<GameContext>;
}

export interface RecentHand extends SharedHand {
  total: number;
  /** Scored under custom tai rules: their fingerprint (rulesFingerprint). */
  rules?: string;
  /** When it was last scored (ms since epoch). */
  at: number;
}

type CtxKey = keyof GameContext;

/** The fields of `ctx` that differ from the defaults. */
export function situationDiff(ctx: GameContext): Partial<GameContext> {
  const diff: Partial<GameContext> = {};
  for (const key of Object.keys(TEST_HAND_BASE_CONTEXT) as CtxKey[]) {
    const value = ctx[key];
    const base = TEST_HAND_BASE_CONTEXT[key];
    const same =
      key === "winningTile"
        ? (value as Tile | null)?.suit === (base as Tile | null)?.suit && (value as Tile | null)?.rank === (base as Tile | null)?.rank
        : value === base;
    if (!same) (diff as Record<CtxKey, unknown>)[key] = value;
  }
  return diff;
}

export function formatBonus(bonus: BonusTile[]): string {
  return bonus.map((b) => `${b.kind === "flower" ? "f" : "s"}${b.rank}`).join("");
}

function parseBonus(text: string): BonusTile[] | null {
  const out: BonusTile[] = [];
  for (const m of text.matchAll(/([fs])([1-4])/g)) {
    const tile: BonusTile = { kind: m[1] === "f" ? "flower" : "season", rank: Number(m[2]) as 1 | 2 | 3 | 4 };
    if (!out.some((b) => b.kind === tile.kind && b.rank === tile.rank)) out.push(tile);
  }
  return text.replace(/[fs][1-4]/g, "") === "" ? out : null;
}

// The situation travels as base64url JSON, with the 食胡 tile as "5m".
function encodeSituation(ctx: Partial<GameContext>): string {
  const { winningTile, ...rest } = ctx;
  const plain: Record<string, unknown> = { ...rest };
  if (winningTile) plain.winningTile = `${winningTile.rank}${winningTile.suit}`;
  return btoa(JSON.stringify(plain)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeSituation(text: string): Partial<GameContext> | null {
  try {
    const plain = JSON.parse(atob(text.replace(/-/g, "+").replace(/_/g, "/"))) as Record<string, unknown>;
    const ctx: Partial<GameContext> = {};
    for (const key of Object.keys(TEST_HAND_BASE_CONTEXT) as CtxKey[]) {
      if (!(key in plain)) continue;
      if (key === "winningTile") {
        const [tile] = parseHand(String(plain.winningTile));
        ctx.winningTile = tile ?? null;
      } else if (typeof plain[key] === typeof TEST_HAND_BASE_CONTEXT[key]) {
        (ctx as Record<CtxKey, unknown>)[key] = plain[key];
      }
    }
    return ctx;
  } catch {
    return null;
  }
}

/** The page's own address with `hand` in its query. */
export function shareUrl(hand: SharedHand): string {
  const params = new URLSearchParams({ h: hand.hand });
  if (hand.bonus.length) params.set("b", formatBonus(hand.bonus));
  if (Object.keys(hand.ctx).length) params.set("c", encodeSituation(hand.ctx));
  return `${window.location.origin}${import.meta.env.BASE_URL}?${params}`;
}

/** The hand in a share link's query, or null if it has none (or a broken one). */
export function readSharedHand(search: string): SharedHand | null {
  const params = new URLSearchParams(search);
  const hand = params.get("h");
  if (!hand) return null;
  try {
    parseScoringHand(hand);
  } catch {
    return null;
  }
  const bonus = parseBonus(params.get("b") ?? "") ?? [];
  const ctx = params.get("c") ? (decodeSituation(params.get("c")!) ?? {}) : {};
  return { hand, bonus, ctx };
}

const RECENT_KEY = "mjwaits.recentHands";
export const RECENT_MAX = 10;

export function loadRecentHands(): RecentHand[] {
  try {
    const raw = window.localStorage.getItem(RECENT_KEY);
    const list = raw ? (JSON.parse(raw) as RecentHand[]) : [];
    return Array.isArray(list) ? list.filter((r) => typeof r?.hand === "string" && typeof r.total === "number") : [];
  } catch {
    return [];
  }
}

export function saveRecentHands(list: RecentHand[]): void {
  try {
    if (list.length) window.localStorage.setItem(RECENT_KEY, JSON.stringify(list));
    else window.localStorage.removeItem(RECENT_KEY);
  } catch {
    // Storage unavailable - the list just won't survive a reload.
  }
}

/** Adds `entry` to the front of `list` - replacing the front entry instead
 *  when it's the same tiles (only the situation changed), so adjusting a
 *  hand's toggles doesn't flood the list. */
export function withRecent(list: RecentHand[], entry: RecentHand): RecentHand[] {
  const sameTiles = (r: RecentHand) => r.hand === entry.hand && formatBonus(r.bonus) === formatBonus(entry.bonus);
  const front = list[0];
  if (front && sameTiles(front)) {
    if (front.total === entry.total && JSON.stringify(front.ctx) === JSON.stringify(entry.ctx)) return list;
    return [entry, ...list.slice(1)];
  }
  return [entry, ...list.filter((r) => !sameTiles(r))].slice(0, RECENT_MAX);
}

// ---- Calculator hands ------------------------------------------------------
// A Calculator hand is just tiles (jokers as "j"), so its link is ?calc=…
// and its Recent entry carries a one-line summary of what the Calculator
// found (waits, shanten, or a winning hand).

export interface RecentCalcHand {
  /** Plain notation, e.g. "123456789m111z11tj". */
  hand: string;
  summary: string;
  at: number;
}

export function calcShareUrl(hand: string): string {
  return `${window.location.origin}${import.meta.env.BASE_URL}?${new URLSearchParams({ calc: hand })}`;
}

/** The Calculator hand in a share link's query, or null. */
export function readCalcHand(search: string): string | null {
  const hand = new URLSearchParams(search).get("calc");
  if (!hand) return null;
  try {
    return parseHand(hand).length > 0 ? hand : null;
  } catch {
    return null;
  }
}

const RECENT_CALC_KEY = "mjwaits.recentCalc";

export function loadRecentCalc(): RecentCalcHand[] {
  try {
    const raw = window.localStorage.getItem(RECENT_CALC_KEY);
    const list = raw ? (JSON.parse(raw) as RecentCalcHand[]) : [];
    return Array.isArray(list) ? list.filter((r) => typeof r?.hand === "string" && typeof r.summary === "string") : [];
  } catch {
    return [];
  }
}

export function saveRecentCalc(list: RecentCalcHand[]): void {
  try {
    if (list.length) window.localStorage.setItem(RECENT_CALC_KEY, JSON.stringify(list));
    else window.localStorage.removeItem(RECENT_CALC_KEY);
  } catch {
    // Storage unavailable - the list just won't survive a reload.
  }
}

// Whether every tile of `a` is also in `b` (as a multiset).
function isSubHand(a: Tile[], b: Tile[]): boolean {
  const left = new Map<string, number>();
  for (const t of b) left.set(`${t.rank}${t.suit}`, (left.get(`${t.rank}${t.suit}`) ?? 0) + 1);
  for (const t of a) {
    const k = `${t.rank}${t.suit}`;
    const n = left.get(k) ?? 0;
    if (n === 0) return false;
    left.set(k, n - 1);
  }
  return true;
}

/** Adds `entry` to the front - replacing the front entry when one hand
 *  holds the other (the same hand being built up or trimmed down), so a
 *  hand entered tile by tile leaves one entry, not one per checkpoint. */
export function withRecentCalc(list: RecentCalcHand[], entry: RecentCalcHand): RecentCalcHand[] {
  const front = list[0];
  if (front) {
    if (front.hand === entry.hand && front.summary === entry.summary) return list;
    const a = parseHand(front.hand);
    const b = parseHand(entry.hand);
    if (isSubHand(a, b) || isSubHand(b, a)) return [entry, ...list.slice(1)];
  }
  return [entry, ...list.filter((r) => r.hand !== entry.hand)].slice(0, RECENT_MAX);
}
