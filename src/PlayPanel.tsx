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
//
// The same table plays online (`online`, from OnlineTable.tsx): the server
// holds the game and sends this seat's view, which seatState turns into a
// game with you at seat 0 - blanks for what you can't see - so the table
// draws it, and works out your calls, waits and hints, exactly as here.
// Your moves go to the server instead of into the game; the bots, timer and
// payments are the server's.

import { type CSSProperties, memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
  retractClaim,
  surrender,
  surrenderable,
  riichiDiscards,
  riichiForcedDiscard,
  roundLabel,
  wallBreak,
  SNAKE_DICE_PENALTY,
  TRIPLE_DICE_BONUS,
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
} from "@mjwaits/shared/engine/game";
import { allTileKinds, getWaits, shanten, sortTiles, tileKey, tileLabel, type Tile } from "@mjwaits/shared/engine/mahjong";
import type { BonusTile } from "@mjwaits/shared/engine/scoring";
import { BonusGlyphSpan, TileGlyphSpan, TileSides } from "./TileGlyphs";
import {
  BOT_PROFILES,
  botClaimFor,
  botSurrenders,
  botTurnFor,
  callLines,
  LEARNED_PREFIX,
  learnedProfile,
  learnedStyle,
  MYSTERY_PREFIX,
  mysteryProfile,
  mysteryStyle,
  profileById,
  randomStyle,
  rateDiscardsFor,
  voiceOf,
  type BotProfile,
  type CallKind,
  type Voice,
} from "@mjwaits/shared/engine/bots";
import { scoreView, type ResultView } from "@mjwaits/shared/engine/view";
import { MYSTERY_BOT, REACTIONS, type Reaction, type TableClientMessage, type TableState } from "@mjwaits/shared/protocol/table";
import { BLANK, seatState } from "./lib/seatState";
import { withEvents, type ScoreGame } from "@mjwaits/shared/engine/ledger";
import { carriedOver, newPlayLedger, playEvents, uniqueNames } from "@mjwaits/shared/engine/playLedger";
import { PlayScores } from "./scores/playScores";
import { ReviewSheet, type Decision } from "./PlayReview";
import { RecordSheet } from "./PlayRecord";
import { isMuted, play as playSound, setMuted, wakeAudio, type Sound } from "./lib/sound";
import { addHand, loadRecord, saveRecord, type Opponent } from "./lib/playRecord";
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
// A learned bot wears its personality's avatar with a ring; a mystery bot
// a plain "?", whichever personality it is.
const Avatar = ({ bot }: { bot: BotProfile }) => {
  if (mysteryStyle(bot))
    return (
      <span className="play-avatar is-mystery" aria-hidden="true">
        ?
      </span>
    );
  const style = learnedStyle(bot);
  return (
    <span className={`play-avatar is-${style ?? bot.id}${style ? " is-learned" : ""}`} aria-hidden="true">
      {style ? profileById(style).name[0] : bot.name[0]}
    </span>
  );
};
// A seat's bot by id: a personality, "net-<personality>" for a learned one,
// or "mystery-<personality>" for one that doesn't say.
const botById = (id: string): BotProfile =>
  id.startsWith(LEARNED_PREFIX)
    ? learnedProfile(id.slice(LEARNED_PREFIX.length))
    : id.startsWith(MYSTERY_PREFIX)
      ? mysteryProfile(id.slice(MYSTERY_PREFIX.length))
      : profileById(id);
const knownBot = (id: string) => BOT_PROFILES.some((p) => p.id === id || LEARNED_PREFIX + p.id === id || MYSTERY_PREFIX + p.id === id);
// A new mystery bot (and a fresh one for each new game).
const newMystery = () => MYSTERY_PREFIX + randomStyle();
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
// A discard a bot is about to take stays on the table this long first, so
// everyone sees what was thrown before it goes into the caller's meld.
const CLAIM_DELAY_MS = 1100;
// The bots' pace, from the menu: every pause is multiplied by this.
const SPEEDS = { slow: { label: "Slow", factor: 1.6 }, normal: { label: "Normal", factor: 1 }, fast: { label: "Fast", factor: 0.45 } } as const;
type Speed = keyof typeof SPEEDS;
// With hints on, a tile at least this dangerous (the Veteran's deal-in read)
// gets a red mark.
const DANGER_MARK = 0.12;
const BUBBLE_MS = 2200;
const BURST_MS = 1200;
// A hand's end is seen on the table first - the 胡 / 自摸 called and the
// hands laid down - and only then the result card: this long after a win,
// less after a 流局 (no call to see).
// How a hand laid down at the end topples, in seconds: from `at`, a tile
// every `step`, each falling for `dur`. The winner's first, in a slow wave
// so there's no doubt who won; then, once it's down, the others' - each
// hand falling all at once, no wave. (A 流局, or a hand shown later: at once.)
type Topple = { at: number; step: number; dur: number };
const TOPPLE_WINNER: Topple = { at: 0.2, step: 0.07, dur: 0.6 };
const TOPPLE_OTHERS: Topple = { at: 2.6, step: 0, dur: 0.5 };
const TOPPLE_DRAW: Topple = { at: 0.15, step: 0, dur: 0.5 };
// The result card waits for all of that.
const WIN_SHOW_MS = 3700;
// A phone held upright: the table is drawn turned (as App.css's media query).
const TURNED = "(orientation: portrait) and (max-width: 820px)";
const DRAW_SHOW_MS = 1700;
// Online, how long a discard whose claim window passed unseen shows in the bubble.
const FLASH_MS = 900;
// 自動 autoplay: a bot plays your seat and you watch - the Grandmaster -
// dealing on by itself this long after each result.
const AUTOPLAY_BOT = "grandmaster";
const AUTOPLAY_NEXT_MS = 4500;
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
  multiWin?: boolean; // 一炮多響 (else 截胡)
  record?: boolean;
  // The bot ids at seats 1-3.
  opponents?: string[];
  // The game so far as a Scores-tab game (playLedger.ts), for 戰況.
  ledger?: ScoreGame;
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

// The game left on this phone, for the start screen's Continue.
export interface SavedSummary {
  round: string;
  you: number; // your total
}

