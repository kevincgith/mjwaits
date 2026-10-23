// The Worker's front door. It answers these and hands everything else to
// the room's Durable Object:
//
//   POST /rooms               make a room; answers {"code": "3AC9X"}
//   GET  /rooms/:code         is there such a room: {"phase": "live", "players": [...]}, or 404
//   GET  /rooms/:code/ws      the room's WebSocket (Upgrade: websocket)
//   GET  /health              "ok"
//
// The room routes check the page's Origin first: only the sites in
// ALLOWED_ORIGINS, and localhost, may use them.

import { normalizeRoomCode, ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH } from "@mjwaits/shared/protocol/limits";
import { Room } from "./room";

export { Room };

export interface Env {
  ROOMS: DurableObjectNamespace<Room>;
  ALLOWED_ORIGINS: string;
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

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin");

    if (url.pathname === "/health") return new Response("ok");

    if (url.pathname === "/rooms") {
      if (!isAllowedOrigin(origin, env.ALLOWED_ORIGINS)) return json({ error: "origin not allowed" }, 403);
      if (request.method === "OPTIONS")
        return new Response(null, { status: 204, headers: { ...cors(origin!), "Access-Control-Allow-Methods": "POST", "Access-Control-Max-Age": "86400" } });
      if (request.method !== "POST") return json({ error: "method not allowed" }, 405, { Allow: "POST", ...cors(origin!) });
      for (let i = 0; i < CREATE_TRIES; i++) {
        const code = randomRoomCode();
        if (await env.ROOMS.getByName(code).create(code)) return json({ code }, 201, cors(origin!));
      }
      return json({ error: "no free room code, try again" }, 503, cors(origin!));
    }

    const info = url.pathname.match(/^\/rooms\/([^/]+)$/);
    if (info) {
      if (!isAllowedOrigin(origin, env.ALLOWED_ORIGINS)) return json({ error: "origin not allowed" }, 403);
      if (request.method !== "GET") return json({ error: "method not allowed" }, 405, { Allow: "GET", ...cors(origin!) });
      const code = normalizeRoomCode(info[1]);
      const room = code ? await env.ROOMS.getByName(code).info() : null;
      return room ? json({ code, ...room }, 200, cors(origin!)) : json({ error: "no such room" }, 404, cors(origin!));
    }

    const ws = url.pathname.match(/^\/rooms\/([^/]+)\/ws$/);
    if (ws) {
      if (!isAllowedOrigin(origin, env.ALLOWED_ORIGINS)) return new Response("origin not allowed", { status: 403 });
      if (request.method !== "GET" || request.headers.get("Upgrade")?.toLowerCase() !== "websocket")
        return new Response("expected a WebSocket upgrade", { status: 426, headers: { Upgrade: "websocket" } });
      const code = normalizeRoomCode(ws[1]);
      if (!code) return new Response("no such room", { status: 404 });
      return env.ROOMS.getByName(code).fetch(request);
    }

    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
