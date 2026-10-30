// The Play tab's start screen: what you see before the table - the title
// over a fan of tiles, and the ways in: carry on with the game you left,
// start a new one against the bots, or play online. Your record and the
// sound switch sit underneath. Held upright, it's drawn turned a quarter
// like the table itself, so you never turn the phone between the two.

import { useState } from "react";
import type { Tile } from "@mjwaits/shared/engine/mahjong";
import { TileGlyphSpan } from "./TileGlyphs";
import { RecordSheet } from "./PlayRecord";
import { loadRecord } from "./lib/playRecord";
import { isMuted, setMuted, wakeAudio } from "./lib/sound";
import type { SavedSummary } from "./lib/playSaved";

// 發 中 白, fanned.
const HERO: Tile[] = [
  { suit: "z", rank: 6 },
  { suit: "z", rank: 5 },
  { suit: "z", rank: 7 },
];

const signed = (n: number) => (n > 0 ? `+${n}` : String(n));

export function PlayHome({
  saved,
  onPlay,
  onOnline,
  onExit,
  edition,
}: {
  saved: SavedSummary | null;
  onPlay: (fresh: boolean) => void;
  onOnline: () => void;
  onExit: () => void;
  // Which table this opens, when it isn't Play's own ("Play 2.0").
  edition?: string;
}) {
  const [record, setRecord] = useState(loadRecord);
  const [recordOpen, setRecordOpen] = useState(false);
  const [soundOff, setSoundOff] = useState(isMuted);
  // A new game ends the one in progress: the first tap asks.
  const [confirmNew, setConfirmNew] = useState(false);

  return (
    <div className="play-screen ph-screen">
      <div className="ph-stage">
        <div className="ph-glow" aria-hidden="true" />
        <button type="button" className="play-icon-button ph-back" onClick={onExit} aria-label="Leave Play">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <path d="M15 5l-7 7 7 7" />
          </svg>
        </button>

        <div className="ph-hero">
          <div className="ph-tiles" aria-hidden="true">
            {HERO.map((t, i) => (
              <span key={i} className={`ph-tile is-${i}`}>
                <TileGlyphSpan tile={t} />
              </span>
            ))}
          </div>
          <h1 className="ph-title">
            <span className="ph-title-zh">麻雀</span>
            <span className="ph-title-en">MJWaits</span>
          </h1>
          <p className="ph-tagline">港式台灣牌 · 十六張{edition && ` · ${edition}`}</p>
        </div>

        <nav className="ph-menu" aria-label="Play">
          {saved && (
            <button type="button" className="ph-item is-primary" onClick={() => onPlay(false)}>
              <span className="ph-item-zh">繼續</span>
              <span className="ph-item-text">
                <strong>Continue</strong>
                <small>
                  {saved.round} · You {signed(saved.you)}
                </small>
              </span>
              <Chevron />
            </button>
          )}
          <button
            type="button"
            className={`ph-item${saved ? "" : " is-primary"}${confirmNew ? " is-armed" : ""}`}
            onClick={() => (saved && !confirmNew ? setConfirmNew(true) : onPlay(true))}
            onBlur={() => setConfirmNew(false)}
          >
            <span className="ph-item-zh">開局</span>
            <span className="ph-item-text">
              <strong>{confirmNew ? "Tap again to start over" : "New game"}</strong>
              <small>{confirmNew ? "The game in progress ends" : "You against three bots"}</small>
            </span>
            <Chevron />
          </button>
          <button type="button" className="ph-item" onClick={onOnline}>
            <span className="ph-item-zh">線上</span>
            <span className="ph-item-text">
              <strong>Play online</strong>
              <small>Friends on their own phones, or bots</small>
            </span>
            <Chevron />
          </button>

          <div className="ph-minor">
            <button type="button" className="ph-chip" onClick={() => setRecordOpen(true)}>
              <span>我的紀錄</span>
              <small>{record.hands ? `${record.wins} wins / ${record.hands}` : "No hands yet"}</small>
            </button>
            <button
              type="button"
              className="ph-chip"
              aria-pressed={!soundOff}
              onClick={() => {
                setMuted(!soundOff);
                setSoundOff(!soundOff);
                if (soundOff) wakeAudio();
              }}
            >
              <span>音效</span>
              <small>Sound {soundOff ? "off" : "on"}</small>
            </button>
          </div>
        </nav>

        {recordOpen && <RecordSheet record={record} onReset={setRecord} onClose={() => setRecordOpen(false)} />}
      </div>
    </div>
  );
}

function Chevron() {
  return (
    <svg className="ph-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
      <path d="M9 5l7 7-7 7" />
    </svg>
  );
}
