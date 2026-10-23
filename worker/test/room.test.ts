// Runs in the Workers runtime (see vitest.config.ts): requests go through the
// real Worker into a real Room Durable Object with its own SQLite storage.
// The live game itself - sharing, recording, permissions - is live.test.ts.

import { env, evictDurableObject, runDurableObjectAlarm, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { MAX_MESSAGE_BYTES, PROTOCOL_VERSION, RATE_BURST, ROOM_CODE_PATTERN } from "@mjwaits/shared/protocol/limits";
import { isAllowedOrigin, randomRoomCode } from "../src/index";
import { IDLE_TTL_MS, MAX_CONNECTIONS, UNUSED_TTL_MS, type Room } from "../src/room";
import { BASE, connect, createRoom, join, ORIGIN, sharing } from "./helpers";

describe("the Worker's routes", () => {
  it("answers /health", async () => {
    const res = await SELF.fetch(`${BASE}/health`);
    expect(await res.text()).toBe("ok");
  });

  it("makes rooms only for allowed pages, with CORS for them", async () => {
    for (const origin of [null, "https://evil.example", "https://app.kevinlhc.com.evil.example", "null"]) {
      const res = await SELF.fetch(`${BASE}/rooms`, { method: "POST", headers: origin ? { Origin: origin } : {} });
      expect(res.status, String(origin)).toBe(403);
    }
    const res = await SELF.fetch(`${BASE}/rooms`, { method: "POST", headers: { Origin: "https://app.kevinlhc.com" } });
    expect(res.status).toBe(201);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://app.kevinlhc.com");
    expect(((await res.json()) as { code: string }).code).toMatch(ROOM_CODE_PATTERN);
    expect((await SELF.fetch(`${BASE}/rooms`, { headers: { Origin: ORIGIN } })).status).toBe(405);
  });

  it("says whether a room exists, for the join form", async () => {
    const code = await createRoom();
    const res = await SELF.fetch(`${BASE}/rooms/${code.toLowerCase()}`, { headers: { Origin: ORIGIN } });
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
    expect(await res.json()).toEqual({ code, phase: "waiting", players: [] });
    let unused = randomRoomCode();
    while (unused === code) unused = randomRoomCode();
    expect((await SELF.fetch(`${BASE}/rooms/${unused}`, { headers: { Origin: ORIGIN } })).status).toBe(404);
    expect((await SELF.fetch(`${BASE}/rooms/nope!`, { headers: { Origin: ORIGIN } })).status).toBe(404);
    expect((await SELF.fetch(`${BASE}/rooms/${code}`, { headers: { Origin: "https://evil.example" } })).status).toBe(403);
  });

  it("refuses a WebSocket from another site, a non-upgrade, and unknown rooms", async () => {
    const code = await createRoom();
    expect((await SELF.fetch(`${BASE}/rooms/${code}/ws`, { headers: { Upgrade: "websocket", Origin: "https://evil.example" } })).status).toBe(403);
    expect((await SELF.fetch(`${BASE}/rooms/${code}/ws`, { headers: { Origin: ORIGIN } })).status).toBe(426);
    expect((await SELF.fetch(`${BASE}/rooms/0OIL1/ws`, { headers: { Upgrade: "websocket", Origin: ORIGIN } })).status).toBe(404);
    // A well-formed code no one made.
    let unused = randomRoomCode();
    while (unused === code) unused = randomRoomCode();
    expect((await SELF.fetch(`${BASE}/rooms/${unused}/ws`, { headers: { Upgrade: "websocket", Origin: ORIGIN } })).status).toBe(404);
    // Codes are case-insensitive.
    const c = await connect(code.toLowerCase());
    c.send({ t: "ping" });
    await c.next("pong");
  });

  it("allows localhost on any port and only the listed sites", () => {
    const listed = "https://app.kevinlhc.com, https://staging.kevinlhc.com";
    expect(isAllowedOrigin("http://localhost:5173", listed)).toBe(true);
    expect(isAllowedOrigin("http://127.0.0.1:4173", listed)).toBe(true);
    expect(isAllowedOrigin("http://[::1]:5173", listed)).toBe(true);
    expect(isAllowedOrigin("https://staging.kevinlhc.com", listed)).toBe(true);
    expect(isAllowedOrigin("https://app.kevinlhc.com/mjwaits", listed)).toBe(false);
    expect(isAllowedOrigin("http://app.kevinlhc.com", listed)).toBe(false);
    expect(isAllowedOrigin("https://localhost.evil.example", listed)).toBe(false);
    expect(isAllowedOrigin("file://localhost", listed)).toBe(false);
    expect(isAllowedOrigin(env.ALLOWED_ORIGINS, env.ALLOWED_ORIGINS)).toBe(true);
  });

  it("makes codes from the alphabet, evenly", () => {
    const counts = new Map<string, number>();
    for (let i = 0; i < 2000; i++) {
      const code = randomRoomCode();
      expect(code).toMatch(ROOM_CODE_PATTERN);
      for (const ch of code) counts.set(ch, (counts.get(ch) ?? 0) + 1);
    }
    // 10,000 characters over 25 symbols: 400 each on average.
    for (const n of counts.values()) expect(n).toBeGreaterThan(300);
  });
});

describe("joining", () => {
  it("welcomes the first person as host, with an id and a reconnect token", async () => {
    const code = await createRoom();
    const { welcome, room } = await join(code, "  陳大文 ");
    expect(welcome).toMatchObject({ v: PROTOCOL_VERSION, name: "陳大文", host: true });
    expect(welcome.id).toMatch(/^[0-9a-f]{16}$/);
    expect(welcome.token).toMatch(/^[0-9a-f]{32}$/);
    expect(room).toMatchObject({ code, phase: "waiting", game: null, gameVersion: 0, colors: {} });
    expect(room.people).toEqual([{ id: welcome.id, name: "陳大文", connected: true, host: true, canRecord: true }]);
  });

  it("lists everyone who joins, watching until the host says otherwise", async () => {
    const { code, host } = await sharing();
    const amy = await join(code, "Amy");
    expect(amy.welcome.host).toBe(false);
    expect(amy.room.game?.seats).toEqual(["Amy", "Ben", "陳大文", "Dee"]);
    const view = await host.c.room((v) => v.people.length === 2);
    expect(view.people[1]).toEqual({ id: amy.welcome.id, name: "Amy", connected: true, host: false, canRecord: false });
  });

  it("needs a hello first, the right version, and a usable, unique nickname", async () => {
    const code = await createRoom();
    const c = await connect(code);
    c.send({ t: "stop", rid: "r1" });
    expect(await c.error()).toMatchObject({ code: "notJoined", rid: "r1" });
    c.send({ t: "hello", v: PROTOCOL_VERSION - 1, name: "A" });
    expect(await c.error()).toMatchObject({ code: "version" });
    c.send({ t: "hello", v: PROTOCOL_VERSION, name: "<>" });
    expect(await c.error()).toMatchObject({ code: "badMessage" });
    await join(code, "Kevin");
    c.send({ t: "hello", v: PROTOCOL_VERSION, name: "KEVIN" });
    expect(await c.error()).toMatchObject({ code: "nameTaken" });
    c.send({ t: "hello", v: PROTOCOL_VERSION, name: "Ｋｅｖｉｎ" }); // full-width
    expect(await c.error()).toMatchObject({ code: "nameTaken" });
  });

  it("answers bad frames with an error and carries on", async () => {
    const { c } = await join(await createRoom(), "A");
    c.send("{not json");
    expect(await c.error()).toMatchObject({ code: "badMessage", message: "message: not JSON" });
    c.send({ t: "setRecorder", person: "nope", allow: true });
    expect(await c.error()).toMatchObject({ code: "badMessage" });
    c.send(JSON.stringify({ t: "ping", rid: "x", pad: "x".repeat(MAX_MESSAGE_BYTES) }));
    expect(await c.error()).toMatchObject({ code: "tooLarge" });
    c.send({ t: "hello", v: PROTOCOL_VERSION, name: "B" });
    expect(await c.error()).toMatchObject({ code: "badMessage", message: "already joined" });
    c.send({ t: "ping", rid: "still here" });
    expect(await c.next("pong")).toEqual({ t: "pong", rid: "still here" });
  });
});

describe("reconnecting", () => {
  it("shows a dropped person as away and knows them again by their token", async () => {
    const { code, host } = await sharing();
    const amy = await join(code, "Amy");
    await host.c.room((v) => v.people.length === 2);
    await amy.c.closeAndWait();
    expect((await host.c.room((v) => v.people[1]?.connected === false)).people[1]).toMatchObject({ name: "Amy", connected: false });

    // Back, with a different name typed - the name stays.
    const again = await join(code, "Someone else", amy.welcome.token);
    expect(again.welcome).toMatchObject({ id: amy.welcome.id, token: amy.welcome.token, name: "Amy", host: false });
    expect(again.room.game).not.toBeNull();
    expect((await host.c.room((v) => v.people[1]?.connected === true)).people[1]).toMatchObject({ name: "Amy", connected: true });
  });

  it("keeps the host the host after a reconnect", async () => {
    const { code, host } = await sharing();
    await host.c.closeAndWait();
    const back = await join(code, "x", host.welcome.token);
    expect(back.welcome.host).toBe(true);
    back.c.send({ t: "stop" });
    expect((await back.c.room((v) => v.phase === "ended")).phase).toBe("ended");
  });

  it("refuses a token the room doesn't know", async () => {
    const code = await createRoom();
    const c = await connect(code);
    c.send({ t: "hello", v: PROTOCOL_VERSION, name: "A", token: "0".repeat(32) });
    expect(await c.error()).toMatchObject({ code: "badToken" });
    const other = await join(await createRoom(), "A");
    c.send({ t: "hello", v: PROTOCOL_VERSION, name: "A", token: other.welcome.token });
    expect(await c.error()).toMatchObject({ code: "badToken" });
  });
});

describe("rooms from before live sharing", () => {
  it("are cleared when they wake: their scoreboard can't be read as a live game", async () => {
    const code = await createRoom();
    const stub = env.ROOMS.getByName(code);
    // Make it look like a protocol-1 room: no schema mark.
    await runInDurableObject(stub, (_room: Room, state) => {
      state.storage.sql.exec("DELETE FROM meta WHERE key = 'schema'");
    });
    await evictDurableObject(stub);
    expect((await SELF.fetch(`${BASE}/rooms/${code}`, { headers: { Origin: ORIGIN } })).status).toBe(404);
  });
});

describe("limits", () => {
  it("rate-limits a connection that floods, then closes it", async () => {
    const { c } = await join(await createRoom(), "A");
    for (let i = 0; i < RATE_BURST + 5; i++) c.send({ t: "ping" });
    expect(await c.error()).toMatchObject({ code: "rateLimited" });
    for (let i = 0; i < 40; i++) c.send({ t: "ping" });
    await expect.poll(() => c.closed, { timeout: 2000 }).toBe(true);
  });

  it("caps connections per room", async () => {
    const code = await createRoom();
    const open = [];
    for (let i = 0; i < MAX_CONNECTIONS; i++) open.push(await connect(code));
    const res = await SELF.fetch(`${BASE}/rooms/${code}/ws`, { headers: { Upgrade: "websocket", Origin: ORIGIN } });
    expect(res.status).toBe(503);
  });
});

describe("expiry", () => {
  const stubFor = (code: string) => env.ROOMS.getByName(code);
  const backdate = (code: string, ms: number) =>
    runInDurableObject(stubFor(code), (_room: Room, state) => {
      state.storage.sql.exec("UPDATE meta SET value = json_set(value, '$.updated', ?) WHERE key = 'clock'", Date.now() - ms);
    });

  it("sets an alarm when a room is made", async () => {
    const code = await createRoom();
    const alarm = await runInDurableObject(stubFor(code), (_room: Room, state) => state.storage.getAlarm());
    expect(alarm).toBeGreaterThan(Date.now() + UNUSED_TTL_MS - 60_000);
  });

  it("removes a room no one joined after an hour", async () => {
    const code = await createRoom();
    await backdate(code, UNUSED_TTL_MS + 1000);
    expect(await runDurableObjectAlarm(stubFor(code))).toBe(true);
    expect((await SELF.fetch(`${BASE}/rooms/${code}/ws`, { headers: { Upgrade: "websocket", Origin: ORIGIN } })).status).toBe(404);
    // Its code can be made again, as a new room.
    expect(await stubFor(code).create(code)).toBe(true);
  });

  it("keeps a joined room until two idle days have passed, and never while anyone is connected", async () => {
    const code = await createRoom();
    const a = await join(code, "A");
    await backdate(code, IDLE_TTL_MS + 1000);
    expect(await runDurableObjectAlarm(stubFor(code))).toBe(true);
    a.c.send({ t: "ping" });
    await a.c.next("pong"); // still there: someone is connected

    await a.c.closeAndWait();
    await expect.poll(() => runInDurableObject(stubFor(code), (_r: Room, state) => state.getWebSockets().length), { timeout: 2000 }).toBe(0);
    await backdate(code, UNUSED_TTL_MS + 1000); // idle an hour: not long enough once joined
    await runDurableObjectAlarm(stubFor(code));
    expect(await runInDurableObject(stubFor(code), (_r: Room, state) => state.storage.sql.exec("SELECT COUNT(*) AS n FROM people").one().n)).toBe(1);

    await backdate(code, IDLE_TTL_MS + 1000);
    await runDurableObjectAlarm(stubFor(code));
    expect((await SELF.fetch(`${BASE}/rooms/${code}/ws`, { headers: { Upgrade: "websocket", Origin: ORIGIN } })).status).toBe(404);
  });
});
