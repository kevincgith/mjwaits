// A Scores-tab game (ledger.ts's ScoreGame) as the server checks it, coming
// from a phone that's sharing or recording into it.
//
// The shape follows ledger.ts field for field - protocol.test.ts holds the
// two together - with every bound the ledger relies on made explicit: four
// distinct seat names, seats 0-3, finite amounts, limited lengths. Unknown
// fields are dropped rather than refused (`strip`), so a game an older app
// version saved still goes up. And checkGame then replays it with the ledger
// itself: a record the ledger can't read is refused too.

import { replay, type ScoreGame } from "../engine/ledger";
import { array, bool, int, literal, nullable, num, object, oneOf, optional, str, tagged, type Infer, type Result } from "./schema";

// Long enough for any real evening's game, several times over.
export const MAX_EVENTS = 3000;
export const MAX_NAME = 64;

const strip = { strip: true };
const seat = int(0, 3);
const name = str(MAX_NAME, /\S/);
const amount = num(0, 1_000_000);
const at = num(0, 1e14); // a Date.now() timestamp
const batch = optional(str(64));
const text = (max: number) => optional(str(max));

const PatternNote = object({ id: str(64), name: str(64), tai: num(-1_000_000, 1_000_000) }, strip);
const WinnerEntry = object({ seat, tai: amount, patterns: optional(array(PatternNote, 0, 200)), rules: text(200) }, strip);
const Shares = array(object({ player: name, amount: num(-1_000_000, 1_000_000) }, strip), 0, 16);

const optNum = optional(amount);
const optNullNum = optional(nullable(amount));
const optBool = optional(bool);
// Every setting optional: the ledger fills a missing one with its default
// ({ ...DEFAULT_SETTINGS, ...settings }), as for a game saved before it existed.
export const SettingsSchema = object(
  {
    base: optNum,
    dealerTai: optNum,
    streakTai: optNum,
    fanXue: optBool,
    fanXueDouble: optNum,
    fanXueTriple: optNum,
    multiWinDouble: optNum,
    multiWinTriple: optNum,
    scoreCap: optNullNum,
    drawKeepsDealer: optBool,
    jackpot: optBool,
    jackpotPerDraw: optNum,
    integerMode: optBool,
    lahRound: optional(oneOf("up", "down")),
    tiRound: optional(oneOf("up", "down")),
    showLah: optBool,
    seatReminder: optBool,
    highScore: optNullNum,
    surrenderPrompt: optNullNum,
    showTally: optBool,
    quickScan: optBool,
    chipsPrompt: optBool,
    tipsAutoHide: optNullNum,
    bonusPresets: optBool,
    presetFlower: optNum,
    presetGrass: optNum,
    presetBoth: optNum,
    presetKong: optNum,
    presetChase: optNum,
    presetChaseBig: optNum,
    presetSnake: optNum,
    presetTriple: optNum,
    presetSevenOne: optNum,
    presetOneSeven: optNum,
    presetEightImmortals: optNum,
    presetWrongCall: optNum,
    zhaHu: optNullNum,
  },
  strip
);

export const EventSchema = tagged({
  win: object(
    { t: literal("win"), at, winners: array(WinnerEntry, 1, 3), from: nullable(seat), jackpotTo: optional(name), source: optional(oneOf("quick", "scoring")), batch },
    strip
  ),
  draw: object({ t: literal("draw"), at, batch }, strip),
  bonus: object({ t: literal("bonus"), at, seat, amount, kind: oneOf("獎", "罰"), other: optional(seat), name: text(64), batch }, strip),
  surrender: object({ t: literal("surrender"), at, holder: name, pulled: name, batch }, strip),
  jackpot: object({ t: literal("jackpot"), at, shares: Shares, batch }, strip),
  jackpotIn: object({ t: literal("jackpotIn"), at, shares: Shares, batch }, strip),
  zhaHu: object({ t: literal("zhaHu"), at, seat, pays: Shares, batch }, strip),
  swap: object({ t: literal("swap"), at, seats: array(name, 4, 4), batch }, strip),
  dealer: object(
    {
      t: literal("dealer"),
      at,
      seat,
      streak: int(0, 10_000),
      resetRound: bool,
      round: optional(object({ wind: int(-100, 100), hand: int(-100, 100) }, strip)),
      batch,
    },
    strip
  ),
  settings: object({ t: literal("settings"), at, settings: SettingsSchema, batch }, strip),
});

export const GameSchema = object(
  {
    id: str(64, /\S/),
    name: text(200),
    startedAt: at,
    endedAt: optional(at),
    startTime: text(16),
    endTime: text(16),
    location: text(200),
    seats: array(name, 4, 4),
    firstDealer: seat,
    settings: SettingsSchema,
    events: array(EventSchema, 0, MAX_EVENTS),
    undone: optional(array(EventSchema, 0, MAX_EVENTS)),
    updatedAt: optional(at),
  },
  strip
);

export type CheckedGame = Infer<typeof GameSchema>;

// A game as checked above, plus what the shape can't say: four different
// names (the ledger keys everything by name), and that the ledger can replay it.
export function checkGame(value: unknown): Result<ScoreGame> {
  const r = GameSchema.check(value, "game");
  if (!r.ok) return r;
  const game = r.value as ScoreGame;
  if (new Set(game.seats).size !== game.seats.length) return { ok: false, error: "game.seats: a name is there twice" };
  try {
    replay(game);
  } catch {
    return { ok: false, error: "game: the ledger can't replay it" };
  }
  return { ok: true, value: game };
}
