// The online table, over real sockets: the lobby, whole hands (people and
// bots), what each phone may see, refusing stale and illegal moves, the
// turn timer, a dropped player's seat, and how little each event writes.

import { env, runDurableObjectAlarm, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Tile } from "@mjwaits/shared/engine/mahjong";
import { applyTurnMove, claimOptions, dealHand, type GameState } from "@mjwaits/shared/engine/game";
import { replay, type ScoreGame } from "@mjwaits/shared/engine/ledger";
import { PROTOCOL_VERSION } from "@mjwaits/shared/protocol/limits";
import { blindPicks, botSplit, SWAP_TIMER_S, takeOrder, type Pile } from "@mjwaits/shared/engine/swap";
import type { TableServerMessage, TableState } from "@mjwaits/shared/protocol/table";
import type { Table } from "../src/table";
import { BASE, ORIGIN } from "./helpers";
import { HOST_GONE_MS } from "../src/hub";

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
  // 換牌: give the first tiles in hand; take evenly, blind (as the one-tap take).
  if (v.phase.kind === "swap") {
    const ph = v.phase;
    if (ph.stage === "give") return p.send({ t: "give", step: s.step, tiles: v.players[s.you].hand!.slice(0, ph.count) });
    const piles = ph.piles.map((pile) => (pile ? pile.map((t) => (t ? ({ suit: "z", rank: 1 } as Tile) : null)) : null)) as (Pile | null)[];
    const order = takeOrder(v.dealer);
    const after = order.slice(order.indexOf(ph.taker) + 1);
    const even = botSplit(piles.map((pl) => (pl ? pl.filter(Boolean).length : 0)), s.you, after, ph.count);
    return p.send({ t: "take", step: s.step, picks: piles.map((pl, g) => (pl ? blindPicks(pl, even[g]) : [])) });
  }
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
      if (i !== s.you) expect(pl.passedPung).toBeUndefined();
      if (pl.hand) expect(pl.hand.length).toBe(pl.handCount);
    });
    // 換牌: of the piles, only your own is face up.
    if (s.view.phase.kind === "swap") s.view.phase.piles.forEach((pile, i) => i !== s.you && pile?.forEach((t) => expect(t === null || t === "back").toBe(true)));
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

describe("between hands", () => {
  it("deals the next hand without someone who never says they're ready, once the hold has passed", async () => {
    const code = await createTable();
    const { p: host } = await join(code, "Kevin");
    for (const seat of [1, 2, 3]) host.send({ t: "setBot", seat, bot: "wall" });
    await host.table((s) => s.seats.every(Boolean));
    host.send({ t: "start" });
    await host.table((s) => s.phase === "playing");
    // The hand over (a draw), and Kevin - here, not played for - never taps ready.
    const step = (now: number) =>
      runInDurableObject(stubFor(code), (t: Table) => {
        const tt = t as unknown as { load(): { game: { phase: unknown; wall: unknown[] }; overAt?: number; hand: number; settings: { hold: number } }; save(): void; onAlarm(now: number): number | null };
        const rt = tt.load();
        if (rt.overAt === undefined) {
          rt.game.phase = { kind: "over", result: { winner: null, from: null, tile: null, score: null, scoreError: null, deltas: [0, 0, 0, 0] } };
          rt.overAt = now;
          tt.save();
        }
        tt.onAlarm(now);
        return { hand: tt.load().hand, hold: rt.settings.hold, overAt: rt.overAt! };
      });
    const start = Date.now();
    const first = await step(start);
    expect(first.hand).toBe(1);
    expect((await step(start + 5_000)).hand).toBe(1); // still waiting
    expect((await step(first.overAt + Math.max(first.hold, 30) * 1000 + 1)).hand).toBe(2);
  });
});

