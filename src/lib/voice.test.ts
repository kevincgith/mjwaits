import { describe, expect, it } from "vitest";
import { OWN_VOICE, setYourVoice, tableVoices } from "./voice";

const STYLES = Object.keys(OWN_VOICE);
const voiceOf = (dir: string) => (dir.startsWith("you-") ? dir.slice(4) : dir.includes("-") ? dir.split("-")[1] : OWN_VOICE[dir]);

describe("a voice for each seat", () => {
  it("gives any three different bots three different voices", () => {
    for (let a = 0; a < STYLES.length; a++)
      for (let b = a + 1; b < STYLES.length; b++)
        for (let c = b + 1; c < STYLES.length; c++) {
          const seats = tableVoices([null, STYLES[a], STYLES[b], STYLES[c]], 0);
          const bots = seats.slice(1).map((v) => voiceOf(v!.dir));
          expect(new Set(bots).size, `${STYLES[a]} ${STYLES[b]} ${STYLES[c]}`).toBe(3);
        }
  });

  it("keeps a bot's own voice when nobody else has it", () => {
    expect(tableVoices([null, "grandmaster", "speedster", "casual"], 0).slice(1).map((v) => v!.dir)).toEqual(["grandmaster", "speedster", "casual"]);
  });

  it("gives you a voice in the kind you chose, one the bots aren't using", () => {
    setYourVoice("female");
    const seats = tableVoices([null, "casual", "grandmaster", "wall"], 0);
    const mine = voiceOf(seats[0]!.dir);
    expect(mine).toBe("hg"); // the one woman's voice the bots leave
    expect(seats.slice(1).map((v) => voiceOf(v!.dir))).not.toContain(mine);
    setYourVoice("male");
    expect(voiceOf(tableVoices([null, "casual", "grandmaster", "wall"], 0)[0]!.dir)).toBe("ys");
  });

  it("gives you a voice of the other kind sooner than one a bot has", () => {
    setYourVoice("female");
    // The bots take all three women's voices.
    const seats = tableVoices([null, "casual", "speedster", "wall"], 0);
    expect(["wl", "ys"]).toContain(voiceOf(seats[0]!.dir));
    setYourVoice("male");
  });

  it("still gives every seat a voice when they can't all differ", () => {
    const seats = tableVoices([null, "casual", "casual", "casual"], 0);
    expect(seats.every((v) => v !== null)).toBe(true);
  });
});
