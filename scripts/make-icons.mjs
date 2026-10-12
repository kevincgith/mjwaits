// One-off: renders the install icons and the link-preview image into public/
// from public/favicon.svg and the tile art.
//
//   node scripts/make-icons.mjs
//
// Writes icon-192.png, icon-512.png and icon-maskable-512.png (the web app
// manifest's icons), og-image.png (1200x630, shown by chat apps when a link
// is pasted) and splash/ (the iPhone / iPad launch screens).
// Uses puppeteer-core against the system Google Chrome, like
// shoot-readme-screenshots.mjs (npm i puppeteer-core --no-save).

import { mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import puppeteer from "puppeteer-core";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = path.join(ROOT, "public");

const logo = await readFile(path.join(PUBLIC, "favicon.svg"), "utf8");
const tile = async (name) =>
  `data:image/svg+xml;base64,${(await readFile(path.join(ROOT, "src/assets/tiles", `${name}.svg`))).toString("base64")}`;
const logoUrl = `data:image/svg+xml;base64,${Buffer.from(logo).toString("base64")}`;

const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new" });
const page = await browser.newPage();

// Icons: the logo itself, edge to edge (the system rounds the corners),
// plus a "maskable" one - the logo shrunk into the middle 72% of a square of
// its own green, so a circle or squircle crop never cuts into the tiles.
const icons = [
  { name: "icon-192.png", size: 192, scale: 1 },
  { name: "icon-512.png", size: 512, scale: 1 },
  { name: "icon-maskable-512.png", size: 512, scale: 0.72 },
];
for (const { name, size, scale } of icons) {
  await page.setViewport({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0;height:${size}px;display:flex;align-items:center;justify-content:center;
    background:linear-gradient(160deg,#46c27a,#17703d)">
    <img src="${logoUrl}" style="display:block;width:${size * scale}px;height:${size * scale}px"></body></html>`);
  await page.screenshot({ path: path.join(PUBLIC, name) });
  console.log("  wrote", name);
}

// Link preview: logo, name and tagline over a row of tiles.
const row = await Promise.all(["m1", "m2", "m3", "t5", "t5", "t5", "b7", "b8", "b9", "z5", "z5", "z5", "z1", "z1"].map(tile));
await page.setViewport({ width: 1200, height: 630 });
await page.setContent(`<html><body style="margin:0;width:1200px;height:630px;display:flex;flex-direction:column;
    justify-content:center;gap:56px;padding:0 90px;box-sizing:border-box;
    background:linear-gradient(160deg,#2a9a5a,#145f34);font-family:-apple-system,'Helvetica Neue',sans-serif;color:#fff">
  <div style="display:flex;align-items:center;gap:36px">
    <img src="${logoUrl}" style="width:150px;height:150px;border-radius:34px;box-shadow:0 10px 30px rgba(0,0,0,.25)">
    <div>
      <div style="font-size:96px;font-weight:800;letter-spacing:-2px;line-height:1">MJWaits</div>
      <div style="font-size:38px;font-weight:500;opacity:.9;margin-top:14px">HK/TW mahjong scoring, waits &amp; trainer</div>
    </div>
  </div>
  <div style="display:flex;gap:8px">
    ${row.map((src, i) => `<img src="${src}" style="width:58px;height:73px;background:#fff;border-radius:7px;${[2, 5, 8, 11].includes(i) ? "margin-right:18px;" : ""}box-shadow:0 4px 0 #cfd8d2">`).join("")}
  </div>
</body></html>`);
await page.screenshot({ path: path.join(PUBLIC, "og-image.png") });
console.log("  wrote og-image.png");

// iPhone / iPad launch screens (apple-touch-startup-image), portrait: the
// logo glowing on felt green, the name below. iOS only shows an image whose
// size matches the screen exactly, hence one per device size. index.html
// lists them with matching media queries (see SPLASH_SIZES' printout).
const SPLASH_SIZES = [
  // [CSS width, CSS height, pixel ratio] - iPhones, then iPads
  [440, 956, 3], [402, 874, 3], [430, 932, 3], [393, 852, 3], [428, 926, 3], [390, 844, 3],
  [375, 812, 3], [414, 896, 3], [414, 896, 2], [414, 736, 3], [375, 667, 2], [320, 568, 2],
  [1032, 1376, 2], [1024, 1366, 2], [834, 1210, 2], [834, 1194, 2], [820, 1180, 2], [834, 1112, 2],
  [810, 1080, 2], [768, 1024, 2], [744, 1133, 2],
];
await mkdir(path.join(PUBLIC, "splash"), { recursive: true });
const links = [];
for (const [w, h, dpr] of SPLASH_SIZES) {
  const logoSize = w >= 700 ? 168 : 128;
  await page.setViewport({ width: w, height: h, deviceScaleFactor: dpr });
  await page.setContent(`<html><body style="margin:0;height:${h}px;overflow:hidden;display:flex;flex-direction:column;
      align-items:center;justify-content:center;gap:${logoSize * 0.16}px;color:#fff;font-family:-apple-system,'Helvetica Neue',sans-serif;
      background:radial-gradient(90% 60% at 50% 45%,#1f6b43 0%,#123f28 60%,#0a2416 100%)">
    <img src="${logoUrl}" style="width:${logoSize}px;height:${logoSize}px;border-radius:${logoSize * 0.225}px;
      box-shadow:0 0 ${logoSize * 0.47}px rgba(120,230,160,.45),0 ${logoSize * 0.11}px ${logoSize * 0.27}px rgba(0,0,0,.45)">
    <div style="font-size:${logoSize * 0.31}px;font-weight:800;letter-spacing:-.02em">MJWaits</div>
  </body></html>`);
  // JPEG: the smooth gradient is ~1 MB as PNG, ~10x smaller as a JPEG.
  const name = `splash-${w * dpr}x${h * dpr}.jpg`;
  await page.screenshot({ path: path.join(PUBLIC, "splash", name), type: "jpeg", quality: 90 });
  links.push(
    `    <link rel="apple-touch-startup-image" href="/splash/${name}" media="(device-width: ${w}px) and (device-height: ${h}px) and (-webkit-device-pixel-ratio: ${dpr}) and (orientation: portrait)" />`
  );
}
console.log(`  wrote ${links.length} splash screens; index.html's tags:\n${links.join("\n")}`);

await browser.close();
