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
//   dealer) + the pair's 拉/踢 add-on
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
// 反雪: a player who dealt into a 雙響/三響 and then self-draws the very next
// hand gets back, from each of those winners, what that winner took off them
// (plus an optional fixed extra).
//
// Jackpot: each draw, every seated player puts jackpotPerDraw into the pot;
// a win can take it (jackpotTo), or it can be handed out by hand.

export const SEATS = 4;
const WIND_CHARS = ["東", "南", "西", "北"];

export interface ScoreSettings {
  base: number; // 自動計算底 - 0 = off
  dealerTai: number; // 自動計算莊 - 0 = off
  streakTai: number; // 自動計算連莊, per 連莊 - 0 = off
  fanXue: boolean; // 反雪
  fanXueBonus: number; // a fixed extra on top of the payback
  drawKeepsDealer: boolean; // 流局留莊
  jackpot: boolean;
  jackpotPerDraw: number; // from each seated player, per draw
  integerMode: boolean; // 整數模式
  lahRound: "up" | "down"; // 拉's half: 0.5進1 (up) or drop it
  tiRound: "up" | "down"; // 踢's half
  showLah: boolean; // 拉數提示 - 拉 badges on the cards
  seatReminder: boolean; // 執位提示 - remind to re-seat when the round wind moves
  selfDrawKey: boolean; // 自摸鍵 - a one-tap 自摸 on each card
  highScore: number | null; // 高分提示 - flag a payment at or above this
}

export const DEFAULT_SETTINGS: ScoreSettings = {
  base: 0,
  dealerTai: 1,
  streakTai: 2,
  fanXue: true,
  fanXueBonus: 0,
  drawKeepsDealer: true,
  jackpot: true,
  jackpotPerDraw: 5,
  integerMode: true,
  lahRound: "up",
  tiRound: "up",
  showLah: true,
  seatReminder: true,
  selfDrawKey: false,
  highScore: 50,
};

export interface PatternNote {
  id: string;
  name: string;
  tai: number;
}

export interface WinnerEntry {
  seat: number;
  tai: number;
  patterns?: PatternNote[];
}

export type ScoreEvent =
  // `from` null = 自摸 (exactly one winner); otherwise the discarder, who pays
  // each winner (one = 食胡, two or three = 雙響 / 三響).
  | { t: "win"; at: number; winners: WinnerEntry[]; from: number | null; jackpotTo?: string; source: "quick" | "scoring" }
  | { t: "draw"; at: number }
  // 特別獎罰: 獎 - each other seated player pays `amount` to the seat's player;
  // 罰 - the seat's player pays each of them `amount`.
  | { t: "bonus"; at: number; seat: number; amount: number; kind: "獎" | "罰" }
  | { t: "surrender"; at: number; holder: string; pulled: string }
  | { t: "jackpot"; at: number; shares: { player: string; amount: number }[] }
  | { t: "swap"; at: number; seats: string[] } // the whole new seating
  | { t: "dealer"; at: number; seat: number; streak: number; resetRound: boolean }
  | { t: "settings"; at: number; settings: ScoreSettings };

export interface ScoreGame {
  id: string;
  startedAt: number;
  endedAt?: number;
  seats: string[]; // the player at each seat at the start, in turn order
  firstDealer: number;
  settings: ScoreSettings; // as at the start - later changes are events
  events: ScoreEvent[];
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
  lahs: Lah[];
  pot: number;
  settings: ScoreSettings;
  hands: HandResult[];
  // Every event's own deltas (hands, bonuses, jackpot hand-outs alike), for
  // the running-totals chart and the hand list.
  steps: { eventIndex: number; deltas: Record<string, number>; totalsAfter: Record<string, number> }[];
  seatChangeDue: boolean; // the round wind just moved and 執位提示 is on
  label: string;
}

export function half(value: number, round: "up" | "down", integer: boolean): number {
  if (!integer) return value / 2;
  return round === "up" ? Math.ceil(value / 2) : Math.floor(value / 2);
}

