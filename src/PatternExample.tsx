// One pattern's example hand - shared by the 設定 sheet (inside each
// expanded rule) and the printable rules reference. Examples come from
// lib/patternExamples.ts.

import { useMemo } from "react";
import { BonusGlyphSpan, TileGlyphSpan } from "./TileGlyphs";
import type { Tile } from "./lib/mahjong";
import { PATTERN_EXAMPLES } from "./lib/patternExamples";
import { DEFAULT_TAI_RULES, parseScoringHand, PATTERNS, scoreParsedHand, type GameContext, type TaiRules } from "./lib/scoring";
import { PATTERN_CATALOG } from "./lib/taiCatalog";
import { TEST_HAND_BASE_CONTEXT } from "./lib/testHands";

const WINDS = ["東", "南", "西", "北"];

// The situation an example sets, as 情況 shows it: 自摸, 叮 + 一發, 槓摸×2…
function situationChips(ctx: Partial<GameContext>): string[] {
  const chips: string[] = [];
  if (ctx.seatWind && ctx.seatWind !== 1) chips.push(`門風 ${WINDS[ctx.seatWind - 1]}`);
  if (ctx.roundWind && ctx.roundWind !== 1) chips.push(`圈風 ${WINDS[ctx.roundWind - 1]}`);
  if (ctx.dealerStreak) chips.push(ctx.dealerStreak === 1 ? "莊" : `莊 連${ctx.dealerStreak - 1}`);
  if (ctx.selfDraw) chips.push("自摸");
  if (ctx.riichi && ctx.riichi !== "none") chips.push({ riichi: "叮", "heavenly-riichi": "天叮", "earthly-riichi": "地叮" }[ctx.riichi]);
  if (ctx.instantWin) chips.push("一發");
  if (ctx.eatRiichi) chips.push("食叮");
  if (ctx.earlyWin && ctx.earlyWin !== "none") chips.push({ four: "四子內", seven: "七子內", ten: "十子內" }[ctx.earlyWin]);
  if (ctx.multiWin && ctx.multiWin !== "none") chips.push(ctx.multiWin === "double" ? "雙響" : "三響");
  if (ctx.heavenlyWin && ctx.heavenlyWin !== "none") chips.push({ heaven: "天胡", earth: "地胡", man: "人胡" }[ctx.heavenlyWin]);
  if (ctx.lastTileWin && ctx.lastTileWin !== "none") chips.push(ctx.lastTileWin === "river-bottom" ? "河底撈魚" : "海底撈月");
  if (ctx.flowerDraw) chips.push(`花摸×${ctx.flowerDraw}`);
  if (ctx.kongDraw) chips.push(`槓摸×${ctx.kongDraw}`);
  if (ctx.robKong) chips.push(`搶槓×${ctx.robKong}`);
  if (ctx.manualVisibleExhaustedMultiWait) chips.push("絕絕");
  else if (ctx.manualVisibleTripleWin) chips.push("明絕");
  return chips;
}

// The example's rules: the house list (正圈風 at 2, since at 0 it never
// counts), so the hand reads the way the tests score it.
const EXAMPLE_RULES: TaiRules = (() => {
  const rules = structuredClone(DEFAULT_TAI_RULES);
  rules.patterns["correct-round-wind"].tai = 2;
  return rules;
})();

