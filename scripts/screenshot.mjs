import { chromium } from "@playwright/test";
import { mkdir } from "node:fs/promises";

const OUT_DIR = "docs/screenshots";
await mkdir(OUT_DIR, { recursive: true });

// Point the server's cwd at this project so screenshots showing file
// autocomplete surface project files, not the user's private ~/ dirs.
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

async function waitFrame(ms = 200) {
  await page.waitForTimeout(ms);
}

// 1. Overview — sidebar + empty state, default (Main agent selected)
await page.goto("http://localhost:3333/");
await page.waitForSelector(".agent-item");
await waitFrame(300);
await snap("01-overview");

// 2. Folder picker modal (no SDK, static)
await page.locator("#cwd-pill").click();
await page.waitForSelector("#cwd-modal:not(.hidden)");
await page.locator("button[data-path='~/Desktop']").click();
await waitFrame(400);
await snap("02-folder-picker");
await page.locator("#cwd-cancel").click();

// 3. Task board — open, empty
await page.locator("#tasks-btn").click();
await page.waitForSelector("#tasks-modal:not(.hidden)");
await waitFrame(300);
await snap("03-task-board-empty");

// 4. Task board — with a typed task in the form (visual cue for auto-routing)
await page
  .locator("#task-description")
  .fill("Draft a short email thanking a client for their feedback this week");
await waitFrame(200);
await snap("04-task-board-form");
await page.locator("#tasks-close").click();

// 5. Content agent highlighted — model chip shows Opus
await page.locator(".agent-item", { hasText: "Content" }).click();
await waitFrame(300);
await snap("05-content-agent-opus");

// 6. Model selector opened (via keyboard)
await page.locator("#model-select").click();
await waitFrame(200);
await snap("06-model-selector");
// close by clicking elsewhere
await page.locator("#chat-title").click();

// 7. @file autocomplete popover in composer
await page.locator(".agent-item", { hasText: "Ops" }).click();
await page.locator("#input").click();
await page
  .locator("#input")
  .pressSequentially("Read @", { delay: 30 });
await page.waitForSelector("#file-popover:not(.hidden)");
await waitFrame(300);
await snap("07-file-autocomplete");
await page.locator("#input").fill("");

// 8. Memory panel with a few example memories
await fetch("http://localhost:3333/api/memories", { method: "DELETE" });
const seedMems = [
  { content: "Name: Jay. Company: Clawless. Closes emails with '— J'.", category: "fact" },
  { content: "Prefers short, direct replies — no preamble, no filler.", category: "preference" },
  { content: "Building Command Center as an educational reference for the Agent SDK.", category: "context" },
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
await waitFrame(300);
await snap("08-memory-panel");
await page.locator("#memory-close").click();

// 9. Slash command output — /agents rendered as markdown
await page.locator(".agent-item", { hasText: "Main" }).click();
await page.locator("#input").fill("/agents");
await page.keyboard.press("Enter");
await page.waitForSelector(".msg.agent .msg-body.markdown");
await waitFrame(400);
await snap("09-slash-command");

await browser.close();
console.log("done");
