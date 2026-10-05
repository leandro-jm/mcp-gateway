import { endSession, getToken } from '../auth/auth';
import { translateUi } from '../i18n/catalog';
import { getLocale } from '../i18n/locale';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly payload: { error?: string; message?: string; details?: unknown },
  ) {
    super(payload.message ?? `HTTP ${status}`);
  }
}

let currentTenant: string | null = null;
export const setApiTenant = (slug: string | null) => {
  currentTenant = slug;
};

/** Admin API call with the user's token and the selected tenant (`X-Tenant`). */
export async function api<T>(path: string, init: { method?: string; body?: unknown; tenant?: string | null } = {}): Promise<T> {
  const token = getToken();
  const tenant = init.tenant === undefined ? currentTenant : init.tenant;
  const res = await fetch(`/admin/v1${path}`, {
    method: init.method ?? 'GET',
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      // only used before login; afterwards the gateway follows the user's profile (ADR-012)
      'accept-language': getLocale(),
      ...(tenant ? { 'x-tenant': tenant } : {}),
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  if (res.status === 401) {
    endSession();
    throw new ApiError(401, { message: translateUi(getLocale(), { key: 'auth.sessionExpired' }) });
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const json = text ? JSON.parse(text) : undefined;
  if (!res.ok) throw new ApiError(res.status, json ?? {});
  return json as T;
}
