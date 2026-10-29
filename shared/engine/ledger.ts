// Score keeping for a real game at the table (港式台牌 house rules), in tai.
//
// A game is an append-only log of events - hands won, draws, bonuses, seat
// swaps, dealer and settings changes - and every number the Scores tab shows
// is worked out by replaying that log from the start (see replay). So 還原
// (undo) is just dropping the last event, and the stats read the same replay.
//
// What one payer owes one winner for a hand of `tai`:
//
//   base + tai + 莊 (dealerTai + streakTai × 連莊, when either of the two is the
//   dealer) + 雙響/三響 (on every pair of one) + the pair's 拉/踢 add-on
//
// 莊 and 雙響/三響 are added here, not typed into the tai: the Scoring tab
// takes both out of a hand it sends over.
//
// 拉/踢 live between two players. Once A has won off B there's a 拉 of V on B:
// - A wins off B again (拉 continues): that hand is worth its value + half of
//   V, and the 拉 grows to V + that worth. (11, then 20: worth 26, 拉 37.)
// - B wins off A (踢): worth its value + half of V; A's 拉 is gone and B's 拉
//   on A starts at the plain value. (29, then 20: worth 35, B's 拉 20.)
// - 自摸 counts, one payer-pair at a time. A draw keeps every 拉. 投降 lets
//   the pulled player end one with nothing paid. A hand the holder doesn't
//   win ends all their 拉.
// "Half" is rounded by 整數模式 (0.5進1 = up), or left exact when it's off.
//
// 反雪: a player who dealt into a 雙響/三響 and then self-draws the next hand
// someone wins (流局 in between don't count) gets a fixed amount from each of
// those winners - fanXueDouble after a 雙響 (5), fanXueTriple after a 三響
// (10) - and it goes into their new 拉 on that winner, like the hand itself:
// the 拉 is worth that much more for the 拉 or 踢 that follows, and the chips
// change hands when the 拉 ends.
//
// Jackpot: each draw, every seated player puts jackpotPerDraw into the pot;
// a win can take it (jackpotTo), or it can be handed out by hand - and
// players can pay into it by hand too (jackpotIn).

export const SEATS = 4;
const WIND_CHARS = ["東", "南", "西", "北"];

export interface ScoreSettings {
  base: number; // 自動計算底 - 0 = off
  dealerTai: number; // 自動計算莊 - 0 = off
  streakTai: number; // 自動計算連莊, per 連莊 - 0 = off
  fanXue: boolean; // 反雪
  // 雙響 / 三響: the tai on each winner's pair, and the 反雪 each winner pays
  // after one - the same number for both.
  fanXueDouble: number;
  fanXueTriple: number;
  scoreCap: number | null; // 封頂 - the highest tai / amount the keypad lets you type; null = no limit. Input only - never changes a payment.
  drawKeepsDealer: boolean; // 流局留莊
  jackpot: boolean;
  jackpotPerDraw: number; // from each seated player, per draw
  integerMode: boolean; // 整數模式
  lahRound: "up" | "down"; // 拉's half: 0.5進1 (up) or drop it
  tiRound: "up" | "down"; // 踢's half
  showLah: boolean; // 拉數提示 - 拉 badges on the cards
  seatReminder: boolean; // 執位提示 - remind to re-seat after 北風北局
  highScore: number | null; // 高分提示 - flag a payment at or above this
  surrenderPrompt: number | null; // 投降提示 - prompt once a 拉 runs this many hands in a row; null = off. A prompt only - 投降 itself is never restricted.
  showTally: boolean; // 胡摸銃數 - win / self-draw / deal-in counts on the cards
  quickScan: boolean; // 快速掃描 - a Scan button on each player's card
  chipsPrompt: boolean; // 籌碼提示 - who hands whom chips, after each entry that moves points
  tipsAutoHide: number | null; // 提示自動隱藏 - seconds a passing card (籌碼, the banners) stays before it goes by itself; null = until closed
  // 預設獎罰 - quick picks on the 特別獎罰 tab, each what one player gets from
  // (or, 蛇骰, pays) each of the others.
  bonusPresets: boolean;
  presetFlower: number; // 花 - receive from each
  presetGrass: number; // 草 - receive from each
  presetBoth: number; // 花草 - receive from each
  presetKong: number; // 暗槓 - receive from each
  presetChase: number; // 追 - pay each (the smaller)
  presetChaseBig: number; // 追 - pay each (the bigger)
  presetSnake: number; // 蛇骰 - pay each
  presetTriple: number; // 圍骰 - receive from each
  presetSevenOne: number; // 7搶1 - receive from one player
  presetOneSeven: number; // 1搶7 - receive from one player
  presetEightImmortals: number; // 八仙過海 - receive from each
  presetWrongCall: number; // 嗌錯 - pay each
  zhaHu: number | null; // 詐胡 - what a false win pays each other player by default (each can be changed); null = off
}

