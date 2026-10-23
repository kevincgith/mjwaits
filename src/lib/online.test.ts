import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROTOCOL_VERSION } from "@mjwaits/shared/protocol/limits";
import type { RoomView, ServerMessage } from "@mjwaits/shared/protocol/server";
import { withEvent, type ScoreGame } from "@mjwaits/shared/engine/ledger";
import { sampleGame } from "@mjwaits/shared/protocol/sampleGame";
import { createRoom, gameKey, GameSync, loadOnline, ONLINE_KEY, RoomClient, roomFromSearch, roomInfo, saveOnline, tokenFor, withoutRoom, withToken, type SocketLike } from "./online";

// A WebSocket stand-in the test drives by hand.
class FakeSocket implements SocketLike {
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  closed = false;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  readonly url: string;
  constructor(url: string) {
    this.url = url;
  }
  send(data: string) {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close() {
    this.closed = true;
    this.readyState = 3;
  }
  // Test side:
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  deliver(msg: ServerMessage) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  drop() {
    this.readyState = 3;
    this.onclose?.({});
  }
}

const view = (version: number, game: ScoreGame | null = null, gameVersion = 0, phase: RoomView["phase"] = game ? "live" : "waiting"): RoomView => ({
  code: "3AC9X",
  version,
  phase,
  people: [],
  game: game && JSON.parse(JSON.stringify(game)),
  gameVersion,
  colors: {},
  authors: [],
  changes: [],
});

function client(extra: Partial<ConstructorParameters<typeof RoomClient>[0]> = {}) {
  const sockets: FakeSocket[] = [];
  const events = { welcome: [] as [string, string, string][], rooms: [] as RoomView[], errors: [] as string[], status: [] as string[] };
  const c = new RoomClient({
    code: "3AC9X",
    name: "Kevin",
    base: "https://mj-api.example",
    backoff: [100, 200],
    makeSocket: (url) => {
      const s = new FakeSocket(url);
      sockets.push(s);
      return s;
    },
    onWelcome: (w) => events.welcome.push([w.id, w.token, w.name]),
    onRoom: (room) => events.rooms.push(room),
    onError: (code) => events.errors.push(code),
    onStatus: (s) => events.status.push(s),
    ...extra,
  });
  return { c, sockets, events };
}

const TOKEN = "0123456789abcdef0123456789abcdef";

describe("RoomClient", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("says hello on the room's WebSocket and reports what comes back", () => {
    const { c, sockets, events } = client();
    expect(sockets[0].url).toBe("wss://mj-api.example/rooms/3AC9X/ws");
    sockets[0].open();
    expect(sockets[0].sent).toEqual([{ t: "hello", v: PROTOCOL_VERSION, name: "Kevin" }]);
    sockets[0].deliver({ t: "welcome", v: PROTOCOL_VERSION, token: TOKEN, id: "0123456789abcdef", name: "Kevin", host: true });
    sockets[0].deliver({ t: "room", room: view(3) });
    expect(events.welcome).toEqual([["0123456789abcdef", TOKEN, "Kevin"]]);
    expect(events.status).toEqual(["open"]);
    expect(c.room?.version).toBe(3);
  });

  it("sends only while connected, tagging each message", () => {
    const { c, sockets } = client();
    expect(c.send({ t: "stop" })).toBe(false);
    sockets[0].open();
    expect(c.send({ t: "stop" })).toBe(false); // not welcomed yet
    sockets[0].deliver({ t: "welcome", v: PROTOCOL_VERSION, token: TOKEN, id: "0123456789abcdef", name: "Kevin", host: true });
    expect(c.send({ t: "stop" })).toBe("1");
    expect(c.send({ t: "ping" })).toBe("2");
    expect(sockets[0].sent.slice(1)).toEqual([
      { t: "stop", rid: "1" },
      { t: "ping", rid: "2" },
    ]);
  });

  it("ignores a room older than the one it has", () => {
    const { sockets, events } = client();
    sockets[0].open();
    sockets[0].deliver({ t: "room", room: view(5) });
    sockets[0].deliver({ t: "room", room: view(4) });
    sockets[0].deliver({ t: "room", room: view(6) });
    expect(events.rooms.map((r) => r.version)).toEqual([5, 6]);
  });

  it("reconnects after a drop, backing off, and comes back with its token", () => {
    const { sockets, events } = client();
    sockets[0].open();
    sockets[0].deliver({ t: "welcome", v: PROTOCOL_VERSION, token: TOKEN, id: "0123456789abcdef", name: "Kevin", host: false });
    sockets[0].drop();
    expect(events.status).toEqual(["open", "reconnecting"]);
    vi.advanceTimersByTime(90);
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(40); // 100ms + up to 20% jitter
    expect(sockets).toHaveLength(2);
    sockets[1].drop(); // failed before opening: waits longer
    vi.advanceTimersByTime(150);
    expect(sockets).toHaveLength(2);
    vi.advanceTimersByTime(100);
    expect(sockets).toHaveLength(3);
    sockets[2].open();
    expect(sockets[2].sent[0]).toEqual({ t: "hello", v: PROTOCOL_VERSION, name: "Kevin", token: TOKEN });
    sockets[2].deliver({ t: "welcome", v: PROTOCOL_VERSION, token: TOKEN, id: "0123456789abcdef", name: "Kevin", host: false });
    expect(events.status.at(-1)).toBe("open");
  });

  it("retries at once when nudged", () => {
    const { c, sockets } = client();
    sockets[0].open();
    sockets[0].drop();
    c.nudge();
    expect(sockets).toHaveLength(2);
    c.nudge(); // already trying
    expect(sockets).toHaveLength(2);
  });

  it("joins afresh when the room no longer knows its token", () => {
    const { sockets, events } = client({ token: TOKEN });
    sockets[0].open();
    expect(sockets[0].sent[0]).toMatchObject({ token: TOKEN });
    sockets[0].deliver({ t: "error", code: "badToken", message: "unknown" });
    expect(sockets[0].sent[1]).toEqual({ t: "hello", v: PROTOCOL_VERSION, name: "Kevin" });
    expect(events.errors).toEqual([]);
  });

  it("stops for good on an error retrying can't fix", () => {
    const { sockets, events } = client();
    sockets[0].open();
    sockets[0].deliver({ t: "error", code: "nameTaken", message: "taken" });
    expect(events.errors).toEqual(["nameTaken"]);
    expect(events.status.at(-1)).toBe("closed");
    expect(sockets[0].closed).toBe(true);
    vi.advanceTimersByTime(10_000);
    expect(sockets).toHaveLength(1);
  });

  it("stops, and says so, when a failed connection turns out to be a room that's gone", async () => {
    let exists = true;
    let gone = 0;
    const { sockets, events } = client({ roomExists: async () => exists, onGone: () => gone++ });
    sockets[0].drop(); // failed before opening, but the room is there: keep trying
    await vi.advanceTimersByTimeAsync(0);
    expect(gone).toBe(0);
    await vi.advanceTimersByTimeAsync(150);
    expect(sockets).toHaveLength(2);
    exists = false;
    sockets[1].drop();
    await vi.advanceTimersByTimeAsync(0);
    expect(gone).toBe(1);
    expect(events.status.at(-1)).toBe("closed");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sockets).toHaveLength(2);
  });

