// The online table, over real sockets: the lobby, whole hands (people and
// bots), what each phone may see, refusing stale and illegal moves, the
// turn timer, a dropped player's seat, and how little each event writes.

import { env, runDurableObjectAlarm, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Tile } from "@mjwaits/shared/engine/mahjong";
import { replay, type ScoreGame } from "@mjwaits/shared/engine/ledger";
import { PROTOCOL_VERSION } from "@mjwaits/shared/protocol/limits";
import type { TableServerMessage, TableState } from "@mjwaits/shared/protocol/table";
import type { Table } from "../src/table";
import { BASE, ORIGIN } from "./helpers";

type Msg = TableServerMessage;

async function createTable(): Promise<string> {
  const res = await SELF.fetch(`${BASE}/tables`, { method: "POST", headers: { Origin: ORIGIN } });
  expect(res.status).toBe(201);
  return ((await res.json()) as { code: string }).code;
}

const stubFor = (code: string) => env.TABLES.getByName(code);

// A phone at the table: keeps every table state it's sent (for the leak
// check) and answers when the table is waiting on it.
class Phone {
  readonly ws: WebSocket;
  inbox: Msg[] = [];
  states: TableState[] = [];
  errors: Extract<Msg, { t: "error" }>[] = [];
  closed = false;
  answered = -1;
  sentAt = 0;
  token = "";
  private wake: (() => void) | null = null;

  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener("message", (e) => {
      const m = JSON.parse(e.data as string) as Msg;
      this.inbox.push(m);
      if (m.t === "table") this.states.push(m.table);
      if (m.t === "error") this.errors.push(m);
      if (m.t === "error" && m.code === "rateLimited") this.answered = -1; // dropped: answer again
      this.wake?.();
    });
    ws.addEventListener("close", () => {
      this.closed = true;
      this.wake?.();
    });
    ws.accept();
  }

  send(msg: unknown) {
    this.ws.send(JSON.stringify(msg));
  }

  get latest(): TableState | undefined {
    return this.states[this.states.length - 1];
  }

  async next<T extends Msg["t"]>(t: T, ms = 3000): Promise<Extract<Msg, { t: T }>> {
    const deadline = Date.now() + ms;
    for (;;) {
      const i = this.inbox.findIndex((m) => m.t === t);
      if (i >= 0) return this.inbox.splice(i, 1)[0] as Extract<Msg, { t: T }>;
      if (this.closed) throw new Error(`closed waiting for ${t}`);
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`no ${t} - got ${JSON.stringify(this.inbox.slice(-3))}`);
      await new Promise<void>((r) => {
        this.wake = r;
        setTimeout(r, left);
      });
    }
  }

  // The first table state from now on that passes `until`.
  async table(until: (s: TableState) => boolean = () => true, ms = 3000): Promise<TableState> {
    const deadline = Date.now() + ms;
    for (;;) {
      const { table } = await this.next("table", Math.max(1, deadline - Date.now()));
      if (until(table)) return table;
    }
  }

  async error() {
    return this.next("error");
  }
}

async function join(code: string, name: string, token?: string) {
  const res = await SELF.fetch(`${BASE}/tables/${code}/ws`, { headers: { Upgrade: "websocket", Origin: ORIGIN } });
  expect(res.status).toBe(101);
  const p = new Phone(res.webSocket!);
  p.send({ t: "hello", v: PROTOCOL_VERSION, name, ...(token ? { token } : {}) });
  const welcome = await p.next("welcome");
  p.token = welcome.token;
  await p.table();
  return { p, welcome };
}

const same = (a: Tile, b: Tile) => a.suit === b.suit && a.rank === b.rank;

