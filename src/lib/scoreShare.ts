// A read-only snapshot of a Scores game, small enough to put in a link (and
// so a QR code): who's playing and where they stand, the round, the 局 count
// and the settle-up. There's no server - it's the scores as they were when
// shared, and a newer link replaces it.

import { replay, settle, type ScoreGame, type ScoreStore } from "./ledger";

export interface SnapshotPlayer {
  n: string; // name
  t: number; // total
  c: number; // colour index (the Scores palette), -1 for none
  w: number; // 胡
  s: number; // 摸
  d: number; // 銃
}

export interface ScoreSnapshot {
  v: 1;
  name?: string;
  at: number; // when it was shared
  started: number;
  label: string; // 東風南局
  hands: number;
  east: number;
  circle: number;
  dealer: string;
  players: SnapshotPlayer[]; // the table, in seat order
  pays: [string, string, number][]; // [from, to, amount], fewest transfers
  ended: boolean;
}

export function snapshotOf(store: ScoreStore, game: ScoreGame, now = Date.now()): ScoreSnapshot {
  const state = replay(game);
  const tally = (player: string) => {
    const won = state.hands.filter((h) => h.winners.some((w) => w.player === player));
    return {
      w: won.length,
      s: won.filter((h) => h.selfDraw).length,
      d: state.hands.filter((h) => h.kind === "win" && !h.selfDraw && h.from === player).length,
    };
  };
  const colour = (n: string) => store.roster.find((p) => p.name === n)?.color ?? -1;
  // Everyone who has played, seated first, so a substitute still shows.
  const names = [...state.seats, ...state.players.filter((p) => !state.seats.includes(p) && state.hands.some((h) => h.seatsAfter.includes(p)))];
  return {
    v: 1,
    ...(game.name ? { name: game.name } : {}),
    at: now,
    started: game.startedAt,
    label: state.label,
    hands: state.hands.length,
    east: state.east,
    circle: state.circle,
    dealer: state.seats[state.dealer],
    players: names.map((n) => ({ n, t: state.totals[n] ?? 0, c: colour(n), ...tally(n) })),
    pays: settle(state.totals, 1).map((p) => [p.from, p.to, p.amount]),
    ended: game.endedAt !== undefined,
  };
}

// base64url of the UTF-8 JSON - names can be Chinese.
export function encodeSnapshot(snap: ScoreSnapshot): string {
  const bytes = new TextEncoder().encode(JSON.stringify(snap));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeSnapshot(code: string): ScoreSnapshot | null {
  try {
    const bin = atob(code.replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
    const snap = JSON.parse(new TextDecoder().decode(bytes)) as ScoreSnapshot;
    if (snap?.v !== 1 || !Array.isArray(snap.players) || !Array.isArray(snap.pays)) return null;
    return snap;
  } catch {
    return null;
  }
}

// The link that opens it: this page, with the snapshot in the hash (never
// sent to a server, so it doesn't land in any log).
export const SHARE_HASH = "#s=";

export function snapshotUrl(snap: ScoreSnapshot, base = `${window.location.origin}${window.location.pathname}`): string {
  return `${base}${SHARE_HASH}${encodeSnapshot(snap)}`;
}

export function snapshotFromHash(hash: string): ScoreSnapshot | null {
  return hash.startsWith(SHARE_HASH) ? decodeSnapshot(hash.slice(SHARE_HASH.length)) : null;
}
