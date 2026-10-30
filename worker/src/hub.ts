// What every kind of room has in common - a live-scores room (room.ts) and an
// online table (table.ts): a Durable Object keyed by its code, keeping its
// state in its own SQLite storage and talking to its people over WebSockets
// accepted with the Hibernation API, so a quiet room costs nothing while it
// waits - the sockets stay open while the object sleeps, and each one's small
// per-connection state rides along as its attachment.
//
// Here: making the room; joining it (`hello`: a nickname, unique in the room,
// or a reconnect token kept only as a hash - the first to join is the host);
// a rate limit per connection; sending a change to everyone; and the one
// alarm, which a room type can use for its own timers and which otherwise
// clears the room away once it's been idle long enough. Each room type says
// how a frame is read (parse), what a message does (act) and what each
// connection is sent (broadcast).

import { DurableObject } from "cloudflare:workers";
import { cleanNickname, PROTOCOL_VERSION, RATE_BURST, RATE_PER_SECOND } from "@mjwaits/shared/protocol/limits";
import type { Result } from "@mjwaits/shared/protocol/schema";
import type { Env } from "./index";

// Open connections per room (everyone together).
export const MAX_CONNECTIONS = 16;
// Nicknames a room will remember - connected or not.
export const MAX_PEOPLE = 12;
// A connection over its rate limit this many times in a row is closed.
export const RATE_STRIKES = 10;
// A room no one has joined is gone after an hour; any other, two days after
// the last change once no one is connected.
export const UNUSED_TTL_MS = 60 * 60 * 1000;
export const IDLE_TTL_MS = 48 * 60 * 60 * 1000;

const CLOSE_POLICY = 1008;

// The heartbeat: pages ping every 20s (PING_MS in online.ts), answered
// without waking the room (an auto-response); a connection that's pinged
// before and has gone this long without a ping or a message is a phone
// that's slept or dropped off - closed, so its seat is seen to go (and is
// played for after the hold). Checked this often while anyone's connected.
export const QUIET_MS = 50_000;
export const SWEEP_MS = 25_000;
// A page from before the heartbeat never pings: closed once it's gone this
// long without a message. (It opens again, if it's still there.)
export const UNPINGED_MS = 5 * 60_000;
// A connection that hasn't said hello this long after opening is closed:
// it holds a place (MAX_CONNECTIONS) for no one.
export const HELLO_MS = 15_000;
const PING = JSON.stringify({ t: "ping" });
const PONG = JSON.stringify({ t: "pong" });
const CLOSE_QUIET = 4000;

// A room that hands on its host (see handsOnHost): the host gone this long -
// no phone of theirs connected - and it's whoever's there who joined first.
export const HOST_GONE_MS = 2 * 60 * 1000;

// Kept on each socket (serializeAttachment), so it survives hibernation.
export interface Conn {
  person: string | null; // set by `hello`
  tokens: number; // rate limit bucket
  at: number; // when the bucket was last topped up
  strikes: number;
  opened?: number; // (absent: a connection from before it was kept)
}

export interface Clock {
  version: number;
  updated: number;
}

export type PersonRow = {
  id: string;
  name: string;
  can_record: number; // SQLite has no booleans
};

export interface Hello {
  t: "hello";
  v: number;
  name: string;
  token?: string;
  rid?: string;
}

const hex = (bytes: ArrayBuffer | Uint8Array) => Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
export const randomHex = (n: number) => hex(crypto.getRandomValues(new Uint8Array(n)));
const sha256 = async (s: string) => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));

// Nicknames are unique per room regardless of case or width (Ｋ vs K).
const nameKey = (name: string) => name.normalize("NFKC").toLowerCase();

