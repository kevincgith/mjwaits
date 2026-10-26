// One online table: four seats - people or bots - playing real hands. (What
// every kind of room has in common - joining, tokens, rate limits, expiry -
// is in hub.ts.)
//
// The table holds everything: the wall and all four hands (the engine's
// GameState), and sends each phone only what its seat may see (viewFor). It
// moves the hand on itself (`run`): it waits for a person's move or claim -
// with a deadline when there's a turn timer - and lets bots, and anyone who's
// been away longer than the hold time, act on their own after a short pause
// so the table can follow. Every move is checked against the engine: the
// right step, the right seat, a legal move.
//
// Storage: the whole table is one row ("state"), written once per event - a
// message or the alarm - however many steps that event moved the hand on,
// plus the hub's clock row. The table's record - the hands as a Scores-tab
// game (playLedger.ts), for 戰況 on every phone - is a row per entry, added
// as the hands are played (a few a hand), and fetched by phones over HTTP. (The free plan's daily limit on rows written is
// the one a busy table would meet first.)
//
// Timers share the room's one alarm: the turn deadline, the next bot move,
// and when an away player's seat stops being held. If every person at the
// table is away, nothing moves until someone is back.

import {
  applyTurnMove,
  botTurnMove,
  claimOptions,
  dealHand,
  forbiddenDiscards,
  canWin,
  kongOptions,
  nextHand,
  resolveClaims,
  riichiDiscards,
  riichiForcedDiscard,
  sameTile,
  SEATS,
  surrender,
  type Claim,
  type GameState,
  type TurnMove,
} from "@mjwaits/shared/engine/game";
import { botClaimFor, botSurrenders, botTurnMoveFor, MYSTERY_NAME, profileById, randomStyle } from "@mjwaits/shared/engine/bots";
import type { Tile } from "@mjwaits/shared/engine/mahjong";
import { viewFor } from "@mjwaits/shared/engine/view";
import type { ScoreEvent, ScoreGame } from "@mjwaits/shared/engine/ledger";
import { newPlayLedger, playEvents } from "@mjwaits/shared/engine/playLedger";
import { PROTOCOL_VERSION } from "@mjwaits/shared/protocol/limits";
import {
  DEFAULT_TABLE_SETTINGS,
  MYSTERY_BOT,
  parseTableMessage,
  type SeatInfo,
  type TableAction,
  type TableBot,
  type TableClientMessage,
  type TableServerMessage,
  type TableSettings,
  type TableState,
  type YourOptions,
} from "@mjwaits/shared/protocol/table";
import { Hub, Refusal } from "./hub";

// A bot's (or an away player's) move waits this long, so people can follow.
export const BOT_PAUSE_MS = 700;
// A discard that's being called stays on the table this many bot pauses
// first, so everyone sees what was thrown before it's taken.
const CLAIM_PAUSES = 1.6;

// A mystery bot keeps its personality here and nowhere else: phones are
// sent only "mystery".
type SeatRow = { kind: "human"; id: string } | { kind: "bot"; bot: TableBot; mystery?: true };
type Decision = Claim | null | "waiting";
type TableMessage = Exclude<TableClientMessage, { t: "hello" | "ping" }>;

// The whole table: one row.
interface Runtime {
  phase: TableState["phase"];
  seats: (SeatRow | null)[];
  settings: TableSettings;
  game: GameState | null;
  totals: number[];
  hand: number;
  step: number; // one higher at each new decision
  deadline: number | null; // the people being waited on must act by then
  botAt: number | null; // when the next bot (or away player) acts
  decisions: Decision[] | null; // a claim window's answers so far
  ready: number[]; // between hands
  away: Record<number, number>; // seat -> when its player dropped
  auto: number[]; // seats being played for
  last: TableAction | null;
  settled: number; // the last hand whose payments are in `totals`
  scores: number; // entries in the record
  shown?: number[]; // this hand's end, losing hands hidden: who has shown theirs
}

// crypto.getRandomValues as a number in [0, 1), for the wall, the dice and the bots.
const random = () => crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32;

