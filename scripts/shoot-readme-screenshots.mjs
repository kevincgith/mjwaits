// One-off: regenerate the README screenshots in docs/ from the running dev server.
//
//   npm run dev            # in another terminal (http://localhost:5173/mjwaits/)
//   node scripts/shoot-readme-screenshots.mjs
//
// Uses puppeteer-core against the system Google Chrome (no bundled download).
// Not wired into package.json - install puppeteer-core ad hoc if it's missing:
//   npm i puppeteer-core --no-save

import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import puppeteer from "puppeteer-core";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const BASE = process.env.MJWAITS_URL ?? "http://localhost:5173/mjwaits/";
const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../docs");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Screenshot the app column (.page), capped at `maxH` CSS px so a long waits
// list doesn't produce a 3000px-tall image. `startAt` (a CSS selector) moves
// the top of the clip down to that element, e.g. to skip the tile picker.
async function shoot(page, name, { maxH = 900, startAt = null } = {}) {
  const box = await page.evaluate((startAt) => {
    const page = document.querySelector(".page").getBoundingClientRect();
    const topY = startAt
      ? document.querySelector(startAt).getBoundingClientRect().top - 12
      : page.top;
    return {
      x: page.x,
      y: topY + window.scrollY,
      w: page.width,
      bottom: page.bottom + window.scrollY,
    };
  }, startAt);
  await page.screenshot({
    path: path.join(OUT, name),
    clip: {
      x: box.x,
      y: box.y,
      width: box.w,
      height: Math.min(box.bottom - box.y, maxH),
    },
  });
  console.log("  wrote", name);
}

// Click a <button> whose trimmed text content exactly equals `label`.
async function clickText(page, label, { nth = 0 } = {}) {
  const handle = await page.evaluateHandle(
    (label, nth) => {
      const btns = [...document.querySelectorAll("button")].filter(
        (b) => b.textContent.trim() === label,
      );
      return btns[nth] ?? null;
    },
    label,
    nth,
  );
  const el = handle.asElement();
  if (!el) throw new Error(`no button "${label}" (nth=${nth})`);
  await el.click();
}

// Click a tile in the Scoring tab's concealed-hand picker (the last .tile-picker
// on the page). Tiles there carry a `title` like "1 Sou" and a glyph <span>
// with data-suit / data-rank.
async function addConcealed(page, suit, rank) {
  const ok = await page.evaluate(
    (suit, rank) => {
      const pickers = [...document.querySelectorAll(".tile-picker")];
      const picker = pickers[pickers.length - 1];
      const btn = [...picker.querySelectorAll("button")].find((b) =>
        b.querySelector(`.tile-glyph[data-suit="${suit}"][data-rank="${rank}"]`),
      );
      if (!btn) return false;
      btn.click();
      return true;
    },
    suit,
    rank,
  );
  if (!ok) throw new Error(`no concealed tile ${rank}${suit}`);
}

async function setMode(page, label) {
  await page.evaluate((label) => {
    [...document.querySelectorAll(".mode-tabs button")]
      .find((b) => b.textContent.trim() === label)
      ?.click();
  }, label);
  await sleep(150);
}

async function collapsePickers(page) {
  await page.evaluate(() => {
    document
      .querySelectorAll('button[title="Hide tile picker"]')
      .forEach((b) => b.click());
  });
  await sleep(150);
}

async function typeNotation(page, text) {
  await page.click('input[type="text"]');
  await page.evaluate(() => {
    document.querySelector('input[type="text"]').value = "";
  });
  await page.type('input[type="text"]', text, { delay: 8 });
  await sleep(250);
}

