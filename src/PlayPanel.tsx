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
  botClaim,
  botTurnMove,
  claimOptions,
  forbiddenDiscards,
  HUMAN,
  isWinningHand,
  kongOptions,
  liveTilesLeft,
  meldsNeeded,
  newGame,
  nextHand,
  rateDiscards,
  resolveClaims,
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

const WIND_CHARS = ["", "東", "南", "西", "北"];
const SEAT_NAMES = ["You", "Right", "Across", "Left"];
// Where each seat sits on screen, by seat index.
const SIDES = ["bottom", "right", "top", "left"] as const;
type Side = (typeof SIDES)[number];
// How long a bot "thinks" before each move, so the table can be followed.
const BOT_DELAY_MS = 650;
const BURST_MS = 1200;
const TIMER_CHOICES = [0, 10, 20] as const;
type TimerSetting = (typeof TIMER_CHOICES)[number];

const SAVE_KEY = "mjwaits.play";

interface Saved {
  game: GameState;
  totals: number[];
  hint: boolean;
  timer?: TimerSetting;
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

const claimLabel = (c: Claim) => (c.kind === "win" ? "胡" : c.kind === "kong" ? "槓" : c.kind === "pung" ? "碰" : "吃");

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

function Melds({ melds }: { melds: GameMeld[] }) {
  return (
    <>
      {melds.map((m, i) => (
        <span key={i} className="play-meld">
          {m.tiles.map((t, j) =>
            m.concealed && (j === 0 || j === 3) ? <span key={j} className="play-back" /> : <TileGlyphSpan key={j} tile={t} />
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
function Pond({ tiles, side, pinLast }: { tiles: Tile[]; side: Side; pinLast: boolean }) {
  return (
    <div className={`play-pond play-pond-${side}`}>
      {tiles.map((t, i) => {
        const last = pinLast && i === tiles.length - 1;
        return (
          <span key={i} className={last ? "play-pond-tile is-latest" : "play-pond-tile"}>
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

// ---- The table ------------------------------------------------------------

export function PlayPanel({ onExit }: { onExit: () => void }) {
  const saved = useMemo(loadSaved, []);
  const [game, setGame] = useState<GameState>(() => saved?.game ?? newGame());
  const [totals, setTotals] = useState<number[]>(() => saved?.totals ?? [0, 0, 0, 0]);
  const [hint, setHint] = useState(() => saved?.hint ?? false);
  const [timer, setTimer] = useState<TimerSetting>(() => saved?.timer ?? 0);
  const [selected, setSelected] = useState<number | null>(null);
  const [burst, setBurst] = useState<{ seat: number; label: string; id: number } | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [trackerOpen, setTrackerOpen] = useState(false);
  const [chowChoice, setChowChoice] = useState(false);
  const [resultHidden, setResultHidden] = useState(false);

  useEffect(() => save({ game, totals, hint, timer }), [game, totals, hint, timer]);

  // Every state change goes through here, so a finished hand's tai lands in
  // the running totals exactly once.
  const advance = (next: GameState) => {
    if (next.phase.kind === "over" && game.phase.kind !== "over") {
      const { deltas } = next.phase.result;
      setTotals((t) => t.map((v, i) => v + deltas[i]));
    }
    setSelected(null);
    setChowChoice(false);
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
    () => (game.phase.kind === "claims" ? Array.from({ length: SEATS }, (_, seat) => (seat === HUMAN ? null : botClaim(game, seat))) : null),
    [game]
  );

  const resolve = (humanClaim: Claim | null) => {
    if (!botDecisions) return;
    const decisions = botDecisions.slice();
    decisions[HUMAN] = humanClaim;
    const seat = winningClaimSeat(game, decisions);
    if (seat !== null) showBurst(seat, claimLabel(decisions[seat]!));
    advance(resolveClaims(game, decisions));
  };

  const me = game.players[HUMAN];
  const myTurn = game.phase.kind === "turn" && game.phase.seat === HUMAN;
  const drawn = myTurn && game.phase.kind === "turn" ? game.phase.drawn : null;
  const forbidden = myTurn ? forbiddenDiscards(game) : [];
  const isForbidden = (t: Tile) => forbidden.some((f) => sameTile(f, t));

  const doTurn = (move: TurnMove) => {
    if (move.kind === "selfDraw") showBurst(HUMAN, "自摸");
    else if (move.kind !== "discard") showBurst(HUMAN, "槓");
    advance(applyTurnMove(game, move));
  };

  // Bot pacing: one move per BOT_DELAY_MS, and a discard nobody (the human
  // included) can claim moves on by itself.
  useEffect(() => {
    const phase = game.phase;
    let move: (() => void) | null = null;
    if (phase.kind === "turn" && phase.seat !== HUMAN) {
      move = () => {
        const m = botTurnMove(game);
        if (m.kind === "selfDraw") showBurst(phase.seat, "自摸");
        else if (m.kind !== "discard") showBurst(phase.seat, "槓");
        advance(applyTurnMove(game, m));
      };
    } else if (phase.kind === "claims" && humanClaims.length === 0) {
      move = () => resolve(null);
    }
    if (!move) return;
    const id = window.setTimeout(move, BOT_DELAY_MS);
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
        const tile = drawn && !isForbidden(drawn) ? drawn : rateDiscards(game, HUMAN)[0].tile;
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

  const ratings = useMemo(() => (myTurn && hint ? rateDiscards(game, HUMAN) : null), [game, myTurn, hint]);
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
    if (selected === index) doTurn({ kind: "discard", tile: handTiles[index] });
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

  const opponent = (seat: number) => {
    const side = SIDES[seat];
    const p = game.players[seat];
    return (
      <div className={`play-seat play-seat-${side}${activeSeat === seat ? " is-active" : ""}`}>
        <span className="play-badge">
          <span className="play-badge-wind">{WIND_CHARS[seatWind(seat, game.dealer)]}</span>
          <span className="play-badge-name">
            {SEAT_NAMES[seat]}
            {seat === game.dealer && <span className="play-dealer">莊</span>}
          </span>
          {total(seat)}
        </span>
        <span className="play-seat-tiles">
          {over ? <RevealedHand tiles={p.hand} winningTile={null} /> : <EdgeTiles count={p.hand.length} side={side} />}
          <span className="play-seat-melds">
            <Melds melds={p.melds} />
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
          <button type="button" className="play-icon-button" onClick={() => setMenuOpen((o) => !o)} aria-label="Game menu" aria-expanded={menuOpen}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <path d="M5 7h14M5 12h14M5 17h14" />
            </svg>
          </button>
          <button type="button" className="play-icon-button is-text" onClick={() => setTrackerOpen(true)} aria-label="Tile tracker" title="記牌器 - tiles you haven't seen">
            記牌器
          </button>
          {menuOpen && (
            <div className="play-menu">
              <button type="button" className={hint ? "toggle-on" : undefined} aria-pressed={hint} onClick={() => setHint((h) => !h)}>
                Hints {hint ? "on" : "off"}
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
              <button type="button" onClick={startNewGame}>
                New game
              </button>
            </div>
          )}
        </div>

        {opponent(2)}
        {opponent(3)}
        {opponent(1)}

        <div className="play-pond-slot play-pond-slot-top">
          <Pond tiles={game.players[2].discards} side="top" pinLast={discardFrom === 2} />
        </div>
        <div className="play-pond-slot play-pond-slot-left">
          <Pond tiles={game.players[3].discards} side="left" pinLast={discardFrom === 3} />
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
          <Pond tiles={game.players[1].discards} side="right" pinLast={discardFrom === 1} />
        </div>
        <div className="play-pond-slot play-pond-slot-bottom">
          <Pond tiles={me.discards} side="bottom" pinLast={discardFrom === HUMAN} />
        </div>

        <div className="play-me">
          <div className="play-calls">
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
                    吃
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

        <div className="play-bar">
          <span className={`play-bar-you${activeSeat === HUMAN ? " is-active" : ""}`}>
            <span className="play-badge-wind">{WIND_CHARS[seatWind(HUMAN, game.dealer)]}</span>
            You
            {game.dealer === HUMAN && <span className="play-dealer">莊</span>}
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
          {myTurn && !over && (
            <span className="play-bar-prompt">{selected === null ? "Tap a tile, then again to discard" : "Tap again to discard"}</span>
          )}
        </div>

        {burst && <CallBurst key={burst.id} seat={burst.seat} label={burst.label} />}

        {trackerOpen && <TileTracker game={game} onClose={() => setTrackerOpen(false)} />}

        {result && resultHidden && (
          <button type="button" className="play-show-result" onClick={() => setResultHidden(false)}>
            Show result
          </button>
        )}
        {result && !resultHidden && (
          <div className="play-result" role="dialog" aria-label="Hand result">
            <div className="play-result-card">
              <h2>
                {result.winner === null
                  ? "Draw - wall exhausted (流局)"
                  : result.winner === HUMAN
                    ? result.from === null
                      ? "You won by self-draw! (自摸)"
                      : `You won off ${SEAT_NAMES[result.from]}'s discard!`
                    : `${SEAT_NAMES[result.winner]} won${result.from === null ? " by self-draw" : result.from === HUMAN ? " off your discard" : ` off ${SEAT_NAMES[result.from]}`}`}
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
                    {SEAT_NAMES[seat]} {d > 0 ? `+${d}` : d}
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
