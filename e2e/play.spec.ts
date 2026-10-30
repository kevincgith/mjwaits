import { expect, test, type Page } from "@playwright/test";

// Any error on the page fails the test - and says what it was. So does a
// reload mid-game (it'd drop you out of Play): the page loads once.
const pageErrors = new WeakMap<Page, string[]>();
test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  pageErrors.set(page, errors);
  page.on("pageerror", (e) => errors.push(`${e.message}\n${e.stack ?? ""}`));
  page.on("console", (m) => m.type() === "error" && !/vibrate|favicon/i.test(m.text()) && errors.push(m.text()));
  let loads = 0;
  page.on("load", () => ++loads > 1 && errors.push(`the page reloaded (${page.url()})`));
  // These flows tap Legacy's table, its tiles page elements (see
  // lib/playRenderer.ts); the WebGL table's own test sets it back.
  await page.addInitScript(() => localStorage.setItem("mjwaits.playRenderer", "dom"));
});
test.afterEach(async ({ page }) => {
  expect(pageErrors.get(page), "errors on the page").toEqual([]);
});

// Play, tapped through as a player would: real clicks on the buttons, found
// by what they say. Each step checks the tap did what it should - so a
// button that's there but does nothing fails here, not on someone's phone.

// The Play tab, its Full game (the start screen), then one of its items.
async function openApp(page: Page, item: string) {
  await page.goto("./");
  // (A tap in the first moment after load can go unheeded: tapped again till it takes.)
  const tab = page.getByRole("button", { name: "Play", exact: true });
  await expect(async () => {
    await tab.click();
    await expect(tab).toHaveAttribute("aria-pressed", "true", { timeout: 1000 });
  }).toPass();
  await page.locator("button", { hasText: "Full game" }).first().click();
  await page.locator(".ph-item", { hasText: item }).click();
}

const gameMenu = (page: Page) => page.getByRole("button", { name: "Game menu" });
const myPile = (page: Page) => page.locator(".play-swap-pond.play-pond-bottom .play-swap-tile");
const myPond = (page: Page) => page.locator(".play-pond-bottom .play-pond-tile");
const drawnTile = (page: Page) => page.locator(".play-hand-tile.is-drawn");

// 換牌 through to its end: 放牌 your picked tiles each round, 攞牌 (an even
// blind take) on your turn - each tap checked to have landed.
async function playSwap(page: Page) {
  const give = page.getByRole("button", { name: /^Give these \d+$/ });
  const take = page.getByRole("button", { name: /^Take \d+ evenly, blind$/ });
  await expect(give).toBeVisible({ timeout: 60_000 });
  let gave = 0;
  let took = 0;
  let quiet = 0;
  const until = Date.now() + 150_000;
  while (Date.now() < until) {
    if ((await give.isVisible()) && (await give.isEnabled())) {
      const n = Number((await give.getAttribute("aria-label"))!.match(/\d+/)![0]);
      await give.click();
      // Given: your pile is laid out, and the button's gone.
      await expect(myPile(page), "放牌 should lay your tiles out").toHaveCount(n, { timeout: 5_000 });
      await expect(give).toBeHidden({ timeout: 5_000 });
      gave++;
    } else if ((await take.isVisible()) && (await take.isEnabled())) {
      await take.click();
      await expect(take, "攞牌 should take").toBeHidden({ timeout: 5_000 });
      took++;
    } else if (await drawnTile(page).isVisible()) {
      break; // the swap's over: someone's turn (yours, here)
    } else if (gave > 0 && (await page.locator(".play-swap-bar").count()) === 0) {
      // The bar gone - and staying gone (between rounds the piles go a moment).
      if (++quiet >= 12) break;
      await page.waitForTimeout(150);
      continue;
    }
    quiet = 0;
    await page.waitForTimeout(150);
  }
  expect(gave, "gave at least once").toBeGreaterThan(0);
  expect(took, "took at least once").toBeGreaterThan(0);
  await expect(page.locator(".play-swap-bar")).toHaveCount(0);
}

// Wait for your turn (passing on any call offered), then throw the drawn
// tile: tap it, tap again - and see it land in your pond.
async function discardOnce(page: Page) {
  const pass = page.locator(".play-call", { hasText: /^過$/ });
  const until = Date.now() + 120_000;
  while (!(await drawnTile(page).isVisible())) {
    if (Date.now() > until) throw new Error("your turn never came");
    if (await pass.isVisible()) await pass.click();
    await page.waitForTimeout(150);
  }
  const before = await myPond(page).count();
  await drawnTile(page).click();
  await expect(page.getByText("Tap again to discard")).toBeVisible({ timeout: 5_000 });
  await drawnTile(page).click();
  await expect(myPond(page), "the second tap should throw the tile").toHaveCount(before + 1, { timeout: 5_000 });
}