const main = async () => {
  await mkdir(OUT, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    defaultViewport: { width: 900, height: 1400, deviceScaleFactor: 2 },
    args: ["--force-color-profile=srgb", "--hide-scrollbars"],
  });
  const page = await browser.newPage();
  await page.goto(BASE, { waitUntil: "networkidle0" });

  const NOTATION = 'label[for="algebraic"]';

  // 1. Hero: Calculator with a shanpon tenpai hand + Breakdown on.
  await setMode(page, "Calculator");
  await typeNotation(page, "123456789m111z11t22b");
  await clickText(page, "Breakdown");
  await sleep(300);
  await shoot(page, "preview.png", { startAt: NOTATION, maxH: 780 });

  // 2. Jokers: 1 man + 3 jokers -> universal wait + joker resolution hints.
  await clickText(page, "Breakdown"); // back off - the list itself is the point
  await typeNotation(page, "1mjjj");
  await sleep(300);
  await shoot(page, "jokers.png", { startAt: NOTATION, maxH: 900 });

  // 3. Discard efficiency: a non-tenpai hand, discards ranked by a two-step
  //    lookahead (555z = 中 renders cleanly; 白/777z shows as a near-blank tile).
  await typeNotation(page, "1278m555t111333555z");
  await sleep(300);
  await shoot(page, "discard-efficiency.png", { startAt: NOTATION, maxH: 950 });

  // 4. Special hand: a tenpai Sixteen Unrelated Tiles hand.
  await typeNotation(page, "147t258m369b1234567z");
  await sleep(300);
  await shoot(page, "special-hand.png", { startAt: NOTATION, maxH: 820 });

  // 5. Scoring: a fully concealed pure-flush self-draw, big tai total.
  await setMode(page, "Scoring");
  await clickText(page, "🔄 Reset").catch(() => {});
  await sleep(150);
  // 123b 456b 789b 111b 555b 99b, all in the concealed region.
  const sou = [1, 1, 1, 1, 2, 3, 4, 5, 5, 5, 5, 6, 7, 8, 9, 9, 9];
  for (const r of sou) await addConcealed(page, "b", r);
  await clickText(page, "自摸"); // self-draw
  await sleep(200);
  await collapsePickers(page);
  // expand the first few stacking patterns so their tile rows show
  await page.evaluate(() => {
    document
      .querySelectorAll("button.scoring-pattern-row[aria-expanded]")
      .forEach((b, i) => {
        if (i < 3) b.click();
      });
  });
  await sleep(250);
  await shoot(page, "scoring.png", { maxH: 1180 });

  // 6. Dice & wall: three dice set to 4 / 5 / 3 = 12, wall broken on the left.
  await setMode(page, "Dice rolling");
  await page.evaluate(() => {
    const dice = [...document.querySelectorAll("button")].filter((b) =>
      (b.getAttribute("aria-label") || "").startsWith("Die showing"),
    );
    const bump = (el, to) => {
      for (let i = 0; i < to; i++) el.click();
    };
    bump(dice[0], 3); // 1 -> 4
    bump(dice[1], 4); // 1 -> 5
    bump(dice[2], 2); // 1 -> 3
  });
  await sleep(300);
  await shoot(page, "dice.png", { maxH: 900 });

  // 7. Trainer: a Level 4 question, answered, showing the marked picker + stats.
  await setMode(page, "Trainer");
  // Seed Math.random so the generated hand is stable run to run.
  await page.evaluate(() => {
    let s = 0x2545f491;
    Math.random = () => {
      s ^= s << 13;
      s ^= s >>> 17;
      s ^= s << 5;
      return ((s >>> 0) % 1_000_000) / 1_000_000;
    };
  });
  await clickText(page, "L4");
  await clickText(page, "New Hand");
  await sleep(300);
  // Let the per-question timer accrue a realistic few seconds.
  await sleep(3500);
  // For this seeded L4 hand the waits are 4-Sou and 7-Sou (picker indices 12
  // and 15). Guess 3-Pin (#2, wrong) and 4-Sou (#12, hit), leaving 7-Sou as a
  // miss - so the submitted picker shows all three feedback colours at once.
  await page.evaluate(() => {
    const picker = [...document.querySelectorAll(".panel .tile-picker button")];
    [2, 12].forEach((i) => picker[i]?.click());
  });
  await sleep(150);
  await clickText(page, "Submit", { nth: 0 }).catch(async () => {
    await page.evaluate(() => {
      [...document.querySelectorAll("button")]
        .find((b) => b.textContent.trim().startsWith("Submit"))
        ?.click();
    });
  });
  await sleep(400);
  await shoot(page, "trainer.png", { maxH: 1150 });

  await browser.close();
  console.log("done ->", OUT);
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