describe("the lobby", () => {
  it("hands the host on once they've been gone a while; clears a seat whose person left; leaves a watcher watching", async () => {
    const code = await createTable();
    const { p: host } = await join(code, "Kevin");
    const { p: amy, welcome: amyIn } = await join(code, "Amy");
    const { p: ben } = await join(code, "Ben");
    // Ben stands to watch, then drops and comes back: still watching.
    ben.send({ t: "stand" });
    await host.table((s) => s.seats.filter(Boolean).length === 2);
    ben.ws.close();
    await host.table((s) => !s.seats.some((x) => x?.kind === "human" && x.name === "Ben"));
    const { p: ben2 } = await join(code, "", ben.token);
    const back = ben2.latest!;
    expect(back.seats.some((x) => x?.kind === "human" && x.name === "Ben")).toBe(false);
    // The host leaves: not straight away, but once HOST_GONE_MS has passed, Amy (joined next) hosts.
    host.ws.close();
    const left = await amy.table((s) => s.seats.some((x) => x?.kind === "human" && x.name === "Kevin" && !x.connected));
    expect(left.host).not.toBe(amyIn.id);
    await runInDurableObject(stubFor(code), (t: Table) => {
      const hub = t as unknown as { passHost(now: number): boolean; setMeta(k: string, v: unknown): void };
      expect(hub.passHost(Date.now() + 1000)).toBe(false);
      expect(hub.passHost(Date.now() + HOST_GONE_MS + 1000)).toBe(true);
    });
    // Amy, host now, clears Kevin's empty seat (he's gone) and seats a bot there.
    const kevinAt = left.seats.findIndex((x) => x?.kind === "human" && x.name === "Kevin");
    amy.send({ t: "setBot", seat: kevinAt, bot: "wall" });
    const cleared = await amy.table((s) => s.seats[kevinAt]?.kind === "bot");
    expect(cleared.host).toBe(amyIn.id);
  });

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

  it("swaps tiles (換牌) and keeps a jackpot (獎池): the record and the totals agree", { timeout: 120_000 }, async () => {
    const swapRules = { winds: [1, 2, 3, 4], rounds: [2, 2, 2, 2, 2, 2], tiles: [3, 3, 3, 3, 3, 3] };
    const { host } = await withBots(0, { swapRules, jackpot: 5 });
    host.send({ t: "start" });
    const s = await playUntil([host], (s) => s.hand >= 4, 100_000);
    const swaps = host.states.filter((x) => x.view?.phase.kind === "swap");
    // Every hand swapped: two rounds, each with a give and four takes.
    expect(new Set(swaps.map((x) => x.hand)).size).toBeGreaterThanOrEqual(3);
    expect(swaps.some((x) => x.view!.phase.kind === "swap" && x.view!.phase.stage === "take" && x.view!.phase.round === 2)).toBe(true);
    // Money stays at the table: what's out of the totals is in the pot.
    expect(s.totals.reduce((a, b) => a + b, 0) + s.pot).toBe(0);
    const res = await SELF.fetch(`${BASE}/tables/${s.code}/scores`, { headers: { Origin: ORIGIN } });
    const record = (await res.json()) as ScoreGame;
    const r = replay(record);
    expect(record.seats.map((p) => r.totals[p])).toEqual(s.totals);
    expect(r.pot).toBe(s.pot);
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

  it("gives a player back on their turn their own time, with no bot's pause left over - and never wakes the room for a time gone by", async () => {
    const code = await createTable();
    const { p: host } = await join(code, "Kevin");
    const { p: amy } = await join(code, "Amy");
    await runInDurableObject(stubFor(code), (t: Table) => {
      (t as unknown as { pause: number }).pause = 700;
    });
    host.send({ t: "sit", seat: 0 });
    amy.send({ t: "sit", seat: 1 });
    host.send({ t: "setBot", seat: 2, bot: "wall" });
    host.send({ t: "setBot", seat: 3, bot: "wall" });
    host.send({ t: "setup", settings: { multiWin: false, timer: 10, hold: 10, firstDealer: 1 } });
    await host.table((s) => s.seats.every(Boolean) && s.settings.timer === 10);
    host.send({ t: "start" });
    await host.table((s) => s.phase === "playing");
    const token = amy.token;
    amy.ws.close(1000, "bye");
    await host.table((s) => s.seats[1]?.kind === "human" && !s.seats[1].connected);
    // Held long enough: played for, her turn waits a bot's pause.
    await patch(code, '$.away."1"', 1);
    await runDurableObjectAlarm(stubFor(code));
    const played = await state(code);
    expect(played.auto).toContain(1);
    expect(played.botAt).toBeGreaterThan(Date.now() - 1000);
    // Back before it's made: her turn, her time, no pause left over.
    await join(code, "Amy", token);
    const back = await state(code);
    expect(back.auto).not.toContain(1);
    expect(back.botAt).toBeNull();
    expect(back.deadline).toBeGreaterThan(Date.now() + 5000);
    // A bot's pause gone by, on a person's turn: not a reason to wake.
    const due = await runInDurableObject(stubFor(code), async (t: Table, st) => {
      const tt = t as unknown as { load(): { botAt: number | null }; save(): void; onAlarm(now: number): number | null };
      tt.load().botAt = 1;
      tt.save();
      return { next: tt.onAlarm(Date.now()), botAt: tt.load().botAt, alarm: await st.storage.getAlarm() };
    });
    expect(due.botAt).toBeNull();
    expect(due.next).toBeGreaterThan(Date.now());
    expect(due.alarm).toBeGreaterThan(Date.now() - 1000);
  });

  it("stops a person's clock while no one at the table is here", async () => {
    const { code, host } = await withBots(0, { timer: 10 });
    await runInDurableObject(stubFor(code), (t: Table) => {
      (t as unknown as { pause: number }).pause = 700;
    });
    host.send({ t: "start" });
    const mine = await host.table((s) => !!s.options?.turn);
    host.ws.close(1000, "bye");
    await expect.poll(async () => (await state(code)).pausedAt, { timeout: 2000 }).toBeTypeOf("number");
    // Left with 8s to go, a minute ago.
    const now = Date.now();
    await patch(code, "$.pausedAt", now - 60_000);
    await patch(code, "$.deadline", now - 52_000);
    await join(code, "", host.token);
    const back = await state(code);
    expect(back.step).toBe(mine.step); // not thrown for him
    expect(back.pausedAt).toBeUndefined();
    expect(back.deadline).toBeGreaterThan(now + 7000);
    expect(back.deadline).toBeLessThan(now + 10_000);
  });
});

describe("what the table shows of a move", () => {
  type Rt = { game: GameState; decisions: unknown; last: TableState["last"] };
  type Inside = { load(): Rt; applyMove(seat: number, move: unknown, onIllegal: string, auto?: boolean): void; resolve(): void };

  it("shows the move a refused one fell back to, not the refused one", async () => {
    const { code, host } = await withBots(0);
    host.send({ t: "start" });
    const s = await host.table((s) => !!s.options?.turn);
    const hand = s.view!.players[0].hand!;
    const missing = [1, 2, 3, 4, 5, 6, 7].map((rank) => ({ suit: "z", rank }) as Tile).find((t) => !hand.some((h) => same(h, t)))!;
    const r = await runInDurableObject(stubFor(code), (t: Table) => {
      const tt = t as unknown as Inside;
      const rt = tt.load();
      tt.applyMove(0, { kind: "discard", tile: missing }, "fallback");
      return { last: rt.last, phase: rt.game.phase, pond: rt.game.players[0].discards };
    });
    // (The dealer's first turn: a discard, as a rule - then it's the tile that went.)
    if (r.phase.kind === "claims") {
      expect(r.last).toMatchObject({ kind: "discard", seat: 0 });
      if (r.last?.kind === "discard") {
        expect(same(r.last.tile, r.phase.tile)).toBe(true);
        expect(same(r.last.tile, missing)).toBe(false);
      }
    }
  });

  it("shows 下家's pung as a call, as anyone else's", async () => {
    const { code, host } = await withBots(0);
    host.send({ t: "start" });
    await host.table((s) => !!s.options?.turn);
    const last = await runInDurableObject(stubFor(code), (t: Table) => {
      const tt = t as unknown as Inside;
      const rt = tt.load();
      rt.game = thrownTo(rt.game, 1, 2);
      if (!claimOptions(rt.game, 1).some((c) => c.kind === "pung")) throw new Error("no pung to call");
      rt.decisions = [null, { kind: "pung" }, null, null];
      tt.resolve();
      return rt.last;
    });
    expect(last).toEqual({ kind: "call", seat: 1, call: "pung", from: 0 });
  });
});

// Seat 0's turn in `g` made into its throw of a tile seat `to` holds `n`
// of: copies traded into `to`'s hand from elsewhere, every tile still there.
function thrownTo(state: GameState, to: number, n: number): GameState {
  const g = structuredClone(state);
  const tile = g.players[0].hand[0];
  const theirs = g.players[to].hand;
  type Spot = [() => Tile, (x: Tile) => void];
  const inHand = (p: number) => g.players[p].hand.map((_, i): Spot => [() => g.players[p].hand[i], (x) => (g.players[p].hand[i] = x)]);
  const spots: Spot[] = [
    ...inHand(0).slice(1),
    ...[1, 2, 3].filter((p) => p !== to).flatMap(inHand),
    ...g.wall.flatMap((w, i): Spot[] => ("tile" in w ? [[() => (g.wall[i] as { tile: Tile }).tile, (x) => (g.wall[i] = { tile: x })]] : [])),
  ];
  for (const [get, put] of spots) {
    if (theirs.filter((x) => same(x, tile)).length >= n) break;
    if (!same(get(), tile)) continue;
    const i = theirs.findIndex((x) => !same(x, tile));
    put(theirs[i]);
    theirs[i] = { ...tile };
  }
  return applyTurnMove(g, { kind: "discard", tile });
}

describe("嗌錯 on a kong", () => {
  it("takes back a pung, never a kong (its replacement's been drawn)", async () => {
    const { code, host } = await withBots(1);
    host.send({ t: "start" });
    await host.table((s) => s.phase === "playing");
    const can = await runInDurableObject(stubFor(code), (t: Table) => {
      const tt = t as unknown as { load(): { game: GameState; decisions: unknown; lastCall: unknown; step: number }; resolve(): void; canRetract(seat: number): boolean; save(): void };
      const out: Record<string, boolean | number> = {};
      for (const call of ["pung", "kong"] as const) {
        const rt = tt.load();
        rt.lastCall = null;
        rt.game = thrownTo(dealHand({ dealer: 0, roundWind: 1, dealerStreak: 0 }), 1, call === "kong" ? 3 : 2);
        if (!claimOptions(rt.game, 1).some((c) => c.kind === call)) throw new Error(`no ${call} to call`);
        rt.decisions = [null, { kind: call }, null, null];
        tt.resolve();
        out[call] = tt.canRetract(1);
        if (call === "kong") {
          tt.save();
          out.step = rt.step;
        }
      }
      return out;
    });
    expect(can).toMatchObject({ pung: true, kong: false });
    // And the table, asked, says no.
    host.send({ t: "retract", step: can.step });
    expect((await host.error()).code).toBe("illegal");
  });
});

describe("嗌錯, 自動 and bot speed", () => {
  const state = (code: string) =>
    runInDurableObject(stubFor(code), (_t: Table, st) => JSON.parse(st.storage.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = 'state'").one().value));

  it("takes back a call (嗌錯): the discard plays on as passed, and the caller pays each player", { timeout: 120_000 }, async () => {
    for (let attempt = 0; attempt < 8; attempt++) {
      const { host } = await withBots(0);
      host.send({ t: "start" });
      // Play (punging when offered) until a pung of yours can be taken back.
      const called = await playUntil([host], (s) => !!s.options?.turn?.retract || s.view?.phase.kind === "over").catch(() => null);
      if (!called || !called.options?.turn?.retract) {
        host.ws.close(1000, "bye");
        continue;
      }
      const melds = called.view!.players[0].melds.length;
      const totals = called.totals;
      host.send({ t: "retract", step: called.step });
      const after = await host.table((s) => s.step > called.step);
      expect(host.errors).toEqual([]);
      expect(after.view!.players[0].melds.length).toBe(melds - 1);
      // The 嗌錯 is paid - and anything else since (the next player's flower, say).
      const since = after.view!.tableBonuses.slice(called.view!.tableBonuses.length);
      expect(since.find((b) => b.name === "嗌錯")).toMatchObject({ seat: 0, deltas: [-15, 5, 5, 5] });
      // (The bots play on at once: a hand they end meanwhile is paid as well.)
      const result = after.view!.phase.kind === "over" ? after.view!.phase.result.deltas : [0, 0, 0, 0];
      for (let s = 0; s < 4; s++) expect(after.totals[s]).toBe(totals[s] + since.reduce((sum, b) => sum + b.deltas[s], 0) + result[s]);
      expect(after.options?.turn?.retract).toBeFalsy();
      // Gone: a second take-back is refused.
      host.send({ t: "retract", step: after.step });
      expect((await host.error()).code).toMatch(/illegal|stale/);
      return;
    }
    throw new Error("no pung came up to take back");
  });

  it("plays your seat as you watch (自動) - between hands too - until you take it back", { timeout: 120_000 }, async () => {
    const { code, host } = await withBots(0);
    // A little pause, so the hand's end is sent before the next deal (it waits a multiple of it).
    await runInDurableObject(stubFor(code), (t: Table) => {
      (t as unknown as { pause: number }).pause = 20;
    });
    host.send({ t: "start" });
    await host.table((s) => s.phase === "playing");
    host.send({ t: "autoplay", on: true });
    // The whole hand and the next deal, without a word from you.
    const next = await host.table((s) => s.hand === 2 && s.view?.phase.kind !== "over", 60_000);
    expect(next.auto).toContain(0);
    expect(host.states.some((s) => s.view?.phase.kind === "over")).toBe(true);
    expect((await state(code)).chosen).toEqual([0]);
    host.send({ t: "autoplay", on: false });
    const mine = await host.table((s) => s.waitingOn.includes(0), 60_000);
    expect(mine.auto).not.toContain(0);
  });

  it("gives 換牌's give and take 30s, with the turn timer off", async () => {
    const { host } = await withBots(0, { swapRules: { winds: [1, 2, 3, 4], rounds: [1, 1, 1, 1, 1, 1], tiles: [3, 3, 3, 3, 3, 3] } });
    const sent = Date.now();
    host.send({ t: "start" });
    const s = await host.table((s) => s.view?.phase.kind === "swap" && s.waitingOn.includes(0));
    expect(s.settings.timer).toBe(0);
    expect(s.deadline! - sent).toBeGreaterThanOrEqual(SWAP_TIMER_S * 1000 - 50);
    expect(s.deadline! - sent).toBeLessThan(SWAP_TIMER_S * 1000 + 2000);
  });

  it("paces bots at the table's bot speed", async () => {
    const code = await createTable();
    const { p: host } = await join(code, "Kevin");
    await runInDurableObject(stubFor(code), (t: Table) => {
      (t as unknown as { pause: number }).pause = 1000;
    });
    host.send({ t: "sit", seat: 1 });
    for (const s of [0, 2, 3]) host.send({ t: "setBot", seat: s, bot: "casual" });
    host.send({ t: "setup", settings: { multiWin: false, timer: 0, hold: 30, firstDealer: 0, botSpeed: "fast" } });
    await host.table((s) => s.seats.every(Boolean) && s.settings.botSpeed === "fast");
    const sent = Date.now();
    host.send({ t: "start" });
    await host.table((s) => s.phase === "playing");
    const wait = (await state(code)).botAt - sent;
    expect(wait).toBeGreaterThan(300);
    expect(wait).toBeLessThan(700);
  });
});

describe("between games", () => {
  it("sends a seated player's reaction to everyone, unstored; the host's rematch goes back to the lobby", async () => {
    const code = await createTable();
    const { p: host } = await join(code, "Kevin");
    const { p: amy } = await join(code, "Amy");
    host.send({ t: "setBot", seat: 2, bot: "wall" });
    host.send({ t: "setBot", seat: 3, bot: "grandmaster" });
    await host.table((s) => s.seats.every(Boolean));
    const { p: dan } = await join(code, "Dan"); // watching
    host.send({ t: "start" });
    await host.table((s) => s.phase === "playing");

    const version = host.latest!.version;
    amy.send({ t: "react", r: "好牌！" });
    for (const p of [host, amy, dan]) expect(await p.next("reaction")).toMatchObject({ seat: 1, r: "好牌！" });
    expect(host.latest!.version).toBe(version); // not a change to the table
    dan.send({ t: "react", r: "👍" });
    expect((await dan.error()).code).toBe("notSeated");
    amy.send({ t: "react", r: "hello" });
    expect((await amy.error()).code).toBe("badMessage");

    amy.send({ t: "rematch" });
    expect((await amy.error()).code).toBe("notHost");
    host.send({ t: "rematch" });
    expect((await host.error()).code).toBe("illegal");
    host.send({ t: "end" });
    const ended = await host.table((s) => s.phase === "ended");
    host.send({ t: "rematch" });
    const lobby = await amy.table((s) => s.phase === "lobby" && s.version > ended.version);
    expect(lobby).toMatchObject({ hand: 0, totals: [0, 0, 0, 0], view: null });
    expect(lobby.seats.map((s) => s?.name)).toEqual(["Kevin", "Amy", "鐵壁 Iron Wall", "宗師 Grandmaster"]);
    expect(await runInDurableObject(stubFor(code), (t: Table) => t.scores())).toBeNull();
    host.send({ t: "start" });
    expect((await host.table((s) => s.phase === "playing")).hand).toBe(1);
  });
});

describe("hiding losing hands", () => {
  it("keeps the host's setting, refuses showing before a hand ends, and tells everyone who has shown", async () => {
    const code = await createTable();
    const { p: host } = await join(code, "Kevin");
    const { p: amy } = await join(code, "Amy");
    host.send({ t: "setup", settings: { multiWin: false, timer: 0, hold: 30, firstDealer: 0, reveal: false } });
    host.send({ t: "setBot", seat: 2, bot: "wall" });
    host.send({ t: "setBot", seat: 3, bot: "wall" });
    const ready = await amy.table((s) => s.settings.reveal === false && s.seats.every(Boolean));
    expect(ready.shown).toEqual([]);
    host.send({ t: "start" });
    await host.table((s) => s.phase === "playing");
    amy.send({ t: "show" });
    expect((await amy.error()).code).toBe("notYourTurn");
    // At a hand's end: the winner's hand and any shown one, not the rest -
    // and all of them when the table shows losing hands.
    const over = { phase: { kind: "over", result: { winner: 0 } } };
    const shown = await runInDurableObject(stubFor(code), (t: Table) => {
      const table = t as unknown as { rt: { settings: { reveal?: boolean }; shown?: number[] }; handShown: (g: unknown, s: number) => boolean };
      table.rt = { settings: { reveal: false }, shown: [2] };
      const hidden = [0, 1, 2, 3].map((s) => table.handShown(over, s));
      table.rt = { settings: { reveal: true }, shown: [] };
      return { hidden, open: [0, 1, 2, 3].map((s) => table.handShown(over, s)) };
    });
    expect(shown).toEqual({ hidden: [true, false, true, false], open: [true, true, true, true] });
  });
});

describe("自摸 online", () => {
  it("wins a hand by self-draw, from the move the app sends", async () => {
    const { code, host } = await withBots(0);
    host.send({ t: "start" });
    const s = await host.table((s) => !!s.options?.turn);
    // Seat 0's turn, its hand made a winning one: 111 222 333 444 555 of characters, 99 dots.
    await runInDurableObject(stubFor(code), (t: Table) => {
      const tt = t as unknown as { load(): { game: GameState }; save(): void };
      const rt = tt.load();
      const g = rt.game;
      const win: Tile[] = [1, 1, 1, 2, 2, 2, 3, 3, 3, 4, 4, 4, 5, 5, 5].map((rank) => ({ suit: "m", rank }) as Tile).concat([{ suit: "t", rank: 9 } as Tile]);
      const drawn = { suit: "t", rank: 9 } as Tile;
      g.players[0].melds = [];
      if (g.phase.kind !== "turn") throw new Error("not a turn");
      g.phase = { ...g.phase, seat: 0, drawn };
      g.players[0].hand = [...win, drawn];
      tt.save();
    });
    host.send({ t: "move", step: s.step, move: { kind: "selfDraw" } });
    // (Its score's patterns carry functions - the table once failed copying it.)
    const end = await host.table((t) => t.view?.phase.kind === "over");
    expect(host.errors).toEqual([]);
    const phase = end.view!.phase;
    if (phase.kind !== "over") throw new Error("not over");
    expect(phase.result.winner).toBe(0);
    expect(phase.result.from).toBe(null);
  });
});

describe("a claim window", () => {
  it("doesn't wait on a run once someone's called a pung", async () => {
    const code = await createTable();
    const { p: host } = await join(code, "Kevin");
    host.send({ t: "sit", seat: 1 });
    const { p: other } = await join(code, "Amy");
    other.send({ t: "sit", seat: 2 });
    host.send({ t: "setup", settings: { multiWin: false, timer: 0, hold: 30, firstDealer: 0 } });
    host.send({ t: "setBot", seat: 0, bot: "wall" });
    host.send({ t: "setBot", seat: 3, bot: "wall" });
    await host.table((s) => s.seats.every(Boolean));
    host.send({ t: "start" });
    await host.table((s) => s.phase === "playing");
    // Seat 0 has thrown 5m: Kevin (next) could run it with 34m, Amy pung it with 55m.
    const { step, pung } = await runInDurableObject(stubFor(code), (t: Table) => {
      const tt = t as unknown as { load(): { game: GameState; decisions: unknown; step: number; botAt: number | null; deadline: number | null }; save(): void };
      const rt = tt.load();
      const g = rt.game;
      g.players[1].hand = [3, 4].map((rank) => ({ suit: "m", rank }) as Tile).concat(g.players[1].hand.filter((x) => x.suit !== "m").slice(0, 11));
      g.players[2].hand = [5, 5].map((rank) => ({ suit: "m", rank }) as Tile).concat(g.players[2].hand.filter((x) => x.suit !== "m").slice(0, 11));
      g.phase = { kind: "claims", from: 0, tile: { suit: "m", rank: 5 } };
      rt.decisions = [null, "waiting", "waiting", null];
      rt.botAt = null;
      rt.deadline = null;
      tt.save();
      return { step: rt.step, pung: claimOptions(g, 2).find((c) => c.kind === "pung") };
    });
    expect(pung).toBeDefined();
    other.send({ t: "claim", step, claim: pung });
    // Taken by Amy, without Kevin's answer.
    const s = await host.table((s) => s.view?.phase.kind === "turn");
    expect(s.view!.phase).toMatchObject({ kind: "turn", seat: 2 });
    expect(host.errors.concat(other.errors)).toEqual([]);
  });
});