// What a simple player does with the table's state: 自摸 or 食糊 when it
// can, 碰 when offered, otherwise throw the drawn tile (or the first one it
// may); ready between hands. No faster than a person (the rate limit is 5 a second).
function answer(p: Phone, s: TableState) {
  if (s.phase !== "playing" || s.you === null || !s.view || !s.waitingOn.includes(s.you) || p.answered === s.step) return;
  if (Date.now() - p.sentAt < 250) return;
  p.answered = s.step;
  p.sentAt = Date.now();
  const v = s.view;
  if (v.phase.kind === "over") return p.send({ t: "ready" });
  const turn = s.options?.turn;
  if (turn) {
    if (turn.selfDraw) return p.send({ t: "move", step: s.step, move: { kind: "selfDraw" } });
    const hand = v.players[s.you].hand!;
    const drawn = v.phase.kind === "turn" ? v.phase.drawn : null;
    const tile = [...(drawn ? [drawn] : []), ...hand].find((t) => !turn.forbidden.some((f) => same(f, t)))!;
    return p.send({ t: "move", step: s.step, move: { kind: "discard", tile } });
  }
  const claims = s.options?.claims ?? [];
  const pick = claims.find((c) => c.kind === "win") ?? claims.find((c) => c.kind === "pung") ?? null;
  p.send({ t: "claim", step: s.step, claim: pick });
}

// Keep every phone answering until `done` holds for the first one's state.
async function playUntil(phones: Phone[], done: (s: TableState) => boolean, ms = 60_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    for (const p of phones) if (p.latest) answer(p, p.latest);
    const s = phones[0].latest;
    if (s && done(s)) return s;
    if (Date.now() > deadline) throw new Error(`table stuck: ${JSON.stringify({ step: s?.step, waitingOn: s?.waitingOn, phase: s?.view?.phase.kind, errors: phones.map((p) => p.errors) })}`);
    await new Promise((r) => setTimeout(r, 2));
  }
}

// Everything a phone was sent shows only what its seat may see.
function expectNoLeaks(states: TableState[]) {
  expect(states.length).toBeGreaterThan(0);
  for (const s of states) {
    const json = JSON.stringify(s);
    expect(json).not.toMatch(/"wall"\s*:/);
    if (!s.view) continue;
    const over = s.view.phase.kind === "over";
    s.view.players.forEach((pl, i) => {
      if (i !== s.you && !over) expect(pl.hand).toBeNull();
      if (pl.hand) expect(pl.hand.length).toBe(pl.handCount);
    });
    if (s.view.phase.kind === "turn" && s.view.phase.seat !== s.you) {
      expect(s.view.phase.drawn).toBeNull();
      expect(s.view.phase.forbidden).toBeUndefined();
    }
    if (s.options) expect(s.you !== null && s.waitingOn.includes(s.you)).toBe(true);
    for (const pl of s.view.players)
      for (const m of pl.melds) if (m.kind === "kong" && "hidden" in m) expect(JSON.stringify(m)).not.toMatch(/"tiles"/);
  }
}

// A table with Kevin as host in `seat` and bots in the rest.
async function withBots(seat = 0, settings: Partial<TableState["settings"]> = {}) {
  const code = await createTable();
  const { p: host } = await join(code, "Kevin");
  host.send({ t: "sit", seat });
  host.send({ t: "setup", settings: { multiWin: false, timer: 0, hold: 30, firstDealer: 0, ...settings } });
  const bots = ["veteran", "speedster", "wall", "casual"] as const;
  for (let s = 0; s < 4; s++) if (s !== seat) host.send({ t: "setBot", seat: s, bot: bots[s] });
  await host.table((s) => s.seats.every(Boolean));
  return { code, host };
}

describe("the lobby", () => {
  it("seats people and bots; only the host sets up and starts, with every seat filled", async () => {
    const code = await createTable();
    const info = await SELF.fetch(`${BASE}/tables/${code}`, { headers: { Origin: ORIGIN } });
    expect(await info.json()).toMatchObject({ code, phase: "lobby", seats: [null, null, null, null] });

    const { p: host, welcome } = await join(code, "Kevin");
    expect(welcome).toMatchObject({ host: true, seat: null });
    const { p: amy } = await join(code, "Amy");
    host.send({ t: "sit", seat: 0 });
    await host.table((s) => s.seats[0]?.kind === "human");
    amy.send({ t: "sit", seat: 0 });
    expect((await amy.error()).code).toBe("seatTaken");
    amy.send({ t: "setBot", seat: 2, bot: "wall" });
    expect((await amy.error()).code).toBe("notHost");
    amy.send({ t: "sit", seat: 1 });
    host.send({ t: "start" });
    expect((await host.error()).code).toBe("seatsNotFull");
    host.send({ t: "setBot", seat: 1, bot: "wall" });
    expect((await host.error()).code).toBe("seatTaken");
    host.send({ t: "setBot", seat: 2, bot: "wall" });
    host.send({ t: "setBot", seat: 3, bot: "grandmaster" });
    const full = await host.table((s) => s.seats.every(Boolean));
    expect(full.seats.map((s) => s?.kind)).toEqual(["human", "human", "bot", "bot"]);
    expect(full.view).toBeNull();
    amy.send({ t: "start" });
    expect((await amy.error()).code).toBe("notHost");
    host.send({ t: "start" });
    const playing = await host.table((s) => s.phase === "playing");
    expect(playing.hand).toBe(1);
    expect(playing.you).toBe(0);
    amy.send({ t: "stand" });
    expect((await amy.error()).code).toBe("started");
  });
});