// One pattern's example, in the expanded rule: the tiles it's about where it
// points at particular melds (三元牌, 般高…), the whole hand where it's about
// the hand's shape (清一色, 平胡, 十三么…), and just the situation where it's
// something declared rather than in the tiles (自摸, 叮, 莊…). Then what it's
// worth there under the set being edited.
export function PatternExampleView({ id, rules }: { id: string; rules: TaiRules }) {
  const example = PATTERN_EXAMPLES[id];
  const scored = useMemo(() => {
    if (!example) return null;
    try {
      const parsed = { ...parseScoringHand(example.hand), bonusTiles: example.bonus ?? [] };
      const ctx: GameContext = { ...TEST_HAND_BASE_CONTEXT, ...example.ctx };
      const result = scoreParsedHand(parsed, { ...ctx, rules: EXAMPLE_RULES });
      const reading = result.matched.some((m) => m.pattern.id === id) || !result.second ? result : { ...result, ...result.second };
      return { ctx, hand: reading.hand, declared: parsed.declaredMelds.length };
    } catch {
      return null;
    }
  }, [example, id]);
  // What it's worth on the example under the set being edited.
  const worth = useMemo(() => {
    if (!example) return null;
    try {
      const parsed = { ...parseScoringHand(example.hand), bonusTiles: example.bonus ?? [] };
      const result = scoreParsedHand(parsed, { ...TEST_HAND_BASE_CONTEXT, ...example.ctx, rules });
      return [...result.matched, ...(result.second?.matched ?? [])].find((m) => m.pattern.id === id)?.tai ?? 0;
    } catch {
      return null;
    }
  }, [example, id, rules]);
  if (!example || !scored) return null;

  const pattern = PATTERNS.find((p) => p.id === id)!;
  const family = PATTERN_CATALOG[id].family;
  const situation = family === "situation";
  // 正花/爛花/無花 are about the flowers and seasons (and the seat wind they
  // match), not the hand.
  const bonusOnly = family === "bonus";
  const rows = situation || bonusOnly ? null : pattern.tiles?.(scored.hand, scored.ctx);
  // Wind and flower patterns compare against the winds, so always show them.
  const winds = family === "winds" || bonusOnly ? [`門風 ${WINDS[scored.ctx.seatWind - 1]}`, ...(id === "correct-round-wind" ? [`圈風 ${WINDS[scored.ctx.roundWind - 1]}`] : [])] : [];
  const isWindChip = (c: string) => c.startsWith("門風") || c.startsWith("圈風");
  const chips = [...winds, ...situationChips(example.ctx ?? {}).filter((c) => winds.length === 0 || !isWindChip(c))];
  const winning = scored.ctx.winningTile;
  // The 食胡 tile, highlighted once - its first copy among the tiles shown.
  let winningShown = false;
  const isWinning = (t: Tile) => {
    if (winningShown || !winning || t.suit !== winning.suit || t.rank !== winning.rank) return false;
    winningShown = true;
    return true;
  };
  const group = (tiles: Tile[], key: number, declared = false) => (
    <span key={key} className={`breakdown-group${declared ? " tr-example-declared" : ""}`}>
      {tiles.map((t, k) => (
        <TileGlyphSpan key={k} tile={t} highlight={!declared && isWinning(t)} />
      ))}
    </span>
  );

  return (
    <div className="tr-detail tr-example">
      <div className="tr-detail-label">
        Example · {situation ? "declared, on any winning hand" : bonusOnly ? "the flowers and seasons" : rows && rows.length > 0 ? "the tiles it counts" : "the whole hand"}
      </div>
      {bonusOnly && (
        <div className="breakdown-groups tr-example-tiles">
          {scored.hand.bonusTiles.length === 0 ? (
            <span className="tr-none">No flowers or seasons</span>
          ) : (
            scored.hand.bonusTiles.map((b, i) => (
              <span key={i} className="breakdown-group">
                <BonusGlyphSpan tile={b} />
              </span>
            ))
          )}
        </div>
      )}
      {!situation &&
        !bonusOnly &&
        (rows && rows.length > 0 ? (
          rows.map((row, i) => (
            <div key={i} className="breakdown-groups tr-example-tiles">
              {row.map((tiles, j) => group(tiles, j))}
            </div>
          ))
        ) : (
          <div className="breakdown-groups tr-example-tiles">
            {scored.hand.melds.map((m, i) => group(m.tiles, i, i < scored.declared))}
            {group(scored.hand.pair, scored.hand.melds.length)}
            {scored.hand.bonusTiles.map((b, i) => (
              <span key={`b${i}`} className="breakdown-group">
                <BonusGlyphSpan tile={b} />
              </span>
            ))}
          </div>
        ))}
      {situation && scored.hand.bonusTiles.length > 0 && (
        <div className="breakdown-groups tr-example-tiles">
          {scored.hand.bonusTiles.map((b, i) => (
            <span key={i} className="breakdown-group">
              <BonusGlyphSpan tile={b} />
            </span>
          ))}
        </div>
      )}
      {(chips.length > 0 || winning) && (
        <div className="tr-chips">
          {winning && (
            <span className="tr-chip is-static tr-example-chip">
              食 <TileGlyphSpan tile={winning} />
            </span>
          )}
          {chips.map((c) => (
            <span key={c} className="tr-chip is-static tr-example-chip">
              {c}
            </span>
          ))}
        </div>
      )}
      <div className="tr-example-worth">
        {worth === null ? null : worth > 0 ? (
          <>
            Worth <strong>{worth}</strong> tai here
          </>
        ) : (
          "Doesn't count here under this set"
        )}
      </div>
    </div>
  );
}
