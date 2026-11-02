import { downloadBlob } from "./files";

// One-page pictures of the Stats views, to share or keep: a game's 走勢 (the
// standings and everyone's running total) and one player's stats. Drawn
// straight onto a canvas rather than copied from the page, so they come out
// the same on every phone - always light, sized for a chat or a photo album.

export interface PictureLine {
  name: string;
  color: string;
  values: (number | null)[];
}

export interface PictureStanding {
  name: string;
  color: string;
  total: number;
  // Their numbers, shown small under the name: 胡 4, 摸 1 and so on.
  metrics?: { label: string; value: string }[];
}

export interface PictureStatGroup {
  title: string;
  // mark: a thumb - best or lowest at the table on this stat, as on the page.
  rows: { label: string; en?: string; value: string; sub?: string | null; tone?: number; mark?: "best" | "worst" | null }[];
}

const W = 1080;
const PAD = 64;
const FONT = `-apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang HK", "Noto Sans TC", "Helvetica Neue", sans-serif`;
const INK = "#1d1d1f";
const MUTED = "#6e6e73";
const FAINT = "#d2d2d7";
const BG = "#f5f5f7";
const CARD = "#ffffff";
const UP = "#248a3d";
const DOWN = "#d70015";

const font = (size: number, weight = 400) => `${weight} ${size}px ${FONT}`;

// The page's thumb icons (Icons.thumbUp / thumbDown, a 24-unit box).
const THUMB = {
  best: ["M7 10v11", "M15 5.9 14 10h5.8a2 2 0 0 1 1.9 2.6l-2.3 7A2 2 0 0 1 17.5 21H4.5A1.5 1.5 0 0 1 3 19.5v-8A1.5 1.5 0 0 1 4.5 10h2.8a2 2 0 0 0 1.8-1.1L12 3a3 3 0 0 1 3 2.9Z"],
  worst: ["M17 14V3", "M9 18.1 10 14H4.2a2 2 0 0 1-1.9-2.6l2.3-7A2 2 0 0 1 6.5 3h13A1.5 1.5 0 0 1 21 4.5v8a1.5 1.5 0 0 1-1.5 1.5h-2.8a2 2 0 0 0-1.8 1.1L12 21a3 3 0 0 1-3-2.9Z"],
};

// A thumb, size px square, its bottom-left at (x, y).
function thumb(ctx: CanvasRenderingContext2D, mark: "best" | "worst", x: number, y: number, size: number) {
  ctx.save();
  ctx.translate(x, y - size);
  ctx.scale(size / 24, size / 24);
  ctx.strokeStyle = mark === "best" ? UP : DOWN;
  ctx.lineWidth = 2.2;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  for (const d of THUMB[mark]) ctx.stroke(new Path2D(d));
  ctx.restore();
}
const signed = (n: number) => (n > 0 ? `+${n}` : n < 0 ? `−${-n}` : "0");
const toneColor = (n: number) => (n > 0 ? UP : n < 0 ? DOWN : MUTED);

function canvasOf(height: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, W, height);
  ctx.textBaseline = "alphabetic";
  return [canvas, ctx];
}

function card(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
  const r = 28;
  ctx.fillStyle = CARD;
  ctx.beginPath();
  // By hand rather than roundRect, which an iPhone before iOS 16 lacks.
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
  ctx.fill();
}

// The title block: the app's name small, the title big, a line under it.
function header(ctx: CanvasRenderingContext2D, title: string, subtitle: string): number {
  ctx.fillStyle = MUTED;
  ctx.font = font(30, 600);
  ctx.fillText("MJWaits", PAD, PAD + 30);
  ctx.fillStyle = INK;
  ctx.font = font(60, 700);
  ctx.fillText(title, PAD, PAD + 104, W - 2 * PAD);
  ctx.fillStyle = MUTED;
  ctx.font = font(32);
  ctx.fillText(subtitle, PAD, PAD + 152, W - 2 * PAD);
  return PAD + 190;
}

function footer(ctx: CanvasRenderingContext2D, height: number) {
  ctx.fillStyle = MUTED;
  ctx.font = font(26);
  ctx.textAlign = "center";
  ctx.fillText(`MJWaits · ${new Date().toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}`, W / 2, height - 40);
  ctx.textAlign = "left";
}

// A tidy step for the y axis: 1, 2 or 5 times a power of ten.
function niceStep(raw: number): number {
  const p = 10 ** Math.floor(Math.log10(raw || 1));
  const m = raw / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p;
}

