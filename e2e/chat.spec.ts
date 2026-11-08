import { expect, test, type Browser, type Page } from "@playwright/test";

// The online table's chat room and quick phrases, tapped through by two
// players: in the lobby, at the table, back after a reload, and muted.

async function player(browser: Browser, errors: string[]): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 844, height: 390 } });
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
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

const chatButton = (p: Page) => p.locator(".play-chat-button");
async function say(p: Page, text: string) {
  await p.getByRole("textbox", { name: "Message" }).fill(text);
  await p.getByRole("button", { name: "Send", exact: true }).click();
  await expect(p.getByRole("textbox", { name: "Message" })).toHaveValue("");
}

test("online: the chat room in the lobby and at the table, quick phrases, mute", async ({ browser }) => {
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

  // In the lobby: a count on the button, then the line once it's opened.
  await chatButton(amy).click();
  await say(amy, "hello from the lobby");
  await expect(chatButton(bo).locator(".play-chat-count")).toHaveText("1");
  await chatButton(bo).click();
  await expect(bo.locator(".play-chat-lines")).toContainText("Amy");
  await expect(bo.locator(".play-chat-lines")).toContainText("hello from the lobby");
  await expect(chatButton(bo).locator(".play-chat-count")).toHaveCount(0);
  await chatButton(bo).click();
  await chatButton(amy).click();

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

  // At the table: the line as a bubble by the name, and in the room.
  await chatButton(bo).click();
  await say(bo, "good luck");
  await expect(amy.locator(".play-badge .play-bubble", { hasText: "good luck" })).toBeVisible();
  await expect(chatButton(amy).locator(".play-chat-count")).toHaveText("1");
  await chatButton(amy).click();
  await expect(amy.locator(".play-chat-lines")).toContainText("good luck");
  await expect(amy.locator(".play-chat-lines")).toContainText("hello from the lobby");

  // Quick phrases: the longer list, one sent - opening them shuts the chat.
  await amy.getByRole("button", { name: "Send a reaction" }).click();
  await expect(amy.locator(".play-chat")).toHaveCount(0);
  await expect(amy.locator(".play-reactions button")).toHaveCount(24);
  await amy.locator(".play-reactions button", { hasText: "勁喎！" }).click();
  await expect(bo.locator(".play-badge .play-bubble", { hasText: "勁喎！" })).toBeVisible();

  // Back after a reload: what was said is still there.
  await bo.reload();
  await expect(bo.locator("canvas.play-gl")).toBeVisible({ timeout: 30_000 });
  await chatButton(bo).click();
  await expect(bo.locator(".play-chat-lines")).toContainText("hello from the lobby");
  await expect(bo.locator(".play-chat-lines")).toContainText("good luck");

  // Amy mutes Bo: his lines go from her room, and new ones don't count.
  await amy.getByRole("button", { name: "Game menu" }).click();
  const row = amy.locator(".play-menu-row", { hasText: "Voice/chat: Bo" });
  await row.getByRole("button", { name: "Off", exact: true }).click();
  await amy.getByRole("button", { name: "Game menu" }).click();
  await say(bo, "you can't see this");
  await bo.waitForTimeout(800);
  await expect(chatButton(amy).locator(".play-chat-count")).toHaveCount(0);
  await expect(amy.locator(".play-badge .play-bubble", { hasText: "you can't see this" })).toHaveCount(0);
  await chatButton(amy).click();
  await expect(amy.locator(".play-chat-lines")).not.toContainText("good luck");
  await expect(amy.locator(".play-chat-lines")).toContainText("hello from the lobby");

  expect(errors, "errors on the page").toEqual([]);
});
