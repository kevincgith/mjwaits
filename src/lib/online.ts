// The web app's side of the live-scores server (worker/): making and checking
// rooms, one live connection to a room that keeps itself up (RoomClient), and
// keeping a game on this phone in step with the room's (GameSync).
//
// Kept on this device (localStorage "mjwaits.online"): the nickname last
// used, each room joined with its reconnect token - so a reload, a dropped
// signal or a phone that slept puts you straight back in - and the room this
// phone is sharing its 戰況 game in, if any.
//
// No React here: RoomClient and GameSync take callbacks, and the Scores tab
// turns them into state.

import type { ScoreGame } from "@mjwaits/shared/engine/ledger";
import type { ClientMessage } from "@mjwaits/shared/protocol/client";
import { stableJson } from "@mjwaits/shared/protocol/audit";
import { GameSchema } from "@mjwaits/shared/protocol/game";
import { normalizeRoomCode, PROTOCOL_VERSION } from "@mjwaits/shared/protocol/limits";
import type { ErrorCode, RoomView, ServerMessage } from "@mjwaits/shared/protocol/server";

// Where the server is: VITE_MP_URL when the build sets it; otherwise, in
// development, wrangler dev on the same host as the page (so a phone on the
// LAN reaches it too), and the deployed server in production.
export function serverBase(): string {
  const set = import.meta.env.VITE_MP_URL as string | undefined;
  if (set) return set.replace(/\/$/, "");
  if (import.meta.env.DEV) return `${window.location.protocol}//${window.location.hostname}:8787`;
  return "https://mj-api.kevinlhc.com";
}

const wsBase = (base: string) => base.replace(/^http/, "ws");

// The link that opens the app on this room's join form.
export function joinLink(code: string): string {
  return `${window.location.origin}${import.meta.env.BASE_URL}?room=${code}`;
}

// The room code in a page address (?room=…), if any.
export function roomFromSearch(search: string): string | null {
  const raw = new URLSearchParams(search).get("room");
  return raw ? normalizeRoomCode(raw) : null;
}

// ---- This device's memory ----------------------------------------------------

export const ONLINE_KEY = "mjwaits.online";

export interface OnlineMemory {
  name: string;
  // Rooms joined on this device, newest first, with the token to get back in.
  rooms: { code: string; token: string; at: number }[];
  current: string | null; // the room being followed (shown in 戰況)
  sharing: { code: string; gameId: string } | null; // this phone's 戰況 game, live in that room
  // Games this phone has shared, newest first, and their rooms - to resume.
  hosted: { code: string; gameId: string; at: number }[];
}

const EMPTY: OnlineMemory = { name: "", rooms: [], current: null, sharing: null, hosted: [] };
// Old rooms expire on the server after two idle days; a week's list is plenty.
const MEMORY_DAYS = 7;

export function loadOnline(storage: Pick<Storage, "getItem"> | null = safeStorage()): OnlineMemory {
  try {
    const raw = storage?.getItem(ONLINE_KEY);
    if (!raw) return EMPTY;
    const saved = JSON.parse(raw) as Partial<OnlineMemory>;
    const cutoff = Date.now() - MEMORY_DAYS * 24 * 60 * 60 * 1000;
    return {
      name: typeof saved.name === "string" ? saved.name : "",
      rooms: Array.isArray(saved.rooms)
        ? saved.rooms.filter((r) => r && typeof r.code === "string" && typeof r.token === "string" && typeof r.at === "number" && r.at > cutoff)
        : [],
      current: typeof saved.current === "string" ? saved.current : null,
      sharing:
        saved.sharing && typeof saved.sharing.code === "string" && typeof saved.sharing.gameId === "string" ? { code: saved.sharing.code, gameId: saved.sharing.gameId } : null,
      hosted: Array.isArray(saved.hosted)
        ? saved.hosted.filter((h) => h && typeof h.code === "string" && typeof h.gameId === "string" && typeof h.at === "number" && h.at > cutoff)
        : [],
    };
  } catch {
    return EMPTY;
  }
}

