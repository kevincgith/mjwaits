// How the Scoring tab's 情況 buttons link to each other, written as data so
// 設定 and the printed reference can show it next to each situation. This
// is the app's own wiring (App.tsx: deactivateSelfDrawGroup,
// deactivateClaimedWinGroup, cycleEarlyWin, cycleHeavenlyWin,
// cycleLastTileWin, cycleRobKong, the 叮/一發 buttons), not part of any rule
// set: the engine scores whatever it's given. Keep the two in step - if a
// button's wiring changes there, change it here.
//
// Plus what each situation needs to count at all, from its score() in
// scoring.ts - also fixed, not a setting.

/** Count as a self-draw: switching one on turns 自摸 on. */
const SELF_DRAWN = ["flower-draw", "kong-draw", "river-bottom-win", "sea-bottom-win", "sea-bottom-win-one-tong", "heavenly-win", "human-win"];
/** Won off another player: switching one on turns 自摸 (and SELF_DRAWN) off. */
const CLAIMED = ["rob-kong", "multi-win-double", "multi-win-triple", "earthly-win", "riichi-eat"];
const SELF_DRAW = ["self-draw", "concealed-self-draw"];
const EARLY = ["early-win-four", "early-win-seven", "early-win-ten"];
const LAST_TILE = ["river-bottom-win", "sea-bottom-win", "sea-bottom-win-one-tong"];
const FIRST_TURN = ["heavenly-win", "earthly-win", "human-win"];
const RIICHI = ["riichi", "concealed-riichi", "heavenly-riichi", "earthly-riichi", "riichi-instant-win"];

// Groups that can't be on together: switching one side on clears the other.
const CONFLICTS: [string[], string[]][] = [
  [CLAIMED, [...SELF_DRAW, ...SELF_DRAWN]],
  [EARLY, LAST_TILE],
  [FIRST_TURN, LAST_TILE],
  [FIRST_TURN, RIICHI],
  [FIRST_TURN, EARLY],
];

// One button cycling through these - only one at a time by construction.
const ONE_BUTTON = [
  ["riichi", "heavenly-riichi", "earthly-riichi"],
  EARLY,
  ["multi-win-double", "multi-win-triple"],
  FIRST_TURN,
  ["river-bottom-win", "sea-bottom-win"],
];

const TURNS_ON: Record<string, string[]> = {
  ...Object.fromEntries(SELF_DRAWN.map((id) => [id, ["self-draw"]])),
  // 搶槓's tile was already three deep in someone's kong.
  "rob-kong": ["visible-triple-win"],
};

const NEEDS: Record<string, string> = {
  "concealed-riichi": "叮 on a 門前清 hand",
  "heavenly-riichi": "no declared melds, kongs included (the 叮 button skips it otherwise)",
  "earthly-riichi": "no declared melds, kongs included (the 叮 button skips it otherwise)",
  "riichi-instant-win": "叮, 天叮 or 地叮 declared (the button is off without it)",
  "concealed-self-draw": "自摸 on a 門前清 hand",
  "heavenly-win": "no declared melds, kongs included",
  "earthly-win": "no declared melds, kongs included",
  "human-win": "no declared melds, kongs included",
  "sea-bottom-win-one-tong": "海底撈月 and 自摸, won on 1筒 - counted by itself, no button",
  "everyone-else-completes-it": "every meld declared, won off a discard",
  "half-everyone-else-completes-it": "every meld declared, self-drawn",
};

export interface SituationLinks {
  /** What it needs to count - its definition. */
  needs?: string;
  /** Buttons it switches on. */
  turnsOn: string[];
  /** Buttons that switch it on. */
  turnedOnBy: string[];
  /** Situations it can't be on with (either one clears the other). */
  clears: string[];
  /** Situations on the same button - one at a time. */
  sameButton: string[];
}

const uniq = (ids: string[], self: string) => [...new Set(ids)].filter((x) => x !== self);

/** A situation's links, or null when it has none (not a 情況 button). */
export function situationLinks(id: string): SituationLinks | null {
  const clears = uniq(
    CONFLICTS.flatMap(([a, b]) => (a.includes(id) ? b : b.includes(id) ? a : [])),
    id,
  );
  const sameButton = uniq(ONE_BUTTON.find((group) => group.includes(id)) ?? [], id);
  const turnsOn = TURNS_ON[id] ?? [];
  const turnedOnBy = Object.keys(TURNS_ON).filter((other) => TURNS_ON[other].includes(id));
  const needs = NEEDS[id];
  // What's on the same button is already one-at-a-time; don't list it twice.
  const links = { needs, turnsOn, turnedOnBy, clears: clears.filter((x) => !sameButton.includes(x)), sameButton };
  return needs || turnsOn.length || turnedOnBy.length || clears.length || sameButton.length ? links : null;
}

export const SITUATION_LINK_IDS = [
  ...new Set([...SELF_DRAWN, ...CLAIMED, ...SELF_DRAW, ...EARLY, ...LAST_TILE, ...FIRST_TURN, ...RIICHI, ...ONE_BUTTON.flat(), ...Object.keys(TURNS_ON), ...Object.values(TURNS_ON).flat(), ...Object.keys(NEEDS)]),
];

/** The links as label/text lines, for 設定 and the printed reference. */
export function situationLinkRows(id: string, name: (id: string) => string): { label: string; text: string }[] {
  const links = situationLinks(id);
  if (!links) return [];
  const list = (ids: string[]) => ids.map(name).join("、");
  const rows: { label: string; text: string }[] = [];
  if (links.needs) rows.push({ label: "Needs", text: links.needs });
  if (links.turnsOn.length) rows.push({ label: "Turns on", text: list(links.turnsOn) });
  if (links.turnedOnBy.length) rows.push({ label: "Turned on by", text: list(links.turnedOnBy) });
  if (links.clears.length) rows.push({ label: "Can't be on with", text: list(links.clears) });
  if (links.sameButton.length) rows.push({ label: "Same button as", text: list(links.sameButton) });
  return rows;
}
