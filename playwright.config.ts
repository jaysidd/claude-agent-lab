import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:3333",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "smoke",
      grepInvert: /@engine/,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "engine",
      grep: /@engine/,
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "npm run serve",
    url: "http://localhost:3333/api/cwd",
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
