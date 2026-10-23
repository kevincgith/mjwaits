// The web app's side of an online table (worker/src/table.ts): making and
// looking up tables, the live connection (TableClient), the invite link, and
// this device's memory of the tables it sat at (with their reconnect tokens,
// so a reload or a dropped signal puts you straight back in your seat).
//
// No React here; OnlineTable.tsx turns it into a screen.

import type { ScoreGame } from "@mjwaits/shared/engine/ledger";
import { normalizeRoomCode } from "@mjwaits/shared/protocol/limits";
import type { TableClientMessage, TableServerMessage, TableState } from "@mjwaits/shared/protocol/table";
import { HubClient, serverBase, type HubClientOptions } from "./online";

// ---- Over HTTP -------------------------------------------------------------------

export async function createTable(base = serverBase(), fetcher: typeof fetch = fetch): Promise<string> {
  const res = await fetcher(`${base}/tables`, { method: "POST" });
  if (!res.ok) throw new Error(res.status === 403 ? "This page isn't allowed to make tables" : "Couldn't make a table - try again");
  return ((await res.json()) as { code: string }).code;
}

export type TableInfo = { phase: TableState["phase"]; seats: (string | null)[] };

// A table's phase and who's sitting where, or null for a code no one has made.
export async function tableInfo(code: string, base = serverBase(), fetcher: typeof fetch = fetch): Promise<TableInfo | null> {
  const res = await fetcher(`${base}/tables/${code}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error("Couldn't reach the server");
  return (await res.json()) as TableInfo;
}

// The table's record - its hands as a Scores-tab game - or null before the first deal.
export async function tableScores(code: string, base = serverBase(), fetcher: typeof fetch = fetch): Promise<ScoreGame | null> {
  const res = await fetcher(`${base}/tables/${code}/scores`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error("Couldn't reach the server");
  return (await res.json()) as ScoreGame;
}

// The link that opens the app at this table.
export function tableLink(code: string): string {
  return `${window.location.origin}${import.meta.env.BASE_URL}?table=${code}`;
}

export function tableFromSearch(search: string): string | null {
  const raw = new URLSearchParams(search).get("table");
  return raw ? normalizeRoomCode(raw) : null;
}

// ---- This device's memory ----------------------------------------------------------

export const TABLES_KEY = "mjwaits.tables";
const MEMORY_DAYS = 7;

export interface TableMemory {
  name: string;
  tables: { code: string; token: string; at: number }[]; // newest first
}

export function loadTables(storage: Pick<Storage, "getItem"> | null = safeStorage()): TableMemory {
  try {
    const saved = JSON.parse(storage?.getItem(TABLES_KEY) ?? "null") as Partial<TableMemory> | null;
    const cutoff = Date.now() - MEMORY_DAYS * 24 * 60 * 60 * 1000;
    return {
      name: typeof saved?.name === "string" ? saved.name : "",
      tables: Array.isArray(saved?.tables)
        ? saved.tables.filter((t) => t && typeof t.code === "string" && typeof t.token === "string" && typeof t.at === "number" && t.at > cutoff)
        : [],
    };
  } catch {
    return { name: "", tables: [] };
  }
}

export function saveTables(memory: TableMemory, storage: Pick<Storage, "setItem"> | null = safeStorage()) {
  try {
    storage?.setItem(TABLES_KEY, JSON.stringify(memory));
  } catch {
    // Full or blocked: the table still works, it just won't be remembered.
  }
}

function safeStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export const tableToken = (memory: TableMemory, code: string) => memory.tables.find((t) => t.code === code)?.token;

export const withTable = (memory: TableMemory, code: string, token: string): TableMemory => ({
  ...memory,
  tables: [{ code, token, at: Date.now() }, ...memory.tables.filter((t) => t.code !== code)].slice(0, 10),
});

export const withoutTable = (memory: TableMemory, code: string): TableMemory => ({ ...memory, tables: memory.tables.filter((t) => t.code !== code) });

// ---- The live connection ------------------------------------------------------------

export interface TableClientOptions extends HubClientOptions<TableServerMessage> {
  onTable?: (table: TableState) => void;
}

export class TableClient extends HubClient<TableClientMessage, TableServerMessage> {
  table: TableState | null = null;
  private readonly onTable?: (table: TableState) => void;

  constructor(opts: TableClientOptions) {
    super("tables", opts);
    this.onTable = opts.onTable;
  }

  protected exists(code: string) {
    return tableInfo(code, this.opts.base).then((t) => t !== null);
  }

  protected receive(msg: TableServerMessage) {
    if (msg.t !== "table") return;
    if (this.table && msg.table.version < this.table.version) return; // a straggler
    this.table = msg.table;
    this.onTable?.(msg.table);
  }
}