// Everyone's running total, hand by hand, each line labelled at its end. A
// mini chart (one player's, beside their total) has no labels or hand count.
function chart(ctx: CanvasRenderingContext2D, lines: PictureLine[], x: number, y: number, w: number, h: number, mini = false) {
  const n = Math.max(1, ...lines.map((l) => l.values.length));
  const all = lines.flatMap((l) => l.values.filter((v): v is number => v !== null));
  let lo = Math.min(0, ...all);
  let hi = Math.max(0, ...all);
  if (lo === hi) hi = lo + 10;
  // Whole-number steps: the labels are rounded, so a step under 1 would
  // print the same number twice.
  const step = Math.max(1, niceStep((hi - lo) / 4));
  lo = Math.floor(lo / step) * step;
  hi = Math.ceil(hi / step) * step;
  const labelW = mini ? 16 : 150;
  const axisW = mini ? 64 : 80;
  const left = x + axisW;
  const right = x + w - labelW;
  const px = (i: number) => left + (n === 1 ? 0 : (i / (n - 1)) * (right - left));
  const py = (v: number) => y + h - ((v - lo) / (hi - lo)) * h;

  ctx.font = font(24);
  ctx.textAlign = "right";
  for (let v = lo; v <= hi + 1e-9; v += step) {
    ctx.strokeStyle = v === 0 ? "#a1a1a6" : FAINT;
    ctx.lineWidth = v === 0 ? 2 : 1;
    ctx.beginPath();
    ctx.moveTo(left, py(v));
    ctx.lineTo(right, py(v));
    ctx.stroke();
    ctx.fillStyle = MUTED;
    ctx.fillText(signed(Math.round(v)), left - 14, py(v) + 8);
  }
  ctx.textAlign = "left";

  ctx.lineWidth = 6;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  for (const l of lines) {
    ctx.strokeStyle = l.color;
    ctx.beginPath();
    let pen = false;
    l.values.forEach((v, i) => {
      if (v === null) {
        pen = false;
        return;
      }
      if (pen) ctx.lineTo(px(i), py(v));
      else ctx.moveTo(px(i), py(v));
      pen = true;
    });
    ctx.stroke();
  }

  // End labels, nudged apart so none sit on top of another.
  const ends = lines
    .map((l) => {
      const i = l.values.map((v) => v !== null).lastIndexOf(true);
      return i < 0 ? null : { l, x: px(i), y: py(l.values[i]!) };
    })
    .filter((e): e is { l: PictureLine; x: number; y: number } => e !== null)
    .sort((a, b) => a.y - b.y);
  const gap = 34;
  const placed = ends.map((e) => e.y);
  for (let i = 1; i < placed.length; i++) placed[i] = Math.max(placed[i], placed[i - 1] + gap);
  for (let i = placed.length - 1; i >= 0; i--) placed[i] = Math.min(placed[i], y + h + 10 - (placed.length - 1 - i) * gap);
  ends.forEach((e, i) => {
    ctx.fillStyle = e.l.color;
    ctx.beginPath();
    ctx.arc(e.x, e.y, 8, 0, Math.PI * 2);
    ctx.fill();
    if (mini) return;
    ctx.fillStyle = INK;
    ctx.font = font(26, 600);
    ctx.fillText(e.l.name, right + 18, placed[i] + 9, labelW - 22);
  });

  if (mini) return;
  ctx.fillStyle = MUTED;
  ctx.font = font(24);
  ctx.textAlign = "center";
  ctx.fillText(`${n - 1}局`, (left + right) / 2, y + h + 44);
  ctx.textAlign = "left";
}

