import { test, expect } from "@playwright/test";

test.describe("Command Center — smoke (no engine)", () => {
  test("loads and shows the four agents", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveTitle(/Command Center/);

    // All four agents render in the sidebar
    for (const name of ["Main", "Comms", "Content", "Ops"]) {
      await expect(page.locator(".agent-name", { hasText: name })).toBeVisible();
    }
  });

  test("each agent card shows a model chip", async ({ page }) => {
    await page.goto("/");
    const chips = page.locator(".agent-model-chip");
    await expect(chips).toHaveCount(4);
    // at least one shows Opus (Content agent)
    await expect(chips.filter({ hasText: /Opus/i })).toHaveCount(1);
    // three show Sonnet (Main/Comms/Ops)
    await expect(chips.filter({ hasText: /Sonnet/i })).toHaveCount(3);
  });

  test("selecting an agent updates the chat header", async ({ page }) => {
    await page.goto("/");
    await page.locator(".agent-item", { hasText: "Content" }).click();
    await expect(page.locator("#chat-title")).toContainText("Content");
    await expect(page.locator("#chat-sub")).toContainText(/YouTube|scripts/i);
  });

  test("model selector reflects the active agent's current model", async ({ page }) => {
    await page.goto("/");
    await page.locator(".agent-item", { hasText: "Content" }).click();
    // Content defaults to Opus
    await expect(page.locator("#model-select")).toHaveValue(/opus/i);

    await page.locator(".agent-item", { hasText: "Main" }).click();
    await expect(page.locator("#model-select")).toHaveValue(/sonnet/i);
  });

  test("folder picker opens with a browsable list", async ({ page }) => {
    await page.goto("/");
    await page.locator("#cwd-pill").click();
    await expect(page.locator("#cwd-modal")).toBeVisible();
    await expect(page.locator("#browse-list li").first()).toBeVisible();
    await page.locator("#cwd-cancel").click();
    await expect(page.locator("#cwd-modal")).toBeHidden();
  });

  test("task board opens and closes", async ({ page }) => {
    await page.goto("/");
    await page.locator("#tasks-btn").click();
    await expect(page.locator("#tasks-modal")).toBeVisible();
    await expect(page.locator(".task-col")).toHaveCount(3);
    await page.locator("#tasks-close").click();
    await expect(page.locator("#tasks-modal")).toBeHidden();
  });

  test("@file autocomplete popover appears on typing @", async ({ page }) => {
    await page.goto("/");
    await page.locator(".agent-item", { hasText: "Ops" }).click();
    const input = page.locator("#input");
    await input.click();

    // Wait for the /api/files response triggered by typing @
    const [resp] = await Promise.all([
      page.waitForResponse((r) => r.url().includes("/api/files")),
      input.pressSequentially("Read @", { delay: 30 }),
    ]);
    expect(resp.status()).toBe(200);

    // With focus held, the popover should be present and populated
    await expect(page.locator(".file-item").first()).toBeVisible();
    expect(await page.locator("#file-popover").evaluate((el) => el.classList.contains("hidden")))
      .toBe(false);
  });
});
