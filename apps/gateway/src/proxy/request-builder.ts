import { ValidationError, type OperationRef } from '@mcp-gateway/core';
import { msg } from '@mcp-gateway/i18n/server';
import type { HttpRequestSpec } from './types';

/**
 * Safe path param encoding. `.` and `..` are rejected: the URL parser normalizes even
 * `%2E%2E` as a parent segment, which would allow navigating the upstream path. So are values
 * with a `.`/`..` segment between slashes (`../../admin`): an upstream that decodes `%2F` before
 * routing (common behind proxies) would read them as a traversal. Control characters too.
 */
export function encodePathParam(value: unknown): string {
  const s = typeof value === 'object' ? JSON.stringify(value) : String(value);
  if (s === '') throw new ValidationError(msg('proxy.emptyPathParam'));
  const traversal = s.split(/[/\\]/).some((seg) => /^\.{1,2}$/.test(seg.trim()));
  // eslint-disable-next-line no-control-regex
  if (traversal || /[\u0000-\u001f\u007f]/.test(s)) throw new ValidationError(msg('proxy.invalidPathParam'));
  return encodeURIComponent(s);
}

const segments = (p: string) => p.split('/').filter(Boolean).length;

function scalar(v: unknown): string {
  return typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v);
}

function joinUrl(baseUrl: string, path: string): URL {
  const base = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  return new URL(`${base}${path.startsWith('/') ? path : `/${path}`}`);
}

/** Builds the HTTP request from the `operation_ref` (mapping generated in F2.3). */
export function buildHttpRequest(baseUrl: string, op: OperationRef, args: Record<string, unknown>): HttpRequestSpec {
  const mapping = op.mapping ?? { params: [] };
  let path = op.path;
  const query: Array<[string, string]> = [];
  const headers: Record<string, string> = { accept: 'application/json, */*;q=0.5' };

  for (const p of mapping.params) {
    const value = args[p.field];
    if (value === undefined || value === null) {
      if (p.in === 'path') throw new ValidationError(msg('proxy.missingRequiredParam', { field: p.field }));
      continue;
    }
    if (p.in === 'path') {
      path = path.replaceAll(`{${p.name}}`, encodePathParam(value));
    } else if (p.in === 'query') {
      if (Array.isArray(value)) {
        if (p.explode === false) query.push([p.name, value.map(scalar).join(',')]);
        else for (const item of value) query.push([p.name, scalar(item)]);
      } else {
        query.push([p.name, scalar(value)]);
      }
    } else {
      const h = scalar(value);
      if (/[\r\n]/.test(h)) throw new ValidationError(msg('proxy.invalidHeader', { field: p.field }));
      headers[p.name.toLowerCase()] = h;
    }
  }
  if (/\{[^}]+\}/.test(path)) throw new ValidationError(msg('proxy.unresolvedPathParams', { path: op.path }));

  const url = joinUrl(baseUrl, path);
  // Defense in depth: the final path must have the same shape as the template.
  if (segments(url.pathname) !== segments(new URL(baseUrl).pathname) + segments(op.path)) {
    throw new ValidationError(msg('proxy.pathParamChangesTarget'));
  }
  for (const [k, v] of query) url.searchParams.append(k, v);

  let body: string | undefined;
  const b = mapping.body;
  if (b) {
    let payload: unknown;
    if (b.mode === 'field') {
      payload = b.field ? args[b.field] : undefined;
    } else {
      const obj: Record<string, unknown> = {};
      for (const f of b.fields ?? []) if (args[f] !== undefined) obj[f] = args[f];
      payload = Object.keys(obj).length ? obj : undefined;
    }
    if (payload !== undefined) {
      if (/json/.test(b.contentType) || b.contentType === '*/*') {
        headers['content-type'] = 'application/json';
        body = JSON.stringify(payload);
      } else if (b.contentType === 'application/x-www-form-urlencoded') {
        headers['content-type'] = b.contentType;
        const form = new URLSearchParams();
        for (const [k, v] of Object.entries((payload ?? {}) as Record<string, unknown>)) {
          if (v !== undefined && v !== null) form.append(k, scalar(v));
        }
        body = form.toString();
      } else {
        throw new ValidationError(msg('proxy.unsupportedBodyContentType', { contentType: b.contentType }));
      }
    }
  }

  return { method: op.method.toUpperCase(), url, headers, ...(body !== undefined ? { body } : {}) };
}