export const DEFAULT_SETTINGS: ScoreSettings = {
  base: 0,
  dealerTai: 1,
  streakTai: 2,
  fanXue: true,
  fanXueDouble: 5,
  fanXueTriple: 10,
  scoreCap: 999,
  drawKeepsDealer: true,
  jackpot: true,
  jackpotPerDraw: 5,
  integerMode: true,
  lahRound: "up",
  tiRound: "up",
  showLah: true,
  seatReminder: true,
  highScore: 50,
  surrenderPrompt: 3,
  showTally: true,
  quickScan: true,
  chipsPrompt: true,
  tipsAutoHide: 30,
  bonusPresets: true,
  presetFlower: 5,
  presetGrass: 3,
  presetBoth: 8,
  presetKong: 5,
  presetChase: 5,
  presetChaseBig: 10,
  presetSnake: 5,
  presetTriple: 5,
  presetSevenOne: 30,
  presetOneSeven: 30,
  presetEightImmortals: 100,
  presetWrongCall: 5,
  zhaHu: 40,
};

// The 預設獎罰 quick picks, from the settings: what each is called, which way
// it goes, how much - and whether it's with everyone else or one player (who
// is picked on the sheet).
export interface BonusPreset {
  name: string;
  kind: "獎" | "罰";
  amount: number;
  one?: true;
}

export function bonusPresets(settings: ScoreSettings): BonusPreset[] {
  if (!settings.bonusPresets) return [];
  // In the order they sit on the sheet: page 1's two rows, then page 2.
  return ([
    { name: "花", kind: "獎", amount: settings.presetFlower },
    { name: "草", kind: "獎", amount: settings.presetGrass },
    { name: "花草", kind: "獎", amount: settings.presetBoth },
    { name: "暗槓", kind: "獎", amount: settings.presetKong },
    { name: "蛇骰", kind: "罰", amount: settings.presetSnake },
    { name: "圍骰", kind: "獎", amount: settings.presetTriple },
    { name: "追", kind: "罰", amount: settings.presetChase },
    { name: "追", kind: "罰", amount: settings.presetChaseBig },
    { name: "嗌錯", kind: "罰", amount: settings.presetWrongCall },
    { name: "7搶1", kind: "獎", amount: settings.presetSevenOne, one: true },
    { name: "1搶7", kind: "獎", amount: settings.presetOneSeven, one: true },
    { name: "八仙過海", kind: "獎", amount: settings.presetEightImmortals },
  ] as BonusPreset[]).filter((p) => p.amount > 0);
}

export interface PatternNote {
  id: string;
  name: string;
  tai: number;
}

export interface WinnerEntry {
  seat: number;
  tai: number;
  patterns?: PatternNote[];
  // Worked out on the Scoring tab under custom tai rules: their fingerprint
  // (rulesFingerprint in taiRules.ts). Absent for the house rules.
  rules?: string;
}

// batch: entries recorded together as one action (a 座位 change's new seats
// and 莊, 全部投降's surrenders) share one, so 還原 / 重做 take them as one.
export type ScoreEvent = ScoreEventBody & { batch?: string };

type ScoreEventBody =
  // `from` null = 自摸 (exactly one winner); otherwise the discarder, who pays
  // each winner (one = 食胡, two or three = 雙響 / 三響).
  // multiTai: a 雙響/三響's tai on each pair, as 設定 had it when it went in
  // (so a later change there leaves recorded hands as they were).
  // dealerExtra: a Play hand's 莊 the dealer paid on another player's 自摸
  // (Play's own settings leave 莊 to the hand's tai, which can't carry it).
  | { t: "win"; at: number; winners: WinnerEntry[]; from: number | null; jackpotTo?: string; source: "quick" | "scoring"; multiTai?: number; dealerExtra?: number }
  | { t: "draw"; at: number }
  // 特別獎罰: 獎 - the seat's player is paid `amount`; 罰 - they pay it. With
  // `other`, just that one player pays (獎) or is paid (罰); without it, each
  // of the other three does.
  // name: a 預設獎罰's, when it came from one (花, 暗槓…) - shown in its place.
  | { t: "bonus"; at: number; seat: number; amount: number; kind: "獎" | "罰"; other?: number; name?: string }
  | { t: "surrender"; at: number; holder: string; pulled: string }
  | { t: "jackpot"; at: number; shares: { player: string; amount: number }[] }
  | { t: "jackpotIn"; at: number; shares: { player: string; amount: number }[] } // paid into the pot
  // 詐胡: the seat's player called a win that wasn't, and pays each of the
  // others their amount. Not a hand - the deal carries on as it was. Any 拉
  // the caller holds ends there, each pulled player paid its 踢 half too.
  | { t: "zhaHu"; at: number; seat: number; pays: { player: string; amount: number }[] }
  | { t: "swap"; at: number; seats: string[] } // the whole new seating
  // resetRound: back to 東風東局 from this dealer. Or `round` sets any 風局:
  // wind 0-3 (東南西北) and hand 0-3 (this dealer's 東局 … 北局).
  | { t: "dealer"; at: number; seat: number; streak: number; resetRound: boolean; round?: { wind: number; hand: number } }
  | { t: "settings"; at: number; settings: ScoreSettings };

