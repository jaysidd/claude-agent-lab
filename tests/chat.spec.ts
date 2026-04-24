import { test, expect } from "@playwright/test";

test.describe("Command Center — chat against real SDK @engine", () => {
  test.setTimeout(120_000);

  test("sending a message to Main yields a streaming reply @engine", async ({ page }) => {
    await page.goto("/");
    await page.locator(".agent-item", { hasText: "Main" }).click();

    const input = page.locator("#input");
    await input.fill("Reply with exactly the word OK, no punctuation.");
    await page.keyboard.press("Enter");

    // User bubble appears immediately
    await expect(page.locator(".msg.user").last()).toContainText("Reply with exactly");

    // Agent bubble appears; becomes non-empty within the timeout
    const agentBubble = page.locator(".msg.agent .msg-body").last();
    await expect(agentBubble).not.toHaveClass(/streaming-empty/, { timeout: 30_000 });
    await expect(agentBubble).toContainText("OK", { timeout: 30_000 });

    // Footer shows model + auth
    const footer = page.locator(".msg.agent .msg-footer").last();
    await expect(footer).toContainText(/Sonnet|Opus|Haiku/);
    await expect(footer).toContainText(/Max plan|API key/i);
  });

  test("task classifier routes an email task to Comms @engine", async ({ page }) => {
    await page.goto("/");
    await page.locator("#tasks-btn").click();
    await expect(page.locator("#tasks-modal")).toBeVisible();

    await page.locator("#task-description").fill("Draft a quick thank-you email to a client");
    await page.locator("#task-create-btn").click();

    const card = page.locator(".task-card").first();
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card.locator(".task-card-agent")).toContainText("Comms", { timeout: 30_000 });

    // Clean up
    await card.locator("button", { hasText: "Delete" }).click();
  });
});
