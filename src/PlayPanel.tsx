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

import { useEffect, useMemo, useState } from "react";
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
  riichiDiscards,
  riichiForcedDiscard,
  roundLabel,
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
import { allTileKinds, shanten, sortTiles, tileKey, tileLabel, type Tile } from "./lib/mahjong";
import { patternDisplayName, type BonusTile } from "./lib/scoring";
import { BonusGlyphSpan, TileGlyphSpan } from "./TileGlyphs";
import { BOT_PROFILES, botClaimFor, botTurnFor, profileById, rateDiscardsFor, voiceOf, type BotProfile, type Voice } from "./lib/bots";

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
function OpponentsSheet({ opponents, onChange, onClose }: { opponents: string[]; onChange: (ids: string[]) => void; onClose: () => void }) {
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
          const current = profileById(opponents[seat - 1]);
          return (
            <div key={seat} className="play-opponent-row">
              <span className="play-opponent-seat">{SEAT_LABELS[seat]}</span>
              <div className="play-opponent-chips">
                {BOT_PROFILES.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    className={p.id === current.id ? "toggle-on" : undefined}
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

// ---- The table ------------------------------------------------------------

export function PlayPanel({ onExit }: { onExit: () => void }) {
  const saved = useMemo(loadSaved, []);
  const [game, setGame] = useState<GameState>(() => saved?.game ?? newGame());
  const [totals, setTotals] = useState<number[]>(() => saved?.totals ?? [0, 0, 0, 0]);
  const [hint, setHint] = useState(() => saved?.hint ?? false);
  const [timer, setTimer] = useState<TimerSetting>(() => saved?.timer ?? 0);
  const [opponents, setOpponents] = useState<string[]>(() =>
    saved?.opponents?.length === 3 && saved.opponents.every((id) => BOT_PROFILES.some((p) => p.id === id)) ? saved.opponents : DEFAULT_OPPONENTS
  );
  const [opponentsOpen, setOpponentsOpen] = useState(false);
  const bots = useMemo<(BotProfile | null)[]>(() => [null, ...opponents.map(profileById)], [opponents]);
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

  useEffect(() => save({ game, totals, hint, timer, opponents }), [game, totals, hint, timer, opponents]);

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
    }
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

  const resolve = (humanClaim: Claim | null) => {
    if (!botDecisions) return;
    const decisions = botDecisions.slice();
    decisions[HUMAN] = humanClaim;
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

  const doTurn = (move: TurnMove) => {
    if (move.kind === "selfDraw") showBurst(HUMAN, "自摸");
    else if (move.kind === "discard" && move.riichi) showBurst(HUMAN, "叮");
    else if (move.kind !== "discard") showBurst(HUMAN, "槓");
    advance(applyTurnMove(game, move));
  };

  // Bot pacing: one move per botDelay(), and a discard nobody (the human
  // included) can claim moves on by itself.
  useEffect(() => {
    const phase = game.phase;
    let move: (() => void) | null = null;
    let delay = PASS_DELAY_MS;
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
    const id = window.setTimeout(move, delay);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game]);

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
  const myShanten = useMemo(() => {
    if (!hint) return null;
    if (myTurn) return ratings?.[0]?.shanten ?? null;
    return me.hand.length === meldsNeeded(me) * 3 + 1 ? shanten(me.hand, meldsNeeded(me)) : null;
  }, [hint, myTurn, ratings, me]);

  const canSelfDraw = myTurn && isWinningHand(me);
  const myKongs = myTurn && liveTilesLeft(game) > 0 ? kongOptions(me) : [];

  const tapTile = (index: number) => {
    if (!myTurn || isForbidden(handTiles[index])) return;
    if (selected === index) doTurn({ kind: "discard", tile: handTiles[index], ...(riichiArmed ? { riichi: true } : {}) });
    else setSelected(index);
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

  // A bot's name card - flat, over the corner of the table like a HUD.
  const badge = (seat: number) => (
    <span className={`play-badge at-${SIDES[seat]}${activeSeat === seat ? " is-active" : ""}`}>
      <span className="play-badge-wind">{WIND_CHARS[seatWind(seat, game.dealer)]}</span>
      <span className="play-badge-name">
        {nameOf(seat)}
        {seat === game.dealer && <span className="play-dealer">莊</span>}
        {game.players[seat].riichi && <span className="play-riichi">叮</span>}
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
        <span className="play-seat-melds">
          <Melds melds={p.melds} hideConcealed={!over} />
        </span>
        <Flowers flowers={p.flowers} />
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
          </span>
          {total(HUMAN)}
          <span className="play-bar-round">
            {roundLabel(game)}
            {game.dealerStreak > 0 && ` · 連${game.dealerStreak}`}
          </span>
          <span className="play-bar-left">剩:{liveTilesLeft(game)}張</span>
          {myShanten !== null && (
            <span className="play-bar-shanten">{myShanten <= 0 ? (myShanten < 0 ? "Complete" : "Ready (聽)") : `${myShanten} from ready`}</span>
          )}
          {myTurn && !over && !forced && (
            <span className="play-bar-prompt">
              {riichiArmed
                ? selected === null
                  ? "叮: choose the tile to throw"
                  : "Tap again to declare 叮"
                : selected === null
                  ? "Tap a tile, then again to discard"
                  : "Tap again to discard"}
            </span>
          )}
          {me.riichi && !over && <span className="play-bar-prompt">叮 - your hand is locked</span>}
        </div>

        {burst && <CallBurst key={burst.id} seat={burst.seat} label={burst.label} />}

        {trackerOpen && <TileTracker game={game} onClose={() => setTrackerOpen(false)} />}
        {opponentsOpen && <OpponentsSheet opponents={opponents} onChange={setOpponents} onClose={() => setOpponentsOpen(false)} />}

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
                <button type="button" className="play-next" onClick={() => advance(nextHand(game))}>
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