export interface ScoreGame {
  id: string;
  name?: string; // what the players call it - set by a long press on the round box
  startedAt: number;
  endedAt?: number;
  // When play started and stopped, as "HH:MM", if someone set them - shown
  // only when set. (startedAt and endedAt are when the app opened and closed it.)
  startTime?: string;
  endTime?: string;
  location?: string; // where it was played, if someone set it
  seats: string[]; // the player at each seat at the start, in turn order
  firstDealer: number;
  settings: ScoreSettings; // as at the start - later changes are events
  events: ScoreEvent[];
  // Entries taken back by 還原, newest last, for 重做 (redo). Any new entry clears it.
  undone?: ScoreEvent[];
  // When it last changed (any entry, a fix, its name or end) - a backup merge
  // keeps whichever copy of a game changed last.
  updatedAt?: number;
}

// "20:00–23:30", "20:00–", "–23:30" or "" - a game's times as set.
export function playTimes(game: Pick<ScoreGame, "startTime" | "endTime">): string {
  const { startTime: from, endTime: to } = game;
  return from || to ? `${from ?? ""}–${to ?? ""}` : "";
}

export interface Lah {
  holder: string;
  pulled: string;
  value: number;
  count: number; // hands in the chain so far
}

// One payer-pair of one hand, broken down the way the 食胡 sheet shows it.
export interface PairPayment {
  winner: string;
  payer: string;
  base: number;
  tai: number;
  dealer: number;
  multi?: number; // 雙響/三響, when there's any
  lah: number; // the 拉 or 踢 add-on
  lahKind: "拉" | "踢" | null;
  lahBefore: number; // the 拉 the add-on came from
  worth: number;
}

export interface HandResult {
  eventIndex: number;
  hand: number; // 第N局, from 1
  label: string;
  dealer: string;
  streak: number;
  kind: "win" | "draw";
  selfDraw: boolean;
  multi: number; // winners off one discard (1 = ordinary)
  from: string | null;
  winners: { player: string; tai: number; patterns?: PatternNote[] }[];
  pairs: PairPayment[];
  fanXue: { from: string; to: string; amount: number }[];
  jackpotWon: { player: string; amount: number } | null;
  jackpotFed: number;
  deltas: Record<string, number>;
  totalsAfter: Record<string, number>;
  seatsAfter: string[];
}

export interface ReplayState {
  seats: string[];
  players: string[]; // everyone who has sat at this game, in order of first sitting
  totals: Record<string, number>;
  dealer: number;
  streak: number;
  roundWind: number; // 0-3
  roundStartDealer: number;
  // Where the game is overall: 第幾圈 (each wind, 東 南 西 北, is one 圈) and
  // 第幾個東 (each pass through all four). Both from 1.
  circle: number;
  east: number;
  lahs: Lah[];
  pot: number;
  settings: ScoreSettings;
  hands: HandResult[];
  // Every event's own deltas (hands, bonuses, jackpot hand-outs alike), for
  // the running-totals chart and the hand list.
  steps: { eventIndex: number; deltas: Record<string, number>; totalsAfter: Record<string, number> }[];
  // Everything each player has paid each other (and the Jackpot pile,
  // CHIP_POT), as "from>to" - for the chips that change hands pair by pair.
  paid: Record<string, number>;
  seatChangeDue: boolean; // 北風北局 just ended and 執位提示 is on
  fanXueDue: FanXueDue | null; // the last hand's 雙響/三響, which a 自摸 by its loser next would 反雪
  label: string;
}

export interface FanXueDue {
  loser: string;
  winners: string[];
}

// A win's 反雪: when the last 雙響/三響's loser now self-draws, what each of
// its winners pays them (`from` pays `to`), into `to`'s 拉 on `from`. Empty
// otherwise.
export function previewFanXue(
  state: Pick<ReplayState, "seats" | "settings" | "fanXueDue">,
  winners: { seat: number }[],
  from: number | null
): { from: string; to: string; amount: number }[] {
  const due = state.fanXueDue;
  const { settings, seats } = state;
  if (!settings.fanXue || from !== null || !due || winners.length === 0 || seats[winners[0].seat] !== due.loser) return [];
  const back = due.winners.length >= 3 ? settings.fanXueTriple : settings.fanXueDouble;
  if (back <= 0) return [];
  return due.winners.filter((w) => seats.includes(w)).map((w) => ({ from: w, to: due.loser, amount: back }));
}

export function half(value: number, round: "up" | "down", integer: boolean): number {
  if (!integer) return value / 2;
  return round === "up" ? Math.ceil(value / 2) : Math.floor(value / 2);
}

export function roundLabel(roundWind: number, dealer: number, roundStartDealer: number): string {
  return `${WIND_CHARS[roundWind]}風${WIND_CHARS[(dealer - roundStartDealer + SEATS) % SEATS]}局`;
}