const sameClaim = (a: Claim, b: Claim) =>
  a.kind === b.kind && (a.kind !== "chow" || (b.kind === "chow" && [...a.tiles].map(key).sort().join() === [...b.tiles].map(key).sort().join()));
const key = (t: Tile) => `${t.suit}${t.rank}`;

export class Table extends Hub<TableMessage> {
  // 2: the table's record (a Scores-tab game) alongside it.
  protected get schema() {
    return 2;
  }

  private rt!: Runtime; // loaded for each event
  // BOT_PAUSE_MS, unless the environment says otherwise (the tests: 0).
  protected pause = this.env.TABLE_PAUSE_MS === undefined ? BOT_PAUSE_MS : Number(this.env.TABLE_PAUSE_MS);

  protected initialize() {
    const fresh: Runtime = {
      phase: "lobby",
      seats: [null, null, null, null],
      settings: DEFAULT_TABLE_SETTINGS,
      game: null,
      totals: [0, 0, 0, 0],
      hand: 0,
      step: 0,
      deadline: null,
      botAt: null,
      decisions: null,
      ready: [],
      away: {},
      auto: [],
      last: null,
      settled: 0,
      scores: 0,
    };
    this.setMeta("state", fresh);
  }

  private load(): Runtime {
    this.rt = this.meta<Runtime>("state")!;
    return this.rt;
  }

  private save() {
    this.setMeta("state", this.rt);
  }

  protected extraTables() {
    return "CREATE TABLE IF NOT EXISTS record (i INTEGER PRIMARY KEY, body TEXT NOT NULL);";
  }

  // ---- The record -------------------------------------------------------------------

  // What one step of the game scored, into the record.
  private record(before: GameState | null, after: GameState) {
    const head = this.meta<ScoreGame>("recordHead");
    if (!head) return;
    this.addToRecord(playEvents(before, after, head.seats));
  }

  private addToRecord(events: ScoreEvent[]) {
    for (const ev of events) this.sql.exec("INSERT INTO record (i, body) VALUES (?, ?)", this.rt.scores++, JSON.stringify(ev));
  }

  // The table so far as a Scores-tab game, or null before the first deal.
  async scores(): Promise<ScoreGame | null> {
    const head = this.meta<ScoreGame>("recordHead");
    if (!head) return null;
    const events = this.sql.exec<{ body: string }>("SELECT body FROM record ORDER BY i").toArray().map((r) => JSON.parse(r.body) as ScoreEvent);
    return { ...head, events };
  }

  protected parse(frame: string | ArrayBuffer) {
    return parseTableMessage(frame);
  }

  async info(): Promise<{ phase: Runtime["phase"]; seats: (string | null)[] } | null> {
    if (this.meta("code") === null) return null;
    const rt = this.load();
    return { phase: rt.phase, seats: rt.seats.map((s) => (s ? this.seatName(s) : null)) };
  }

  private seatName(s: SeatRow): string {
    if (s.kind === "human") return this.person(s.id)?.name ?? "?";
    if (!s.mystery) return profileById(s.bot).name;
    // Several mystery bots are told apart by number.
    const mysteries = this.rt.seats.filter((x) => x?.kind === "bot" && x.mystery);
    return mysteries.length > 1 ? `${MYSTERY_NAME} ${mysteries.indexOf(s) + 1}` : MYSTERY_NAME;
  }

  private seatOf(personId: string): number | null {
    const i = this.rt.seats.findIndex((s) => s?.kind === "human" && s.id === personId);
    return i >= 0 ? i : null;
  }

  // Bots, and people being played for, act on their own.
  private actsAlone(seat: number): boolean {
    return this.rt.seats[seat]?.kind === "bot" || this.rt.auto.includes(seat);
  }

  protected welcome(id: string, token: string, rid?: string): TableServerMessage {
    this.load();
    return { t: "welcome", v: PROTOCOL_VERSION, token, id, name: this.person(id)!.name, host: this.isHost(id), seat: this.seatOf(id), ...(rid === undefined ? {} : { rid }) };
  }