export function roundLabel(roundWind: number, dealer: number, roundStartDealer: number): string {
  return `${WIND_CHARS[roundWind]}風${WIND_CHARS[(dealer - roundStartDealer + SEATS) % SEATS]}局`;
}

const lahKey = (holder: string, pulled: string) => `${holder}>${pulled}`;

export function dealerAmount(settings: ScoreSettings, streak: number): number {
  return settings.dealerTai + settings.streakTai * streak;
}

// The payer-pairs a win would produce, given the state before it - what the
// 食胡 sheet previews, and what replay applies. Doesn't change `state`.
export function previewWin(
  state: Pick<ReplayState, "seats" | "dealer" | "streak" | "lahs" | "settings">,
  winners: WinnerEntry[],
  from: number | null
): PairPayment[] {
  const { settings, seats } = state;
  const lahs = new Map(state.lahs.map((l) => [lahKey(l.holder, l.pulled), l]));
  const pairs: PairPayment[] = [];
  for (const w of winners) {
    const payers = from === null ? [0, 1, 2, 3].filter((s) => s !== w.seat) : [from];
    for (const p of payers) {
      const dealer = w.seat === state.dealer || p === state.dealer ? dealerAmount(settings, state.streak) : 0;
      const plain = settings.base + w.tai + dealer;
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
      pairs.push({ winner, payer, base: settings.base, tai: w.tai, dealer, lah, lahKind, lahBefore, worth: plain + lah });
    }
  }
  return pairs;
}

const add = (rec: Record<string, number>, player: string, amount: number) => {
  rec[player] = (rec[player] ?? 0) + amount;
};