const lahKey = (holder: string, pulled: string) => `${holder}>${pulled}`;

// A 詐胡 ends every 拉 its caller holds: each pulled player gets the 踢 half
// of theirs, as if they'd won it back.
export function zhaHuKicks(state: Pick<ReplayState, "lahs" | "settings">, caller: string): { player: string; amount: number }[] {
  return state.lahs
    .filter((l) => l.holder === caller)
    .map((l) => ({ player: l.pulled, amount: half(l.value, state.settings.tiRound, state.settings.integerMode) }))
    .filter((k) => k.amount > 0);
}

// What a hand of this many winners off one discard adds to each pair, by 設定:
// 雙響 or 三響's amount (the 反雪 one), nothing for one winner.
export function multiWinTai(settings: Pick<ScoreSettings, "fanXueDouble" | "fanXueTriple">, winners: number): number {
  return winners === 2 ? settings.fanXueDouble : winners >= 3 ? settings.fanXueTriple : 0;
}

export function dealerAmount(settings: ScoreSettings, streak: number): number {
  return settings.dealerTai + settings.streakTai * streak;
}

// The payer-pairs a win would produce, given the state before it - what the
// 食胡 sheet previews, and what replay applies. Doesn't change `state`.
// multiTai: a 雙響/三響's tai on each pair (see multiWinTai). dealerExtra:
// 莊 the dealer pays on top on another player's 自摸 (a Play hand's).
export function previewWin(
  state: Pick<ReplayState, "seats" | "dealer" | "streak" | "lahs" | "settings">,
  winners: WinnerEntry[],
  from: number | null,
  multiTai = 0,
  dealerExtra = 0
): PairPayment[] {
  const { settings, seats } = state;
  const lahs = new Map(state.lahs.map((l) => [lahKey(l.holder, l.pulled), l]));
  const pairs: PairPayment[] = [];
  for (const w of winners) {
    const payers = from === null ? [0, 1, 2, 3].filter((s) => s !== w.seat) : [from];
    for (const p of payers) {
      const dealer =
        (w.seat === state.dealer || p === state.dealer ? dealerAmount(settings, state.streak) : 0) + (from === null && p === state.dealer ? dealerExtra : 0);
      const plain = settings.base + w.tai + dealer + multiTai;
      const winner = seats[w.seat];
      const payer = seats[p];
      const pull = lahs.get(lahKey(winner, payer));
      const kick = lahs.get(lahKey(payer, winner));
      let lah = 0;
      let lahKind: PairPayment["lahKind"] = null;
      let lahBefore = 0;
      if (pull) {
        lah = half(pull.value, settings.lahRound, settings.integerMode);
        lahKind = "拉";
        lahBefore = pull.value;
      } else if (kick) {
        lah = half(kick.value, settings.tiRound, settings.integerMode);
        lahKind = "踢";
        lahBefore = kick.value;
      }
      pairs.push({ winner, payer, base: settings.base, tai: w.tai, dealer, ...(multiTai ? { multi: multiTai } : {}), lah, lahKind, lahBefore, worth: plain + lah });
    }
  }
  return pairs;
}

// The 拉 map after a win: every 拉 whose holder won survives (unless
// replaced below); each winner-payer pair then gets a 拉 of the winner on
// the payer - grown by this hand's worth if it continued one, or the plain
// value if it's fresh or a 踢 - and the payer's 拉 on the winner, if any,
// is gone. A 拉 whose holder didn't win this hand ends.
export function nextLahs(before: Lah[], pairs: PairPayment[], winnerNames: Set<string>): Lah[] {
  const lahs = new Map(before.map((l) => [lahKey(l.holder, l.pulled), l]));
  const next = new Map<string, Lah>();
  for (const l of before) if (winnerNames.has(l.holder)) next.set(lahKey(l.holder, l.pulled), l);
  for (const pair of pairs) {
    const prev = lahs.get(lahKey(pair.winner, pair.payer));
    next.delete(lahKey(pair.payer, pair.winner));
    next.set(lahKey(pair.winner, pair.payer), {
      holder: pair.winner,
      pulled: pair.payer,
      // A fresh 拉 (or a 踢's) starts at the plain value.
      value: pair.lahKind === "拉" ? pair.lahBefore + pair.worth : pair.base + pair.tai + pair.dealer + (pair.multi ?? 0),
      count: pair.lahKind === "拉" && prev ? prev.count + 1 : 1,
    });
  }
  return [...next.values()];
}

const add = (rec: Record<string, number>, player: string, amount: number) => {
  rec[player] = (rec[player] ?? 0) + amount;
};

// A game's replay, worked out once per version of it: games are never changed
// in place (every change is a new object), so a game object's replay never
// goes stale. For views that read many games at once (紀錄, careers).
const replays = new WeakMap<ScoreGame, ReplayState>();
export function replayCached(game: ScoreGame): ReplayState {
  let state = replays.get(game);
  if (!state) replays.set(game, (state = replay(game)));
  return state;
}