export function saveOnline(memory: OnlineMemory, storage: Pick<Storage, "setItem"> | null = safeStorage()) {
  try {
    storage?.setItem(ONLINE_KEY, JSON.stringify(memory));
  } catch {
    // Full or blocked: the room still works, it just won't be remembered.
  }
}

function safeStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

// A name to start from, until you pick your own: Player and two digits.
export const defaultNickname = (random: () => number = Math.random) => `Player${Math.floor(random() * 90) + 10}`;

export const tokenFor = (memory: OnlineMemory, code: string) => memory.rooms.find((r) => r.code === code)?.token;

export const withToken = (memory: OnlineMemory, code: string, token: string): OnlineMemory => ({
  ...memory,
  rooms: [{ code, token, at: Date.now() }, ...memory.rooms.filter((r) => r.code !== code)],
});

export const withoutRoom = (memory: OnlineMemory, code: string): OnlineMemory => ({
  ...memory,
  rooms: memory.rooms.filter((r) => r.code !== code),
  current: memory.current === code ? null : memory.current,
  sharing: memory.sharing?.code === code ? null : memory.sharing,
  hosted: memory.hosted.filter((h) => h.code !== code),
});

// This phone is sharing `gameId` in room `code` (now, and in the list to resume).
export const withSharing = (memory: OnlineMemory, code: string, gameId: string): OnlineMemory => ({
  ...memory,
  sharing: { code, gameId },
  hosted: [{ code, gameId, at: Date.now() }, ...memory.hosted.filter((h) => h.gameId !== gameId)].slice(0, 10),
});

// ---- Rooms over HTTP -----------------------------------------------------------

export async function createRoom(base = serverBase(), fetcher: typeof fetch = fetch): Promise<string> {
  const res = await fetcher(`${base}/rooms`, { method: "POST" });
  if (!res.ok) throw new Error(res.status === 403 ? "This page isn't allowed to make rooms" : "Couldn't make a room - try again");
  return ((await res.json()) as { code: string }).code;
}

