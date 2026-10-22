// Play tab: a full hand of 16-tile mahjong against three local bots, laid
// out as a landscape table - you along the bottom, the bots right / across /
// left in turn order. All the rules and the bots live in lib/game.ts; this
// file only renders the state, paces the bots and takes the human's input.
//
// The look borrows from commercial 16-tile apps: a wind compass in the
// middle that lights whoever is to act, each player's concealed tiles drawn
// edge-on along their side with their pond in front of them, the latest
// discard in a spotlight while it can be claimed, big round call buttons and
// a call burst by whoever calls.
//
// The table fills the screen (over the tab bar, with its own Leave button),
// and a phone held upright gets a "turn to landscape" card instead, since a
// web page can't lock orientation on iPhone.

import { useEffect, useMemo, useRef, useState } from "react";
import {
  applyTurnMove,
  claimOptions,
  forbiddenDiscards,
  HUMAN,
  isWinningHand,
  kongOptions,
  liveTilesLeft,
  meldsNeeded,
  newGame,
  nextHand,
  resolveClaims,
  surrender,
  surrenderable,
  riichiDiscards,
  riichiForcedDiscard,
  roundLabel,
  wallBreak,
  type Dice,
  sameTile,
  SEATS,
  seatWind,
  unseenCounts,
  winningClaimSeat,
  type Claim,
  type GameMeld,
  type GameState,
  type TurnMove,
} from "./lib/game";
import { allTileKinds, getWaits, shanten, sortTiles, tileKey, tileLabel, type Tile } from "./lib/mahjong";
import { patternDisplayName, type BonusTile } from "./lib/scoring";
import { BonusGlyphSpan, TileGlyphSpan } from "./TileGlyphs";
import { BOT_PROFILES, botClaimFor, botSurrenders, botTurnFor, LEARNED_PREFIX, learnedProfile, learnedStyle, profileById, rateDiscardsFor, voiceOf, type BotProfile, type Voice } from "./lib/bots";
import { loadLearnedModel, type LearnedModel } from "./lib/ml/browser";
import { learnedClaim, learnedTurnMove, type LearnedBot } from "./lib/ml/policy";
import { claimDecisionAction, encodeObservation, legalActions, turnMoveAction } from "./lib/ml/encode";
import { countRecorded, exportRecorded, finishHand, recordDecision } from "./lib/ml/recorder";

const WIND_CHARS = ["", "東", "南", "西", "北"];
// Ready-made tables: who sits at Right / Across / Left (seats 1-3).
const PRESETS = [
  { label: "Mixed", bots: ["veteran", "hunter", "speedster"] },
  { label: "Tough", bots: ["grandmaster", "veteran", "grandmaster"] },
  { label: "Styles", bots: ["wall", "gambler", "hunter"] },
  { label: "Friendly", bots: ["casual", "casual", "casual"] },
] as const;
const DEFAULT_OPPONENTS = [...PRESETS[0].bots];
// Seats 1-3 as the opponents sheet names them.
const SEAT_LABELS = ["", "Right", "Across", "Left"];
// "老手 Veteran" -> "老手" / "Veteran".
const shortName = (p: BotProfile) => p.name.split(" ")[0];
const englishName = (p: BotProfile) => p.name.split(" ").slice(1).join(" ");
// Each personality's avatar: the first character of its title on its own
// colour (see .play-avatar.is-<id>).
// A learned bot wears its personality's avatar with a ring.
const Avatar = ({ bot }: { bot: BotProfile }) => {
  const style = learnedStyle(bot);
  return (
    <span className={`play-avatar is-${style ?? bot.id}${style ? " is-learned" : ""}`} aria-hidden="true">
      {style ? profileById(style).name[0] : bot.name[0]}
    </span>
  );
};
// A seat's bot by id: a personality, or "net-<personality>" for a learned one.
const botById = (id: string): BotProfile => (id.startsWith(LEARNED_PREFIX) ? learnedProfile(id.slice(LEARNED_PREFIX.length)) : profileById(id));
const knownBot = (id: string) => BOT_PROFILES.some((p) => p.id === id || LEARNED_PREFIX + p.id === id);
// Hints and the timer's fallback throw judge the way the Veteran does.
const ADVISOR = profileById("veteran");
// Where each seat sits on screen, by seat index.
const SIDES = ["bottom", "right", "top", "left"] as const;
type Side = (typeof SIDES)[number];
// How long a bot "thinks" before a move, like a person: an obvious throw
// goes almost at once, a close or risky one gets a real pause (difficulty
// 0..1 from botTurnFor), with a little jitter, and a beat more after a
// call while it re-plans its hand.
const botDelay = (difficulty: number, afterCall: boolean) => 300 + difficulty * 1300 + Math.random() * 260 + (afterCall ? 300 : 0);
// A discard nobody can claim moves on after a short pause - longer when a
// bot had a call to weigh and passed (a tell, as at a real table).
const PASS_DELAY_MS = 380;
const PONDER_DELAY_MS = 900;
// The bots' pace, from the menu: every pause is multiplied by this.
const SPEEDS = { slow: { label: "Slow", factor: 1.6 }, normal: { label: "Normal", factor: 1 }, fast: { label: "Fast", factor: 0.45 } } as const;
type Speed = keyof typeof SPEEDS;
// With hints on, a tile at least this dangerous (the Veteran's deal-in read)
// gets a red mark.
const DANGER_MARK = 0.12;
const BUBBLE_MS = 2200;
const BURST_MS = 1200;
const TIMER_CHOICES = [0, 10, 20] as const;
type TimerSetting = (typeof TIMER_CHOICES)[number];

const SAVE_KEY = "mjwaits.play";

interface Saved {
  game: GameState;
  totals: number[];
  hint: boolean;
  timer?: TimerSetting;
  speed?: Speed;
  oneTap?: boolean;
  record?: boolean;
  // The bot ids at seats 1-3.
  opponents?: string[];
}

function loadSaved(): Saved | null {
  try {
    const raw = window.localStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw) as Saved;
    if (!saved?.game?.players || saved.game.players.length !== SEATS || !Array.isArray(saved.totals)) return null;
    return saved;
  } catch {
    return null;
  }
}

