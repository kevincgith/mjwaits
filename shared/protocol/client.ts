// What a phone may send a live room, and the one function the server runs on
// every incoming frame (parseClientMessage).
//
// A room shares one Scores-tab game. The host - whoever made the room - puts
// their 戰況 game up and keeps it current; anyone else joins to watch; the
// host can let particular people record too. Recording is just sending the
// whole game as it now stands (`update`), the way the Scores tab itself
// saves it - so every 戰況 feature works the same online.
//
// Every message may carry `rid`, a client-chosen id echoed back on the
// `error` it causes, so the page knows which action failed.

import { GameSchema, MAX_NAME } from "./game";
import { MAX_MESSAGE_BYTES, NICKNAME_RAW_MAX, TOKEN_PATTERN } from "./limits";
import { bool, int, literal, object, optional, record, str, tagged, type Infer, type Result } from "./schema";

const rid = optional(str(16));
// Room members are told apart by an id the server gives them (not their token).
export const PERSON_ID_PATTERN = /^[0-9a-f]{16}$/;

const ClientSchema = tagged({
  // First message on every connection. `token` (from an earlier `welcome`)
  // comes back as the same person; without one, a new person joins.
  hello: object({ t: literal("hello"), v: int(0, 1_000_000), name: str(NICKNAME_RAW_MAX), token: optional(str(32, TOKEN_PATTERN)), rid }),
  // The game as it now stands, from the host or someone allowed to record.
  // `base` is the room's gameVersion this change was made on: if someone
  // else's change landed first, it's refused (conflict) rather than lost.
  // `colors`: each player's colour on the host's phone, for everyone else's.
  update: object({ t: literal("update"), base: int(0, 1_000_000_000), game: GameSchema, colors: optional(record(str(MAX_NAME), int(0, 7), 32)), rid }),
  // Host only: let someone record, or stop them.
  setRecorder: object({ t: literal("setRecorder"), person: str(16, PERSON_ID_PATTERN), allow: bool, rid }),
  // Host only: stop sharing. The room keeps the game as it was, read-only.
  stop: object({ t: literal("stop"), rid }),
  // Host only: share a stopped room's game again - same code, same people.
  resume: object({ t: literal("resume"), rid }),
  ping: object({ t: literal("ping"), rid }),
});

export type ClientMessage = Infer<typeof ClientSchema>;
export type ClientMessageType = ClientMessage["t"];

const encoder = new TextEncoder();

// Checks one incoming WebSocket frame: text, within the size limit, JSON, and
// a known message of the right shape (a game in `update` is then checked in
// full by checkGame, by the room). Whether it's allowed - host, recorder - is
// the room's call.
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
  return ClientSchema.check(data, "");
}
