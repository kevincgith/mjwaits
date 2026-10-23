// One room (a table): a Durable Object keyed by its room code.
//
// It holds the room in its own SQLite storage and talks to its players over
// WebSockets accepted with the Hibernation API, so a quiet room costs
// nothing while it waits - the sockets stay open while the object sleeps,
// and each one's small per-connection state rides along as its attachment.
//
// Every frame goes through parseClientMessage (shared/protocol) before
// anything else looks at it, and every change ends with the whole public
// room going to everyone (see RoomView).
//
// Phase 1, the shared scoreboard: players join, sit and start; then any
// seated player records hands, draws and 特別獎罰 as events in the Scores
// tab's own format (ledger.ts), and the board is worked out by replaying
// them with the shared ledger - the same numbers the Scores tab would show.
// Undo takes back the last event, once another player agrees (or at once,
// for the host, if the room allows it). Ending the session freezes the
// board as its summary.

import { DurableObject } from "cloudflare:workers";
import { DEFAULT_SETTINGS, replay, settle, type ScoreEvent, type ScoreGame, type ScoreSettings } from "@mjwaits/shared/engine/ledger";
import { DEFAULT_ROOM_SETTINGS, parseClientMessage, type ClientMessage, type RoomSettings } from "@mjwaits/shared/protocol/client";
import { cleanNickname, PROTOCOL_VERSION, RATE_BURST, RATE_PER_SECOND, SEATS } from "@mjwaits/shared/protocol/limits";
import type { BoardView, ErrorCode, PendingUndo, RoomView, SeatView, ServerMessage, SessionSummary } from "@mjwaits/shared/protocol/server";
import type { Env } from "./index";

// Open connections per room (players and watchers together).
export const MAX_CONNECTIONS = 16;
// Nicknames a room will remember - seated or not, connected or not.
export const MAX_PLAYERS = 12;
// A connection over its rate limit this many times in a row is closed.
export const RATE_STRIKES = 10;
// A room no one has joined is gone after an hour; any other, two days after
// the last change once no one is connected.
export const UNUSED_TTL_MS = 60 * 60 * 1000;
export const IDLE_TTL_MS = 48 * 60 * 60 * 1000;

const CLOSE_POLICY = 1008;

// Kept on each socket (serializeAttachment), so it survives hibernation.
interface Conn {
  player: string | null; // set by `hello`
  tokens: number; // rate limit bucket
  at: number; // when the bucket was last topped up
  strikes: number;
}

type Phase = RoomView["phase"];

type PlayerRow = {
  id: string;
  name: string;
  seat: number | null;
};

const hex = (bytes: ArrayBuffer | Uint8Array) => Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
const randomHex = (n: number) => hex(crypto.getRandomValues(new Uint8Array(n)));
const sha256 = async (s: string) => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));

// The ledger settings a room plays by: the Scores tab's defaults with the
// host's 底 / 莊 / 連莊, and 詐胡 off - the room has no message for it, so
// the web app's 食胡 sheet shouldn't offer it.
export function ledgerSettings(room: RoomSettings): ScoreSettings {
  return { ...DEFAULT_SETTINGS, base: room.base, dealerTai: room.dealerTai, streakTai: room.streakTai, zhaHu: null };
}

