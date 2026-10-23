// Who changed a live game, and how: the room's audit trail.
//
// Each change to a shared game is the whole game sent again, so the room
// works out what changed by comparing it with the game before (diffGames):
// entries added, removed, or replaced, and where. It keeps one AuditEntry per
// accepted change, with who made it. From that log, entryAuthors says who
// entered each entry now in the game, and who last edited it - for the
// 最近 list on every phone.

import type { ScoreEvent, ScoreGame } from "../engine/ledger";

export interface AuditEntry {
  v: number; // the gameVersion this change made
  at: number; // when the room took it
  by: string; // the person's name
  // share: the game went up (its entries, all the host's) · add / remove /
  // edit: entries changed · other: only the game's details (name, place…)
  kind: "share" | "add" | "remove" | "edit" | "other";
  from: number; // where in the entries it happened
  removed: number; // entries taken out there…
  added: number; // …and put in
  t: ScoreEvent["t"][]; // what the added entries are
}

export type AuditChange = Omit<AuditEntry, "v" | "at" | "by">;

// The same value written down the same way, whatever order its keys were in.
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

export function diffGames(before: ScoreGame | null, after: ScoreGame): AuditChange {
  if (!before) return { kind: "share", from: 0, removed: 0, added: after.events.length, t: after.events.map((e) => e.t) };
  const a = before.events.map(stableJson);
  const b = after.events.map(stableJson);
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const removed = a.length - p - s;
  const added = b.length - p - s;
  const kind = removed === 0 && added === 0 ? "other" : removed === 0 ? "add" : added === 0 ? "remove" : "edit";
  return { kind, from: p, removed, added, t: after.events.slice(p, p + added).map((e) => e.t) };
}

// For each entry in the game now: who put it in, and who last changed it
// (if someone did after). Built by replaying the log over the entries.
export function entryAuthors(log: AuditEntry[]): { by: string; editedBy?: string }[] {
  const owners: { by: string; editedBy?: string }[] = [];
  for (const e of log) {
    if (e.kind === "share") {
      owners.length = 0;
      for (let i = 0; i < e.added; i++) owners.push({ by: e.by });
      continue;
    }
    const replaced = owners.slice(e.from, e.from + e.removed);
    const added = Array.from({ length: e.added }, (_, i) =>
      // An entry replaced in place keeps its author: it was edited.
      e.kind === "edit" && replaced[i] ? { by: replaced[i].by, editedBy: e.by } : { by: e.by }
    );
    owners.splice(e.from, e.removed, ...added);
  }
  return owners;
}

const ENTRY_NAMES: Record<ScoreEvent["t"], string> = {
  win: "食胡",
  draw: "流局",
  bonus: "獎罰",
  surrender: "投降",
  jackpot: "Jackpot",
  jackpotIn: "Jackpot",
  zhaHu: "詐胡",
  swap: "換人",
  dealer: "莊家",
  settings: "設定",
};

// One line for the log, e.g. "added 食胡 (entry 5)".
export function describeChange(e: AuditEntry): string {
  const what = e.t.map((t) => ENTRY_NAMES[t]).join(", ");
  const at = (n: number) => (n === 1 ? `entry ${e.from + 1}` : `entries ${e.from + 1}-${e.from + n}`);
  switch (e.kind) {
    case "share":
      return e.added ? `shared the game (${e.added} ${e.added === 1 ? "entry" : "entries"})` : "shared the game";
    case "add":
      return `added ${what} (${at(e.added)})`;
    case "remove":
      return `took back ${at(e.removed)}`;
    case "edit":
      return e.removed === e.added ? `changed ${at(e.added)}${what ? ` (${what})` : ""}` : `replaced ${at(e.removed)} with ${what || "nothing"}`;
    case "other":
      return "changed the game's details";
  }
}
