import { defineConfig, devices } from "@playwright/test";

// Tap-through tests of Play (e2e/): real clicks on the real buttons, in a
// browser, against the dev app - and, online, a local Worker (the dev app
// finds it on :8787). `npm run e2e`; CI runs them on every pull request.
export default defineConfig({
  testDir: "e2e",
  timeout: 180_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    ...devices["Desktop Chrome"],
    // A phone on its side, as Play is played.
    viewport: { width: 844, height: 390 },
    baseURL: "http://localhost:5173/mjwaits/",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: [
    {
      command: "npm run dev -- --port 5173 --strictPort",
      url: "http://localhost:5173/mjwaits/",
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      command: "npm run dev --workspace worker -- --port 8787",
      port: 8787,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: { WRANGLER_SEND_METRICS: "false" },
    },
  ],
});
