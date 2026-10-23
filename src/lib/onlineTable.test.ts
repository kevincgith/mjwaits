import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "@mjwaits/shared/protocol/limits";
import type { TableServerMessage, TableState } from "@mjwaits/shared/protocol/table";
import type { SocketLike } from "./online";
import { createTable, loadTables, saveTables, TableClient, tableFromSearch, tableInfo, tableToken, TABLES_KEY, withoutTable, withTable } from "./onlineTable";

class FakeSocket implements SocketLike {
  readyState = 0;
  sent: Record<string, unknown>[] = [];
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
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  deliver(msg: TableServerMessage) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}

const state = (version: number, step = 1): TableState => ({
  code: "3AC9X",
  version,
  phase: "playing",
  seats: [null, null, null, null],
  watching: 0,
  settings: { multiWin: false, timer: 20, hold: 30, firstDealer: 0 },
  totals: [0, 0, 0, 0],
  hand: 1,
  step,
  deadline: null,
  waitingOn: [],
  ready: [],
  auto: [],
  last: null,
  you: 0,
  view: null,
  options: null,
});

describe("TableClient", () => {
  it("joins the table's socket, keeps the newest state, and sends moves tagged with a request id", () => {
    const sockets: FakeSocket[] = [];
    const tables: TableState[] = [];
    const c = new TableClient({
      code: "3AC9X",
      name: "Kevin",
      token: "a".repeat(32),
      base: "https://mj-api.example",
      makeSocket: (url) => {
        const s = new FakeSocket(url);
        sockets.push(s);
        return s;
      },
      onTable: (t) => tables.push(t),
    });
    const s = sockets[0];
    expect(s.url).toBe("wss://mj-api.example/tables/3AC9X/ws");
    s.open();
    expect(s.sent[0]).toEqual({ t: "hello", v: PROTOCOL_VERSION, name: "Kevin", token: "a".repeat(32) });
    expect(c.send({ t: "ready" })).toBe(false); // not welcomed yet
    s.deliver({ t: "welcome", v: PROTOCOL_VERSION, token: "b".repeat(32), id: "0123456789abcdef", name: "Kevin", host: true, seat: 0 });
    s.deliver({ t: "table", table: state(3) });
    s.deliver({ t: "table", table: state(2) }); // a straggler
    s.deliver({ t: "table", table: state(4, 2) });
    expect(tables.map((t) => t.version)).toEqual([3, 4]);
    expect(c.table?.step).toBe(2);
    const rid = c.send({ t: "move", step: 2, move: { kind: "selfDraw" } });
    expect(s.sent.at(-1)).toEqual({ t: "move", step: 2, move: { kind: "selfDraw" }, rid });
    c.stop();
  });
});

describe("tables over HTTP and the device's memory", () => {
  it("makes and looks up tables", async () => {
    const calls: string[] = [];
    const fetcher = (async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.endsWith("/tables")) return new Response(JSON.stringify({ code: "3AC9X" }), { status: 201 });
      if (url.endsWith("/GONE1")) return new Response("", { status: 404 });
      return new Response(JSON.stringify({ phase: "lobby", seats: ["Kevin", null, null, null] }));
    }) as typeof fetch;
    expect(await createTable("https://x", fetcher)).toBe("3AC9X");
    expect(await tableInfo("3AC9X", "https://x", fetcher)).toEqual({ phase: "lobby", seats: ["Kevin", null, null, null] });
    expect(await tableInfo("GONE1", "https://x", fetcher)).toBeNull();
    expect(calls).toEqual(["POST https://x/tables", "GET https://x/tables/3AC9X", "GET https://x/tables/GONE1"]);
  });

  it("reads a table invite from the address", () => {
    expect(tableFromSearch("?table=3ac9x")).toBe("3AC9X");
    expect(tableFromSearch("?room=3AC9X")).toBeNull();
    expect(tableFromSearch("?table=nope!")).toBeNull();
  });

  it("remembers tables with their tokens, newest first, and forgets them", () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    let m = loadTables(storage);
    expect(m).toEqual({ name: "", tables: [] });
    m = withTable(withTable({ ...m, name: "Kevin" }, "AAAAA", "1".repeat(32)), "CCCCC", "2".repeat(32));
    m = withTable(m, "AAAAA", "3".repeat(32));
    saveTables(m, storage);
    const back = loadTables(storage);
    expect(back.tables.map((t) => t.code)).toEqual(["AAAAA", "CCCCC"]);
    expect(tableToken(back, "AAAAA")).toBe("3".repeat(32));
    expect(withoutTable(back, "AAAAA").tables.map((t) => t.code)).toEqual(["CCCCC"]);
    store.set(TABLES_KEY, "not json");
    expect(loadTables(storage).tables).toEqual([]);
  });
});
