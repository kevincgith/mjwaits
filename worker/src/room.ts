// One live room: a Durable Object keyed by its room code, sharing one
// Scores-tab game between phones.
//
// It holds the room in its own SQLite storage and talks to its people over
// WebSockets accepted with the Hibernation API, so a quiet room costs
// nothing while it waits - the sockets stay open while the object sleeps,
// and each one's small per-connection state rides along as its attachment.
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

import { DurableObject } from "cloudflare:workers";
import type { ScoreGame } from "@mjwaits/shared/engine/ledger";
import { parseClientMessage, type ClientMessage } from "@mjwaits/shared/protocol/client";
import { diffGames, entryAuthors, type AuditEntry } from "@mjwaits/shared/protocol/audit";
import { checkGame } from "@mjwaits/shared/protocol/game";
import { cleanNickname, PROTOCOL_VERSION, RATE_BURST, RATE_PER_SECOND } from "@mjwaits/shared/protocol/limits";
import type { ErrorCode, PersonView, RoomView, ServerMessage } from "@mjwaits/shared/protocol/server";
import type { Env } from "./index";

// Open connections per room (host, recorders and watchers together).
export const MAX_CONNECTIONS = 16;
// Nicknames a room will remember - connected or not.
export const MAX_PEOPLE = 12;
// Changes each room view carries (the whole log stays in storage).
export const RECENT_CHANGES = 50;
// A connection over its rate limit this many times in a row is closed.
export const RATE_STRIKES = 10;
// A room no one has joined is gone after an hour; any other, two days after
// the last change once no one is connected.
export const UNUSED_TTL_MS = 60 * 60 * 1000;
export const IDLE_TTL_MS = 48 * 60 * 60 * 1000;
// Rooms keep this in meta. One without it was made by the earlier
// scoreboard rooms (protocol 1), which can't be read as a live game: wiped.
const SCHEMA = 2;

const CLOSE_POLICY = 1008;

// Kept on each socket (serializeAttachment), so it survives hibernation.
interface Conn {
  person: string | null; // set by `hello`
  tokens: number; // rate limit bucket
  at: number; // when the bucket was last topped up
  strikes: number;
}

type Phase = RoomView["phase"];

type PersonRow = {
  id: string;
  name: string;
  can_record: number; // SQLite has no booleans
};

const hex = (bytes: ArrayBuffer | Uint8Array) => Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
const randomHex = (n: number) => hex(crypto.getRandomValues(new Uint8Array(n)));
const sha256 = async (s: string) => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));

// Nicknames are unique per room regardless of case or width (Ｋ vs K).
const nameKey = (name: string) => name.normalize("NFKC").toLowerCase();

