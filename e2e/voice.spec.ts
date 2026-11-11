/// <reference lib="dom" />
import { expect, test, type Browser, type Locator, type Page } from "@playwright/test";

// The online table's walkie-talkie, tapped through by two players on one
// table: real presses of the button, and what reaches the other phone's
// speaker measured as it's played. The microphone is a steady 440 Hz tone
// (a headless browser's own stand-in hangs on some machines) - everything
// from there on is the real thing, and the tone should come out the same.

type Heard = { buffers: number; peak: number; crossings: number };
declare global {
  interface Window {
    __heard: Heard;
  }
}

async function player(browser: Browser, errors: string[]): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 844, height: 390 } });
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && !/vibrate|favicon|404|ERR_/i.test(m.text()) && errors.push(m.text()));
  // Every buffer the page plays: the voice's are 100 ms long.
  await page.addInitScript(() => {
    window.__heard = { buffers: 0, peak: 0, crossings: 0 };
    navigator.mediaDevices.getUserMedia = async () => {
      const ac = new AudioContext();
      await ac.resume();
      const tone = ac.createOscillator();
      const level = ac.createGain();
      const out = ac.createMediaStreamDestination();
      tone.frequency.value = 440;
      level.gain.value = 0.3;
      tone.connect(level).connect(out);
      tone.start();
      return out.stream;
    };
    const start = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (...args: Parameters<typeof start>) {
      const b = this.buffer;
      if (b && Math.abs(b.duration - 0.1) < 0.005) {
        window.__heard.buffers++;
        const data = b.getChannelData(0);
        window.__heard.peak = Math.max(window.__heard.peak, ...data);
        window.__heard.crossings = data.reduce((n, v, i) => n + (i > 0 && v >= 0 !== data[i - 1] >= 0 ? 1 : 0), 0);
      }
      return start.apply(this, args);
    };
  });
  await page.goto("./");
  const tab = page.getByRole("button", { name: "Play", exact: true });
  await expect(async () => {
    await tab.click();
    await expect(tab).toHaveAttribute("aria-pressed", "true", { timeout: 1000 });
  }).toPass();
  await page.locator("button", { hasText: "Full game" }).first().click();
  await page.locator(".ph-item", { hasText: "Play online" }).click();
  return page;
}

const heard = (p: Page) => p.evaluate(() => window.__heard);
const hold = async (p: Page, button: Locator) => {
  const box = (await button.boundingBox())!;
  await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await p.mouse.down();
};

test("online: hold to talk, one at a time, heard at the other phone; mute", async ({ browser }) => {
  const errors: string[] = [];
  const amy = await player(browser, errors);
  await amy.getByPlaceholder("Your name").fill("Amy");
  await amy.getByRole("button", { name: /New table/ }).click();
  await expect(amy.locator(".ot-rules")).toBeVisible({ timeout: 30_000 });
  const code = new URL(amy.url()).searchParams.get("table")!;

  const bo = await player(browser, errors);
  await bo.getByPlaceholder("Your name").fill("Bo");
  await bo.locator(".ot-join input").fill(code);
  await bo.locator(".ot-join button").first().click();
  await expect(amy.getByText("Bo").first()).toBeVisible({ timeout: 30_000 });

  for (let i = 0; i < 2; i++) {
    const empty = amy.locator("select").filter({ hasNot: amy.locator('option[value="-"]') }).first();
    await empty.selectOption("casual");
    await expect(amy.locator("select").filter({ hasNot: amy.locator('option[value="-"]') })).toHaveCount(1 - i);
  }
  const setting = (label: string, seg: string) => amy.locator(".ot-rules > *", { hasText: label }).getByRole("button", { name: seg, exact: true }).click();
  await setting("Turn timer", "Off");
  await setting("換牌 Swap tiles", "Off");
  await amy.getByRole("button", { name: /Start the game/ }).click();
  for (const p of [amy, bo]) await expect(p.locator("canvas.play-gl")).toBeVisible({ timeout: 30_000 });

  const amyTalk = amy.locator(".play-talk");
  const boTalk = bo.locator(".play-talk");
  await expect(amyTalk).toBeVisible();
  await expect(boTalk).toBeVisible();
  // Big enough to hold, in the top-right corner, above the player's card there.
  const button = (await amyTalk.boundingBox())!;
  const card = (await amy.locator(".play-badge.at-right").boundingBox())!;
  expect(button.width).toBeGreaterThanOrEqual(60);
  expect(button.x + button.width / 2).toBeGreaterThan(700);
  expect(button.y + button.height).toBeLessThanOrEqual(card.y);
  // (The tap that wakes a phone's audio.)
  await bo.locator(".play-bar").click();

  // Amy holds: live for her, a mic by her name and a busy button for Bo.
  await hold(amy, amyTalk);
  await expect(amyTalk).toHaveClass(/is-live/, { timeout: 10_000 });
  await expect(bo.locator(".play-badge .play-talking")).toHaveCount(1);
  await expect(boTalk).toHaveClass(/is-busy/);

  // One at a time: Bo's press while she talks does nothing.
  await hold(bo, boTalk);
  await bo.waitForTimeout(400);
  await expect(boTalk).not.toHaveClass(/is-live|is-opening/);
  await bo.mouse.up();

  await expect.poll(async () => (await heard(bo)).buffers, { timeout: 10_000 }).toBeGreaterThan(15);
  // The tone arrives at its own level and pitch (440 Hz: 88 crossings in 100 ms).
  const got = await heard(bo);
  expect(got.peak).toBeGreaterThan(0.2);
  expect(got.peak).toBeLessThan(0.4);
  expect(Math.abs(got.crossings - 88)).toBeLessThanOrEqual(4);
  expect((await heard(amy)).buffers, "she doesn't hear herself").toBe(0);

  // She lets go: the mic is off and the table is free.
  await amy.mouse.up();
  await expect(amyTalk).not.toHaveClass(/is-live/);
  await expect(bo.locator(".play-talking")).toHaveCount(0);
  await expect(boTalk).not.toHaveClass(/is-busy/);

  // And the other way.
  await amy.locator(".play-bar").click();
  await hold(bo, boTalk);
  await expect(boTalk).toHaveClass(/is-live/, { timeout: 10_000 });
  await expect.poll(async () => (await heard(amy)).buffers, { timeout: 10_000 }).toBeGreaterThan(5);
  await bo.mouse.up();
  await expect(amy.locator(".play-talking")).toHaveCount(0);

  // Bo mutes Amy: she still shows as talking, but nothing plays.
  await bo.getByRole("button", { name: "Game menu" }).click();
  const row = bo.locator(".play-menu-row", { hasText: "Voice/chat: Amy" });
  await row.getByRole("button", { name: "Off", exact: true }).click();
  await expect(row.getByRole("button", { name: "Off", exact: true })).toHaveAttribute("aria-pressed", "true");
  await bo.getByRole("button", { name: "Game menu" }).click();
  await amy.waitForTimeout(500);
  const before = (await heard(bo)).buffers;
  await hold(amy, amyTalk);
  await expect(amyTalk).toHaveClass(/is-live/, { timeout: 10_000 });
  await expect(bo.locator(".play-badge .play-talking")).toHaveCount(1);
  await amy.waitForTimeout(1500);
  await amy.mouse.up();
  expect((await heard(bo)).buffers).toBe(before);

  // The rest of the table's top bar still works: a reaction reaches Amy.
  await bo.getByRole("button", { name: "Send a reaction" }).click();
  await bo.locator(".play-reactions button").first().click();
  await expect(amy.locator(".play-bubble")).toBeVisible();

  expect(errors, "errors on the page").toEqual([]);
});