  it("keeps trying when it can't tell whether the room is there", async () => {
    let gone = 0;
    const { sockets } = client({
      roomExists: async () => {
        throw new Error("offline");
      },
      onGone: () => gone++,
    });
    sockets[0].drop();
    await vi.advanceTimersByTimeAsync(150);
    expect(gone).toBe(0);
    expect(sockets).toHaveLength(2);
  });

  it("doesn't ask about the room after a drop from an open connection", async () => {
    let asked = 0;
    const { sockets } = client({
      roomExists: async () => {
        asked++;
        return true;
      },
    });
    sockets[0].open();
    sockets[0].drop();
    await vi.advanceTimersByTimeAsync(0);
    expect(asked).toBe(0);
  });

  it("stays closed once stopped", () => {
    const { c, sockets } = client();
    sockets[0].open();
    c.stop();
    sockets[0].drop();
    vi.advanceTimersByTime(10_000);
    expect(sockets).toHaveLength(1);
    expect(c.connection).toBe("closed");
  });
});

describe("rooms over HTTP", () => {
  it("makes a room and checks one", async () => {
    const calls: [string, RequestInit | undefined][] = [];
    const fetcher = (async (url: string, init?: RequestInit) => {
      calls.push([url, init]);
      if (url.endsWith("/rooms")) return new Response(JSON.stringify({ code: "3AC9X" }), { status: 201 });
      if (url.endsWith("/3AC9X")) return new Response(JSON.stringify({ code: "3AC9X", phase: "live", players: ["A", "B", "C", "D"] }));
      return new Response("{}", { status: 404 });
    }) as typeof fetch;
    expect(await createRoom("https://x", fetcher)).toBe("3AC9X");
    expect(calls[0]).toEqual(["https://x/rooms", { method: "POST" }]);
    expect(await roomInfo("3AC9X", "https://x", fetcher)).toMatchObject({ phase: "live", players: ["A", "B", "C", "D"] });
    expect(await roomInfo("4AC9X", "https://x", fetcher)).toBeNull();
  });
});

