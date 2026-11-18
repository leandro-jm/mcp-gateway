/**
 * Captures the Admin UI screenshots used by the landing page (ADR-020), in dark and light themes,
 * into apps/site/public/screens/<screen>-<theme>.jpg. With SITE_URL set, it also renders the
 * Open Graph image (public/og.png) from the landing page hero.
 *
 * Prerequisites: the same dev stack as the Admin UI E2E (see apps/admin-ui/playwright.config.ts):
 * `pnpm dev:infra`, `pnpm db:migrate`, `pnpm db:seed`, gateway on :4000, fake upstream on :4010 and
 * the Admin UI on :5180. For pages that are not empty, crawl the `rh` source, enable a few tools with
 * a policy and make some calls first (e.g. `pnpm tsx examples/mcp-client.ts "..."`).
 *
 * The oauth and router screens need OAUTH_ENABLED=true and TOOL_ROUTER_ENABLED=true on the gateway.
 *
 * Usage: pnpm --filter @mcp-gateway/site screens
 * Env: ADMIN_UI_URL (default http://localhost:5180), SITE_URL (e.g. http://localhost:5190), ADMIN_USER/ADMIN_PASSWORD.
 */
import { chromium, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ADMIN_UI = process.env.ADMIN_UI_URL ?? 'http://localhost:5180';
const SITE_URL = process.env.SITE_URL;
// gateway-admin: Playground and Observability are not visible to a tool owner.
const USER = process.env.ADMIN_USER ?? 'admin';
const PASSWORD = process.env.ADMIN_PASSWORD ?? 'admin';
const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const OUT = join(PUBLIC_DIR, 'screens');
const THEMES = ['dark', 'light'] as const;

interface Screen {
  /** File name, referenced by src/sections/Features.tsx. */
  name: string;
  path: string;
  /** Optional interaction so the page shows something meaningful. */
  prepare?: (page: Page) => Promise<void>;
}

const tab = (page: Page, name: string) => page.getByText(name, { exact: true }).first().click();

const SCREENS: Screen[] = [
  { name: 'servers', path: '/servers' },
  { name: 'policies', path: '/policies' },
  {
    name: 'oauth',
    path: '/settings',
    prepare: async (page) => {
      await tab(page, 'App connections');
      await page.waitForTimeout(800);
    },
  },
  {
    name: 'pii',
    path: '/pii',
    prepare: async (page) => {
      await tab(page, 'Preview');
      await page.getByRole('button', { name: 'Apply rules' }).click();
      await page.getByText(/redactions?/i).first().waitFor();
    },
  },
  {
    name: 'views',
    path: '/tools',
    // The View tab of a tool drawer: suggested view, activation and live preview (ADR-022).
    prepare: async (page) => {
      await page.getByPlaceholder('Search by name').fill('rh_colaboradores_list');
      await page.getByTestId('tools-table').getByRole('row', { name: /rh_colaboradores_list/ }).first().click();
      await tab(page, 'View');
      await page.waitForTimeout(1500);
    },
  },
  {
    name: 'router',
    path: '/settings',
    prepare: async (page) => {
      await tab(page, 'Tool router');
      await page.waitForTimeout(800);
    },
  },
  { name: 'observability', path: '/observability' },
  {
    name: 'playground',
    path: '/playground',
    prepare: async (page) => {
      // Same flow as the playground E2E (apps/admin-ui/e2e/owner-flow.spec.ts): run a tool to show final × raw.
      await page.getByLabel('Tool').selectOption('rh_colaborador_get');
      await page.locator('[aria-label="Arguments"] .cm-content').fill('{"id": "col-00001"}');
      await page.getByRole('button', { name: 'Run', exact: true }).click();
      await page.getByTestId('diff').waitFor();
      await page.getByTestId('playground-meta').evaluate((el) => el.scrollIntoView({ block: 'start' }));
    },
  },
];

const log = (line: string) => process.stdout.write(`${line}\n`);

async function login(page: Page): Promise<void> {
  await page.goto(`${ADMIN_UI}/tools`);
  await page.locator('#username').fill(USER);
  await page.locator('#password').fill(PASSWORD);
  await page.locator('#login').click();
  await page.getByRole('heading', { name: 'Tools' }).waitFor();
}

async function captureAdmin(): Promise<void> {
  await mkdir(OUT, { recursive: true });
  const browser = await chromium.launch();
  try {
    for (const theme of THEMES) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, colorScheme: theme, locale: 'en-US' });
      await context.addInitScript((t) => {
        localStorage.setItem('mcp-gw:theme', t);
        localStorage.setItem('mcp-gw:locale', 'en');
      }, theme);
      // The screenshots are in English whatever the user's profile language is (the profile wins in the UI).
      await context.route('**/admin/v1/me', async (route) => {
        const response = await route.fetch();
        const me = (await response.json()) as Record<string, unknown>;
        await route.fulfill({ response, json: { ...me, locale: 'en' } });
      });
      const page = await context.newPage();
      await login(page);
      for (const screen of SCREENS) {
        await page.goto(`${ADMIN_UI}${screen.path}`);
        await page.waitForLoadState('networkidle');
        await screen.prepare?.(page);
        await page.waitForTimeout(600);
        const file = join(OUT, `${screen.name}-${theme}.jpg`);
        await page.screenshot({ path: file, type: 'jpeg', quality: 86 });
        log(`saved ${file}`);
      }
      await context.close();
    }
  } finally {
    await browser.close();
  }
}

async function captureOg(siteUrl: string): Promise<void> {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1, colorScheme: 'dark', reducedMotion: 'reduce' });
    const page = await context.newPage();
    await page.goto(`${siteUrl}/?lang=en`);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(400);
    const file = join(PUBLIC_DIR, 'og.png');
    await page.screenshot({ path: file });
    log(`saved ${file}`);
  } finally {
    await browser.close();
  }
}

await captureAdmin();
if (SITE_URL) await captureOg(SITE_URL);
