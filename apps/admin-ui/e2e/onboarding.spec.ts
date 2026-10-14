import { expect, test, type Locator, type Page } from '@playwright/test';

async function login(page: Page, path: string, user: string, password: string) {
  await page.goto(path);
  await page.locator('#username').fill(user);
  await page.locator('#password').fill(password);
  await page.locator('#login').click();
}

/** Opens a step unless it is already open (the first pending step opens by itself). */
async function expand(step: Locator, title: RegExp) {
  const head = step.getByRole('button', { name: title });
  if ((await head.getAttribute('aria-expanded')) !== 'true') await head.click();
  await expect(head).toHaveAttribute('aria-expanded', 'true');
}

/** ADR-023: the getting-started guide detects progress from the tenant data and explains each step. */
test('owner follows the getting-started guide', async ({ page }) => {
  // no policy and no token, whatever other specs left in the dev database
  await page.route('**/admin/v1/policies', (route) => (route.request().method() === 'GET' ? route.fulfill({ json: { items: [] } }) : route.continue()));
  await page.route('**/admin/v1/me/tokens', (route) => (route.request().method() === 'GET' ? route.fulfill({ json: { items: [] } }) : route.continue()));

  // with steps pending, the home page opens the guide
  await login(page, '/', 'owner', 'owner');
  await expect(page).toHaveURL(/\/onboarding$/);
  await expect(page.getByRole('heading', { name: 'Getting started' })).toBeVisible();
  const steps = page.getByTestId('onboarding-steps');

  // the seed registers the `rh` source
  await expect(steps.locator('[data-step="source"]')).toHaveAttribute('data-done', 'true');

  // a pending step the owner cannot do says who can
  const policy = steps.locator('[data-step="policy"]');
  await expect(policy).toHaveAttribute('data-done', 'false');
  await expect(policy).toContainText('Requires a tenant admin');

  // a step opens with why / how / example and a link to its page
  await expand(policy, /Allow access with a policy/);
  await expect(policy).toContainText('How to do it');
  await expect(policy).toContainText('hr_demo_*');
  await expect(policy.getByRole('link', { name: 'Open Policies' })).toHaveAttribute('href', '/policies');

  // a manual step stays marked after a reload (localStorage per tenant and user)
  const token = steps.locator('[data-step="token"]');
  await expand(token, /Create the agent token/);
  await token.getByRole('button', { name: 'Mark as done' }).click();
  await expect(token).toHaveAttribute('data-done', 'true');
  await page.reload();
  await expect(page.getByTestId('onboarding-steps').locator('[data-step="token"]')).toHaveAttribute('data-done', 'true');

  // the last step shows ready-to-paste snippets for the omni endpoint
  const connect = page.getByTestId('onboarding-steps').locator('[data-step="connect"]');
  await expand(connect, /Connect your agent/);
  await expect(connect.getByTestId('onboarding-snippet')).toContainText('claude mcp add --transport http mcp-gateway');
  await expect(connect.getByTestId('onboarding-snippet')).toContainText('/mcp/omni');

  // hiding the guide makes the home page open the tools again; the guide stays in the menu
  await page.getByLabel('Do not open this guide on start').check();
  await page.goto('/');
  await expect(page).toHaveURL(/\/tools$/);
  await expect(page.getByRole('link', { name: /Getting started/ })).toBeVisible();
});
