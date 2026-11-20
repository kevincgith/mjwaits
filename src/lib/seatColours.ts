import { learnedStyle, mysteryStyle, type BotProfile } from "@mjwaits/shared/engine/bots";

// Each seat's colour at the Play table, a pair: `plaque`, deep, for its
// avatar on the dark plaque (white letter on it); `felt`, light, for its
// marks on the green felt (the 叮 bars) - the same colour lifted, so a bar
// reads as its player's.
export type SeatColour = { plaque: string; felt: string };

// Each personality's (as .play-avatar.is-<id>). Casual's green would vanish
// on the felt, and the Hunter's gold and the Speedster's orange are too
// like your gold: those sit at the table in a spare.
const BOT_COLOURS: Record<string, SeatColour | null> = {
  grandmaster: { plaque: "#7a4fb0", felt: "#d2a8ff" },
  veteran: { plaque: "#2f6fb5", felt: "#6fb8ff" },
  speedster: null,
  hunter: null,
  wall: { plaque: "#5b6670", felt: "#e3e8ec" },
  gambler: { plaque: "#b3261e", felt: "#ff8585" },
  casual: null,
};
// A mystery bot's grey (the Iron Wall's silver on the felt - they count as one).
const MYSTERY: SeatColour = { plaque: "#5d6670", felt: "#e3e8ec" };
export const YOUR_COLOUR: SeatColour = { plaque: "#ffd166", felt: "#ffd166" };
// For a seat whose own would be too like another's (or there's none): the
// first of these far enough from every colour already at the table.
const SPARES: SeatColour[] = [
  { plaque: "#c2185b", felt: "#ff86cc" },
  { plaque: "#1f6fb0", felt: "#6fb8ff" },
  { plaque: "#6a3fb0", felt: "#d2a8ff" },
  { plaque: "#b3261e", felt: "#ff8585" },
  { plaque: "#0e7c86", felt: "#5ce6f2" },
  { plaque: "#5b6670", felt: "#e3e8ec" },
];

// A felt colour's hue (degrees) - none for a grey.
function hueOf(hex: string): number | null {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max - min < 0.15) return null;
  const d = max - min;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}

// Two felt colours told apart at a glance, side by side as thin bars: hues
// 40 degrees or more apart, or one grey and the other not.
export function apart(a: string, b: string): boolean {
  const [ha, hb] = [hueOf(a), hueOf(b)];
  if (ha === null || hb === null) return (ha === null) !== (hb === null);
  const d = Math.abs(ha - hb);
  return Math.min(d, 360 - d) >= 40;
}

const ownColour = (bot: BotProfile): SeatColour | null => (mysteryStyle(bot) ? MYSTERY : (BOT_COLOURS[learnedStyle(bot) ?? bot.id] ?? null));

// Each seat's colour, all told apart: you gold; a bot its own, unless it
// has none for the table or it's too like one taken by a seat before it -
// then the first spare that isn't; another person a spare too.
export function seatColours(bots: (BotProfile | null | undefined)[], you: number): SeatColour[] {
  const used: string[] = [YOUR_COLOUR.felt];
  const free = (c: SeatColour | null) => !!c && used.every((u) => apart(u, c.felt));
  const take = (c: SeatColour) => (used.push(c.felt), c);
  const spare = () => take(SPARES.find(free) ?? SPARES[SPARES.length - 1]);
  const out = bots.map((bot) => {
    if (!bot) return null;
    const own = ownColour(bot);
    return free(own) ? take(own!) : spare();
  });
  return out.map((c, seat) => c ?? (seat === you ? YOUR_COLOUR : spare()));
}
