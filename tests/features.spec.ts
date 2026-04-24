import { test, expect, type Page } from "@playwright/test";

test.describe("Command Center — new features smoke (no engine)", () => {
  test("memory panel: open, add, list, delete", async ({ page, request }) => {
    // Clean slate
    await request.delete("http://localhost:3333/api/memories");

    await page.goto("/");
    await page.locator("#memory-btn").click();
    await expect(page.locator("#memory-modal")).toBeVisible();

    await page.locator("#memory-content").fill("Likes concise replies");
    await page.locator("#memory-create-btn").click();

    const card = page.locator(".memory-card").first();
    await expect(card).toBeVisible();
    await expect(card.locator(".memory-content")).toContainText("Likes concise replies");
    await expect(card.locator(".memory-badge")).toHaveText("preference");

    // Count badge updates
    await expect(page.locator("#memory-count")).toHaveText("1");

    // Delete
    await card.locator(".memory-delete").click();
    await expect(page.locator(".memory-card")).toHaveCount(0);
  });

  test("slash command /agents renders a system message", async ({ page }) => {
    await page.goto("/");
    await page.locator(".agent-item", { hasText: "Main" }).click();
    await page.locator("#input").fill("/agents");
    await page.keyboard.press("Enter");

    const lastAgentMsg = page.locator(".msg.agent .msg-body").last();
    await expect(lastAgentMsg).toContainText("Available agents");
    await expect(lastAgentMsg).toContainText("Main");
    await expect(lastAgentMsg).toContainText("Comms");
    await expect(lastAgentMsg).toContainText("Content");
    await expect(lastAgentMsg).toContainText("Ops");
  });

  test("slash command /help lists commands", async ({ page }) => {
    await page.goto("/");
    await page.locator(".agent-item", { hasText: "Main" }).click();
    await page.locator("#input").fill("/help");
    await page.keyboard.press("Enter");
    await expect(page.locator(".msg.agent .msg-body").last()).toContainText("Slash commands");
  });

  test("slash command /model aliases switch the active model", async ({ page }) => {
    await page.goto("/");
    await page.locator(".agent-item", { hasText: "Main" }).click();
    await page.locator("#input").fill("/model haiku");
    await page.keyboard.press("Enter");
    await expect(page.locator("#model-select")).toHaveValue(/haiku/i, { timeout: 5_000 });
    // Reset back to default
    await page.locator("#input").fill("/model sonnet");
    await page.keyboard.press("Enter");
    await expect(page.locator("#model-select")).toHaveValue(/sonnet/i, { timeout: 5_000 });
  });

  test("plan mode toggle turns on and off", async ({ page, request }) => {
    await page.goto("/");
    await page.locator(".agent-item", { hasText: "Ops" }).click();

    const toggle = page.locator("#plan-toggle");
    const checkbox = page.locator("#plan-checkbox");
    await expect(checkbox).not.toBeChecked();

    await checkbox.check();
    await expect(toggle).toHaveClass(/active/);

    const statusRes = await request.get("http://localhost:3333/api/plan/ops");
    expect(await statusRes.json()).toMatchObject({ enabled: true });

    await checkbox.uncheck();
    await expect(toggle).not.toHaveClass(/active/);
  });

  test("markdown renders in completed agent messages", async ({ page }) => {
    // Use the slash command path — it writes markdown directly to the history
    // without needing the engine. /agents produces bold + list output.
    await page.goto("/");
    await page.locator(".agent-item", { hasText: "Main" }).click();
    await page.locator("#input").fill("/agents");
    await page.keyboard.press("Enter");

    const bubble = page.locator(".msg.agent .msg-body.markdown").last();
    await expect(bubble).toBeVisible();
    // Bold heading
    await expect(bubble.locator("strong", { hasText: "Available agents" })).toBeVisible();
    // List
    await expect(bubble.locator("li")).toHaveCount(4);
  });
});
