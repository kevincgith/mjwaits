// The game Play left on this phone, as the Play tab's page and start
// screen show it (Continue) - read here, without loading Play itself.
import type { GameState } from "@mjwaits/shared/engine/game";

export const PLAY_SAVE_KEY = "mjwaits.play";

export interface SavedSummary {
  round: string;
  you: number; // your total
}

const WIND_CHARS = ["", "東", "南", "西", "北"];

// "東圈南局", as roundLabel (game.ts) has it.
const roundOf = (g: GameState) => `${WIND_CHARS[g.roundWind]}圈${WIND_CHARS[((g.dealer - (g.firstDealer ?? 0) + 4) % 4) + 1]}局`;

export function savedSummary(): SavedSummary | null {
  try {
    const raw = window.localStorage.getItem(PLAY_SAVE_KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw) as { game?: GameState; totals?: number[] };
    if (!saved?.game?.players || saved.game.players.length !== 4 || !Array.isArray(saved.totals)) return null;
    return { round: roundOf(saved.game), you: saved.totals[0] };
  } catch {
    return null;
  }
}