// 走勢: the standings, best first, the chart, then 對戰 - what each player
// won or lost against each other one (row vs column).
export function trendPicture({
  title,
  subtitle,
  standings,
  lines,
  h2h,
  chartTitle = "走勢 Trend",
}: {
  title: string;
  subtitle: string;
  standings: PictureStanding[];
  lines: PictureLine[];
  h2h?: Record<string, Record<string, number>>;
  chartTitle?: string;
}): HTMLCanvasElement {
  const rowH = standings.some((s) => s.metrics?.length) ? 112 : 76;
  const listH = standings.length * rowH + 40;
  const chartH = 640;
  const names = standings.map((s) => s.name);
  const h2hRow = 64;
  const h2hH = h2h && names.length > 1 ? 100 + (names.length + 1) * h2hRow + 20 : 0;
  const height = 190 + PAD + listH + 32 + chartH + 140 + (h2hH ? h2hH + 32 : 0) + 80;
  const [canvas, ctx] = canvasOf(height);
  let y = header(ctx, title, subtitle);

  card(ctx, PAD - 16, y, W - 2 * (PAD - 16), listH);
  standings.forEach((s, i) => {
    const ry = y + 20 + i * rowH;
    if (i > 0) {
      ctx.fillStyle = "#e8e8ed";
      ctx.fillRect(PAD + 76, ry, W - 2 * PAD - 76, 2);
    }
    ctx.fillStyle = i === 0 ? "#b8860b" : MUTED;
    ctx.font = font(34, 700);
    ctx.fillText(String(i + 1), PAD + 12, ry + 50);
    ctx.fillStyle = s.color;
    ctx.beginPath();
    ctx.arc(PAD + 92, ry + 39, 12, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = INK;
    ctx.font = font(38, i === 0 ? 700 : 500);
    ctx.fillText(s.name, PAD + 120, ry + 52, 560);
    // 胡 4 · 摸 1 · 銃 2 · 獎 +5 · 每局 +2.2 under the name.
    let mx = PAD + 120;
    s.metrics?.forEach((m, k) => {
      ctx.fillStyle = MUTED;
      ctx.font = font(25);
      const label = `${k > 0 ? "·  " : ""}${m.label} `;
      ctx.fillText(label, mx, ry + 92);
      mx += ctx.measureText(label).width;
      ctx.fillStyle = INK;
      ctx.font = font(25, 700);
      ctx.fillText(m.value, mx, ry + 92);
      mx += ctx.measureText(m.value).width + 14;
    });
    ctx.fillStyle = toneColor(s.total);
    ctx.font = font(42, 700);
    ctx.textAlign = "right";
    ctx.fillText(signed(s.total), W - PAD - 8, ry + 52);
    ctx.textAlign = "left";
  });
  y += listH + 32;

  card(ctx, PAD - 16, y, W - 2 * (PAD - 16), chartH + 140);
  ctx.fillStyle = INK;
  ctx.font = font(34, 700);
  ctx.fillText(chartTitle, PAD + 8, y + 58);
  chart(ctx, lines, PAD, y + 100, W - 2 * PAD, chartH - 40);
  y += chartH + 140 + 32;

  if (h2h && h2hH) {
    card(ctx, PAD - 16, y, W - 2 * (PAD - 16), h2hH);
    ctx.fillStyle = INK;
    ctx.font = font(34, 700);
    ctx.fillText("對戰 Head-to-head", PAD + 8, y + 58);
    ctx.fillStyle = MUTED;
    ctx.font = font(24);
    ctx.textAlign = "right";
    ctx.fillText("Row vs column", W - PAD - 8, y + 58);
    const nameW = 260;
    const cellW = (W - 2 * PAD - nameW) / names.length;
    const top = y + 100;
    ctx.font = font(26, 600);
    names.forEach((n, j) => {
      ctx.fillStyle = MUTED;
      ctx.fillText(n, PAD + nameW + (j + 1) * cellW - 12, top + 40, cellW - 16);
    });
    names.forEach((a, i) => {
      const ry = top + (i + 1) * h2hRow;
      ctx.fillStyle = "#e8e8ed";
      ctx.fillRect(PAD, ry, W - 2 * PAD, 2);
      ctx.textAlign = "left";
      ctx.fillStyle = standings[i].color;
      ctx.beginPath();
      ctx.arc(PAD + 18, ry + 33, 10, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = INK;
      ctx.font = font(30, 600);
      ctx.fillText(a, PAD + 42, ry + 43, nameW - 52);
      ctx.textAlign = "right";
      names.forEach((b, j) => {
        const cx = PAD + nameW + j * cellW;
        if (a === b) {
          ctx.fillStyle = "#f2f2f7";
          ctx.fillRect(cx + 6, ry + 6, cellW - 6, h2hRow - 10);
          return;
        }
        const v = h2h[a]?.[b] ?? 0;
        ctx.fillStyle = toneColor(v);
        ctx.font = font(30, 700);
        ctx.fillText(signed(v), cx + cellW - 12, ry + 43);
      });
    });
    ctx.textAlign = "left";
  }
  footer(ctx, height);
  return canvas;
}

// 玩家: one player's total and trend, then each group of stats in two columns.
export function playerPicture({
  title,
  subtitle,
  net,
  line,
  kpis,
  groups,
}: {
  title: string;
  subtitle: string;
  net: number;
  line: PictureLine | null;
  kpis: { label: string; value: string }[];
  groups: PictureStatGroup[];
}): HTMLCanvasElement {
  const colW = (W - 2 * PAD - 32) / 2;
  const rowH = 74;
  const groupH = (g: PictureStatGroup) => 70 + g.rows.length * rowH + 16;
  // Two columns, each group to the shorter one.
  const cols: PictureStatGroup[][] = [[], []];
  const colH = [0, 0];
  for (const g of groups) {
    const c = colH[0] <= colH[1] ? 0 : 1;
    cols[c].push(g);
    colH[c] += groupH(g) + 24;
  }
  const topH = 300;
  const marked = groups.some((g) => g.rows.some((r) => r.mark));
  const height = 190 + PAD + topH + 32 + Math.max(...colH) + (marked ? 150 : 100);
  const [canvas, ctx] = canvasOf(height);
  let y = header(ctx, title, subtitle);

  card(ctx, PAD - 16, y, W - 2 * (PAD - 16), topH);
  ctx.fillStyle = toneColor(net);
  ctx.font = font(96, 700);
  ctx.fillText(signed(net), PAD + 12, y + 118);
  if (line && line.values.some((v) => v !== null)) chart(ctx, [line], PAD + 420, y + 36, W - 2 * PAD - 420 - 8, 120, true);
  kpis.forEach((k, i) => {
    const kx = PAD + 12 + i * ((W - 2 * PAD) / kpis.length);
    ctx.fillStyle = INK;
    ctx.font = font(48, 700);
    ctx.fillText(k.value, kx, y + 230);
    ctx.fillStyle = MUTED;
    ctx.font = font(26);
    ctx.fillText(k.label, kx, y + 270);
  });
  y += topH + 32;

  cols.forEach((col, c) => {
    let gy = y;
    const gx = PAD - 16 + c * (colW + 32);
    for (const g of col) {
      const h = groupH(g);
      card(ctx, gx, gy, colW + 16, h);
      ctx.fillStyle = INK;
      ctx.font = font(30, 700);
      ctx.fillText(g.title, gx + 28, gy + 50, colW - 30);
      g.rows.forEach((r, i) => {
        const ry = gy + 70 + i * rowH;
        ctx.fillStyle = "#e8e8ed";
        ctx.fillRect(gx + 28, ry, colW - 40, 2);
        // The Cantonese, then the English smaller and grey if there's room.
        const ly = ry + (r.sub ? 36 : 46);
        const room = colW - 40 - (ctx.font = font(32, 700), ctx.measureText(r.value).width) - 24;
        ctx.fillStyle = INK;
        ctx.font = font(27);
        ctx.fillText(r.label, gx + 28, ly, room);
        let zhW = Math.min(room, ctx.measureText(r.label).width);
        if (r.mark) {
          thumb(ctx, r.mark, gx + 28 + zhW + 6, ly + 1, 24);
          zhW += 34;
        }
        if (r.en) {
          ctx.font = font(21);
          if (zhW + 10 + ctx.measureText(r.en).width <= room) {
            ctx.fillStyle = MUTED;
            ctx.fillText(r.en, gx + 28 + zhW + 10, ly);
          }
        }
        ctx.textAlign = "right";
        ctx.fillStyle = r.tone !== undefined ? toneColor(r.tone) : INK;
        ctx.font = font(32, 700);
        ctx.fillText(r.value, gx + colW - 12, ry + (r.sub ? 36 : 46));
        if (r.sub) {
          ctx.fillStyle = MUTED;
          ctx.font = font(22);
          ctx.fillText(r.sub, gx + colW - 12, ry + 64, colW - 60);
        }
        ctx.textAlign = "left";
      });
      gy += h + 24;
    }
  });
  // What the thumbs mean.
  if (marked) {
    const ky = height - 100;
    ctx.font = font(26);
    const best = "全場最好 Best at the table";
    const worst = "全場最差 Lowest at the table";
    const total = 32 + ctx.measureText(best).width + 48 + 32 + ctx.measureText(worst).width;
    let kx = (W - total) / 2;
    thumb(ctx, "best", kx, ky + 4, 26);
    ctx.fillStyle = MUTED;
    ctx.fillText(best, kx + 32, ky);
    kx += 32 + ctx.measureText(best).width + 48;
    thumb(ctx, "worst", kx, ky + 4, 26);
    ctx.fillText(worst, kx + 32, ky);
  }
  footer(ctx, height);
  return canvas;
}

// Hand the picture over: the share sheet where there is one (on a phone,
// Save Image puts it in Photos), else a download. The PNG is made at once
// (toDataURL, not the async toBlob) so share() is still called inside the
// tap - iPhone refuses a share sheet once the tap's moment has passed.
export async function savePicture(canvas: HTMLCanvasElement, filename: string): Promise<void> {
  const data = atob(canvas.toDataURL("image/png").split(",")[1]);
  const bytes = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) bytes[i] = data.charCodeAt(i);
  const blob = new Blob([bytes], { type: "image/png" });
  const file = new File([blob], filename, { type: "image/png" });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return;
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
    }
  }
  downloadBlob(blob, filename);
}

// A player's colour as the page draws it (--sc-cN, or the neutral grey for
// someone off the roster), for the picture's lines and dots.
export function playerColor(index: number | "x"): string {
  const name = index === "x" ? "--sc-neutral" : `--sc-c${index}`;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  if (v) return v;
  return index === "x" ? "#8e8e93" : ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#8d5b2c", "#4a3aa7", "#e34948"][index % 8];
}
