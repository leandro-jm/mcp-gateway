/** Thin Admin API client (`/admin/v1`): bearer token + `X-Tenant`. */

export class AdminError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
    method: string,
    path: string,
  ) {
    super(`${method} ${path} → ${status}: ${JSON.stringify(body)}`);
  }
}

export interface ToolDto {
  id: string;
  kind: string;
  sourceId: string | null;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: { readOnlyHint?: boolean; destructiveHint?: boolean };
  state: 'disabled' | 'enabled' | 'deprecated' | 'removed';
}
export interface SourceDto {
  id: string;
  name: string;
}
export interface TenantDto {
  id: string;
  slug: string;
  settings: Record<string, unknown>;
}
export interface UserDto {
  id: string;
  username: string;
  kind: 'human' | 'service';
  roles: string[];
  groups: string[];
}
export interface PolicyDto {
  id: string;
  subjectType: string;
  subject: string;
  effect: 'allow' | 'deny';
  toolPattern: string;
}
export interface VirtualServerDto {
  id: string;
  slug: string;
  mode: 'full' | 'omni';
  toolSelector: Record<string, unknown>;
}
export interface ToolRouterView {
  platformEnabled: boolean;
  settings: Record<string, unknown>;
  provider: { configured: boolean; provider?: string; model?: string };
}
export interface Decision {
  effect: 'allow' | 'deny';
  reason: string;
  ruleId: string | null;
}

export interface Admin {
  readonly tenant: string;
  request<T>(method: string, path: string, body?: unknown): Promise<T>;
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
  put<T>(path: string, body: unknown): Promise<T>;
  patch<T>(path: string, body: unknown): Promise<T>;
  del(path: string): Promise<void>;
  /** Every item of a `{items, total}` page, 500 at a time. */
  listAll<T>(path: string): Promise<T[]>;
}

export function adminClient(baseUrl: string, token: string, tenant: string): Admin {
  const root = `${baseUrl.replace(/\/+$/, '')}/admin/v1`;
  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${root}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        'x-tenant': tenant,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    const parsed: unknown = text ? JSON.parse(text) : undefined;
    if (!res.ok) throw new AdminError(res.status, parsed, method, path);
    return parsed as T;
  }
  return {
    tenant,
    request,
    get: (p) => request('GET', p),
    post: (p, b) => request('POST', p, b ?? {}),
    put: (p, b) => request('PUT', p, b),
    patch: (p, b) => request('PATCH', p, b),
    del: async (p) => void (await request('DELETE', p)),
    async listAll<T>(path: string) {
      const items: T[] = [];
      const sep = path.includes('?') ? '&' : '?';
      for (let offset = 0; ; offset += 500) {
        const page = await request<{ items: T[]; total: number }>('GET', `${path}${sep}limit=500&offset=${offset}`);
        items.push(...page.items);
        if (page.items.length < 500 || items.length >= page.total) return items;
      }
    },
  };
}

export async function findSource(admin: Admin, name: string): Promise<SourceDto> {
  const source = (await admin.listAll<SourceDto>('/sources')).find((s) => s.name === name);
  if (!source) throw new Error(`source "${name}" not found in tenant ${admin.tenant}`);
  return source;
}

export async function findTenant(admin: Admin): Promise<TenantDto> {
  const tenant = (await admin.listAll<TenantDto>('/tenants')).find((t) => t.slug === admin.tenant);
  if (!tenant) throw new Error(`tenant "${admin.tenant}" not found (the admin token must be a platform admin's)`);
  return tenant;
}