// The game record minus its events, kept in meta from the start (events
// have their own table, one row each).
type GameHead = Omit<ScoreGame, "events">;

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
  }

  // Run on every start, and again after an expired room's storage is wiped
  // (deleteAll drops the tables too) in case its code is handed out again.
  private migrate() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS players (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        name_key TEXT NOT NULL UNIQUE,
        seat INTEGER UNIQUE,
        joined_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (idx INTEGER PRIMARY KEY, body TEXT NOT NULL);
    `);
  }

  // ---- Storage ------------------------------------------------------------

  private meta<T>(key: string): T | null {
    const row = this.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = ?", key).toArray()[0];
    return row ? (JSON.parse(row.value) as T) : null;
  }

  private setMeta(key: string, value: unknown) {
    this.sql.exec("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, JSON.stringify(value));
  }

  private deleteMeta(key: string) {
    this.sql.exec("DELETE FROM meta WHERE key = ?", key);
  }

  private settings(): RoomSettings {
    return this.meta<RoomSettings>("settings") ?? DEFAULT_ROOM_SETTINGS;
  }

  private eventCount(): number {
    return this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM events").one().n;
  }

  // The scoreboard as the ledger keeps it, or null before the game starts.
  private game(): ScoreGame | null {
    const head = this.meta<GameHead>("game");
    if (!head) return null;
    const events = this.sql.exec<{ body: string }>("SELECT body FROM events ORDER BY idx").toArray().map((r) => JSON.parse(r.body) as ScoreEvent);
    return { ...head, events, updatedAt: this.meta<number>("updated") ?? head.startedAt };
  }

  private record(ev: ScoreEvent) {
    this.sql.exec("INSERT INTO events (idx, body) VALUES (?, ?)", this.eventCount(), JSON.stringify(ev));
  }

  private players(): PlayerRow[] {
    return this.sql.exec<PlayerRow>("SELECT id, name, seat FROM players ORDER BY joined_at").toArray();
  }

  private player(id: string): PlayerRow | null {
    return this.sql.exec<PlayerRow>("SELECT id, name, seat FROM players WHERE id = ?", id).toArray()[0] ?? null;
  }

  private get phase(): Phase {
    return this.meta<Phase>("phase") ?? "lobby";
  }

  // ---- Making the room ----------------------------------------------------

  // Called by the Worker with a fresh random code: true if this room is new
  // (and now exists), false if the code is already in use.
  async create(code: string): Promise<boolean> {
    this.migrate();
    if (this.meta("code") !== null) return false;
    const now = Date.now();
    this.setMeta("code", code);
    this.setMeta("created", now);
    this.setMeta("updated", now);
    this.setMeta("version", 0);
    this.setMeta("phase", "lobby");
    this.setMeta("settings", DEFAULT_ROOM_SETTINGS);
    await this.ctx.storage.setAlarm(now + UNUSED_TTL_MS);
    return true;
  }

  // What the join form shows before connecting: whether the room exists and
  // how full it is. Null for a code no one has made.
  async info(): Promise<{ phase: Phase; seated: number } | null> {
    if (this.meta("code") === null) return null;
    return { phase: this.phase, seated: this.players().filter((p) => p.seat !== null).length };
  }

  async fetch(_request: Request): Promise<Response> {
    if (this.meta("code") === null) return new Response("no such room", { status: 404 });
    if (this.ctx.getWebSockets().length >= MAX_CONNECTIONS) return new Response("room is full", { status: 503 });
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    const conn: Conn = { player: null, tokens: RATE_BURST, at: Date.now(), strikes: 0 };
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
      else if (!conn.player) throw new Refusal("notJoined", "say hello first");
      else this.act(conn.player, msg);
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
    // The player's last connection gone: everyone sees them drop.
    if (conn?.player && !this.conns(ws).some(([, c]) => c.player === conn.player)) this.changed(ws);
  }

  async webSocketError(ws: WebSocket) {
    await this.webSocketClose(ws, 1011, "error");
  }

  // ---- Messages -----------------------------------------------------------

  private async hello(ws: WebSocket, conn: Conn, msg: Extract<ClientMessage, { t: "hello" }>) {
    if (msg.v !== PROTOCOL_VERSION) throw new Refusal("version", `this page speaks version ${msg.v}, the server ${PROTOCOL_VERSION} - reload the page`);
    if (conn.player) throw new Refusal("badMessage", "already joined");
    // The one await comes first: everything after it runs in one go, so no
    // other message can slip in between checking a name and taking it.
    const token = msg.token ?? randomHex(16);
    const tokenHash = await sha256(token);
    // Another hello on this socket may have finished while this one waited.
    if ((ws.deserializeAttachment() as Conn).player) throw new Refusal("badMessage", "already joined");
    let id: string;
    if (msg.token) {
      const row = this.sql.exec<{ id: string }>("SELECT id FROM players WHERE token_hash = ?", tokenHash).toArray()[0];
      if (!row) throw new Refusal("badToken", "this room doesn't know that player - join again");
      id = row.id;
    } else {
      const name = cleanNickname(msg.name);
      if (!name) throw new Refusal("badMessage", "pick a nickname");
      if (this.sql.exec("SELECT 1 FROM players WHERE name_key = ?", nameKey(name)).toArray().length)
        throw new Refusal("nameTaken", `someone here is already called ${name}`);
      if (this.players().length >= MAX_PLAYERS) throw new Refusal("badMessage", "this room has as many players as it can take");
      id = randomHex(8);
      this.sql.exec(
        "INSERT INTO players (id, token_hash, name, name_key, seat, joined_at) VALUES (?, ?, ?, ?, NULL, ?)",
        id,
        tokenHash,
        name,
        nameKey(name),
        Date.now()
      );
      if (this.meta("host") === null) this.setMeta("host", id);
    }
    conn.player = id;
    ws.serializeAttachment(conn);
    const me = this.player(id)!;
    this.send(ws, {
      t: "welcome",
      v: PROTOCOL_VERSION,
      token,
      name: me.name,
      host: this.meta<string>("host") === id,
      seat: me.seat,
      ...(msg.rid === undefined ? {} : { rid: msg.rid }),
    });
    this.changed();
  }

  private act(playerId: string, msg: Exclude<ClientMessage, { t: "hello" | "ping" }>) {
    const me = this.player(playerId);
    if (!me) throw new Refusal("notJoined", "say hello first");
    const isHost = this.meta<string>("host") === playerId;
    const lobby = () => {
      if (this.phase !== "lobby") throw new Refusal("started", "the game has started");
    };
    const playing = () => {
      const phase = this.phase;
      if (phase === "lobby") throw new Refusal("notStarted", "the game hasn't started");
      if (phase === "ended") throw new Refusal("ended", "the session has ended");
    };
    // Only the four at the table record, not anyone watching.
    const seat = (): number => {
      if (me.seat === null) throw new Refusal("notSeated", "only the players at the table can do that");
      return me.seat;
    };
    const noPendingUndo = () => {
      if (this.meta("pendingUndo")) throw new Refusal("undoPending", "an undo is waiting for an answer");
    };
    switch (msg.t) {
      case "sit": {
        lobby();
        const taken = this.sql.exec<{ id: string }>("SELECT id FROM players WHERE seat = ?", msg.seat).toArray()[0];
        if (taken && taken.id !== playerId) throw new Refusal("seatTaken", "someone is in that seat");
        this.sql.exec("UPDATE players SET seat = ? WHERE id = ?", msg.seat, playerId);
        break;
      }
      case "stand":
        lobby();
        this.sql.exec("UPDATE players SET seat = NULL WHERE id = ?", playerId);
        break;
      case "setup":
        lobby();
        if (!isHost) throw new Refusal("notHost", "only the host sets up the table");
        this.setMeta("settings", msg.settings);
        break;
      case "start": {
        lobby();
        if (!isHost) throw new Refusal("notHost", "only the host starts the game");
        if (this.sql.exec("SELECT 1 FROM players WHERE seat IS NOT NULL").toArray().length < SEATS)
          throw new Refusal("seatsNotFull", "all four seats need a player");
        const seated = this.players().filter((p) => p.seat !== null);
        const names = Array.from({ length: SEATS }, (_, i) => seated.find((p) => p.seat === i)!.name);
        const settings = this.settings();
        const now = Date.now();
        const head: GameHead = { id: `g${now.toString(36)}`, startedAt: now, seats: names, firstDealer: settings.firstDealer, settings: ledgerSettings(settings) };
        this.setMeta("game", head);
        this.setMeta("phase", "playing");
        break;
      }
      case "win": {
        playing();
        seat();
        noPendingUndo();
        if (msg.winners.length > 1 && this.settings().multiWin !== "all")
          throw new Refusal("multiWinOff", "this table plays 截胡: one winner per discard");
        const names = this.meta<GameHead>("game")!.seats;
        this.record({
          t: "win",
          at: Date.now(),
          winners: msg.winners.map((w) => ({ seat: w.seat, tai: w.tai })),
          from: msg.from,
          source: "quick",
          ...(msg.jackpot ? { jackpotTo: names[msg.winners[0].seat] } : {}),
        });
        break;
      }
      case "draw":
        playing();
        seat();
        noPendingUndo();
        this.record({ t: "draw", at: Date.now() });
        break;
      case "bonus":
        playing();
        seat();
        noPendingUndo();
        this.record({ t: "bonus", at: Date.now(), seat: msg.seat, kind: msg.kind, amount: msg.amount, ...(msg.other === undefined ? {} : { other: msg.other }) });
        break;
      case "undo": {
        playing();
        const mine = seat();
        noPendingUndo();
        const entries = this.eventCount();
        if (entries === 0) throw new Refusal("nothingToUndo", "nothing recorded yet");
        if (isHost && this.settings().hostCanUndo) this.dropLast();
        else this.setMeta("pendingUndo", { by: mine, entry: entries - 1 } satisfies PendingUndo);
        break;
      }
      case "undoVote": {
        playing();
        const mine = seat();
        const pending = this.meta<PendingUndo>("pendingUndo");
        if (!pending) throw new Refusal("noUndoPending", "no undo is waiting for an answer");
        if (pending.by === mine && msg.approve) throw new Refusal("ownUndo", "another player has to agree");
        // Recording is blocked while an undo waits, so its entry is still the last.
        if (msg.approve) this.dropLast();
        this.deleteMeta("pendingUndo");
        break;
      }
      case "end":
        playing();
        if (!isHost) throw new Refusal("notHost", "only the host ends the session");
        noPendingUndo();
        this.setMeta("phase", "ended");
        this.setMeta("endedAt", Date.now());
        break;
    }
    this.changed();
  }

  private dropLast() {
    this.sql.exec("DELETE FROM events WHERE idx = (SELECT MAX(idx) FROM events)");
  }

  // ---- Broadcasting -------------------------------------------------------

  // The board and, once ended, the summary - worked out from the events by
  // the shared ledger.
  private scores(game: ScoreGame, settings: RoomSettings): { board: BoardView; summary: SessionSummary | null } {
    const state = replay(game);
    const net = game.seats.map((name) => state.totals[name] ?? 0);
    const chips = net.map((n) => settings.startChips + n);
    const board: BoardView = {
      chips,
      net,
      dealer: state.dealer,
      streak: state.streak,
      roundWind: state.roundWind,
      label: state.label,
      hands: state.hands.length,
      lahs: state.lahs,
      pot: state.pot,
    };
    const endedAt = this.meta<number>("endedAt");
    const seatOf = (name: string) => game.seats.indexOf(name);
    const summary =
      endedAt === null
        ? null
        : {
            hands: board.hands,
            net,
            chips,
            settle: settle(Object.fromEntries(game.seats.map((name, i) => [name, net[i]]))).map((p) => ({ from: seatOf(p.from), to: seatOf(p.to), amount: p.amount })),
            pot: board.pot,
            endedAt,
          };
    return { board, summary };
  }

  private view(except?: WebSocket): RoomView {
    const online = new Set(this.conns(except).map(([, c]) => c.player));
    const host = this.meta<string>("host");
    const seats: (SeatView | null)[] = Array.from({ length: SEATS }, () => null);
    let watching = 0;
    for (const p of this.players()) {
      if (p.seat !== null) seats[p.seat] = { name: p.name, connected: online.has(p.id), host: p.id === host };
      else if (online.has(p.id)) watching++;
    }
    const settings = this.settings();
    const game = this.game();
    const scores = game ? this.scores(game, settings) : null;
    return {
      code: this.meta<string>("code")!,
      version: this.meta<number>("version") ?? 0,
      phase: this.phase,
      seats,
      watching,
      settings,
      game,
      board: scores?.board ?? null,
      pendingUndo: this.meta<PendingUndo>("pendingUndo"),
      summary: scores?.summary ?? null,
    };
  }

  // Something everyone can see changed: count it, note when (for expiry),
  // and send the room to every joined connection.
  private changed(except?: WebSocket) {
    this.setMeta("version", (this.meta<number>("version") ?? 0) + 1);
    this.setMeta("updated", Date.now());
    const msg: ServerMessage = { t: "room", room: this.view(except) };
    for (const [ws, c] of this.conns(except)) if (c.player) this.send(ws, msg);
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
    const joined = this.players().length > 0;
    const due = (this.meta<number>("updated") ?? 0) + (joined ? IDLE_TTL_MS : UNUSED_TTL_MS);
    if (now < due) {
      await this.ctx.storage.setAlarm(due);
      return;
    }
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    this.migrate(); // this object lives on: answer "no such room" from empty tables
  }
}
