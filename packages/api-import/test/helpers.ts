import { FAKE_CREDENTIALS } from '@mcp-gateway/testkit';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

export const API_HEADERS = { 'x-api-key': FAKE_CREDENTIALS.apiKey, 'content-type': 'application/json' };

export function ajv() {
  const a = new Ajv2020({ strict: false, allErrors: true });
  addFormats.default(a);
  return a;
}

/** Calls the fake upstream and returns the status and the parsed JSON body. */
export async function call(url: string, init: RequestInit = {}): Promise<{ status: number; json: unknown; text: string }> {
  const res = await fetch(url, { ...init, headers: { ...API_HEADERS, ...(init.headers as Record<string, string>) } });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : undefined, text };
}
