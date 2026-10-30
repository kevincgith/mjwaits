import { describe, expect, expectTypeOf, it } from "vitest";
import type { ScoreEvent, ScoreGame, ScoreSettings } from "../engine/ledger";
import { parseClientMessage, type ClientMessage } from "./client";
import { checkGame, EventSchema, GameSchema, MAX_EVENTS, MAX_UNDONE, SettingsSchema } from "./game";
import { cleanNickname, MAX_MESSAGE_BYTES, normalizeRoomCode, ROOM_CODE_ALPHABET } from "./limits";
import type { Infer } from "./schema";
import { sampleGame } from "./sampleGame";

const parse = (m: unknown) => parseClientMessage(JSON.stringify(m));
const error = (m: unknown) => {
  const r = typeof m === "string" ? parseClientMessage(m) : parse(m);
  return r.ok ? null : r.error;
};

describe("parseClientMessage", () => {
  it("accepts every message type in its documented shape", () => {
    const good: ClientMessage[] = [
      { t: "hello", v: 2, name: "Kevin" },
      { t: "hello", v: 2, name: "陳大文", token: "0123456789abcdef0123456789abcdef", rid: "r1" },
      { t: "update", base: 0, game: sampleGame() },
      { t: "update", base: 7, game: sampleGame(), colors: { Amy: 0, Ben: 3 } },
      { t: "setRecorder", person: "0123456789abcdef", allow: true },
      { t: "stop" },
      { t: "resume" },
      { t: "ping", rid: "x" },
    ];
    for (const m of good) expect(parse(m)).toEqual({ ok: true, value: JSON.parse(JSON.stringify(m)) });
  });

  it("rejects frames that aren't a JSON object of a known type", () => {
    expect(parseClientMessage(new ArrayBuffer(4))).toEqual({ ok: false, error: "message: expected text" });
    expect(error("{nope")).toBe("message: not JSON");
    expect(error("[]")).toBe("message: expected an object");
    expect(error({ t: "win" })).toBe("t: unknown message type"); // the old scoreboard messages are gone
    expect(error({ t: "__proto__" })).toBe("t: unknown message type");
  });

  it("is strict about the message itself", () => {
    expect(error({ t: "stop", admin: true })).toBe('message: unexpected field "admin"');
    expect(error({ t: "setRecorder", person: "nope", allow: true })).toBe("person: not in the expected form");
    expect(error({ t: "setRecorder", person: "0123456789abcdef" })).toBe("allow: missing");
    expect(error({ t: "update", base: -1, game: sampleGame() })).toMatch(/^base: /);
    expect(error({ t: "update", base: 0, game: sampleGame(), colors: { Amy: 9 } })).toMatch(/^colors\.Amy: /);
    expect(error({ t: "hello", v: 2, name: "A", token: "not-a-token" })).toBe("token: not in the expected form");
    expect(error({ t: "ping", rid: "x".repeat(17) })).toBe("rid: longer than 16");
  });

  it("refuses anything over the size limit, counted in UTF-8 bytes", () => {
    expect(error(JSON.stringify({ t: "ping", pad: "x".repeat(MAX_MESSAGE_BYTES) }))).toBe("message: too large");
    const cjk = JSON.stringify({ t: "hello", v: 2, name: "麻".repeat(Math.ceil(MAX_MESSAGE_BYTES / 3)) });
    expect(cjk.length).toBeLessThan(MAX_MESSAGE_BYTES);
    expect(error(cjk)).toBe("message: too large");
  });

  it("fits a game at the entry cap", () => {
    const g = sampleGame();
    const at = g.startedAt;
    const big = { ...g, events: Array.from({ length: MAX_EVENTS }, (_, i): ScoreEvent => (i % 3 ? { t: "draw", at } : { t: "win", at, winners: [{ seat: i % 4, tai: 88 }], from: null, source: "quick" })) };
    expect(parse({ t: "update", base: 123456, game: big }).ok).toBe(true);
  });

  it("fits a game at both entry caps, every entry a Play table's win with its patterns", () => {
    const g = sampleGame();
    const at = g.startedAt;
    const patterns = ["底", "莊", "門前清 Concealed", "自摸 Self-drawn", "清一色 Full Flush", "對對糊 All Pungs", "花 Flower"].map((name, i) => ({ id: `pattern-${i}`, name, tai: i + 1 }));
    const win = (i: number): ScoreEvent => ({ t: "win", at, winners: [{ seat: i % 4, tai: 28, patterns }], from: i % 4 === 0 ? null : 0, source: "scoring", dealerExtra: 1 });
    const big = { ...g, events: Array.from({ length: MAX_EVENTS }, (_, i) => win(i)), undone: Array.from({ length: MAX_UNDONE }, (_, i) => win(i)) };
    const frame = JSON.stringify({ t: "update", base: 123456, game: big });
    expect(new TextEncoder().encode(frame).length / (MAX_EVENTS + MAX_UNDONE)).toBeGreaterThan(400); // (as big as they come, on average)
    expect(parseClientMessage(frame).ok).toBe(true);
  });
});

