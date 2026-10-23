// One live-scores room: sharing one Scores-tab game between phones. (What
// every kind of room has in common - joining, tokens, rate limits, expiry -
// is in hub.ts.)
//
// The host - whoever joins first, the phone that made the room - puts their
// 戰況 game up and keeps it current; anyone else joins to watch; the host can
// let particular people record. Every change is the whole game as it now
// stands (`update`), checked in full (checkGame: the shape, then a replay by
// the ledger) and accepted only if it was made on the latest game - two
// people recording at once can't overwrite each other; the later one is told
// to try again on the new game. Each accepted change is logged with who made
// it (the audit trail, see shared/protocol/audit.ts).
//
// Every frame goes through parseClientMessage (shared/protocol) before
// anything else looks at it, and every change ends with the whole public
// room going to everyone (see RoomView).

import type { ScoreGame } from "@mjwaits/shared/engine/ledger";
import { diffGames, entryAuthors, type AuditEntry } from "@mjwaits/shared/protocol/audit";
import { parseClientMessage, type ClientMessage } from "@mjwaits/shared/protocol/client";
import { checkGame } from "@mjwaits/shared/protocol/game";
import { PROTOCOL_VERSION } from "@mjwaits/shared/protocol/limits";
import type { PersonView, RoomView, ServerMessage } from "@mjwaits/shared/protocol/server";
import { Hub, Refusal } from "./hub";

export { IDLE_TTL_MS, MAX_CONNECTIONS, UNUSED_TTL_MS } from "./hub";

// Changes each room view carries (the whole log stays in storage).
export const RECENT_CHANGES = 50;

type Phase = RoomView["phase"];
type RoomMessage = Exclude<ClientMessage, { t: "hello" | "ping" }>;

export class Room extends Hub<RoomMessage> {
  // 2: a whole Scores-tab game. Rooms from protocol 1 (the earlier seat-and-
  // lobby scoreboard) can't be read as one, so they're cleared when they wake.
  protected get schema() {
    return 2;
  }

  protected extraTables() {
    return "CREATE TABLE IF NOT EXISTS audit (v INTEGER PRIMARY KEY, body TEXT NOT NULL);";
  }

  protected initialize() {
    this.setMeta("gameVersion", 0);
    this.setMeta("phase", "waiting");
  }

  protected parse(frame: string | ArrayBuffer) {
    return parseClientMessage(frame);
  }

  private get phase(): Phase {
    return this.meta<Phase>("phase") ?? "waiting";
  }

  // What the join form shows before connecting: whether the room exists, and
  // whether its game is up. Null for a code no one has made.
  async info(): Promise<{ phase: Phase; players: string[] } | null> {
    if (this.meta("code") === null) return null;
    return { phase: this.phase, players: this.meta<ScoreGame>("game")?.seats ?? [] };
  }

  protected welcome(id: string, token: string, rid?: string): ServerMessage {
    return { t: "welcome", v: PROTOCOL_VERSION, token, id, name: this.person(id)!.name, host: this.isHost(id), ...(rid === undefined ? {} : { rid }) };
  }

  protected act(personId: string, msg: RoomMessage) {
    const me = this.person(personId);
    if (!me) throw new Refusal("notJoined", "say hello first");
    const isHost = this.isHost(personId);
    switch (msg.t) {
      case "update": {
        if (this.phase === "ended") throw new Refusal("ended", "the host has stopped sharing this game");
        const current = this.meta<ScoreGame>("game");
        // Putting the game up is the host's; after that, anyone they allow.
        if (!isHost && (!me.can_record || !current)) throw new Refusal("notAllowed", "the host hasn't let you record");
        const checked = checkGame(msg.game);
        if (!checked.ok) throw new Refusal("badGame", checked.error);
        if (current && checked.value.id !== current.id) throw new Refusal("badGame", "that's a different game - share it as a new room");
        const gameVersion = this.meta<number>("gameVersion") ?? 0;
        if (msg.base !== gameVersion) throw new Refusal("conflict", "someone else's change landed first");
        const entry: AuditEntry = { v: gameVersion + 1, at: Date.now(), by: me.name, ...diffGames(current, checked.value) };
        this.sql.exec("INSERT INTO audit (v, body) VALUES (?, ?)", entry.v, JSON.stringify(entry));
        this.setMeta("game", checked.value);
        this.setMeta("gameVersion", gameVersion + 1);
        if (isHost && msg.colors) this.setMeta("colors", msg.colors);
        this.setMeta("phase", "live");
        break;
      }
      case "setRecorder": {
        if (!isHost) throw new Refusal("notHost", "only the host decides who records");
        if (!this.person(msg.person)) throw new Refusal("noSuchPerson", "no one here by that id");
        this.sql.exec("UPDATE people SET can_record = ? WHERE id = ?", msg.allow ? 1 : 0, msg.person);
        break;
      }
      case "stop":
        if (!isHost) throw new Refusal("notHost", "only the host stops sharing");
        this.setMeta("phase", "ended");
        break;
      case "resume":
        if (!isHost) throw new Refusal("notHost", "only the host can share it again");
        this.setMeta("phase", this.meta("game") ? "live" : "waiting");
        break;
    }
    this.changed();
  }

  // ---- Broadcasting -------------------------------------------------------

  private view(except?: WebSocket): RoomView {
    const log = this.sql.exec<{ body: string }>("SELECT body FROM audit ORDER BY v").toArray().map((r) => JSON.parse(r.body) as AuditEntry);
    const online = this.online(except);
    const people: PersonView[] = this.people().map((p) => ({
      id: p.id,
      name: p.name,
      connected: online.has(p.id),
      host: this.isHost(p.id),
      canRecord: this.isHost(p.id) || p.can_record === 1,
    }));
    return {
      code: this.meta<string>("code")!,
      version: this.clock.version,
      phase: this.phase,
      people,
      game: this.meta<ScoreGame>("game"),
      gameVersion: this.meta<number>("gameVersion") ?? 0,
      colors: this.meta<Record<string, number>>("colors") ?? {},
      authors: entryAuthors(log),
      changes: log.slice(-RECENT_CHANGES),
    };
  }

  protected broadcast(except?: WebSocket) {
    const msg: ServerMessage = { t: "room", room: this.view(except) };
    for (const [ws, c] of this.conns(except)) if (c.person) this.send(ws, msg);
  }
}