function save(saved: Saved): void {
  try {
    window.localStorage.setItem(SAVE_KEY, JSON.stringify(saved));
  } catch {
    // Storage unavailable - the game just won't survive a reload.
  }
}

const claimLabel = (c: Claim) => (c.kind === "win" ? "胡" : c.kind === "kong" ? "槓" : c.kind === "pung" ? "碰" : "上");

// ---- Pieces of the table ----------------------------------------------------

// A seat's concealed tiles, seen edge-on from the middle of the table.
function EdgeTiles({ count, side }: { count: number; side: Side }) {
  return (
    <span className={`play-edge play-edge-${side}`} aria-label={`${count} concealed tiles`}>
      {Array.from({ length: count }, (_, i) => (
        <span key={i} className="play-edge-tile" />
      ))}
    </span>
  );
}

// `hideConcealed`: a bot's concealed kong lies fully face down - nothing
// about it shows until the hand is over. Your own shows its two middle
// tiles, so you can see what you've set aside.
function Melds({ melds, hideConcealed }: { melds: GameMeld[]; hideConcealed?: boolean }) {
  return (
    <>
      {melds.map((m, i) => (
        <span key={i} className="play-meld">
          {m.tiles.map((t, j) =>
            m.concealed && (hideConcealed || j === 0 || j === 3) ? <span key={j} className="play-back" /> : <TileGlyphSpan key={j} tile={t} />
          )}
        </span>
      ))}
    </>
  );
}

function Flowers({ flowers }: { flowers: BonusTile[] }) {
  if (flowers.length === 0) return null;
  return (
    <span className="play-flowers">
      {flowers.map((f, i) => (
        <BonusGlyphSpan key={i} tile={f} />
      ))}
    </span>
  );
}

// A finished hand's concealed tiles, sorted, with the winning tile marked once.
function RevealedHand({ tiles, winningTile }: { tiles: Tile[]; winningTile: Tile | null }) {
  const sorted = sortTiles(tiles);
  const mark = winningTile ? sorted.findIndex((t) => sameTile(t, winningTile)) : -1;
  return (
    <span className="play-meld">
      {sorted.map((t, i) => (
        <TileGlyphSpan key={i} tile={t} highlight={i === mark} />
      ))}
    </span>
  );
}

// A seat's discards, in front of it; the newest one carries a gold pin.
// `riichiAt`: the pond index of the tile that declared 叮, laid sideways.
function Pond({ tiles, side, pinLast, riichiAt }: { tiles: Tile[]; side: Side; pinLast: boolean; riichiAt?: number }) {
  return (
    <div className={`play-pond play-pond-${side}`}>
      {tiles.map((t, i) => {
        const last = pinLast && i === tiles.length - 1;
        return (
          <span key={i} className={["play-pond-tile", last && "is-latest", i === riichiAt && "is-riichi"].filter(Boolean).join(" ")}>
            <TileGlyphSpan tile={t} />
          </span>
        );
      })}
    </div>
  );
}

// The wind compass: the four seats' winds where those seats sit, the one to
// act lit gold with a beam toward them, and a number in the middle.
function Compass({ game, active, center }: { game: GameState; active: number | null; center: string }) {
  return (
    <div className="play-compass" aria-hidden="true">
      {SIDES.map((side, seat) => (
        <span key={side} className={`play-compass-q play-compass-${side}${active === seat ? " is-active" : ""}`}>
          {WIND_CHARS[seatWind(seat, game.dealer)]}
        </span>
      ))}
      {active !== null && <span className={`play-compass-beam to-${SIDES[active]}`} />}
      <span className="play-compass-center">{center}</span>
    </div>
  );
}

function CallBurst({ seat, label }: { seat: number; label: string }) {
  return (
    <span key={`${seat}${label}`} className={`play-burst at-${SIDES[seat]}${label.length > 1 ? " is-long" : ""}`} aria-live="polite">
      {label}
    </span>
  );
}