  // ---- Arriving and leaving ----------------------------------------------------

  protected onArrive(personId: string) {
    const rt = this.load();
    // In the lobby, someone arriving takes the first empty seat (they can
    // move, or stand to watch).
    if (rt.phase === "lobby" && this.seatOf(personId) === null) {
      const free = rt.seats.indexOf(null);
      if (free >= 0) {
        rt.seats[free] = { kind: "human", id: personId };
        this.save();
      }
      return;
    }
    const seat = this.seatOf(personId);
    if (seat === null) return;
    delete rt.away[seat];
    rt.auto = rt.auto.filter((s) => s !== seat);
    this.run(Date.now());
    this.save();
    void this.schedule();
  }

  protected onLeave(personId: string) {
    const rt = this.load();
    const seat = this.seatOf(personId);
    if (seat === null || rt.phase !== "playing") return;
    rt.away[seat] = Date.now();
    this.save();
    void this.schedule();
  }

  // ---- Messages -------------------------------------------------------------------

  protected async act(personId: string, msg: TableMessage) {
    const rt = this.load();
    const host = this.isHost(personId);
    const mine = this.seatOf(personId);
    const lobby = () => {
      if (rt.phase !== "lobby") throw new Refusal("started", "the game has started");
    };
    const playing = () => {
      if (rt.phase === "lobby") throw new Refusal("notStarted", "the game hasn't started");
      if (rt.phase === "ended") throw new Refusal("ended", "the table has finished");
    };
    const hostOnly = () => {
      if (!host) throw new Refusal("notHost", "only the host can do that");
    };
    const seated = (): number => {
      if (mine === null) throw new Refusal("notSeated", "only the players at the table can do that");
      return mine;
    };
    switch (msg.t) {
      case "sit": {
        lobby();
        const taken = rt.seats[msg.seat];
        if (taken && !(taken.kind === "human" && taken.id === personId)) throw new Refusal("seatTaken", "someone is in that seat");
        if (mine !== null) rt.seats[mine] = null;
        rt.seats[msg.seat] = { kind: "human", id: personId };
        break;
      }
      case "stand":
        lobby();
        if (mine !== null) rt.seats[mine] = null;
        break;
      case "setBot": {
        lobby();
        hostOnly();
        const taken = rt.seats[msg.seat];
        if (taken?.kind === "human") throw new Refusal("seatTaken", "someone is in that seat");
        rt.seats[msg.seat] = !msg.bot
          ? null
          : msg.bot === MYSTERY_BOT
            ? { kind: "bot", bot: randomStyle(random) as TableBot, mystery: true }
            : { kind: "bot", bot: msg.bot };
        break;
      }
      case "setup":
        lobby();
        hostOnly();
        rt.settings = msg.settings;
        break;
      case "start": {
        lobby();
        hostOnly();
        if (rt.seats.some((s) => s === null)) throw new Refusal("seatsNotFull", "every seat needs a player or a bot");
        rt.game = dealHand({ dealer: rt.settings.firstDealer, roundWind: 1, dealerStreak: 0, multiWin: rt.settings.multiWin }, undefined, random);
        rt.phase = "playing";
        // The record starts with the first deal (its dice and flowers).
        this.setMeta("recordHead", newPlayLedger(rt.seats.map((x) => this.seatName(x!)), rt.settings.firstDealer, Date.now(), `table-${this.meta("code")}`));
        this.record(null, rt.game);
        rt.hand = 1;
        rt.step = 1;
        rt.totals = [0, 0, 0, 0];
        // Anyone seated but not here is away from the first deal.
        const online = this.online();
        rt.seats.forEach((s, i) => s?.kind === "human" && !online.has(s.id) && (rt.away[i] = Date.now()));
        this.collectBonuses();
        this.newDecision(Date.now());
        break;
      }
      case "move": {
        playing();
        const seat = seated();
        const g = rt.game!;
        if (msg.step !== rt.step) throw new Refusal("stale", "that turn has passed");
        if (g.phase.kind !== "turn" || g.phase.seat !== seat || this.actsAlone(seat)) throw new Refusal("notYourTurn", "it isn't your turn");
        this.applyMove(seat, msg.move as TurnMove, "refuse");
        break;
      }
      case "claim": {
        playing();
        const seat = seated();
        const g = rt.game!;
        if (msg.step !== rt.step) throw new Refusal("stale", "that discard has gone");
        if (g.phase.kind !== "claims" || rt.decisions?.[seat] !== "waiting") throw new Refusal("notYourTurn", "nothing to claim right now");
        const claim = msg.claim as Claim | null;
        if (claim && !claimOptions(g, seat).some((o) => sameClaim(o, claim))) throw new Refusal("illegal", "you can't make that claim");
        rt.decisions![seat] = claim;
        break;
      }
      case "ready": {
        playing();
        const seat = seated();
        if (rt.game?.phase.kind !== "over") throw new Refusal("notYourTurn", "the hand isn't over");
        if (!rt.ready.includes(seat)) rt.ready.push(seat);
        break;
      }
      case "show": {
        playing();
        const seat = seated();
        if (rt.game?.phase.kind !== "over") throw new Refusal("notYourTurn", "the hand isn't over");
        if (!(rt.shown ??= []).includes(seat)) rt.shown.push(seat);
        break;
      }
      case "surrender": {
        playing();
        const seat = seated();
        const before = rt.game!;
        try {
          rt.game = surrender(before, msg.holder, seat);
        } catch {
          throw new Refusal("illegal", "that 拉 can't be surrendered now");
        }
        this.record(before, rt.game);
        break;
      }
      case "end":
        hostOnly();
        rt.phase = "ended";
        rt.deadline = null;
        rt.botAt = null;
        break;
      case "rematch": {
        hostOnly();
        if (rt.phase !== "ended") throw new Refusal("illegal", "the table hasn't finished");
        // Back to the lobby: the same seats and rules, a new game and record.
        Object.assign(rt, {
          phase: "lobby",
          game: null,
          totals: [0, 0, 0, 0],
          hand: 0,
          step: 0,
          deadline: null,
          botAt: null,
          decisions: null,
          ready: [],
          away: {},
          auto: [],
          last: null,
          settled: 0,
          scores: 0,
          shown: [],
        } satisfies Partial<Runtime>);
        this.sql.exec("DELETE FROM record");
        this.setMeta("recordHead", null);
        break;
      }
      case "react": {
        // Straight out to everyone - not stored, not a change to the table.
        const seat = seated();
        for (const [ws] of this.conns()) this.send(ws, { t: "reaction", seat, r: msg.r });
        return;
      }
    }
    this.run(Date.now());
    this.save();
    this.changed();
    await this.schedule();
  }

