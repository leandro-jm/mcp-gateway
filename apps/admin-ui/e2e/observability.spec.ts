import { expect, test, type Page } from '@playwright/test';

const SHOTS = process.env.SCREENSHOT_DIR;

async function login(page: Page, user: string, password: string) {
  await page.goto('/tools');
  await page.locator('#username').fill(user);
  await page.locator('#password').fill(password);
  await page.locator('#login').click();
  await expect(page.getByRole('heading', { name: 'Tools' })).toBeVisible();
}

/** Generates a few calls through the gateway so the views have data. */
async function generateCalls(page: Page) {
  const token = 'mgw_dev-agent-token-somente-para-desenvolvimento';
  for (const id of ['col-00001', 'missing']) {
    await page.request.post('/mcp', {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json' },
      data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'rh_colaborador_get', arguments: { id } } },
    });
  }
}

/** F15.16: the observability page per audience, localized, with the LGPD lookup for admins. */
test('admin sees every audience tab, the LGPD lookup and localized labels', async ({ page }) => {
  await login(page, 'admin', 'admin');
  await generateCalls(page);
  await page.getByRole('link', { name: 'Observability' }).click();
  await expect(page.getByRole('heading', { name: 'Observability' })).toBeVisible();
  for (const tab of ['Operations', 'Tools', 'Security', 'FinOps']) await expect(page.getByRole('tab', { name: tab })).toBeVisible();
  await expect(page.getByTestId('observability-sre')).toContainText('Gateway overhead p95');

  await page.getByRole('tab', { name: 'Tools' }).click();
  await expect(page.getByTestId('observability-tools')).toContainText('Usage per tool');

  await page.getByRole('tab', { name: 'Security' }).click();
  const lgpd = page.getByTestId('lgpd-panel');
  await expect(lgpd).toBeVisible();
  await lgpd.getByLabel('Value').fill('529.982.247-25');
  await lgpd.getByRole('button', { name: 'Search' }).click();
  await expect(lgpd).toContainText(/touched this subject/);

  await page.getByRole('tab', { name: 'FinOps' }).click();
  await expect(page.getByTestId('before-after')).toContainText('With the gateway');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/observability-finops.png` });

  // switching the language changes the labels (ADR-012), then back to English
  await page.getByRole('button', { name: /^(Language|Idioma)$/ }).click();
  await page.getByRole('menuitemradio', { name: /Português/ }).click();
  await expect(page.getByRole('heading', { name: 'Observabilidade' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Segurança' })).toBeVisible();
  await page.getByRole('button', { name: /^(Language|Idioma)$/ }).click();
  await page.getByRole('menuitemradio', { name: /English/ }).click();
  await expect(page.getByRole('heading', { name: 'Observability' })).toBeVisible();
});

test('a tool owner only sees the Tools tab', async ({ page }) => {
  await login(page, 'owner', 'owner');
  await page.goto('/observability');
  await expect(page.getByRole('tab', { name: 'Tools' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Operations' })).toHaveCount(0);
  await expect(page.getByRole('tab', { name: 'Security' })).toHaveCount(0);
  await expect(page.getByTestId('observability-tools')).toContainText('Usage per tool');
});

/** F15.19: the call explorer explains a call; only admins get raw × final and replay. */
test('call explorer: admin sees the explanation and the debug panel, owners do not', async ({ page, browser }) => {
  await login(page, 'admin', 'admin');
  await generateCalls(page);
  await page.getByRole('link', { name: 'Calls' }).click();
  await page.getByTestId('calls-table').getByRole('row').nth(1).click();
  const drawer = page.getByRole('dialog');
  await expect(drawer.getByTestId('call-explain')).toContainText('Time per stage');
  await expect(drawer.getByTestId('call-explain')).toContainText('Policy decision');
  await expect(drawer.getByTestId('debug-panel')).toBeVisible();

  // the owner in a fresh browser context (separate session)
  const ownerContext = await browser.newContext();
  const ownerPage = await ownerContext.newPage();
  try {
    await login(ownerPage, 'owner', 'owner');
    await ownerPage.goto('/calls');
    const rows = ownerPage.getByTestId('calls-table').getByRole('row');
    await expect(rows.nth(1)).toBeVisible();
    await rows.nth(1).click();
    await expect(ownerPage.getByRole('dialog').getByTestId('call-explain')).toBeVisible();
    await expect(ownerPage.getByRole('dialog').getByTestId('debug-panel')).toHaveCount(0);
  } finally {
    await ownerContext.close();
  }
});