function TileTracker({ game, onClose }: { game: GameState; onClose: () => void }) {
  const unseen = unseenCounts(game, HUMAN);
  return (
    <div className="play-sheet-backdrop" onClick={onClose}>
      <div className="play-sheet play-tracker" role="dialog" aria-label="Tile tracker" onClick={(e) => e.stopPropagation()}>
        <div className="play-sheet-head">
          <h2>記牌器</h2>
          <span>Tiles you haven't seen yet</span>
          <button type="button" className="play-sheet-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="play-tracker-grid">
          {allTileKinds().map((t) => {
            const left = Math.max(0, unseen.get(tileKey(t)) ?? 0);
            return (
              <span key={tileKey(t)} className={left === 0 ? "play-tracker-cell is-gone" : "play-tracker-cell"}>
                <TileGlyphSpan tile={t} />
                <span className="play-tracker-count">{left}</span>
              </span>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// Who you play against: a ready-made table, or a bot per seat from the
// whole roster. Changes take effect from the next move.
function OpponentsSheet({
  opponents,
  learned,
  onChange,
  onClose,
}: {
  opponents: string[];
  // The personalities a learned model can play, once it has loaded.
  learned: string[] | null;
  onChange: (ids: string[]) => void;
  onClose: () => void;
}) {
  const choices = [...BOT_PROFILES, ...(learned ?? []).filter((st) => BOT_PROFILES.some((p) => p.id === st)).map(learnedProfile)];
  return (
    <div className="play-sheet-backdrop" onClick={onClose}>
      <div className="play-sheet play-opponents" role="dialog" aria-label="Opponents" onClick={(e) => e.stopPropagation()}>
        <div className="play-sheet-head">
          <h2>對手 Opponents</h2>
          <span>Pick a table, or a bot for each seat</span>
          <button type="button" className="play-sheet-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="play-presets">
          {PRESETS.map((p) => {
            const on = p.bots.every((id, i) => opponents[i] === id);
            return (
              <button key={p.label} type="button" className={on ? "toggle-on" : undefined} aria-pressed={on} onClick={() => onChange([...p.bots])}>
                {p.label}
              </button>
            );
          })}
        </div>
        {[1, 2, 3].map((seat) => {
          const current = botById(opponents[seat - 1]);
          return (
            <div key={seat} className="play-opponent-row">
              <span className="play-opponent-seat">{SEAT_LABELS[seat]}</span>
              <div className="play-opponent-chips">
                {choices.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    className={[p.id === current.id && "toggle-on", learnedStyle(p) && "is-learned"].filter(Boolean).join(" ") || undefined}
                    aria-pressed={p.id === current.id}
                    title={englishName(p)}
                    aria-label={`${SEAT_LABELS[seat]}: ${englishName(p)}`}
                    onClick={() => onChange(opponents.map((id, i) => (i === seat - 1 ? p.id : id)))}
                  >
                    {shortName(p)}
                  </button>
                ))}
              </div>
              <span className="play-opponent-blurb">
                <b>{englishName(current)}</b> {current.blurb}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// The pips on each face, as cells of a 3x3 grid (1-9, reading order) - as
// on the Dice tab.
const DIE_PIPS: Record<number, number[]> = { 1: [5], 2: [3, 7], 3: [3, 5, 7], 4: [1, 3, 7, 9], 5: [1, 3, 5, 7, 9], 6: [1, 3, 4, 6, 7, 9] };

// One Chinese die (red pips on the 1 and the 4), tumbling in when `rolling`.
function PlayDie({ value, rolling, index }: { value: number; rolling: boolean; index: number }) {
  return (
    <span
      className={`play-die${value === 1 || value === 4 ? " is-red" : ""}${value === 1 ? " is-one" : ""}${rolling ? " is-rolling" : ""}`}
      style={{ animationDelay: `${index * 70}ms` }}
      role="img"
      aria-label={`${value}`}
    >
      {Array.from({ length: 9 }, (_, i) => (
        <span key={i} className={DIE_PIPS[value]?.includes(i + 1) ? "play-die-pip" : undefined} />
      ))}
    </span>
  );
}

// ---- The table ------------------------------------------------------------

export function PlayPanel({ onExit }: { onExit: () => void }) {
  const saved = useMemo(loadSaved, []);
  const [game, setGame] = useState<GameState>(() => saved?.game ?? newGame());
  const [totals, setTotals] = useState<number[]>(() => saved?.totals ?? [0, 0, 0, 0]);
  const [hint, setHint] = useState(() => saved?.hint ?? false);
  const [timer, setTimer] = useState<TimerSetting>(() => saved?.timer ?? 0);
  // One-tap discard: a single tap throws the tile (off: tap to lift, tap again).
  const [oneTap, setOneTap] = useState(() => saved?.oneTap ?? false);
  // Record my play (off by default): your decisions, kept in this browser for
  // training a learned bot that plays like you (lib/ml/recorder.ts).
  const [record, setRecord] = useState(() => saved?.record ?? false);
  const [recorded, setRecorded] = useState<number | null>(null);
  const handId = useRef(String(Date.now()));
  const [speed, setSpeed] = useState<Speed>(() => (saved?.speed && saved.speed in SPEEDS ? saved.speed : "normal"));
  // The dealer's dice, shown tumbling in at the start of each deal while
  // play waits (rolling); remembered per deal so a reload mid-hand doesn't
  // roll again.
  const [rolling, setRolling] = useState(false);
  const rolledFor = useRef<Dice | null>(null);
  useEffect(() => {
    const dice = game.dice;
    if (!dice || rolledFor.current === dice || game.discardsMade > 0 || game.phase.kind === "over") return;
    rolledFor.current = dice;
    setRolling(true);
  }, [game]);
  // How long the roll shows - timed on its own, so a re-run of the effect
  // above (which skips a deal it has seen) can't leave it showing forever.
  useEffect(() => {
    if (!rolling) return;
    const id = window.setTimeout(() => setRolling(false), speed === "fast" ? 900 : 1700);
    return () => window.clearTimeout(id);
  }, [rolling, speed]);
  const [opponents, setOpponents] = useState<string[]>(() =>
    saved?.opponents?.length === 3 && saved.opponents.every(knownBot) ? saved.opponents : DEFAULT_OPPONENTS
  );
  const [opponentsOpen, setOpponentsOpen] = useState(false);
  // 投降 on the result card takes two taps; this is the holder armed.
  const [surrenderArmed, setSurrenderArmed] = useState<string | null>(null);
  const bots = useMemo<(BotProfile | null)[]>(() => [null, ...opponents.map(botById)], [opponents]);
  // The learned bots' network: loaded when one is seated or the Opponents
  // sheet opens; until then (or if there's none) they play by their rules.
  const [model, setModel] = useState<LearnedModel | null>(null);
  const wantModel = opponentsOpen || opponents.some((id) => id.startsWith(LEARNED_PREFIX));
  useEffect(() => {
    if (wantModel && !model) void loadLearnedModel().then(setModel);
  }, [wantModel, model]);
  const learnedBot = (seat: number): LearnedBot | null => {
    const style = bots[seat] && learnedStyle(bots[seat]!);
    if (!style || !model || !model.styles.includes(style)) return null;
    // A little sampling, so it isn't the same robot every time.
    return { run: model.run, style: model.styles.indexOf(style), temperature: 0.25 };
  };
  // What each bot is saying, by seat (a speech bubble by its name card).
  const [bubbles, setBubbles] = useState<Record<number, { text: string; id: number }>>({});
  const say = (seat: number, line: keyof Voice) => {
    const bot = bots[seat];
    if (!bot) return;
    const lines = voiceOf(bot)[line];
    const id = Date.now() + seat;
    setBubbles((b) => ({ ...b, [seat]: { text: lines[Math.floor(Math.random() * lines.length)], id } }));
    window.setTimeout(() => setBubbles((b) => (b[seat]?.id === id ? Object.fromEntries(Object.entries(b).filter(([k]) => Number(k) !== seat)) : b)), BUBBLE_MS);
  };
  // "You", or the bot's English name (老手 Veteran -> Veteran).
  const nameOf = (seat: number) => (seat === HUMAN ? "You" : englishName(bots[seat]!));
  const [selected, setSelected] = useState<number | null>(null);
  const [burst, setBurst] = useState<{ seat: number; label: string; id: number } | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  // New game wipes the running totals, so it takes a second tap.
  const [confirmNew, setConfirmNew] = useState(false);
  const [trackerOpen, setTrackerOpen] = useState(false);
  const [chowChoice, setChowChoice] = useState(false);
  // 叮 armed: the next discard declares it (only tiles that leave you ready).
  const [riichiArmed, setRiichiArmed] = useState(false);
  const [resultHidden, setResultHidden] = useState(false);

  useEffect(() => save({ game, totals, hint, timer, opponents, speed, oneTap, record }), [game, totals, hint, timer, opponents, speed, oneTap, record]);

  // The menu closes on a tap anywhere outside it, and disarms New game.
  useEffect(() => {
    if (!menuOpen) return;
    const close = (e: PointerEvent) => {
      if ((e.target as Element).closest(".play-corner")) return;
      setMenuOpen(false);
      setConfirmNew(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [menuOpen]);

  // Every state change goes through here, so a finished hand's tai lands in
  // the running totals exactly once.
  const advance = (next: GameState) => {
    if (next.phase.kind === "over" && game.phase.kind !== "over") {
      const { deltas } = next.phase.result;
      setTotals((t) => t.map((v, i) => v + deltas[i]));
      if (record) void finishHand(handId.current, deltas[HUMAN]);
    }
    // A new deal: a new hand for the recorder.
    if (game.phase.kind === "over" && next.phase.kind !== "over") handId.current = String(Date.now());
    setSelected(null);
    setChowChoice(false);
    setRiichiArmed(false);
    setResultHidden(false);
    setGame(next);
  };

  const showBurst = (seat: number, label: string) => {
    const id = Date.now();
    setBurst({ seat, label, id });
    window.setTimeout(() => setBurst((b) => (b?.id === id ? null : b)), BURST_MS);
  };

  const humanClaims = game.phase.kind === "claims" ? claimOptions(game, HUMAN) : [];

  // The bots' claims on the current discard are decided as soon as it lands
  // (they can't see what the human will do).
  const botDecisions = useMemo(
    () => (game.phase.kind === "claims" ? Array.from({ length: SEATS }, (_, seat) => (seat === HUMAN ? null : botClaimFor(game, seat, bots[seat]!))) : null),
    [game, bots]
  );

  // Learned bots decide their claims through the network (async); a resolve
  // already under way for this discard ignores a second call.
  const resolving = useRef<GameState | null>(null);
  const resolve = async (humanClaim: Claim | null) => {
    if (!botDecisions || resolving.current === game) return;
    resolving.current = game;
    const decisions = botDecisions.slice();
    decisions[HUMAN] = humanClaim;
    if (humanClaims.length) recordMine(1, claimDecisionAction(game, humanClaim));
    for (let seat = 1; seat < SEATS; seat++) {
      const net = learnedBot(seat);
      if (net) decisions[seat] = await learnedClaim(net, game, seat);
    }
    const seat = winningClaimSeat(game, decisions);
    if (seat !== null) {
      showBurst(seat, claimLabel(decisions[seat]!));
      if (decisions[seat]!.kind === "win") {
        say(seat, "win");
        if (game.phase.kind === "claims") say(game.phase.from, "dealIn");
      } else say(seat, "call");
    }
    advance(resolveClaims(game, decisions));
  };

  const me = game.players[HUMAN];
  const myTurn = game.phase.kind === "turn" && game.phase.seat === HUMAN;
  const drawn = myTurn && game.phase.kind === "turn" ? game.phase.drawn : null;
  const forbidden = myTurn ? forbiddenDiscards(game) : [];
  // Tiles you can't throw right now: 食替, a locked 叮 hand's anything-but-
  // the-draw, and, with 叮 armed, anything that wouldn't leave you ready.
  const forced = myTurn ? riichiForcedDiscard(game) : null;
  const riichiTiles = useMemo(() => (myTurn ? riichiDiscards(game, HUMAN) : []), [game, myTurn]);
  const isForbidden = (t: Tile) =>
    forbidden.some((f) => sameTile(f, t)) || (forced !== null && !sameTile(forced, t)) || (riichiArmed && !riichiTiles.some((r) => sameTile(r, t)));

  // Record my play: one of your decisions, if it was a real choice.
  const recordMine = (kind: 0 | 1, action: number) => {
    if (!record) return;
    const mask = legalActions(game, HUMAN);
    if (mask.reduce((n, m) => n + m, 0) < 2) return;
    void recordDecision({ obs: encodeObservation(game, HUMAN), mask, action, kind, hand: handId.current });
  };

  const doTurn = (move: TurnMove) => {
    recordMine(0, turnMoveAction(move));
    if (move.kind === "selfDraw") showBurst(HUMAN, "自摸");
    else if (move.kind === "discard" && move.riichi) showBurst(HUMAN, "叮");
    else if (move.kind !== "discard") showBurst(HUMAN, "槓");
    advance(applyTurnMove(game, move));
  };

  // Bot pacing: one move per botDelay(), and a discard nobody (the human
  // included) can claim moves on by itself.
  useEffect(() => {
    if (rolling) return;
    const phase = game.phase;
    let move: (() => void) | null = null;
    let delay = PASS_DELAY_MS;
    if (phase.kind === "turn" && phase.seat !== HUMAN && learnedBot(phase.seat)) {
      // A learned bot asks its network (async), then moves after a steady pause.
      let cancelled = false;
      let timer = 0;
      const seat = phase.seat;
      void learnedTurnMove(learnedBot(seat)!, game).then((m) => {
        if (cancelled) return;
        timer = window.setTimeout(() => {
          if (m.kind === "selfDraw") {
            showBurst(seat, "自摸");
            say(seat, "selfDraw");
          } else if (m.kind === "discard" && m.riichi) {
            showBurst(seat, "叮");
            say(seat, "riichi");
          } else if (m.kind !== "discard") showBurst(seat, "槓");
          advance(applyTurnMove(game, m));
        }, botDelay(0.4, phase.drawn === null) * SPEEDS[speed].factor);
      });
      return () => {
        cancelled = true;
        window.clearTimeout(timer);
      };
    }
    if (phase.kind === "turn" && phase.seat !== HUMAN) {
      // Decide now, so the pause can match how hard the choice was.
      const { move: m, difficulty } = botTurnFor(game, bots[phase.seat]!);
      delay = botDelay(difficulty, phase.drawn === null);
      move = () => {
        if (m.kind === "selfDraw") {
          showBurst(phase.seat, "自摸");
          say(phase.seat, "selfDraw");
        } else if (m.kind === "discard" && m.riichi) {
          showBurst(phase.seat, "叮");
          say(phase.seat, "riichi");
        } else if (m.kind !== "discard") showBurst(phase.seat, "槓");
        advance(applyTurnMove(game, m));
      };
    } else if (phase.kind === "turn" && game.players[HUMAN].riichi && !isWinningHand(game.players[HUMAN])) {
      // Your locked 叮 hand throws the draw by itself.
      const tile = riichiForcedDiscard(game);
      if (tile) move = () => advance(applyTurnMove(game, { kind: "discard", tile }));
      delay = 700;
    } else if (phase.kind === "claims" && humanClaims.length === 0) {
      move = () => resolve(null);
      // Someone had a call to weigh: they take a moment either way.
      const pondered = [1, 2, 3].some((seat) => seat !== phase.from && claimOptions(game, seat).length > 0);
      delay = pondered ? PONDER_DELAY_MS + Math.random() * 300 : PASS_DELAY_MS;
    }
    if (!move) return;
    const id = window.setTimeout(move, delay * SPEEDS[speed].factor);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game, rolling]);

  // The turn timer (off by default): runs only while the human has to
  // decide, and on running out passes on a call or throws the drawn tile.
  const deciding = myTurn || humanClaims.length > 0;
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
  useEffect(() => {
    if (!timer || !deciding) {
      setSecondsLeft(null);
      return;
    }
    const started = Date.now();
    setSecondsLeft(timer);
    const id = window.setInterval(() => {
      const left = timer - Math.floor((Date.now() - started) / 1000);
      setSecondsLeft(Math.max(0, left));
      if (left > 0) return;
      window.clearInterval(id);
      if (game.phase.kind === "claims") {
        resolve(null);
      } else if (game.phase.kind === "turn") {
        const tile = drawn && !isForbidden(drawn) ? drawn : rateDiscardsFor(game, HUMAN, ADVISOR)[0].tile;
        advance(applyTurnMove(game, { kind: "discard", tile }));
      }
    }, 250);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game, timer, deciding]);

  // The hand sorted, with the just-drawn tile split off at the right.
  const handView = useMemo(() => {
    const tiles = me.hand.slice();
    let drawnTile: Tile | null = null;
    if (drawn) {
      const i = tiles.findIndex((t) => sameTile(t, drawn));
      if (i >= 0) drawnTile = tiles.splice(i, 1)[0];
    }
    return { sorted: sortTiles(tiles), drawnTile };
  }, [me.hand, drawn]);
  const handTiles = handView.drawnTile ? [...handView.sorted, handView.drawnTile] : handView.sorted;

  const ratings = useMemo(() => (myTurn && hint && !me.riichi ? rateDiscardsFor(game, HUMAN, ADVISOR) : null), [game, myTurn, hint, me.riichi]);
  const bestDiscard = ratings?.[0]?.tile ?? null;
  // Hints underline one copy - the drawn tile when that's the pick.
  const hintIndex = bestDiscard
    ? handView.drawnTile && sameTile(handView.drawnTile, bestDiscard)
      ? handTiles.length - 1
      : handTiles.findIndex((t) => sameTile(t, bestDiscard))
    : -1;
  // Hints: tiles risky enough to mark red, by the Veteran's read of the table.
  const dangerous = useMemo(() => new Set((ratings ?? []).filter((r) => r.danger >= DANGER_MARK).map((r) => tileKey(r.tile))), [ratings]);
  // When you're ready (聽): what you're waiting on, and how many of each are
  // still unseen. Shown whether or not hints are on - any player knows this.
  const waits = useMemo(() => {
    if (myTurn || me.hand.length !== meldsNeeded(me) * 3 + 1) return null;
    const ws = getWaits(me.hand, meldsNeeded(me));
    if (ws.length === 0) return null;
    const unseen = unseenCounts(game, HUMAN);
    return ws.map((t) => ({ tile: t, left: Math.max(0, unseen.get(tileKey(t)) ?? 0) }));
  }, [game, me, myTurn]);
  const myShanten = useMemo(() => {
    if (!hint) return null;
    if (myTurn) return ratings?.[0]?.shanten ?? null;
    return me.hand.length === meldsNeeded(me) * 3 + 1 ? shanten(me.hand, meldsNeeded(me)) : null;
  }, [hint, myTurn, ratings, me]);

  const canSelfDraw = myTurn && isWinningHand(me);
  const myKongs = myTurn && liveTilesLeft(game) > 0 ? kongOptions(me) : [];

  const tapTile = (index: number) => {
    if (rolling) return;
    if (!myTurn || isForbidden(handTiles[index])) return;
    // One-tap throws straight away - except when declaring 叮, which always
    // takes the confirming second tap.
    if (selected === index || (oneTap && !riichiArmed)) doTurn({ kind: "discard", tile: handTiles[index], ...(riichiArmed ? { riichi: true } : {}) });
    else setSelected(index);
  };

  // Next hand: first any bot allowed to 投降 decides (and says so), then deal.
  const nextHandWithSurrenders = () => {
    let s = game;
    for (let seat = 1; seat < SEATS; seat++) {
      const holders = botSurrenders(s, seat, bots[seat]!);
      for (const holder of holders) s = surrender(s, holder, seat);
      if (holders.length) window.setTimeout(() => say(seat, "surrender"), 300);
    }
    setSurrenderArmed(null);
    advance(nextHand(s));
  };

  const startNewGame = () => {
    setTotals([0, 0, 0, 0]);
    setMenuOpen(false);
    setSelected(null);
    setResultHidden(false);
    setGame(newGame());
  };

  const discardFrom = game.phase.kind === "claims" ? game.phase.from : null;
  const activeSeat = game.phase.kind === "turn" ? game.phase.seat : game.phase.kind === "claims" ? game.phase.from : null;
  const over = game.phase.kind === "over";
  const result = over && game.phase.kind === "over" ? game.phase.result : null;
  const compassCenter =
    secondsLeft !== null ? String(secondsLeft).padStart(2, "0") : String(liveTilesLeft(game)).padStart(2, "0");

  const total = (seat: number) => (
    <span className={`play-total${totals[seat] < 0 ? " is-neg" : ""}`}>{totals[seat] > 0 ? `+${totals[seat]}` : totals[seat]}</span>
  );

  // The 拉 a seat holds, as chips: who it's on (their avatar character, or 你
  // for you) and its value - red when it's on you, green when it's yours.
  const lahChips = (seat: number) =>
    (game.lahs ?? [])
      .filter((l) => l.holder === String(seat))
      .map((l) => {
        const on = Number(l.pulled);
        const who = on === HUMAN ? "你" : bots[on]!.name[0];
        const tone = on === HUMAN ? " is-on-you" : seat === HUMAN ? " is-yours" : "";
        return (
          <span key={l.pulled} className={`play-lah${tone}`} title={`${nameOf(seat)} 拉 ${nameOf(on)}: ${l.value} (${l.count} in a row)`}>
            拉{who} {l.value}
          </span>
        );
      });

  // A bot's name card - flat, over the corner of the table like a HUD.
  const badge = (seat: number) => (
    <span className={`play-badge at-${SIDES[seat]}${activeSeat === seat ? " is-active" : ""}`}>
      <span className="play-badge-wind">{WIND_CHARS[seatWind(seat, game.dealer)]}</span>
      {bots[seat] && <Avatar bot={bots[seat]!} />}
      <span className="play-badge-name">
        {nameOf(seat)}
        {seat === game.dealer && <span className="play-dealer">莊</span>}
        {game.players[seat].riichi && <span className="play-riichi">叮</span>}
        {lahChips(seat)}
        {bubbles[seat] && (
          <span key={bubbles[seat].id} className="play-bubble" role="status">
            {bubbles[seat].text}
          </span>
        )}
      </span>
      {total(seat)}
    </span>
  );

  // A bot's tiles, standing along its edge of the (tilted) table.
  const wall = (seat: number) => {
    const side = SIDES[seat];
    const p = game.players[seat];
    return (
      <div className={`play-seat play-seat-${side}`}>
        {over ? <RevealedHand tiles={p.hand} winningTile={null} /> : <EdgeTiles count={p.hand.length} side={side} />}
        {/* Melds and flowers beside the tiles, toward the middle - below
            them, a side seat's column ran down into your hand. */}
        <span className="play-seat-side">
          <span className="play-seat-melds">
            <Melds melds={p.melds} hideConcealed={!over} />
          </span>
          <Flowers flowers={p.flowers} />
        </span>
      </div>
    );
  };

  const chows = humanClaims.filter((c): c is Extract<Claim, { kind: "chow" }> => c.kind === "chow");
  const otherClaims = humanClaims.filter((c) => c.kind !== "chow");

  return (
    <div className="play-screen">
      <div className="play-rotate">
        <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="7" y="2.5" width="10" height="19" rx="2" />
          <path d="M3 9.5a9 9 0 0 1 3-5M3 4.5v5h5" />
        </svg>
        <p>Turn your phone sideways to play.</p>
        <button type="button" onClick={onExit}>
          Leave
        </button>
      </div>

      <div className="play-table">
        <div className="play-corner">
          <button type="button" className="play-icon-button" onClick={onExit} aria-label="Leave the table" title="Leave">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <path d="M15 5l-7 7 7 7" />
            </svg>
          </button>
          <button type="button" className="play-icon-button" onClick={() => {
              setMenuOpen((o) => !o);
              setConfirmNew(false);
            }} aria-label="Game menu" aria-expanded={menuOpen}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <path d="M5 7h14M5 12h14M5 17h14" />
            </svg>
          </button>
          <button type="button" className="play-icon-button is-text" onClick={() => setTrackerOpen(true)} aria-label="Tile tracker" title="記牌器 - tiles you haven't seen">
            記牌器
          </button>
          {menuOpen && (
            <div className="play-menu">
              <div className="play-menu-row">
                <span>Hints</span>
                <span className="play-menu-seg">
                  {[false, true].map((on) => (
                    <button key={String(on)} type="button" className={hint === on ? "toggle-on" : undefined} aria-pressed={hint === on} onClick={() => setHint(on)}>
                      {on ? "On" : "Off"}
                    </button>
                  ))}
                </span>
              </div>
              <div className="play-menu-row">
                <span>One-tap discard</span>
                <span className="play-menu-seg">
                  {[false, true].map((on) => (
                    <button key={String(on)} type="button" className={oneTap === on ? "toggle-on" : undefined} aria-pressed={oneTap === on} onClick={() => setOneTap(on)}>
                      {on ? "On" : "Off"}
                    </button>
                  ))}
                </span>
              </div>
              <div className="play-menu-row">
                <span>
                  Record my play
                  {record && recorded !== null && <span className="play-menu-note"> · {recorded}</span>}
                </span>
                <span className="play-menu-seg">
                  {[false, true].map((on) => (
                    <button
                      key={String(on)}
                      type="button"
                      className={record === on ? "toggle-on" : undefined}
                      aria-pressed={record === on}
                      onClick={() => {
                        setRecord(on);
                        if (on) void countRecorded().then(setRecorded);
                      }}
                    >
                      {on ? "On" : "Off"}
                    </button>
                  ))}
                </span>
              </div>
              {record && (
                <button
                  type="button"
                  onClick={async () => {
                    const { text, count } = await exportRecorded();
                    const url = URL.createObjectURL(new Blob([text], { type: "application/x-ndjson" }));
                    const a = document.createElement("a");
                    a.href = url;
                    a.download = `mjwaits-my-play-${new Date().toISOString().slice(0, 10)}.jsonl`;
                    a.click();
                    URL.revokeObjectURL(url);
                    setRecorded(count);
                  }}
                >
                  Export my play for training
                </button>
              )}
              <button
                type="button"
                className="play-menu-link"
                onClick={() => {
                  setMenuOpen(false);
                  setOpponentsOpen(true);
                }}
              >
                <span>Opponents</span>
                <span className="play-menu-value">{opponents.map((id) => shortName(profileById(id))).join(" · ")} ›</span>
              </button>
              <div className="play-menu-row">
                <span>Bot speed</span>
                <span className="play-menu-seg">
                  {(Object.keys(SPEEDS) as Speed[]).map((sp) => (
                    <button key={sp} type="button" className={speed === sp ? "toggle-on" : undefined} aria-pressed={speed === sp} onClick={() => setSpeed(sp)}>
                      {SPEEDS[sp].label}
                    </button>
                  ))}
                </span>
              </div>
              <div className="play-menu-row">
                <span>Turn timer</span>
                <span className="play-menu-seg">
                  {TIMER_CHOICES.map((t) => (
                    <button key={t} type="button" className={timer === t ? "toggle-on" : undefined} aria-pressed={timer === t} onClick={() => setTimer(t)}>
                      {t === 0 ? "Off" : `${t}s`}
                    </button>
                  ))}
                </span>
              </div>
              <button type="button" className={confirmNew ? "is-armed" : undefined} onClick={() => (confirmNew ? startNewGame() : setConfirmNew(true))}>
                {confirmNew ? "Tap again to reset totals" : "New game"}
              </button>
            </div>
          )}
        </div>

        {badge(2)}
        {badge(3)}
        {badge(1)}

        {/* The table itself, tipped away from you in perspective; your hand
            and the bar stay flat in front of it. */}
        <div className="play-stage">
          <div className="play-felt">
            {wall(2)}
            {wall(3)}
            {wall(1)}
            <div className="play-pond-slot play-pond-slot-top">
              <Pond tiles={game.players[2].discards} riichiAt={game.players[2].riichi?.discard} side="top" pinLast={discardFrom === 2} />
            </div>
            <div className="play-pond-slot play-pond-slot-left">
              <Pond tiles={game.players[3].discards} riichiAt={game.players[3].riichi?.discard} side="left" pinLast={discardFrom === 3} />
            </div>
            <div className="play-middle">
              <Compass game={game} active={over ? null : activeSeat} center={compassCenter} />
              {game.phase.kind === "claims" && (
                <span className={`play-spotlight from-${SIDES[game.phase.from]}`}>
                  <TileGlyphSpan tile={game.phase.tile} />
                </span>
              )}
            </div>
            <div className="play-pond-slot play-pond-slot-right">
              <Pond tiles={game.players[1].discards} riichiAt={game.players[1].riichi?.discard} side="right" pinLast={discardFrom === 1} />
            </div>
            <div className="play-pond-slot play-pond-slot-bottom">
              <Pond tiles={me.discards} riichiAt={me.riichi?.discard} side="bottom" pinLast={discardFrom === HUMAN} />
            </div>
          </div>
        </div>

        <div className="play-me">
          <div className="play-hand-wrap">
            <div className="play-calls">
              {result && resultHidden && (
                <button type="button" className="play-show-result" onClick={() => setResultHidden(false)}>
                  Show result
                </button>
              )}
              {chowChoice ? (
                <>
                  {chows.map((c, i) => (
                    <button key={i} type="button" className="play-call is-chow-shape" onClick={() => resolve(c)} aria-label={`Chow with ${c.tiles.map(tileLabel).join(" and ")}`}>
                      {sortTiles([...c.tiles, game.phase.kind === "claims" ? game.phase.tile : c.tiles[0]]).map((t, j) => (
                        <TileGlyphSpan key={j} tile={t} />
                      ))}
                    </button>
                  ))}
                  <button type="button" className="play-call is-pass" onClick={() => setChowChoice(false)} aria-label="Back">
                    ‹
                  </button>
                </>
              ) : (
                <>
                  {canSelfDraw && (
                    <button type="button" className="play-call is-win is-long" onClick={() => doTurn({ kind: "selfDraw" })}>
                      自摸
                    </button>
                  )}
                  {riichiTiles.length > 0 && (
                    <button
                      type="button"
                      className={`play-call is-riichi${riichiArmed ? " is-armed" : ""}`}
                      aria-pressed={riichiArmed}
                      aria-label={riichiArmed ? "Cancel 叮" : "Declare 叮 - then choose the tile to throw"}
                      onClick={() => {
                        setSelected(null);
                        setRiichiArmed((a) => !a);
                      }}
                    >
                      叮
                    </button>
                  )}
                  {myKongs.map((k) => (
                    <button key={`${k.kind}${tileKey(k.tile)}`} type="button" className="play-call has-tile" onClick={() => doTurn(k)} aria-label={`Kong ${tileLabel(k.tile)}`}>
                      槓
                      <span className="play-call-tile">
                        <TileGlyphSpan tile={k.tile} />
                      </span>
                    </button>
                  ))}
                  {otherClaims.map((c, i) => (
                    <button key={i} type="button" className={`play-call${c.kind === "win" ? " is-win" : ""}`} onClick={() => resolve(c)}>
                      {claimLabel(c)}
                    </button>
                  ))}
                  {chows.length > 0 && (
                    <button type="button" className="play-call" onClick={() => (chows.length === 1 ? resolve(chows[0]) : setChowChoice(true))}>
                      上
                    </button>
                  )}
                  {humanClaims.length > 0 && (
                    <button type="button" className="play-call is-pass" onClick={() => resolve(null)}>
                      過
                    </button>
                  )}
                </>
              )}
            </div>
            <div className={`play-hand${myTurn ? " is-turn" : ""}`}>
              {(me.melds.length > 0 || me.flowers.length > 0) && (
                <span className="play-my-melds">
                  <Melds melds={me.melds} />
                  <Flowers flowers={me.flowers} />
                </span>
              )}
              {handTiles.map((t, i) => {
                const isDrawn = handView.drawnTile !== null && i === handTiles.length - 1;
                const barred = isForbidden(t);
                return (
                  <button
                    key={i}
                    type="button"
                    className={[
                      "play-hand-tile",
                      isDrawn && "is-drawn",
                      selected === i && "is-selected",
                      i === hintIndex && "is-hint",
                      hint && myTurn && dangerous.has(tileKey(t)) && "is-danger",
                      barred && "is-barred",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    disabled={!myTurn || barred}
                    onClick={() => tapTile(i)}
                    title={barred ? "食替 – can't discard this now" : undefined}
                    aria-label={barred ? `${tileLabel(t)} (食替 – can't discard this now)` : selected === i ? `Discard ${tileLabel(t)}` : tileLabel(t)}
                  >
                    <TileGlyphSpan tile={t} />
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <div className="play-bar">
          <span className={`play-bar-you${activeSeat === HUMAN ? " is-active" : ""}`}>
            <span className="play-badge-wind">{WIND_CHARS[seatWind(HUMAN, game.dealer)]}</span>
            You
            {game.dealer === HUMAN && <span className="play-dealer">莊</span>}
            {me.riichi && <span className="play-riichi">叮</span>}
            {lahChips(HUMAN)}
          </span>
          {total(HUMAN)}
          <span className="play-bar-round">
            {roundLabel(game)}
            {game.dealerStreak > 0 && ` · 連${game.dealerStreak}`}
          </span>
          <span className="play-bar-left">剩:{liveTilesLeft(game)}張</span>
          {game.dice && !rolling && (
            <span className="play-bar-dice" aria-label={`Dice ${game.dice.join(", ")}`}>
              {game.dice.map((d, i) => (
                <PlayDie key={i} value={d} rolling={false} index={i} />
              ))}
            </span>
          )}
          {waits ? (
            <span className="play-bar-waits" aria-label={`Ready, waiting on ${waits.map((w) => `${tileLabel(w.tile)} (${w.left} left)`).join(", ")}`}>
              聽
              {waits.map((w) => (
                <span key={tileKey(w.tile)} className={`play-wait${w.left === 0 ? " is-dead" : ""}`}>
                  <TileGlyphSpan tile={w.tile} />×{w.left}
                </span>
              ))}
            </span>
          ) : (
            myShanten !== null && myShanten > 0 && <span className="play-bar-shanten">{myShanten} from ready</span>
          )}
          {myTurn && !over && !forced && (riichiArmed || selected !== null) && (
            <span className="play-bar-prompt">
              {riichiArmed ? (selected === null ? "叮: choose the tile to throw" : "Tap again to declare 叮") : "Tap again to discard"}
            </span>
          )}
          {me.riichi && !over && <span className="play-bar-prompt">叮 - your hand is locked</span>}
        </div>

        {burst && <CallBurst key={burst.id} seat={burst.seat} label={burst.label} />}

        {rolling && game.dice && (
          <div className="play-dice" role="status">
            <div className="play-dice-row">
              {game.dice.map((d, i) => (
                <PlayDie key={i} value={d} rolling index={i} />
              ))}
            </div>
            <span className="play-dice-caption">
              {game.dice.join(" + ")} = {game.dice[0] + game.dice[1] + game.dice[2]} ·{" "}
              {(() => {
                const brk = wallBreak(game.dice, game.dealer);
                return `${brk.seat === HUMAN ? "your" : `${nameOf(brk.seat)}'s`} wall, ${brk.stacks} stacks in`;
              })()}
            </span>
          </div>
        )}

        {trackerOpen && <TileTracker game={game} onClose={() => setTrackerOpen(false)} />}
        {opponentsOpen && <OpponentsSheet opponents={opponents} learned={model?.styles ?? null} onChange={setOpponents} onClose={() => setOpponentsOpen(false)} />}

        {result && !resultHidden && (
          <div className="play-result" role="dialog" aria-label="Hand result">
            <div className="play-result-card">
              <h2>
                {result.winner === null
                  ? "Draw - wall exhausted (流局)"
                  : result.winner === HUMAN
                    ? result.from === null
                      ? "You won by self-draw! (自摸)"
                      : `You won off ${nameOf(result.from)}'s discard!`
                    : `${nameOf(result.winner)} won${result.from === null ? " by self-draw" : result.from === HUMAN ? " off your discard" : ` off ${nameOf(result.from)}`}`}
              </h2>
              {result.winner !== null && (
                <div className="play-result-hand">
                  <Melds melds={game.players[result.winner].melds} />
                  <RevealedHand tiles={game.players[result.winner].hand} winningTile={result.tile} />
                  <Flowers flowers={game.players[result.winner].flowers} />
                </div>
              )}
              {result.score && (
                <ul className="play-result-patterns">
                  {result.score.matched.map(({ pattern, tai }) => (
                    <li key={pattern.id}>
                      <span>{patternDisplayName(pattern, result.score!.hand)}</span>
                      <span>{tai}</span>
                    </li>
                  ))}
                  {result.score.second?.matched.map(({ pattern, tai }) => (
                    <li key={`2-${pattern.id}`}>
                      <span>{patternDisplayName(pattern, result.score!.second!.hand)}</span>
                      <span>{tai}</span>
                    </li>
                  ))}
                  <li className="play-result-total">
                    <span>Total</span>
                    <span>{result.score.total} 台</span>
                  </li>
                </ul>
              )}
              {result.scoreError && <p className="play-result-error">Couldn't score this hand: {result.scoreError}</p>}
              {(result.pairs ?? []).some((p) => p.lah) && (
                <ul className="play-result-lah">
                  {(result.pairs ?? [])
                    .filter((p) => p.lah)
                    .map((p) => (
                      <li key={p.payer}>
                        {p.lahKind === "踢" ? "踢" : "拉"} · {nameOf(Number(p.payer))} {Number(p.payer) === HUMAN ? "pay" : "pays"} {nameOf(Number(p.winner))} +{p.lah} on top (from {p.lahBefore})
                      </li>
                    ))}
                </ul>
              )}
              {surrenderable(game, HUMAN).map((l) => {
                const holder = Number(l.holder);
                const armed = surrenderArmed === l.holder;
                return (
                  <div key={l.holder} className="play-surrender">
                    <span>
                      {nameOf(holder)} has 拉'd you {l.count} in a row ({l.value}). 投降 ends it, paying nothing.
                    </span>
                    <button
                      type="button"
                      className={armed ? "is-armed" : undefined}
                      onClick={() => {
                        if (!armed) return setSurrenderArmed(l.holder);
                        setSurrenderArmed(null);
                        setGame(surrender(game, holder, HUMAN));
                      }}
                    >
                      {armed ? "Tap again to 投降" : "投降"}
                    </button>
                  </div>
                );
              })}
              <div className="play-result-deltas">
                {result.deltas.map((d, seat) => (
                  <span key={seat} className={d < 0 ? "is-neg" : d > 0 ? "is-pos" : undefined}>
                    {nameOf(seat)} {d > 0 ? `+${d}` : d}
                  </span>
                ))}
              </div>
              <div className="play-result-actions">
                <button type="button" className="play-view-table" onClick={() => setResultHidden(true)}>
                  View table
                </button>
                <button type="button" className="play-next" onClick={nextHandWithSurrenders}>
                  Next hand
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
