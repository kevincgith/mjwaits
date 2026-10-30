// scoring.test.ts's ctx() defaults, as testHands.ts has them - here on
// their own so the Scoring tab can use them without loading the whole
// test-hands list (which only the developer sheet needs).
// testHandContext.test.ts checks the two stay the same.
import type { GameContext } from "@mjwaits/shared/engine/scoring";

export const TEST_HAND_BASE_CONTEXT: GameContext = {
  seatWind: 1,
  roundWind: 1,
  selfDraw: false,
  winningTile: null,
  riichi: "none",
  instantWin: false,
  eatRiichi: false,
  earlyWin: "none",
  multiWin: "none",
  heavenlyWin: "none",
  lastTileWin: "none",
  flowerDraw: 0,
  kongDraw: 0,
  robKong: 0,
  dealerStreak: 0,
  manualVisibleTripleWin: false,
  manualVisibleExhaustedMultiWait: false,
};
