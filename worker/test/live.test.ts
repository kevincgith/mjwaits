// The live game: the host shares their Scores-tab game, others watch, the
// host lets some of them record, and changes made at the same moment don't
// overwrite each other.

import { env, evictDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { withEvent, type ScoreGame } from "@mjwaits/shared/engine/ledger";
import { sampleGame } from "@mjwaits/shared/protocol/sampleGame";
import { join, sharing } from "./helpers";

const plusDraw = (g: ScoreGame) => withEvent(g, { t: "draw", at: Date.now() });
const asSent = (g: ScoreGame) => JSON.parse(JSON.stringify(g));

describe("sharing a game", () => {
  it("puts the host's game up, with its colours, for everyone who joins", async () => {
    const { code, room, game } = await sharing();
    expect(room).toMatchObject({ phase: "live", gameVersion: 1, colors: { Amy: 1, Ben: 2 } });
    expect(room.game).toEqual(asSent(game));
    const amy = await join(code, "Amy");
    expect(amy.room.game).toEqual(asSent(game));
  });

  it("follows each change the host makes", async () => {
    const { code, host, game } = await sharing();
    const amy = await join(code, "Amy");
    const next = plusDraw(game);
    host.c.send({ t: "update", base: 1, game: next });
    const seen = await amy.c.room((v) => v.gameVersion === 2);
    expect(seen.game).toEqual(asSent(next));
  });

  it("drops what it doesn't know from an older app's game, and refuses what the ledger can't use", async () => {
    const { host, game } = await sharing();
    host.c.send({ t: "update", base: 1, game: { ...asSent(plusDraw(game)), oldField: 1 } });
    expect((await host.c.room((v) => v.gameVersion === 2)).game).not.toHaveProperty("oldField");
    host.c.send({ t: "update", base: 2, game: { ...asSent(game), seats: ["Amy", "Amy", "陳大文", "Dee"] } });
    expect(await host.c.error()).toMatchObject({ code: "badGame", message: "game.seats: a name is there twice" });
    host.c.send({ t: "update", base: 2, game: { ...asSent(game), id: "another" } });
    expect(await host.c.error()).toMatchObject({ code: "badGame" });
  });
});

describe("who may record", () => {
  it("is the host, plus whoever the host allows - and only for as long as they allow it", async () => {
    const { code, host, game } = await sharing();
    const amy = await join(code, "Amy");
    amy.c.send({ t: "update", base: 1, game: plusDraw(game) });
    expect(await amy.c.error()).toMatchObject({ code: "notAllowed" });

    host.c.send({ t: "setRecorder", person: amy.welcome.id, allow: true });
    expect((await amy.c.room((v) => v.people[1]?.canRecord === true)).people[1].canRecord).toBe(true);
    amy.c.send({ t: "update", base: 1, game: plusDraw(game) });
    expect((await host.c.room((v) => v.gameVersion === 2)).game!.events).toHaveLength(game.events.length + 1);

    host.c.send({ t: "setRecorder", person: amy.welcome.id, allow: false });
    await amy.c.room((v) => v.people[1]?.canRecord === false);
    amy.c.send({ t: "update", base: 2, game: plusDraw(plusDraw(game)) });
    expect(await amy.c.error()).toMatchObject({ code: "notAllowed" });
  });

  it("is decided by the host alone, about people who are here", async () => {
    const { code, host } = await sharing();
    const amy = await join(code, "Amy");
    const ben = await join(code, "Ben");
    amy.c.send({ t: "setRecorder", person: ben.welcome.id, allow: true });
    expect(await amy.c.error()).toMatchObject({ code: "notHost" });
    host.c.send({ t: "setRecorder", person: "0123456789abcdef", allow: true });
    expect(await host.c.error()).toMatchObject({ code: "noSuchPerson" });
  });

  it("doesn't let a recorder put up the game before the host has, or change the colours", async () => {
    const { code, host, game } = await sharing();
    const amy = await join(code, "Amy");
    host.c.send({ t: "setRecorder", person: amy.welcome.id, allow: true });
    await amy.c.room((v) => v.people[1]?.canRecord === true);
    amy.c.send({ t: "update", base: 1, game: plusDraw(game), colors: { Amy: 7 } });
    expect((await host.c.room((v) => v.gameVersion === 2)).colors).toEqual({ Amy: 1, Ben: 2 });
  });
});

describe("two changes at once", () => {
  it("takes the first and refuses the second, which was made on the older game", async () => {
    const { code, host, game } = await sharing();
    const amy = await join(code, "Amy");
    host.c.send({ t: "setRecorder", person: amy.welcome.id, allow: true });
    await amy.c.room((v) => v.people[1]?.canRecord === true);

    const hostVersion = plusDraw(game);
    const amyVersion = withEvent(game, { t: "bonus", at: Date.now(), seat: 0, kind: "獎", amount: 5 });
    host.c.send({ t: "update", base: 1, game: hostVersion });
    amy.c.send({ t: "update", base: 1, game: amyVersion });
    expect(await amy.c.error()).toMatchObject({ code: "conflict" });
    const seen = await amy.c.room((v) => v.gameVersion === 2);
    expect(seen.game).toEqual(asSent(hostVersion));
    // On the new game, Amy's goes in.
    amy.c.send({ t: "update", base: 2, game: withEvent(hostVersion, amyVersion.events.at(-1)!) });
    expect((await host.c.room((v) => v.gameVersion === 3)).game!.events.at(-1)).toMatchObject({ t: "bonus" });
  });
});

describe("stopping", () => {
  it("leaves the game up, read-only, for everyone", async () => {
    const { code, host, game } = await sharing();
    const amy = await join(code, "Amy");
    amy.c.send({ t: "stop" });
    expect(await amy.c.error()).toMatchObject({ code: "notHost" });
    host.c.send({ t: "stop" });
    const view = await amy.c.room((v) => v.phase === "ended");
    expect(view.game).toEqual(asSent(game));
    host.c.send({ t: "update", base: 1, game: plusDraw(game) });
    expect(await host.c.error()).toMatchObject({ code: "ended" });
  });
});

describe("persistence", () => {
  it("keeps everything when the room is evicted from memory, sockets and all", async () => {
    const { code, host, game } = await sharing(sampleGame());
    const amy = await join(code, "Amy");
    await evictDurableObject(env.ROOMS.getByName(code));
    // Hibernated sockets stay open across the eviction and keep working.
    host.c.send({ t: "update", base: 1, game: plusDraw(game) });
    const seen = await amy.c.room((v) => v.gameVersion === 2);
    expect(seen.game!.events).toHaveLength(game.events.length + 1);
    const again = await join(code, "x", amy.welcome.token);
    expect(again.room.game).toEqual(seen.game);
  });
});