describe("seats", () => {
  it("puts people who arrive in the lobby in the first empty seat; once full, they watch", async () => {
    const code = await createTable();
    const phones: Phone[] = [];
    for (const name of ["Kevin", "Amy", "Ben"]) phones.push((await join(code, name)).p);
    const { p: host } = { p: phones[0] };
    host.send({ t: "setBot", seat: 3, bot: "wall" });
    const s = await host.table((t) => t.seats.every(Boolean));
    expect(s.seats.map((x) => x?.name)).toEqual(["Kevin", "Amy", "Ben", "鐵壁 Iron Wall"]);
    const { p: dan } = await join(code, "Dan");
    expect(dan.latest!.you).toBeNull();
    expect(dan.latest!.watching).toBe(1);
    // Standing frees the seat; coming back (a new connection) doesn't take it again unless it's free.
    phones[1].send({ t: "stand" });
    await host.table((t) => t.seats[1] === null);
  });

  it("seats a mystery bot without ever saying which personality it is", async () => {
    const code = await createTable();
    const { p: host } = await join(code, "Kevin");
    const { p: watcher } = await join(code, "Dan");
    watcher.send({ t: "stand" });
    for (const seat of [1, 2, 3]) host.send({ t: "setBot", seat, bot: "mystery" });
    const lobby = await host.table((t) => t.seats.filter((x) => x?.kind === "bot").length === 3);
    expect(lobby.seats.slice(1).map((x) => x?.kind === "bot" && x.bot)).toEqual(["mystery", "mystery", "mystery"]);
    expect(lobby.seats.slice(1).map((x) => x?.name)).toEqual(["神秘 Mystery 1", "神秘 Mystery 2", "神秘 Mystery 3"]);
    host.send({ t: "setup", settings: { multiWin: false, timer: 0, hold: 30, firstDealer: 0 } });
    host.send({ t: "start" });
    await playUntil([host], (t) => t.hand >= 2);
    // Nothing anyone was sent names a personality.
    const ids = ["grandmaster", "veteran", "speedster", "hunter", "wall", "gambler", "casual"].map((id) => `"${id}"`);
    const names = [...ids, "Grandmaster", "Veteran", "Speedster", "Hunter", "Iron Wall", "Gambler", "Casual"];
    for (const p of [host, watcher]) {
      const all = JSON.stringify(p.inbox) + JSON.stringify(p.states);
      for (const n of names) expect(all).not.toContain(n);
    }
    const info = await (await SELF.fetch(`${BASE}/tables/${code}`, { headers: { Origin: ORIGIN } })).text();
    for (const n of names) expect(info).not.toContain(n);
  }, 120_000);
});