  // ---- Moving the hand on -------------------------------------------------------------

  // A new decision: count it, and set who's waited on until when.
  private newDecision(now: number) {
    const rt = this.rt;
    const g = rt.game!;
    rt.step++;
    rt.deadline = null;
    rt.botAt = null;
    rt.decisions = null;
    const timer = rt.settings.timer * 1000;
    if (g.phase.kind === "turn") {
      if (this.actsAlone(g.phase.seat)) rt.botAt = now + this.pause;
      else if (timer) rt.deadline = now + timer;
    } else if (g.phase.kind === "claims") {
      // Bots and away players answer at once; people with something to claim
      // are waited on; everyone else passes.
      rt.decisions = Array.from({ length: SEATS }, (_, seat): Decision => {
        if (g.phase.kind !== "claims" || seat === g.phase.from || claimOptions(g, seat).length === 0) return null;
        return this.actsAlone(seat) ? this.aloneClaim(seat) : "waiting";
      });
      if (timer && rt.decisions.includes("waiting")) rt.deadline = now + timer;
      // Only bots (or away players) answered, and one calls: the discard
      // stays on the table a moment before it's taken. (If someone was
      // waited on, everyone has already seen it.)
      if (!rt.decisions.includes("waiting") && rt.decisions.some((x) => x !== null) && this.pause > 0) rt.botAt = now + this.pause * CLAIM_PAUSES;
    } else {
      rt.ready = [];
    }
  }