describe("a game, as the server checks it", () => {
  it("takes what the Scores tab writes, unchanged", () => {
    const g = sampleGame();
    expect(checkGame(JSON.parse(JSON.stringify(g)))).toEqual({ ok: true, value: JSON.parse(JSON.stringify(g)) });
  });

  it("drops fields it doesn't know, from older or newer app versions", () => {
    const g = { ...JSON.parse(JSON.stringify(sampleGame())), legacy: 1 };
    g.events[0].oldField = "x";
    g.settings.removedSetting = true;
    const r = checkGame(g);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).not.toHaveProperty("legacy");
    expect(r.value.events[0]).not.toHaveProperty("oldField");
    expect(r.value.settings).not.toHaveProperty("removedSetting");
  });

  it("takes an old game missing settings added since", () => {
    const g = JSON.parse(JSON.stringify(sampleGame()));
    g.settings = { base: 0, dealerTai: 1 };
    expect(checkGame(g).ok).toBe(true);
  });

  it("refuses what the ledger couldn't use", () => {
    const bad = (mutate: (g: any) => void) => {
      const g = JSON.parse(JSON.stringify(sampleGame()));
      mutate(g);
      const r = checkGame(g);
      return r.ok ? null : r.error;
    };
    expect(bad((g) => g.seats.pop())).toBe("game.seats: expected 4-4 items");
    expect(bad((g) => (g.seats[3] = "Amy"))).toBe("game.seats: a name is there twice");
    expect(bad((g) => (g.seats[1] = "  "))).toBe("game.seats[1]: not in the expected form");
    expect(bad((g) => (g.firstDealer = 4))).toMatch(/^game\.firstDealer: /);
    expect(bad((g) => (g.events[0].winners[0].seat = 7))).toMatch(/^game\.events\[0\]\.winners\[0\]\.seat: /);
    expect(bad((g) => (g.events[0].winners[0].tai = null))).toMatch(/^game\.events\[0\]\.winners\[0\]\.tai: /);
    expect(bad((g) => (g.events[1].t = "teleport"))).toBe("game.events[1].t: unknown message type");
    expect(bad((g) => (g.events[3].kind = "gift"))).toMatch(/^game\.events\[3\]\.kind: /);
    expect(bad((g) => (g.settings.lahRound = "sideways"))).toMatch(/^game\.settings\.lahRound: /);
    expect(bad((g) => (g.events = Array(MAX_EVENTS + 1).fill({ t: "draw", at: 1 })))).toMatch(/^game\.events: /);
    expect(bad((g) => (g.name = "x".repeat(201)))).toBe("game.name: longer than 200");
  });

  // If the ledger gains a field, these fail until the schema has it too -
  // otherwise the server would quietly drop it from every shared game.
  it("has exactly the ledger's fields", () => {
    type Keys<T> = T extends unknown ? keyof T : never;
    expectTypeOf<keyof Infer<typeof GameSchema>>().toEqualTypeOf<keyof ScoreGame>();
    expectTypeOf<keyof Infer<typeof SettingsSchema>>().toEqualTypeOf<keyof ScoreSettings>();
    expectTypeOf<Infer<typeof EventSchema>["t"]>().toEqualTypeOf<ScoreEvent["t"]>();
    type Ev<T extends ScoreEvent["t"]> = Extract<ScoreEvent, { t: T }>;
    type Checked<T extends ScoreEvent["t"]> = Extract<Infer<typeof EventSchema>, { t: T }>;
    expectTypeOf<Keys<Checked<"win">>>().toEqualTypeOf<Keys<Ev<"win">>>();
    expectTypeOf<Keys<Checked<"bonus">>>().toEqualTypeOf<Keys<Ev<"bonus">>>();
    expectTypeOf<Keys<Checked<"dealer">>>().toEqualTypeOf<Keys<Ev<"dealer">>>();
    expectTypeOf<Keys<Checked<"zhaHu">>>().toEqualTypeOf<Keys<Ev<"zhaHu">>>();
    expectTypeOf<Keys<Checked<"swap">>>().toEqualTypeOf<Keys<Ev<"swap">>>();
    expectTypeOf<Keys<Checked<"surrender">>>().toEqualTypeOf<Keys<Ev<"surrender">>>();
    expectTypeOf<Keys<Checked<"jackpot">>>().toEqualTypeOf<Keys<Ev<"jackpot">>>();
    expectTypeOf<Keys<Checked<"settings">>>().toEqualTypeOf<Keys<Ev<"settings">>>();
    // And anything the Scores tab makes passes as far as types go.
    expectTypeOf<ScoreGame>().toMatchTypeOf<Infer<typeof GameSchema>>();
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
