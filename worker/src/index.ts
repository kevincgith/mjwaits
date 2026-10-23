// The Worker's front door. It answers these and hands everything else to
// the room's Durable Object:
//
//   POST /rooms               make a live-scores room; answers {"code": "3AC9X"}
//   GET  /rooms/:code         is there such a room: {"phase": "live", "players": [...]}, or 404
//   GET  /rooms/:code/ws      the room's WebSocket (Upgrade: websocket)
//   POST /tables, GET /tables/:code, GET /tables/:code/ws
//                             the same for an online table ({"phase": "lobby", "seats": [...]})
//   GET  /tables/:code/scores the table's hands as a Scores-tab game (ScoreGame), or 404
//   GET  /health              "ok"
//
// The room routes check the page's Origin first: only the sites in
// ALLOWED_ORIGINS, and localhost, may use them.

import { normalizeRoomCode, ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH } from "@mjwaits/shared/protocol/limits";
import { Room } from "./room";
import { Table } from "./table";

export { Room, Table };

export interface Env {
  ROOMS: DurableObjectNamespace<Room>;
  TABLES: DurableObjectNamespace<Table>;
  ALLOWED_ORIGINS: string;
  TABLE_PAUSE_MS?: string; // how long a bot's move waits (tests: 0)
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function isAllowedOrigin(origin: string | null, allowed: string): boolean {
  if (!origin) return false;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.origin !== origin) return false; // a path, credentials or anything else tacked on
  if ((url.protocol === "http:" || url.protocol === "https:") && LOCAL_HOSTS.has(url.hostname)) return true;
  return allowed
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .includes(origin);
}

// A fresh room code: uniform over the alphabet (25 symbols, so reject bytes
// past the last whole multiple of 25 rather than skew towards the first few).
export function randomRoomCode(): string {
  const n = ROOM_CODE_ALPHABET.length;
  const limit = 256 - (256 % n);
  let code = "";
  while (code.length < ROOM_CODE_LENGTH) {
    for (const b of crypto.getRandomValues(new Uint8Array(16))) {
      if (b < limit && code.length < ROOM_CODE_LENGTH) code += ROOM_CODE_ALPHABET[b % n];
    }
  }
  return code;
}

const cors = (origin: string) => ({ "Access-Control-Allow-Origin": origin, Vary: "Origin" });

function json(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}

// Codes are random, so a clash with a live room is rare; a few tries make
// failing to find a free one practically impossible.
const CREATE_TRIES = 5;

// The two kinds of room, by their path. (Both are hubs: create, info, fetch.)
type Stub = { create(code: string): Promise<boolean>; info(): Promise<object | null>; fetch(request: Request): Promise<Response> };
function stubFor(env: Env, kind: string, code: string): Stub {
  return (kind === "tables" ? env.TABLES.getByName(code) : env.ROOMS.getByName(code)) as unknown as Stub;
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin");

    if (url.pathname === "/health") return new Response("ok");

    const make = url.pathname.match(/^\/(rooms|tables)$/);
    if (make) {
      if (!isAllowedOrigin(origin, env.ALLOWED_ORIGINS)) return json({ error: "origin not allowed" }, 403);
      if (request.method === "OPTIONS")
        return new Response(null, { status: 204, headers: { ...cors(origin!), "Access-Control-Allow-Methods": "POST", "Access-Control-Max-Age": "86400" } });
      if (request.method !== "POST") return json({ error: "method not allowed" }, 405, { Allow: "POST", ...cors(origin!) });
      for (let i = 0; i < CREATE_TRIES; i++) {
        const code = randomRoomCode();
        if (await stubFor(env, make[1], code).create(code)) return json({ code }, 201, cors(origin!));
      }
      return json({ error: "no free room code, try again" }, 503, cors(origin!));
    }

    const info = url.pathname.match(/^\/(rooms|tables)\/([^/]+)$/);
    if (info) {
      if (!isAllowedOrigin(origin, env.ALLOWED_ORIGINS)) return json({ error: "origin not allowed" }, 403);
      if (request.method !== "GET") return json({ error: "method not allowed" }, 405, { Allow: "GET", ...cors(origin!) });
      const code = normalizeRoomCode(info[2]);
      const room = code ? await stubFor(env, info[1], code).info() : null;
      return room ? json({ code, ...room }, 200, cors(origin!)) : json({ error: "no such room" }, 404, cors(origin!));
    }

    const scores = url.pathname.match(/^\/tables\/([^/]+)\/scores$/);
    if (scores) {
      if (!isAllowedOrigin(origin, env.ALLOWED_ORIGINS)) return json({ error: "origin not allowed" }, 403);
      if (request.method !== "GET") return json({ error: "method not allowed" }, 405, { Allow: "GET", ...cors(origin!) });
      const code = normalizeRoomCode(scores[1]);
      const game = code ? await env.TABLES.getByName(code).scores() : null;
      return game ? json(game, 200, cors(origin!)) : json({ error: "no record yet" }, 404, cors(origin!));
    }

    const ws = url.pathname.match(/^\/(rooms|tables)\/([^/]+)\/ws$/);
    if (ws) {
      if (!isAllowedOrigin(origin, env.ALLOWED_ORIGINS)) return new Response("origin not allowed", { status: 403 });
      if (request.method !== "GET" || request.headers.get("Upgrade")?.toLowerCase() !== "websocket")
        return new Response("expected a WebSocket upgrade", { status: 426, headers: { Upgrade: "websocket" } });
      const code = normalizeRoomCode(ws[2]);
      if (!code) return new Response("no such room", { status: 404 });
      return stubFor(env, ws[1], code).fetch(request);
    }

    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