// A message the room turns down: its code and why, sent back as an error.
export class Refusal extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export abstract class Hub<Msg extends { t: string; rid?: string }> extends DurableObject<Env> {
  protected readonly sql: SqlStorage;
  // Kept in meta. A room without the current mark was made by an earlier,
  // incompatible version: cleared when it wakes. (A getter, not a field: the
  // constructor below reads it before a subclass's fields are set.)
  protected abstract get schema(): number;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.migrate();
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
    void ctx.blockConcurrencyWhile(async () => {
      if (this.meta("code") !== null && this.meta<number>("schema") !== this.schema) await this.wipe();
    });
  }

  // ---- What a room type supplies -------------------------------------------

  protected abstract parse(frame: string | ArrayBuffer): Result<Msg | Hello | { t: "ping"; rid?: string }>;
  protected abstract act(personId: string, msg: Msg, ws: WebSocket): void | Promise<void>;
  // Send the room to every joined connection (as each may see it).
  protected abstract broadcast(except?: WebSocket): void;
  protected abstract welcome(id: string, token: string, rid?: string): object;
  protected initialize(_now: number): void {}
  protected extraTables(): string {
    return "";
  }
  // A person's last connection opened or closed.
  protected onArrive(_personId: string): void {}
  protected onLeave(_personId: string): void {}
  // The alarm went off: do what's due, and say when to wake next (null: no
  // timer of the room type's own is pending). Expiry is handled here.
  protected onAlarm(_now: number): number | null | Promise<number | null> {
    return null;
  }

  // ---- Storage ---------------------------------------------------------------

  // Run on every start, and again after a room's storage is wiped (deleteAll
  // drops the tables too) in case its code is handed out again.
  protected migrate() {
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
      ${this.extraTables()}
    `);
  }

  protected async wipe() {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    this.migrate(); // this object lives on: answer "no such room" from empty tables
  }

  protected meta<T>(key: string): T | null {
    const row = this.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = ?", key).toArray()[0];
    return row ? (JSON.parse(row.value) as T) : null;
  }

  protected setMeta(key: string, value: unknown) {
    this.sql.exec("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, JSON.stringify(value));
  }

  protected people(): PersonRow[] {
    return this.sql.exec<PersonRow>("SELECT id, name, can_record FROM people ORDER BY joined_at").toArray();
  }

  protected person(id: string): PersonRow | null {
    return this.sql.exec<PersonRow>("SELECT id, name, can_record FROM people WHERE id = ?", id).toArray()[0] ?? null;
  }

  // How many changes the room has sent, and when it last changed (expiry).
  protected get clock(): Clock {
    return this.meta<Clock>("clock") ?? { version: 0, updated: 0 };
  }

  protected isHost(personId: string): boolean {
    return this.meta<string>("host") === personId;
  }

  // Whether the host passes to someone else once they've been gone a while
  // (HOST_GONE_MS) - an online table, which can't start, change or end
  // without one. (A live-scores room keeps its host: it's their game.)
  protected get handsOnHost(): boolean {
    return false;
  }

  // The host gone long enough: the first-joined of the people connected
  // takes over. True if it moved.
  private passHost(now: number): boolean {
    const gone = this.meta<number>("hostGone");
    if (!this.handsOnHost || !gone || now - gone < HOST_GONE_MS) return false;
    const host = this.meta<string>("host");
    const online = this.online();
    if (host && online.has(host)) {
      this.setMeta("hostGone", 0);
      return false;
    }
    const next = this.people().find((p) => online.has(p.id));
    if (!next) return false; // no one to take it yet - whoever comes next
    this.setMeta("host", next.id);
    this.setMeta("hostGone", 0);
    return true;
  }

  // ---- Making the room ---------------------------------------------------------

  // Called by the Worker with a fresh random code: true if this room is new
  // (and now exists), false if the code is already in use.
  async create(code: string): Promise<boolean> {
    this.migrate();
    if (this.meta("code") !== null) return false;
    const now = Date.now();
    this.setMeta("schema", this.schema);
    this.setMeta("code", code);
    this.setMeta("created", now);
    this.setMeta("clock", { version: 0, updated: now } satisfies Clock);
    this.initialize(now);
    await this.ctx.storage.setAlarm(now + UNUSED_TTL_MS);
    return true;
  }

  async fetch(_request: Request): Promise<Response> {
    if (this.meta("code") === null) return new Response("no such room", { status: 404 });
    if (this.ctx.getWebSockets().length >= MAX_CONNECTIONS) return new Response("room is full", { status: 503 });
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    const now = Date.now();
    const conn: Conn = { person: null, tokens: RATE_BURST, at: now, strikes: 0, opened: now };
    server.serializeAttachment(conn);
    await this.wakeAt(now + HELLO_MS); // (to close it if no hello comes)
    return new Response(null, { status: 101, webSocket: client });
  }

  // ---- Connections ----------------------------------------------------------------

  protected send(ws: WebSocket, msg: object) {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // Closing or closed - its close handler tidies up.
    }
  }

  protected refuse(ws: WebSocket, code: string, message: string, rid?: string) {
    this.send(ws, { t: "error", code, message, ...(rid === undefined ? {} : { rid }) });
  }

  // Sockets still open, each with its connection state.
  protected conns(except?: WebSocket): [WebSocket, Conn][] {
    return this.ctx
      .getWebSockets()
      .filter((ws) => ws !== except && ws.readyState === WebSocket.OPEN)
      .map((ws) => [ws, ws.deserializeAttachment() as Conn]);
  }

  protected online(except?: WebSocket): Set<string> {
    return new Set(this.conns(except).flatMap(([, c]) => (c.person ? [c.person] : [])));
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
    const parsed = this.parse(frame);
    if (!parsed.ok) {
      this.refuse(ws, parsed.error === "message: too large" ? "tooLarge" : "badMessage", parsed.error);
      return;
    }
    const msg = parsed.value;
    try {
      if (msg.t === "hello") await this.hello(ws, conn, msg as Hello);
      else if (msg.t === "ping") this.send(ws, { t: "pong", ...(msg.rid === undefined ? {} : { rid: msg.rid }) });
      else if (!conn.person) throw new Refusal("notJoined", "say hello first");
      else await this.act(conn.person, msg as Msg, ws);
    } catch (e) {
      // The room's own error, not a refusal: logged and said, and the room
      // goes on (a room type checks before it writes - a table writes once,
      // at the end: see table.ts save).
      if (!(e instanceof Refusal)) {
        console.error("Message failed", JSON.stringify({ room: this.meta<string>("code"), t: msg.t, error: e instanceof Error ? (e.stack ?? e.message) : String(e) }));
        this.refuse(ws, "server", "something went wrong here - try again", msg.rid);
        return;
      }
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
    if (conn?.person && !this.conns(ws).some(([, c]) => c.person === conn.person)) {
      if (this.handsOnHost && this.isHost(conn.person)) {
        this.setMeta("hostGone", Date.now());
        await this.wakeAt(Date.now() + HOST_GONE_MS);
      }
      this.onLeave(conn.person);
      this.changed(ws);
    }
  }

  async webSocketError(ws: WebSocket) {
    await this.webSocketClose(ws, 1011, "error");
  }

  private async hello(ws: WebSocket, conn: Conn, msg: Hello) {
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
      if (this.people().length >= MAX_PEOPLE) throw new Refusal("full", "this room has as many people as it can take");
      id = randomHex(8);
      this.sql.exec("INSERT INTO people (id, token_hash, name, name_key, joined_at) VALUES (?, ?, ?, ?, ?)", id, tokenHash, name, nameKey(name), Date.now());
      if (this.meta("host") === null) this.setMeta("host", id);
    }
    const first = !this.conns(ws).some(([, c]) => c.person === id);
    conn.person = id;
    ws.serializeAttachment(conn);
    // The host back: they stay host. Anyone else, with the host gone long enough: it's theirs.
    if (this.isHost(id)) this.setMeta("hostGone", 0);
    else this.passHost(Date.now());
    this.send(ws, this.welcome(id, token, msg.rid));
    if (first) this.onArrive(id);
    this.changed();
    await this.wakeAt(Date.now() + SWEEP_MS);
  }

  // Connections gone quiet (see QUIET_MS, UNPINGED_MS), or that never said
  // hello (HELLO_MS): closed. True if any are left open (so the room checks again).
  private async sweep(now: number): Promise<boolean> {
    let open = false;
    for (const [ws, conn] of this.conns()) {
      if (!conn.person && now - (conn.opened ?? conn.at) > HELLO_MS) {
        await this.webSocketClose(ws, CLOSE_POLICY, "no hello");
        continue;
      }
      const pinged = this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime();
      const quiet = pinged === undefined ? now - conn.at > UNPINGED_MS : now - Math.max(pinged, conn.at) > QUIET_MS;
      if (quiet) await this.webSocketClose(ws, CLOSE_QUIET, "quiet");
      else open = true;
    }
    return open;
  }

  // Something everyone can see changed: count it, note when (for expiry),
  // and send the room to every joined connection.
  protected changed(except?: WebSocket) {
    // One row for both: every change writes it, so it's kept to one.
    this.setMeta("clock", { version: this.clock.version + 1, updated: Date.now() } satisfies Clock);
    this.broadcast(except);
  }

  // Wake the room at `at` (or sooner, if it's already due to wake sooner).
  protected async wakeAt(at: number) {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || at < current) await this.ctx.storage.setAlarm(at);
  }

  // ---- The alarm: the room type's timers, then expiry ---------------------------------
  //
  // Set when the room is made; from then on moved only when it fires or a
  // room type's timer needs it sooner - no storage write per message. A room
  // with someone connected is never removed.
  async alarm() {
    const now = Date.now();
    const open = await this.sweep(now);
    if (this.passHost(now)) this.changed();
    const next = await this.onAlarm(now);
    if (this.conns().length > 0 || next !== null) {
      const gone = this.handsOnHost ? this.meta<number>("hostGone") : null;
      const handOn = gone ? Math.max(now + 1000, gone + HOST_GONE_MS) : Infinity;
      await this.ctx.storage.setAlarm(Math.min(next ?? Infinity, open ? now + SWEEP_MS : Infinity, handOn, now + IDLE_TTL_MS));
      return;
    }
    const joined = this.people().length > 0;
    const due = this.clock.updated + (joined ? IDLE_TTL_MS : UNUSED_TTL_MS);
    if (now < due) {
      await this.ctx.storage.setAlarm(due);
      return;
    }
    await this.wipe();
  }
}
