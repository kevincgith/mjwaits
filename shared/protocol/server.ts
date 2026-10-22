// What the room sends its clients. The server builds these itself, so they
// are types only - nothing here is validated on the way out.
//
// Phase 1 sends the whole public room on every change (`room`): it is small
// (a scoreboard's event list), so there is no diffing to get wrong, and a
// reconnecting client needs nothing else. `version` goes up by one each time,
// so a client can drop anything older than what it has.

import type { Lah, ScoreGame } from "../engine/ledger";
import type { RoomSettings } from "./client";

export type ErrorCode =
  | "badMessage" // failed parseClientMessage
  | "tooLarge"
  | "rateLimited"
  | "version" // the page is out of date: reload
  | "notJoined" // anything before `hello`
  | "badToken" // a reconnect token this room doesn't know
  | "nameTaken" // another player here already uses that nickname
  | "seatTaken"
  | "notSeated"
  | "notHost"
  | "started" // only before the game starts
  | "notStarted"
  | "ended"
  | "seatsNotFull"
  | "multiWinOff" // two or three winners in a 截胡 room
  | "undoPending"
  | "nothingToUndo"
  | "noUndoPending"
  | "ownUndo"; // voting on your own request

export interface SeatView {
  name: string;
  connected: boolean;
  host: boolean;
}

// What the server worked out from the event list with the shared ledger:
// the numbers the board shows, per seat.
export interface BoardView {
  chips: number[]; // startChips + net, per seat
  net: number[];
  dealer: number;
  streak: number; // 連莊
  roundWind: number; // 0-3, 東南西北
  label: string; // e.g. 東風南局
  hands: number; // 局 played
  lahs: Lah[]; // holder / pulled are nicknames, as in the ledger
  pot: number; // Jackpot
}

export interface PendingUndo {
  by: number; // the seat that asked
  entry: number; // index of the event it would take back
}

// The end-of-session result, per seat, and the fewest payments that settle
// it (the Scores tab's 結帳), in tai. Anything still in the Jackpot was paid
// in by the players and isn't in `settle` - `pot` says how much is left.
export interface SessionSummary {
  hands: number;
  net: number[];
  chips: number[];
  settle: { from: number; to: number; amount: number }[];
  pot: number;
  endedAt: number;
}

export interface RoomView {
  code: string;
  version: number;
  phase: "lobby" | "playing" | "ended";
  seats: (SeatView | null)[];
  watching: number; // connected but not seated
  settings: RoomSettings;
  // The ledger's own game record - seats are nicknames, as in the Scores
  // tab - so a client can replay it with the shared ledger for the history
  // list and per-hand breakdowns.
  game: ScoreGame | null;
  board: BoardView | null;
  pendingUndo: PendingUndo | null;
  summary: SessionSummary | null; // once ended
}

export type ServerMessage =
  // The answer to `hello`. Keep `token` (in localStorage) to come back to
  // the same seat after a drop or a reload.
  | { t: "welcome"; v: number; token: string; seat: number | null; rid?: string }
  | { t: "room"; room: RoomView }
  | { t: "error"; code: ErrorCode; message: string; rid?: string }
  | { t: "pong"; rid?: string };

export type ServerMessageType = ServerMessage["t"];
