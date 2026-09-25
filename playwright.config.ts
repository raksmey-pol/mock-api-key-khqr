import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.E2E_PORT ?? 3197);

export default defineConfig({
  testDir: "./tests/browser",
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  use: {
    baseURL: `http://localhost:${port}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 1050 } } }],
  webServer: {
    command: `pnpm build && pnpm start --port ${port}`,
    url: `http://localhost:${port}/api/v1/health-check`,
    timeout: 120_000,
    reuseExistingServer: false,
    env: { PAYMENT_MODE: "mock", DATABASE_PATH: `.data/playwright-${process.pid}.sqlite`, WEBHOOK_SECRET: "browser-test-secret", WEBHOOK_SIGNATURE_MODE: "signed" },
  },
});