export function replay(game: ScoreGame): ReplayState {
  const state: ReplayState = {
    seats: game.seats.slice(),
    players: game.seats.slice(),
    totals: Object.fromEntries(game.seats.map((p) => [p, 0])),
    dealer: game.firstDealer,
    streak: 0,
    roundWind: 0,
    roundStartDealer: game.firstDealer,
    lahs: [],
    pot: 0,
    settings: { ...DEFAULT_SETTINGS, ...game.settings },
    hands: [],
    steps: [],
    seatChangeDue: false,
    label: "",
  };
  // The 雙響/三響 the next hand's 自摸 could 反雪.
  let lastMulti: { loser: string; paid: { winner: string; amount: number }[] } | null = null;

  const passDeal = () => {
    state.dealer = (state.dealer + 1) % SEATS;
    state.streak = 0;
    if (state.dealer === state.roundStartDealer) {
      state.roundWind = (state.roundWind + 1) % 4;
      state.seatChangeDue = state.settings.seatReminder;
    }
  };

  game.events.forEach((ev, eventIndex) => {
    const deltas: Record<string, number> = {};
    const labelBefore = roundLabel(state.roundWind, state.dealer, state.roundStartDealer);
    const dealerBefore = state.seats[state.dealer];
    const streakBefore = state.streak;
    // The 執位 reminder lasts until the next hand or a re-seating.
    if (ev.t === "win" || ev.t === "draw" || ev.t === "swap") state.seatChangeDue = false;

    switch (ev.t) {
      case "win": {
        const pairs = previewWin(state, ev.winners, ev.from);
        const lahs = new Map(state.lahs.map((l) => [lahKey(l.holder, l.pulled), l]));
        const winnerNames = new Set(ev.winners.map((w) => state.seats[w.seat]));
        const next = new Map<string, Lah>();
        // Every 拉 whose holder won this hand survives unless it's replaced below.
        for (const l of state.lahs) if (winnerNames.has(l.holder)) next.set(lahKey(l.holder, l.pulled), l);
        for (const pair of pairs) {
          add(deltas, pair.winner, pair.worth);
          add(deltas, pair.payer, -pair.worth);
          const prev = lahs.get(lahKey(pair.winner, pair.payer));
          next.delete(lahKey(pair.payer, pair.winner));
          next.set(lahKey(pair.winner, pair.payer), {
            holder: pair.winner,
            pulled: pair.payer,
            value: pair.lahKind === "拉" ? pair.lahBefore + pair.worth : pair.worth - pair.lah,
            count: pair.lahKind === "拉" && prev ? prev.count + 1 : 1,
          });
        }
        state.lahs = [...next.values()];

        // 反雪.
        const fanXue: HandResult["fanXue"] = [];
        if (state.settings.fanXue && ev.from === null && lastMulti && state.seats[ev.winners[0].seat] === lastMulti.loser) {
          for (const { winner, amount } of lastMulti.paid) {
            if (!state.seats.includes(winner)) continue;
            const back = amount + state.settings.fanXueBonus;
            add(deltas, lastMulti.loser, back);
            add(deltas, winner, -back);
            fanXue.push({ from: winner, to: lastMulti.loser, amount: back });
          }
        }
        lastMulti =
          ev.from !== null && ev.winners.length > 1
            ? { loser: state.seats[ev.from], paid: pairs.map((p) => ({ winner: p.winner, amount: p.worth })) }
            : null;

        let jackpotWon: HandResult["jackpotWon"] = null;
        if (ev.jackpotTo && state.pot > 0) {
          add(deltas, ev.jackpotTo, state.pot);
          jackpotWon = { player: ev.jackpotTo, amount: state.pot };
          state.pot = 0;
        }

        for (const [p, d] of Object.entries(deltas)) add(state.totals, p, d);
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
          for (const p of state.seats) add(deltas, p, -state.settings.jackpotPerDraw);
          fed = state.settings.jackpotPerDraw * SEATS;
          state.pot += fed;
        }
        lastMulti = null;
        for (const [p, d] of Object.entries(deltas)) add(state.totals, p, d);
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
        for (const other of state.seats) {
          if (other === me) continue;
          const amount = ev.kind === "獎" ? ev.amount : -ev.amount;
          add(deltas, me, amount);
          add(deltas, other, -amount);
        }
        for (const [p, d] of Object.entries(deltas)) add(state.totals, p, d);
        break;
      }
      case "surrender":
        state.lahs = state.lahs.filter((l) => !(l.holder === ev.holder && l.pulled === ev.pulled));
        break;
      case "jackpot": {
        const total = ev.shares.reduce((s, x) => s + x.amount, 0);
        if (total > state.pot) break;
        for (const s of ev.shares) add(deltas, s.player, s.amount);
        state.pot -= total;
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
        if (ev.resetRound) {
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

export const SCORES_KEY = "mjwaits.scores";
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

export function loadScores(): ScoreStore {
  try {
    const raw = window.localStorage.getItem(SCORES_KEY);
    if (!raw) return emptyStore();
    const saved = JSON.parse(raw) as Partial<ScoreStore>;
    return {
      active: isGame(saved.active) ? saved.active : null,
      history: Array.isArray(saved.history) ? saved.history.filter(isGame) : [],
      roster: Array.isArray(saved.roster) ? saved.roster.filter((p) => p && typeof p.name === "string") : [],
      settings: { ...DEFAULT_SETTINGS, ...(saved.settings ?? {}) },
    };
  } catch {
    return emptyStore();
  }
}

export function saveScores(store: ScoreStore): void {
  try {
    window.localStorage.setItem(SCORES_KEY, JSON.stringify(store));
  } catch {
    // Storage unavailable - scores just won't survive a reload.
  }
}

export function newGame(seats: string[], firstDealer: number, settings: ScoreSettings): ScoreGame {
  const now = Date.now();
  return { id: `g${now.toString(36)}`, startedAt: now, seats: seats.slice(), firstDealer, settings, events: [] };
}

export const withEvent = (game: ScoreGame, ev: ScoreEvent): ScoreGame => ({ ...game, events: [...game.events, ev] });
export const undoEvent = (game: ScoreGame): ScoreGame => ({ ...game, events: game.events.slice(0, -1) });
