// Screenshots for the user guide (docs/guide/jpg), phone-sized, from the dev server.
//   npm run dev; URL=http://localhost:5173/mjwaits/ node docs/guide/shoot.mjs [scoring scores calculator trainer dice play]
// Writes PNGs to docs/guide/img/ (not committed); the guide uses them as 560px-wide JPEGs in jpg/
// (1000px for play-table).
import { createRequire } from "node:module";
const require = createRequire(new URL("../../package.json", import.meta.url));
const puppeteer = require("puppeteer-core");

const BASE = process.env.URL ?? "http://localhost:5175/mjwaits/";
const OUT = new URL("./img/", import.meta.url).pathname;
const only = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const want = (n) => !only.length || only.includes(n);

const browser = await puppeteer.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: "new",
  args: ["--force-color-profile=srgb", "--hide-scrollbars"],
});
const page = await browser.newPage();
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: false });
await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);

const shot = async (name, opts = {}) => {
  await sleep(opts.wait ?? 400);
  await page.screenshot({ path: `${OUT}${name}.png`, fullPage: !!opts.full });
  console.log("wrote", name);
};
const clickText = (label, nth = 0) =>
  page.evaluate(
    (label, nth) => {
      const b = [...document.querySelectorAll("button")].filter((b) => b.textContent.trim() === label)[nth];
      if (!b) return false;
      b.click();
      return true;
    },
    label,
    nth,
  );
const clickStarts = (label) =>
  page.evaluate((label) => {
    const b = [...document.querySelectorAll("button")].find((b) => b.textContent.trim().startsWith(label));
    b?.click();
    return !!b;
  }, label);
const tab = async (label) => {
  await page.evaluate((label) => {
    [...document.querySelectorAll(".tab-bar button")].find((b) => b.textContent.trim() === label)?.click();
  }, label);
  await sleep(300);
  await page.evaluate(() => window.scrollTo(0, 0));
};
const addTile = (suit, rank) =>
  page.evaluate(
    (suit, rank) => {
      const pickers = [...document.querySelectorAll(".tile-picker")];
      const picker = pickers[pickers.length - 1];
      const btn = [...picker.querySelectorAll("button")].find((b) => b.querySelector(`.tile-glyph[data-suit="${suit}"][data-rank="${rank}"]`));
      btn?.click();
      return !!btn;
    },
    suit,
    rank,
  );

// A game in progress for the Scores tab, built with the app's own ledger.
const seedScores = () =>
  page.evaluate(async () => {
    const L = await import("/mjwaits/shared/engine/ledger.ts");
    const g = L.newGame(["Amy", "Ben", "Chris", "Dee"], 0, L.DEFAULT_SETTINGS);
    let at = g.startedAt;
    const t = () => (at += 240000);
    const pat = (n, tai) => ({ id: n, name: n, tai });
    const ev = [
      { t: "win", at: t(), winners: [{ seat: 1, tai: 12, patterns: [pat("清一色", 8), pat("門前清", 3)] }], from: 2, source: "scoring" },
      { t: "win", at: t(), winners: [{ seat: 1, tai: 8 }], from: 2, source: "quick" },
      { t: "draw", at: t() },
      { t: "win", at: t(), winners: [{ seat: 3, tai: 15, patterns: [pat("對對胡", 10), pat("自摸", 1)] }], from: null, source: "scoring" },
      { t: "bonus", at: t(), seat: 0, kind: "獎", amount: 5, name: "花" },
      { t: "win", at: t(), winners: [{ seat: 0, tai: 20, patterns: [pat("混一色", 4), pat("三元牌", 6)] }], from: 1, source: "scoring" },
      { t: "win", at: t(), winners: [{ seat: 2, tai: 6 }], from: 3, source: "quick" },
      { t: "win", at: t(), winners: [{ seat: 1, tai: 9 }], from: 2, source: "quick" },
    ];
    const game = { ...L.withEvents(g, ev), name: "Friday night", updatedAt: at };
    const store = { ...L.emptyStore(), active: game, roster: ["Amy", "Ben", "Chris", "Dee"].map((n) => ({ name: n })) };
    localStorage.setItem("mjwaits.scores", JSON.stringify(store));
  });

await page.goto(BASE, { waitUntil: "networkidle0" });
await page.evaluate(() => localStorage.clear());
await page.reload({ waitUntil: "networkidle0" });

