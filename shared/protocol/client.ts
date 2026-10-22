// What a client may send the room, and the one function the server runs on
// every incoming frame (parseClientMessage). Phase 1: the shared scoreboard.
//
// Every message may carry `rid`, a client-chosen id echoed back on the
// `error` it causes, so the page knows which action failed.

import { MAX_MESSAGE_BYTES, NICKNAME_RAW_MAX, SEATS, TOKEN_PATTERN } from "./limits";
import { array, bool, int, literal, nullable, object, oneOf, optional, str, tagged, type Infer, type Result } from "./schema";

const seat = int(0, SEATS - 1);
// 封頂 is 999 in the Scores tab; nothing at a real table goes past it.
const tai = int(0, 999);
const rid = optional(str(16));

// What the host sets for the table. The rest of the ledger's settings stay
// at the Scores tab's defaults (see DEFAULT_SETTINGS in ledger.ts).
export const RoomSettingsSchema = object({
  startChips: int(0, 1_000_000), // what each player starts with; the board shows this + net
  base: int(0, 100), // 底
  dealerTai: int(0, 100), // 莊
  streakTai: int(0, 100), // per 連莊
  // Several winners on one discard: "first" = 截胡 (the first in turn order
  // from the discarder takes it), "all" = 一炮多響 (雙響 / 三響 all paid).
  multiWin: oneOf("first", "all"),
  // Undo: the host may take back the last entry alone; otherwise another
  // seated player has to agree.
  hostCanUndo: bool,
  firstDealer: seat,
});
export type RoomSettings = Infer<typeof RoomSettingsSchema>;

export const DEFAULT_ROOM_SETTINGS: RoomSettings = {
  startChips: 0,
  base: 0,
  dealerTai: 1,
  streakTai: 2,
  multiWin: "first",
  hostCanUndo: false,
  firstDealer: 0,
};

const ClientSchema = tagged({
  // First message on every connection. `token` (from an earlier `welcome`)
  // takes back the seat it held; without one the player joins unseated.
  hello: object({ t: literal("hello"), v: int(0, 1_000_000), name: str(NICKNAME_RAW_MAX), token: optional(str(32, TOKEN_PATTERN)), rid }),
  sit: object({ t: literal("sit"), seat, rid }),
  stand: object({ t: literal("stand"), rid }),
  // Host only, before the game starts.
  setup: object({ t: literal("setup"), settings: RoomSettingsSchema, rid }),
  // Host only, with all four seats taken.
  start: object({ t: literal("start"), rid }),
  // A hand won. `from` null = 自摸 (exactly one winner); otherwise the
  // discarder, who pays each winner - two or three winners only when the
  // room plays 一炮多響.
  win: object({ t: literal("win"), winners: array(object({ seat, tai }), 1, 3), from: nullable(seat), rid }),
  draw: object({ t: literal("draw"), rid }), // 流局
  // 特別獎罰, as on the Scores tab: 獎 - `seat` is paid `amount`; 罰 - they
  // pay it. With `other`, only that player; without, each of the other three.
  bonus: object({ t: literal("bonus"), seat, kind: oneOf("獎", "罰"), amount: int(1, 9999), other: optional(seat), rid }),
  undo: object({ t: literal("undo"), rid }), // ask to take back the last entry
  undoVote: object({ t: literal("undoVote"), approve: bool, rid }),
  end: object({ t: literal("end"), rid }), // end the session (host)
  ping: object({ t: literal("ping"), rid }),
});

export type ClientMessage = Infer<typeof ClientSchema>;
export type ClientMessageType = ClientMessage["t"];

const encoder = new TextEncoder();

// Checks one incoming WebSocket frame: text, within the size limit, JSON, a
// known message of the right shape, and the cross-field rules a shape can't
// say. Whether it's allowed right now (seated, host, game started) is the
// room's call.
export function parseClientMessage(frame: string | ArrayBuffer): Result<ClientMessage> {
  if (typeof frame !== "string") return { ok: false, error: "message: expected text" };
  // A UTF-16 unit is at most 3 UTF-8 bytes - skip encoding when it can't be over.
  if (frame.length * 3 > MAX_MESSAGE_BYTES && encoder.encode(frame).length > MAX_MESSAGE_BYTES) return { ok: false, error: "message: too large" };
  let data: unknown;
  try {
    data = JSON.parse(frame);
  } catch {
    return { ok: false, error: "message: not JSON" };
  }
  const r = ClientSchema.check(data, "");
  if (!r.ok) return r;
  const m = r.value;
  if (m.t === "win") {
    const seats = m.winners.map((w) => w.seat);
    if (new Set(seats).size !== seats.length) return { ok: false, error: "winners: a seat is listed twice" };
    if (m.from === null && seats.length !== 1) return { ok: false, error: "winners: a self-draw has one winner" };
    if (m.from !== null && seats.includes(m.from)) return { ok: false, error: "from: the discarder can't be a winner" };
  }
  if (m.t === "bonus" && m.other === m.seat) return { ok: false, error: "other: must be another player" };
  return r;
}
