// The shared scoreboard: recording, payouts (checked against the ledger the
// Scores tab uses), undo with approval, the summary, and state surviving the
// room being evicted from memory.

import { env, evictDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { replay, settle, type ScoreEvent } from "@mjwaits/shared/engine/ledger";
import { DEFAULT_ROOM_SETTINGS, type RoomSettings } from "@mjwaits/shared/protocol/client";
import type { RoomView } from "@mjwaits/shared/protocol/server";
import { ledgerSettings } from "../src/room";
import { fullTable, join } from "./helpers";

// Four seated (A B C D in seats 0-3, A hosting), set up and started.
async function playing(settings: Partial<RoomSettings> = {}) {
  const table = await fullTable();
  const [a] = table.players;
  a.c.send({ t: "setup", settings: { ...DEFAULT_ROOM_SETTINGS, ...settings } });
  await a.c.room((v) => v.settings.startChips === (settings.startChips ?? 0));
  a.c.send({ t: "start" });
  const views = [];
  for (const p of table.players) views.push(await p.c.room((v) => v.phase === "playing"));
  return { ...table, start: views[0], b: table.players[1].c, c: table.players[2].c, d: table.players[3].c, host: a.c };
}

// Waits for the view in which the scoreboard has `n` events.
const atEvents = (n: number) => (v: RoomView) => v.game?.events.length === n;

describe("recording hands", () => {
  it("starts with the seated names, the host's settings and an empty board", async () => {
    const settings = { ...DEFAULT_ROOM_SETTINGS, startChips: 1000, firstDealer: 2, base: 3 };
    const { start } = await playing(settings);
    expect(start.game).toMatchObject({ seats: ["A", "B", "C", "D"], firstDealer: 2, settings: ledgerSettings(settings), events: [] });
    expect(start.board).toEqual({ chips: [1000, 1000, 1000, 1000], net: [0, 0, 0, 0], dealer: 2, streak: 0, roundWind: 0, label: "東風東局", hands: 0, lahs: [], pot: 0 });
    expect(start.summary).toBeNull();
  });

  it("only takes entries from seated players, once the game is on", async () => {
    const table = await fullTable();
    const [a] = table.players;
    a.c.send({ t: "draw" });
    expect(await a.c.error()).toMatchObject({ code: "notStarted" });
    a.c.send({ t: "start" });
    await a.c.room((v) => v.phase === "playing");
    const watcher = await join(table.code, "W");
    watcher.c.send({ t: "win", winners: [{ seat: 0, tai: 5 }], from: null });
    expect(await watcher.c.error()).toMatchObject({ code: "notSeated" });
  });

  it("pays a win as the ledger does, and moves the deal on", async () => {
    const { host, b } = await playing({ startChips: 500 });
    // A deals first. B wins 10 off C: neither is the dealer, so C pays 10.
    b.send({ t: "win", winners: [{ seat: 1, tai: 10 }], from: 2 });
    const view = await host.room(atEvents(1));
    expect(view.board).toMatchObject({ net: [0, 10, -10, 0], chips: [500, 510, 490, 500], dealer: 1, streak: 0, hands: 1 });
    expect(view.board!.lahs).toEqual([{ holder: "B", pulled: "C", value: 10, count: 1 }]);
    expect(view.game!.seats).toEqual(["A", "B", "C", "D"]);
  });

  it("matches the Scores tab's ledger over a whole run of entries", async () => {
    const { host, b, c, d } = await playing({ base: 2, dealerTai: 3, streakTai: 1, multiWin: "all" });
    const sends: [typeof host, unknown][] = [
      [b, { t: "win", winners: [{ seat: 1, tai: 10 }], from: 2 }],
      [b, { t: "win", winners: [{ seat: 1, tai: 5 }], from: null }], // dealer B self-draws
      [c, { t: "draw" }],
      [c, { t: "win", winners: [{ seat: 2, tai: 20 }], from: 1 }], // 踢 back
      [d, { t: "win", winners: [{ seat: 0, tai: 8 }, { seat: 3, tai: 12 }], from: 2 }], // 雙響
      [host, { t: "bonus", seat: 2, kind: "獎", amount: 5 }],
      [d, { t: "bonus", seat: 3, kind: "罰", amount: 30, other: 0 }],
      [c, { t: "win", winners: [{ seat: 2, tai: 6 }], from: null }], // 反雪 for C
    ];
    let latest: RoomView | null = null;
    for (const [i, [who, msg]] of sends.entries()) {
      who.send(msg);
      latest = await host.room(atEvents(i + 1));
    }
    if (!latest) throw new Error("no view");

    // The same events, replayed by the ledger here.
    const expected = replay({ ...latest.game!, settings: ledgerSettings({ ...DEFAULT_ROOM_SETTINGS, base: 2, dealerTai: 3, streakTai: 1 }) });
    expect(latest.board!.net).toEqual(latest.game!.seats.map((n) => expected.totals[n]));
    // What the players lost between them is what's in the Jackpot.
    expect(latest.board!.net.reduce((x, y) => x + y, 0) + latest.board!.pot).toBe(0);
    expect(latest.board).toMatchObject({ dealer: expected.dealer, streak: expected.streak, label: expected.label, hands: 6, pot: expected.pot });
    expect(latest.board!.lahs).toEqual(expected.lahs);
    expect(latest.game!.events.map((e: ScoreEvent) => e.t)).toEqual(["win", "win", "draw", "win", "win", "bonus", "bonus", "win"]);
    // 反雪 really happened: C was paid back by both 雙響 winners.
    expect(expected.hands[5].fanXue).toHaveLength(2);
  });

  it("refuses two winners at a 截胡 table, and takes them at a 一炮多響 one", async () => {
    const first = await playing();
    first.b.send({ t: "win", winners: [{ seat: 1, tai: 5 }, { seat: 3, tai: 5 }], from: 2 });
    expect(await first.b.error()).toMatchObject({ code: "multiWinOff" });
    const all = await playing({ multiWin: "all" });
    all.b.send({ t: "win", winners: [{ seat: 1, tai: 5 }, { seat: 3, tai: 5 }], from: 2 });
    expect((await all.host.room(atEvents(1))).board!.net).toEqual([0, 5, -10, 5]);
  });

  it("feeds the Jackpot on a draw and pays it to a winner who takes it", async () => {
    const { host, b } = await playing();
    b.send({ t: "draw" });
    expect((await host.room(atEvents(1))).board).toMatchObject({ pot: 20, net: [-5, -5, -5, -5] });
    b.send({ t: "win", winners: [{ seat: 1, tai: 10 }], from: 2, jackpot: true });
    const board = (await host.room(atEvents(2))).board!;
    expect(board.pot).toBe(0);
    expect(board.net).toEqual([-5, -5 + 10 + 20, -5 - 10, -5]);
  });
});

describe("undo", () => {
  it("needs another seated player's yes, and blocks new entries while it waits", async () => {
    const { host, b, c } = await playing();
    b.send({ t: "undo" });
    expect(await b.error()).toMatchObject({ code: "nothingToUndo" });
    b.send({ t: "win", winners: [{ seat: 1, tai: 10 }], from: 2 });
    await host.room(atEvents(1));

    b.send({ t: "undo" });
    expect((await host.room((v) => v.pendingUndo !== null)).pendingUndo).toEqual({ by: 1, entry: 0 });
    c.send({ t: "draw" });
    expect(await c.error()).toMatchObject({ code: "undoPending" });
    b.send({ t: "undoVote", approve: true });
    expect(await b.error()).toMatchObject({ code: "ownUndo" });

    // A no: the entry stays.
    c.send({ t: "undoVote", approve: false });
    let view = await host.room((v) => v.pendingUndo === null);
    expect(view.game!.events).toHaveLength(1);

    // Asked again, a yes: gone, and the board with it.
    b.send({ t: "undo" });
    await host.room((v) => v.pendingUndo !== null);
    c.send({ t: "undoVote", approve: true });
    view = await host.room((v) => v.pendingUndo === null);
    expect(view.game!.events).toHaveLength(0);
    expect(view.board).toMatchObject({ net: [0, 0, 0, 0], dealer: 0, hands: 0 });
  });

  it("lets the one who asked withdraw it", async () => {
    const { host, b } = await playing();
    b.send({ t: "draw" });
    await host.room(atEvents(1));
    b.send({ t: "undo" });
    await host.room((v) => v.pendingUndo !== null);
    b.send({ t: "undoVote", approve: false });
    expect((await host.room((v) => v.pendingUndo === null)).game!.events).toHaveLength(1);
    b.send({ t: "undoVote", approve: true });
    expect(await b.error()).toMatchObject({ code: "noUndoPending" });
  });

  it("lets the host undo alone when the room allows it - and only the host", async () => {
    const { host, b } = await playing({ hostCanUndo: true });
    b.send({ t: "draw" });
    b.send({ t: "draw" });
    await host.room(atEvents(2));
    host.send({ t: "undo" });
    expect((await host.room(atEvents(1))).pendingUndo).toBeNull();
    b.send({ t: "undo" });
    expect((await host.room((v) => v.pendingUndo !== null)).pendingUndo).toEqual({ by: 1, entry: 0 });
  });
});

describe("ending the session", () => {
  it("is the host's call, and leaves a summary that settles up", async () => {
    const { host, b, c } = await playing({ startChips: 100 });
    b.send({ t: "win", winners: [{ seat: 1, tai: 10 }], from: 2 });
    await host.room(atEvents(1));
    c.send({ t: "win", winners: [{ seat: 2, tai: 4 }], from: null });
    await host.room(atEvents(2));
    b.send({ t: "end" });
    expect(await b.error()).toMatchObject({ code: "notHost" });

    host.send({ t: "end" });
    const view = await c.room((v) => v.phase === "ended");
    const s = view.summary!;
    expect(s.hands).toBe(2);
    expect(s.net).toEqual(view.board!.net);
    expect(s.chips).toEqual(s.net.map((n) => 100 + n));
    expect(s.net.reduce((x, y) => x + y, 0)).toBe(0);
    expect(s.pot).toBe(0);
    // Applying the payments leaves everyone at zero.
    const after = s.net.slice();
    for (const p of s.settle) {
      after[p.from] += p.amount;
      after[p.to] -= p.amount;
    }
    expect(after).toEqual([0, 0, 0, 0]);
    expect(s.settle).toEqual(settle(Object.fromEntries(view.game!.seats.map((n, i) => [n, s.net[i]]))).map((p) => ({ from: view.game!.seats.indexOf(p.from), to: view.game!.seats.indexOf(p.to), amount: p.amount })));

    b.send({ t: "draw" });
    expect(await b.error()).toMatchObject({ code: "ended" });
    host.send({ t: "undo" });
    expect(await host.error()).toMatchObject({ code: "ended" });
  });
});

describe("persistence", () => {
  it("keeps everything when the room is evicted from memory, sockets and all", async () => {
    const { code, players, host, b } = await playing({ startChips: 300 });
    b.send({ t: "win", winners: [{ seat: 1, tai: 10 }], from: 2 });
    const before = await host.room(atEvents(1));

    // Hibernated sockets stay open across the eviction and keep working.
    await evictDurableObject(env.ROOMS.getByName(code));
    b.send({ t: "draw" });
    const afterEviction = await host.room(atEvents(2));
    expect(afterEviction.board!.net).toEqual(before.board!.net.map((n) => n - 5));

    // And a player coming back on a new connection gets the same room.
    const again = await join(code, "C", players[2].welcome.token);
    expect(again.welcome.seat).toBe(2);
    expect(again.room.board).toEqual(afterEviction.board);
    expect(again.room.game!.events).toHaveLength(2);
  });
});

describe("the summary with money left in the Jackpot", () => {
  it("says what's left in the pot, and settles only what players owe each other", async () => {
    const { host, b } = await playing();
    b.send({ t: "draw" });
    await host.room(atEvents(1));
    b.send({ t: "win", winners: [{ seat: 1, tai: 8 }], from: 0 });
    await host.room(atEvents(2));
    host.send({ t: "end" });
    const s = (await host.room((v) => v.phase === "ended")).summary!;
    expect(s.pot).toBe(20);
    // Each put 5 in; then dealer A, on a 連莊 after the draw, paid B
    // 8 + 莊 1 + 連莊 2 = 11.
    expect(s.net).toEqual([-16, 6, -5, -5]);
    expect(s.net.reduce((x, y) => x + y, 0) + s.pot).toBe(0);
    // B is owed 6 and gets it; the other 20 is the pot, not anyone's debt.
    expect(s.settle.reduce((x, p) => x + p.amount, 0)).toBe(6);
  });
});