// 自動 on and off, from the button.
async function autoplayToggles(page: Page) {
  const auto = page.getByRole("button", { name: "自動 Autoplay" });
  await auto.click();
  await expect(auto).toHaveAttribute("aria-pressed", "true");
  await auto.click();
  await expect(auto).toHaveAttribute("aria-pressed", "false");
}

test("single player: the setup page, the menu, 記牌器, 換牌's give and take, a discard, 自動", async ({ page }) => {
  await openApp(page, "New game");
  // A new game's rules first (開局): 換牌 on for 東圈, then Start.
  await expect(page.getByRole("dialog", { name: "New game" })).toBeVisible();
  await page.locator(".play-setup .play-menu-link", { hasText: "換牌" }).click();
  const east = page.locator(".play-swap-winds button", { hasText: "東" });
  if (!(await east.evaluate((b) => b.classList.contains("toggle-on")))) await east.click();
  await page.locator(".play-swap-confirm").click();
  await page.locator(".play-setup-start").click();
  await expect(page.getByRole("dialog", { name: "New game" })).toBeHidden();
  await expect(page.locator(".play-felt")).toBeVisible();

  // The menu opens and closes; 記牌器 opens and closes.
  await gameMenu(page).click();
  await expect(page.locator(".play-menu")).toBeVisible();
  await gameMenu(page).click();
  await expect(page.locator(".play-menu")).toBeHidden();
  await page.getByRole("button", { name: "Tile tracker" }).click();
  const tracker = page.getByRole("dialog", { name: "Tile tracker" });
  await expect(tracker).toBeVisible();
  await tracker.getByRole("button", { name: "Close" }).click();
  await expect(tracker).toBeHidden();

  await playSwap(page);
  await discardOnce(page);
  await autoplayToggles(page);
});

test("online: a table with bots - 換牌's give and take, a discard, 自動", async ({ page }) => {
  await openApp(page, "Play online");
  await page.getByPlaceholder("Your name").fill("Tester");
  await page.getByRole("button", { name: /New table/ }).click();
  await expect(page.locator(".ot-rules")).toBeVisible({ timeout: 30_000 });

  // Bots in the three empty seats (an empty seat's menu has no "-" to remove).
  for (let i = 0; i < 3; i++) {
    const empty = page.locator("select").filter({ hasNot: page.locator('option[value="-"]') }).first();
    await empty.selectOption("casual");
    await expect(page.locator("select").filter({ hasNot: page.locator('option[value="-"]') })).toHaveCount(2 - i);
  }
  const setting = (label: string, seg: string) => page.locator(".ot-rules > *", { hasText: label }).getByRole("button", { name: seg, exact: true }).click();
  await setting("Turn timer", "Off");
  await setting("換牌 Swap tiles", "Usual");
  await setting("Rounds that swap", "東圈");
  await setting("Bot speed", "Fast");
  await page.getByRole("button", { name: /Start the game/ }).click();
  await expect(page.locator(".play-felt")).toBeVisible({ timeout: 30_000 });

  await playSwap(page);
  await discardOnce(page);
  await autoplayToggles(page);
});

// Play's own table, drawn by WebGL: its tiles are on a canvas, so a tap is
// aimed at your drawn tile's place (the right end of your row) and checked
// by the game saved after it.
test("the WebGL table: a discard by tapping the canvas, 自動", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("mjwaits.playRenderer", "webgl"));
  await openApp(page, "New game");
  await page.locator(".play-setup-start").click();
  await expect(page.locator("canvas.play-gl")).toBeVisible({ timeout: 30_000 });
  const saved = () =>
    page.evaluate(() => {
      const g = JSON.parse(localStorage.getItem("mjwaits.play") ?? "{}").game;
      return { mine: g?.phase?.kind === "turn" && g.phase.seat === 0 && !!g.phase.drawn, thrown: g?.players?.[0]?.discards?.length ?? 0 };
    });
  const pass = page.locator(".play-call", { hasText: /^過$/ });
  const until = Date.now() + 120_000;
  while (!(await saved()).mine) {
    if (Date.now() > until) throw new Error("your turn never came");
    if (await pass.isVisible()) await pass.click();
    await page.waitForTimeout(150);
  }
  const before = (await saved()).thrown;
  const row = (await page.locator(".play-hand.is-gl").boundingBox())!;
  const at = { x: row.x + row.width - row.height * 0.3, y: row.y + row.height * 0.55 };
  // (Tapped again till it takes: a tap while the deal's dice still roll goes unheeded.)
  await expect(async () => {
    await page.mouse.click(at.x, at.y);
    await expect(page.getByText("Tap again to discard")).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 20_000 });
  await page.mouse.click(at.x, at.y - row.height * 0.1);
  await expect.poll(async () => (await saved()).thrown, { message: "the second tap should throw the tile", timeout: 5_000 }).toBe(before + 1);
  await autoplayToggles(page);
});
