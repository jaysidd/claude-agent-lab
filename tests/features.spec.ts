import { test, expect, type Page } from "@playwright/test";

test.describe("Command Center — new features smoke (no engine)", () => {
  test("memory panel: open, add, list, delete", async ({ page, request }) => {
    // Clean slate — iterate and delete
    const existing = await (await request.get("http://localhost:3333/api/memories")).json();
    for (const m of existing) {
      await request.delete(`http://localhost:3333/api/memories/${m.id}`);
    }

    await page.goto("/");
    await page.locator("#memory-btn").click();
    await expect(page.locator("#memory-modal")).toBeVisible({ timeout: 5_000 });

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

  test("plan mode toggle turns on and off", async ({ page }) => {
    await page.goto("/");
    await page.locator(".agent-item", { hasText: "Ops" }).click();

    const toggle = page.locator("#plan-toggle");
    const checkbox = page.locator("#plan-checkbox");
    await expect(checkbox).not.toBeChecked();

    await checkbox.check();
    await expect(toggle).toHaveClass(/active/);

    await checkbox.uncheck();
    await expect(toggle).not.toHaveClass(/active/);
  });

  test("whisprdesk status endpoint reports configured state", async ({ request }) => {
    const res = await request.get("http://localhost:3333/api/whisprdesk/status");
    expect(res.ok()).toBe(true);
    const data = await res.json();
    expect(data).toHaveProperty("configured");
    // If token isn't set, UI reports "off" gracefully
    if (!data.configured) expect(data).toEqual({ configured: false });
    // If it is, the reachable field should be present
    if (data.configured) expect(typeof data.reachable).toBe("boolean");
  });

  test("mic button reflects whisprdesk availability", async ({ page }) => {
    await page.goto("/");
    const mic = page.locator("#mic-btn");
    // Either disabled (not configured or unreachable) or enabled (live);
    // the label must match.
    const label = await page.locator("#whisprdesk-label").textContent();
    const micDisabled = await mic.isDisabled();
    if (/off|unreachable|error/i.test(label ?? "")) {
      expect(micDisabled).toBe(true);
    } else {
      expect(micDisabled).toBe(false);
    }
  });

  test("settings modal opens and exposes whisprdesk + telegram sections", async ({ page, request }) => {
    // Reset any saved settings
    const existing = await request.get("http://localhost:3333/api/settings");
    const data = await existing.json();
    for (const v of data.values ?? []) {
      await request.delete(`http://localhost:3333/api/settings/${v.key}`);
    }

    await page.goto("/");
    await page.locator("#settings-btn").click();
    await expect(page.locator("#settings-modal")).toBeVisible();

    const sectionTitles = await page.locator(".settings-section h3").allTextContents();
    expect(sectionTitles).toEqual(expect.arrayContaining([expect.stringMatching(/WhisprDesk/i)]));
    expect(sectionTitles).toEqual(expect.arrayContaining([expect.stringMatching(/Telegram/i)]));

    // Save a non-secret value, confirm it persists via API
    await page.locator('input[data-key="whisprdesk.url"]').fill("http://127.0.0.1:9999");
    await page.locator("#settings-save").click();
    await expect(page.locator("#settings-save")).toHaveText("Save changes");

    const after = await (await request.get("http://localhost:3333/api/settings")).json();
    const saved = after.values.find((v) => v.key === "whisprdesk.url");
    expect(saved?.preview).toBe("http://127.0.0.1:9999");

    // Clean up
    await request.delete("http://localhost:3333/api/settings/whisprdesk.url");
  });

  test("built-in agents are read-only — PATCH and DELETE return 400", async ({ request }) => {
    const patch = await request.patch("http://localhost:3333/api/agents/main", {
      data: { description: "hijacked" },
    });
    expect(patch.status()).toBe(400);
    const patchBody = await patch.json();
    expect(patchBody.error).toMatch(/built-in/i);

    const del = await request.delete("http://localhost:3333/api/agents/main");
    expect(del.status()).toBe(400);
    const delBody = await del.json();
    expect(delBody.error).toMatch(/built-in/i);
  });

  test("custom agent delete flow via UI", async ({ page, request }) => {
    // Seed via API
    const created = await request.post("http://localhost:3333/api/agents", {
      data: {
        name: "Delete Me",
        emoji: "🗑",
        accent: "#ff77aa",
        description: "Scratch agent for the delete test",
        systemPrompt: "Say nothing.",
        allowedTools: [],
        model: "claude-sonnet-4-6",
      },
    });
    const agent = await created.json();

    await page.goto("/");
    const card = page.locator(".agent-item", { hasText: "Delete Me" });
    await expect(card).toBeVisible({ timeout: 5_000 });
    await card.locator(".agent-action-btn").click();
    await expect(page.locator("#agent-modal")).toBeVisible({ timeout: 5_000 });

    // Confirm dialog auto-accept
    page.on("dialog", (d) => d.accept());
    await page.locator("#agent-delete").click();
    await expect(page.locator("#agent-modal")).toBeHidden({ timeout: 5_000 });
    await expect(page.locator(".agent-item", { hasText: "Delete Me" })).toHaveCount(0, {
      timeout: 5_000,
    });

    // Server-side: agent is gone
    const list = await (await request.get("http://localhost:3333/api/agents")).json();
    expect(list.find((a) => a.id === agent.id)).toBeUndefined();
  });

  test("settings Telegram section renders disabled with 'coming soon' badge", async ({ page }) => {
    await page.goto("/");
    await page.locator("#settings-btn").click();
    await expect(page.locator("#settings-modal")).toBeVisible({ timeout: 5_000 });

    const telegramSection = page.locator(".settings-section", { hasText: /Telegram/i });
    await expect(telegramSection.locator(".section-badge")).toContainText(/coming soon/i);
    // Inputs inside Telegram section should be disabled
    const disabledInputs = telegramSection.locator("input[disabled]");
    expect(await disabledInputs.count()).toBeGreaterThan(0);
  });

  test("custom agent CRUD flow end-to-end", async ({ page, request }) => {
    await page.goto("/");
    await page.locator("#new-agent-btn").click();
    await expect(page.locator("#agent-modal")).toBeVisible();

    await page.locator("#agent-name").fill("Playwright Bot");
    await page.locator("#agent-emoji").fill("🎭");
    await page.locator("#agent-description").fill("Smoke test agent");
    await page.locator("#agent-system-prompt").fill("You are Playwright Bot. Only reply 'ok'.");
    // Check Read tool
    await page.locator('input[data-tool="Read"]').check();
    await page.locator("#agent-save").click();
    await expect(page.locator("#agent-modal")).toBeHidden();

    // It should appear in the sidebar
    await expect(page.locator(".agent-item", { hasText: "Playwright Bot" })).toBeVisible();

    // Edit it
    await page
      .locator(".agent-item", { hasText: "Playwright Bot" })
      .locator(".agent-action-btn")
      .click();
    await expect(page.locator("#agent-modal")).toBeVisible();
    await page.locator("#agent-description").fill("Updated description");
    await page.locator("#agent-save").click();
    await expect(page.locator("#agent-modal")).toBeHidden();
    await expect(
      page.locator(".agent-item", { hasText: "Playwright Bot" }).locator(".agent-desc"),
    ).toContainText("Updated description");

    // Delete via API to keep the test deterministic
    const list = await (await request.get("http://localhost:3333/api/agents")).json();
    const bot = list.find((a) => a.name === "Playwright Bot");
    if (bot) await request.delete(`http://localhost:3333/api/agents/${bot.id}`);
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
