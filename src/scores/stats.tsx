// Scores tab: 統計 - the trend chart, the 局 sheet, player cards, patterns,
// past games and backups.

import { Fragment, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { exportScores, mergeScores, parseBackup, replay, replayCached, type HandResult, type ReplayState, type ScoreGame, type ScoreStore, playTimes } from "@mjwaits/shared/engine/ledger";
import { sheetCsv, sheetRows, type SheetRow } from "../lib/scoreViews";
import { careerPlayerStats, careerStats, careerTrend, smoothed, periodKey, periodLabel, periodsOf, type Period, headToHead, marks, patternCounts, playerStats, rankedBy, RECENT_HANDS, trend, trendSummary, type PlayerStats, type Swing } from "../lib/scoreStats";
import { fmt, signed, pct, tone, colorOf, Icons, SectionHead, Monogram, Sheet, Segmented, Sparkline } from "./shared";

// ---- 統計 ------------------------------------------------------------------------

// A line per player over the hands of one game - or any other series
// (`data`, e.g. the 生涯 trend over every game), each point named by labelOf.
// smooth: lines drawn averaged over that many points (the numbers on touch
// stay the real ones); marks: faint lines at those points (where games start).
export function TrendChart({
  store,
  state,
  data,
  labelOf,
  smooth = 1,
  marks = [],
}: {
  store: ScoreStore;
  state?: ReplayState;
  data?: { hands: number; series: { player: string; values: (number | null)[] }[] };
  labelOf?: (i: number) => string;
  smooth?: number;
  marks?: number[];
}) {
  const { hands, series: raw } = data ?? trend(state!);
  const series = useMemo(() => raw.map((s) => ({ ...s, values: smoothed(s.values, smooth) })), [raw, smooth]);
  const rawOf = new Map(raw.map((s) => [s.player, s.values]));
  const [hover, setHover] = useState<number | null>(null);
  // Drawn at the container's real width, so text keeps its pixel size.
  const [box, setBox] = useState<HTMLDivElement | null>(null);
  const [W, setW] = useState(640);
  useEffect(() => {
    if (!box) return;
    const observer = new ResizeObserver(([entry]) => setW(Math.max(260, Math.round(entry.contentRect.width))));
    observer.observe(box);
    return () => observer.disconnect();
  }, [box]);
  if (hands === 0) return <p className="sc-empty">No hands yet.</p>;
  const H = Math.round(Math.min(320, Math.max(220, W * 0.62)));
  const pad = { l: 40, r: 56, t: 12, b: 26 };
  const all = series.flatMap((s) => s.values.filter((v): v is number => v !== null));
  const lo = Math.min(0, ...all);
  const hi = Math.max(0, ...all);
  const step = niceStep((hi - lo || 1) / 4);
  const yTicks: number[] = [];
  for (let v = Math.floor(lo / step) * step; v <= Math.ceil(hi / step) * step + 1e-9; v += step) yTicks.push(v);
  const yMin = Math.min(lo, yTicks[0]);
  const yMax = Math.max(hi, yTicks[yTicks.length - 1]);
  const x = (i: number) => pad.l + (i / Math.max(1, hands)) * (W - pad.l - pad.r);
  const y = (v: number) => pad.t + (1 - (v - yMin) / (yMax - yMin || 1)) * (H - pad.t - pad.b);
  const xStep = niceStep(hands / 5) || 1;
  const xTicks: number[] = [];
  for (let i = 0; i <= hands; i += xStep) xTicks.push(i);
  const path = (values: (number | null)[]) =>
    values.reduce((d, v, i) => (v === null ? d : `${d}${d === "" || values[i - 1] === null ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`), "");
  // Direct labels at each line's end, nudged apart so they don't overlap.
  const ends = series
    .map((s) => {
      const lastIdx = s.values.reduce<number>((a, v, i) => (v !== null ? i : a), -1);
      return { s, lastIdx, v: lastIdx >= 0 ? (s.values[lastIdx] as number) : 0 };
    })
    .filter((e) => e.lastIdx >= 0)
    .sort((a, b) => y(a.v) - y(b.v));
  let prevY = -Infinity;
  const labelYs = ends.map((e) => {
    const yy = Math.max(y(e.v), prevY + 14);
    prevY = yy;
    return yy;
  });

  const onMove = (e: ReactPointerEvent<SVGRectElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * (W - pad.l - pad.r);
    setHover(Math.max(0, Math.min(hands, Math.round((px / (W - pad.l - pad.r)) * hands))));
  };

  return (
    <div className="sc-chart" ref={setBox}>
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" aria-label={`Running totals over ${hands} hands`}>
        {yTicks.map((v) => (
          <g key={v}>
            <line x1={pad.l} x2={W - pad.r} y1={y(v)} y2={y(v)} className={v === 0 ? "sc-axis-zero" : "sc-grid"} />
            <text x={pad.l - 8} y={y(v)} className="sc-tick" textAnchor="end" dominantBaseline="middle">
              {fmt(v)}
            </text>
          </g>
        ))}
        {xTicks.map((i) => (
          <text key={i} x={x(i)} y={H - 8} className="sc-tick" textAnchor="middle">
            {i}
          </text>
        ))}
        {marks.map((i) => (
          <line key={`m${i}`} x1={x(i)} x2={x(i)} y1={pad.t} y2={H - pad.b} className="sc-grid sc-game-mark" />
        ))}
        {series.map((s) => (
          <path key={s.player} d={path(s.values)} className={`sc-line sc-c${colorOf(store, s.player)}`} />
        ))}
        {ends.map((e, k) => (
          <text key={e.s.player} x={x(e.lastIdx) + 6} y={labelYs[k]} className="sc-end-label" dominantBaseline="middle">
            {e.s.player}
          </text>
        ))}
        {hover !== null && (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={H - pad.b} className="sc-crosshair" />
            {series.map((s) =>
              s.values[hover] !== null && s.values[hover] !== undefined ? <circle key={s.player} cx={x(hover)} cy={y(s.values[hover] as number)} r={4.5} className={`sc-marker sc-c${colorOf(store, s.player)}`} /> : null
            )}
          </g>
        )}
        <rect x={pad.l} y={0} width={W - pad.l - pad.r} height={H} fill="transparent" onPointerMove={onMove} onPointerDown={onMove} onPointerLeave={() => setHover(null)} />
      </svg>
      {hover !== null && (
        <div className={`sc-tooltip${x(hover) > W * 0.6 ? " is-left" : ""}`} style={{ left: x(hover) }}>
          <strong>{labelOf ? labelOf(hover) : hover === 0 ? "Start" : `第${hover}局`}</strong>
          {raw
            .filter((s) => s.values[hover] !== null && s.values[hover] !== undefined)
            .sort((a, b) => (b.values[hover] as number) - (a.values[hover] as number))
            .map((s) => (
              <span key={s.player}>
                <span className={`sc-dot sc-c${colorOf(store, s.player)}`} />
                {s.player}
                <span className="sc-num">{fmt(rawOf.get(s.player)![hover] as number)}</span>
              </span>
            ))}
        </div>
      )}
    </div>
  );
}

export function niceStep(raw: number): number {
  if (raw <= 0) return 1;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const n = raw / mag;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * mag;
}

// sub: a muted line under the value - which 局 a record came from.
export type StatRow = { key: keyof PlayerStats; zh: string; en: string; show: (s: PlayerStats) => string; sub?: (s: PlayerStats) => string | null; tone?: (s: PlayerStats) => number };

// Which hand a stat happened on, and how many times a chain record was hit.
// Across games (career) a record also names its game, by the day.
export const handOf = (h: { hand: number; when?: string } | null) => (h ? `${h.when ? `${h.when} ` : ""}第${h.hand}局` : null);
// A swing's span: 3→9局, or 開局→9局 from the start; across games, by day.
export const spanOf = (w: Swing | null) =>
  !w ? null : w.toWhen ? (w.fromWhen === w.toWhen ? `${w.toWhen} ${w.from}→${w.to}局` : `${w.fromWhen ?? "開局"}→${w.toWhen}`) : `${w.from === 0 ? "開局" : w.from}→${w.to}局`;
export const chain = (c: { count: number; times: number } | null) => (c ? `${c.count}${c.times > 1 ? ` ×${c.times}` : ""}` : "–");
export const oneDp = (n: number | null) => (n === null ? "–" : fmt(Math.round(n * 10) / 10));
export const signedDp = (n: number | null) => (n === null ? "–" : signed(Math.round(n * 10) / 10));

// Cantonese for each stat, a few words of English under it.
export const STAT_GROUPS: { zh: string; en: string; rows: StatRow[] }[] = [
  {
    zh: "戰績",
    en: "Record",
    rows: [
      { key: "wins", zh: "食糊", en: "Off a discard", show: (s) => String(s.wins) },
      { key: "selfDraws", zh: "自摸", en: "Self-drawn", show: (s) => String(s.selfDraws) },
      { key: "dealIns", zh: "出銃", en: "Dealt in", show: (s) => String(s.dealIns) },
      { key: "assists", zh: "被自摸", en: "Paid others' 自摸", show: (s) => String(s.assists) },
      { key: "multiWins", zh: "多響", en: "Won in a 雙響 / 三響", show: (s) => String(s.multiWins) },
      { key: "winStreak", zh: "連勝", en: "Most wins in a row", show: (s) => String(s.winStreak) },
    ],
  },
  {
    zh: "效率",
    en: "Rates",
    rows: [
      { key: "winRate", zh: "食糊率", en: "Hands won", show: (s) => pct(s.winRate) },
      { key: "dealInRate", zh: "出銃率", en: "Hands dealt in", show: (s) => pct(s.dealInRate) },
      { key: "selfDrawShare", zh: "自摸比例", en: "Wins by 自摸", show: (s) => pct(s.selfDrawShare) },
      { key: "assistRate", zh: "被自摸率", en: "Paid others' 自摸", show: (s) => pct(s.assistRate) },
      { key: "firstRate", zh: "領先", en: "Time in 1st", show: (s) => pct(s.firstRate) },
      { key: "positiveRate", zh: "正數", en: "Time above 0", show: (s) => pct(s.positiveRate) },
    ],
  },
  {
    zh: "走勢",
    en: "Trend",
    rows: [
      { key: "peak", zh: "最高位", en: "Highest total", show: (s) => (s.peak ? signed(s.peak.value) : "–"), sub: (s) => handOf(s.peak), tone: (s) => s.peak?.value ?? 0 },
      { key: "trough", zh: "最低位", en: "Lowest total", show: (s) => (s.trough ? signed(s.trough.value) : "–"), sub: (s) => handOf(s.trough), tone: (s) => s.trough?.value ?? 0 },
      { key: "maxDrawdown", zh: "最大回落", en: "Biggest drop", show: (s) => (s.maxDrawdown ? signed(s.maxDrawdown.value) : "–"), sub: (s) => spanOf(s.maxDrawdown), tone: (s) => s.maxDrawdown?.value ?? 0 },
      { key: "maxRunUp", zh: "最大升幅", en: "Biggest climb", show: (s) => (s.maxRunUp ? signed(s.maxRunUp.value) : "–"), sub: (s) => spanOf(s.maxRunUp), tone: (s) => s.maxRunUp?.value ?? 0 },
      { key: "recovery", zh: "谷底反彈", en: "Back from the low", show: (s) => signed(s.recovery), tone: (s) => s.recovery },
      { key: "recent", zh: `近${RECENT_HANDS}局`, en: `Last ${RECENT_HANDS} hands`, show: (s) => signed(s.recent.net), tone: (s) => s.recent.net },
      { key: "longestLosingRun", zh: "最長連跌", en: "Losing run", show: (s) => String(s.longestLosingRun) },
      { key: "avgSwing", zh: "平均波幅", en: "Swing per hand", show: (s) => oneDp(s.avgSwing) },
    ],
  },
  {
    zh: "得失",
    en: "Points",
    rows: [
      { key: "avgWinGain", zh: "每次食糊", en: "Won per win", show: (s) => signedDp(s.avgWinGain), tone: (s) => s.avgWinGain ?? 0 },
      { key: "avgDealInLoss", zh: "每次出銃", en: "Lost per deal-in", show: (s) => signedDp(s.avgDealInLoss), tone: (s) => s.avgDealInLoss ?? 0 },
      { key: "bestHand", zh: "最大一舖", en: "Best hand", show: (s) => (s.bestHand ? signed(s.bestHand.value) : "–"), sub: (s) => handOf(s.bestHand), tone: () => 1 },
      { key: "worstHand", zh: "最傷一舖", en: "Worst hand", show: (s) => (s.worstHand ? fmt(s.worstHand.value) : "–"), sub: (s) => handOf(s.worstHand), tone: () => -1 },
      { key: "selfDrawGain", zh: "自摸贏", en: "Won by 自摸", show: (s) => signed(s.selfDrawGain), tone: (s) => s.selfDrawGain },
      { key: "discardGain", zh: "食糊贏", en: "Won off discards", show: (s) => signed(s.discardGain), tone: (s) => s.discardGain },
      { key: "discardLoss", zh: "出銃輸", en: "Lost dealing in", show: (s) => fmt(s.discardLoss), tone: (s) => s.discardLoss },
      { key: "selfDrawLoss", zh: "被自摸輸", en: "Paid on others' 自摸", show: (s) => fmt(s.selfDrawLoss), tone: (s) => s.selfDrawLoss },
      { key: "bonus", zh: "獎罰", en: "Bonuses and 詐胡", show: (s) => signed(s.bonus), tone: (s) => s.bonus },
      { key: "jackpot", zh: "彩池", en: "Jackpot won", show: (s) => fmt(s.jackpot) },
    ],
  },
  {
    zh: "番數",
    en: "Tai",
    rows: [
      { key: "maxTai", zh: "最高番", en: "Biggest hand", show: (s) => (s.maxTai ? fmt(s.maxTai.value) : "–"), sub: (s) => handOf(s.maxTai) },
      { key: "avgWinTai", zh: "平均食糊番", en: "Avg tai per win", show: (s) => oneDp(s.avgWinTai) },
      { key: "avgDealInTai", zh: "平均出銃番", en: "Avg tai dealt in", show: (s) => oneDp(s.avgDealInTai) },
    ],
  },
  {
    zh: "做莊",
    en: "As dealer",
    rows: [
      { key: "dealerHands", zh: "做莊局數", en: "Hands dealt", show: (s) => String(s.dealerHands) },
      { key: "dealerNet", zh: "莊家得失", en: "Net as dealer", show: (s) => signed(s.dealerNet), tone: (s) => s.dealerNet },
      { key: "longestDealerRun", zh: "最長連莊", en: "Most 連莊 in a run", show: (s) => (s.longestDealerRun > 1 ? `連${s.longestDealerRun - 1}` : "–") },
    ],
  },
  {
    zh: "拉踢",
    en: "Pull & kick",
    rows: [
      { key: "lahNet", zh: "拉踢淨額", en: "Net from add-ons", show: (s) => signed(s.lahNet), tone: (s) => s.lahNet },
      { key: "maxPull", zh: "最長拉", en: "Longest 拉 held", show: (s) => chain(s.maxPull) },
      { key: "pulls", zh: "拉人", en: "拉 on others", show: (s) => String(s.pulls) },
      { key: "pulled", zh: "被拉", en: "拉'd by others", show: (s) => String(s.pulled) },
      { key: "kicks", zh: "踢人", en: "踢 others", show: (s) => String(s.kicks) },
      { key: "kicked", zh: "被踢", en: "踢'd by others", show: (s) => String(s.kicked) },
      { key: "fanXue", zh: "反雪", en: "Paid back after a 雙響", show: (s) => String(s.fanXue) },
    ],
  },
];

// Where a player's points came from and went: gains to the right of the
// middle, losses to the left, each split by how.
export function PointsBar({ s }: { s: PlayerStats }) {
  const gains = [
    { label: "自摸", value: s.selfDrawGain, cls: "is-g1" },
    { label: "食糊", value: s.discardGain, cls: "is-g2" },
    { label: "獎罰", value: Math.max(0, s.bonus), cls: "is-g3" },
  ].filter((x) => x.value > 0);
  const losses = [
    { label: "出銃", value: -s.discardLoss, cls: "is-l1" },
    { label: "被自摸", value: -s.selfDrawLoss, cls: "is-l2" },
    { label: "獎罰", value: Math.max(0, -s.bonus), cls: "is-l3" },
  ].filter((x) => x.value > 0);
  const gain = gains.reduce((t, x) => t + x.value, 0);
  const loss = losses.reduce((t, x) => t + x.value, 0);
  const scale = Math.max(gain, loss, 1);
  if (gain === 0 && loss === 0) return null;
  return (
    <div className="sc-pointsbar">
      <div className="sc-pointsbar-track" role="img" aria-label={`Won ${fmt(gain)}, lost ${fmt(loss)}`}>
        <div className="sc-pointsbar-half is-loss">
          {losses.map((x) => (
            <span key={x.label} className={x.cls} style={{ width: `${(x.value / scale) * 100}%` }} />
          ))}
        </div>
        <div className="sc-pointsbar-half is-gain">
          {gains.map((x) => (
            <span key={x.label} className={x.cls} style={{ width: `${(x.value / scale) * 100}%` }} />
          ))}
        </div>
      </div>
      <div className="sc-pointsbar-legend">
        <span className="is-neg">
          {losses.map((x) => (
            <span key={x.label}>
              <i className={x.cls} />
              {x.label} {fmt(x.value)}
            </span>
          ))}
        </span>
        <span className="is-pos">
          {gains.map((x) => (
            <span key={x.label}>
              <i className={x.cls} />
              {x.label} {fmt(x.value)}
            </span>
          ))}
        </span>
      </div>
    </div>
  );
}

// 重點: the few things worth knowing about a player's game, said in a line
// each - Cantonese, with the English under it. Only what has something to say.
export function insights(s: PlayerStats): { zh: string; en: string; tone?: number }[] {
  const out: { zh: string; en: string; tone?: number }[] = [];
  const share = (n: number, of: number) => `${Math.round((n / of) * 100)}%`;
  const sources = [
    { zh: "自摸", en: "self-draws", v: s.selfDrawGain },
    { zh: "食糊", en: "wins off discards", v: s.discardGain },
    { zh: "獎罰", en: "bonuses", v: Math.max(0, s.bonus) },
  ];
  const won = sources.reduce((t, x) => t + x.v, 0);
  const top = sources.slice().sort((a, b) => b.v - a.v)[0];
  if (won > 0 && top.v > 0) out.push({ zh: `主要靠${top.zh}贏分（${share(top.v, won)}）`, en: `Most points won by ${top.en} (${share(top.v, won)})` });
  // 走勢: a comeback from below 0, else a deep fall; then current form.
  if (s.trough && s.trough.value < 0 && s.net > 0)
    out.push({ zh: `由 ${signed(s.trough.value)} 反彈到 ${signed(s.net)}`, en: `Came back from ${signed(s.trough.value)} to ${signed(s.net)}`, tone: 1 });
  else if (s.maxDrawdown && s.avgSwing && -s.maxDrawdown.value >= 3 * s.avgSwing)
    out.push({ zh: `最大回落 ${signed(s.maxDrawdown.value)}（${spanOf(s.maxDrawdown)}）`, en: `Biggest drop: ${signed(s.maxDrawdown.value)}`, tone: -1 });
  if (s.recent.hands >= 4 && s.recent.net !== 0)
    out.push({
      zh: `近${s.recent.hands}局 ${signed(s.recent.net)}${s.recent.net > 0 ? "，手風順" : "，手風唔順"}`,
      en: `Last ${s.recent.hands} hands: ${signed(s.recent.net)} - ${s.recent.net > 0 ? "on form" : "off form"}`,
      tone: s.recent.net,
    });
  if (s.dealIns > 0 && s.avgDealInLoss !== null)
    out.push({
      zh: `出銃 ${s.dealIns} 次，平均每次輸 ${oneDp(-s.avgDealInLoss)}`,
      en: `Dealt in ${s.dealIns} time${s.dealIns === 1 ? "" : "s"}, losing ${oneDp(-s.avgDealInLoss)} each on average`,
      tone: -1,
    });
  const prey = s.opponents[0];
  const nemesis = s.opponents[s.opponents.length - 1];
  if (prey && prey.net > 0) out.push({ zh: `最大苦主：${prey.player}（${signed(prey.net)}）`, en: `Won the most from ${prey.player}`, tone: 1 });
  if (nemesis && nemesis.net < 0) out.push({ zh: `剋星：${nemesis.player}（${signed(nemesis.net)}）`, en: `Lost the most to ${nemesis.player}`, tone: -1 });
  if (s.dealerHands > 0)
    out.push({
      zh: `做莊 ${s.dealerHands} 局，${signed(s.dealerNet)}${s.longestDealerRun > 1 ? `，最長連${s.longestDealerRun - 1}` : ""}`,
      en: `As dealer: ${s.dealerHands} hand${s.dealerHands === 1 ? "" : "s"}, ${signed(s.dealerNet)}${s.longestDealerRun > 1 ? `, up to 連${s.longestDealerRun - 1}` : ""}`,
      tone: s.dealerNet,
    });
  if (s.lahNet !== 0) out.push({ zh: `拉踢淨${s.lahNet > 0 ? "賺" : "蝕"} ${fmt(Math.abs(s.lahNet))}`, en: `${s.lahNet > 0 ? "Made" : "Lost"} ${fmt(Math.abs(s.lahNet))} on 拉 / 踢 add-ons`, tone: s.lahNet });
  return out;
}

// One stat, everyone at the table on it: 1st to last whichever way is good
// for it, ties sharing a place, the player being looked at picked out.
export function StatRanking({ store, stats, row, player, onClose }: { store: ScoreStore; stats: PlayerStats[]; row: StatRow; player: string; onClose: () => void }) {
  const order = rankedBy(stats, row.key);
  const bySelf = new Map(stats.map((x) => [x.player, x]));
  const ranked = order.filter((x) => x.rank !== null);
  const first = ranked[0]?.rank;
  const last = ranked.at(-1)?.rank;
  const spread = first !== undefined && last !== undefined && first !== last;
  return (
    <Sheet title={row.zh} subtitle={`${row.en} · 全場排名 The table`} onClose={onClose}>
      <ol className="sc-ranking">
        {order.map(({ player: p, rank }) => {
          const x = bySelf.get(p)!;
          const t = row.tone?.(x);
          const mark = spread && rank === first ? "best" : spread && rank === last ? "worst" : null;
          return (
            <li key={p} className={p === player ? "is-me" : undefined}>
              <span className={`sc-leader-rank${rank !== null && rank <= 3 ? ` is-${rank}` : ""}`}>{rank ?? "–"}</span>
              <Monogram store={store} player={p} size="sm" />
              <span className="sc-ranking-name">
                {p}
                {mark && <span className={`sc-mark is-${mark}`}>{mark === "best" ? Icons.thumbUp : Icons.thumbDown}</span>}
              </span>
              <span className="sc-stat-value">
                <strong className={t !== undefined ? tone(t) : undefined}>{row.show(x)}</strong>
                {row.sub?.(x) && <small>{row.sub(x)}</small>}
              </span>
            </li>
          );
        })}
      </ol>
    </Sheet>
  );
}

// Under the 走勢 chart: the game's story in a line or three - how often the
// lead changed, who held it longest, and the biggest comeback.
export function TrendSummary({ state }: { state: ReplayState }) {
  const t = trendSummary(state);
  const lines: { zh: string; en: string }[] = [];
  if (state.hands.length > 1) lines.push({ zh: t.leadChanges === 0 ? "領先從未易手" : `領先易手 ${t.leadChanges} 次`, en: t.leadChanges === 0 ? "The lead never changed" : `The lead changed ${t.leadChanges} time${t.leadChanges === 1 ? "" : "s"}` });
  if (t.mostLed) lines.push({ zh: `${t.mostLed.player} 領先最耐（${t.mostLed.hands}局）`, en: `${t.mostLed.player} led for the most hands` });
  if (t.comeback && t.comeback.to > 0) lines.push({ zh: `最大逆轉：${t.comeback.player} 由 ${signed(t.comeback.from)} 追到 ${signed(t.comeback.to)}`, en: `Biggest comeback: ${t.comeback.player}` });
  if (lines.length === 0) return null;
  return (
    <ul className="sc-trend-summary">
      {lines.map((l) => (
        <li key={l.zh}>
          <span>{l.zh}</span>
          <small>{l.en}</small>
        </li>
      ))}
    </ul>
  );
}

// One player's stats - for a game, or a whole career (the same card, the
// same numbers): series is their running total, games how many they played
// (career only).
export function PlayerCard({
  store,
  stats,
  seriesOf,
  index,
  onIndex,
  games,
}: {
  store: ScoreStore;
  stats: PlayerStats[];
  seriesOf: (player: string) => (number | null)[] | undefined;
  index: number;
  onIndex: (i: number) => void;
  games?: number;
}) {
  const s = stats[index];
  const markFor = useMemo(() => Object.fromEntries(STAT_GROUPS.flatMap((g) => g.rows).map((r) => [r.key, marks(stats, r.key)])), [stats]);
  const values = seriesOf(s.player);
  const rank = stats.slice().sort((a, b) => b.net - a.net).findIndex((x) => x.player === s.player) + 1;
  const notes = insights(s);
  const oppMax = Math.max(1, ...s.opponents.map((o) => Math.abs(o.net)));
  // A stat tapped: everyone at the table ranked on it.
  const [ranking, setRanking] = useState<StatRow | null>(null);
  return (
    <div className="card sc-profile">
      <div className="sc-profile-head">
        <button type="button" className="sc-icon-button sc-icon-button-fill" onClick={() => onIndex((index - 1 + stats.length) % stats.length)} aria-label="Previous player">
          {Icons.back}
        </button>
        <div className="sc-profile-id">
          <Monogram store={store} player={s.player} size="lg" />
          <span className="sc-profile-name">{s.player}</span>
          <span className="sc-profile-sub">
            第{rank}名（{stats.length}人）· {games !== undefined ? `${games}場 · ` : ""}
            {s.hands}局
          </span>
        </div>
        <button type="button" className="sc-icon-button sc-icon-button-fill" onClick={() => onIndex((index + 1) % stats.length)} aria-label="Next player">
          {Icons.forward}
        </button>
      </div>
      <div className="sc-profile-score">
        <span className={`sc-profile-net ${tone(s.net)}`}>{signed(s.net)}</span>
        {values && <Sparkline values={values} className={`sc-c${colorOf(store, s.player)}`} />}
      </div>
      {/* 胡 here is every win, 自摸 included - 戰績 below splits them. */}
      <div className="sc-kpis">
        <span>
          <strong>{s.wins + s.selfDraws}</strong>
          胡<small>Wins</small>
        </span>
        <span>
          <strong>{s.selfDraws}</strong>
          摸<small>Self-draws</small>
        </span>
        <span>
          <strong>{s.dealIns}</strong>
          銃<small>Deal-ins</small>
        </span>
        <span>
          <strong className={tone(s.perHand ?? 0)}>{signedDp(s.perHand)}</strong>
          每局<small>Per hand</small>
        </span>
      </div>
      <PointsBar s={s} />
      {notes.length > 0 && (
        <div className="sc-insights">
          <div className="sc-stat-title">
            重點 <small>Highlights</small>
          </div>
          <ul>
            {notes.map((n) => (
              <li key={n.zh} className={n.tone === undefined || n.tone === 0 ? undefined : n.tone > 0 ? "is-up" : "is-down"}>
                <span>{n.zh}</span>
                <small>{n.en}</small>
              </li>
            ))}
          </ul>
        </div>
      )}
      {/* The first two groups open; the rest fold away until wanted. */}
      {STAT_GROUPS.map((g, gi) => (
        <details key={g.zh} className="sc-stat-group" open={gi < 2}>
          <summary className="sc-stat-title">
            {g.zh} <small>{g.en}</small>
          </summary>
          <div className="sc-stat-grid">
            {g.rows.map((r) => {
              const m = markFor[r.key]?.get(s.player);
              const t = r.tone?.(s);
              return (
                <button key={r.key} type="button" className="sc-stat" onClick={() => setRanking(r)} aria-label={`${r.zh} ${r.en}: ${r.show(s)} - see everyone`}>
                  <span className="sc-stat-label">
                    <span>
                      {r.zh}
                      {m && (
                        <span className={`sc-mark is-${m}`} title={m === "best" ? "Best at the table" : "Lowest at the table"}>
                          {m === "best" ? Icons.thumbUp : Icons.thumbDown}
                        </span>
                      )}
                    </span>
                    <small>{r.en}</small>
                  </span>
                  <span className="sc-stat-value">
                    <strong className={t !== undefined ? tone(t) : undefined}>{r.show(s)}</strong>
                    {r.sub?.(s) && <small>{r.sub(s)}</small>}
                  </span>
                </button>
              );
            })}
          </div>
        </details>
      ))}
      {s.opponents.length > 0 && (
        <details className="sc-stat-group">
          <summary className="sc-stat-title">
            對手 <small>Against each player</small>
          </summary>
          <ul className="sc-opponents">
            {s.opponents.map((o) => (
              <li key={o.player}>
                <span className="sc-opponent-name">
                  <span className={`sc-dot sc-c${colorOf(store, o.player)}`} aria-hidden="true" />
                  {o.player}
                </span>
                <span className="sc-opponent-bar" aria-hidden="true">
                  <span className={o.net > 0 ? "is-pos" : "is-neg"} style={{ width: `${(Math.abs(o.net) / oppMax) * 50}%` }} />
                </span>
                <strong className={tone(o.net)}>{signed(o.net)}</strong>
              </li>
            ))}
          </ul>
        </details>
      )}
      {ranking && <StatRanking store={store} stats={stats} row={ranking} player={s.player} onClose={() => setRanking(null)} />}
      <p className="sc-help sc-stat-key">撳任何一項睇全場排名 · Tap a stat to see everyone<br />
        <span className="sc-mark is-best">{Icons.thumbUp}</span> 全場最好 · <span className="sc-mark is-worst">{Icons.thumbDown}</span> 全場最差 - best and lowest at the table
      </p>
    </div>
  );
}

export type StatsView = "trend" | "hands" | "player" | "patterns" | "history";

// 備份: the whole store as a file to keep, and a file to bring back - for a
// new phone, or if an update ever loses something.
export const BACKED_UP_KEY = "mjwaits.scoresBackedUpAt";

export function readBackedUpAt(): number | null {
  try {
    const n = Number(window.localStorage.getItem(BACKED_UP_KEY));
    return n > 0 ? n : null;
  } catch {
    return null;
  }
}

// The 局 sheet as a CSV file, as it's showing (Detailed or Simple), named for the game (or the day it started). A
// byte-order mark first, so spreadsheet apps read the Chinese right.
function saveSheetCsv(game: ScoreGame, state: ReplayState, players: string[], merge: boolean) {
  const blob = new Blob(["\uFEFF" + sheetCsv(game, state, players, merge)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const d = new Date(game.startedAt);
  const pad = (n: number) => String(n).padStart(2, "0");
  const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const name = game.name?.trim().replace(/[\\/:*?"<>|]+/g, "-");
  a.href = url;
  a.download = `mjwaits-${name ? `${name}-` : ""}${day}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Save the whole store as a dated file, and note when - for the reminders.
export function saveBackupFile(store: ScoreStore): number {
  const now = Date.now();
  const blob = new Blob([exportScores(store, now)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const d = new Date(now);
  const pad = (n: number) => String(n).padStart(2, "0");
  a.href = url;
  a.download = `mjwaits-scores-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  try {
    window.localStorage.setItem(BACKED_UP_KEY, String(now));
  } catch {
    // Just the reminder - the file is saved either way.
  }
  return now;
}

// Hands recorded since the last backup file (all of them, if never).
export const handsSinceBackup = (game: ScoreGame, backedUpAt: number | null) =>
  game.events.filter((ev) => (ev.t === "win" || ev.t === "draw") && (backedUpAt === null || ev.at > backedUpAt)).length;

// The board's nudge comes every this many hands without a backup.
export const BACKUP_NUDGE_HANDS = 16;

export function BackupCard({ store, setStore }: { store: ScoreStore; setStore: (s: ScoreStore) => void }) {
  const [backedUpAt, setBackedUpAt] = useState(readBackedUpAt);
  const [incoming, setIncoming] = useState<{ name: string; store: ScoreStore } | null>(null);
  const [message, setMessage] = useState<{ text: string; bad?: boolean } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const count = (s: ScoreStore) => s.history.length + (s.active ? 1 : 0);
  const games = (n: number) => `${n} game${n === 1 ? "" : "s"}`;
  const players = (n: number) => `${n} player${n === 1 ? "" : "s"}`;

  const download = () => {
    setBackedUpAt(saveBackupFile(store));
    setMessage(null);
  };

  const pick = async (file: File | undefined) => {
    if (fileRef.current) fileRef.current.value = "";
    if (!file) return;
    const parsed = parseBackup(await file.text());
    if (!parsed) return setMessage({ text: `${file.name} isn't a Scores backup.`, bad: true });
    setIncoming({ name: file.name, store: parsed });
  };

  const apply = (next: ScoreStore, how: string) => {
    setStore(next);
    setIncoming(null);
    setMessage({ text: `${how} · ${games(count(next))} here now.` });
  };

  return (
    <>
      <SectionHead zh="備份" en="Backup" />
      <div className="card">
        <p className="sc-help sc-backup-status">
          {games(count(store))} · {players(store.roster.length)} ·{" "}
          {backedUpAt ? `last saved ${new Date(backedUpAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}` : "never backed up"}
        </p>
        <div className="sc-backup-actions">
          <button type="button" className="sc-primary" onClick={download} disabled={count(store) === 0 && store.roster.length === 0}>
            儲存 Save file
          </button>
          <button type="button" className="sc-secondary" onClick={() => fileRef.current?.click()}>
            還原 Restore
          </button>
          <input ref={fileRef} type="file" accept="application/json,.json" hidden onChange={(e) => void pick(e.target.files?.[0])} />
        </div>
        {message && <p className={message.bad ? "sc-warn sc-backup-message" : "sc-help sc-backup-message"}>{message.text}</p>}
      </div>
      {incoming && (
        <Sheet
          title="還原 Restore"
          subtitle={incoming.name}
          onClose={() => setIncoming(null)}
          actions={
            <>
              <button type="button" className="sc-danger" onClick={() => apply(incoming.store, "Replaced")}>
                取代 Replace
              </button>
              <button type="button" className="sc-primary" onClick={() => apply(mergeScores(store, incoming.store), "Merged")}>
                合併 Merge
              </button>
            </>
          }
        >
          <p className="sc-note">
            The file has {games(count(incoming.store))} and {players(incoming.store.roster.length)}; this phone has {games(count(store))}.
            <br />
            <strong>Merge</strong> keeps everything from both. <strong>Replace</strong> throws away what's here and uses only the file.
          </p>
        </Sheet>
      )}
    </>
  );
}

// The players, best first: rank, 胡·摸·銃, any 獎罰, the trend line and the
// net. `compact`: a line each. A tap picks that player (their stats).
export function Leaderboard({
  store,
  stats,
  series,
  compact,
  onPick,
}: {
  store: ScoreStore;
  stats: PlayerStats[];
  series: { player: string; values: (number | null)[] }[];
  compact?: boolean;
  onPick?: (index: number) => void;
}) {
  const ranked = stats.slice().sort((a, b) => b.net - a.net);
  return (
    <div className={`card sc-board-table${compact ? " is-compact" : ""}`}>
      {ranked.length === 0 && <p className="sc-empty">No hands yet.</p>}
      {ranked.map((s, i) => (
        <button key={s.player} type="button" className="sc-leader" onClick={() => onPick?.(stats.findIndex((x) => x.player === s.player))}>
          <span className={`sc-leader-rank is-${i + 1}`}>{i + 1}</span>
          <Monogram store={store} player={s.player} />
          <span className="sc-leader-id">
            <span className="sc-leader-name">{s.player}</span>
            <span className="sc-leader-sub">
              {/* As on the 戰況 cards: 胡 black, 摸 green, 銃 red. */}
              <span className="sc-card-counts" aria-label={`${s.wins + s.selfDraws} wins, ${s.selfDraws} self-draws, ${s.dealIns} deal-ins`}>
                <strong className="is-win">{s.wins + s.selfDraws}</strong>·<strong className="is-self">{s.selfDraws}</strong>·<strong className="is-dealin">{s.dealIns}</strong>
              </span>
              {s.bonus !== 0 && <span>獎{signed(s.bonus)}</span>}
            </span>
          </span>
          <Sparkline values={series.find((x) => x.player === s.player)?.values ?? []} className={`sc-c${colorOf(store, s.player)}`} />
          <span className={`sc-leader-net ${tone(s.net)}`}>{signed(s.net)}</span>
        </button>
      ))}
    </div>
  );
}

export function StatsPanel({ store, setStore, view, setView }: { store: ScoreStore; setStore: (s: ScoreStore) => void; view: StatsView; setView: (v: StatsView) => void }) {
  const games = useMemo(() => [...(store.active ? [store.active] : []), ...store.history], [store]);
  const [gameId, setGameId] = useState<string | null>(null);
  const game = games.find((g) => g.id === gameId) ?? games[0] ?? null;
  const [playerIndex, setPlayerIndex] = useState(0);
  const state = useMemo(() => (game ? replay(game) : null), [game]);
  const stats = useMemo(() => (game && state ? playerStats(state, game).filter((s) => s.hands > 0) : []), [game, state]);
  const series = useMemo(() => (state ? trend(state).series : []), [state]);

  if (!game || !state)
    return (
      <>
        <div className="card sc-empty-card">
          <p className="sc-empty">No games yet — start one on 戰況.</p>
        </div>
        <BackupCard store={store} setStore={setStore} />
      </>
    );

  const views: { value: StatsView; label: string }[] = [
    { value: "trend", label: "走勢" },
    { value: "hands", label: "局" },
    { value: "player", label: "玩家" },
    { value: "patterns", label: "牌型" },
    { value: "history", label: "紀錄" },
  ];
  const isActive = game === store.active;

  return (
    <>
      <SectionHead zh="玩家統計" en={game.name ?? (isActive ? "This game" : new Date(game.startedAt).toLocaleDateString())}>
        <span className="sc-help">{state.hands.length}局</span>
      </SectionHead>
      {/* In full - sparklines and 胡·摸·銃 - above 走勢; a line each above the other views, which have their own detail. */}
      <Leaderboard
        store={store}
        stats={stats}
        series={series}
        compact={view !== "trend"}
        onPick={(i) => {
          setPlayerIndex(i);
          setView("player");
        }}
      />

      <div className="sc-views">
        <Segmented value={view} onChange={setView} options={views} />
      </div>

      {view === "hands" && <HandsTable store={store} game={game} state={state} />}
      {view === "trend" && (
        <div className="card">
          <div className="sc-card-head">
            <h3>走勢 Trend</h3>
            <span className="sc-help">累計分數 · Running totals, touch for a 局</span>
          </div>
          <TrendChart store={store} state={state} />
          <TrendSummary state={state} />
        </div>
      )}
      {view === "patterns" && <PatternsCard state={state} store={store} />}
      {view === "player" && stats.length > 0 && (
        <PlayerCard store={store} stats={stats} seriesOf={(p) => series.find((x) => x.player === p)?.values} index={Math.min(playerIndex, stats.length - 1)} onIndex={setPlayerIndex} />
      )}
      {view === "history" && (
        <HistoryCard
          store={store}
          games={games}
          current={game.id}
          onPick={(id) => {
            setGameId(id);
            setView("trend");
          }}
          onDelete={(id) => setStore({ ...store, history: store.history.filter((g) => g.id !== id) })}
        />
      )}
      {view === "history" && <BackupCard store={store} setStore={setStore} />}
    </>
  );
}

// 局 as a score sheet: a row per hand, oldest first, each player's change in
// their own column - 胡 / 摸 on the winner's number, 銃 on the discarder's -
// and the total at the foot. A tap opens who paid whom. 特別獎罰 are their
// own rows, or folded into the hand they happened during.
export const SHEET_VIEW_KEY = "mjwaits.sheetView";

export function HandsTable({ store, game, state }: { store: ScoreStore; game: ScoreGame; state: ReplayState }) {
  // Detailed: 獎罰 and Jackpot pay-ins as their own rows, with every tag and
  // 胡 / 摸 / 銃 mark. Simple: all folded into the hands, numbers only (the
  // winner's in bold). Remembered on this phone.
  const [detailed, setDetailedState] = useState(() => {
    try {
      return window.localStorage.getItem(SHEET_VIEW_KEY) !== "simple";
    } catch {
      return true;
    }
  });
  const setDetailed = (on: boolean) => {
    setDetailedState(on);
    try {
      window.localStorage.setItem(SHEET_VIEW_KEY, on ? "detailed" : "simple");
    } catch {
      // Just this visit, then.
    }
  };
  const merge = !detailed;
  const tags = detailed;
  const [open, setOpen] = useState<string | null>(null);
  const players = state.players.filter((p) => state.hands.some((h) => h.seatsAfter.includes(p)) || (state.totals[p] ?? 0) !== 0);
  const rows = useMemo(() => sheetRows(game, state, merge), [game, state, merge]);
  const cols = { gridTemplateColumns: `1.5rem 2.7rem repeat(${players.length}, minmax(0, 1fr))` };
  const cell = (row: SheetRow, p: string) => {
    const d = row.deltas[p] ?? 0;
    let mark: string | null = null;
    if (row.kind === "hand" && row.h.kind === "win" && tags) {
      if (row.h.winners.some((w) => w.player === p)) mark = row.h.selfDraw ? "摸" : "胡";
      else if (row.h.from === p) mark = "銃";
    }
    const won = row.kind === "hand" && row.h.winners.some((w) => w.player === p);
    return (
      <span key={p} className={`sc-sheet-cell ${d ? tone(d) : "is-zero"}${won ? " is-winner" : ""}`}>
        {mark && <span className={`sc-sheet-mark${mark === "銃" ? " is-dealin" : ""}`}>{mark}</span>}
        {d ? signed(d) : "·"}
      </span>
    );
  };
  const what = (row: SheetRow) => {
    if (row.kind === "bonus") return <span className="sc-sheet-what is-muted">{row.label}</span>;
    if (row.kind === "jackpot") return <span className="sc-sheet-what is-muted">JP</span>;
    const h = row.h;
    if (h.kind === "draw") return <span className="sc-sheet-what is-muted">流局</span>;
    const tag = h.pairs.some((x) => x.lahKind === "拉") ? "拉" : h.pairs.some((x) => x.lahKind === "踢") ? "踢" : null;
    return (
      <span className="sc-sheet-what">
        {h.multi > 1 ? (h.multi === 2 ? "雙" : "三") : fmt(h.winners[0].tai)}
        {tags && tag && <small>{tag}</small>}
        {tags && row.bonuses > 0 && <small>獎罰</small>}
        {tags && row.payIns > 0 && <small>JP</small>}
      </span>
    );
  };
  if (state.hands.length === 0) return <div className="card"><p className="sc-empty">No hands yet.</p></div>;
  return (
    <div className="card sc-sheet-card">
      <div className="sc-card-head">
        <h3>局 Hands</h3>
        <span className="sc-sheet-tools">
          <Segmented
            small
            value={detailed ? "detailed" : "simple"}
            onChange={(v) => setDetailed(v === "detailed")}
            options={[
              { value: "detailed", label: "Detailed" },
              { value: "simple", label: "Simple" },
            ]}
          />
          <button type="button" className="sc-outline sc-sheet-csv" onClick={() => saveSheetCsv(game, state, players, merge)} aria-label="Export the hands as a CSV file">
            CSV
          </button>
        </span>
      </div>
      <div className="sc-sheet-table" role="table" aria-label="Every hand, and what each player won or paid">
        <div className="sc-sheet-row is-head" style={cols} role="row">
          <span>#</span>
          <span>番</span>
          {players.map((p) => (
            <span key={p} className={`sc-sheet-name sc-c${colorOf(store, p)}`}>
              {p}
            </span>
          ))}
        </div>
        {rows.map((row) => {
          const isOpen = open === row.key;
          return (
            <Fragment key={row.key}>
              <div
                className={`sc-sheet-row is-${row.kind}${isOpen ? " is-open" : ""}`}
                style={cols}
                role="row"
                tabIndex={row.kind === "hand" ? 0 : undefined}
                onClick={() => row.kind === "hand" && setOpen(isOpen ? null : row.key)}
              >
                <span className="sc-sheet-no">{row.kind === "hand" ? row.h.hand : ""}</span>
                {what(row)}
                {players.map((p) => cell(row, p))}
              </div>
              {isOpen && row.kind === "hand" && <HandDetail h={row.h} bonuses={row.bonuses} payIns={row.payIns} />}
            </Fragment>
          );
        })}
        <div className="sc-sheet-row is-total" style={cols} role="row">
          <span />
          <span>Total</span>
          {players.map((p) => (
            <span key={p} className={`sc-sheet-cell ${tone(state.totals[p] ?? 0)}`}>
              {signed(state.totals[p] ?? 0)}
            </span>
          ))}
        </div>
      </div>
      <p className="sc-help sc-help-block">Tap a hand for who paid whom.{merge ? " 獎罰 and Jackpot pay-ins are folded into the hand they happened during." : ""}</p>
    </div>
  );
}

// One hand opened in the 局 sheet: the round, each payment and its parts,
// and anything else that moved (反雪, the Jackpot).
export function HandDetail({ h, bonuses, payIns }: { h: HandResult; bonuses: number; payIns: number }) {
  const lines: string[] = h.pairs.map((p) => {
    const parts = [p.base ? `底${fmt(p.base)}` : null, `番${fmt(p.tai)}`, p.dealer ? `莊${fmt(p.dealer)}` : null, p.multi ? `${h.multi === 3 ? "三響" : "雙響"}${fmt(p.multi)}` : null, p.lahKind ? `${p.lahKind}${fmt(p.lah)}` : null].filter(Boolean);
    return `${p.payer} → ${p.winner} ${fmt(p.worth)} · ${parts.join(" ")}`;
  });
  for (const f of h.fanXue) lines.push(`${f.from} → ${f.to} ${fmt(f.amount)} · 反雪`);
  if (h.jackpotWon) lines.push(`${h.jackpotWon.player} takes the Jackpot ${fmt(h.jackpotWon.amount)}`);
  if (h.jackpotFed > 0) lines.push(`Jackpot +${fmt(h.jackpotFed)}`);
  if (bonuses > 0) lines.push(`Includes ${bonuses} 特別獎罰`);
  if (payIns > 0) lines.push(`Includes ${payIns} Jackpot pay-in${payIns > 1 ? "s" : ""}`);
  return (
    <div className="sc-sheet-detail">
      <span className="sc-help">
        {h.label} · 莊 {h.dealer}
        {h.streak > 0 ? ` 連${h.streak}` : ""}
        {h.multi > 1 ? ` · ${h.winners.map((w) => `${w.player} ${fmt(w.tai)}番`).join(", ")}` : ""}
      </span>
      {/* The patterns behind each winner's tai, for a hand scored on Scoring. */}
      {h.winners
        .filter((w) => w.patterns?.length)
        .map((w) => (
          <span key={`p-${w.player}`} className="sc-sheet-patterns">
            {w.player}: {w.patterns!.map((p) => `${p.name} ${fmt(p.tai)}`).join(" · ")}
          </span>
        ))}
      {lines.map((l, i) => (
        <span key={i}>{l}</span>
      ))}
    </div>
  );
}

export function PatternsCard({ state, store }: { state: ReplayState; store: ScoreStore }) {
  const rows = patternCounts(state);
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <div className="card">
      <div className="sc-card-head">
        <h3>牌型 Patterns</h3>
        <span className="sc-help">計番送嚟嘅牌 · Hands from Scoring</span>
      </div>
      {rows.length === 0 ? (
        <p className="sc-empty">Use Record to Scores on the Scoring tab, and the patterns behind each hand show up here.</p>
      ) : (
        <ul className="sc-patterns">
          {rows.map((r) => (
            <li key={r.name}>
              <span className="sc-pattern-name">{r.name}</span>
              <span className="sc-pattern-bar" aria-hidden="true">
                <span style={{ width: `${(r.count / max) * 100}%` }} />
              </span>
              <strong className="sc-num">{r.count}</strong>
              <span className="sc-pattern-who">
                {Object.entries(r.byPlayer).map(([p, n]) => (
                  <span key={p}>
                    <span className={`sc-dot sc-c${colorOf(store, p)}`} />
                    {p} {n}
                  </span>
                ))}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// The 生涯 trend's smoothing: how many hands each point is averaged over, for
// a chart of n hands - more for a longer career, so the shape stays readable.
type Smoothing = "raw" | "smooth" | "smoother";
const SMOOTHING: Record<Smoothing, (n: number) => number> = {
  raw: () => 1,
  smooth: (n) => Math.max(3, Math.round(n / 40)),
  smoother: (n) => Math.max(5, Math.round(n / 12)),
};
const SMOOTHING_KEY = "mjwaits.careerSmoothing";
const PERIOD_KEY = "mjwaits.careerPeriod";
const GAMES_OPEN_KEY = "mjwaits.pastGamesOpen";

export function HistoryCard({ store, games: allGames, current, onPick, onDelete }: { store: ScoreStore; games: ScoreGame[]; current: string; onPick: (id: string) => void; onDelete: (id: string) => void }) {
  const [confirm, setConfirm] = useState<string | null>(null);
  // The period shown - all time, or one month, quarter or year (the latest
  // with a game, until ‹ › picks another). Everything on the page follows it.
  const [period, setPeriodState] = useState<Period | "all">(() => {
    try {
      const v = window.localStorage.getItem(PERIOD_KEY);
      return v === "month" || v === "quarter" || v === "year" ? v : "all";
    } catch {
      return "all";
    }
  });
  const [periodAt, setPeriodAt] = useState<string | null>(null);
  const setPeriod = (v: Period | "all") => {
    setPeriodState(v);
    setPeriodAt(null);
    try {
      window.localStorage.setItem(PERIOD_KEY, v);
    } catch {
      // Just this visit, then.
    }
  };
  const keys = useMemo(() => (period === "all" ? [] : periodsOf(allGames, period)), [allGames, period]);
  const key = period === "all" ? null : periodAt !== null && keys.includes(periodAt) ? periodAt : (keys[keys.length - 1] ?? null);
  const games = useMemo(() => (period === "all" || key === null ? allGames : allGames.filter((g) => periodKey(g.startedAt, period) === key)), [allGames, period, key]);
  const step = (by: number) => key !== null && setPeriodAt(keys[keys.indexOf(key) + by] ?? key);
  // Each game's number, #1 the first ever played - the same in every period.
  const numberOf = useMemo(() => new Map(allGames.slice().sort((a, b) => a.startedAt - b.startedAt).map((g, i) => [g.id, i + 1])), [allGames]);
  // The games list folds away under its header (remembered on this phone).
  const [listOpen, setListOpenState] = useState(() => {
    try {
      return window.localStorage.getItem(GAMES_OPEN_KEY) === "1";
    } catch {
      return false;
    }
  });
  const setListOpen = (open: boolean) => {
    setListOpenState(open);
    try {
      window.localStorage.setItem(GAMES_OPEN_KEY, open ? "1" : "0");
    } catch {
      // Just this visit, then.
    }
  };
  const [careerOpen, setCareerOpen] = useState<string | null>(null);
  const career = useMemo(() => careerStats(games), [games]);
  // The 玩家 card's numbers over every game, for the card a row opens.
  const careerCard = useMemo(() => careerPlayerStats(games, (at) => new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" })), [games]);
  // Opened from a row: bring the card into view (it sits under the table).
  const careerCardRef = useRef<HTMLDivElement>(null);
  const openCareer = (player: string | null) => {
    setCareerOpen(player);
    if (player) window.setTimeout(() => careerCardRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
  };
  const h2h = useMemo(() => headToHead(games), [games]);
  // Everyone's career total hand by hand, for the 生涯 trend chart, smoothed
  // as picked (remembered on this phone).
  const allTime = useMemo(() => careerTrend(games, (at) => new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })), [games]);
  const [smoothing, setSmoothingState] = useState<Smoothing>(() => {
    try {
      const v = window.localStorage.getItem(SMOOTHING_KEY);
      return v === "raw" || v === "smoother" ? v : "smooth";
    } catch {
      return "smooth";
    }
  });
  const setSmoothing = (v: Smoothing) => {
    setSmoothingState(v);
    try {
      window.localStorage.setItem(SMOOTHING_KEY, v);
    } catch {
      // Just this visit, then.
    }
  };
  const names = career.map((c) => c.player);
  return (
    <>
      <div className="sc-period">
        <Segmented
          small
          value={period}
          onChange={setPeriod}
          options={[
            { value: "all", label: "All" },
            { value: "year", label: "Year" },
            { value: "quarter", label: "Quarter" },
            { value: "month", label: "Month" },
          ]}
        />
        {period !== "all" && key !== null && (
          <span className="sc-period-step">
            <button type="button" className="sc-icon-button" onClick={() => step(-1)} disabled={keys.indexOf(key) === 0} aria-label="Earlier">
              {Icons.back}
            </button>
            <strong>{periodLabel(key, period)}</strong>
            <button type="button" className="sc-icon-button" onClick={() => step(1)} disabled={keys.indexOf(key) === keys.length - 1} aria-label="Later">
              {Icons.forward}
            </button>
          </span>
        )}
      </div>
      <button type="button" className="sc-games-toggle" onClick={() => setListOpen(!listOpen)} aria-expanded={listOpen}>
        <span className="section-title">
          過往<span className="section-title-en">Games</span>
        </span>
        <span className="sc-help">
          {games.length} game{games.length === 1 ? "" : "s"} {listOpen ? "▴" : "▾"}
        </span>
      </button>
      {listOpen && (
      <div className="card sc-list-card">
        {games.map((g) => {
          const st = replayCached(g);
          const ranked = st.players.filter((p) => st.hands.some((h) => h.seatsAfter.includes(p))).sort((a, b) => (st.totals[b] ?? 0) - (st.totals[a] ?? 0));
          return (
            <div key={g.id} className={`sc-game${g.id === current ? " is-current" : ""}`}>
              <button type="button" className="sc-game-main" onClick={() => onPick(g.id)}>
                <span className="sc-game-date">
                  <span className="sc-game-no">#{numberOf.get(g.id)}</span>
                  {g.name && <strong>{g.name} · </strong>}
                  {g === store.active ? "In progress" : new Date(g.startedAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}
                  {playTimes(g) && ` · ${playTimes(g)}`}
                  {g.location && ` · ${g.location}`}
                  <span className="sc-help"> · {st.hands.length}局</span>
                  {g.id === current && <span className="sc-chip-accent">Showing</span>}
                </span>
                <span className="sc-game-totals">
                  {ranked.map((p, i) => (
                    <span key={p} className={i === 0 ? "is-first" : undefined}>
                      {i === 0 && "🏆 "}
                      {p} <span className={tone(st.totals[p] ?? 0)}>{signed(st.totals[p] ?? 0)}</span>
                    </span>
                  ))}
                </span>
              </button>
              {g !== store.active && (
                <button type="button" className={`sc-icon-button${confirm === g.id ? " is-armed" : ""}`} onClick={() => (confirm === g.id ? onDelete(g.id) : setConfirm(g.id))} aria-label={confirm === g.id ? "Tap again to delete this game" : "Delete this game"}>
                  {confirm === g.id ? <span className="sc-armed-text">Delete</span> : Icons.close}
                </button>
              )}
            </div>
          );
        })}
      </div>
      )}
      <SectionHead zh="生涯" en="Career">
        <span className="sc-help">撳一行睇詳情 · Tap a player</span>
      </SectionHead>
      <div className="card sc-table-card">
        <div className="sc-table-wrap">
          <table className="sc-table">
            <thead>
              {/* Cantonese, the English under it. */}
              <tr className="sc-th-two">
                <th>
                  玩家<small>Player</small>
                </th>
                <th>
                  場數<small>Games</small>
                </th>
                <th>
                  總分<small>Net</small>
                </th>
                <th className="sc-opt">
                  平均<small>Per game</small>
                </th>
                <th>
                  第一<small>Won</small>
                </th>
                <th>
                  食糊率<small>Win</small>
                </th>
                <th>
                  出銃率<small>Deal-in</small>
                </th>
                <th className="sc-opt">
                  最大一舖<small>Best hand</small>
                </th>
              </tr>
            </thead>
            <tbody>
              {career.map((c) => {
                const isOpen = careerOpen === c.player;
                return (
                  <Fragment key={c.player}>
                    {/* A tap opens their career, as a 玩家 card, under the table. */}
                    <tr className={`sc-career-row${isOpen ? " is-open" : ""}`} onClick={() => openCareer(isOpen ? null : c.player)} aria-expanded={isOpen}>
                      <th>
                        <span className="sc-table-player">
                          <Monogram store={store} player={c.player} size="sm" />
                          {c.player}
                        </span>
                      </th>
                      <td>{c.games}</td>
                      <td className={tone(c.net)}>{signed(c.net)}</td>
                      <td className="sc-opt">{fmt(Math.round(c.avgNet * 10) / 10)}</td>
                      <td>{c.firsts}</td>
                      <td>{pct(c.winRate)}</td>
                      <td>{pct(c.dealInRate)}</td>
                      <td className="sc-opt">{c.bestHand === null ? "–" : fmt(c.bestHand)}</td>
                    </tr>
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
      {/* Everyone's career total hand by hand over every game, oldest first. */}
      {allTime.hands > 0 && (
        <div className="card">
          <div className="sc-card-head">
            <h3>走勢 All-time trend</h3>
            <Segmented
              small
              value={smoothing}
              onChange={setSmoothing}
              options={[
                { value: "raw", label: "Raw" },
                { value: "smooth", label: "Smooth" },
                { value: "smoother", label: "Smoother" },
              ]}
            />
          </div>
          <TrendChart store={store} data={allTime} labelOf={(i) => allTime.labels[i]} smooth={SMOOTHING[smoothing](allTime.hands)} marks={allTime.starts.slice(1)} />
          <p className="sc-help sc-help-block">
            {allTime.hands} hand{allTime.hands > 1 ? "s" : ""} over {allTime.starts.length} game{allTime.starts.length > 1 ? "s" : ""} - a faint line where each game starts. Touch for a hand.
          </p>
        </div>
      )}
      {careerOpen !== null && careerCard.stats.some((x) => x.player === careerOpen) && (
        <div ref={careerCardRef} className="sc-career-card">
        <PlayerCard
          store={store}
          stats={careerCard.stats}
          seriesOf={(p) => careerCard.series.get(p)}
          index={careerCard.stats.findIndex((x) => x.player === careerOpen)}
          onIndex={(i) => setCareerOpen(careerCard.stats[i].player)}
          games={career.find((c) => c.player === careerOpen)?.games ?? 0}
        />
        </div>
      )}
      {names.length > 1 && (
        <>
          <SectionHead zh="對戰" en="Head-to-head">
            <span className="sc-help">橫行對直行 · Row vs column</span>
          </SectionHead>
          <div className="card sc-table-card">
            <div className="sc-table-wrap">
              <table className="sc-table sc-h2h">
                <thead>
                  <tr>
                    <th />
                    {names.map((n) => (
                      <th key={n}>{n}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {names.map((a) => (
                    <tr key={a}>
                      <th>
                        <span className="sc-table-player">
                          <Monogram store={store} player={a} size="sm" />
                          {a}
                        </span>
                      </th>
                      {names.map((b) => {
                        const v = a === b ? null : (h2h[a]?.[b] ?? 0);
                        return (
                          <td key={b} className={v === null ? "sc-cell-self" : tone(v)}>
                            {v === null ? "" : signed(v)}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </>
  );
}