// An entry's step and hand by its index, looked up directly (built once per
// replay) rather than searched for - so a long game's views stay quick.
const indexes = new WeakMap<ReplayState, { steps: Map<number, ReplayState["steps"][number]>; hands: Map<number, HandResult> }>();
function indexOf(state: ReplayState) {
  let ix = indexes.get(state);
  if (!ix) {
    ix = { steps: new Map(state.steps.map((x) => [x.eventIndex, x])), hands: new Map(state.hands.map((h) => [h.eventIndex, h])) };
    indexes.set(state, ix);
  }
  return ix;
}
export const stepAt = (state: ReplayState, eventIndex: number) => indexOf(state).steps.get(eventIndex);
export const handAt = (state: ReplayState, eventIndex: number) => indexOf(state).hands.get(eventIndex);

export function replay(game: ScoreGame): ReplayState {
  const state: ReplayState = {
    seats: game.seats.slice(),
    players: game.seats.slice(),
    totals: Object.fromEntries(game.seats.map((p) => [p, 0])),
    dealer: game.firstDealer,
    streak: 0,
    roundWind: 0,
    roundStartDealer: game.firstDealer,
    circle: 1,
    east: 1,
    lahs: [],
    pot: 0,
    settings: { ...DEFAULT_SETTINGS, ...game.settings },
    hands: [],
    steps: [],
    paid: {},
    seatChangeDue: false,
    fanXueDue: null,
    label: "",
  };

  // Hands played in the current 圈 - a reset back to 東風東局 only starts a
  // new 圈 (and a new 東) when this one had any.
  let handsThisCircle = 0;
  const nextCircle = () => {
    state.circle++;
    handsThisCircle = 0;
  };
  const passDeal = () => {
    state.dealer = (state.dealer + 1) % SEATS;
    state.streak = 0;
    if (state.dealer === state.roundStartDealer) {
      state.roundWind = (state.roundWind + 1) % 4;
      nextCircle();
      if (state.roundWind === 0) state.east++;
      // 執位 once a whole 圈 is done: after 北風北局, back round to 東.
      if (state.roundWind === 0) state.seatChangeDue = state.settings.seatReminder;
    }
  };

  game.events.forEach((ev, eventIndex) => {
    const deltas: Record<string, number> = {};
    // One payment between two players (or a player and the pot): their
    // deltas, and who paid whom.
    const pay = (from: string, to: string, amount: number) => {
      if (from !== CHIP_POT) add(deltas, from, -amount);
      if (to !== CHIP_POT) add(deltas, to, amount);
      add(state.paid, `${from}>${to}`, amount);
    };
    const labelBefore = roundLabel(state.roundWind, state.dealer, state.roundStartDealer);
    const dealerBefore = state.seats[state.dealer];
    const streakBefore = state.streak;
    // The 執位 reminder lasts until the next hand or a re-seating.
    if (ev.t === "win" || ev.t === "draw" || ev.t === "swap") state.seatChangeDue = false;

    switch (ev.t) {
      case "win": {
        const pairs = previewWin(state, ev.winners, ev.from, ev.multiTai ?? 0, ev.dealerExtra ?? 0);
        const winnerNames = new Set(ev.winners.map((w) => state.seats[w.seat]));
        for (const pair of pairs) pay(pair.payer, pair.winner, pair.worth);
        state.lahs = nextLahs(state.lahs, pairs, winnerNames);

        // 反雪: paid, and riding in the 拉 this 自摸 just started on each winner.
        const fanXue: HandResult["fanXue"] = previewFanXue(state, ev.winners, ev.from);
        for (const f of fanXue) pay(f.from, f.to, f.amount);
        if (fanXue.length > 0)
          state.lahs = state.lahs.map((l) => {
            const f = fanXue.find((x) => x.to === l.holder && x.from === l.pulled);
            return f ? { ...l, value: l.value + f.amount } : l;
          });
        state.fanXueDue =
          ev.from !== null && ev.winners.length > 1
            ? { loser: state.seats[ev.from], winners: pairs.map((p) => p.winner) }
            : null;

        let jackpotWon: HandResult["jackpotWon"] = null;
        if (ev.jackpotTo && state.pot > 0) {
          pay(CHIP_POT, ev.jackpotTo, state.pot);
          jackpotWon = { player: ev.jackpotTo, amount: state.pot };
          state.pot = 0;
        }

        for (const [p, d] of Object.entries(deltas)) add(state.totals, p, d);
        handsThisCircle++;
        state.hands.push({
          eventIndex,
          hand: state.hands.length + 1,
          label: labelBefore,
          dealer: dealerBefore,
          streak: streakBefore,
          kind: "win",
          selfDraw: ev.from === null,
          multi: ev.winners.length,
          from: ev.from === null ? null : state.seats[ev.from],
          winners: ev.winners.map((w) => ({ player: state.seats[w.seat], tai: w.tai, patterns: w.patterns })),
          pairs,
          fanXue,
          jackpotWon,
          jackpotFed: 0,
          deltas,
          totalsAfter: { ...state.totals },
          seatsAfter: state.seats.slice(),
        });
        if (ev.winners.some((w) => w.seat === state.dealer)) state.streak++;
        else passDeal();
        break;
      }
      case "draw": {
        let fed = 0;
        if (state.settings.jackpot && state.settings.jackpotPerDraw > 0) {
          for (const p of state.seats) pay(p, CHIP_POT, state.settings.jackpotPerDraw);
          fed = state.settings.jackpotPerDraw * SEATS;
          state.pot += fed;
        }
        // A 流局 keeps a pending 反雪, as it keeps every 拉.
        for (const [p, d] of Object.entries(deltas)) add(state.totals, p, d);
        handsThisCircle++;
        state.hands.push({
          eventIndex,
          hand: state.hands.length + 1,
          label: labelBefore,
          dealer: dealerBefore,
          streak: streakBefore,
          kind: "draw",
          selfDraw: false,
          multi: 0,
          from: null,
          winners: [],
          pairs: [],
          fanXue: [],
          jackpotWon: null,
          jackpotFed: fed,
          deltas,
          totalsAfter: { ...state.totals },
          seatsAfter: state.seats.slice(),
        });
        if (state.settings.drawKeepsDealer) state.streak++;
        else passDeal();
        break;
      }
      case "bonus": {
        const me = state.seats[ev.seat];
        const counterparts = ev.other !== undefined && ev.other !== ev.seat ? [state.seats[ev.other]] : state.seats;
        for (const other of counterparts) {
          if (other === me) continue;
          if (ev.kind === "獎") pay(other, me, ev.amount);
          else pay(me, other, ev.amount);
        }
        for (const [p, d] of Object.entries(deltas)) add(state.totals, p, d);
        break;
      }
      case "zhaHu": {
        const me = state.seats[ev.seat];
        for (const each of ev.pays) if (each.player !== me && each.amount > 0) pay(me, each.player, each.amount);
        for (const kick of zhaHuKicks(state, me)) pay(me, kick.player, kick.amount);
        state.lahs = state.lahs.filter((l) => l.holder !== me);
        for (const [p, d] of Object.entries(deltas)) add(state.totals, p, d);
        break;
      }
      case "surrender":
        state.lahs = state.lahs.filter((l) => !(l.holder === ev.holder && l.pulled === ev.pulled));
        break;
      case "jackpot": {
        const total = ev.shares.reduce((s, x) => s + x.amount, 0);
        if (total > state.pot) break;
        for (const s of ev.shares) pay(CHIP_POT, s.player, s.amount);
        state.pot -= total;
        for (const [p, d] of Object.entries(deltas)) add(state.totals, p, d);
        break;
      }
      case "jackpotIn": {
        for (const s of ev.shares) {
          if (s.amount <= 0) continue;
          pay(s.player, CHIP_POT, s.amount);
          state.pot += s.amount;
        }
        for (const [p, d] of Object.entries(deltas)) add(state.totals, p, d);
        break;
      }
      case "swap":
        state.seats = ev.seats.slice();
        for (const p of ev.seats) {
          if (!state.players.includes(p)) state.players.push(p);
          if (!(p in state.totals)) state.totals[p] = 0;
        }
        break;
      case "dealer":
        state.dealer = ev.seat;
        state.streak = ev.streak;
        // Before the first hand it's just who deals first, so the 圈 starts
        // from them too, reset or not.
        if (ev.round) {
          // Set by hand. A new wind after hands in this one starts a new 圈
          // (and, landing on 東風, a new 東); the same wind - including a seat
          // move that keeps the round - just puts the label right.
          const wind = ((ev.round.wind % 4) + 4) % 4;
          if (handsThisCircle > 0 && wind !== state.roundWind) {
            nextCircle();
            if (wind === 0) state.east++;
          }
          state.roundWind = wind;
          state.roundStartDealer = (ev.seat - (((ev.round.hand % 4) + 4) % 4) + SEATS) % SEATS;
        } else if (ev.resetRound || state.hands.length === 0) {
          if (handsThisCircle > 0) {
            nextCircle();
            state.east++; // back to 東風東局: a new 東
          }
          state.roundWind = 0;
          state.roundStartDealer = ev.seat;
        }
        break;
      case "settings":
        state.settings = { ...DEFAULT_SETTINGS, ...ev.settings };
        break;
    }
    state.steps.push({ eventIndex, deltas, totalsAfter: { ...state.totals } });
  });

  state.label = roundLabel(state.roundWind, state.dealer, state.roundStartDealer);
  return state;
}