describe("this device's memory", () => {
  it("round-trips, remembers tokens per room and forgets old rooms", () => {
    const mem = new Map<string, string>();
    const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
    expect(loadOnline(storage)).toEqual({ name: "", rooms: [], current: null, sharing: null });
    let m = withToken({ name: "Kevin", rooms: [], current: "3AC9X", sharing: { code: "3AC9X", gameId: "g1" } }, "3AC9X", TOKEN);
    m = withToken(m, "4AC9X", "f".repeat(32));
    saveOnline(m, storage);
    const back = loadOnline(storage);
    expect(back.rooms.map((r) => r.code)).toEqual(["4AC9X", "3AC9X"]);
    expect(tokenFor(back, "3AC9X")).toBe(TOKEN);
    expect(back.sharing).toEqual({ code: "3AC9X", gameId: "g1" });
    expect(withoutRoom(back, "3AC9X")).toMatchObject({ current: null, sharing: null, rooms: [{ code: "4AC9X" }] });

    const stale = { ...back, rooms: [{ code: "9AC9X", token: TOKEN, at: Date.now() - 8 * 24 * 60 * 60 * 1000 }] };
    mem.set(ONLINE_KEY, JSON.stringify(stale));
    expect(loadOnline(storage).rooms).toEqual([]);
    mem.set(ONLINE_KEY, "{oops");
    expect(loadOnline(storage)).toEqual({ name: "", rooms: [], current: null, sharing: null });
  });

  it("reads a room code from a link", () => {
    expect(roomFromSearch("?room=3ac9x")).toBe("3AC9X");
    expect(roomFromSearch("?room=nope")).toBeNull();
    expect(roomFromSearch("?h=abc")).toBeNull();
  });
});

