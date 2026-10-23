// The online table: four seats - people or bots - playing real hands, the
// server holding the wall and every hand (see engine/view.ts: each phone is
// sent only what its seat may see).
//
// What a phone may send a table, checked by parseTableMessage on every
// incoming frame, and what the table sends back. Separate from the live
// scores rooms (client.ts / server.ts): a table is its own kind of room.
//
// Every move and claim names the decision `step` it answers - the table's
// counter, one higher at each new decision - so a late tap, or a second one
// after the timer has already moved for you, is refused as stale instead of
// landing on the next turn.

import type { Claim, KongMove, TurnMove } from "../engine/game";
import type { Tile } from "../engine/mahjong";
import type { TableView } from "../engine/view";
import { MAX_MESSAGE_BYTES, NICKNAME_RAW_MAX, SEATS, TOKEN_PATTERN } from "./limits";
import { array, bool, int, literal, nullable, object, oneOf, optional, str, tagged, type Infer, type Result } from "./schema";

// The personalities a host can seat (the Play tab's roster, bots.ts).
export const TABLE_BOTS = ["grandmaster", "veteran", "speedster", "hunter", "wall", "gambler", "casual"] as const;
export type TableBot = (typeof TABLE_BOTS)[number];

// Seconds a player gets for each decision; 0 = no timer.
export const TURN_TIMERS = [0, 10, 20, 30] as const;

const rid = optional(str(16));
const seat = int(0, SEATS - 1);
const step = int(0, 1_000_000_000);
const TileSchema = object({ suit: oneOf("m", "t", "b", "z"), rank: int(1, 9) });

export const MoveSchema = tagged({
  discard: object({ kind: literal("discard"), tile: TileSchema, riichi: optional(bool) }),
  selfDraw: object({ kind: literal("selfDraw") }),
  concealedKong: object({ kind: literal("concealedKong"), tile: TileSchema }),
  addedKong: object({ kind: literal("addedKong"), tile: TileSchema }),
}, "kind");

export const ClaimSchema = tagged({
  win: object({ kind: literal("win") }),
  kong: object({ kind: literal("kong") }),
  pung: object({ kind: literal("pung") }),
  chow: object({ kind: literal("chow"), tiles: array(TileSchema, 2, 2) }),
}, "kind");

export const TableSettingsSchema = object({
  multiWin: bool, // 一炮多響; off = 截胡
  timer: int(0, 30), // seconds per decision, one of TURN_TIMERS
  hold: int(10, 300), // seconds a dropped player's seat waits before it's played for them
  firstDealer: seat,
});
export type TableSettings = Infer<typeof TableSettingsSchema>;

export const DEFAULT_TABLE_SETTINGS: TableSettings = { multiWin: false, timer: 20, hold: 30, firstDealer: 0 };

const TableClientSchema = tagged({
  // First on every connection; `token` comes back as the same person (and seat).
  hello: object({ t: literal("hello"), v: int(0, 1_000_000), name: str(NICKNAME_RAW_MAX), token: optional(str(32, TOKEN_PATTERN)), rid }),
  // In the lobby.
  sit: object({ t: literal("sit"), seat, rid }),
  stand: object({ t: literal("stand"), rid }),
  setBot: object({ t: literal("setBot"), seat, bot: nullable(oneOf(...TABLE_BOTS)), rid }), // host: a bot in a seat, or out of it
  setup: object({ t: literal("setup"), settings: TableSettingsSchema, rid }), // host
  start: object({ t: literal("start"), rid }), // host, with four seats filled
  // Playing: your turn's move, or your answer to a discard (null = pass).
  move: object({ t: literal("move"), step, move: MoveSchema, rid }),
  claim: object({ t: literal("claim"), step, claim: nullable(ClaimSchema), rid }),
  // Between hands: ready for the next deal; 投降 a 拉 that holder has on you.
  ready: object({ t: literal("ready"), rid }),
  surrender: object({ t: literal("surrender"), holder: seat, rid }),
  end: object({ t: literal("end"), rid }), // host: the table's done
  ping: object({ t: literal("ping"), rid }),
});

export type TableClientMessage = Infer<typeof TableClientSchema>;

const encoder = new TextEncoder();