  // `auto`: the table is moving for a person (out of time, or away).
  private applyMove(seat: number, move: TurnMove, onIllegal: "refuse" | "fallback", auto = false) {
    const rt = this.rt;
    let next: GameState;
    try {
      next = applyTurnMove(rt.game!, move);
    } catch (e) {
      if (onIllegal === "refuse") throw new Refusal("illegal", e instanceof Error ? e.message : "not a legal move");
      next = applyTurnMove(rt.game!, botTurnMove(rt.game!));
    }
    const before = rt.game!;
    rt.game = next;
    this.record(before, next);
    const by = auto ? { auto: true } : {};
    if (move.kind === "discard" && next.phase.kind === "claims" && !next.phase.robKong) rt.last = { kind: "discard", seat, tile: move.tile, ...(move.riichi ? { riichi: true } : {}), ...by };
    else if (move.kind === "concealedKong" || move.kind === "addedKong") rt.last = { kind: "kong", seat, concealed: move.kind === "concealedKong", ...by };
    this.collectBonuses();
    this.afterStep(before);
  }

  private resolve() {
    const rt = this.rt;
    const before = rt.game!;
    const decisions = rt.decisions!.map((d) => (d === "waiting" ? null : d));
    rt.game = resolveClaims(before, decisions);
    this.record(before, rt.game);
    const g = rt.game;
    if (before.phase.kind === "claims" && g.phase.kind === "turn" && g.phase.seat !== (before.phase.from + 1) % SEATS) {
      const claim = decisions[g.phase.seat];
      if (claim && claim.kind !== "win") rt.last = { kind: "call", seat: g.phase.seat, call: claim.kind, from: before.phase.from };
    } else if (before.phase.kind === "claims" && g.phase.kind === "turn" && g.phase.seat === (before.phase.from + 1) % SEATS) {
      const claim = decisions[g.phase.seat];
      if (claim?.kind === "chow") rt.last = { kind: "call", seat: g.phase.seat, call: "chow", from: before.phase.from };
    }
    this.collectBonuses();
    this.afterStep(before);
  }

  // After the engine moved: note a finished hand's result, then the next decision.
  private afterStep(before: GameState) {
    const rt = this.rt;
    const g = rt.game!;
    if (g.phase.kind === "over" && before.phase.kind !== "over") {
      const r = g.phase.result;
      rt.last = r.winner === null ? { kind: "draw" } : { kind: "win", seats: [r.winner, ...(r.alsoWon ?? []).map((w) => w.winner)], from: r.from, ...(r.robKong ? { robKong: true } : {}) };
      if (rt.settled < rt.hand) {
        for (let i = 0; i < SEATS; i++) rt.totals[i] += r.deltas[i];
        rt.settled = rt.hand;
      }
    }
    this.newDecision(Date.now());
  }

  // Dice and flower bonuses, paid as they come up.
  private collectBonuses() {
    const rt = this.rt;
    const g = rt.game!;
    if (g.diceBonus && !g.diceBonus.paid) {
      for (let i = 0; i < SEATS; i++) rt.totals[i] += g.diceBonus.deltas[i];
      g.diceBonus = { ...g.diceBonus, paid: true };
    }
    if (g.tableBonuses?.some((b) => !b.paid)) {
      g.tableBonuses = g.tableBonuses.map((b) => {
        if (b.paid) return b;
        for (let i = 0; i < SEATS; i++) rt.totals[i] += b.deltas[i];
        return { ...b, paid: true };
      });
    }
  }

  // What a bot, or someone being played for, does with a claim.
  private aloneClaim(seat: number): Claim | null {
    const row = this.rt.seats[seat]!;
    const g = this.rt.game!;
    if (row.kind === "bot") return botClaimFor(g, seat, profileById(row.bot), random);
    return claimOptions(g, seat).find((o) => o.kind === "win") ?? null; // played for: win if you can, else pass
  }

