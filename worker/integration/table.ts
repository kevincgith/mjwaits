// The integration test: four phones and someone watching play a whole hand
// at an online table, over real WebSockets, against `wrangler dev` - the
// Worker and its Durable Objects as they'll run on Cloudflare.
//
//   npm run test:dev --prefix worker              starts wrangler dev itself (bots and
//                                                 timers without pauses), then stops it
//   npm run test:dev --prefix worker -- --url http://127.0.0.1:8787
//                                                 against a wrangler dev already running
//
// It checks, on every message each phone is sent, that it holds only what
// its seat may see; that a phone dropping mid-hand gets its seat and tiles
// back with its token; that another site's page can't connect; and that the
// hand ends the same for everyone and the next is dealt.
//
// Plain Node (it runs TypeScript as is): the protocol's types come from
// shared/, nothing else does.

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Tile } from "@mjwaits/shared/engine/mahjong";
import type { TableServerMessage, TableState } from "@mjwaits/shared/protocol/table";

const PROTOCOL_VERSION = 2; // shared/protocol/limits.ts
const ORIGIN = "http://localhost:5173";
const PORT = 8799;
const PACE_MS = 250; // a phone answers no faster than this (the rate limit is 5 a second)
const HAND_TIMEOUT_MS = 120_000;

type Msg = TableServerMessage;

const args = process.argv.slice(2);
const given = args.includes("--url") ? args[args.indexOf("--url") + 1] : null;
const base = (given ?? `http://127.0.0.1:${PORT}`).replace(/\/$/, "");
const wsBase = base.replace(/^http/, "ws");

let failures = 0;
function check(ok: boolean, what: string) {
  if (!ok) {
    failures++;
    console.error(`  ✗ ${what}`);
  }
  return ok;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const same = (a: Tile, b: Tile) => a.suit === b.suit && a.rank === b.rank;

// ---- wrangler dev ---------------------------------------------------------------

async function startServer(): Promise<{ stop: () => void }> {
  if (given) return { stop: () => {} };
  const state = mkdtempSync(join(tmpdir(), "mjwaits-dev-"));
  const child: ChildProcess = spawn(
    "npx",
    ["wrangler", "dev", "--ip", "127.0.0.1", "--port", String(PORT), "--var", "TABLE_PAUSE_MS:0", "--persist-to", state, "--show-interactive-dev-session=false"],
    { cwd: new URL("..", import.meta.url).pathname, stdio: ["ignore", "pipe", "pipe"] }
  );
  let log = "";
  child.stdout!.on("data", (d) => (log += d));
  child.stderr!.on("data", (d) => (log += d));
  const stop = () => {
    child.kill("SIGINT");
    rmSync(state, { recursive: true, force: true });
  };
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      if ((await fetch(`${base}/health`)).ok) return { stop };
    } catch {
      // not up yet
    }
    if (child.exitCode !== null || Date.now() > deadline) {
      stop();
      throw new Error(`wrangler dev didn't start:\n${log}`);
    }
    await sleep(300);
  }
}

// ---- A phone ------------------------------------------------------------------------

class Phone {
  readonly name: string;
  ws!: WebSocket;
  states: TableState[] = [];
  errors: Extract<Msg, { t: "error" }>[] = [];
  token = "";
  answered = -1;
  sentAt = 0;
  private waiters: ((m: Msg) => boolean)[] = [];

  constructor(name: string) {
    this.name = name;
  }

  // Opens the socket and says hello (with its token, if it has one).
  async connect(code: string) {
    // Node's WebSocket takes headers: the Worker only lets in pages from allowed origins.
    this.ws = new WebSocket(`${wsBase}/tables/${code}/ws`, { headers: { Origin: ORIGIN } } as unknown as string[]);
    await new Promise<void>((ok, fail) => {
      this.ws.onopen = () => ok();
      this.ws.onerror = () => fail(new Error(`${this.name}: couldn't connect`));
    });
    this.ws.onmessage = (e) => {
      const m = JSON.parse(e.data as string) as Msg;
      if (m.t === "table") this.states.push(m.table);
      if (m.t === "error") {
        this.errors.push(m);
        if (m.code === "rateLimited") this.answered = -1; // dropped: answer again
      }
      this.waiters = this.waiters.filter((w) => !w(m));
    };
    const welcome = this.wait((m): m is Extract<Msg, { t: "welcome" }> => m.t === "welcome");
    const first = this.wait((m) => m.t === "table");
    this.send({ t: "hello", v: PROTOCOL_VERSION, name: this.name, ...(this.token ? { token: this.token } : {}) });
    const w = await welcome;
    this.token = w.token;
    await first;
    return w;
  }

  send(msg: unknown) {
    this.ws.send(JSON.stringify(msg));
  }

  wait<T extends Msg>(test: (m: Msg) => m is T, ms?: number): Promise<T>;
  wait(test: (m: Msg) => boolean, ms?: number): Promise<Msg>;
  wait(test: (m: Msg) => boolean, ms = 5000): Promise<Msg> {
    return new Promise((ok, fail) => {
      const timer = setTimeout(() => fail(new Error(`${this.name}: timed out waiting`)), ms);
      this.waiters.push((m) => {
        if (!test(m)) return false;
        clearTimeout(timer);
        ok(m);
        return true;
      });
    });
  }