// 結帳: the fewest payments that settle everyone up - the biggest loser
// pays the biggest winner, repeatedly - with every amount × `multiplier`.
export function settle(totals: Record<string, number>, multiplier = 1): { from: string; to: string; amount: number }[] {
  const debtors = Object.entries(totals)
    .filter(([, v]) => v < 0)
    .map(([p, v]) => ({ p, v: -v }))
    .sort((a, b) => b.v - a.v);
  const creditors = Object.entries(totals)
    .filter(([, v]) => v > 0)
    .map(([p, v]) => ({ p, v }))
    .sort((a, b) => b.v - a.v);
  const out: { from: string; to: string; amount: number }[] = [];
  let i = 0;
  let j = 0;
  while (i < debtors.length && j < creditors.length) {
    const amount = Math.min(debtors[i].v, creditors[j].v);
    if (amount > 0) out.push({ from: debtors[i].p, to: creditors[j].p, amount: amount * multiplier });
    debtors[i].v -= amount;
    creditors[j].v -= amount;
    if (debtors[i].v <= 1e-9) i++;
    if (creditors[j].v <= 1e-9) j++;
  }
  return out;
}

// The Jackpot split as evenly as it goes, by seat: what won't divide is
// spread one unit each (1, or 0.1 off 整數模式), from `first` (the 起莊 seat)
// on round the table - 11 is 3 · 3 · 3 · 2 from seat 0.
export function evenShares(pot: number, first: number, integer: boolean): number[] {
  const unit = integer ? 1 : 0.1;
  const units = Math.round(pot / unit);
  const each = Math.floor(units / SEATS);
  const left = units - each * SEATS;
  return [0, 1, 2, 3].map((seat) => Math.round((each + ((seat - first + SEATS) % SEATS < left ? 1 : 0)) * unit * 10) / 10);
}