// Checks one incoming frame: text, within the size limit, JSON, a known
// message of the right shape, and what a shape can't say (honours go to 7, a
// timer is one of TURN_TIMERS). Whether it's allowed now - your turn, legal
// in this hand - is the table's call, against the engine.
export function parseTableMessage(frame: string | ArrayBuffer): Result<TableClientMessage> {
  if (typeof frame !== "string") return { ok: false, error: "message: expected text" };
  if (frame.length * 3 > MAX_MESSAGE_BYTES && encoder.encode(frame).length > MAX_MESSAGE_BYTES) return { ok: false, error: "message: too large" };
  let data: unknown;
  try {
    data = JSON.parse(frame);
  } catch {
    return { ok: false, error: "message: not JSON" };
  }
  const r = TableClientSchema.check(data, "");
  if (!r.ok) return r;
  const m = r.value;
  const tiles: Tile[] =
    m.t === "move" && "tile" in m.move ? [m.move.tile as Tile] : m.t === "claim" && m.claim?.kind === "chow" ? (m.claim.tiles as Tile[]) : [];
  if (tiles.some((t) => t.suit === "z" && t.rank > 7)) return { ok: false, error: "tile: honours are 1-7" };
  if (m.t === "claim" && m.claim?.kind === "chow" && m.claim.tiles.some((t) => t.suit === "z")) return { ok: false, error: "claim: no chow of honours" };
  if (m.t === "setup" && !(TURN_TIMERS as readonly number[]).includes(m.settings.timer))
    return { ok: false, error: `settings.timer: one of ${TURN_TIMERS.join(", ")}` };
  return r;
}

// ---- What the table sends ----------------------------------------------------

export type TableErrorCode =
  | "badMessage"
  | "tooLarge"
  | "rateLimited"
  | "version"
  | "notJoined"
  | "badToken"
  | "nameTaken"
  | "notHost"
  | "seatTaken"
  | "notSeated"
  | "started" // only in the lobby
  | "notStarted"
  | "seatsNotFull"
  | "notYourTurn"
  | "stale" // a move or claim for a decision that's already gone
  | "illegal" // not a legal move or claim right now
  | "ended";

export type SeatInfo =
  | { kind: "human"; id: string; name: string; connected: boolean; host: boolean }
  | { kind: "bot"; bot: TableBot; name: string };

// What this seat may do right now. The table still checks every move.
export interface YourOptions {
  // Your turn: 自摸, kongs, the discards that would declare 叮, and the
  // tiles 食替 bars you from throwing. (Any other tile in hand may go.)
  turn: { selfDraw: boolean; kongs: KongMove[]; riichi: Tile[]; forbidden: Tile[] } | null;
  // A discard (or a kong being added) you may claim; empty if you can't.
  claims: Claim[];
}

// What just happened, for the table to show it (a burst, a sound). `auto`:
// the table made that move for the seat - out of time, or away.
export type TableAction =
  | { kind: "discard"; seat: number; tile: Tile; riichi?: boolean; auto?: boolean }
  | { kind: "call"; seat: number; call: "chow" | "pung" | "kong"; from: number }
  | { kind: "kong"; seat: number; concealed: boolean; auto?: boolean }
  | { kind: "win"; seats: number[]; from: number | null; robKong?: boolean }
  | { kind: "draw" }; // 流局

export interface TableState {
  code: string;
  version: number; // one higher each send
  phase: "lobby" | "playing" | "ended";
  seats: (SeatInfo | null)[];
  watching: number;
  settings: TableSettings;
  totals: number[]; // per seat, over the hands played
  hand: number; // hands dealt so far
  // Playing: the decision being waited on, and until when (ms since epoch;
  // null with no timer); `ready` - between hands, who's ready for the next.
  step: number;
  deadline: number | null;
  waitingOn: number[];
  ready: number[];
  auto: number[]; // seats being played for, until their player is back
  last: TableAction | null;
  // This phone's seat (null for someone watching) and its view of the hand.
  you: number | null;
  view: TableView | null;
  options: YourOptions | null;
}

export type TableServerMessage =
  | { t: "welcome"; v: number; token: string; id: string; name: string; host: boolean; seat: number | null; rid?: string }
  | { t: "table"; table: TableState }
  | { t: "error"; code: TableErrorCode; message: string; rid?: string }
  | { t: "pong"; rid?: string };

// The engine's types, as the messages carry them (kept in step by the tests).
export type { Claim, TurnMove };