// --- Scoring -------------------------------------------------------------
if (want("scoring")) {
  await tab("Scoring");
  await shot("scoring-empty");
  // 123b 456b 789b 111b 555b 99b, concealed, self-drawn.
  for (const r of [1, 1, 1, 1, 2, 3, 4, 5, 5, 5, 5, 6, 7, 8]) await addTile("b", r);
  await shot("scoring-building");
  for (const r of [9, 9, 9]) await addTile("b", r);
  await clickText("自摸");
  await sleep(500);
  await shot("scoring-situation", { wait: 300 });
  await page.evaluate(() => document.querySelector(".result-total")?.scrollIntoView({ block: "start" }));
  await page.evaluate(() => window.scrollBy(0, -70));
  await page.evaluate(() => {
    document.querySelectorAll("button.scoring-pattern-row[aria-expanded]").forEach((b, i) => i < 2 && b.click());
  });
  await shot("scoring-result");
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await shot("scoring-recent");
}

// --- Scores --------------------------------------------------------------
if (want("scores")) {
  await page.evaluate(() => localStorage.removeItem("mjwaits.scores"));
  await page.reload({ waitUntil: "networkidle0" });
  await tab("Scores");
  await shot("scores-setup");
  await seedScores();
  await page.reload({ waitUntil: "networkidle0" });
  await tab("Scores");
  await shot("scores-board", { wait: 700 });
  // Record a hand for Ben: tap his card.
  await page.evaluate(() => [...document.querySelectorAll("button[aria-label]")].find((b) => b.getAttribute("aria-label").startsWith("Ben,"))?.click());
  await sleep(500);
  await shot("scores-win-sheet");
  await page.keyboard.press("Escape");
  await page.reload({ waitUntil: "networkidle0" });
  await tab("Scores");
  await clickStarts("統計");
  await shot("scores-stats", { wait: 700 });
  await page.evaluate(() => window.scrollTo(0, 0));
}

// --- Calculator ----------------------------------------------------------
if (want("calculator")) {
  await tab("Calculator");
  await page.click('input[type="text"]');
  await page.type('input[type="text"]', "123456789m111z11t22b", { delay: 5 });
  await clickText("Breakdown");
  await sleep(300);
  await page.evaluate(() => document.querySelector('.calculator-panel button[title="Hide tile picker"]')?.click());
  await shot("calculator-waits");
  await page.evaluate(() => document.querySelector('.calculator-panel button[title="Show tile picker"]')?.click());
  await sleep(200);
  await page.click('input[type="text"]');
  await page.keyboard.down("Meta"); await page.keyboard.press("a"); await page.keyboard.up("Meta");
  await page.keyboard.press("Backspace");
  await page.type('input[type="text"]', "1278m555t111333555z", { delay: 5 });
  await page.evaluate(() => document.querySelector('.calculator-panel button[title="Hide tile picker"]')?.click());
  await shot("calculator-discards");
}

// --- Trainer -------------------------------------------------------------
if (want("trainer")) {
  await tab("Trainer");
  await shot("trainer-start");
  await clickText("L3");
  await clickText("New hand");
  await shot("trainer-question", { wait: 600 });
}

// --- Dice ----------------------------------------------------------------
if (want("dice")) {
  await tab("Dice");
  await page.evaluate(() => {
    const dice = [...document.querySelectorAll("button")].filter((b) => (b.getAttribute("aria-label") || "").startsWith("Die "));
    const bump = (el, n) => {
      for (let i = 0; i < n; i++) el.click();
    };
    bump(dice[0], 4);
    bump(dice[1], 5);
    bump(dice[2], 3);
  });
  await shot("dice-wall", { full: true });
  await clickStarts("Exchange");
  await clickText("Roll the dice");
  await shot("dice-exchange", { wait: 2500 });
  await clickText("Seating");
  await page.evaluate(() => document.querySelector(".seat-token")?.click());
  await shot("dice-seating", { wait: 600 });
}

// --- Play (landscape) ----------------------------------------------------
if (want("play")) {
  await page.setViewport({ width: 844, height: 390, deviceScaleFactor: 2, isMobile: true, hasTouch: false });
  await page.goto(BASE, { waitUntil: "networkidle0" });
  const logo = await page.$(".app-logo");
  const box = await logo.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await sleep(800);
  await page.mouse.up();
  await sleep(6000); // dice tumble and the deal
  await shot("play-table");
}

await browser.close();
