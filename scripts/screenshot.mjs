import { chromium } from "@playwright/test";

const out = process.argv[2] || "docs/screenshots/command-center.png";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto("http://localhost:3333/");
await page.waitForSelector(".agent-item");
// Give the default Main agent its empty state
await page.waitForTimeout(300);
await page.screenshot({ path: out, fullPage: false });
await browser.close();
console.log("wrote " + out);