  // What a bot, or someone being played for, does on their turn. Out of
  // time (`timedOut`): the drawn tile goes, as on the Play tab.
  private aloneMove(seat: number, timedOut = false): TurnMove {
    const row = this.rt.seats[seat]!;
    const g = this.rt.game!;
    if (row.kind === "bot" && !timedOut) return botTurnMoveFor(g, profileById(row.bot), random);
    const p = g.players[seat];
    if (!timedOut && canWin(p)) return { kind: "selfDraw" };
    const forced = riichiForcedDiscard(g);
    if (forced) return { kind: "discard", tile: forced };
    const drawn = g.phase.kind === "turn" ? g.phase.drawn : null;
    if (drawn && !forbiddenDiscards(g).some((t) => sameTile(t, drawn))) return { kind: "discard", tile: drawn };
    return botTurnMove(g);
  }

  // Move the hand on as far as it goes without waiting for a person. Runs
  // on every event; writes nothing itself (the caller saves once).
  private run(now: number) {
    const rt = this.rt;
    if (rt.phase !== "playing" || !rt.game) return;
    // Nobody at the table is here: nothing moves until someone's back.
    const online = this.online();
    const humans = rt.seats.flatMap((s, i) => (s?.kind === "human" ? [{ seat: i, id: s.id }] : []));
    if (!humans.some((h) => online.has(h.id))) return;
    // Seats held long enough are played for.
    for (const h of humans) {
      const since = rt.away[h.seat];
      if (since !== undefined && now >= since + rt.settings.hold * 1000 && !rt.auto.includes(h.seat)) rt.auto.push(h.seat);
    }
    for (let guard = 0; guard < 500; guard++) {
      const g = rt.game;
      if (g.phase.kind === "turn") {
        const seat = g.phase.seat;
        if (this.actsAlone(seat)) {
          if (rt.botAt === null) rt.botAt = now + this.pause;
          if (now < rt.botAt) return;
          this.applyMove(seat, this.aloneMove(seat), "fallback", rt.auto.includes(seat));
          continue;
        }
        if (rt.deadline !== null && now >= rt.deadline) {
          this.applyMove(seat, this.aloneMove(seat, true), "fallback", true);
          continue;
        }
        return;
      }
      if (g.phase.kind === "claims") {
        const d = rt.decisions!;
        // Someone who's just become away, or is now played for, answers alone.
        for (let s = 0; s < SEATS; s++) if (d[s] === "waiting" && this.actsAlone(s)) d[s] = this.aloneClaim(s);
        if (d.includes("waiting")) {
          if (rt.deadline !== null && now >= rt.deadline) d.forEach((x, s) => x === "waiting" && (d[s] = null)); // out of time: pass
          else return;
        }
        // A bot's call: the discard is seen on the table first (see newDecision).
        if (rt.botAt !== null && now < rt.botAt) return;
        this.resolve();
        continue;
      }
      // Between hands: bots surrender a long 拉 by personality; the next hand
      // is dealt once every person here (and not played for) is ready.
      for (const [s, row] of rt.seats.entries()) {
        if (row?.kind !== "bot") continue;
        for (const holder of botSurrenders(g, s, profileById(row.bot))) {
          const before = rt.game;
          rt.game = surrender(before, holder, s);
          this.record(before, rt.game);
        }
      }
      const waiting = humans.filter((h) => online.has(h.id) && !rt.auto.includes(h.seat) && !rt.ready.includes(h.seat));
      if (waiting.length) return;
      const ended = rt.game;
      rt.game = nextHand(ended, undefined, random);
      this.record(ended, rt.game);
      rt.shown = [];
      rt.hand++;
      rt.last = null;
      this.collectBonuses();
      this.newDecision(now);
    }
  }

  // ---- The alarm: bots, deadlines, held seats ----------------------------------------

  // The next moment something is due.
  private nextDue(): number | null {
    const rt = this.rt;
    if (rt.phase !== "playing") return null;
    const holds = Object.entries(rt.away).map(([seat, since]) => (rt.auto.includes(Number(seat)) ? Infinity : since + rt.settings.hold * 1000));
    const due = Math.min(rt.botAt ?? Infinity, rt.deadline ?? Infinity, ...holds);
    return Number.isFinite(due) ? due : null;
  }

