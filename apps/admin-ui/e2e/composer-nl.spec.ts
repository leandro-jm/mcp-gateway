import { expect, test, type APIRequestContext, type Page, type Route } from '@playwright/test';

const SHOTS = process.env.SCREENSHOT_DIR;
const RUN = Date.now().toString(36);
const NAME = `rh_resumo_e2e_${RUN}`;
const SLUG = `e2e-composer-${RUN}`;

const SOURCE = `name: ${NAME}
title: Resumo do colaborador
description: Dados do colaborador, escala atual e últimas marcações
input:
  type: object
  required: [colaborador_id]
  properties:
    colaborador_id: { type: string }
steps:
  - id: colab
    tool: rh_colaborador_get
    args: { id: "$input.colaborador_id" }
  - id: escalas
    tool: rh_escalas_list
    args: { colaborador: "$steps.colab.id" }
  - id: marcacoes
    tool: rh_marcacoes_list
    args: { colaborador: "$steps.colab.id" }
output: |
  { "nome": $steps.colab.nome, "escala_atual": $steps.escalas[0].nome, "ultimas_marcacoes": $steps.marcacoes[[0..2]].tipo }
failure_mode: partial
`;

async function login(page: Page, user: string, password: string) {
  await page.goto('/tools');
  await page.locator('#username').fill(user);
  await page.locator('#password').fill(password);
  await page.locator('#login').click();
  await expect(page.getByRole('heading', { name: 'Tools' })).toBeVisible();
}

async function apiToken(request: APIRequestContext, username: string, password: string): Promise<string> {
  const res = await request.post('/admin/v1/auth/login', { data: { username, password } });
  expect(res.ok()).toBeTruthy();
  return (await res.json()).token as string;
}

/**
 * The LLM is the only simulated piece (no provider key in CI, and a real key must not be overwritten):
 * the tenant appears configured and the generation returns a fixed draft, validated by the real gateway.
 */
async function fakeLlm(page: Page) {
  await page.route('**/admin/v1/settings/llm', (route) =>
    route.request().method() === 'GET' ? route.fulfill({ json: { configured: true, provider: 'anthropic', model: 'claude-opus-5-5' } }) : route.fallback(),
  );
  await page.route('**/admin/v1/composites/generate', async (route: Route) => {
    const body = route.request().postDataJSON() as { prompt: string };
    expect(body.prompt).toContain('resumo do colaborador');
    const validation = await (await route.fetch({ url: route.request().url().replace('/generate', '/validate'), method: 'POST', postData: JSON.stringify({ source: SOURCE }) })).json();
    await route.fulfill({
      json: {
        proposal: { source: SOURCE, explanation: 'Busca o colaborador e, em paralelo, as escalas e as marcações.', assumptions: ['colaborador_id é o id do colaborador'], unsupported: null },
        validation,
        candidates: [
          { name: 'rh_colaborador_get', state: 'enabled', score: 0.9 },
          { name: 'rh_escalas_list', state: 'disabled', score: 0.8 },
          { name: 'rh_marcacoes_list', state: 'enabled', score: 0.7 },
        ],
        usage: { provider: 'anthropic', model: 'claude-opus-5-5', attempts: 1, inputTokens: 4200, outputTokens: 610, cacheReadTokens: 0, durationMs: 8300 },
      },
    });
  });
}

