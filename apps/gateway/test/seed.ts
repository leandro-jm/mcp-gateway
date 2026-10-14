import type { PolicyInput } from '@mcp-gateway/db';
import { generateTools, parseSpec } from '@mcp-gateway/openapi-toolgen';
import { FAKE_CREDENTIALS, type FakeUpstream } from '@mcp-gateway/testkit';
import { Client as ModernClient, StreamableHTTPClientTransport as ModernTransport, type ClientCapabilities } from '@modelcontextprotocol/client';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Harness } from './harness';

export interface SeededTenant {
  tenantId: string;
  sourceId: string;
  credentialId: string | null;
  tools: Record<string, string>;
}

/** Creates tenant + credential + source of the fake upstream and registers/enables the generated tools. */
export async function seedRhTenant(
  h: Harness,
  up: FakeUpstream,
  opts: {
    slug?: string;
    credential?: 'oauth' | 'apikey' | 'none';
    enable?: string[] | 'all';
    sourceSettings?: Record<string, unknown>;
    /** Tenant policies. Default: role `agent` may do everything, including the destructive `marcacao` ones. */
    policies?: PolicyInput[];
  } = {},
): Promise<SeededTenant> {
  const repos = h.services.repos;
  // Test tokens may have created the tenant earlier (harness `mintToken`).
  const slug = opts.slug ?? 'acme';
  const tenant = (await repos.tenants.findBySlug(slug)) ?? (await repos.tenants.create({ slug, name: 'ACME' }));
  let credentialId: string | null = null;
  if ((opts.credential ?? 'oauth') === 'oauth') {
    credentialId = (
      await repos.credentials.create(tenant.id, {
        name: 'rh-oauth',
        type: 'oauth2_client_credentials',
        config: { tokenUrl: `${up.url}/oauth/token`, clientId: FAKE_CREDENTIALS.clientId, clientSecret: FAKE_CREDENTIALS.clientSecret },
      })
    ).id;
  } else if (opts.credential === 'apikey') {
    credentialId = (
      await repos.credentials.create(tenant.id, { name: 'rh-key', type: 'api_key', config: { name: 'X-API-Key', value: FAKE_CREDENTIALS.apiKey } })
    ).id;
  }
  const source = await repos.sources.create(tenant.id, {
    name: 'rh',
    openapiUrl: `${up.url}/openapi.json`,
    baseUrl: up.url,
    credentialId,
    ownerTeam: 'team-rh',
    settings: opts.sourceSettings ?? {},
  });
  const spec = await (await fetch(`${up.url}/openapi.json`)).json();
  const { tools } = generateTools(await parseSpec(spec), { sourceName: 'rh' });
  const ids: Record<string, string> = {};
  for (const g of tools) {
    const enable = opts.enable === 'all' || (opts.enable ?? 'all') === 'all' || (opts.enable as string[]).includes(g.name);
    const t = await repos.tools.create(tenant.id, {
      kind: 'openapi',
      sourceId: source.id,
      operationKey: g.operationKey,
      name: g.name,
      title: g.title,
      description: g.description,
      operationRef: g.operationRef,
      inputSchema: g.inputSchema,
      outputSchema: g.outputSchema,
      annotations: g.annotations,
      specHash: g.specHash,
      tags: g.tags,
      ownerTeam: 'team-rh',
      state: enable ? 'enabled' : 'disabled',
    });
    ids[g.name] = t.id;
  }
  const policies: PolicyInput[] = opts.policies ?? [
    { subjectType: 'role', subject: 'agent', effect: 'allow', toolPattern: '*' },
    { subjectType: 'role', subject: 'agent', effect: 'allow', toolPattern: 'rh_marcacao_*' },
  ];
  for (const p of policies) await repos.policies.create(tenant.id, p);
  await h.services.registry.invalidate(tenant.id);
  return { tenantId: tenant.id, sourceId: source.id, credentialId, tools: ids };
}

export async function mcpClient(baseUrl: string, token: string, path = '/mcp'): Promise<Client> {
  const client = new Client({ name: 'test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}${path}`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  return client;
}

/** MCP client on the 2026-07-28 era (ADR-021): stateless, client info and capabilities in every request envelope. */
export async function modernMcpClient(
  baseUrl: string,
  token: string,
  path = '/mcp',
  opts: { name?: string; version?: string; capabilities?: ClientCapabilities; headers?: Record<string, string> } = {},
): Promise<ModernClient> {
  const client = new ModernClient(
    { name: opts.name ?? 'modern-test', version: opts.version ?? '2.0.0' },
    { capabilities: opts.capabilities ?? {}, versionNegotiation: { mode: { pin: '2026-07-28' } } },
  );
  await client.connect(
    new ModernTransport(new URL(`${baseUrl}${path}`), { requestInit: { headers: { authorization: `Bearer ${token}`, ...opts.headers } } }),
  );
  return client;
}