describe("playing", () => {
  it("plays hands with one person and three bots, totals adding up to nothing", { timeout: 120_000 }, async () => {
    const { host } = await withBots(0);
    host.send({ t: "start" });
    const s = await playUntil([host], (s) => s.hand >= 3);
    expect(s.totals.reduce((a, b) => a + b, 0)).toBe(0);
    // The table's record (for 戰況) replays to the same totals.
    const res = await SELF.fetch(`${BASE}/tables/${s.code}/scores`, { headers: { Origin: ORIGIN } });
    expect(res.status).toBe(200);
    const record = (await res.json()) as ScoreGame;
    expect(record.seats).toEqual(["Kevin", "快手 Speedster", "鐵壁 Iron Wall", "街坊 Casual"]);
    const latest = host.latest!;
    expect(record.events.length).toBe(latest.scores);
    const r = replay(record);
    expect(record.seats.map((p) => r.totals[p])).toEqual(latest.totals);
    expect(r.hands.length).toBe(latest.hand - 1);
    expect(host.errors).toEqual([]);
    expectNoLeaks(host.states);
  });

  it("plays a whole hand with four people and someone watching, each sent only their own tiles", { timeout: 120_000 }, async () => {
    const code = await createTable();
    const names = ["Kevin", "Amy", "Ben", "Cat"];
    const phones: Phone[] = [];
    for (const [i, name] of names.entries()) {
      const { p } = await join(code, name);
      p.send({ t: "sit", seat: i });
      phones.push(p);
    }
    const { p: watcher } = await join(code, "Dan");
    await phones[0].table((s) => s.seats.every(Boolean));
    phones[0].send({ t: "start" });
    // One hand to its end, then everyone ready for the next.
    await playUntil(phones, (s) => s.hand === 2);
    for (const p of phones) {
      expect(p.errors).toEqual([]);
      expectNoLeaks(p.states);
      // Its own tiles, every time it saw a hand in play.
      for (const s of p.states) if (s.view && s.view.phase.kind !== "over") expect(s.view.players[s.you!].hand).not.toBeNull();
    }
    expectNoLeaks(watcher.states);
    for (const s of watcher.states) {
      expect(s.you).toBeNull();
      expect(s.options).toBeNull();
      if (s.view && s.view.phase.kind !== "over") expect(s.view.players.every((pl) => pl.hand === null)).toBe(true);
    }
    // Everyone saw the same hand end the same way.
    const ends = phones.map((p) => p.states.find((s) => s.view?.phase.kind === "over")!.view!.phase);
    for (const e of ends) expect(e).toEqual(ends[0]);
  });

  it("refuses moves for a passed step, illegal moves, and moves from people not seated", async () => {
    const { code, host } = await withBots(0);
    const { p: watcher } = await join(code, "Dan");
    host.send({ t: "start" });
    const s = await host.table((s) => !!s.options?.turn);
    host.send({ t: "move", step: s.step - 1, move: { kind: "discard", tile: s.view!.players[0].hand![0] } });
    expect((await host.error()).code).toBe("stale");
    const hand = s.view!.players[0].hand!;
    const missing = [1, 2, 3, 4, 5, 6, 7].map((rank) => ({ suit: "z" as const, rank })).find((t) => !hand.some((h) => same(h, t)))!;
    host.send({ t: "move", step: s.step, move: { kind: "discard", tile: missing } });
    expect((await host.error()).code).toBe("illegal");
    host.send({ t: "claim", step: s.step, claim: null });
    expect((await host.error()).code).toBe("notYourTurn");
    watcher.send({ t: "move", step: s.step, move: { kind: "discard", tile: hand[0] } });
    expect((await watcher.error()).code).toBe("notSeated");
    host.send({ t: "move", step: s.step, move: { kind: "discard", tile: hand[0] }, extra: 1 });
    expect((await host.error()).code).toBe("badMessage");
    // Still the same decision: nothing moved.
    const now = await runInDurableObject(stubFor(code), (_t: Table, state) => JSON.parse(state.storage.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = 'state'").one().value));
    expect(now.step).toBe(s.step);
  });

  it("writes one state row (and the clock) per event, however far it moves the hand", async () => {
    const { code, host } = await withBots(0);
    host.send({ t: "start" });
    const s = await host.table((s) => !!s.options?.turn);
    const cursors: SqlStorageCursor<Record<string, SqlStorageValue>>[] = [];
    await runInDurableObject(stubFor(code), (t: Table) => {
      const sql = (t as unknown as { sql: SqlStorage }).sql;
      const exec = sql.exec.bind(sql);
      (sql as { exec: SqlStorage["exec"] }).exec = ((query: string, ...b: SqlStorageValue[]) => {
        const cur = exec(query, ...b);
        cursors.push(cur);
        return cur;
      }) as SqlStorage["exec"];
    });
    // One discard: three bots then answer and play on until it's this seat again.
    answer(host, s);
    await host.table((n) => n.step > s.step);
    const rows = cursors.reduce((n, c) => n + c.rowsWritten, 0);
    expect(rows).toBeGreaterThan(0);
    expect(rows).toBeLessThanOrEqual(2);
  });
});

describe("timers", () => {
  const state = (code: string) =>
    runInDurableObject(stubFor(code), (_t: Table, st) => JSON.parse(st.storage.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = 'state'").one().value));
  const patch = (code: string, path: string, value: unknown) =>
    runInDurableObject(stubFor(code), (_t: Table, st) => {
      st.storage.sql.exec("UPDATE meta SET value = json_set(value, ?, json(?)) WHERE key = 'state'", path, JSON.stringify(value));
    });

  it("plays the drawn tile when the turn timer runs out", async () => {
    const { code, host } = await withBots(0, { timer: 10 });
    await runInDurableObject(stubFor(code), (t: Table) => {
      (t as unknown as { pause: number }).pause = 700;
    });
    host.send({ t: "start" });
    const s = await host.table((s) => !!s.options?.turn);
    expect(s.deadline).toBeGreaterThan(Date.now());
    await patch(code, "$.deadline", 1);
    expect(await runDurableObjectAlarm(stubFor(code))).toBe(true);
    await host.table((n) => n.step > s.step);
    const drawn = s.view!.phase.kind === "turn" ? s.view!.phase.drawn : null;
    const auto = host.states.find((n) => n.last?.kind === "discard" && n.last.seat === 0 && n.last.auto);
    expect(auto).toBeDefined();
    // Out of time, the drawn tile goes.
    if (drawn && auto?.last?.kind === "discard") expect(same(auto.last.tile, drawn)).toBe(true);
  });

  it("paces bots by the alarm, and waits while no one at the table is here", async () => {
    const code = await createTable();
    const { p: host } = await join(code, "Kevin");
    await runInDurableObject(stubFor(code), (t: Table) => {
      (t as unknown as { pause: number }).pause = 700;
    });
    host.send({ t: "sit", seat: 1 });
    for (const s of [0, 2, 3]) host.send({ t: "setBot", seat: s, bot: "casual" });
    await host.table((s) => s.seats.every(Boolean));
    host.send({ t: "start" });
    const first = await host.table((s) => s.phase === "playing");
    expect(first.view!.phase).toMatchObject({ kind: "turn", seat: 0 });
    expect(first.waitingOn).toEqual([]);
    expect((await state(code)).botAt).toBeGreaterThan(Date.now());
    await patch(code, "$.botAt", 1);
    await runDurableObjectAlarm(stubFor(code));
    const moved = await host.table((s) => s.step > first.step);
    expect(moved.last).toMatchObject({ seat: 0 });

    // Everyone away: the bots wait.
    host.ws.close(1000, "bye");
    await new Promise((r) => setTimeout(r, 50));
    const before = await state(code);
    await patch(code, "$.botAt", 1);
    await runDurableObjectAlarm(stubFor(code));
    expect((await state(code)).step).toBe(before.step);
  });

  it("holds a dropped player's seat, then plays for them until they're back", async () => {
    const code = await createTable();
    const { p: host } = await join(code, "Kevin");
    const { p: amy } = await join(code, "Amy");
    host.send({ t: "sit", seat: 0 });
    amy.send({ t: "sit", seat: 1 });
    host.send({ t: "setBot", seat: 2, bot: "wall" });
    host.send({ t: "setBot", seat: 3, bot: "wall" });
    host.send({ t: "setup", settings: { multiWin: false, timer: 0, hold: 10, firstDealer: 1 } });
    await host.table((s) => s.seats.every(Boolean) && s.settings.hold === 10);
    host.send({ t: "start" });
    await host.table((s) => s.phase === "playing");
    const token = amy.token;
    amy.ws.close(1000, "bye");
    // Amy (the dealer) is away: her seat is held, the table waits on her.
    const waiting = await host.table((s) => s.seats[1]?.kind === "human" && !s.seats[1].connected);
    expect(waiting.waitingOn).toContain(1);
    expect(waiting.auto).toEqual([]);
    await patch(code, '$.away."1"', 1);
    await runDurableObjectAlarm(stubFor(code));
    const played = await host.table((s) => s.auto.includes(1));
    expect(played.step).toBeGreaterThan(waiting.step);
    // Back: her seat is hers again.
    const { p: back, welcome } = await join(code, "Amy", token);
    expect(welcome.seat).toBe(1);
    const mine = back.latest!;
    expect(mine.auto).not.toContain(1);
    expect(mine.you).toBe(1);
    expect(mine.view!.players[1].hand).not.toBeNull();
  });
});