// Whether a room exists before joining it: its phase and the game's players,
// or null for a code no one has made (or one that has expired).
export async function roomInfo(code: string, base = serverBase(), fetcher: typeof fetch = fetch): Promise<{ phase: RoomView["phase"]; players: string[] } | null> {
  const res = await fetcher(`${base}/rooms/${code}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error("Couldn't reach the server");
  return (await res.json()) as { phase: RoomView["phase"]; players: string[] };
}

// ---- The live connection -------------------------------------------------------

export type ConnectionStatus = "connecting" | "open" | "reconnecting" | "closed";

// The parts of WebSocket this needs, so tests can hand in a fake.
export interface SocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

// What every kind of room sends the same way (see worker/src/hub.ts).
type Welcome = { t: "welcome"; token: string };
type HubError = { t: "error"; code: string; message: string; rid?: string };
type HubServerMessage = Welcome | HubError | { t: "pong" } | { t: string };
type ErrorCodeOf<Recv> = Recv extends { t: "error"; code: infer C } ? C : never;

export interface HubClientOptions<Recv extends HubServerMessage> {
  code: string;
  name: string;
  token?: string;
  base?: string;
  makeSocket?: (url: string) => SocketLike;
  // Waits before each retry, in ms; the last repeats. A little jitter is added.
  backoff?: number[];
  // Asked after a connection fails before it opens: a room that has gone
  // (the server answers its socket with 404, which a browser can't see)
  // would otherwise be retried forever.
  roomExists?: (code: string) => Promise<boolean>;
  onWelcome?: (welcome: Extract<Recv, { t: "welcome" }>) => void;
  onError?: (code: ErrorCodeOf<Recv>, message: string, rid?: string) => void;
  onStatus?: (status: ConnectionStatus) => void;
  // The room no longer exists (expired, or never made): the client has stopped.
  onGone?: () => void;
}

const OPEN = 1;
const DEFAULT_BACKOFF = [500, 1000, 2000, 4000, 8000];
// Errors that mean retrying the same way can't work.
const FATAL: ReadonlySet<string> = new Set(["version", "nameTaken", "full"]);

// The heartbeat: a ping this often while connected (answered by the room
// without waking it - see the Worker's hub.ts). Nothing heard back for
// DEAD_MS - a socket that still looks open after the phone slept or the
// network changed - and it's dropped and opened again; on coming back to
// the front, quiet for WAKE_MS is enough.
export const PING_MS = 20_000;
export const DEAD_MS = 50_000;
export const WAKE_MS = 25_000;
// A socket still not open after CONNECT_MS is given up on and tried again
// (one can hang connecting for good on a network that's changed); on coming
// back to the front, still connecting after STUCK_MS is enough.
export const CONNECT_MS = 8_000;
export const STUCK_MS = 2_000;

// One live connection to a room - a live-scores room or an online table -
// that keeps itself up: says hello (with the token, once it has one),
// reconnects with backoff, rejoins afresh if the room forgot the token, and
// stops for good when the room has gone. What the room sends besides the
// common messages goes to `receive` (RoomClient, TableClient).
export abstract class HubClient<Send extends { t: string }, Recv extends HubServerMessage> {
  private socket: SocketLike | null = null;
  private status: ConnectionStatus = "connecting";
  private retries = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private pinger: ReturnType<typeof setInterval> | null = null;
  private heard = 0; // when anything last came from the room
  private began = 0; // when the socket now connecting was opened
  private stopped = false;
  private nextRid = 1;
  private token: string | undefined;
  protected readonly opts: HubClientOptions<Recv>;
  private readonly path: string;

  constructor(path: "rooms" | "tables", opts: HubClientOptions<Recv>) {
    this.path = path;
    this.opts = opts;
    this.token = opts.token;
    // Nothing arrives before the subclass's fields are set: messages come
    // in on a later task.
    this.open();
  }

  protected abstract receive(msg: Recv): void;
  protected abstract exists(code: string): Promise<boolean>;

  private setStatus(status: ConnectionStatus) {
    if (status === this.status) return;
    this.status = status;
    this.opts.onStatus?.(status);
  }

  private open() {
    const url = `${wsBase(this.opts.base ?? serverBase())}/${this.path}/${this.opts.code}/ws`;
    const socket = (this.opts.makeSocket ?? ((u) => new WebSocket(u) as unknown as SocketLike))(url);
    this.socket = socket;
    this.began = Date.now();
    let opened = false;
    const lost = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.unbeat();
      clearTimeout(slow);
      if (this.stopped) return this.setStatus("closed");
      this.setStatus("reconnecting");
      this.scheduleRetry();
      if (!opened) void this.checkGone();
    };
    // No answer in time: let it go, as one that failed.
    const slow = setTimeout(() => {
      if (opened || this.socket !== socket) return;
      try {
        socket.close(4000, "slow");
      } catch {
        // Already gone.
      }
      lost();
    }, CONNECT_MS);
    socket.onopen = () => {
      opened = true;
      clearTimeout(slow);
      this.retries = 0;
      this.heard = Date.now();
      this.beat();
      this.raw({ t: "hello", v: PROTOCOL_VERSION, name: this.opts.name, ...(this.token ? { token: this.token } : {}) });
    };
    socket.onmessage = (ev) => {
      if (this.socket === socket) this.heard = Date.now();
      if (typeof ev.data !== "string") return;
      let msg: Recv;
      try {
        msg = JSON.parse(ev.data) as Recv;
      } catch {
        return;
      }
      this.handle(msg);
    };
    socket.onclose = lost;
    socket.onerror = () => {
      // A close always follows; that's where the retry happens.
    };
  }

  private handle(msg: Recv) {
    if (msg.t === "welcome") {
      const w = msg as Extract<Recv, { t: "welcome" }> & Welcome;
      this.token = w.token;
      this.setStatus("open");
      this.opts.onWelcome?.(w);
    } else if (msg.t === "error") {
      const e = msg as Extract<Recv, { t: "error" }> & HubError;
      // A token the room no longer knows: forget it and join afresh.
      if (e.code === "badToken" && this.token) {
        this.token = undefined;
        this.raw({ t: "hello", v: PROTOCOL_VERSION, name: this.opts.name });
        return;
      }
      if (FATAL.has(e.code)) this.stop();
      this.opts.onError?.(e.code as ErrorCodeOf<Recv>, e.message, e.rid);
    } else if (msg.t !== "pong") this.receive(msg);
  }

  // A failed handshake: offline, or the room is gone. Only a definite "no
  // such room" stops the retries - a failed check is just more offline.
  private async checkGone() {
    let exists = true;
    try {
      exists = await (this.opts.roomExists ?? ((code) => this.exists(code)))(this.opts.code);
    } catch {
      return;
    }
    if (exists || this.stopped) return;
    this.stop();
    this.opts.onGone?.();
  }

  private scheduleRetry() {
    const steps = this.opts.backoff ?? DEFAULT_BACKOFF;
    const wait = steps[Math.min(this.retries, steps.length - 1)] * (1 + Math.random() * 0.2);
    this.retries++;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (!this.stopped) this.open();
    }, wait);
  }

  private beat() {
    this.unbeat();
    this.pinger = setInterval(() => {
      if (Date.now() - this.heard > DEAD_MS) this.drop();
      else this.raw({ t: "ping" });
    }, PING_MS);
  }

  private unbeat() {
    if (this.pinger) clearInterval(this.pinger);
    this.pinger = null;
  }

  // A socket that's gone quiet: let it go (its close may never come) and connect again.
  private drop() {
    const socket = this.socket;
    if (!socket) return;
    this.socket = null;
    this.unbeat();
    try {
      socket.close(4000, "quiet");
    } catch {
      // Already gone.
    }
    this.setStatus("reconnecting");
    this.retries = 0;
    this.open();
  }

  // Try again now - the page came back to the front, or the network did.
  // Still connected but quiet a while: most likely a socket that died while
  // the phone slept, so a fresh one - as for one still connecting a while.
  nudge() {
    if (this.stopped) return;
    if (this.socket) {
      const open = this.socket.readyState === OPEN;
      if (open ? Date.now() - this.heard > WAKE_MS : Date.now() - this.began > STUCK_MS) this.drop();
      else this.raw({ t: "ping" });
      return;
    }
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.retries = 0;
    this.open();
  }

  private raw(msg: object) {
    if (this.socket?.readyState === OPEN) this.socket.send(JSON.stringify(msg));
  }

  // Sends a message to the room; false if not connected right now (nothing
  // is queued - an action taken offline would surprise everyone later).
  send(msg: Exclude<Send, { t: "hello" }>): string | false {
    if (this.status !== "open" || this.socket?.readyState !== OPEN) return false;
    const rid = String(this.nextRid++);
    this.socket.send(JSON.stringify({ ...msg, rid }));
    return rid;
  }

  get connection(): ConnectionStatus {
    return this.status;
  }

  stop() {
    this.stopped = true;
    this.unbeat();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const socket = this.socket;
    this.socket = null;
    socket?.close(1000, "bye");
    this.setStatus("closed");
  }
}

export interface RoomClientEvents {
  onWelcome?: (welcome: Extract<ServerMessage, { t: "welcome" }>) => void;
  onRoom?: (room: RoomView) => void;
  onError?: (code: ErrorCode, message: string, rid?: string) => void;
  onStatus?: (status: ConnectionStatus) => void;
  onGone?: () => void;
}

export interface RoomClientOptions extends HubClientOptions<ServerMessage> {
  onRoom?: (room: RoomView) => void;
}

// A live-scores room.
export class RoomClient extends HubClient<ClientMessage, ServerMessage> {
  room: RoomView | null = null;
  private readonly onRoom?: (room: RoomView) => void;

  constructor(opts: RoomClientOptions) {
    super("rooms", opts);
    this.onRoom = opts.onRoom;
  }

  protected exists(code: string) {
    return roomInfo(code, this.opts.base).then((r) => r !== null);
  }

  protected receive(msg: ServerMessage) {
    if (msg.t !== "room") return;
    // Anything older than what's showing is a straggler.
    if (this.room && msg.room.version < this.room.version) return;
    this.room = msg.room;
    this.onRoom?.(msg.room);
  }
}

// ---- Keeping a game in step with the room ---------------------------------------

// The same game, written down the same way: the server keeps a game as its
// schema reads it (unknown fields dropped, keys in schema order), so a game
// on this phone is put through the schema too before the two are compared.
export function gameKey(game: ScoreGame): string {
  const checked = GameSchema.check(game, "game");
  return stableJson(checked.ok ? checked.value : game);
}

export interface GameSyncIO {
  // Send this game as an update made on `base`: the message's rid, or false
  // if not connected.
  send(base: number, game: ScoreGame): string | false;
  // Someone else's change: show this game from now on.
  adopt(game: ScoreGame): void;
  // A change made here was overtaken by someone else's and is gone (the
  // room's game was adopted instead) - say so, so it can be entered again.
  lost?(): void;
}

// One phone's copy of a room's game, kept in step with it. `local` whenever
// this phone's game changes, `room` with each room view, `refused` when an
// update was turned down. It sends this phone's game when it differs from the
// last one the room confirmed - one update at a time, each made on that
// confirmed version - and adopts every change made elsewhere. When both
// changed at once the room's wins: there's no merging two people's entries
// behind their backs.
export class GameSync {
  private readonly io: GameSyncIO;
  private latest: ScoreGame | null = null;
  // The room's game as last confirmed: its gameVersion and key.
  private confirmed: { version: number; key: string } | null = null;
  // An update on its way: the version it was made on, its game's key, and its rid.
  private inflight: { base: number; key: string; rid: string } | null = null;
  // A game the room couldn't take at all: not sent again till it changes.
  private held: string | null = null;
  private ended = false;

  constructor(io: GameSyncIO) {
    this.io = io;
  }

  local(game: ScoreGame) {
    this.latest = game;
    this.flush();
  }

  room(view: RoomView) {
    this.ended = view.phase === "ended";
    if (!view.game) {
      // Not up yet (the host's first update puts it up).
      this.confirmed = { version: view.gameVersion, key: "" };
      return this.flush();
    }
    const key = gameKey(view.game);
    const inflight = this.inflight;
    if (inflight && view.gameVersion === inflight.base + 1 && key === inflight.key) {
      // Ours, accepted.
      this.inflight = null;
      this.confirmed = { version: view.gameVersion, key };
      return this.flush();
    }
    if (this.confirmed && view.gameVersion === this.confirmed.version) return this.flush(); // nothing new in the game
    const first = this.confirmed === null;
    const localKey = this.latest ? gameKey(this.latest) : null;
    if (localKey === key) {
      // Already showing it (connected to a room with this phone's game).
      this.confirmed = { version: view.gameVersion, key };
      this.inflight = null;
      return this.flush();
    }
    const changedHere = localKey !== null && localKey !== key && (first || localKey !== this.confirmed!.key);
    this.confirmed = { version: view.gameVersion, key };
    this.inflight = null;
    if (changedHere && first && (this.latest!.updatedAt ?? 0) > (view.game.updatedAt ?? 0)) {
      // Just connected, and this phone's game is the newer (changed while
      // offline, nothing changed in the room since): send it.
      return this.flush();
    }
    if (changedHere && !first) this.io.lost?.();
    this.latest = view.game;
    this.io.adopt(view.game);
  }

  // The room turned something down - the update on its way, if `rid` is its
  // (or the error didn't say which: too large, rate limited). Let go of, the
  // next room view settles what's shown; `again` false: a game the room
  // can't take (a bad game, too large), not sent again as it is.
  refused(rid?: string, again = true) {
    const f = this.inflight;
    if (!f || (rid !== undefined && rid !== f.rid)) return;
    this.inflight = null;
    if (!again) this.held = f.key;
  }

  // Send what's waiting, if anything (after being told to slow down).
  retry() {
    this.flush();
  }

  // Connection lost: whatever was in flight may or may not have landed - the
  // next room view after reconnecting says.
  reset() {
    this.inflight = null;
  }

  private flush() {
    if (!this.latest || this.inflight || !this.confirmed || this.ended) return;
    const key = gameKey(this.latest);
    if (key === this.confirmed.key || key === this.held) return;
    const rid = this.io.send(this.confirmed.version, this.latest);
    if (rid !== false) this.inflight = { base: this.confirmed.version, key, rid };
  }
}
