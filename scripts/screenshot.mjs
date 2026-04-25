import { chromium } from "@playwright/test";
import { mkdir } from "node:fs/promises";

const OUT_DIR = "docs/screenshots";
await mkdir(OUT_DIR, { recursive: true });

// Point the server's cwd at this project so captured file-lists only surface
// the repo's own contents, never the author's private home-directory folders.
await fetch("http://localhost:3333/api/cwd", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ path: process.cwd() }),
});

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
});
const page = await ctx.newPage();

async function snap(name, opts = {}) {
  const path = `${OUT_DIR}/${name}.png`;
  await page.screenshot({ path, ...opts });
  console.log("wrote " + path);
}
const wait = (ms = 200) => page.waitForTimeout(ms);

// 1. Overview — landing page, default Main agent selected
await page.goto("http://localhost:3333/");
await page.waitForSelector(".agent-item");
await wait(300);
await snap("01-overview");

// 2. Folder picker modal — open + browsing list visible
await page.locator("#cwd-pill").click();
await page.waitForSelector("#cwd-modal:not(.hidden)");
await page.locator("button[data-path='~/Desktop']").click();
await wait(400);
await snap("02-folder-picker");
await page.locator("#cwd-cancel").click();

// 3. Task board — open, empty
await page.locator("#tasks-btn").click();
await page.waitForSelector("#tasks-modal:not(.hidden)");
await wait(300);
await snap("03-task-board-empty");

// 4. Task board — with a typed task (highlights auto-routing)
await page
  .locator("#task-description")
  .fill("Draft a short email thanking a client for their feedback this week");
await wait(200);
await snap("04-task-board-form");
await page.locator("#tasks-close").click();

// 5. Content agent highlighted — Opus model chip visible
await page.locator(".agent-item", { hasText: "Content" }).click();
await wait(300);
await snap("05-content-agent-opus");

// 6. Model selector opened (native dropdown + sidebar state)
await page.locator("#model-select").click();
await wait(200);
await snap("06-model-selector");
await page.locator("#chat-title").click();

// 7. @file autocomplete popover in the composer
await page.locator(".agent-item", { hasText: "Ops" }).click();
await page.locator("#input").click();
await page.locator("#input").pressSequentially("Read @", { delay: 30 });
await page.waitForSelector("#file-popover:not(.hidden)");
await wait(300);
await snap("07-file-autocomplete");
await page.locator("#input").fill("");

// 8. Memory panel seeded with three example entries
await fetch("http://localhost:3333/api/memories", { method: "DELETE" }).catch(() => {});
// Cleanest clean-slate: iterate existing memories and delete each
const existing = await (await fetch("http://localhost:3333/api/memories")).json();
for (const m of existing) {
  await fetch(`http://localhost:3333/api/memories/${m.id}`, { method: "DELETE" });
}
const seedMems = [
  { content: "Name: Jay. Company: Clawless. Closes emails with '— J'.", category: "fact" },
  { content: "Prefers short, direct replies — no preamble, no filler.", category: "preference" },
  {
    content: "Building Command Center as an educational reference for the Agent SDK.",
    category: "context",
  },
];
for (const m of seedMems) {
  await fetch("http://localhost:3333/api/memories", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(m),
  });
}
await page.locator("#memory-btn").click();
await page.waitForSelector("#memory-modal:not(.hidden)");
await wait(300);
await snap("08-memory-panel");
await page.locator("#memory-close").click();

// 9. Slash command output — /agents rendered as markdown
await page.locator(".agent-item", { hasText: "Main" }).click();
await page.locator("#input").fill("/agents");
await page.keyboard.press("Enter");
await page.waitForSelector(".msg.agent .msg-body.markdown");
await wait(400);
await snap("09-slash-command");

// 10. Settings modal — WhisprDesk + Telegram (coming soon) sections
// Clear any lingering test values so the screenshot shows a clean empty state.
await fetch("http://localhost:3333/api/settings", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    entries: [
      { key: "whisprdesk.url", value: null },
      { key: "whisprdesk.token", value: null },
      { key: "telegram.bot_token", value: null },
      { key: "telegram.allowed_chat_ids", value: null },
    ],
  }),
});
await page.locator("#settings-btn").click();
await page.waitForSelector("#settings-modal:not(.hidden)");
await wait(400);
await snap("10-settings-modal");
await page.locator("#settings-close").click();

// 11. Slash command autocomplete popover (our new feature)
await page.locator("#reset-btn").click();
await page.locator("#input").click();
await page.locator("#input").pressSequentially("/", { delay: 30 });
await page.waitForSelector("#command-popover:not(.hidden)");
await wait(400);
await snap("11-slash-popover");
await page.locator("#input").fill("");

// 13. History modal — seed a few sessions across agents so the modal isn't bare
const seedConvos = [
  { agentId: "main", message: "Help me plan a YouTube video about AI agents" },
  { agentId: "comms", message: "Draft a thank-you email to a client" },
  { agentId: "content", message: "Brainstorm 3 short video titles about TypeScript" },
];
for (const c of seedConvos) {
  console.log(`seeding history: ${c.agentId} ← "${c.message.slice(0, 30)}…"`);
  await fetch("http://localhost:3333/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(c),
  });
}
await page.reload();
await page.waitForSelector(".agent-item");
await wait(400);
await page.locator("#history-btn").click();
await page.waitForSelector("#history-modal:not(.hidden)");
await wait(400);
await snap("13-history-modal");

// 14. Restore a session → active chat with the usage chip + per-message footer
await page.locator(".history-row").first().click();
await page.waitForSelector(".msg.agent .msg-footer .usage-chip", { timeout: 15_000 });
await wait(400);
await snap("14-chat-with-usage");

// 12. New agent editor — partially filled so reader sees the form
await page.locator("#new-agent-btn").click();
await page.waitForSelector("#agent-modal:not(.hidden)");
await page.locator("#agent-name").fill("Research");
await page.locator("#agent-emoji").fill("🔬");
await page.locator("#agent-description").fill("Deep research with cited sources");
await page.locator('input[data-tool="Read"]').check();
await page.locator('input[data-tool="WebSearch"]').check();
await page.locator('input[data-tool="WebFetch"]').check();
await page
  .locator("#agent-system-prompt")
  .fill(
    "You are Research, a careful investigator. Use WebSearch liberally. Always cite sources inline with URLs. Prefer primary sources over secondary summaries.",
  );
await wait(300);
await snap("12-new-agent-editor");
await page.locator("#agent-cancel").click();

await browser.close();
console.log("done");