  // The latest table state if it already passes `until`, else the next one that does.
  async table(until: (s: TableState) => boolean, ms?: number): Promise<TableState> {
    const now = this.latest;
    if (now && until(now)) return now;
    return ((await this.wait((m) => m.t === "table" && until(m.table), ms)) as Extract<Msg, { t: "table" }>).table;
  }

  get latest() {
    return this.states.at(-1);
  }

  async close() {
    this.ws.close(1000, "bye");
    await sleep(100);
  }
}

// What a simple player does: 自摸 or 食糊 when it can, 碰 when offered,
// otherwise throw the drawn tile (or the first it may); ready between hands.
function answer(p: Phone, s: TableState) {
  if (s.phase !== "playing" || s.you === null || !s.view || !s.waitingOn.includes(s.you) || p.answered === s.step) return;
  if (p.ws.readyState !== WebSocket.OPEN || Date.now() - p.sentAt < PACE_MS) return;
  p.answered = s.step;
  p.sentAt = Date.now();
  const v = s.view;
  if (v.phase.kind === "over") return p.send({ t: "ready" });
  const turn = s.options?.turn;
  if (turn) {
    if (turn.selfDraw) return p.send({ t: "move", step: s.step, move: { kind: "selfDraw" } });
    const drawn = v.phase.kind === "turn" ? v.phase.drawn : null;
    const tile = [...(drawn ? [drawn] : []), ...v.players[s.you].hand!].find((t) => !turn.forbidden.some((f) => same(f, t)))!;
    return p.send({ t: "move", step: s.step, move: { kind: "discard", tile } });
  }
  const claims = s.options?.claims ?? [];
  p.send({ t: "claim", step: s.step, claim: claims.find((c) => c.kind === "win") ?? claims.find((c) => c.kind === "pung") ?? null });
}

// Every message a phone was sent shows only what its seat may see.
function checkNoLeaks(p: Phone) {
  let bad = 0;
  for (const s of p.states) {
    if (/"wall"\s*:/.test(JSON.stringify(s))) bad++;
    if (!s.view) continue;
    const over = s.view.phase.kind === "over";
    s.view.players.forEach((pl, i) => {
      if (i !== s.you && !over && pl.hand !== null) bad++;
      if (i === s.you && !over && pl.hand === null) bad++;
      if (pl.hand && pl.hand.length !== pl.handCount) bad++;
    });
    if (s.view.phase.kind === "turn" && s.view.phase.seat !== s.you && (s.view.phase.drawn !== null || s.view.phase.forbidden)) bad++;
    if (s.options && (s.you === null || !s.waitingOn.includes(s.you))) bad++;
  }
  check(bad === 0, `${p.name}: ${bad} things it shouldn't see, over ${p.states.length} messages`);
}

// Two people and two bots, until a hand is won (the simple players above
// never build a hand; bots do): the result, its tai, and the payments.
async function untilSomeoneWins() {
  const made = await fetch(`${base}/tables`, { method: "POST", headers: { Origin: ORIGIN } });
  const { code } = (await made.json()) as { code: string };
  const phones = [new Phone("Kevin"), new Phone("Amy")];
  for (const p of phones) await p.connect(code);
  phones[0].send({ t: "sit", seat: 0 });
  phones[1].send({ t: "sit", seat: 2 });
  phones[0].send({ t: "setBot", seat: 1, bot: "grandmaster" });
  phones[0].send({ t: "setBot", seat: 3, bot: "speedster" });
  await phones[0].table((s) => s.seats.every(Boolean));
  phones[0].send({ t: "start" });
  await phones[0].table((s) => s.phase === "playing");
  const deadline = Date.now() + HAND_TIMEOUT_MS;
  for (;;) {
    for (const p of phones) if (p.latest) answer(p, p.latest);
    const won = phones[0].states.find((s) => s.view?.phase.kind === "over" && s.view.phase.result.winner !== null);
    if (won && won.view!.phase.kind === "over") {
      const r = won.view!.phase.result;
      check(r.score !== null && r.score.total > 0, `a won hand has its tai (${JSON.stringify(r.score)})`);
      check(r.deltas.reduce((a, b) => a + b, 0) === 0 && r.deltas.some((d) => d !== 0), `a won hand's payments add up to nothing: ${r.deltas}`);
      check(won.totals.reduce((a, b) => a + b, 0) === 0 && won.totals.some((t) => t !== 0), `totals move and add up to nothing: ${won.totals}`);
      const names = won.seats.map((x) => x?.name ?? "?");
      console.log(`With bots, hand ${won.hand}: ${names[r.winner!]} won${r.from === null ? " (自摸)" : ` off ${names[r.from]}`}, ${r.score?.total} 台 (${r.score?.patterns.map((x) => x.name).join(", ")}); totals ${won.totals.join(" / ")}`);
      break;
    }
    if (Date.now() > deadline) throw new Error("with bots: no one won in time");
    await sleep(5);
  }
  for (const p of phones) {
    checkNoLeaks(p);
    const unexpected = p.errors.filter((e) => e.code !== "rateLimited");
    check(unexpected.length === 0, `${p.name}: errors ${JSON.stringify(unexpected)}`);
    await p.close();
  }
}

