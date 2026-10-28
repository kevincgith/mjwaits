// What a live room sends its phones. The server builds these itself, so they
// are types only - nothing here is validated on the way out.
//
// The whole public room goes to everyone after every change (`room`): the
// shared game, who's here, who may record. `version` goes up by one with each
// send, so a phone can drop anything older than what it has; `gameVersion`
// only when the game itself changes - it's what an `update` names as `base`.

import type { ScoreGame } from "../engine/ledger";
import type { AuditEntry } from "./audit";

export type ErrorCode =
  | "badMessage" // failed parseClientMessage
  | "tooLarge"
  | "rateLimited"
  | "version" // the page is out of date: reload
  | "notJoined" // anything before `hello`
  | "badToken" // a reconnect token this room doesn't know
  | "nameTaken" // someone here already uses that nickname
  | "full" // the room has as many people as it can take
  | "notHost"
  | "notAllowed" // an update from someone the host hasn't let record
  | "conflict" // an update made on an older game: someone else's landed first
  | "badGame" // a game the ledger can't use
  | "ended" // the host stopped sharing
  | "noSuchPerson";

export interface PersonView {
  id: string;
  name: string;
  connected: boolean;
  host: boolean;
  canRecord: boolean; // always true for the host
}

export interface RoomView {
  code: string;
  version: number;
  // waiting: made, game not up yet · live: being shared · ended: the host
  // stopped sharing (the game stays, read-only).
  phase: "waiting" | "live" | "ended";
  people: PersonView[];
  game: ScoreGame | null;
  gameVersion: number;
  colors: Record<string, number>; // player name -> colour, from the host's phone
  // The audit trail: for each entry in `game`, who put it in and who last
  // changed it; and the latest changes, newest last (see audit.ts).
  authors: { by: string; editedBy?: string }[];
  changes: AuditEntry[];
}

export type ServerMessage =
  // The answer to `hello`. Keep `token` (in localStorage) to come back as the
  // same person after a drop or a reload. `id` is how the room names you in
  // `people`.
  | { t: "welcome"; v: number; token: string; id: string; name: string; host: boolean; rid?: string }
  | { t: "room"; room: RoomView }
  | { t: "error"; code: ErrorCode; message: string; rid?: string }
  | { t: "pong"; rid?: string };

export type ServerMessageType = ServerMessage["t"];
