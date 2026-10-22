// Recording your own play at the Play table, for training a learned bot that
// plays like you (ml/README.md, step 4). Off unless you switch it on; it
// stays in this browser (IndexedDB) until you export it.
//
// Each decision is stored as the same encoding the bot data uses
// (encode.ts): what you could see, which actions were legal, what you
// chose - and, once the hand ends, how it went for you. Export writes one
// JSON line per decision (arrays base64) that ml/human.py turns into
// training shards.

import { NUM_ACTIONS, NUM_PLANES, OBS_SIZE } from "./encode";

const DB = "mjwaits-ml";
const STORE = "decisions";

export interface HumanDecision {
  obs: Uint8Array;
  mask: Uint8Array;
  action: number;
  kind: 0 | 1; // 0 your turn, 1 a claim
  hand: string; // which hand it belongs to, so the outcome can be filled in
  handNet: number | null; // your net tai for that hand, once it's over
  at: number;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      const store = req.result.createObjectStore(STORE, { keyPath: "id", autoIncrement: true });
      store.createIndex("hand", "hand");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = run(t.objectStore(STORE));
    t.oncomplete = () => resolve(req ? req.result : undefined);
    t.onerror = () => reject(t.error);
  });
}

// Never lets a storage problem get in the way of the game.
const quietly = async <T>(work: () => Promise<T>, fallback: T): Promise<T> => {
  try {
    return await work();
  } catch {
    return fallback;
  }
};

export function recordDecision(d: Omit<HumanDecision, "handNet" | "at">): Promise<void> {
  if (d.obs.length !== OBS_SIZE || d.mask.length !== NUM_ACTIONS) return Promise.resolve();
  return quietly(async () => {
    await tx("readwrite", (s) => s.add({ ...d, obs: Array.from(d.obs), mask: Array.from(d.mask), handNet: null, at: Date.now() }));
  }, undefined);
}

// Fills in how a hand went for every decision recorded in it.
export function finishHand(hand: string, handNet: number): Promise<void> {
  return quietly(async () => {
    const db = await open();
    await new Promise<void>((resolve, reject) => {
      const t = db.transaction(STORE, "readwrite");
      const cursor = t.objectStore(STORE).index("hand").openCursor(IDBKeyRange.only(hand));
      cursor.onsuccess = () => {
        const c = cursor.result;
        if (!c) return;
        c.update({ ...c.value, handNet });
        c.continue();
      };
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
  }, undefined);
}

export function countRecorded(): Promise<number> {
  return quietly(async () => (await tx<number>("readonly", (s) => s.count())) ?? 0, 0);
}

const b64 = (bytes: number[]) => btoa(String.fromCharCode(...bytes));

// One JSON line per finished decision; decisions from an unfinished hand are
// left out.
export async function exportRecorded(): Promise<{ text: string; count: number }> {
  const rows = (await quietly(async () => (await tx<unknown[]>("readonly", (s) => s.getAll())) ?? [], [] as unknown[])) as (Omit<HumanDecision, "obs" | "mask"> & { obs: number[]; mask: number[] })[];
  const done = rows.filter((r) => r.handNet !== null);
  const header = JSON.stringify({ format: "mjwaits-human-v1", obsSize: OBS_SIZE, numPlanes: NUM_PLANES, numActions: NUM_ACTIONS, count: done.length });
  const lines = done.map((r) => JSON.stringify({ obs: b64(r.obs), mask: b64(r.mask), action: r.action, kind: r.kind, handNet: r.handNet, at: r.at }));
  return { text: [header, ...lines].join("\n") + "\n", count: done.length };
}

export function clearRecorded(): Promise<void> {
  return quietly(async () => {
    await tx("readwrite", (s) => s.clear());
  }, undefined);
}
