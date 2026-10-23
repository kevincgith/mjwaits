import { describe, expect, it } from "vitest";
import { newGame, withEvent, type ScoreStore } from "@mjwaits/shared/engine/ledger";
import { decodeFull, decodeSnapshot, encodeFull, encodeSnapshot, fullSnapshotOf, fullSnapshotUrl, snapshotFromAnyHash, snapshotFromHash, snapshotOf, snapshotUrl } from "./scoreShare";

const store = (): ScoreStore => {
  let g = newGame(["凱文", "Mandy", "Kelvin", "Ah Wing"], 0, { base: 0, dealerTai: 0, streakTai: 0, jackpot: false } as never);
  g = withEvent(g, { t: "win", at: 1, winners: [{ seat: 1, tai: 8 }], from: 0, source: "quick" });
  g = withEvent(g, { t: "win", at: 2, winners: [{ seat: 1, tai: 3 }], from: null, source: "quick" });
  return { active: { ...g, name: "週一" }, history: [], roster: [{ name: "Mandy", color: 3 }], settings: g.settings };
};

describe("share snapshot", () => {
  it("captures the table, totals, 胡摸銃 and the settle-up", () => {
    const s = store();
    const snap = snapshotOf(s, s.active!, 100);
    expect(snap).toMatchObject({ v: 1, name: "週一", at: 100, hands: 2, dealer: "Mandy" });
    expect(snap.players.find((p) => p.n === "Mandy")).toMatchObject({ w: 2, s: 1, d: 0, c: 3 });
    expect(snap.players.find((p) => p.n === "凱文")).toMatchObject({ d: 1, c: -1 });
    expect(snap.players.reduce((t, p) => t + p.t, 0)).toBe(0);
    expect(snap.pays.length).toBeGreaterThan(0);
  });

  it("round-trips through a URL, Chinese names and all", () => {
    const s = store();
    const snap = snapshotOf(s, s.active!, 100);
    const url = snapshotUrl(snap, "https://example.test/mjwaits/");
    expect(url).toMatch(/^https:\/\/example\.test\/mjwaits\/#s=[\w-]+$/);
    expect(snapshotFromHash(url.slice(url.indexOf("#")))).toEqual(snap);
    expect(decodeSnapshot(encodeSnapshot(snap))).toEqual(snap);
  });

  it("ignores anything that isn't a snapshot", () => {
    expect(snapshotFromHash("#s=not-base64!!")).toBeNull();
    expect(snapshotFromHash("#other")).toBeNull();
    expect(decodeSnapshot(encodeSnapshot({ v: 2 } as never))).toBeNull();
  });

  it("v2 carries the whole game, compressed, and reads back exactly", async () => {
    const s = store();
    const full = fullSnapshotOf(s, s.active!, 100);
    expect(full.v).toBe(2);
    expect(full.game?.events).toHaveLength(2);
    expect(full.colors).toEqual({ Mandy: 3 });
    expect(await decodeFull(await encodeFull(full))).toEqual(full);
    const url = await fullSnapshotUrl(full, "https://example.test/mjwaits/");
    expect(url).toMatch(/#z=[\w-]+$/);
    expect(await snapshotFromAnyHash(url.slice(url.indexOf("#")))).toEqual(full);
    // Old #s= links still read.
    const old = snapshotUrl(snapshotOf(s, s.active!, 100), "https://example.test/mjwaits/");
    expect((await snapshotFromAnyHash(old.slice(old.indexOf("#"))))?.v).toBe(1);
  });

  it("keeps a night's game short enough for a QR code", async () => {
    const s = store();
    let g = s.active!;
    for (let i = 0; i < 40; i++) g = withEvent(g, { t: "win", at: 1792000000000 + i * 60000, winners: [{ seat: i % 4, tai: 3 + (i % 7) }], from: i % 3 ? (i + 1) % 4 : null, source: "quick" });
    const url = await fullSnapshotUrl(fullSnapshotOf(s, g, 100), "https://kevincgith.github.io/mjwaits/");
    expect(url.length).toBeLessThan(2900);
  });

  it("ignores a #z= that isn't a game", async () => {
    expect(await snapshotFromAnyHash("#z=bm90LWRlZmxhdGU")).toBeNull();
  });
});
