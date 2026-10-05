import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

const AGENT_TOKEN = 'mgw_dev-agent-token-somente-para-desenvolvimento';
const SEQUENCE = ['rh_colaborador_get', 'rh_escalas_list'];

async function login(page: Page, user: string, password: string) {
  await page.goto('/tools');
  await page.locator('#username').fill(user);
  await page.locator('#password').fill(password);
  await page.locator('#login').click();
  await expect(page.getByRole('heading', { name: 'Tools' })).toBeVisible();
}

async function apiToken(request: APIRequestContext, username: string, password: string): Promise<string> {
  const res = await request.post('/admin/v1/auth/login', { data: { username, password } });
  expect(res.ok()).toBe(true);
  return (await res.json()).token as string;
}

/** Calls the sequence in a fresh MCP session (stateless session id issued on initialize). */
async function runSequence(request: APIRequestContext, token: string, colaboradorId: string) {
  const headers = { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json' };
  const init = await request.post('/mcp', {
    headers,
    data: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'e2e-agent', version: '1' } } },
  });
  const sid = init.headers()['mcp-session-id'];
  const withSession = { ...headers, ...(sid ? { 'mcp-session-id': sid } : {}) };
  await request.post('/mcp', { headers: withSession, data: { jsonrpc: '2.0', method: 'notifications/initialized' } });
  await request.post('/mcp', { headers: withSession, data: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: SEQUENCE[0], arguments: { id: colaboradorId } } } });
  await request.post('/mcp', { headers: withSession, data: { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: SEQUENCE[1], arguments: { colaborador: colaboradorId } } } });
}

/**
 * F15.24: a frequent call sequence becomes a composite suggestion; accepting it opens the draft in
 * the Composer. The setup enables the two tools and an allow policy through the Admin API.
 */
test('accepting a suggestion lands in the Composer with the draft', async ({ page, request }) => {
  const admin = await apiToken(request, 'admin', 'admin');
  const h = { authorization: `Bearer ${admin}`, 'x-tenant': 'dev' };
  const tools = (await (await request.get('/admin/v1/tools?limit=500', { headers: h })).json()).items as Array<{ id: string; name: string; state: string }>;
  for (const name of SEQUENCE) {
    const tool = tools.find((x) => x.name === name);
    test.skip(!tool, `the dev source has no ${name} (run a crawl first)`);
    if (tool!.state !== 'enabled') await request.post(`/admin/v1/tools/${tool!.id}/enable`, { headers: h });
  }
  const policies = (await (await request.get('/admin/v1/policies', { headers: h })).json()).items as Array<{ toolPattern: string; subject: string }>;
  if (!policies.some((p) => p.toolPattern === 'rh_*' && p.subject === 'agent')) {
    await request.post('/admin/v1/policies', { headers: h, data: { subjectType: 'role', subject: 'agent', effect: 'allow', toolPattern: 'rh_*' } });
  }
  const colab = 'col-00001';
  const agente = await apiToken(request, 'agente', 'agente');
  for (const token of [AGENT_TOKEN, AGENT_TOKEN, agente]) await runSequence(request, token, colab);
  expect((await request.post('/admin/v1/agent-insights/refresh', { headers: h })).ok()).toBe(true);

  const list = async (status: string) =>
    ((await (await request.get(`/admin/v1/agent-insights/suggestions?status=${status}`, { headers: h })).json()).items as Array<{ sequence: string[]; compositeId: string }>).find(
      (x) => x.sequence.join() === SEQUENCE.join(),
    );

  await login(page, 'admin', 'admin');
  if (await list('open')) {
    await page.goto('/agents');
    await page.getByRole('tab', { name: 'Suggestions' }).click();
    const card = page.getByTestId('suggestion').filter({ hasText: SEQUENCE.join(' → ') });
    await expect(card).toBeVisible();
    await card.getByRole('button', { name: 'Create draft' }).click();
    await expect(page).toHaveURL(/\/composer/);
  } else {
    // accepted in an earlier run: the composite exists and opens from the deep link
    const done = await list('accepted');
    expect(done).toBeTruthy();
    await page.goto(`/composer?open=${done!.compositeId}`);
  }
  await expect(page.locator('[aria-label="YAML definition"] .cm-content')).toContainText(SEQUENCE[1]!);
});