  // Set the alarm for exactly the next thing due - replacing a deadline that
  // was met - so it only fires when there's something to do.
  private async schedule() {
    const due = this.nextDue();
    if (due !== null) await this.ctx.storage.setAlarm(due);
  }

  protected onAlarm(now: number): number | null {
    if (this.meta("code") === null) return null;
    const rt = this.load();
    const before = JSON.stringify(rt);
    this.run(now);
    if (JSON.stringify(rt) !== before) {
      this.save();
      this.changed();
    }
    // Paused (no one here) or idle: nothing of the table's own is pending.
    const humansHere = rt.seats.some((s) => s?.kind === "human" && this.online().has(s.id));
    return humansHere ? this.nextDue() : null;
  }

  // ---- What each phone is sent ------------------------------------------------------------

  private stateFor(seat: number | null, except?: WebSocket): TableState {
    const rt = this.rt;
    const online = this.online(except);
    const g = rt.game;
    const seats: (SeatInfo | null)[] = rt.seats.map((s) =>
      !s
        ? null
        : s.kind === "bot"
          ? { kind: "bot", bot: s.mystery ? MYSTERY_BOT : s.bot, name: this.seatName(s) }
          : { kind: "human", id: s.id, name: this.seatName(s), connected: online.has(s.id), host: this.isHost(s.id) }
    );
    const waitingOn: number[] = !g
      ? []
      : g.phase.kind === "turn"
        ? this.actsAlone(g.phase.seat)
          ? []
          : [g.phase.seat]
        : g.phase.kind === "claims"
          ? (rt.decisions ?? []).flatMap((d, s) => (d === "waiting" ? [s] : []))
          : rt.seats.flatMap((s, i) => (s?.kind === "human" && !rt.auto.includes(i) && !rt.ready.includes(i) ? [i] : []));
    let options: YourOptions | null = null;
    if (g && seat !== null && rt.phase === "playing" && waitingOn.includes(seat)) {
      const p = g.players[seat];
      options =
        g.phase.kind === "turn"
          ? { turn: { selfDraw: canWin(p), kongs: p.riichi ? [] : kongOptions(p, g.phase), riichi: riichiDiscards(g, seat), forbidden: forbiddenDiscards(g) }, claims: [] }
          : { turn: null, claims: g.phase.kind === "claims" ? claimOptions(g, seat) : [] };
    }
    const people = this.people();
    return {
      code: this.meta<string>("code")!,
      version: this.clock.version,
      phase: rt.phase,
      seats,
      watching: people.filter((p) => online.has(p.id) && !rt.seats.some((s) => s?.kind === "human" && s.id === p.id)).length,
      settings: rt.settings,
      totals: rt.totals,
      hand: rt.hand,
      step: rt.step,
      deadline: rt.deadline,
      waitingOn,
      ready: rt.ready,
      auto: rt.auto,
      shown: rt.shown ?? [],
      scores: rt.scores,
      last: rt.last,
      you: seat,
      view: g ? viewFor(g, seat ?? -1, (s) => this.handShown(g, s)) : null,
      options,
    };
  }

  // At a hand's end, whether everyone sees this seat's hand: always, unless
  // the table keeps losing hands hidden - then a winner's, or one shown.
  private handShown(g: GameState, seat: number): boolean {
    if (this.rt.settings.reveal !== false || g.phase.kind !== "over") return true;
    const r = g.phase.result;
    return r.winner === seat || !!r.alsoWon?.some((w) => w.winner === seat) || !!this.rt.shown?.includes(seat);
  }

  protected broadcast(except?: WebSocket) {
    if (!this.rt) this.load();
    for (const [ws, c] of this.conns(except)) {
      if (!c.person) continue;
      this.send(ws, { t: "table", table: this.stateFor(this.seatOf(c.person), except) } satisfies TableServerMessage);
    }
  }
}
