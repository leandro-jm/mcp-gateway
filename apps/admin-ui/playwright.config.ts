import { defineConfig, devices } from '@playwright/test';

/**
 * Admin UI E2E against the real dev stack (seeded Postgres, gateway, fake upstream, Vite).
 * Prerequisites: `pnpm dev:infra`, `pnpm db:migrate` and `pnpm db:seed`, gateway on :4000, fake upstream on :4010,
 * `pnpm --filter @mcp-gateway/admin-ui dev` and, for the import flow, the crawler (`pnpm --filter @mcp-gateway/crawler dev`).
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: process.env.ADMIN_UI_URL ?? 'http://localhost:5180',
    viewport: { width: 2000, height: 1055 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 2000, height: 1055 } } }],
});
