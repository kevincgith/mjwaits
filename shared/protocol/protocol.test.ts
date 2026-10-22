import { describe, expect, expectTypeOf, it } from "vitest";
import { DEFAULT_ROOM_SETTINGS, parseClientMessage, type ClientMessage } from "./client";
import { cleanNickname, MAX_MESSAGE_BYTES, normalizeRoomCode, ROOM_CODE_ALPHABET } from "./limits";

const parse = (m: unknown) => parseClientMessage(JSON.stringify(m));
const error = (m: unknown) => {
  const r = typeof m === "string" ? parseClientMessage(m) : parse(m);
  return r.ok ? null : r.error;
};

describe("parseClientMessage", () => {
  it("accepts every message type in its documented shape", () => {
    const good: ClientMessage[] = [
      { t: "hello", v: 1, name: "Kevin" },
      { t: "hello", v: 1, name: "陳大文", token: "0123456789abcdef0123456789abcdef", rid: "r1" },
      { t: "sit", seat: 3 },
      { t: "stand" },
      { t: "setup", settings: DEFAULT_ROOM_SETTINGS },
      { t: "start" },
      { t: "win", winners: [{ seat: 0, tai: 12 }], from: null },
      { t: "win", winners: [{ seat: 0, tai: 5 }, { seat: 2, tai: 8 }], from: 1 },
      { t: "draw" },
      { t: "bonus", seat: 1, kind: "獎", amount: 5 },
      { t: "bonus", seat: 1, kind: "罰", amount: 30, other: 2 },
      { t: "undo" },
      { t: "undoVote", approve: true },
      { t: "end" },
      { t: "ping", rid: "x" },
    ];
    for (const m of good) expect(parse(m)).toEqual({ ok: true, value: m });
  });

  it("rejects frames that aren't a JSON object of a known type", () => {
    expect(parseClientMessage(new ArrayBuffer(4))).toEqual({ ok: false, error: "message: expected text" });
    expect(error("{nope")).toBe("message: not JSON");
    expect(error("[]")).toBe("message: expected an object");
    expect(error("null")).toBe("message: expected an object");
    expect(error({ t: "shuffle" })).toBe("t: unknown message type");
    expect(error({ t: "__proto__" })).toBe("t: unknown message type");
    expect(error({ seat: 1 })).toBe("t: unknown message type");
  });

  it("rejects missing, extra and mistyped fields", () => {
    expect(error({ t: "sit" })).toBe("seat: missing");
    expect(error({ t: "sit", seat: 1, admin: true })).toBe('message: unexpected field "admin"');
    expect(error({ t: "sit", seat: "1" })).toMatch(/^seat: expected a whole number/);
    expect(error({ t: "sit", seat: 1.5 })).toMatch(/^seat: expected a whole number/);
    expect(error({ t: "sit", seat: 4 })).toMatch(/^seat: expected a whole number 0-3/);
    expect(error({ t: "sit", seat: -1 })).toMatch(/^seat: /);
    expect(error({ t: "undoVote", approve: "yes" })).toBe("approve: expected true or false");
    expect(error({ t: "bonus", seat: 0, kind: "gift", amount: 5 })).toMatch(/^kind: expected one of 獎, 罰/);
    expect(error({ t: "bonus", seat: 0, kind: "獎", amount: 0 })).toMatch(/^amount: /);
    expect(error({ t: "win", winners: [{ seat: 0, tai: 1000 }], from: null })).toMatch(/^winners\[0\]\.tai: /);
    expect(error({ t: "win", winners: [], from: 1 })).toMatch(/^winners: expected 1-3 items/);
    expect(error({ t: "setup", settings: { ...DEFAULT_ROOM_SETTINGS, multiWin: "some" } })).toMatch(/^settings\.multiWin: /);
    const { hostCanUndo: _, ...partial } = DEFAULT_ROOM_SETTINGS;
    expect(error({ t: "setup", settings: partial })).toBe("settings.hostCanUndo: missing");
  });

  it("checks reconnect tokens and the rid", () => {
    expect(error({ t: "hello", v: 1, name: "A", token: "not-a-token" })).toBe("token: not in the expected form");
    expect(error({ t: "hello", v: 1, name: "A", token: "0123456789ABCDEF0123456789ABCDEF" })).toBe("token: not in the expected form");
    expect(error({ t: "ping", rid: "x".repeat(17) })).toBe("rid: longer than 16");
  });

  it("applies the rules a shape can't say", () => {
    expect(error({ t: "win", winners: [{ seat: 0, tai: 5 }, { seat: 2, tai: 5 }], from: null })).toBe("winners: a self-draw has one winner");
    expect(error({ t: "win", winners: [{ seat: 0, tai: 5 }, { seat: 0, tai: 6 }], from: 1 })).toBe("winners: a seat is listed twice");
    expect(error({ t: "win", winners: [{ seat: 1, tai: 5 }], from: 1 })).toBe("from: the discarder can't be a winner");
    expect(error({ t: "bonus", seat: 2, kind: "罰", amount: 5, other: 2 })).toBe("other: must be another player");
  });

  it("refuses anything over the size limit, counted in UTF-8 bytes", () => {
    const name = (n: number) => JSON.stringify({ t: "ping", rid: "a", pad: "x".repeat(n) });
    expect(error(name(MAX_MESSAGE_BYTES))).toBe("message: too large");
    // Under the limit in characters but over it in bytes: 3 bytes each.
    const cjk = JSON.stringify({ t: "hello", v: 1, name: "麻".repeat(Math.ceil(MAX_MESSAGE_BYTES / 3)) });
    expect(cjk.length).toBeLessThan(MAX_MESSAGE_BYTES);
    expect(error(cjk)).toBe("message: too large");
  });

  it("returns a fresh object, never the parsed input itself", () => {
    const r = parse({ t: "sit", seat: 2 });
    expect(r.ok && Object.getPrototypeOf(r.value)).toBe(Object.prototype);
  });

  it("types each message from its schema", () => {
    expectTypeOf<Extract<ClientMessage, { t: "win" }>>().toEqualTypeOf<{
      t: "win";
      winners: { seat: number; tai: number }[];
      from: number | null;
      rid?: string;
    }>();
  });
});

