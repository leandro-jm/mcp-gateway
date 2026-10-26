import { expect, test, type Page } from '@playwright/test';

const SHOTS = process.env.SCREENSHOT_DIR;

async function login(page: Page, user: string, password: string) {
  await page.goto('/tools');
  await page.locator('#username').fill(user);
  await page.locator('#password').fill(password);
  await page.locator('#login').click();
  await expect(page.getByRole('heading', { name: 'Tools' })).toBeVisible();
}

/**
 * F10.1 acceptance: an owner can, without calling the API by hand, review a new tool, adjust its
 * description, define a projection, enable it and test it with the simulator.
 */
test('owner reviews, adjusts, projects, enables and tests a tool', async ({ page }) => {
  await login(page, 'owner', 'owner');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/tools.png` });

  // review a new tool (disabled)
  const row = page.getByTestId('tools-table').getByRole('row', { name: /rh_marcacoes_list/ });
  await expect(row).toContainText('disabled');
  await row.click();
  const drawer = page.getByRole('dialog');
  await expect(drawer.getByRole('heading', { name: 'rh_marcacoes_list' })).toBeVisible();

  // adjust the description (override)
  const desc = drawer.getByLabel('Description', { exact: true });
  await desc.fill('Lista as batidas de ponto de um colaborador (entrada/saída). Use colaborador=<id>.');
  await drawer.getByRole('button', { name: 'Save overrides' }).click();
  await expect(page.getByText(/^Overrides saved/)).toBeVisible();

  // define a projection
  await drawer.getByRole('tab', { name: 'Projection' }).click();
  await drawer.getByLabel('Include').fill('$.items[*].id\n$.items[*].tipo\n$.items[*].data_hora');
  await drawer.getByLabel('Maximum items').fill('5');
  await drawer.getByRole('button', { name: 'Save projection' }).click();
  await expect(page.getByText('Projection saved and active')).toBeVisible();

  // enable
  await drawer.getByRole('button', { name: 'Enable' }).click();
  await expect(drawer.getByText('enabled', { exact: true }).first()).toBeVisible();

  // preview saved bytes with a real response
  await drawer.getByRole('button', { name: 'Load upstream response' }).click();
  await drawer.getByRole('button', { name: 'Preview' }).click();
  await expect(drawer.getByTestId('projection-savings')).toContainText('%');

  // test with the simulator
  await drawer.getByRole('tab', { name: 'Test' }).click();
  await drawer.getByRole('button', { name: 'Simulate policy' }).click();
  await expect(drawer.getByTestId('simulation')).toContainText('ALLOWED');
  await drawer.getByRole('button', { name: 'Run as subject' }).click();
  const result = drawer.getByTestId('test-result');
  await expect(result).toContainText('allow');
  await expect(result).toContainText('"tipo"');
  await expect(result).not.toContainText('"origem"');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/tool-drawer.png` });
});

test('main screens render with the theme (screenshots)', async ({ page }) => {
  await login(page, 'admin', 'admin');
  for (const [path, title] of [
    ['/servers', 'MCP Servers'],
    ['/sources', 'Sources'],
    ['/policies', 'Policies'],
    ['/composer', 'Composer'],
    ['/playground', 'Playground'],
    ['/drift', 'Drift inbox'],
    ['/audit', 'Audit'],
    ['/users', 'Users'],
    ['/tokens', 'Tokens'],
  ] as const) {
    await page.goto(path);
    await expect(page.getByRole('heading', { name: title })).toBeVisible();
    // Composer: live YAML validation and DAG view
    if (path === '/composer') {
      await page.getByRole('tab', { name: 'YAML editor' }).click();
      await expect(page.getByTestId('dag')).toContainText('rh_colaborador_get');
    }
    if (SHOTS) await page.screenshot({ path: `${SHOTS}${path}.png` });
  }
});