export function savedSummary(): SavedSummary | null {
  const saved = loadSaved();
  return saved && { round: roundLabel(saved.game), you: saved.totals[0] };
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
// `drew`: holding a tile just drawn, which stands a little apart at the
// player's right end (as yours does).
function EdgeTilesView({ count, side, drew }: { count: number; side: Side; drew: boolean }) {
  return (
    <span className={`play-edge play-edge-${side}${drew ? " has-drawn" : ""}`} style={{ "--count": count } as CSSProperties} aria-label={`${count} concealed tiles`}>
      {Array.from({ length: count }, (_, i) => (
        <span key={i} className="play-edge-tile" />
      ))}
    </span>
  );
}

// `hideConcealed`: a bot's concealed kong lies fully face down - nothing
// about it shows until the hand is over. Your own shows its two middle
// tiles, so you can see what you've set aside.
// A called run's tiles in table order: the claimed one between the other two.
function runOrder(tiles: Tile[], claimed: Tile): number[] {
  const c = tiles.findIndex((t) => sameTile(t, claimed));
  if (c < 0) return [0, 1, 2];
  const others = [0, 1, 2].filter((j) => j !== c);
  return [others[0], c, others[1]];
}

// A kong is three tiles wide, its fourth stacked on the middle one - where
// tiles lie on the table. `inRow`: its four tiles side by side instead - in
// your melds (they stand, and nothing rests on a standing tile) and on the
// result card (a flat picture, where a stack just overlaps).
function MeldsView({ melds, hideConcealed, inRow }: { melds: GameMeld[]; hideConcealed?: boolean; inRow?: boolean }) {
  return (
    <>
      {melds.map((m, i) => {
        const tile = (j: number) =>
          m.concealed && (hideConcealed || j === 0 || j === 3) ? (
            // Face down: on the table, a block with its back up.
            <span key={j} className="play-back">
              <i className="tile-top" />
              <TileSides />
            </span>
          ) : (
            <TileGlyphSpan key={j} tile={m.tiles[j]} block />
          );
        return (
          <span key={i} className="play-meld">
            {m.kind === "run" && m.claimed && m.tiles.length === 3 ? (
              // A called run shows the claimed tile in the middle: 1-3-2 for
              // a 3 taken to 1-2.
              runOrder(m.tiles, m.claimed).map((j) => tile(j))
            ) : m.kind === "kong" && m.tiles.length === 4 && !inRow ? (
              <>
                {tile(0)}
                <span className="play-kong-stack">
                  {tile(1)}
                  <span className="play-kong-top">{tile(3)}</span>
                </span>
                {tile(2)}
              </>
            ) : (
              m.tiles.map((_, j) => tile(j))
            )}
          </span>
        );
      })}
    </>
  );
}

function FlowersView({ flowers }: { flowers: BonusTile[] }) {
  if (flowers.length === 0) return null;
  return (
    <span className="play-flowers">
      {flowers.map((f, i) => (
        <BonusGlyphSpan key={i} tile={f} block />
      ))}
    </span>
  );
}

// A finished hand's concealed tiles, sorted, with the winning tile marked once.
// The tile that completed a winning hand goes last, laid sideways, as
// players mark it at the table.
// On the table (a seat's hand laid down at the end) the tiles topple from
// standing to flat one after another, as a player knocks their hand over,
// timed by `topple` (the winner's first - see TOPPLE_WINNER); the winning
// tile drops in after.
function RevealedHandView({ tiles, winningTile, topple = TOPPLE_WINNER }: { tiles: Tile[]; winningTile: Tile | null; topple?: Topple }) {
  const sorted = sortTiles(tiles);
  const mark = winningTile ? sorted.findIndex((t) => sameTile(t, winningTile)) : -1;
  const rest = mark < 0 ? sorted : sorted.filter((_, i) => i !== mark);
  return (
    <span
      className="play-meld is-revealed"
      style={{ "--topple-at": `${topple.at}s`, "--topple-step": `${topple.step}s`, "--topple-dur": `${topple.dur}s`, "--n": rest.length } as CSSProperties}
    >
      {rest.map((t, i) => (
        <span key={i} className="play-topple" style={{ "--i": i } as CSSProperties}>
          <TileGlyphSpan tile={t} block />
        </span>
      ))}
      {mark >= 0 && (
        <span className="play-win-tile">
          <TileGlyphSpan tile={sorted[mark]} block />
        </span>
      )}
    </span>
  );
}

// The sound for a burst: a win, 叮, a call, or (anything longer, as 正花 +2) a bonus.
function burstSound(label: string): Sound {
  if (/胡|自摸|搶槓|響/.test(label)) return "win";
  if (label === "叮") return "riichi";
  if (label === "碰" || label === "上" || label === "槓") return "call";
  return "bonus";
}

// 音效: sound on or off, in either menu.
function SoundRow() {
  const [off, setOff] = useState(isMuted);
  return (
    <div className="play-menu-row">
      <span>音效 Sound</span>
      <span className="play-menu-seg">
        {[true, false].map((on) => (
          <button
            key={String(on)}
            type="button"
            className={!off === on ? "toggle-on" : undefined}
            aria-pressed={!off === on}
            onClick={() => {
              setMuted(!on);
              setOff(!on);
              if (on) wakeAudio();
            }}
          >
            {on ? "On" : "Off"}
          </button>
        ))}
      </span>
    </div>
  );
}

// A seat's discards, in front of it; the newest one carries a gold pin.
// `riichiAt`: the pond index of the tile that declared 叮, laid sideways.
function PondView({ tiles, side, pinLast, riichiAt }: { tiles: Tile[]; side: Side; pinLast: boolean; riichiAt?: number }) {
  return (
    <div className={`play-pond play-pond-${side}${riichiAt !== undefined ? " has-riichi" : ""}`}>
      {tiles.map((t, i) => {
        const last = pinLast && i === tiles.length - 1;
        return (
          <span key={i} className={["play-pond-tile", last && "is-latest", i === riichiAt && "is-riichi"].filter(Boolean).join(" ")}>
            <TileGlyphSpan tile={t} block />
          </span>
        );
      })}
    </div>
  );
}

// The table's pieces drawn again only when what they show changes - the
// game is copied whole on every move, so a pond or a seat's melds would
// otherwise be rebuilt (every tile, every side) many times a second on a
// busy table.
const tilesKey = (ts: Tile[]) => ts.map(tileKey).join();
const meldsKey = (ms: GameMeld[]) =>
  ms.map((m) => `${m.kind}${m.concealed ? "c" : ""}${tilesKey(m.tiles)}${m.claimed ? tileKey(m.claimed) : ""}`).join("|");
const EdgeTiles = memo(EdgeTilesView);
const Melds = memo(MeldsView, (a, b) => a.hideConcealed === b.hideConcealed && a.inRow === b.inRow && meldsKey(a.melds) === meldsKey(b.melds));
const Flowers = memo(FlowersView, (a, b) => a.flowers.map((f) => f.kind + f.rank).join() === b.flowers.map((f) => f.kind + f.rank).join());
const RevealedHand = memo(
  RevealedHandView,
  (a, b) =>
    a.topple === b.topple && tilesKey(a.tiles) === tilesKey(b.tiles) && (a.winningTile ? tileKey(a.winningTile) : "") === (b.winningTile ? tileKey(b.winningTile) : "")
);
const Pond = memo(PondView, (a, b) => a.side === b.side && a.pinLast === b.pinLast && a.riichiAt === b.riichiAt && tilesKey(a.tiles) === tilesKey(b.tiles));

// The turn timer as a light bar around the compass's rim, from the top and
// clockwise: full when the clock starts, gone when it runs out. Drawn every
// frame from the clock's end itself, so it always agrees with the number in
// the middle (a CSS animation only starts when it's first painted, and ran
// behind). Red for the last stretch.
interface Countdown {
  total: number; // seconds
  endsAt: number; // ms
}

const COUNTDOWN_SHORT = 0.3;

function CountdownRing({ total, endsAt }: Countdown) {
  const bar = useRef<SVGPathElement>(null);
  useEffect(() => {
    let frame = 0;
    const draw = () => {
      const left = Math.min(1, Math.max(0, (endsAt - Date.now()) / (total * 1000)));
      const el = bar.current;
      if (el) {
        el.style.strokeDashoffset = String(left - 1);
        el.classList.toggle("is-short", left < COUNTDOWN_SHORT);
      }
      if (left > 0) frame = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(frame);
  }, [total, endsAt]);
  return (
    <svg className="play-countdown" viewBox="0 0 36 36">
      <path className="play-countdown-track" d={RIM} pathLength={1} />
      <path ref={bar} className="play-countdown-bar" d={RIM} pathLength={1} />
    </svg>
  );
}

// The compass's rounded edge, from the middle of its top edge clockwise.
const RIM = "M18 1H27A8 8 0 0 1 35 9V27A8 8 0 0 1 27 35H9A8 8 0 0 1 1 27V9A8 8 0 0 1 9 1Z";

// The wind compass: the four seats' winds where those seats sit, the one to
// act lit gold with a beam toward them, and a number in the middle.
function Compass({ game, active, center, countdown }: { game: GameState; active: number | null; center: string; countdown: Countdown | null }) {
  return (
    <div className="play-compass" aria-hidden="true">
      {countdown && <CountdownRing key={countdown.endsAt} {...countdown} />}
      {SIDES.map((side, seat) => (
        <span key={side} className={`play-compass-q play-compass-${side}${active === seat ? " is-active" : ""}`}>
          {WIND_CHARS[seatWind(seat, game.dealer)]}
        </span>
      ))}
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
          const mystery = !!mysteryStyle(current);
          return (
            <div key={seat} className="play-opponent-row">
              <span className="play-opponent-seat">{SEAT_LABELS[seat]}</span>
              <div className="play-opponent-chips">
                {choices.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    className={[!mystery && p.id === current.id && "toggle-on", learnedStyle(p) && "is-learned"].filter(Boolean).join(" ") || undefined}
                    aria-pressed={!mystery && p.id === current.id}
                    title={englishName(p)}
                    aria-label={`${SEAT_LABELS[seat]}: ${englishName(p)}`}
                    onClick={() => onChange(opponents.map((id, i) => (i === seat - 1 ? p.id : id)))}
                  >
                    {shortName(p)}
                  </button>
                ))}
                <button
                  type="button"
                  className={mystery ? "toggle-on" : undefined}
                  aria-pressed={mystery}
                  title="Mystery"
                  aria-label={`${SEAT_LABELS[seat]}: a mystery bot`}
                  onClick={() => onChange(opponents.map((id, i) => (i === seat - 1 ? newMystery() : id)))}
                >
                  神秘?
                </button>
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

// Playing at an online table: what the server sent, and how to answer it.
export interface OnlinePlay {
  table: TableState;
  // The last quick reaction someone at the table sent (a new id each time).
  reaction: { seat: number; r: Reaction; id: number } | null;
  // The table's record, as the server keeps it (null until it's arrived).
  scores: ScoreGame | null;
  send: (msg: Exclude<TableClientMessage, { t: "hello" }>) => void;
  host: boolean;
}

type WireMove = Extract<TableClientMessage, { t: "move" }>["move"];
type WireClaim = Extract<TableClientMessage, { t: "claim" }>["claim"];

// `fresh`: start a new game (keeping the settings) instead of the saved one.
export function PlayPanel({ onExit, onOnline, online, fresh }: { onExit: () => void; onOnline?: () => void; online?: OnlinePlay; fresh?: boolean }) {
  const saved = useMemo(loadSaved, []);
  const resume = fresh ? null : saved;
  const [localGame, setGame] = useState<GameState>(() => resume?.game ?? newGame());
  const [localTotals, setTotals] = useState<number[]>(() => resume?.totals ?? [0, 0, 0, 0]);
  // Online: this seat's view, turned so you're at seat 0.
  const net = useMemo(() => (online?.table.view ? seatState(online.table.view) : null), [online?.table]);
  const game = net?.game ?? localGame;
  const totals = online && net ? [0, 1, 2, 3].map((i) => online.table.totals[net.toTable(i)]) : localTotals;
  // Online, someone watching sits in seat 0's place but has no hand to play.
  const seated = !online || online.table.you !== null;
  // Online, whether the table is waiting on you (it isn't once you've
  // answered, or while it's playing for you).
  const waitedOn = !online || (online.table.you !== null && online.table.waitingOn.includes(online.table.you));
  const [hint, setHint] = useState(() => saved?.hint ?? false);
  const [timer, setTimer] = useState<TimerSetting>(() => saved?.timer ?? 0);
  // One-tap discard: a single tap throws the tile (off: tap to lift, tap again).
  const [oneTap, setOneTap] = useState(() => saved?.oneTap ?? false);
  // 一炮多響: a table setting, kept on the game itself so it carries hand to hand.
  const [multiWin, setMultiWin] = useState(() => saved?.multiWin ?? saved?.game?.multiWin ?? false);
  useEffect(() => {
    if (!online && !!game.multiWin !== multiWin) setGame((g) => ({ ...g, multiWin }));
  }, [game, multiWin, online]);
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
  // Which deal it is: the dice themselves here; online, the hand number
  // (every message brings a fresh copy of the game).
  const dealKey: unknown = online ? online.table.hand : game.dice;
  const rolledFor = useRef<unknown>(null);
  useEffect(() => {
    if (!game.dice || rolledFor.current === dealKey || game.discardsMade > 0 || game.phase.kind === "over") return;
    rolledFor.current = dealKey;
    setRolling(true);
  }, [game, dealKey]);
  // A roll that pays (圍骰 / 蛇骰): into the totals once, as the dice
  // settle. The saved paid mark stops a reload paying again; the ref stops
  // a second run of this effect before that mark has landed.
  const paidFor = useRef<Dice | null>(null);
  useEffect(() => {
    const bonus = game.diceBonus;
    // Online the server pays it.
    if (online || rolling || !bonus || bonus.paid || paidFor.current === game.dice) return;
    paidFor.current = game.dice ?? null;
    setTotals((t) => t.map((v, i) => v + bonus.deltas[i]));
    setGame((g) => (g.diceBonus ? { ...g, diceBonus: { ...g.diceBonus, paid: true } } : g));
    showBurst(game.dealer, bonus.name);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rolling, game.diceBonus]);
  // Table bonuses (flowers, 暗槓) paid as they're earned, the
  // same way: marked paid in the game, and the ref remembers what this
  // hand has paid in case a stale copy of the game comes back unmarked.
  const paidBonuses = useRef<{ hand: Dice | undefined; keys: Set<string> }>({ hand: undefined, keys: new Set() });
  // Online the server pays them; the table just shows each new one. (On
  // joining mid-hand, the ones already paid aren't shown again.)
  const shownBonuses = useRef<{ deal: unknown; count: number }>({ deal: undefined, count: 0 });
  useEffect(() => {
    if (!online) return;
    const all = game.tableBonuses ?? [];
    if (shownBonuses.current.deal !== dealKey) shownBonuses.current = { deal: dealKey, count: game.discardsMade === 0 ? 0 : all.length };
    if (rolling || all.length <= shownBonuses.current.count) return;
    shownBonuses.current.count = all.length;
    const last = all[all.length - 1];
    showBurst(last.seat, `${last.name} ${last.deltas[last.seat] > 0 ? "+" : "−"}${Math.abs(last.deltas[last.seat])}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [online, rolling, game.tableBonuses]);
  useEffect(() => {
    if (online) return;
    if (paidBonuses.current.hand !== game.dice) paidBonuses.current = { hand: game.dice, keys: new Set() };
    const keys = paidBonuses.current.keys;
    const unpaid = (game.tableBonuses ?? []).filter((b) => !b.paid);
    if (rolling || !unpaid.length) return;
    setGame((g) => (g.tableBonuses ? { ...g, tableBonuses: g.tableBonuses.map((b) => ({ ...b, paid: true })) } : g));
    // Keyed by place in the list, which only grows during a hand.
    const all = game.tableBonuses ?? [];
    const due = unpaid.filter((b) => !keys.has(String(all.indexOf(b))));
    if (!due.length) return;
    for (const b of due) keys.add(String(all.indexOf(b)));
    setTotals((t) => t.map((v, i) => v + due.reduce((sum, b) => sum + b.deltas[i], 0)));
    const last = due[due.length - 1];
    showBurst(last.seat, `${last.name} ${last.deltas[last.seat] > 0 ? "+" : "−"}${Math.abs(last.deltas[last.seat])}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rolling, game.tableBonuses]);
  // How long the roll shows - timed on its own, so a re-run of the effect
  // above (which skips a deal it has seen) can't leave it showing forever.
  useEffect(() => {
    if (!rolling) return;
    const id = window.setTimeout(() => setRolling(false), speed === "fast" ? 900 : 1700);
    return () => window.clearTimeout(id);
  }, [rolling, speed]);
  // Online the table doesn't wait for this phone's roll: the dice go as soon
  // as the first tile is thrown, so they never sit over tiles landing on the
  // felt (iPhone Safari drew those flat under the fading overlay).
  useEffect(() => {
    if (online && rolling && game.discardsMade > 0) setRolling(false);
  }, [online, rolling, game.discardsMade]);
  const [opponents, setOpponents] = useState<string[]>(() =>
    saved?.opponents?.length === 3 && saved.opponents.every(knownBot)
      ? // A new game, new mysteries.
        saved.opponents.map((id) => (fresh && id.startsWith(MYSTERY_PREFIX) ? newMystery() : id))
      : DEFAULT_OPPONENTS
  );
  const [opponentsOpen, setOpponentsOpen] = useState(false);
  // The game so far as a Scores-tab game: started with the game (its first
  // deal's dice and flowers in it), or - a game saved before this was kept -
  // carried over from the totals.
  const playerNames = (ids: string[]) => uniqueNames(["You", ...ids.map((id) => englishName(botById(id)))]);
  const [localLedger, setLedger] = useState<ScoreGame>(() => {
    if (resume?.ledger) return resume.ledger;
    if (resume) return carriedOver(playerNames(opponents), localGame.dealer, localTotals);
    const fresh = newPlayLedger(playerNames(opponents), localGame.dealer);
    return { ...fresh, events: playEvents(null, localGame, fresh.seats) };
  });
  // Every change to the game adds what it scored (a hand's end, a bonus, 投降).
  const ledgerFrom = useRef(localGame);
  useEffect(() => {
    const before = ledgerFrom.current;
    ledgerFrom.current = localGame;
    if (before === localGame) return;
    const evs = playEvents(before, localGame, localLedger.seats);
    if (evs.length) setLedger((l) => withEvents(l, evs));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localGame]);
  // New opponents mid-game: a new seating in the record.
  useEffect(() => {
    const names = playerNames(opponents);
    setLedger((l) => {
      const lastSwap = l.events.findLast((e) => e.t === "swap");
      const seated = lastSwap?.t === "swap" ? lastSwap.seats : l.seats;
      return names.join() === seated.join() ? l : withEvents(l, [{ t: "swap", at: Date.now(), seats: names }]);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opponents]);
  const [scoresOpen, setScoresOpen] = useState(false);
  // 回顧: your discards this hand, each with the table just before it - for
  // the review on the result card. A new deal starts a new list.
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [reviewOpen, setReviewOpen] = useState(false);
  // Sound: woken by the first tap (iPhones need one); a clack whenever a
  // tile hits a pond, a softer tick as you draw.
  useEffect(() => {
    const wake = () => wakeAudio();
    window.addEventListener("pointerdown", wake, { once: true });
    return () => window.removeEventListener("pointerdown", wake);
  }, []);
  const soundBefore = useRef<GameState | null>(null);
  useEffect(() => {
    const prev = soundBefore.current;
    soundBefore.current = game;
    if (!prev || game.phase.kind === "over") return;
    const count = (g: GameState) => g.players.reduce((n, p) => n + p.discards.length, 0);
    if (count(game) > count(prev)) playSound("discard");
    else if (game.phase.kind === "turn" && game.phase.seat === HUMAN && game.phase.drawn && !(prev.phase.kind === "turn" && prev.phase.drawn)) playSound("draw");
  }, [game]);
  const beforeMove = useRef<GameState | null>(null);
  useEffect(() => {
    const prev = beforeMove.current;
    beforeMove.current = game;
    if (!prev) return;
    if (prev.phase.kind === "over" && game.phase.kind !== "over") {
      setDecisions([]);
      setReviewOpen(false);
      return;
    }
    const mine = game.players[HUMAN].discards;
    if (prev.phase.kind === "turn" && prev.phase.seat === HUMAN && mine.length === prev.players[HUMAN].discards.length + 1)
      setDecisions((d) => [...d, { before: prev, tile: mine[mine.length - 1] }]);
  }, [game]);
  // Where the scores sheet is drawn: outside the table (in the app's own
  // colours), but turned with it on a phone held upright.
  const [sheetHost] = useState(() => {
    const host = document.createElement("div");
    host.className = "play-sheet-host";
    // The layer that turns (the host itself stays put - see App.css).
    const turn = document.createElement("div");
    turn.className = "play-sheet-turn";
    host.appendChild(turn);
    return host;
  });
  useEffect(() => {
    document.body.appendChild(sheetHost);
    // The page behind at its top: a scrolled page throws iPhone Safari's
    // taps off on a turned table.
    window.scrollTo(0, 0);
    return () => sheetHost.remove();
  }, [sheetHost]);
  // The side seats' columns both as wide as the wider seat (its melds and
  // flowers included), so a call on one side never pushes the middle over.
  const feltRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const felt = feltRef.current;
    if (!felt) return;
    const seats = [...felt.querySelectorAll<HTMLElement>(".play-seat-left, .play-seat-right")];
    const fit = () => felt.style.setProperty("--play-side", `${Math.max(...seats.map((el) => el.offsetWidth))}px`);
    fit();
    const watch = new ResizeObserver(fit);
    seats.forEach((el) => watch.observe(el));
    return () => watch.disconnect();
  }, []);
  // The far seat's melds and flowers along its row, beside its hand - in
  // front of the hand only when the row really won't fit across the table.
  // The hand keeps a slot for a drawn tile, so only a call or a flower can
  // change this, never a draw.
  const [topFront, setTopFront] = useState(false);
  useLayoutEffect(() => {
    const felt = feltRef.current;
    const seat = felt?.querySelector<HTMLElement>(".play-seat-top");
    const side = seat?.querySelector<HTMLElement>(".play-seat-side");
    if (!felt || !seat || !side) return;
    const fit = () => {
      const hand = seat.querySelector<HTMLElement>(".play-edge-top");
      if (!hand) return; // the hand laid out at the end: leave it as it was
      const cols = getComputedStyle(felt).gridTemplateColumns.split(" ").map(parseFloat);
      const room = cols.slice(1, -1).reduce((a, b) => a + b, 0);
      const gap = parseFloat(getComputedStyle(seat).columnGap) || 0;
      setTopFront(hand.offsetWidth + gap + side.offsetWidth > room);
    };
    fit();
    const watch = new ResizeObserver(fit);
    watch.observe(felt);
    watch.observe(side);
    return () => watch.disconnect();
  }, []);
  // The table as deep as the screen allows at its one angle: its far edge
  // just under the name cards. It depends only on the screen, so it's
  // worked out when that changes size - never as the game goes on, so
  // nothing on the table is resized mid-game.
  useLayoutEffect(() => {
    const felt = feltRef.current;
    const stage = felt?.parentElement;
    if (!felt || !stage) return;
    // The table's top as drawn: on a phone held upright the whole table is
    // turned a quarter (see .play-screen), its top along the phone's right
    // edge - further right is higher up.
    const turned = window.matchMedia(TURNED);
    const topOf = (el: Element) => {
      const r = el.getBoundingClientRect();
      return turned.matches ? -r.right : r.top;
    };
    const fitDepth = () => {
      felt.style.height = "";
      const limit = topOf(stage) + parseFloat(getComputedStyle(stage).paddingTop);
      let lo = felt.offsetHeight;
      let hi = lo * 3;
      for (let i = 0; i < 14; i++) {
        const mid = (lo + hi) / 2;
        felt.style.height = `${mid}px`;
        if (topOf(felt) >= limit) lo = mid;
        else hi = mid;
      }
      felt.style.height = `${Math.floor(lo)}px`;
    };
    fitDepth();
    const watch = new ResizeObserver(fitDepth);
    watch.observe(stage);
    return () => watch.disconnect();
  }, []);
  const ledger = online ? online.scores : localLedger;
  // 投降 on the result card takes two taps; this is the holder armed.
  const [surrenderArmed, setSurrenderArmed] = useState<string | null>(null);
  // Online: the table's bots (a mystery one as a mystery - the server never
  // says which it is), and no one in the seats people sit in.
  const onlineSeats = online?.table.seats;
  const bots = useMemo<(BotProfile | null)[]>(() => {
    if (!onlineSeats || !net) return [null, ...opponents.map(botById)];
    return [0, 1, 2, 3].map((i) => {
      const info = onlineSeats[net.toTable(i)];
      if (info?.kind !== "bot") return null;
      return info.bot === MYSTERY_BOT ? mysteryProfile("veteran") : profileById(info.bot);
    });
  }, [opponents, onlineSeats, net]);
  // The learned bots' network: loaded when one is seated or the Opponents
  // sheet opens; until then (or if there's none) they play by their rules.
  const [model, setModel] = useState<LearnedModel | null>(null);
  const wantModel = !online && (opponentsOpen || opponents.some((id) => id.startsWith(LEARNED_PREFIX)));
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
  // Online: a quick reaction shows as a bubble by whoever sent it (you too).
  const showBubble = (seat: number, text: string) => {
    const id = Date.now() + seat;
    setBubbles((b) => ({ ...b, [seat]: { text, id } }));
    window.setTimeout(() => setBubbles((b) => (b[seat]?.id === id ? Object.fromEntries(Object.entries(b).filter(([k]) => Number(k) !== seat)) : b)), BUBBLE_MS);
  };
  const reaction = online?.reaction ?? null;
  useEffect(() => {
    if (!reaction || !net) return;
    showBubble(net.toLocal(reaction.seat), reaction.r);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reaction?.id]);
  const [reacting, setReacting] = useState(false);
  const lastLine = useRef<Record<number, string>>({});
  // A call says which (chow, pung, kong), so the line fits it.
  const say = (seat: number, line: keyof Voice, call?: CallKind) => {
    const bot = bots[seat];
    if (!bot) return;
    const lines = call ? callLines(voiceOf(bot), call) : voiceOf(bot)[line];
    // Never the same line twice running from one bot.
    let text = lines[Math.floor(Math.random() * lines.length)];
    if (lines.length > 1 && text === lastLine.current[seat]) text = lines[(lines.indexOf(text) + 1 + Math.floor(Math.random() * (lines.length - 1))) % lines.length];
    lastLine.current[seat] = text;
    const id = Date.now() + seat;
    setBubbles((b) => ({ ...b, [seat]: { text, id } }));
    window.setTimeout(() => setBubbles((b) => (b[seat]?.id === id ? Object.fromEntries(Object.entries(b).filter(([k]) => Number(k) !== seat)) : b)), BUBBLE_MS);
  };
  // "You", or the bot's English name (老手 Veteran -> Veteran); online,
  // people by their nickname and bots by the name the table gives them.
  const nameOf = (seat: number): string => {
    if (seat === HUMAN && seated) return "You";
    if (online && net) {
      const info = online.table.seats[net.toTable(seat)];
      if (!info) return "?";
      return info.kind === "bot" ? info.name.split(" ").slice(1).join(" ") || info.name : info.name;
    }
    return englishName(bots[seat]!);
  };
  // One character for a seat: 你, a bot's avatar character, a person's initial.
  const initialOf = (seat: number) =>
    seat === HUMAN && seated ? "你" : bots[seat] ? (mysteryStyle(bots[seat]!) ? "?" : bots[seat]!.name[0]) : nameOf(seat).slice(0, 1).toUpperCase();
  const [selected, setSelected] = useState<number | null>(null);
  const [burst, setBurst] = useState<{ seat: number; label: string; id: number } | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  // New game wipes the running totals, so it takes a second tap.
  const [confirmNew, setConfirmNew] = useState(false);
  const [trackerOpen, setTrackerOpen] = useState(false);
  const [chowChoice, setChowChoice] = useState(false);
  // Your last chow / pung / kong, with the discard it came from - so 嗌錯 can
  // take it back until you discard.
  const [lastCall, setLastCall] = useState<{ before: GameState; decisions: (Claim | null)[] } | null>(null);
  // 叮 armed: the next discard declares it (only tiles that leave you ready).
  const [riichiArmed, setRiichiArmed] = useState(false);
  const [resultHidden, setResultHidden] = useState(false);
  // 自動: your seat played for you (this phone's own game only).
  const [autoplay, setAutoplay] = useState(false);
  const autoBot = useMemo(() => botById(AUTOPLAY_BOT), []);

  // This device's own game (never an online one).
  useEffect(
    () => save({ game: localGame, totals: localTotals, hint, timer, opponents, speed, oneTap, record, multiWin, ledger: localLedger }),
    [localGame, localTotals, hint, timer, opponents, speed, oneTap, record, multiWin, localLedger]
  );

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
    setLastCall(null);
    setGame(next);
  };

  const showBurst = (seat: number, label: string) => {
    playSound(burstSound(label));
    const id = Date.now();
    setBurst({ seat, label, id });
    window.setTimeout(() => setBurst((b) => (b?.id === id ? null : b)), BURST_MS);
  };

  // Online: a burst (and a bot's line) for what just happened at the table -
  // not for whatever happened before this phone looked.
  const lastSeen = useRef<string | null>(null);
  const lastAction = online?.table.last ?? null;
  useEffect(() => {
    if (!online || !net) return;
    const key = JSON.stringify([online.table.hand, game.discardsMade, lastAction]);
    if (!lastAction || lastSeen.current === key) return;
    const first = lastSeen.current === null;
    lastSeen.current = key;
    if (first) return;
    const at = net.toLocal;
    if (lastAction.kind === "call") {
      showBurst(at(lastAction.seat), lastAction.call === "chow" ? "上" : lastAction.call === "pung" ? "碰" : "槓");
      say(at(lastAction.seat), "call", lastAction.call);
    } else if (lastAction.kind === "kong") showBurst(at(lastAction.seat), "槓");
    else if (lastAction.kind === "discard" && lastAction.riichi) {
      showBurst(at(lastAction.seat), "叮");
      say(at(lastAction.seat), "riichi");
    } else if (lastAction.kind === "win") {
      const seat = at(lastAction.seats[0]);
      const n = lastAction.seats.length;
      showBurst(seat, lastAction.robKong ? "搶槓" : lastAction.from === null ? "自摸" : n > 1 ? (n === 2 ? "雙響" : "三響") : "胡");
      say(seat, lastAction.from === null ? "selfDraw" : "win");
      if (lastAction.from !== null) say(at(lastAction.from), "dealIn");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastAction, online?.table.hand, game.discardsMade]);

  const humanClaims = game.phase.kind === "claims" && seated && waitedOn ? claimOptions(game, HUMAN) : [];

  // The bots' claims on the current discard are decided as soon as it lands
  // (they can't see what the human will do).
  const botDecisions = useMemo(
    () => (!online && game.phase.kind === "claims" ? Array.from({ length: SEATS }, (_, seat) => (seat === HUMAN ? null : botClaimFor(game, seat, bots[seat]!))) : null),
    [game, bots, online]
  );

  // Learned bots decide their claims through the network (async); a resolve
  // already under way for this discard ignores a second call.
  const resolving = useRef<GameState | null>(null);
  const resolve = async (humanClaim: Claim | null) => {
    if (online) {
      online.send({ t: "claim", step: online.table.step, claim: humanClaim as WireClaim });
      return;
    }
    if (!botDecisions || resolving.current === game) return;
    resolving.current = game;
    const decisions = botDecisions.slice();
    decisions[HUMAN] = humanClaim;
    if (humanClaims.length && !autoplay) recordMine(1, claimDecisionAction(game, humanClaim));
    for (let seat = 1; seat < SEATS; seat++) {
      const net = learnedBot(seat);
      if (net) decisions[seat] = await learnedClaim(net, game, seat);
    }
    const seat = winningClaimSeat(game, decisions);
    if (seat !== null) {
      showBurst(seat, game.phase.kind === "claims" && game.phase.robKong ? "搶槓" : claimLabel(decisions[seat]!));
      if (decisions[seat]!.kind === "win") {
        say(seat, "win");
        if (game.phase.kind === "claims") say(game.phase.from, "dealIn");
      } else say(seat, "call", decisions[seat]!.kind as CallKind);
    }
    advance(resolveClaims(game, decisions));
    if (seat === HUMAN && humanClaim && humanClaim.kind !== "win") setLastCall({ before: game, decisions });
  };

  // 嗌錯: take back your call - the discard plays on as if you'd passed and
  // you pay each player. Anything the call itself earned (a kong's
  // replacement flower) is handed back.
  const canRetract =
    !!lastCall &&
    game.phase.kind === "turn" &&
    game.phase.seat === HUMAN &&
    game.discardsMade === lastCall.before.discardsMade &&
    game.players[HUMAN].melds.length === lastCall.before.players[HUMAN].melds.length + 1;
  const retract = () => {
    if (!lastCall || !canRetract) return;
    const kept = lastCall.before.tableBonuses?.length ?? 0;
    const now = game.tableBonuses ?? [];
    const refund = now.slice(kept).filter((b) => b.paid);
    if (refund.length) setTotals((t) => t.map((v, i) => v - refund.reduce((sum, b) => sum + b.deltas[i], 0)));
    const next = retractClaim(lastCall.before, lastCall.decisions, HUMAN);
    next.tableBonuses = next.tableBonuses?.map((b, i) => (i < kept ? { ...b, paid: now[i]?.paid ?? b.paid } : b));
    paidBonuses.current.keys = new Set([...paidBonuses.current.keys].filter((k) => Number(k) < kept));
    advance(next);
  };

  const me = game.players[HUMAN];
  const myTurn = seated && waitedOn && game.phase.kind === "turn" && game.phase.seat === HUMAN;
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
    if (!record || online) return;
    const mask = legalActions(game, HUMAN);
    if (mask.reduce((n, m) => n + m, 0) < 2) return;
    void recordDecision({ obs: encodeObservation(game, HUMAN), mask, action, kind, hand: handId.current });
  };

  const doTurn = (move: TurnMove) => {
    if (online) {
      online.send({ t: "move", step: online.table.step, move: move as WireMove });
      setSelected(null);
      setRiichiArmed(false);
      return;
    }
    recordMine(0, turnMoveAction(move));
    if (move.kind === "selfDraw") showBurst(HUMAN, "自摸");
    else if (move.kind === "discard" && move.riichi) showBurst(HUMAN, "叮");
    else if (move.kind !== "discard") showBurst(HUMAN, "槓");
    advance(applyTurnMove(game, move));
  };

  // Bot pacing: one move per botDelay(), and a discard nobody (the human
  // included) can claim moves on by itself.
  useEffect(() => {
    if (online) {
      // The server plays the bots; a locked 叮 hand still throws its draw by itself.
      const phase = game.phase;
      if (!myTurn || phase.kind !== "turn" || !me.riichi || isWinningHand(me) || !phase.drawn) return;
      const tile = phase.drawn;
      const id = window.setTimeout(() => doTurn({ kind: "discard", tile }), 700);
      return () => window.clearTimeout(id);
    }
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
    if (phase.kind === "turn" && (phase.seat !== HUMAN || autoplay)) {
      // Decide now, so the pause can match how hard the choice was.
      const { move: m, difficulty } = botTurnFor(game, phase.seat === HUMAN ? autoBot : bots[phase.seat]!);
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
    } else if (phase.kind === "claims" && (humanClaims.length === 0 || autoplay)) {
      // On autoplay your seat's call is the autoplay bot's.
      const mine = autoplay && humanClaims.length ? botClaimFor(game, HUMAN, autoBot) : null;
      move = () => resolve(mine);
      // Someone had a call to weigh: they take a moment either way; a call
      // that's coming lets the discard land first.
      const pondered = [1, 2, 3].some((seat) => seat !== phase.from && claimOptions(game, seat).length > 0);
      const called = mine !== null || botDecisions?.some((d) => d !== null);
      delay = called ? CLAIM_DELAY_MS : pondered ? PONDER_DELAY_MS + Math.random() * 300 : PASS_DELAY_MS;
    }
    if (!move) return;
    const id = window.setTimeout(move, delay * SPEEDS[speed].factor);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game, rolling, myTurn, autoplay]);

  // The turn timer (off by default): runs only while the human has to
  // decide, and on running out passes on a call or throws the drawn tile.
  const deciding = !autoplay && (myTurn || humanClaims.length > 0);
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
  const [countdown, setCountdown] = useState<Countdown | null>(null);
  // Online, the server's deadline (it moves for you when it passes).
  const deadline = online?.table.deadline ?? null;
  useEffect(() => {
    if (!online) return;
    if (deadline === null) {
      setSecondsLeft(null);
      setCountdown(null);
      return;
    }
    const total = online.table.settings.timer;
    setCountdown(total ? { total, endsAt: deadline } : null);
    const tick = () => setSecondsLeft(Math.max(0, Math.ceil((deadline - Date.now()) / 1000)));
    tick();
    const id = window.setInterval(tick, 250);
    return () => window.clearInterval(id);
  }, [online, deadline]);
  useEffect(() => {
    if (online) return;
    if (!timer || !deciding) {
      setSecondsLeft(null);
      setCountdown(null);
      return;
    }
    const started = Date.now();
    setSecondsLeft(timer);
    setCountdown({ total: timer, endsAt: started + timer * 1000 });
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
    if (!seated || myTurn || me.hand.length !== meldsNeeded(me) * 3 + 1) return null;
    const ws = getWaits(me.hand, meldsNeeded(me));
    if (ws.length === 0) return null;
    const unseen = unseenCounts(game, HUMAN);
    return ws.map((t) => ({ tile: t, left: Math.max(0, unseen.get(tileKey(t)) ?? 0) }));
  }, [game, me, myTurn, seated]);
  const myShanten = useMemo(() => {
    if (!hint || !seated) return null;
    if (myTurn) return ratings?.[0]?.shanten ?? null;
    return me.hand.length === meldsNeeded(me) * 3 + 1 ? shanten(me.hand, meldsNeeded(me)) : null;
  }, [hint, myTurn, ratings, me, seated]);

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
    if (online) {
      online.send({ t: "ready" });
      return;
    }
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
    // A new game, new mysteries.
    setOpponents((o) => o.map((id) => (id.startsWith(MYSTERY_PREFIX) ? newMystery() : id)));
    setMenuOpen(false);
    setSelected(null);
    setResultHidden(false);
    const g = newGame();
    ledgerFrom.current = g;
    const fresh = newPlayLedger(playerNames(opponents), g.dealer);
    setLedger({ ...fresh, events: playEvents(null, g, fresh.seats) });
    setGame(g);
  };

  // The pond whose newest tile is up for claiming (not when robbing a kong:
  // that tile was never discarded).
  // The newest discard: from whichever pond just grew - not from the claim
  // window, which online is often settled before this phone sees it (no
  // drop, no pin, no bubble for most bot discards). Gone once it's claimed
  // or the hand ends. Online, a discard whose claim window passed unseen
  // still flashes in the bubble for a moment.
  const pondSizes = useRef<number[] | null>(null);
  const [latest, setLatest] = useState<{ seat: number; count: number; tile: Tile; id: number } | null>(null);
  const [flash, setFlash] = useState<{ seat: number; tile: Tile; id: number } | null>(null);
  useEffect(() => {
    const sizes = game.players.map((p) => p.discards.length);
    const prev = pondSizes.current;
    pondSizes.current = sizes;
    if (!prev) return;
    const seat = sizes.findIndex((n, i) => n > prev[i]);
    if (seat < 0) return;
    const tile = game.players[seat].discards[sizes[seat] - 1];
    const id = Date.now();
    setLatest({ seat, count: sizes[seat], tile, id });
    if (online && game.phase.kind !== "claims") {
      setFlash({ seat, tile, id });
      window.setTimeout(() => setFlash((f) => (f?.id === id ? null : f)), FLASH_MS);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game]);
  const discardFrom =
    game.phase.kind === "over" ? null : latest && game.players[latest.seat].discards.length === latest.count ? latest.seat : null;
  // The finished hand, with its scores as the card shows them (online, as the server sent them).
  const shownResult: ResultView | null = useMemo(() => {
    if (net) return net.result;
    if (game.phase.kind !== "over") return null;
    const { alsoWon, ...r } = game.phase.result;
    return {
      ...r,
      score: r.score ? scoreView(r.score) : null,
      ...(alsoWon ? { alsoWon: alsoWon.map((w) => ({ winner: w.winner, score: w.score ? scoreView(w.score) : null, scoreError: w.scoreError })) } : {}),
    };
  }, [game, net]);
  const activeSeat = game.phase.kind === "turn" ? game.phase.seat : game.phase.kind === "claims" ? game.phase.from : null;
  const over = game.phase.kind === "over";
  const result = over ? shownResult : null;
  // You won this hand: your tiles topple flat, as everyone's on the table do.
  const iWon = !!result && !!result.tile && (result.winner === HUMAN || !!result.alsoWon?.some((w) => w.winner === HUMAN));
  // The card held back while the table shows how the hand ended - only when
  // it ends in front of you (a game opened already over shows it at once).
  const [cardHeld, setCardHeld] = useState(false);
  const wasOver = useRef(over);
  // Before the screen updates (a layout effect), so the card never shows
  // for a frame first.
  useLayoutEffect(() => {
    const ended = over && !wasOver.current;
    wasOver.current = over;
    if (!ended) return;
    setCardHeld(true);
    const won = game.phase.kind === "over" && game.phase.result.winner !== null;
    const t = window.setTimeout(() => setCardHeld(false), won ? WIN_SHOW_MS : DRAW_SHOW_MS);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [over]);
  // 我的紀錄: your record across games, added to as each hand you play ends
  // (watching doesn't count) - with any big pattern won for the first time,
  // for the result card.
  const [playRecord, setPlayRecord] = useState(loadRecord);
  const [recordOpen, setRecordOpen] = useState(false);
  const [milestones, setMilestones] = useState<string[]>([]);
  const recordedOver = useRef(over);
  useEffect(() => {
    const ended = over && !recordedOver.current;
    recordedOver.current = over;
    if (!over) setMilestones([]);
    if (!ended || !result || !seated) return;
    const opponents: Opponent[] = [1, 2, 3].map((seat) => {
      const bot = bots[seat];
      if (!bot) return { seat, key: `people:${nameOf(seat)}`, name: nameOf(seat) };
      if (mysteryStyle(bot)) return { seat, key: "mystery", name: "Mystery" };
      return { seat, key: bot.id, name: nameOf(seat) };
    });
    const { record: next, firsts } = addHand(loadRecord(), result, opponents);
    saveRecord(next);
    setPlayRecord(next);
    setMilestones(firsts);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [over]);
  // On autoplay the next hand deals itself once the result has been up a while.
  useEffect(() => {
    if (!autoplay || !over || cardHeld || online) return;
    const t = window.setTimeout(() => nextHandWithSurrenders(), AUTOPLAY_NEXT_MS);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoplay, over, cardHeld, game]);
  // Online, between hands: whether you've said you're ready, and who hasn't.
  const meReady = !!online && online.table.you !== null && online.table.ready.includes(online.table.you);
  const notReady = online && net ? online.table.waitingOn.filter((s) => s !== online.table.you).map((s) => nameOf(net.toLocal(s))) : [];
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
        const who = initialOf(on);
        const tone = on === HUMAN ? " is-on-you" : seat === HUMAN ? " is-yours" : "";
        return (
          <span key={l.pulled} className={`play-lah${tone}`} title={`${nameOf(seat)} 拉 ${nameOf(on)}: ${l.value} (${l.count} in a row)`}>
            拉{who} {l.value}
          </span>
        );
      });

  // Online: a person whose phone has dropped, or whom the table is playing for.
  const seatTag = (seat: number) => {
    if (!online || !net) return null;
    const t = net.toTable(seat);
    const info = online.table.seats[t];
    if (online.table.auto.includes(t)) return <span className="play-away">auto</span>;
    if (info?.kind === "human" && !info.connected) return <span className="play-away">away</span>;
    return null;
  };

  // The dealer's chip, with their run of wins and draws (連莊) on it.
  const dealerChip = game.dealerStreak > 0 ? <span className="play-dealer is-streak">莊連{game.dealerStreak}</span> : <span className="play-dealer">莊</span>;

  // A bot's name card - flat, over the corner of the table like a HUD.
  const badge = (seat: number) => (
    <span className={`play-badge at-${SIDES[seat]}${activeSeat === seat ? " is-active" : ""}`}>
      <span className="play-badge-wind">{WIND_CHARS[seatWind(seat, game.dealer)]}</span>
      {bots[seat] && <Avatar bot={bots[seat]!} />}
      <span className="play-badge-name">
        <span className="play-badge-name-text">{nameOf(seat)}</span>
        <span className="play-badge-chips">
          {seatTag(seat)}
          {seat === game.dealer && dealerChip}
          {game.players[seat].riichi && <span className="play-riichi">叮</span>}
          {lahChips(seat)}
        </span>
        {bubbles[seat] && (
          <span key={bubbles[seat].id} className="play-bubble" role="status">
            {bubbles[seat].text}
          </span>
        )}
      </span>
      {total(seat)}
    </span>
  );

  // Who's holding a tile just drawn (online, the table says so - not which).
  const drewSeat =
    game.phase.kind === "turn" && (game.phase.drawn !== null || ("drew" in game.phase && game.phase.drew)) ? game.phase.seat : null;
  // A bot's tiles, standing along its edge of the (tilted) table.
  // The tile a seat won with (to lay sideways in its hand), if it won.
  const wonWith = (seat: number) =>
    result && result.tile && (result.winner === seat || result.alsoWon?.some((w) => w.winner === seat)) ? result.tile : null;
  const wall = (seat: number) => {
    const side = SIDES[seat];
    const p = game.players[seat];
    // Online, a losing hand the table keeps hidden (until its player shows
    // it) stays standing, face down.
    const hidden = p.hand.some((t) => t === BLANK);
    // Losing hands hidden, one shown is shown later, by choice: at once.
    const choosing = online?.table.settings.reveal === false;
    return (
      <div className={`play-seat play-seat-${side}${side !== "top" || topFront ? " is-front" : ""}`}>
        {/* Melds and flowers in front of a side player's wall, from their
            left (the CSS turns them to face them); across, on the far
            player's left along their row - or in front, if that runs long. */}
        <span className="play-seat-side">
          <Flowers flowers={p.flowers} />
          <span className="play-seat-melds">
            <Melds melds={p.melds} hideConcealed={!over || hidden} />
          </span>
        </span>
        {over && !hidden ? (
          <RevealedHand
            tiles={p.hand}
            winningTile={wonWith(seat)}
            topple={wonWith(seat) ? TOPPLE_WINNER : result?.winner === null || choosing ? TOPPLE_DRAW : TOPPLE_OTHERS}
          />
        ) : (
          <EdgeTiles count={p.hand.length} side={side} drew={!over && drewSeat === seat} />
        )}
      </div>
    );
  };

  // Your ways to make a run with the discard - each run once (with only one,
  // 上 takes it at once; the choice shows only when there's a real choice).
  const chows = humanClaims
    .filter((c): c is Extract<Claim, { kind: "chow" }> => c.kind === "chow")
    .filter((c, i, all) => all.findIndex((d) => tilesKey(sortTiles([...d.tiles])) === tilesKey(sortTiles([...c.tiles]))) === i);
  const otherClaims = humanClaims.filter((c) => c.kind !== "chow");

  return (
    <div className="play-screen">
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
          {!online && (
            <button
              type="button"
              className={`play-icon-button is-text${autoplay ? " is-on" : ""}`}
              onClick={() => {
                setAutoplay((a) => !a);
                setSelected(null);
                setChowChoice(false);
              }}
              aria-pressed={autoplay}
              title={autoplay ? "自動 - the Grandmaster is playing your seat; tap to take it back" : "自動 - let the Grandmaster play your seat and watch"}
            >
              {autoplay ? "■ 自動" : "▶ 自動"}
            </button>
          )}
          {ledger && (
            <button type="button" className="play-icon-button is-text" onClick={() => setScoresOpen(true)} aria-label="Scores so far" title="戰況 - the scores so far, 拉, every hand and each player's stats">
              戰況
            </button>
          )}
          {/* Online: quick reactions for the table, and who's watching. */}
          {online && seated && (
            <button type="button" className={`play-icon-button${reacting ? " is-on" : ""}`} onClick={() => setReacting((r) => !r)} aria-label="Send a reaction" aria-expanded={reacting}>
              😊
            </button>
          )}
          {online && online.table.watching > 0 && (
            <span className="play-watching" title={`${online.table.watching} watching`}>
              👁 {online.table.watching}
            </span>
          )}
          {reacting && online && (
            <div className="play-reactions" role="menu">
              {REACTIONS.map((r) => (
                <button
                  key={r}
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    online.send({ t: "react", r });
                    setReacting(false);
                  }}
                >
                  {r}
                </button>
              ))}
            </div>
          )}
          {menuOpen && online && (
            <div className="play-menu">
              <p className="play-menu-note">
                Table {online.table.code} · {online.table.settings.multiWin ? "一炮多響" : "截胡"} · timer {online.table.settings.timer ? `${online.table.settings.timer}s` : "off"}
                {online.table.watching > 0 && ` · ${online.table.watching} watching`}
              </p>
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
              <SoundRow />
              <button type="button" onClick={onExit}>
                Leave (your seat waits for you)
              </button>
              {online.host && (
                <button type="button" className={confirmNew ? "is-armed" : undefined} onClick={() => (confirmNew ? online.send({ t: "end" }) : setConfirmNew(true))}>
                  {confirmNew ? "Tap again to end the table" : "End the table"}
                </button>
              )}
            </div>
          )}
          {menuOpen && !online && (
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
                  一炮多響
                  <span className="play-menu-note"> · {multiWin ? "everyone off one discard wins" : "截胡: first in turn takes it"}</span>
                </span>
                <span className="play-menu-seg">
                  {[false, true].map((on) => (
                    <button key={String(on)} type="button" className={multiWin === on ? "toggle-on" : undefined} aria-pressed={multiWin === on} onClick={() => setMultiWin(on)}>
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
                  setRecordOpen(true);
                }}
              >
                <span>我的紀錄 Your record</span>
                <span className="play-menu-value">
                  {playRecord.hands ? `${playRecord.wins} wins / ${playRecord.hands}` : "–"} ›
                </span>
              </button>
              <button
                type="button"
                className="play-menu-link"
                onClick={() => {
                  setMenuOpen(false);
                  setOpponentsOpen(true);
                }}
              >
                <span>Opponents</span>
                <span className="play-menu-value">{opponents.map((id) => shortName(botById(id))).join(" · ")} ›</span>
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
              <SoundRow />
              {onOnline && (
                <button type="button" className="play-menu-link" onClick={onOnline}>
                  <span>線上對局 Play online</span>
                  <span className="play-menu-value">with friends or bots ›</span>
                </button>
              )}
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
          <div className="play-felt" ref={feltRef}>
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
              <Compass game={game} active={over ? null : activeSeat} center={compassCenter} countdown={over ? null : countdown} />
              {game.phase.kind === "claims" ? (
                <span key={game.discardsMade} className={`play-spotlight from-${SIDES[game.phase.from]}`}>
                  <TileGlyphSpan tile={game.phase.tile} block />
                </span>
              ) : (
                flash &&
                game.phase.kind !== "over" && (
                  <span key={flash.id} className={`play-spotlight from-${SIDES[flash.seat]}`}>
                    <TileGlyphSpan tile={flash.tile} block />
                  </span>
                )
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

        <div className={`play-me${autoplay ? " is-auto" : ""}`}>
          <div className="play-hand-wrap">
            <div className="play-calls">
              {result && resultHidden && !cardHeld && (
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
                  {canRetract && (
                    <button type="button" className="play-call is-pass is-minor" onClick={retract} aria-label="嗌錯 - take back your call and pay 5 to each">
                      嗌錯
                    </button>
                  )}
                  {canSelfDraw && (
                    <button type="button" className="play-call is-win is-long" onClick={() => doTurn({ kind: "selfDraw" })}>
                      自摸
                    </button>
                  )}
                  {riichiArmed && (
                    <button
                      type="button"
                      className="play-call is-pass is-minor"
                      onClick={() => {
                        setSelected(null);
                        setRiichiArmed(false);
                      }}
                      aria-label="Cancel 叮 - discard as usual"
                    >
                      取消
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
            <div className={`play-hand${myTurn ? " is-turn" : ""}${iWon ? " is-toppled" : ""}`}>
              {(me.melds.length > 0 || me.flowers.length > 0) && (
                <span className="play-my-melds">
                  {/* Flowers always leftmost, then melds, then the hand. */}
                  <Flowers flowers={me.flowers} />
                  <Melds melds={me.melds} hideConcealed={!seated} inRow />
                </span>
              )}
              {handTiles.map((t, i) => {
                const isDrawn = handView.drawnTile !== null && i === handTiles.length - 1;
                const barred = isForbidden(t);
                return (
                  <button
                    key={i}
                    type="button"
                    style={{ "--i": i } as CSSProperties}
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
                    {t === BLANK ? (
                      // Watching, not seated: the seat's tiles face down, as blocks like the rest.
                      <span className="play-back">
                        <i className="tile-top" />
                        <TileSides fine />
                      </span>
                    ) : (
                      <TileGlyphSpan tile={t} block="fine" />
                    )}
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
            {game.dealer === HUMAN && dealerChip}
            {me.riichi && <span className="play-riichi">叮</span>}
            {lahChips(HUMAN)}
            {bubbles[HUMAN] && (
              <span key={bubbles[HUMAN].id} className="play-bubble is-mine" role="status">
                {bubbles[HUMAN].text}
              </span>
            )}
          </span>
          {total(HUMAN)}
          <span className="play-bar-round">
            {roundLabel(game)}
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
              {riichiArmed ? (selected === null ? "叮: choose the tile to throw (取消 to cancel)" : "Tap again to declare 叮") : "Tap again to discard"}
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
            {game.diceBonus && (
              <span className="play-dice-bonus">
                {game.diceBonus.name} ·{" "}
                {game.diceBonus.deltas[game.dealer] > 0
                  ? `${game.dealer === HUMAN ? "you collect" : `${nameOf(game.dealer)} collects`} ${game.diceBonus.deltas[game.dealer]} (${TRIPLE_DICE_BONUS} from each)`
                  : `${game.dealer === HUMAN ? "you pay" : `${nameOf(game.dealer)} pays`} ${-game.diceBonus.deltas[game.dealer]} (${SNAKE_DICE_PENALTY} to each)`}
              </span>
            )}
          </div>
        )}

        {trackerOpen && <TileTracker game={game} onClose={() => setTrackerOpen(false)} />}
        {scoresOpen && ledger && <PlayScores game={ledger} onClose={() => setScoresOpen(false)} host={sheetHost.firstElementChild} />}
        {recordOpen && <RecordSheet record={playRecord} onReset={setPlayRecord} onClose={() => setRecordOpen(false)} />}
        {reviewOpen && (
          <ReviewSheet
            decisions={decisions}
            dealtIn={!!result && result.winner !== null && result.from === HUMAN}
            onClose={() => setReviewOpen(false)}
          />
        )}
        {opponentsOpen && <OpponentsSheet opponents={opponents} learned={model?.styles ?? null} onChange={setOpponents} onClose={() => setOpponentsOpen(false)} />}

        {result && !resultHidden && !cardHeld && (
          <div className="play-result" role="dialog" aria-label="Hand result">
            <div className="play-result-card">
              <h2>
                {result.winner !== null && result.alsoWon?.length
                  ? `${result.alsoWon.length === 1 ? "雙響" : "三響"}! ${[result.winner, ...result.alsoWon.map((w) => w.winner)].map((w) => (w === HUMAN ? "You" : nameOf(w))).join(" and ")} won off ${
                      result.from === HUMAN ? "your" : `${nameOf(result.from!)}'s`
                    } ${result.robKong ? "kong (搶槓)" : "discard"}`
                  : result.winner === null
                  ? "Draw - wall exhausted (流局)"
                  : result.winner === HUMAN
                    ? result.from === null
                      ? "You won by self-draw! (自摸)"
                      : result.robKong
                        ? `You robbed ${nameOf(result.from)}'s kong! (搶槓)`
                        : `You won off ${nameOf(result.from)}'s discard!`
                    : `${nameOf(result.winner)} ${
                        result.from === null
                          ? "won by self-draw"
                          : result.robKong
                            ? `robbed ${result.from === HUMAN ? "your" : `${nameOf(result.from)}'s`} kong (搶槓)`
                            : result.from === HUMAN
                              ? "won off your discard"
                              : `won off ${nameOf(result.from)}`
                      }`}
              </h2>
              {result.winner !== null &&
                [{ winner: result.winner, score: result.score, scoreError: result.scoreError }, ...(result.alsoWon ?? [])].map((w) => (
                  <div key={w.winner} className="play-result-winner">
                    {result.alsoWon?.length ? <h3 className="play-result-who">{w.winner === HUMAN ? "You" : nameOf(w.winner)}</h3> : null}
                    <div className="play-result-hand">
                      <Flowers flowers={game.players[w.winner].flowers} />
                      <Melds melds={game.players[w.winner].melds} inRow />
                      <RevealedHand tiles={game.players[w.winner].hand} winningTile={result.tile} />
                    </div>
                    {w.score && (
                      <ul className="play-result-patterns">
                        {w.score.patterns.map(({ id, name, tai }, i) => (
                          <li key={`${i}-${id}`}>
                            <span>{name}</span>
                            <span>{tai}</span>
                          </li>
                        ))}
                        <li className="play-result-total">
                          <span>Total</span>
                          <span>{w.score.total} 台</span>
                        </li>
                      </ul>
                    )}
                    {w.scoreError && <p className="play-result-error">Couldn't score this hand: {w.scoreError}</p>}
                  </div>
                ))}
              {(result.pairs ?? []).some((p) => p.lah) && (
                <ul className="play-result-lah">
                  {(result.pairs ?? [])
                    .filter((p) => p.lah)
                    .map((p) => (
                      <li key={`${p.winner}-${p.payer}`}>
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
                        if (online && net) online.send({ t: "surrender", holder: net.toTable(holder) });
                        else setGame(surrender(game, holder, HUMAN));
                      }}
                    >
                      {armed ? "Tap again to 投降" : "投降"}
                    </button>
                  </div>
                );
              })}
              {milestones.length > 0 && <p className="play-result-milestone">🏅 First time: {milestones.join(" · ")}</p>}
              <div className="play-result-deltas">
                {result.deltas.map((d, seat) => (
                  <span key={seat} className={d < 0 ? "is-neg" : d > 0 ? "is-pos" : undefined}>
                    {nameOf(seat)} {d > 0 ? `+${d}` : d}
                  </span>
                ))}
              </div>
              {/* Losing hands hidden at this table: yours shows only if you say so. */}
              {online && seated && online.table.settings.reveal === false && !iWon && (
                <button type="button" className="play-show-hand" disabled={online.table.shown.includes(online.table.you!)} onClick={() => online.send({ t: "show" })}>
                  {online.table.shown.includes(online.table.you!) ? "亮牌 Shown ✓" : "亮牌 Show my hand"}
                </button>
              )}
              <div className="play-result-actions">
                <button type="button" className="play-view-table" onClick={() => setResultHidden(true)}>
                  View table
                </button>
                {decisions.length > 0 && (
                  <button type="button" className="play-view-table" onClick={() => setReviewOpen(true)}>
                    回顧 Review
                  </button>
                )}
                {seated && (
                  <button type="button" className="play-next" disabled={meReady} onClick={nextHandWithSurrenders}>
                    {meReady ? "Ready ✓" : "Next hand"}
                  </button>
                )}
              </div>
              {notReady.length > 0 && <p className="play-menu-note">Waiting for {notReady.join(", ")}</p>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
