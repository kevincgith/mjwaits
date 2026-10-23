import { describe, expect, expectTypeOf, it } from "vitest";
import type { Claim, TurnMove } from "../engine/game";
import type { Infer } from "./schema";
import { ClaimSchema, DEFAULT_TABLE_SETTINGS, MoveSchema, parseTableMessage, TABLE_BOTS, type TableClientMessage } from "./table";

const parse = (m: unknown) => parseTableMessage(JSON.stringify(m));
const error = (m: unknown) => {
  const r = parse(m);
  return r.ok ? null : r.error;
};
const m5 = { suit: "m", rank: 5 } as const;

describe("parseTableMessage", () => {
  it("accepts every message in its documented shape", () => {
    const good: TableClientMessage[] = [
      { t: "hello", v: 2, name: "Kevin" },
      { t: "hello", v: 2, name: "Kevin", token: "0123456789abcdef0123456789abcdef", rid: "a" },
      { t: "sit", seat: 2 },
      { t: "stand" },
      { t: "setBot", seat: 3, bot: "grandmaster" },
      { t: "setBot", seat: 3, bot: null },
      { t: "setup", settings: DEFAULT_TABLE_SETTINGS },
      { t: "setup", settings: { multiWin: true, timer: 0, hold: 60, firstDealer: 2 } },
      { t: "start" },
      { t: "move", step: 7, move: { kind: "discard", tile: m5 } },
      { t: "move", step: 7, move: { kind: "discard", tile: { suit: "z", rank: 7 }, riichi: true } },
      { t: "move", step: 8, move: { kind: "selfDraw" } },
      { t: "move", step: 9, move: { kind: "concealedKong", tile: m5 } },
      { t: "move", step: 9, move: { kind: "addedKong", tile: m5 } },
      { t: "claim", step: 10, claim: null },
      { t: "claim", step: 10, claim: { kind: "win" } },
      { t: "claim", step: 10, claim: { kind: "pung" } },
      { t: "claim", step: 10, claim: { kind: "kong" } },
      { t: "claim", step: 10, claim: { kind: "chow", tiles: [{ suit: "m", rank: 4 }, { suit: "m", rank: 6 }] } },
      { t: "ready" },
      { t: "surrender", holder: 1 },
      { t: "end" },
      { t: "ping" },
    ];
    for (const m of good) expect(parse(m)).toEqual({ ok: true, value: m });
  });

  it("refuses moves and claims that aren't well formed", () => {
    expect(error({ t: "move", step: 1, move: { kind: "pass" } })).toBe("move.kind: unknown kind");
    expect(error({ t: "move", move: { kind: "selfDraw" } })).toBe("step: missing");
    expect(error({ t: "move", step: -1, move: { kind: "selfDraw" } })).toMatch(/^step: /);
    expect(error({ t: "move", step: 1, move: { kind: "discard", tile: { suit: "x", rank: 1 } } })).toMatch(/^move\.tile\.suit: /);
    expect(error({ t: "move", step: 1, move: { kind: "discard", tile: { suit: "m", rank: 10 } } })).toMatch(/^move\.tile\.rank: /);
    expect(error({ t: "move", step: 1, move: { kind: "discard", tile: { suit: "z", rank: 8 } } })).toBe("tile: honours are 1-7");
    expect(error({ t: "move", step: 1, move: { kind: "selfDraw", tile: m5 } })).toBe('move: unexpected field "tile"');
    expect(error({ t: "claim", step: 1 })).toBe("claim: missing");
    expect(error({ t: "claim", step: 1, claim: { kind: "chow", tiles: [m5] } })).toMatch(/^claim\.tiles: /);
    expect(error({ t: "claim", step: 1, claim: { kind: "chow", tiles: [{ suit: "z", rank: 1 }, { suit: "z", rank: 2 }] } })).toBe("claim: no chow of honours");
  });

  it("refuses an unknown bot, a timer off the list, and seats off the table", () => {
    expect(error({ t: "setBot", seat: 1, bot: "terminator" })).toMatch(/^bot: expected one of/);
    expect(error({ t: "setBot", seat: 4, bot: "veteran" })).toMatch(/^seat: /);
    expect(error({ t: "setup", settings: { ...DEFAULT_TABLE_SETTINGS, timer: 15 } })).toBe("settings.timer: one of 0, 10, 20, 30");
    expect(error({ t: "setup", settings: { ...DEFAULT_TABLE_SETTINGS, hold: 5 } })).toMatch(/^settings\.hold: /);
    expect(error({ t: "surrender", holder: 5 })).toMatch(/^holder: /);
  });

  // The table hands these to the engine: anything that passes must be one of
  // its moves (the engine's tiles also allow jokers, which a table never has),
  // and every kind of move and claim it has must be sendable.
  it("only lets through the engine's own moves and claims", () => {
    expectTypeOf<Infer<typeof MoveSchema>>().toMatchTypeOf<TurnMove>();
    expectTypeOf<Infer<typeof MoveSchema>["kind"]>().toEqualTypeOf<TurnMove["kind"]>();
    expectTypeOf<Infer<typeof ClaimSchema>["kind"]>().toEqualTypeOf<Claim["kind"]>();
    expectTypeOf<Exclude<Infer<typeof ClaimSchema>, { kind: "chow" }>>().toMatchTypeOf<Claim>();
    expect(TABLE_BOTS).toHaveLength(7);
  });
});