// ---- The run ------------------------------------------------------------------------

async function main() {
  console.log(given ? `Against ${base}` : `Starting wrangler dev on ${base}…`);
  const server = await startServer();
  try {
    const t0 = Date.now();

    // Another site's page is turned away.
    const evil = await fetch(`${base}/tables`, { method: "POST", headers: { Origin: "https://evil.example" } });
    check(evil.status === 403, `another site's page making a table: expected 403, got ${evil.status}`);

    const made = await fetch(`${base}/tables`, { method: "POST", headers: { Origin: ORIGIN } });
    check(made.status === 201, `making a table: expected 201, got ${made.status}`);
    const { code } = (await made.json()) as { code: string };
    console.log(`Table ${code}`);

    const phones = ["Kevin", "Amy", "Ben", "Cat"].map((n) => new Phone(n));
    for (const p of phones) await p.connect(code);
    const watcher = new Phone("Dan");
    await watcher.connect(code);
    phones.forEach((p, seat) => p.send({ t: "sit", seat }));
    await phones[0].table((s) => s.seats.every(Boolean));
    phones[0].send({ t: "setup", settings: { multiWin: false, timer: 0, hold: 60, firstDealer: 0 } });
    await phones[0].table((s) => s.settings.hold === 60);
    phones[0].send({ t: "start" });
    await phones[0].table((s) => s.phase === "playing");
    console.log("Dealt; playing…");

    // Play; a third of the way into the hand, Ben's phone drops and comes back
    // (if the first hand ends too soon for that, early in the next).
    let dropped = false;
    const deadline = Date.now() + HAND_TIMEOUT_MS;
    for (;;) {
      for (const p of phones) if (p.latest) answer(p, p.latest);
      const s = phones[0].latest!;
      if (s.hand >= 2 && dropped) break;
      if (!dropped && s.view && s.view.phase.kind !== "over" && s.view.discardsMade >= (s.hand === 1 ? 20 : 4)) {
        dropped = true;
        const ben = phones[2];
        const before = ben.latest!.view!.players[2].hand!;
        await ben.close();
        await phones[0].table((n) => n.seats[2]?.kind === "human" && !n.seats[2].connected);
        const back = await ben.connect(code);
        check(back.seat === 2, `Ben back in seat 2 (got ${back.seat})`);
        const hand = ben.latest!.view!.players[2].hand;
        check(!!hand && hand.length >= before.length - 1, "Ben's tiles back after reconnecting");
        check(ben.latest!.seats[2]?.kind === "human" && ben.latest!.seats[2].connected === true, "Ben shown connected again");
        ben.answered = -1;
        console.log("Ben dropped and came back");
      }
      if (Date.now() > deadline) throw new Error(`stuck: step ${s.step}, waiting on ${s.waitingOn}, ${JSON.stringify(phones.map((p) => p.errors))}`);
      await sleep(5);
    }

    // The checks.
    for (const p of [...phones, watcher]) checkNoLeaks(p);
    for (const s of watcher.states) if (s.view && s.view.phase.kind !== "over") check(s.view.players.every((pl) => pl.hand === null), "Dan (watching) sees no hand");
    for (const p of phones) {
      const unexpected = p.errors.filter((e) => e.code !== "rateLimited");
      check(unexpected.length === 0, `${p.name}: errors ${JSON.stringify(unexpected)}`);
    }
    check(dropped, "the hand lasted long enough for Ben to drop");
    const ends = phones.map((p) => JSON.stringify(p.states.find((s) => s.view?.phase.kind === "over")?.view?.phase ?? null));
    check(ends[0] !== "null" && ends.every((e) => e === ends[0]), "everyone saw the hand end the same way");
    const end = phones[0].states.find((s) => s.view?.phase.kind === "over")!;
    const totals = phones[0].latest!.totals;
    check(totals.reduce((a, b) => a + b, 0) === 0, `totals add up to nothing: ${totals}`);

    const result = end.view!.phase.kind === "over" ? end.view!.phase.result : null;
    const outcome = !result || result.winner === null ? "流局" : `${phones[result.winner].name} won${result.from === null ? " (自摸)" : ` off ${phones[result.from].name}`}, ${result.score?.total ?? "?"} 台`;
    console.log(`Hand 1: ${outcome}; totals ${totals.join(" / ")}`);
    console.log(`Messages: ${phones.map((p) => `${p.name} ${p.states.length}`).join(", ")}, Dan ${watcher.states.length}; ${((Date.now() - t0) / 1000).toFixed(1)} s`);

    for (const p of [...phones, watcher]) await p.close();

    await untilSomeoneWins();
  } finally {
    server.stop();
  }
  if (failures) {
    console.error(`${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("All checks passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
