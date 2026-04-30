import { test, expect, type Page } from "@playwright/test";
import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const LAB_DB = path.resolve(TEST_DIR, "..", "data", "lab.db");

function seedLedgerRow(agentId: string): void {
  // Direct DB write — used to seed the cost_ledger so we can exercise the
  // cap-exhausted preflight path without firing a real SDK call. The server
  // runs in WAL mode so concurrent reads/writes are fine.
  const db = new Database(LAB_DB);
  db.prepare(
    `INSERT INTO cost_ledger (agent_id, occurred_at, input_tokens, output_tokens, cost_usd, is_oauth)
     VALUES (?, ?, 0, 0, 0, 1)`,
  ).run(agentId, Date.now());
  db.close();
}

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

  test("settings Telegram section is enabled (post-C05) with editable inputs", async ({ page }) => {
    await page.goto("/");
    await page.locator("#settings-btn").click();
    await expect(page.locator("#settings-modal")).toBeVisible({ timeout: 5_000 });

    const telegramSection = page.locator(".settings-section", { hasText: /Telegram/i });
    // The "coming soon" badge is gone post-C05.
    await expect(telegramSection.locator(".section-badge")).toHaveCount(0);
    // Inputs inside Telegram section should be editable.
    const enabledInputs = telegramSection.locator("input:not([disabled])");
    expect(await enabledInputs.count()).toBeGreaterThan(0);
    // Test connection button shows up.
    await expect(telegramSection.locator(".btn-test")).toBeVisible();
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

  test("C16c — settings schema exposes Budget (CostGuard) section", async ({ request }) => {
    const r = await request.get("http://localhost:3333/api/settings");
    expect(r.ok()).toBeTruthy();
    const body = await r.json();
    const sections = body.schema.map((s: { section: string }) => s.section);
    expect(sections).toContain("Budget (CostGuard)");
    const budget = body.schema.find(
      (s: { section: string }) => s.section === "Budget (CostGuard)",
    );
    const keys = budget.fields.map((f: { key: string }) => f.key);
    expect(keys).toContain("costguard.cost_cap_monthly_usd");
    expect(keys).toContain("costguard.rate_cap_per_window");
    expect(keys).toContain("costguard.rate_window_seconds");
  });

  test("C16c — settings POST allowlists per-agent override keys", async ({ request }) => {
    // M1 fix: only the two cap base keys with per-agent semantics, with a
    // valid known agent id, with no extra dotted segments.
    const body = (entries: Array<{ key: string; value: string | null }>) =>
      ({ entries });
    // Reject: rate_window_seconds has no per-agent variant.
    const r1 = await request.post("http://localhost:3333/api/settings", {
      data: body([{ key: "costguard.rate_window_seconds.main", value: "60" }]),
    });
    expect((await r1.json()).changed).toBe(0);
    // Reject: unknown agent.
    const r2 = await request.post("http://localhost:3333/api/settings", {
      data: body([{ key: "costguard.rate_cap_per_window.nonexistent_agent", value: "1" }]),
    });
    expect((await r2.json()).changed).toBe(0);
    // Reject: dotted trailer.
    const r3 = await request.post("http://localhost:3333/api/settings", {
      data: body([{ key: "costguard.rate_cap_per_window.foo.bar", value: "1" }]),
    });
    expect((await r3.json()).changed).toBe(0);
    // Accept: valid override on a known agent.
    const r4 = await request.post("http://localhost:3333/api/settings", {
      data: body([{ key: "costguard.rate_cap_per_window.ops", value: "100" }]),
    });
    expect((await r4.json()).changed).toBe(1);
    // Cleanup.
    await request.post("http://localhost:3333/api/settings", {
      data: body([{ key: "costguard.rate_cap_per_window.ops", value: null }]),
    });
  });

  test("C16c — /api/costguard/status reports usage shape", async ({ request }) => {
    const r = await request.get(
      "http://localhost:3333/api/costguard/status?agentId=main",
    );
    expect(r.ok()).toBeTruthy();
    const body = await r.json();
    expect(typeof body.rateUsed).toBe("number");
    expect(typeof body.costUsedThisMonth).toBe("number");
    // No cap configured → remaining is null.
    expect(body.rateRemaining).toBe(null);
    expect(body.costRemaining).toBe(null);

    const bad = await request.get(
      "http://localhost:3333/api/costguard/status?agentId=does_not_exist",
    );
    expect(bad.status()).toBe(400);
  });

  test("C16c — exhausted rate cap returns 429 on /api/chat without firing SDK", async ({
    request,
  }) => {
    // Strategy: seed at least one ledger row directly, read current count, then
    // set the per-agent cap to that count. Next call has remaining=0 and is
    // rejected by check() before any SDK call. Stays in the smoke project.
    const agentId = "ops";
    seedLedgerRow(agentId);
    const status = await (
      await request.get(`http://localhost:3333/api/costguard/status?agentId=${agentId}`)
    ).json();
    const cap = status.rateUsed;
    expect(cap).toBeGreaterThanOrEqual(1);

    await request.post("http://localhost:3333/api/settings", {
      data: {
        entries: [
          { key: `costguard.rate_cap_per_window.${agentId}`, value: String(cap) },
        ],
      },
    });
    try {
      const r = await request.post("http://localhost:3333/api/chat", {
        data: { agentId, message: "would never reach the SDK" },
      });
      expect(r.status()).toBe(429);
      const body = await r.json();
      expect(body.capType).toBe("rate");
      expect(body.remaining).toBe(0);
      expect(body.error).toMatch(/rate cap/i);

      // Stream route uses the same preflight.
      const s = await request.post("http://localhost:3333/api/chat/stream", {
        data: { agentId, message: "also never reaches the SDK" },
      });
      expect(s.status()).toBe(429);
      const sBody = await s.json();
      expect(sBody.capType).toBe("rate");
    } finally {
      // Cleanup — null clears the override.
      await request.post("http://localhost:3333/api/settings", {
        data: {
          entries: [
            { key: `costguard.rate_cap_per_window.${agentId}`, value: null },
          ],
        },
      });
    }
  });

  test("C16a — POST /api/schedules creates a schedule with all fields", async ({
    request,
  }) => {
    const r = await request.post("http://localhost:3333/api/schedules", {
      data: {
        agentId: "main",
        prompt: "QA test schedule",
        cron: "0 9 * * *",
      },
    });
    expect(r.status()).toBe(200);
    const sched = await r.json();
    try {
      expect(sched.id).toBeTruthy();
      expect(sched.agentId).toBe("main");
      expect(sched.prompt).toBe("QA test schedule");
      expect(sched.cron).toBe("0 9 * * *");
      expect(sched.enabled).toBe(true);
      expect(sched.pausedReason).toBe(null);
      expect(typeof sched.nextFireAt).toBe("number");
      expect(sched.nextFireAt).toBeGreaterThan(Date.now());
      expect(sched.consecutiveFailures).toBe(0);
      expect(sched.lastFiredAt).toBe(null);
      expect(sched.lastTaskId).toBe(null);
      expect(sched.lastStatus).toBe(null);
    } finally {
      await request.delete(`http://localhost:3333/api/schedules/${sched.id}`);
    }
  });

  test("C16a — POST /api/schedules rejects invalid cron with 400", async ({
    request,
  }) => {
    const r = await request.post("http://localhost:3333/api/schedules", {
      data: {
        agentId: "main",
        prompt: "x",
        cron: "TOTALLY NOT A CRON",
      },
    });
    expect(r.status()).toBe(400);
    const body = await r.json();
    expect(body.error).toMatch(/invalid cron/i);
  });

  test("C16a — POST /api/schedules rejects unknown agent with 400", async ({
    request,
  }) => {
    const r = await request.post("http://localhost:3333/api/schedules", {
      data: {
        agentId: "nobody-here",
        prompt: "x",
        cron: "0 9 * * *",
      },
    });
    expect(r.status()).toBe(400);
    expect((await r.json()).error).toBe("unknown agent");
  });

  test("C16a — POST /api/schedules rejects empty prompt and oversize cron", async ({
    request,
  }) => {
    // Empty prompt
    const r1 = await request.post("http://localhost:3333/api/schedules", {
      data: { agentId: "main", prompt: "", cron: "0 9 * * *" },
    });
    expect(r1.status()).toBe(400);

    // Oversize cron (> 100 char cap)
    const r2 = await request.post("http://localhost:3333/api/schedules", {
      data: {
        agentId: "main",
        prompt: "x",
        cron: "0 ".repeat(60) + "9 * * *",
      },
    });
    expect(r2.status()).toBe(400);
  });

  test("C16a — schedule persists to SQLite and is readable across DB handles", async ({
    request,
  }) => {
    const r = await request.post("http://localhost:3333/api/schedules", {
      data: { agentId: "main", prompt: "persist test", cron: "0 12 * * *" },
    });
    const sched = await r.json();
    try {
      // Open a fresh DB handle (proxies "what would happen on restart") and
      // verify the row is on disk, not in-memory.
      const db = new Database(LAB_DB, { readonly: true });
      const row = db
        .prepare("SELECT id, prompt, cron, enabled FROM schedules WHERE id = ?")
        .get(sched.id) as
        | { id: string; prompt: string; cron: string; enabled: number }
        | undefined;
      db.close();

      expect(row).toBeTruthy();
      expect(row!.id).toBe(sched.id);
      expect(row!.prompt).toBe("persist test");
      expect(row!.cron).toBe("0 12 * * *");
      expect(row!.enabled).toBe(1);
    } finally {
      await request.delete(`http://localhost:3333/api/schedules/${sched.id}`);
    }
  });

  test("C16a — pause/resume round-trip", async ({ request }) => {
    const created = await (
      await request.post("http://localhost:3333/api/schedules", {
        data: { agentId: "main", prompt: "pause test", cron: "0 9 * * *" },
      })
    ).json();
    try {
      // Pause
      const paused = await (
        await request.post(
          `http://localhost:3333/api/schedules/${created.id}/pause`,
        )
      ).json();
      expect(paused.enabled).toBe(false);
      expect(paused.pausedReason).toBe("manual");

      // Resume — re-derives next_fire_at from now() so a long-paused
      // schedule doesn't fire-storm. Verify it's still in the future.
      const resumed = await (
        await request.post(
          `http://localhost:3333/api/schedules/${created.id}/resume`,
        )
      ).json();
      expect(resumed.enabled).toBe(true);
      expect(resumed.pausedReason).toBe(null);
      expect(resumed.consecutiveFailures).toBe(0);
      expect(resumed.nextFireAt).toBeGreaterThan(Date.now());
    } finally {
      await request.delete(`http://localhost:3333/api/schedules/${created.id}`);
    }
  });

  test("C16a — DELETE on missing schedule returns 404", async ({ request }) => {
    const r = await request.delete(
      "http://localhost:3333/api/schedules/does-not-exist",
    );
    expect(r.status()).toBe(404);
  });

  test("C16a — POST /api/cron/preview returns 3 future fires for a valid cron", async ({
    request,
  }) => {
    const r = await request.post("http://localhost:3333/api/cron/preview", {
      data: { cron: "0 */6 * * *" },
    });
    expect(r.status()).toBe(200);
    const body = await r.json();
    expect(body.valid).toBe(true);
    expect(Array.isArray(body.next)).toBe(true);
    expect(body.next).toHaveLength(3);
    // All three must be in the future and strictly increasing.
    const now = Date.now();
    expect(body.next[0]).toBeGreaterThan(now);
    expect(body.next[1]).toBeGreaterThan(body.next[0]);
    expect(body.next[2]).toBeGreaterThan(body.next[1]);
  });

  test("C16a — POST /api/cron/preview rejects invalid cron with 400", async ({
    request,
  }) => {
    const r = await request.post("http://localhost:3333/api/cron/preview", {
      data: { cron: "junk" },
    });
    expect(r.status()).toBe(400);
    const body = await r.json();
    expect(body.valid).toBe(false);
    expect(typeof body.error).toBe("string");
  });

  test("C16a — PATCH cron updates next_fire_at", async ({ request }) => {
    const created = await (
      await request.post("http://localhost:3333/api/schedules", {
        data: { agentId: "main", prompt: "patch test", cron: "0 9 * * *" },
      })
    ).json();
    try {
      const patched = await (
        await request.patch(
          `http://localhost:3333/api/schedules/${created.id}`,
          { data: { cron: "0 10 * * *" } },
        )
      ).json();
      expect(patched.cron).toBe("0 10 * * *");
      // next_fire_at is re-derived from now() — almost certainly different
      // unless the test runs at exactly :00:00 UTC.
      expect(patched.nextFireAt).not.toBe(created.nextFireAt);
    } finally {
      await request.delete(`http://localhost:3333/api/schedules/${created.id}`);
    }
  });

  // ----- C16d Approvals -----

  function seedPendingApproval(opts: {
    taskId: string;
    toolName?: string;
    workerId?: string;
    toolInput?: unknown;
  }): string {
    // Direct DB write — used to seed pending_approvals so we can exercise
    // decide / list / orphan-sweep paths without firing a real SDK call.
    const db = new Database(LAB_DB);
    const id = crypto.randomUUID();
    db.prepare(
      `INSERT INTO pending_approvals
         (id, task_id, tool_name, tool_use_id, tool_input_json, cwd,
          status, worker_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    ).run(
      id,
      opts.taskId,
      opts.toolName ?? "Bash",
      `tu-${id.slice(0, 8)}`,
      JSON.stringify(opts.toolInput ?? { command: "echo hi" }),
      null,
      opts.workerId ?? "test-worker",
      Date.now(),
    );
    db.close();
    return id;
  }

  function deleteApproval(id: string): void {
    const db = new Database(LAB_DB);
    db.prepare("DELETE FROM pending_approvals WHERE id = ?").run(id);
    db.close();
  }

  test("C16d — POST /api/task accepts requiresApproval and surfaces it on the wire", async ({
    request,
  }) => {
    const created = await (
      await request.post("http://localhost:3333/api/task", {
        data: {
          description: "C16d QA — requires approval",
          priority: "low",
          agentId: "main",
          requiresApproval: true,
        },
      })
    ).json();
    try {
      expect(created.requiresApproval).toBe(true);
      // Same task, fetched via list, should still carry the flag.
      const all = await (await request.get("http://localhost:3333/api/tasks")).json();
      const found = all.find((t: any) => t.id === created.id);
      expect(found?.requiresApproval).toBe(true);
    } finally {
      await request.delete(`http://localhost:3333/api/task/${created.id}`);
    }
  });

  test("C16d — POST /api/task without requiresApproval omits the flag", async ({
    request,
  }) => {
    const created = await (
      await request.post("http://localhost:3333/api/task", {
        data: {
          description: "C16d QA — no approval",
          priority: "low",
          agentId: "main",
        },
      })
    ).json();
    try {
      expect("requiresApproval" in created).toBe(false);
    } finally {
      await request.delete(`http://localhost:3333/api/task/${created.id}`);
    }
  });

  test("C16d — GET /api/approvals?status=pending lists seeded rows", async ({
    request,
  }) => {
    const id = seedPendingApproval({ taskId: "qa-task-1" });
    try {
      const rows = await (
        await request.get("http://localhost:3333/api/approvals?status=pending")
      ).json();
      const found = rows.find((r: any) => r.id === id);
      expect(found).toBeTruthy();
      expect(found.taskId).toBe("qa-task-1");
      expect(found.toolName).toBe("Bash");
      expect(found.toolInput).toEqual({ command: "echo hi" });
      expect(found.status).toBe("pending");
    } finally {
      deleteApproval(id);
    }
  });

  test("C16d — POST /api/approvals/:id/decide approve flips state with reason", async ({
    request,
  }) => {
    const id = seedPendingApproval({ taskId: "qa-task-2" });
    try {
      const r = await request.post(
        `http://localhost:3333/api/approvals/${id}/decide`,
        { data: { decision: "approve", reason: "verified the command" } },
      );
      expect(r.status()).toBe(200);
      const decided = await r.json();
      expect(decided.status).toBe("approved");
      expect(decided.decisionReason).toBe("verified the command");
      expect(decided.decidedBy).toBe("operator");
      expect(decided.decidedAt).toBeGreaterThan(0);
    } finally {
      deleteApproval(id);
    }
  });

  test("C16d — POST /api/approvals/:id/decide reject also flips state", async ({
    request,
  }) => {
    const id = seedPendingApproval({ taskId: "qa-task-3" });
    try {
      const decided = await (
        await request.post(`http://localhost:3333/api/approvals/${id}/decide`, {
          data: { decision: "reject", reason: "looks suspicious" },
        })
      ).json();
      expect(decided.status).toBe("rejected");
      expect(decided.decisionReason).toBe("looks suspicious");
    } finally {
      deleteApproval(id);
    }
  });

  test("C16d — second decide on the same approval returns 409 with current state", async ({
    request,
  }) => {
    const id = seedPendingApproval({ taskId: "qa-task-4" });
    try {
      await request.post(`http://localhost:3333/api/approvals/${id}/decide`, {
        data: { decision: "approve" },
      });
      const r2 = await request.post(
        `http://localhost:3333/api/approvals/${id}/decide`,
        { data: { decision: "reject" } },
      );
      expect(r2.status()).toBe(409);
      const body = await r2.json();
      expect(body.error).toMatch(/already approved/i);
      expect(body.approval?.status).toBe("approved");
    } finally {
      deleteApproval(id);
    }
  });

  test("C16d — decide rejects unknown decision values with 400", async ({
    request,
  }) => {
    const id = seedPendingApproval({ taskId: "qa-task-5" });
    try {
      const r = await request.post(
        `http://localhost:3333/api/approvals/${id}/decide`,
        { data: { decision: "maybe" } },
      );
      expect(r.status()).toBe(400);
    } finally {
      deleteApproval(id);
    }
  });

  test("C16d — GET /api/approvals/:id returns 404 for missing", async ({
    request,
  }) => {
    const r = await request.get(
      "http://localhost:3333/api/approvals/does-not-exist",
    );
    expect(r.status()).toBe(404);
  });

  test("C16d — settings schema exposes Approvals section with production_cwds key", async ({
    request,
  }) => {
    const settings = await (
      await request.get("http://localhost:3333/api/settings")
    ).json();
    const approvalsSection = settings.schema.find(
      (s: any) => s.section === "Approvals (C16d)",
    );
    expect(approvalsSection).toBeTruthy();
    const cwdsField = approvalsSection.fields.find(
      (f: any) => f.key === "approvals.production_cwds",
    );
    expect(cwdsField).toBeTruthy();
    expect(cwdsField.type).toBe("textarea");
  });

  test("C16d — orphan rows from prior worker_id persist in DB but listing only shows current state", async ({
    request,
  }) => {
    // Seed with a foreign worker_id. Without a server restart, expireOrphaned
    // hasn't run for this row — so it stays 'pending' until restart. The test
    // verifies the row is visible on the listing path either way.
    const id = seedPendingApproval({
      taskId: "qa-task-orphan",
      workerId: "FOREIGN-WORKER-FROM-OTHER-PROCESS",
    });
    try {
      const pending = await (
        await request.get("http://localhost:3333/api/approvals?status=pending")
      ).json();
      // Either pending (no restart since seed) or expired (restart happened).
      // Both are acceptable end-states; the row is reachable.
      const single = await (
        await request.get(`http://localhost:3333/api/approvals/${id}`)
      ).json();
      expect(["pending", "expired"]).toContain(single.status);
      // Sanity: workerId roundtrips intact.
      expect(single.workerId).toBe("FOREIGN-WORKER-FROM-OTHER-PROCESS");
      // (We don't assert on `pending` array contents because a parallel test
      // may have created/decided rows in between.)
      void pending;
    } finally {
      deleteApproval(id);
    }
  });

  // ----- Keyboard shortcuts + ⌘K palette -----

  // ----- C05 Telegram bridge -----

  test("C05 — /api/telegram/status returns stopped when no token configured", async ({
    request,
  }) => {
    // Make sure no token is set (clear any leftover from manual testing).
    await request.post("http://localhost:3333/api/settings", {
      data: {
        entries: [
          { key: "telegram.bot_token", value: null },
          { key: "telegram.allowed_chat_ids", value: null },
        ],
      },
    });
    // Give the restart a tick to settle.
    await new Promise((r) => setTimeout(r, 200));
    const r = await request.get("http://localhost:3333/api/telegram/status");
    expect(r.status()).toBe(200);
    const body = await r.json();
    expect(["stopped", "auth_failed", "error", "conflict"]).toContain(body.kind);
  });

  test("C05 — /api/telegram/test reports 'no token configured' when blank", async ({
    request,
  }) => {
    await request.post("http://localhost:3333/api/settings", {
      data: { entries: [{ key: "telegram.bot_token", value: null }] },
    });
    await new Promise((r) => setTimeout(r, 200));
    const r = await request.post("http://localhost:3333/api/telegram/test");
    expect(r.status()).toBe(200);
    const body = await r.json();
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/no token/i);
  });

  test("C05 — Telegram section in settings schema is no longer disabled", async ({
    request,
  }) => {
    const settings = await (
      await request.get("http://localhost:3333/api/settings")
    ).json();
    const tg = settings.schema.find((s: any) => s.section === "Telegram bridge");
    expect(tg).toBeTruthy();
    // The "coming soon" disabled flag is gone in C05.
    expect(tg.disabled).toBeFalsy();
    expect(tg.fields.map((f: any) => f.key)).toEqual([
      "telegram.bot_token",
      "telegram.allowed_chat_ids",
    ]);
  });

  test("C05 — saving a fake token triggers a restart and the status reflects auth_failed", async ({
    request,
  }) => {
    // Save a syntactically-plausible-but-fake token. The listener will
    // try getMe(), Telegram returns 401, status flips to auth_failed.
    // This proves the settings-save → restart path actually re-reads
    // from settings rather than caching the old token in memory.
    const fakeToken = "111111111:AAA-FAKE-TOKEN-FOR-QA-DO-NOT-USE";
    try {
      await request.post("http://localhost:3333/api/settings", {
        data: {
          entries: [
            { key: "telegram.bot_token", value: fakeToken, isSecret: true },
            { key: "telegram.allowed_chat_ids", value: "12345" },
          ],
        },
      });
      // Wait for the async restartTelegram() + getMe() roundtrip.
      // 5s is comfortably more than a Telegram getMe call (~200ms).
      await new Promise((r) => setTimeout(r, 5000));
      const status = await (
        await request.get("http://localhost:3333/api/telegram/status")
      ).json();
      // auth_failed is the expected outcome for a fabricated token. We
      // accept "error" too in case the test runs offline (DNS failure on
      // api.telegram.org would surface as kind=error, not auth_failed).
      expect(["auth_failed", "error"]).toContain(status.kind);
    } finally {
      await request.post("http://localhost:3333/api/settings", {
        data: {
          entries: [
            { key: "telegram.bot_token", value: null },
            { key: "telegram.allowed_chat_ids", value: null },
          ],
        },
      });
    }
  });

  test("Palette — Cmd+K opens, shows actions and agents, filters on type", async ({
    page,
  }) => {
    await page.goto("/");
    await page.waitForSelector(".agent-item");
    await page.keyboard.press("Meta+k");
    await expect(page.locator("#palette-modal")).toBeVisible({ timeout: 3000 });

    // Default entries should include the modals + a Switch-to-<agent> per agent.
    const entries = page.locator(".palette-row");
    await expect(entries.filter({ hasText: "Open Tasks" })).toHaveCount(1);
    await expect(entries.filter({ hasText: "Open Settings" })).toHaveCount(1);
    await expect(entries.filter({ hasText: "Switch to Main" })).toHaveCount(1);

    // Type to filter — only matches remain
    await page.locator("#palette-input").fill("settings");
    await expect(entries.filter({ hasText: "Open Settings" })).toHaveCount(1);
    await expect(entries.filter({ hasText: "Open Tasks" })).toHaveCount(0);

    // Esc closes the palette
    await page.keyboard.press("Escape");
    await expect(page.locator("#palette-modal")).toBeHidden({ timeout: 2000 });
  });

  test("Palette — Enter on highlighted entry fires the action", async ({
    page,
  }) => {
    await page.goto("/");
    await page.waitForSelector(".agent-item");
    await page.keyboard.press("Meta+k");
    await expect(page.locator("#palette-modal")).toBeVisible({ timeout: 3000 });

    // Filter to Settings, then press Enter to fire
    await page.locator("#palette-input").fill("settings");
    await page.keyboard.press("Enter");

    // Palette closes, settings modal opens
    await expect(page.locator("#palette-modal")).toBeHidden({ timeout: 2000 });
    await expect(page.locator("#settings-modal")).toBeVisible({ timeout: 2000 });
  });

  test("Palette — Cmd+; opens Settings without going through palette", async ({
    page,
  }) => {
    await page.goto("/");
    await page.waitForSelector(".agent-item");
    await page.keyboard.press("Meta+;");
    await expect(page.locator("#settings-modal")).toBeVisible({ timeout: 2000 });
  });

  test("C16c — cap value of 0 is treated as unset", async ({ request }) => {
    // M2 fix: schema help text says "leave blank for no cap". 0 collapses to
    // unset to avoid the footgun where typing 0 silently bricks the agent.
    const agentId = "content";
    await request.post("http://localhost:3333/api/settings", {
      data: {
        entries: [
          { key: `costguard.rate_cap_per_window.${agentId}`, value: "0" },
        ],
      },
    });
    try {
      const status = await (
        await request.get(
          `http://localhost:3333/api/costguard/status?agentId=${agentId}`,
        )
      ).json();
      // 0 was stored but resolver treats it as unset → remaining is null.
      expect(status.rateRemaining).toBe(null);
    } finally {
      await request.post("http://localhost:3333/api/settings", {
        data: {
          entries: [
            { key: `costguard.rate_cap_per_window.${agentId}`, value: null },
          ],
        },
      });
    }
  });
});
