// Test helpers: make rooms, and talk to them like the web app would.

import { SELF } from "cloudflare:test";
import { expect } from "vitest";
import { PROTOCOL_VERSION } from "@mjwaits/shared/protocol/limits";
import type { RoomView, ServerMessage } from "@mjwaits/shared/protocol/server";

export const ORIGIN = "http://localhost:5173";
export const BASE = "https://mp.test";

export async function createRoom(origin = ORIGIN): Promise<string> {
  const res = await SELF.fetch(`${BASE}/rooms`, { method: "POST", headers: { Origin: origin } });
  expect(res.status).toBe(201);
  return ((await res.json()) as { code: string }).code;
}

// A test client: collects what the room sends, and waits for the next
// message (of a type, if given).
export class Client {
  private inbox: ServerMessage[] = [];
  private waiting: (() => void) | null = null;
  closed = false;
  readonly ws: WebSocket;

  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener("message", (e) => {
      this.inbox.push(JSON.parse(e.data as string) as ServerMessage);
      this.waiting?.();
    });
    ws.addEventListener("close", () => {
      this.closed = true;
      this.waiting?.();
    });
    ws.accept();
  }

  send(msg: unknown) {
    this.ws.send(typeof msg === "string" ? msg : JSON.stringify(msg));
  }

  async next<T extends ServerMessage["t"]>(t?: T): Promise<Extract<ServerMessage, { t: T }>> {
    const deadline = Date.now() + 2000;
    for (;;) {
      const i = this.inbox.findIndex((m) => !t || m.t === t);
      if (i >= 0) return this.inbox.splice(i, 1)[0] as Extract<ServerMessage, { t: T }>;
      if (this.closed) throw new Error(`closed while waiting for ${t ?? "a message"}`);
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`no ${t ?? "message"} - got ${JSON.stringify(this.inbox)}`);
      await new Promise<void>((resolve) => {
        this.waiting = resolve;
        setTimeout(resolve, left);
      });
    }
  }

  // The first room view that passes `until`, skipping the ones before it
  // (with no test, the next one).
  async room(until: (view: RoomView) => boolean = () => true): Promise<RoomView> {
    for (;;) {
      const { room } = await this.next("room");
      if (until(room)) return room;
    }
  }

  async error() {
    return this.next("error");
  }

  async closeAndWait() {
    this.ws.close(1000, "bye");
  }
}

export async function connect(code: string, origin = ORIGIN): Promise<Client> {
  const res = await SELF.fetch(`${BASE}/rooms/${code}/ws`, { headers: { Upgrade: "websocket", Origin: origin } });
  expect(res.status).toBe(101);
  return new Client(res.webSocket!);
}

export async function join(code: string, name: string, token?: string) {
  const c = await connect(code);
  c.send({ t: "hello", v: PROTOCOL_VERSION, name, ...(token ? { token } : {}) });
  const welcome = await c.next("welcome");
  const room = await c.room();
  return { c, welcome, room };
}

// A room with four seated players; `a` is the host.
export async function fullTable() {
  const code = await createRoom();
  const players = [];
  for (const [i, name] of ["A", "B", "C", "D"].entries()) {
    const p = await join(code, name);
    p.c.send({ t: "sit", seat: i });
    await p.c.room((v) => v.seats[i]?.name === name);
    players.push(p);
  }
  return { code, players };
}
