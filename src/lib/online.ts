// The web app's side of the multiplayer server (worker/): making and
// checking rooms, and one live connection to a room that keeps itself up.
//
// Kept on this device (localStorage "mjwaits.online"): the nickname last
// used, and for each room joined its reconnect token - so a reload, a dropped
// signal or a phone that slept puts the player straight back in their seat.
//
// No React here: RoomClient takes callbacks, and the Scores tab's 線上
// panel turns them into state.

import type { ClientMessage } from "@mjwaits/shared/protocol/client";
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
  current: string | null; // the room the 線上 panel had open
}

const EMPTY: OnlineMemory = { name: "", rooms: [], current: null };
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

export const tokenFor = (memory: OnlineMemory, code: string) => memory.rooms.find((r) => r.code === code)?.token;

export const withToken = (memory: OnlineMemory, code: string, token: string): OnlineMemory => ({
  ...memory,
  rooms: [{ code, token, at: Date.now() }, ...memory.rooms.filter((r) => r.code !== code)],
});

export const withoutRoom = (memory: OnlineMemory, code: string): OnlineMemory => ({
  ...memory,
  rooms: memory.rooms.filter((r) => r.code !== code),
  current: memory.current === code ? null : memory.current,
});

// ---- Rooms over HTTP -----------------------------------------------------------

export async function createRoom(base = serverBase(), fetcher: typeof fetch = fetch): Promise<string> {
  const res = await fetcher(`${base}/rooms`, { method: "POST" });
  if (!res.ok) throw new Error(res.status === 403 ? "This page isn't allowed to make rooms" : "Couldn't make a room - try again");
  return ((await res.json()) as { code: string }).code;
}

// Whether a room exists before joining it: its phase and how many are seated,
// or null for a code no one has made (or one that has expired).
export async function roomInfo(code: string, base = serverBase(), fetcher: typeof fetch = fetch): Promise<{ phase: RoomView["phase"]; seated: number } | null> {
  const res = await fetcher(`${base}/rooms/${code}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error("Couldn't reach the server");
  return (await res.json()) as { phase: RoomView["phase"]; seated: number };
}

// ---- The live connection -------------------------------------------------------

export type ConnectionStatus = "connecting" | "open" | "reconnecting" | "closed";

export interface RoomClientEvents {
  onWelcome?: (welcome: Extract<ServerMessage, { t: "welcome" }>) => void;
  onRoom?: (room: RoomView) => void;
  onError?: (code: ErrorCode, message: string, rid?: string) => void;
  onStatus?: (status: ConnectionStatus) => void;
  // The room no longer exists (expired, or never made): the client has stopped.
  onGone?: () => void;
}

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

export interface RoomClientOptions extends RoomClientEvents {
  code: string;
  name: string;
  token?: string;
  base?: string;
  makeSocket?: (url: string) => SocketLike;
  // Waits before each retry, in ms; the last repeats. A little jitter is added.
  backoff?: number[];
  // Asked after a connection fails before it opens: a room that has gone
  // (the server answers its socket with 404, which a browser can't see)
  // would otherwise be retried forever. Defaults to roomInfo.
  roomExists?: (code: string) => Promise<boolean>;
}

const OPEN = 1;
const DEFAULT_BACKOFF = [500, 1000, 2000, 4000, 8000];
// Errors that mean retrying the same way can't work.
const FATAL: ReadonlySet<ErrorCode> = new Set(["version", "nameTaken"]);

export class RoomClient {
  private socket: SocketLike | null = null;
  private status: ConnectionStatus = "connecting";
  private retries = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private nextRid = 1;
  private token: string | undefined;
  private readonly opts: RoomClientOptions;
  room: RoomView | null = null;

  constructor(opts: RoomClientOptions) {
    this.opts = opts;
    this.token = opts.token;
    this.open();
  }

  private setStatus(status: ConnectionStatus) {
    if (status === this.status) return;
    this.status = status;
    this.opts.onStatus?.(status);
  }

  private open() {
    const url = `${wsBase(this.opts.base ?? serverBase())}/rooms/${this.opts.code}/ws`;
    const socket = (this.opts.makeSocket ?? ((u) => new WebSocket(u) as unknown as SocketLike))(url);
    this.socket = socket;
    let opened = false;
    socket.onopen = () => {
      opened = true;
      this.retries = 0;
      this.raw({ t: "hello", v: PROTOCOL_VERSION, name: this.opts.name, ...(this.token ? { token: this.token } : {}) });
    };
    socket.onmessage = (ev) => {
      if (typeof ev.data !== "string") return;
      let msg: ServerMessage;
      try {
        msg = JSON.parse(ev.data) as ServerMessage;
      } catch {
        return;
      }
      this.receive(msg);
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      if (this.stopped) return this.setStatus("closed");
      this.setStatus("reconnecting");
      this.scheduleRetry();
      if (!opened) void this.checkGone();
    };
    socket.onerror = () => {
      // A close always follows; that's where the retry happens.
    };
  }

  private receive(msg: ServerMessage) {
    switch (msg.t) {
      case "welcome":
        this.token = msg.token;
        this.setStatus("open");
        this.opts.onWelcome?.(msg);
        break;
      case "room":
        // Anything older than what's showing is a straggler.
        if (this.room && msg.room.version < this.room.version) return;
        this.room = msg.room;
        this.opts.onRoom?.(msg.room);
        break;
      case "error":
        // A token the room no longer knows: forget it and join afresh.
        if (msg.code === "badToken" && this.token) {
          this.token = undefined;
          this.raw({ t: "hello", v: PROTOCOL_VERSION, name: this.opts.name });
          return;
        }
        if (FATAL.has(msg.code)) {
          this.stop();
        }
        this.opts.onError?.(msg.code, msg.message, msg.rid);
        break;
      case "pong":
        break;
    }
  }

  // A failed handshake: offline, or the room is gone. Only a definite "no
  // such room" stops the retries - a failed check is just more offline.
  private async checkGone() {
    let exists = true;
    try {
      exists = await (this.opts.roomExists ?? (async (code) => (await roomInfo(code, this.opts.base)) !== null))(this.opts.code);
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

  // Try again now - the page came back to the front, or the network did.
  nudge() {
    if (this.stopped || this.socket) return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.retries = 0;
    this.open();
  }

  private raw(msg: ClientMessage) {
    if (this.socket?.readyState === OPEN) this.socket.send(JSON.stringify(msg));
  }

  // Sends a message to the room; false if not connected right now (nothing
  // is queued - an action taken offline would surprise everyone later).
  send(msg: Exclude<ClientMessage, { t: "hello" }>): string | false {
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
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const socket = this.socket;
    this.socket = null;
    socket?.close(1000, "bye");
    this.setStatus("closed");
  }
}