// ---- Chips -----------------------------------------------------------------

// Who hands whom chips between two states of a game. At the table a hand's
// payment goes into a 拉 and stays there: chips only change hands when that
// 拉 ends (the holder doesn't win the next hand, a 踢, 投降, 詐胡), the pulled
// player paying its whole value - less a 踢's half, which the 踢 pays back.
// 反雪 rides in its 拉 the same way; 獎罰, 詐胡 and the Jackpot are paid there
// and then. Each 拉 is
// settled between its own two players, so the handovers are pair by pair -
// never netted across the table. The Jackpot is a pile of its own (彩池).
export const CHIP_POT = "彩池";

export function chipMoves(before: Pick<ReplayState, "paid" | "lahs">, after: Pick<ReplayState, "paid" | "lahs">): { from: string; to: string; amount: number }[] {
  // Between each two players, what has changed hands in chips so far: what
  // one has paid the other, less what's still riding in a 拉 between them.
  const handed = (state: Pick<ReplayState, "paid" | "lahs">) => {
    const net: Record<string, number> = {};
    const move = (from: string, to: string, amount: number) => {
      const key = from < to ? `${from}>${to}` : `${to}>${from}`;
      net[key] = (net[key] ?? 0) + (from < to ? amount : -amount);
    };
    for (const [key, amount] of Object.entries(state.paid)) {
      const [from, to] = key.split(">");
      move(from, to, amount);
    }
    for (const l of state.lahs) move(l.pulled, l.holder, -l.value);
    return net;
  };
  const was = handed(before);
  const now = handed(after);
  const out: { from: string; to: string; amount: number }[] = [];
  for (const key of new Set([...Object.keys(was), ...Object.keys(now)])) {
    const d = Math.round(((now[key] ?? 0) - (was[key] ?? 0)) * 10) / 10;
    if (d === 0) continue;
    const [a, b] = key.split(">");
    out.push(d > 0 ? { from: a, to: b, amount: d } : { from: b, to: a, amount: -d });
  }
  return out;
}

// ---- Storage -------------------------------------------------------------

export interface RosterPlayer {
  name: string;
  color: number; // index into the Scores palette
}

export interface ScoreStore {
  active: ScoreGame | null;
  history: ScoreGame[];
  roster: RosterPlayer[];
  settings: ScoreSettings; // what a new game starts with
}

export const PLAYER_COLORS = 8;

export function emptyStore(): ScoreStore {
  return { active: null, history: [], roster: [], settings: DEFAULT_SETTINGS };
}

const isGame = (g: unknown): g is ScoreGame =>
  !!g &&
  typeof g === "object" &&
  Array.isArray((g as ScoreGame).seats) &&
  (g as ScoreGame).seats.length === SEATS &&
  Array.isArray((g as ScoreGame).events);

// Whatever was saved (or imported), trimmed to what this version can use.
export function normalizeStore(saved: Partial<ScoreStore>): ScoreStore {
  return {
    active: isGame(saved.active) ? saved.active : null,
    history: Array.isArray(saved.history) ? saved.history.filter(isGame) : [],
    roster: Array.isArray(saved.roster) ? saved.roster.filter((p) => p && typeof p.name === "string") : [],
    settings: { ...DEFAULT_SETTINGS, ...(saved.settings ?? {}) },
  };
}

// ---- Backup --------------------------------------------------------------
// A backup file is the whole store, wrapped so an import can tell it apart
// from any other JSON. Older or newer versions read it the same way a saved
// store is read (normalizeStore), so a backup outlives app updates.

