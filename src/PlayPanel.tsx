// Play tab: a full hand of 16-tile mahjong against three local bots, laid
// out as a landscape table - you along the bottom, the bots right / across /
// left in turn order. All the rules and the bots live in lib/game.ts; this
// file only renders the state, paces the bots and takes the human's input.
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
  HUMAN,
  isWinningHand,
  kongOptions,
  liveTilesLeft,
  meldsNeeded,
  newGame,
  nextHand,
  rateDiscards,
  resolveClaims,
  sameTile,
  SEATS,
  seatWind,
  winningClaimSeat,
  type Claim,
  type GameMeld,
  type GameState,
  type TurnMove,
} from "./lib/game";
import { shanten, sortTiles, tileKey, tileLabel, type Tile } from "./lib/mahjong";
import { patternDisplayName } from "./lib/scoring";
import { BonusGlyphSpan, TileGlyphSpan } from "./TileGlyphs";

const WIND_CHARS = ["", "東", "南", "西", "北"];
const SEAT_NAMES = ["You", "Right", "Across", "Left"];
// How long a bot "thinks" before each move, so the table can be followed.
const BOT_DELAY_MS = 650;
const CALL_FLASH_MS = 1100;

const SAVE_KEY = "mjwaits.play";

interface Saved {
  game: GameState;
  totals: number[];
  hint: boolean;
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

function TileBacks({ count }: { count: number }) {
  return (
    <span className="play-backs" aria-label={`${count} concealed tiles`}>
      {Array.from({ length: count }, (_, i) => (
        <span key={i} className="play-back" />
      ))}
    </span>
  );
}

function Melds({ melds }: { melds: GameMeld[] }) {
  return (
    <>
      {melds.map((m, i) => (
        <span key={i} className={`play-meld${m.concealed ? " is-concealed" : ""}`}>
          {m.tiles.map((t, j) =>
            m.concealed && (j === 0 || j === 3) ? <span key={j} className="play-back" /> : <TileGlyphSpan key={j} tile={t} />
          )}
        </span>
      ))}
    </>
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

function Pond({ tiles, highlightLast }: { tiles: Tile[]; highlightLast: boolean }) {
  return (
    <div className="play-pond">
      {tiles.map((t, i) => (
        <TileGlyphSpan key={i} tile={t} highlight={highlightLast && i === tiles.length - 1} />
      ))}
    </div>
  );
}

export function PlayPanel({ onExit }: { onExit: () => void }) {
  const saved = useMemo(loadSaved, []);
  const [game, setGame] = useState<GameState>(() => saved?.game ?? newGame());
  const [totals, setTotals] = useState<number[]>(() => saved?.totals ?? [0, 0, 0, 0]);
  const [hint, setHint] = useState(() => saved?.hint ?? false);
  const [selected, setSelected] = useState<number | null>(null);
  const [flash, setFlash] = useState<{ seat: number; label: string } | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => save({ game, totals, hint }), [game, totals, hint]);

  // Every state change goes through here, so a finished hand's tai lands in
  // the running totals exactly once.
  const advance = (next: GameState) => {
    if (next.phase.kind === "over" && game.phase.kind !== "over") {
      const { deltas } = next.phase.result;
      setTotals((t) => t.map((v, i) => v + deltas[i]));
    }
    setSelected(null);
    setGame(next);
  };

  const showFlash = (seat: number, label: string) => {
    setFlash({ seat, label });
    window.setTimeout(() => setFlash((f) => (f?.seat === seat && f.label === label ? null : f)), CALL_FLASH_MS);
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
    if (seat !== null && seat !== HUMAN) showFlash(seat, claimLabel(decisions[seat]!));
    advance(resolveClaims(game, decisions));
  };

  // Bot pacing: one move per BOT_DELAY_MS, and a discard nobody (the human
  // included) can claim moves on by itself.
  useEffect(() => {
    const phase = game.phase;
    let move: (() => void) | null = null;
    if (phase.kind === "turn" && phase.seat !== HUMAN) {
      move = () => {
        const m = botTurnMove(game);
        if (m.kind === "selfDraw") showFlash(phase.seat, "自摸");
        else if (m.kind !== "discard") showFlash(phase.seat, "槓");
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

  const me = game.players[HUMAN];
  const myTurn = game.phase.kind === "turn" && game.phase.seat === HUMAN;
  const drawn = myTurn && game.phase.kind === "turn" ? game.phase.drawn : null;

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
  const myShanten = useMemo(() => {
    if (!hint) return null;
    if (myTurn) return ratings?.[0]?.shanten ?? null;
    return me.hand.length === meldsNeeded(me) * 3 + 1 ? shanten(me.hand, meldsNeeded(me)) : null;
  }, [hint, myTurn, ratings, me]);

  const canSelfDraw = myTurn && isWinningHand(me);
  const myKongs = myTurn && liveTilesLeft(game) > 0 ? kongOptions(me) : [];

  const doTurn = (move: TurnMove) => advance(applyTurnMove(game, move));

  const tapTile = (index: number) => {
    if (!myTurn) return;
    if (selected === index) doTurn({ kind: "discard", tile: handTiles[index] });
    else setSelected(index);
  };

  const startNewGame = () => {
    setTotals([0, 0, 0, 0]);
    setMenuOpen(false);
    setSelected(null);
    setGame(newGame());
  };

  const lastDiscardFrom = game.phase.kind === "claims" ? game.phase.from : null;
  const turnSeat = game.phase.kind === "turn" ? game.phase.seat : game.phase.kind === "claims" ? game.phase.from : null;

  const seatBadge = (seat: number) => (
    <span className={`play-seat-badge${turnSeat === seat ? " is-turn" : ""}`}>
      <span className="play-wind">{WIND_CHARS[seatWind(seat, game.dealer)]}</span>
      {seat === game.dealer && <span className="play-dealer">莊</span>}
      <span className="play-seat-name">{SEAT_NAMES[seat]}</span>
      <span className={`play-total${totals[seat] < 0 ? " is-neg" : ""}`}>{totals[seat] > 0 ? `+${totals[seat]}` : totals[seat]}</span>
      {flash?.seat === seat && <span className="play-flash">{flash.label}</span>}
    </span>
  );

  const opponent = (seat: number, side: "top" | "left" | "right") => {
    const p = game.players[seat];
    return (
      <div className={`play-opponent play-${side}`}>
        {seatBadge(seat)}
        <div className="play-opponent-tiles">
          {game.phase.kind === "over" ? <RevealedHand tiles={p.hand} winningTile={null} /> : <TileBacks count={p.hand.length} />}
          <Melds melds={p.melds} />
          {p.flowers.map((f, i) => (
            <BonusGlyphSpan key={i} tile={f} />
          ))}
        </div>
      </div>
    );
  };

  const result = game.phase.kind === "over" ? game.phase.result : null;

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
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <circle cx="5" cy="12" r="1.8" />
              <circle cx="12" cy="12" r="1.8" />
              <circle cx="19" cy="12" r="1.8" />
            </svg>
          </button>
          {menuOpen && (
            <div className="play-menu">
              <button type="button" className={hint ? "toggle-on" : undefined} aria-pressed={hint} onClick={() => setHint((h) => !h)}>
                Hints {hint ? "on" : "off"}
              </button>
              <button type="button" onClick={startNewGame}>
                New game
              </button>
            </div>
          )}
        </div>

        {opponent(2, "top")}
        {opponent(3, "left")}
        {opponent(1, "right")}

        <div className="play-center">
          <div className="play-pond-slot play-pond-top">
            <Pond tiles={game.players[2].discards} highlightLast={lastDiscardFrom === 2} />
          </div>
          <div className="play-pond-slot play-pond-left">
            <Pond tiles={game.players[3].discards} highlightLast={lastDiscardFrom === 3} />
          </div>
          <div className="play-info">
            <span className="play-round">{WIND_CHARS[game.roundWind]}風圈</span>
            <span className="play-wall">{liveTilesLeft(game)} left</span>
            {game.dealerStreak > 0 && <span className="play-streak">連莊 {game.dealerStreak}</span>}
          </div>
          <div className="play-pond-slot play-pond-right">
            <Pond tiles={game.players[1].discards} highlightLast={lastDiscardFrom === 1} />
          </div>
          <div className="play-pond-slot play-pond-bottom">
            <Pond tiles={me.discards} highlightLast={lastDiscardFrom === HUMAN} />
          </div>
        </div>

        <div className="play-me">
          <div className="play-me-head">
            {seatBadge(HUMAN)}
            <span className="play-me-melds">
              <Melds melds={me.melds} />
              {me.flowers.map((f, i) => (
                <BonusGlyphSpan key={i} tile={f} />
              ))}
            </span>
            {myShanten !== null && (
              <span className="play-shanten">{myShanten <= 0 ? (myShanten < 0 ? "Complete" : "Ready (聽)") : `${myShanten} from ready`}</span>
            )}
            <span className="play-actions">
              {canSelfDraw && (
                <button type="button" className="play-action is-win" onClick={() => doTurn({ kind: "selfDraw" })}>
                  自摸
                </button>
              )}
              {myKongs.map((k) => (
                <button key={`${k.kind}${tileKey(k.tile)}`} type="button" className="play-action" onClick={() => doTurn(k)}>
                  槓 <TileGlyphSpan tile={k.tile} />
                </button>
              ))}
              {humanClaims.map((c, i) => (
                <button
                  key={i}
                  type="button"
                  className={`play-action${c.kind === "win" ? " is-win" : ""}`}
                  onClick={() => resolve(c)}
                >
                  {claimLabel(c)}
                  {c.kind === "chow" && (
                    <span className="play-action-tiles">
                      {c.tiles.map((t, j) => (
                        <TileGlyphSpan key={j} tile={t} />
                      ))}
                    </span>
                  )}
                </button>
              ))}
              {humanClaims.length > 0 && (
                <button type="button" className="play-action is-pass" onClick={() => resolve(null)}>
                  過
                </button>
              )}
            </span>
          </div>
          <div className={`play-hand${myTurn ? " is-turn" : ""}`}>
            {handTiles.map((t, i) => {
              const isDrawn = handView.drawnTile !== null && i === handTiles.length - 1;
              const isBest = bestDiscard !== null && sameTile(t, bestDiscard);
              return (
                <button
                  key={i}
                  type="button"
                  className={[
                    "play-hand-tile",
                    isDrawn && "is-drawn",
                    selected === i && "is-selected",
                    isBest && "is-hint",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  disabled={!myTurn}
                  onClick={() => tapTile(i)}
                  aria-label={selected === i ? `Discard ${tileLabel(t)}` : tileLabel(t)}
                >
                  <TileGlyphSpan tile={t} />
                </button>
              );
            })}
          </div>
          {myTurn && <div className="play-prompt">{selected === null ? "Tap a tile, then tap it again to discard" : "Tap again to discard"}</div>}
        </div>

        {result && (
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
                  {game.players[result.winner].flowers.map((f, i) => (
                    <BonusGlyphSpan key={i} tile={f} />
                  ))}
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
              <button type="button" className="play-next" onClick={() => advance(nextHand(game))}>
                Next hand
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