test.describe.serial('natural-language composer (F14)', () => {
  test('admin configures the LLM: the key is write-only', async ({ page }) => {
    let saved: Record<string, unknown> | undefined;
    await page.route('**/admin/v1/settings/llm', async (route) => {
      if (route.request().method() === 'PUT') {
        saved = route.request().postDataJSON();
        return route.fulfill({ json: { configured: true, provider: 'anthropic', model: saved!.model, baseUrl: null, hasApiKey: true, apiKeyHint: 'abcd', jsonMode: 'schema', maxGenerationsPerHour: 30, updatedBy: 'admin', updatedAt: new Date().toISOString() } });
      }
      return route.fulfill({ json: saved ? { configured: true, provider: 'anthropic', model: saved.model, hasApiKey: true, apiKeyHint: 'abcd', maxGenerationsPerHour: 30 } : { configured: false } });
    });
    await page.route('**/admin/v1/settings/llm/test', (route) => route.fulfill({ json: { ok: true, latencyMs: 210 } }));

    await login(page, 'admin', 'admin');
    await page.getByRole('link', { name: 'Settings' }).click();
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
    const panel = page.getByTestId('llm-settings');
    await expect(panel).toContainText('No key configured');
    await panel.getByRole('radio', { name: 'Anthropic (Claude)' }).check();
    await panel.getByLabel('Model', { exact: true }).selectOption('claude-sonnet-5-5');
    await panel.getByLabel('API key').fill('sk-ant-e2e-fake-key-0000abcd');
    await panel.getByRole('button', { name: 'Test connection' }).click();
    await expect(panel).toContainText('Connection OK (210 ms)');
    await panel.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('LLM settings saved')).toBeVisible();
    expect(saved).toMatchObject({ provider: 'anthropic', model: 'claude-sonnet-5-5', apiKey: 'sk-ant-e2e-fake-key-0000abcd' });
    await expect(panel).toContainText('Key configured (ending in ••••abcd)');
    await expect(panel.getByLabel('API key')).toHaveValue('');
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/settings.png` });
  });

  test('owner: description → graph → draft → dry-run → publish', async ({ page }) => {
    await fakeLlm(page);
    await login(page, 'owner', 'owner');
    await page.goto('/composer');
    const nl = page.getByTestId('composer-nl');
    await nl.getByLabel('What should the tool do?').fill('Crie uma tool que traz o resumo do colaborador com escala atual e últimas marcações');
    await nl.getByRole('button', { name: 'Generate' }).click();

    const proposal = page.getByTestId('proposal');
    await expect(proposal).toContainText('Busca o colaborador');
    await expect(proposal.getByTestId('dag')).toContainText('rh_colaborador_get');
    await expect(proposal.locator('[data-edge="colab->escalas"]')).toHaveCount(1);
    await expect(proposal.locator('[data-edge="colab->marcacoes"]')).toHaveCount(1);
    await expect(proposal).toContainText('rh_escalas_list · disabled');
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/composer-nl.png` });

    await proposal.getByRole('button', { name: 'Accept and save draft' }).click();
    await expect(page.getByText('Draft saved. Run the dry-run, then publish.')).toBeVisible();
    await expect(page.getByRole('tab', { name: 'YAML editor' })).toHaveAttribute('aria-selected', 'true');

    // the dry-run needs every step tool enabled: enable the disabled ones explicitly
    const disabled = page.getByTestId('disabled-steps');
    while (await disabled.isVisible()) {
      await disabled.getByRole('button').first().click();
      await expect(page.getByText(/enabled$/).first()).toBeVisible();
    }

    await page.locator('[aria-label="Dry-run input"] .cm-content').fill('{ "colaborador_id": "col-00001" }');
    await page.getByRole('button', { name: 'Run dry-run' }).click();
    await expect(page.getByText('Final output (redacted)')).toBeVisible();
    await expect(page.locator('.dag-node.status-ok')).toHaveCount(3);

    await page.getByRole('button', { name: 'Publish' }).click();
    const wizard = page.getByTestId('publish-wizard');
    await wizard.getByRole('button', { name: 'Enable' }).first().click();
    await expect(wizard.getByText('enabled', { exact: true })).toHaveCount(4);
    await wizard.getByRole('button', { name: 'Next' }).click();
    // dev seed: role agent may call everything
    await expect(wizard.locator('td .badge', { hasText: 'deny' })).toHaveCount(0);
    await expect(wizard.locator('td .badge', { hasText: 'allow' })).toHaveCount(4);
    await wizard.getByRole('button', { name: 'Next' }).click();
    await wizard.getByRole('button', { name: 'Next' }).click();
    await expect(page.getByTestId('publish-summary')).toContainText(`Ready: the selected roles can call ${NAME}.`);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/publish-wizard.png` });
  });

  test('admin adds the composite to an MCP server and an agent calls it', async ({ page, request }) => {
    const token = await apiToken(request, 'admin', 'admin');
    const headers = { authorization: `Bearer ${token}`, 'x-tenant': 'dev' };
    const vs = await request.post('/admin/v1/virtual-servers', { headers, data: { slug: SLUG, name: 'E2E composer', toolSelector: { tools: [] } } });
    expect(vs.ok()).toBeTruthy();
    const vsId = (await vs.json()).id as string;
    try {
      await login(page, 'admin', 'admin');
      await page.goto('/composer');
      await page.getByRole('button', { name: new RegExp(NAME) }).click();
      await page.getByRole('button', { name: 'Publish' }).click();
      const wizard = page.getByTestId('publish-wizard');
      await page.getByRole('dialog').getByRole('tab', { name: '3. MCP server' }).click();
      const row = wizard.getByRole('row', { name: new RegExp(SLUG) });
      await row.getByRole('button', { name: 'Add' }).click();
      await expect(row).toContainText('included');

      const selector = (await (await request.get(`/admin/v1/virtual-servers/${vsId}`, { headers })).json()).toolSelector;
      expect(selector.tools).toContain(NAME);

      // an agent sees the composite in that MCP and calls it
      const agent = { authorization: 'Bearer mgw_dev-agent-token-somente-para-desenvolvimento', accept: 'application/json, text/event-stream', 'content-type': 'application/json' };
      const init = await request.post(`/mcp/s/${SLUG}`, {
        headers: agent,
        data: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } } },
      });
      expect(init.ok()).toBeTruthy();
      const session = init.headers()['mcp-session-id'];
      const withSession = { ...agent, ...(session ? { 'mcp-session-id': session } : {}) };
      await request.post(`/mcp/s/${SLUG}`, { headers: withSession, data: { jsonrpc: '2.0', method: 'notifications/initialized' } });
      const call = await request.post(`/mcp/s/${SLUG}`, {
        headers: withSession,
        data: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: NAME, arguments: { colaborador_id: 'col-00001' } } },
      });
      const text = await call.text();
      expect(text).toContain('escala_atual');
      expect(text).not.toContain('"isError":true');
    } finally {
      await request.delete(`/admin/v1/virtual-servers/${vsId}`, { headers });
    }
  });
});