test('playground: final × raw with highlighted differences (gateway-admin)', async ({ page }) => {
  await login(page, 'admin', 'admin');
  await page.goto('/playground');
  await page.getByLabel('Tool').selectOption('rh_colaborador_get');
  await page.locator('[aria-label="Arguments"] .cm-content').fill('{"id": "col-00001"}');
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.getByTestId('playground-meta')).toContainText('redactions');
  const diff = page.getByTestId('diff');
  await expect(diff.locator('.diff-del').first()).toBeVisible();
  await expect(diff.locator('.diff-add').first()).toBeVisible();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/playground.png`, fullPage: true });
});

test('theme picker: light, dark and system, persisted', async ({ page }) => {
  await login(page, 'admin', 'admin');
  const html = page.locator('html');
  const bg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);

  await page.getByRole('button', { name: 'Theme' }).click();
  await page.getByRole('menuitemradio', { name: 'Light' }).click();
  await expect(html).toHaveAttribute('data-theme', 'light');
  expect(await bg()).toBe('rgb(250, 250, 250)');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/tools-light.png` });

  // persists after reload (applied before first paint)
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Tools' })).toBeVisible();
  await expect(html).toHaveAttribute('data-theme', 'light');

  await page.goto('/servers');
  await expect(page.getByRole('heading', { name: 'MCP Servers' })).toBeVisible();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/servers-light.png` });
  await page.goto('/playground');
  await page.getByLabel('Tool').selectOption('rh_colaborador_get');
  await page.locator('[aria-label="Arguments"] .cm-content').fill('{"id": "col-00001"}');
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.getByTestId('diff')).toBeVisible();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/playground-light.png` });

  await page.getByRole('button', { name: 'Theme' }).click();
  await page.getByRole('menuitemradio', { name: 'Dark' }).click();
  await expect(html).toHaveAttribute('data-theme', 'dark');
  expect(await bg()).toBe('rgb(11, 11, 12)');

  // System: no data-theme, follows the OS prefers-color-scheme
  await page.getByRole('button', { name: 'Theme' }).click();
  await page.getByRole('menuitemradio', { name: 'System' }).click();
  await expect(html).not.toHaveAttribute('data-theme', /.+/);
  await page.emulateMedia({ colorScheme: 'light' });
  expect(await bg()).toBe('rgb(250, 250, 250)');
  await page.emulateMedia({ colorScheme: 'dark' });
  expect(await bg()).toBe('rgb(11, 11, 12)');
});

test('admin creates an agent (service user) and issues a token that works on /mcp', async ({ page, request }) => {
  await login(page, 'admin', 'admin');
  await page.goto('/users');
  const username = `bot-${Date.now()}`;
  await page.getByRole('button', { name: 'New user' }).click();
  const drawer = page.getByRole('dialog');
  await drawer.getByLabel('Username').fill(username);
  await drawer.locator('select').first().selectOption('service');
  await drawer.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('User created')).toBeVisible();

  await page.getByRole('row', { name: new RegExp(username) }).click();
  await page.getByRole('dialog').getByRole('tab', { name: 'Tokens' }).click();
  await page.getByLabel('Token name').fill('e2e');
  await page.getByRole('button', { name: 'Generate token' }).click();
  const token = (await page.getByTestId('new-token').locator('.codeblock').innerText()).trim();
  expect(token).toMatch(/^mgw_/);

  const res = await request.post('/mcp', {
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    data: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
  });
  expect(res.status()).toBe(200);
});

test('logout ends the session and returns to the login screen', async ({ page }) => {
  await login(page, 'owner', 'owner');
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.locator('#username')).toBeVisible();
  await page.goto('/tools');
  await expect(page.locator('#username')).toBeVisible();
});

/**
 * ADR-012: the language comes from the user's profile. `owner-pt` (seed) starts in Portuguese, switches to
 * Spanish through the picker, the choice survives a reload and API errors follow it.
 */
test('language follows the profile and the picker saves it', async ({ page, request }) => {
  const apiLogin = await request.post('/admin/v1/auth/login', { data: { username: 'owner-pt', password: 'owner-pt' } });
  const { token } = (await apiLogin.json()) as { token: string };
  const headers = { authorization: `Bearer ${token}`, 'accept-language': 'en' };
  // start from the seed profile even if a previous run stopped halfway
  expect((await request.patch('/admin/v1/me', { headers, data: { locale: 'pt-BR' } })).status()).toBe(200);

  await login(page, 'owner-pt', 'owner-pt');
  await expect(page.getByRole('button', { name: 'Sair' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'pt-BR');

  await page.getByRole('button', { name: 'Idioma' }).click();
  await page.getByRole('menuitemradio', { name: 'Español' }).click();
  await expect(page.getByRole('button', { name: 'Cerrar sesión' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'es');

  await page.reload();
  await expect(page.getByRole('button', { name: 'Cerrar sesión' })).toBeVisible();

  // a server-side message in the profile language, regardless of Accept-Language
  const missing = await request.get('/admin/v1/tools/00000000-0000-0000-0000-000000000000', { headers });
  expect(missing.status()).toBe(404);
  expect(((await missing.json()) as { message: string }).message).toMatch(/^No encontrado/);

  // restore the seed profile for the next runs
  const restored = await request.patch('/admin/v1/me', { headers, data: { locale: 'pt-BR' } });
  expect(restored.status()).toBe(200);
});
