import { expect, test } from '@playwright/test';

const SHOTS = process.env.SCREENSHOT_DIR;

/**
 * F13.7 acceptance (ADR-014): an admin pastes cURL commands, reviews the preview, creates the source
 * and its tools show up disabled after the crawl. Requires the crawler running (`apps/crawler` dev).
 */
test('admin imports an API from pasted cURL', async ({ page }) => {
  await page.goto('/sources');
  await page.locator('#username').fill('admin');
  await page.locator('#password').fill('admin');
  await page.locator('#login').click();
  await expect(page.getByRole('heading', { name: 'Sources' })).toBeVisible();

  await page.getByRole('button', { name: 'Import API' }).first().click();
  const wizard = page.getByTestId('import-wizard');
  await wizard.getByLabel('Content').fill(
    [
      "curl 'http://localhost:4010/colaboradores/col-00003' -H 'X-API-Key: key-from-the-docs'",
      "curl 'http://localhost:4010/escalas?colaborador=col-00003' -H 'X-API-Key: key-from-the-docs'",
    ].join('\n'),
  );
  await expect(wizard.getByTestId('import-detected')).toHaveText('Detected: cURL');
  await wizard.getByRole('button', { name: 'Preview' }).click();

  // preview: credential stripped, path templated, one tool per operation
  await expect(wizard.getByTestId('import-warnings')).toContainText('credential removed from header "X-API-Key"');
  const ops = wizard.getByTestId('import-operations');
  await expect(ops).toContainText('GET /colaboradores/{colaborador_id}');
  await expect(ops).toContainText('GET /escalas');
  await expect(ops).not.toContainText('key-from-the-docs');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/import-preview.png` });
  await wizard.getByRole('button', { name: 'Next' }).click();

  const name = `e2e_${Date.now().toString(36)}`;
  await expect(wizard.getByLabel('Base URL')).toHaveValue('http://localhost:4010');
  await wizard.getByLabel('Name', { exact: true }).fill(name);
  await wizard.getByRole('button', { name: 'Import and crawl' }).click();
  await expect(page.getByText('Imported: 2 operations; crawl queued')).toBeVisible();

  // the source drawer follows the crawl and offers the generated OpenAPI
  const drawer = page.getByRole('dialog');
  await expect(drawer.getByRole('heading', { name })).toBeVisible();
  await expect(drawer.getByRole('button', { name: 'Download OpenAPI' })).toBeVisible();
  await expect(drawer.getByText('succeeded')).toBeVisible({ timeout: 30_000 });

  // default deny: the generated tools exist and start disabled
  await page.goto('/tools');
  await page.getByPlaceholder('Search by name').fill(name);
  const table = page.getByTestId('tools-table');
  await expect(table.getByRole('row', { name: new RegExp(`${name}_colaboradores_get`) })).toContainText('disabled');
  await expect(table.getByRole('row', { name: new RegExp(`${name}_escalas_list`) })).toContainText('disabled');
});