describe("cleanNickname", () => {
  it("trims, collapses spaces and keeps CJK", () => {
    expect(cleanNickname("  陳   大文 ")).toBe("陳 大文");
  });

  it("strips markup characters and invisible ones", () => {
    expect(cleanNickname("<b>Kev</b>")).toBe("bKev/b");
    expect(cleanNickname("A​B‮C\u0000D")).toBe("ABCD");
    expect(cleanNickname(`Tom "T" O'Neil & co`)).toBe("Tom T ONeil");
  });

  it("caps the length by what the reader sees", () => {
    expect(cleanNickname("一二三四五六七八九十甲乙丙")).toBe("一二三四五六七八九十甲乙");
    expect(cleanNickname("👨‍👩‍👧".repeat(13))).toBe("👨‍👩‍👧".repeat(12));
  });

  it("gives null when nothing usable is left", () => {
    expect(cleanNickname("   ")).toBeNull();
    expect(cleanNickname("<>&​")).toBeNull();
  });
});

describe("room codes", () => {
  it("accept any case and surrounding spaces, and only the code alphabet", () => {
    expect(normalizeRoomCode(" 3ac9x ")).toBe("3AC9X");
    expect(normalizeRoomCode("3AC9")).toBeNull();
    expect(normalizeRoomCode("3AC9XY")).toBeNull();
    expect(normalizeRoomCode("0OIL1")).toBeNull();
  });

  it("use no look-alike characters", () => {
    for (const c of "0O1IL5S2Z8B") expect(ROOM_CODE_ALPHABET).not.toContain(c);
    expect(new Set(ROOM_CODE_ALPHABET).size).toBe(ROOM_CODE_ALPHABET.length);
  });
});