const BACKUP_KIND = "mjwaits.scores";
const BACKUP_VERSION = 1;

export function exportScores(store: ScoreStore, now = Date.now()): string {
  return JSON.stringify({ kind: BACKUP_KIND, version: BACKUP_VERSION, exportedAt: now, store }, null, 1);
}

// The store in a backup file, or null if the text isn't one. A bare store
// (what localStorage itself holds) is accepted too.
export function parseBackup(text: string): ScoreStore | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  const wrapped = (data as { kind?: unknown }).kind === BACKUP_KIND;
  const saved = (wrapped ? (data as { store?: unknown }).store : data) as Partial<ScoreStore> | undefined;
  if (!saved || typeof saved !== "object") return null;
  if (!wrapped && !("history" in saved) && !("active" in saved)) return null;
  return normalizeStore(saved);
}

// A backup folded into what's here: every game from both (by id - the copy
// with more entries wins), the roster joined, this device's settings kept.
// This device's game in progress stays in progress; the backup's, if it's a
// different game, goes to the history like any other.
export function mergeScores(here: ScoreStore, backup: ScoreStore): ScoreStore {
  const byId = new Map<string, ScoreGame>();
  // The same game in both: keep the copy that changed last - an edit or a
  // deletion is newer, not fewer entries. Copies from before updatedAt was
  // kept fall back to their latest entry, then to more entries.
  const changed = (g: ScoreGame) => g.updatedAt ?? Math.max(g.endedAt ?? 0, ...g.events.map((ev) => ev.at), g.startedAt);
  const add = (g: ScoreGame | null) => {
    if (!g) return;
    const prev = byId.get(g.id);
    if (!prev || changed(g) > changed(prev) || (changed(g) === changed(prev) && g.events.length > prev.events.length)) byId.set(g.id, g);
  };
  [here.active, ...here.history, backup.active, ...backup.history].forEach(add);
  const activeId = here.active?.id ?? backup.active?.id ?? null;
  const active = activeId ? (byId.get(activeId) ?? null) : null;
  const history = [...byId.values()].filter((g) => g.id !== activeId).sort((a, b) => b.startedAt - a.startedAt);
  const roster = here.roster.slice();
  for (const p of backup.roster) if (!roster.some((r) => r.name === p.name)) roster.push(p);
  return { active, history, roster, settings: here.settings };
}

export function newGame(seats: string[], firstDealer: number, settings: ScoreSettings): ScoreGame {
  const now = Date.now();
  return { id: `g${now.toString(36)}`, startedAt: now, seats: seats.slice(), firstDealer, settings, events: [] };
}

// A new entry - which also drops anything waiting to be redone.
export const withEvent = (game: ScoreGame, ev: ScoreEvent): ScoreGame => ({ ...game, events: [...game.events, ev], undone: [] });

// Several entries that make one action, so 還原 / 重做 treat them as one.
export const withEvents = (game: ScoreGame, evs: ScoreEvent[]): ScoreGame => {
  if (evs.length < 2) return evs.reduce(withEvent, game);
  const batch = `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  return { ...game, events: [...game.events, ...evs.map((ev) => ({ ...ev, batch }))], undone: [] };
};

// The trailing run of a list that belongs to its last entry's batch (just
// the last entry when it has none).
const lastAction = (list: ScoreEvent[]): number => {
  const last = list[list.length - 1];
  if (!last?.batch) return list.length ? 1 : 0;
  let n = 0;
  while (n < list.length && list[list.length - 1 - n].batch === last.batch) n++;
  return n;
};

// 還原: take the last action back (all its entries), keeping it for 重做.
export const undoEvent = (game: ScoreGame): ScoreGame => {
  const n = lastAction(game.events);
  if (n === 0) return game;
  return { ...game, events: game.events.slice(0, -n), undone: [...(game.undone ?? []), ...game.events.slice(-n)] };
};

// 重做: put the most recently undone entry back.
export const redoEvent = (game: ScoreGame): ScoreGame => {
  const undone = game.undone ?? [];
  const n = lastAction(undone);
  if (n === 0) return game;
  return { ...game, events: [...game.events, ...undone.slice(-n)], undone: undone.slice(0, -n) };
};

export const canRedo = (game: ScoreGame) => (game.undone?.length ?? 0) > 0;

// Fix an older entry from 最近: swap it for a corrected one (keeping when it
// happened), or take it out. Everything after it replays on top, so totals,
// 拉, 莊 and the round all follow. Either clears 重做, like a new entry.
export const replaceEvent = (game: ScoreGame, index: number, ev: ScoreEvent): ScoreGame => ({
  ...game,
  events: game.events.map((e, i) => (i === index ? { ...ev, at: e.at } : e)),
  undone: [],
});

export const deleteEvent = (game: ScoreGame, index: number): ScoreGame => ({
  ...game,
  events: game.events.filter((_, i) => i !== index),
  undone: [],
});
