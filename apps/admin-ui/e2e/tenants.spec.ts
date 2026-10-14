import { expect, test } from '@playwright/test';

/** The platform admin creates a tenant, switches to it from the top bar and removes it. */
test('platform admin manages tenants', async ({ page }) => {
  const slug = `e2e-${Date.now().toString(36)}`;
  await page.goto('/tenants');
  await page.locator('#username').fill('admin');
  await page.locator('#password').fill('admin');
  await page.locator('#login').click();
  await expect(page.getByRole('heading', { name: 'Tenants' })).toBeVisible();

  await page.getByRole('button', { name: 'New tenant' }).click();
  const drawer = page.getByRole('dialog');
  await drawer.getByLabel('Slug').fill(slug);
  await drawer.getByLabel('Name', { exact: true }).fill('E2E tenant');
  await drawer.getByRole('button', { name: 'Save' }).click();
  const row = page.getByRole('row', { name: new RegExp(slug) });
  await expect(row).toContainText('active');

  // with two tenants or more the top bar switches between them
  const switcher = page.getByRole('combobox', { name: 'Tenant' });
  await switcher.selectOption(slug);
  await expect(row).toContainText('current');

  page.once('dialog', (d) => void d.accept());
  await row.getByRole('button', { name: `Remove ${slug}` }).click();
  await expect(row).toHaveCount(0);
  // removing the current tenant moves the session to another one
  await expect(page.locator('.crumbs')).not.toContainText('E2E tenant');
});
