// 結帳 as a picture for the group chat: the game, everyone's total (best
// first) with their 胡 · 摸 · 銃, and who pays whom - drawn on a canvas in
// the app's light theme, so it looks the same wherever it's posted.

import type { ScoreSnapshot } from "./scoreShare";

// The Scores player palette (App.css --sc-c0 … --sc-c7).
const PLAYER_COLOURS = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#8d5b2c", "#4a3aa7", "#e34948"];
const INK = "#1d1d1f";
const MUTED = "#6e6e73";
const LINE = "#e5e5ea";
const GREEN = "#1d7f45";
const RED = "#c42b1c";
const ACCENT = "#2e7d4f";
const FONT = `-apple-system, BlinkMacSystemFont, "PingFang HK", "PingFang TC", "Noto Sans TC", "Segoe UI", sans-serif`;

const money = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
const signed = (n: number) => (n > 0 ? `+${money(n)}` : n < 0 ? `−${money(-n)}` : "0");

export function drawSettleCard(snap: ScoreSnapshot, pays: { from: string; to: string; amount: number }[], multiplierLabel: string): Promise<Blob | null> {
  const W = 1080;
  const pad = 72;
  const rowH = 118;
  const payH = 76;
  const ranked = [...snap.players].sort((a, b) => b.t - a.t);
  const H = 300 + ranked.length * rowH + 120 + Math.max(1, pays.length) * payH + 120;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const g = canvas.getContext("2d");
  if (!g) return Promise.resolve(null);

  g.fillStyle = "#ffffff";
  g.fillRect(0, 0, W, H);
  g.textBaseline = "alphabetic";

  // Header: the game's name (or 結帳), then when, where and how long.
  g.fillStyle = INK;
  g.font = `700 64px ${FONT}`;
  g.fillText(snap.name ?? "結帳", pad, 130);
  g.fillStyle = MUTED;
  g.font = `500 34px ${FONT}`;
  const date = new Date(snap.started).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  g.fillText(`${date} · ${snap.label} · ${snap.hands}局${multiplierLabel ? ` · ${multiplierLabel}` : ""}`, pad, 190);

  // Totals, best first.
  let y = 280;
  ranked.forEach((p, i) => {
    const mid = y + rowH / 2;
    if (i > 0) {
      g.fillStyle = LINE;
      g.fillRect(pad, y, W - pad * 2, 2);
    }
    g.fillStyle = MUTED;
    g.font = `700 34px ${FONT}`;
    g.fillText(String(i + 1), pad, mid + 12);
    g.fillStyle = p.c >= 0 ? PLAYER_COLOURS[p.c % PLAYER_COLOURS.length] : "#a1a1a6";
    g.beginPath();
    g.arc(pad + 76, mid, 22, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = INK;
    g.font = `700 44px ${FONT}`;
    g.fillText(p.n, pad + 122, mid - 2);
    g.fillStyle = MUTED;
    g.font = `500 28px ${FONT}`;
    g.fillText(`胡 ${p.w} · 摸 ${p.s} · 銃 ${p.d}`, pad + 122, mid + 38);
    g.fillStyle = p.t > 0 ? GREEN : p.t < 0 ? RED : MUTED;
    g.font = `800 56px ${FONT}`;
    g.textAlign = "right";
    g.fillText(signed(p.t), W - pad, mid + 18);
    g.textAlign = "left";
    y += rowH;
  });

  // Who pays whom.
  y += 70;
  g.fillStyle = INK;
  g.font = `700 38px ${FONT}`;
  g.fillText("Settle up", pad, y);
  y += 30;
  if (pays.length === 0) {
    g.fillStyle = MUTED;
    g.font = `500 32px ${FONT}`;
    g.fillText("Everyone is level.", pad, y + 50);
  }
  for (const p of pays) {
    const mid = y + payH / 2;
    g.fillStyle = INK;
    g.font = `600 36px ${FONT}`;
    g.fillText(`${p.from}  →  ${p.to}`, pad, mid + 12);
    g.fillStyle = ACCENT;
    g.font = `800 40px ${FONT}`;
    g.textAlign = "right";
    g.fillText(`$${money(p.amount)}`, W - pad, mid + 14);
    g.textAlign = "left";
    y += payH;
  }

  // A quiet credit at the foot.
  g.fillStyle = "#a1a1a6";
  g.font = `500 26px ${FONT}`;
  g.fillText("MJWaits", pad, H - 56);

  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), "image/png"));
}
