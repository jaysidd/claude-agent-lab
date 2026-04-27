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

  test("slash command popover autocompletes when typing /", async ({ page }) => {
    await page.goto("/");
    await page.locator(".agent-item", { hasText: "Main" }).click();
    const input = page.locator("#input");
    await input.click();
    await input.pressSequentially("/", { delay: 30 });
    await expect(page.locator("#command-popover")).toBeVisible({ timeout: 5_000 });
    // Sanity: at least 12 commands appear; exact count is allowed to grow.
    const count = await page.locator(".command-item").count();
    expect(count).toBeGreaterThanOrEqual(12);

    // Narrow to /think — should show 3 items
    await input.pressSequentially("think", { delay: 30 });
    await expect(page.locator(".command-item")).toHaveCount(3);

    // Escape closes the popover
    await page.keyboard.press("Escape");
    await expect(page.locator("#command-popover")).toBeHidden();
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
    // Wait for the initial status probe so label + disabled state are
    // guaranteed consistent before we assert on them.
    const statusPromise = page.waitForResponse((r) =>
      r.url().includes("/api/whisprdesk/status"),
    );
    await page.goto("/");
    await statusPromise;
    // Give the app.js handler one tick to apply the DOM updates
    await page.waitForTimeout(50);

    const label = (await page.locator("#whisprdesk-label").textContent()) ?? "";
    const micDisabled = await page.locator("#mic-btn").isDisabled();
    if (/off|unreachable|error/i.test(label)) {
      expect(micDisabled).toBe(true);
    } else {
      expect(micDisabled).toBe(false);
    }
  });

  test("slash command /export refuses on empty conversation", async ({ page }) => {
    await page.goto("/");
    await page.locator(".agent-item", { hasText: "Main" }).click();
    // Make sure the conversation is empty
    await page.locator("#reset-btn").click();

    await page.locator("#input").fill("/export");
    await page.keyboard.press("Enter");
    await expect(page.locator(".msg.agent .msg-body").last()).toContainText(
      /empty/i,
    );
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

  test("C16b — task queue persists via SQLite + wire shape preserved", async ({ request }) => {
    // Tasks round-trip through SQLite (durable across server restarts).
    // POST returns the C03-shape JSON; GET /api/tasks lists it back.
    const created = await request.post("http://localhost:3333/api/task", {
      data: {
        description: "C16b QA — persistence smoke",
        priority: "high",
        agentId: "ops",
      },
    });
    expect(created.ok()).toBeTruthy();
    const task = await created.json();
    expect(task.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(task.status).toBe("queued");
    expect(task.priority).toBe("high");
    expect(task.assignedAgent).toBe("ops");

    const listed = await (await request.get("http://localhost:3333/api/tasks")).json();
    const found = listed.find((t: { id: string }) => t.id === task.id);
    expect(found).toBeDefined();
    expect(found.status).toBe("queued");

    // Cleanup: hard-cancel via raw API would need a /cancel route which doesn't
    // exist; we leave the row. pruneCompletedTasks only touches terminal rows,
    // and the kanban surfaces only the most recent so this stays out of the way.
    // Tracked: future tests should add a /cancel route or accept the leftover.
  });

  test("C16b — DELETE on queued task returns 409 with current state", async ({ request }) => {
    // Reviewer R2 fix: hard-delete is constrained to terminal states.
    const created = await request.post("http://localhost:3333/api/task", {
      data: { description: "C16b QA — delete-on-queued", priority: "low", agentId: "main" },
    });
    const task = await created.json();

    const res = await request.delete(`http://localhost:3333/api/task/${task.id}`);
    expect(res.status()).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/terminal/i);
    expect(body.task.id).toBe(task.id);
    expect(body.task.status).toBe("queued");
  });

  test("C16b — DELETE on missing task is idempotent", async ({ request }) => {
    // Idempotent 200 OK so the UI can fire-and-forget on stale IDs.
    const res = await request.delete(
      "http://localhost:3333/api/task/00000000-0000-0000-0000-000000000000",
    );
    expect(res.status()).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test("C16b — POST /api/task validates priority enum", async ({ request }) => {
    // Priority must be one of low/medium/high. Anything else is rejected at
    // the route boundary, before the queue's enqueue is called.
    const res = await request.post("http://localhost:3333/api/task", {
      data: { description: "bad", priority: "urgent" },
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toMatch(/priority/i);
  });

  test("C16b — POST /api/task validates description type", async ({ request }) => {
    const res = await request.post("http://localhost:3333/api/task", {
      data: { description: 42, priority: "low" },
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toMatch(/description/i);
  });
});