describe("GameSync", () => {
  const draw = (g: ScoreGame, at = 1): ScoreGame => ({ ...withEvent(g, { t: "draw", at }), updatedAt: at });
  function sync() {
    const sent: { base: number; game: ScoreGame }[] = [];
    const adopted: ScoreGame[] = [];
    let lost = 0;
    let online = true;
    const s = new GameSync({
      send: (base, game) => online && sent.push({ base, game }) > 0,
      adopt: (g) => adopted.push(g),
      lost: () => lost++,
    });
    return { s, sent, adopted, lost: () => lost, offline: (v: boolean) => (online = !v) };
  }

  it("puts the host's game up when the room is empty, then sends each change made on the confirmed one", () => {
    const { s, sent } = sync();
    const g = sampleGame();
    s.local(g);
    expect(sent).toEqual([]); // nothing until the room is known
    s.room(view(1)); // waiting, gameVersion 0
    expect(sent).toEqual([{ base: 0, game: g }]);
    s.room(view(2, g, 1)); // ours landed
    const g2 = draw(g, 2);
    s.local(g2);
    expect(sent.at(-1)).toEqual({ base: 1, game: g2 });
  });

  it("sends one update at a time, then whatever changed meanwhile", () => {
    const { s, sent } = sync();
    const g = sampleGame();
    s.local(g);
    s.room(view(1, g, 1));
    const g2 = draw(g, 2);
    const g3 = draw(g2, 3);
    s.local(g2);
    s.local(g3); // while g2 is in flight
    expect(sent).toHaveLength(1);
    s.room(view(2, g2, 2)); // g2 landed
    expect(sent.at(-1)).toEqual({ base: 2, game: g3 });
  });

  it("adopts a change made elsewhere, and sends nothing back for it", () => {
    const { s, sent, adopted, lost } = sync();
    const g = sampleGame();
    s.local(g);
    s.room(view(1, g, 1));
    const theirs = draw(g, 5);
    s.room(view(2, theirs, 2));
    expect(adopted.map(gameKey)).toEqual([gameKey(theirs)]);
    s.local(adopted[0]); // the page shows it
    expect(sent).toEqual([]);
    expect(lost()).toBe(0);
  });

  it("when two changes collide, keeps the room's and says this phone's was lost", () => {
    const { s, sent, adopted, lost } = sync();
    const g = sampleGame();
    s.local(g);
    s.room(view(1, g, 1));
    const mine = draw(g, 2);
    const theirs = { ...withEvent(g, { t: "bonus", at: 3, seat: 0, kind: "獎", amount: 5 }), updatedAt: 3 };
    s.local(mine);
    expect(sent).toHaveLength(1);
    s.room(view(2, theirs, 2)); // theirs landed first
    s.refused(); // and ours was refused as a conflict
    expect(adopted.map(gameKey)).toEqual([gameKey(theirs)]);
    expect(lost()).toBe(1);
    s.local(adopted[0]);
    expect(sent).toHaveLength(1); // nothing more to send
  });

  it("ignores room views that don't change the game", () => {
    const { s, sent, adopted } = sync();
    const g = sampleGame();
    s.local(g);
    s.room(view(1, g, 1));
    s.room(view(2, g, 1)); // someone joined
    expect(adopted).toEqual([]);
    expect(sent).toEqual([]);
  });

  it("on reconnecting, sends this phone's newer game, or takes the room's newer one", () => {
    const g = sampleGame();
    // Changed here while offline, nothing new in the room: send it.
    const a = sync();
    const offlineEdit = draw(g, 9e12);
    a.s.local(offlineEdit);
    a.s.room(view(1, g, 4));
    expect(a.sent).toEqual([{ base: 4, game: offlineEdit }]);
    expect(a.adopted).toEqual([]);
    // A recorder's change landed while this phone was away: take it.
    const b = sync();
    b.s.local(g);
    const recorded = draw(g, 9e12);
    b.s.room(view(1, recorded, 5));
    expect(b.adopted.map(gameKey)).toEqual([gameKey(recorded)]);
    expect(b.sent).toEqual([]);
  });

  it("matches a game from an older app version once the server has tidied it", () => {
    const { s, sent } = sync();
    const g = { ...sampleGame(), legacyField: 1 } as unknown as ScoreGame;
    s.local(g);
    const { legacyField: _, ...tidied } = g as unknown as Record<string, unknown>;
    s.room(view(1, tidied as unknown as ScoreGame, 1));
    expect(sent).toEqual([]); // the same game - no endless resending
  });

  it("stops sending once the host has stopped sharing", () => {
    const { s, sent } = sync();
    const g = sampleGame();
    s.local(g);
    s.room(view(1, g, 1, "ended"));
    s.local(draw(g, 2));
    expect(sent).toEqual([]);
  });

  it("waits while offline and sends when the room is back", () => {
    const { s, sent, offline } = sync();
    const g = sampleGame();
    s.local(g);
    s.room(view(1, g, 1));
    offline(true);
    const g2 = draw(g, 2);
    s.local(g2);
    expect(sent).toEqual([]);
    offline(false);
    s.reset();
    s.room(view(2, g, 1)); // reconnected: the room hasn't moved
    expect(sent).toEqual([{ base: 1, game: g2 }]);
  });
});