class Refusal extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export class Room extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.migrate();
    if (this.meta("code") !== null && this.meta<number>("schema") !== SCHEMA) void ctx.blockConcurrencyWhile(() => this.wipe());
  }

  // Run on every start, and again after a room's storage is wiped (deleteAll
  // drops the tables too) in case its code is handed out again.
  private migrate() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS people (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        name_key TEXT NOT NULL UNIQUE,
        can_record INTEGER NOT NULL DEFAULT 0,
        joined_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS audit (v INTEGER PRIMARY KEY, body TEXT NOT NULL);
    `);
  }

  private async wipe() {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    this.migrate(); // this object lives on: answer "no such room" from empty tables
  }

  // ---- Storage ------------------------------------------------------------

  private meta<T>(key: string): T | null {
    const row = this.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = ?", key).toArray()[0];
    return row ? (JSON.parse(row.value) as T) : null;
  }

  private setMeta(key: string, value: unknown) {
    this.sql.exec("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, JSON.stringify(value));
  }

  private people(): PersonRow[] {
    return this.sql.exec<PersonRow>("SELECT id, name, can_record FROM people ORDER BY joined_at").toArray();
  }

  private person(id: string): PersonRow | null {
    return this.sql.exec<PersonRow>("SELECT id, name, can_record FROM people WHERE id = ?", id).toArray()[0] ?? null;
  }

  private get phase(): Phase {
    return this.meta<Phase>("phase") ?? "waiting";
  }

  // ---- Making the room ----------------------------------------------------

  // Called by the Worker with a fresh random code: true if this room is new
  // (and now exists), false if the code is already in use.
  async create(code: string): Promise<boolean> {
    this.migrate();
    if (this.meta("code") !== null) return false;
    const now = Date.now();
    this.setMeta("schema", SCHEMA);
    this.setMeta("code", code);
    this.setMeta("created", now);
    this.setMeta("updated", now);
    this.setMeta("version", 0);
    this.setMeta("gameVersion", 0);
    this.setMeta("phase", "waiting");
    await this.ctx.storage.setAlarm(now + UNUSED_TTL_MS);
    return true;
  }

  // What the join form shows before connecting: whether the room exists, and
  // whether its game is up. Null for a code no one has made.
  async info(): Promise<{ phase: Phase; players: string[] } | null> {
    if (this.meta("code") === null) return null;
    return { phase: this.phase, players: this.meta<ScoreGame>("game")?.seats ?? [] };
  }

  async fetch(_request: Request): Promise<Response> {
    if (this.meta("code") === null) return new Response("no such room", { status: 404 });
    if (this.ctx.getWebSockets().length >= MAX_CONNECTIONS) return new Response("room is full", { status: 503 });
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    const conn: Conn = { person: null, tokens: RATE_BURST, at: Date.now(), strikes: 0 };
    server.serializeAttachment(conn);
    return new Response(null, { status: 101, webSocket: client });
  }

  // ---- Connections --------------------------------------------------------

  private send(ws: WebSocket, msg: ServerMessage) {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // Closing or closed - its close handler tidies up.
    }
  }

  private refuse(ws: WebSocket, code: ErrorCode, message: string, rid?: string) {
    this.send(ws, { t: "error", code, message, ...(rid === undefined ? {} : { rid }) });
  }

  // Sockets still open, each with its connection state.
  private conns(except?: WebSocket): [WebSocket, Conn][] {
    return this.ctx
      .getWebSockets()
      .filter((ws) => ws !== except && ws.readyState === WebSocket.OPEN)
      .map((ws) => [ws, ws.deserializeAttachment() as Conn]);
  }

  // Token bucket: true if this frame may go through.
  private admit(ws: WebSocket, conn: Conn): boolean {
    const now = Date.now();
    conn.tokens = Math.min(RATE_BURST, conn.tokens + ((now - conn.at) / 1000) * RATE_PER_SECOND);
    conn.at = now;
    const ok = conn.tokens >= 1;
    if (ok) {
      conn.tokens -= 1;
      conn.strikes = 0;
    } else conn.strikes += 1;
    ws.serializeAttachment(conn);
    return ok;
  }

  async webSocketMessage(ws: WebSocket, frame: string | ArrayBuffer) {
    const conn = ws.deserializeAttachment() as Conn;
    if (!this.admit(ws, conn)) {
      if (conn.strikes >= RATE_STRIKES) ws.close(CLOSE_POLICY, "rate limit");
      else this.refuse(ws, "rateLimited", "too many messages - slow down");
      return;
    }
    const parsed = parseClientMessage(frame);
    if (!parsed.ok) {
      this.refuse(ws, parsed.error === "message: too large" ? "tooLarge" : "badMessage", parsed.error);
      return;
    }
    const msg = parsed.value;
    try {
      if (msg.t === "hello") await this.hello(ws, conn, msg);
      else if (msg.t === "ping") this.send(ws, { t: "pong", ...(msg.rid === undefined ? {} : { rid: msg.rid }) });
      else if (!conn.person) throw new Refusal("notJoined", "say hello first");
      else this.act(conn.person, msg);
    } catch (e) {
      if (!(e instanceof Refusal)) throw e;
      this.refuse(ws, e.code, e.message, msg.rid);
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string) {
    try {
      ws.close(code, reason);
    } catch {
      // Already closed.
    }
    const conn = ws.deserializeAttachment() as Conn | null;
    // Their last connection gone: everyone sees them drop.
    if (conn?.person && !this.conns(ws).some(([, c]) => c.person === conn.person)) this.changed(ws);
  }

  async webSocketError(ws: WebSocket) {
    await this.webSocketClose(ws, 1011, "error");
  }

  // ---- Messages -----------------------------------------------------------

  private async hello(ws: WebSocket, conn: Conn, msg: Extract<ClientMessage, { t: "hello" }>) {
    if (msg.v !== PROTOCOL_VERSION) throw new Refusal("version", `this page speaks version ${msg.v}, the server ${PROTOCOL_VERSION} - reload the page`);
    if (conn.person) throw new Refusal("badMessage", "already joined");
    // The one await comes first: everything after it runs in one go, so no
    // other message can slip in between checking a name and taking it.
    const token = msg.token ?? randomHex(16);
    const tokenHash = await sha256(token);
    // Another hello on this socket may have finished while this one waited.
    if ((ws.deserializeAttachment() as Conn).person) throw new Refusal("badMessage", "already joined");
    let id: string;
    if (msg.token) {
      const row = this.sql.exec<{ id: string }>("SELECT id FROM people WHERE token_hash = ?", tokenHash).toArray()[0];
      if (!row) throw new Refusal("badToken", "this room doesn't know you - join again");
      id = row.id;
    } else {
      const name = cleanNickname(msg.name);
      if (!name) throw new Refusal("badMessage", "pick a nickname");
      if (this.sql.exec("SELECT 1 FROM people WHERE name_key = ?", nameKey(name)).toArray().length)
        throw new Refusal("nameTaken", `someone here is already called ${name}`);
      if (this.people().length >= MAX_PEOPLE) throw new Refusal("badMessage", "this room has as many people as it can take");
      id = randomHex(8);
      this.sql.exec("INSERT INTO people (id, token_hash, name, name_key, joined_at) VALUES (?, ?, ?, ?, ?)", id, tokenHash, name, nameKey(name), Date.now());
      if (this.meta("host") === null) this.setMeta("host", id);
    }
    conn.person = id;
    ws.serializeAttachment(conn);
    this.send(ws, {
      t: "welcome",
      v: PROTOCOL_VERSION,
      token,
      id,
      name: this.person(id)!.name,
      host: this.meta<string>("host") === id,
      ...(msg.rid === undefined ? {} : { rid: msg.rid }),
    });
    this.changed();
  }

  private act(personId: string, msg: Exclude<ClientMessage, { t: "hello" | "ping" }>) {
    const me = this.person(personId);
    if (!me) throw new Refusal("notJoined", "say hello first");
    const isHost = this.meta<string>("host") === personId;
    const notEnded = () => {
      if (this.phase === "ended") throw new Refusal("ended", "the host has stopped sharing this game");
    };
    switch (msg.t) {
      case "update": {
        notEnded();
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
        const target = this.person(msg.person);
        if (!target) throw new Refusal("noSuchPerson", "no one here by that id");
        this.sql.exec("UPDATE people SET can_record = ? WHERE id = ?", msg.allow ? 1 : 0, msg.person);
        break;
      }
      case "stop":
        if (!isHost) throw new Refusal("notHost", "only the host stops sharing");
        this.setMeta("phase", "ended");
        break;
    }
    this.changed();
  }

  // ---- Broadcasting -------------------------------------------------------

  private view(except?: WebSocket): RoomView {
    const log = this.sql.exec<{ body: string }>("SELECT body FROM audit ORDER BY v").toArray().map((r) => JSON.parse(r.body) as AuditEntry);
    const online = new Set(this.conns(except).map(([, c]) => c.person));
    const host = this.meta<string>("host");
    const people: PersonView[] = this.people().map((p) => ({
      id: p.id,
      name: p.name,
      connected: online.has(p.id),
      host: p.id === host,
      canRecord: p.id === host || p.can_record === 1,
    }));
    return {
      code: this.meta<string>("code")!,
      version: this.meta<number>("version") ?? 0,
      phase: this.phase,
      people,
      game: this.meta<ScoreGame>("game"),
      gameVersion: this.meta<number>("gameVersion") ?? 0,
      colors: this.meta<Record<string, number>>("colors") ?? {},
      authors: entryAuthors(log),
      changes: log.slice(-RECENT_CHANGES),
    };
  }

  // Something everyone can see changed: count it, note when (for expiry),
  // and send the room to every joined connection.
  private changed(except?: WebSocket) {
    this.setMeta("version", (this.meta<number>("version") ?? 0) + 1);
    this.setMeta("updated", Date.now());
    const msg: ServerMessage = { t: "room", room: this.view(except) };
    for (const [ws, c] of this.conns(except)) if (c.person) this.send(ws, msg);
  }

  // ---- Expiry -------------------------------------------------------------

  // The alarm is set once, when the room is made, and from then on only
  // moves when it fires - no storage write per message. A room with someone
  // connected is never removed.
  async alarm() {
    const now = Date.now();
    if (this.conns().length > 0) {
      await this.ctx.storage.setAlarm(now + IDLE_TTL_MS);
      return;
    }
    const joined = this.people().length > 0;
    const due = (this.meta<number>("updated") ?? 0) + (joined ? IDLE_TTL_MS : UNUSED_TTL_MS);
    if (now < due) {
      await this.ctx.storage.setAlarm(due);
      return;
    }
    await this.wipe();
  }
}
