import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { UpstreamError, ValidationError, type GatewayError } from '@mcp-gateway/core';
import { translate } from '@mcp-gateway/i18n/server';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ANTHROPIC_BASE_URL, AnthropicProvider, createLlmProvider, OpenAiProvider, type LlmClientConfig } from '../src/llm';

const KEY = 'sk-test-llm-secret-key-0123456789';
const SCHEMA = { type: 'object', properties: { a: { type: 'string' } }, required: ['a'], additionalProperties: false };
const REQ = { system: 'SYS', context: '<catalog>[]</catalog>', user: 'make a tool', schema: SCHEMA, maxTokens: 1000 };

interface Seen {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: any;
}

let server: Server;
let base: string;
let seen: Seen[] = [];
let reply: (s: Seen) => { status: number; body: unknown } = () => ({ status: 200, body: {} });

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const s: Seen = { method: req.method!, url: req.url!, headers: req.headers, body: raw ? JSON.parse(raw) : undefined };
      seen.push(s);
      const r = reply(s);
      res.writeHead(r.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(r.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
afterEach(() => {
  seen = [];
});

const cfg = (extra: Partial<LlmClientConfig> = {}): LlmClientConfig => ({
  provider: 'openai_compatible',
  model: 'local-model',
  baseUrl: `${base}/v1/`,
  apiKey: KEY,
  jsonMode: 'schema',
  ...extra,
});
const open = { allowPrivate: true, allowedHosts: [] };

describe('OpenAI-compatible provider (F14.2)', () => {
  it('sends a strict json_schema request and maps the answer and usage', async () => {
    reply = () => ({
      status: 200,
      body: { model: 'local-model-v2', choices: [{ finish_reason: 'stop', message: { content: '{"a":"x"}' } }], usage: { prompt_tokens: 10, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 4 } } },
    });
    const r = await new OpenAiProvider(cfg(), open).generate(REQ);
    expect(r).toEqual({ output: '{"a":"x"}', stop: 'end', model: 'local-model-v2', usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 4 } });
    const [s] = seen;
    expect(s!.url).toBe('/v1/chat/completions');
    expect(s!.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(s!.body).toMatchObject({
      model: 'local-model',
      max_tokens: 1000,
      response_format: { type: 'json_schema', json_schema: { name: 'composite_proposal', strict: true, schema: SCHEMA } },
    });
    expect(s!.body.messages).toEqual([
      { role: 'system', content: 'SYS' },
      { role: 'user', content: '<catalog>[]</catalog>\n\nmake a tool' },
    ]);
  });

  it('falls back to json_object with the schema in the instructions', async () => {
    reply = () => ({ status: 200, body: { choices: [{ finish_reason: 'length', message: { content: '{' } }] } });
    const r = await new OpenAiProvider(cfg({ jsonMode: 'object' }), open).generate(REQ);
    expect(r.stop).toBe('max_tokens');
    expect(seen[0]!.body.response_format).toEqual({ type: 'json_object' });
    expect(seen[0]!.body.messages[0].content).toContain(JSON.stringify(SCHEMA));
  });

  it('reports refusals', async () => {
    reply = () => ({ status: 200, body: { choices: [{ finish_reason: 'stop', message: { content: null, refusal: 'no' } }] } });
    expect((await new OpenAiProvider(cfg(), open).generate(REQ)).stop).toBe('refusal');
  });

  it('maps HTTP errors without echoing the provider body', async () => {
    reply = () => ({ status: 401, body: { error: `bad key ${KEY}` } });
    const err = await new OpenAiProvider(cfg(), open).ping().catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(translate((err as GatewayError).msg)).toBe('the LLM provider rejected the API key');
    reply = () => ({ status: 500, body: { error: `boom ${KEY}` } });
    const err2 = await new OpenAiProvider(cfg(), open).generate(REQ).catch((e) => e);
    expect(err2).toBeInstanceOf(UpstreamError);
    expect(JSON.stringify(err2.toJSON('en')) + String(err2.message)).not.toContain(KEY);
    expect(seen.at(-1)!.url).toBe('/v1/chat/completions');
  });

  it('blocks a private base URL when the network policy forbids it (SSRF)', async () => {
    const err = await new OpenAiProvider(cfg(), { allowPrivate: false, allowedHosts: [] }).ping().catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(seen).toHaveLength(0);
  });

  it('requires a base URL for compatible providers and pins the OpenAI one', () => {
    expect(() => new OpenAiProvider(cfg({ baseUrl: null }), open)).toThrow(ValidationError);
    expect(createLlmProvider(cfg({ provider: 'openai', baseUrl: 'http://evil.example' }), open)).toMatchObject({ baseUrl: 'https://api.openai.com/v1' });
  });
});

describe('Anthropic provider (F14.2)', () => {
  const anthropicCfg = (model = 'claude-opus-5-5') => cfg({ provider: 'anthropic', model, baseUrl: null });
  const message = (stop: string) => ({
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    content: [{ type: 'text', text: '{"a":"x"}' }],
    stop_reason: stop,
    stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 },
  });

  it('ignores ANTHROPIC_BASE_URL and ANTHROPIC_API_KEY from the environment', () => {
    process.env.ANTHROPIC_BASE_URL = base;
    process.env.ANTHROPIC_API_KEY = 'env-key';
    try {
      const client = (createLlmProvider(anthropicCfg(), open) as any).client;
      expect(client.baseURL).toBe(ANTHROPIC_BASE_URL);
      expect(client.apiKey).toBe(KEY);
    } finally {
      delete process.env.ANTHROPIC_BASE_URL;
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it('sends structured output, cache breakpoints and the refusal fallback', async () => {
    reply = () => ({ status: 200, body: message('end_turn') });
    const r = await new AnthropicProvider(anthropicCfg(), { baseURL: base }).generate(REQ);
    expect(r).toEqual({ output: '{"a":"x"}', stop: 'end', model: 'claude-opus-5-5', usage: { inputTokens: 1000, outputTokens: 20, cacheReadTokens: 900 } });
    const [s] = seen;
    expect(s!.url).toMatch(/^\/v1\/messages/);
    expect(s!.headers['x-api-key']).toBe(KEY);
    expect(s!.headers['anthropic-beta']).toContain('server-side-fallback-2026-07-01');
    expect(s!.body).toMatchObject({
      model: 'claude-opus-5-5',
      max_tokens: 1000,
      fallbacks: 'default',
      output_config: { format: { type: 'json_schema', schema: SCHEMA }, effort: 'medium' },
      system: [{ type: 'text', text: 'SYS', cache_control: { type: 'ephemeral' } }],
    });
    expect(s!.body.messages[0].content).toEqual([
      { type: 'text', text: '<catalog>[]</catalog>', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'make a tool' },
    ]);
  });

  it('omits effort and the fallback on Haiku 4.5 and maps stop reasons', async () => {
    reply = () => ({ status: 200, body: message('refusal') });
    const r = await new AnthropicProvider(anthropicCfg('claude-haiku-4-5'), { baseURL: base }).generate(REQ);
    expect(r.stop).toBe('refusal');
    expect(seen[0]!.body.output_config).toEqual({ format: { type: 'json_schema', schema: SCHEMA } });
    expect(seen[0]!.body.fallbacks).toBeUndefined();
    expect(seen[0]!.headers['anthropic-beta']).toBeUndefined();
  });

  it('maps authentication errors', async () => {
    reply = () => ({ status: 401, body: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } } });
    const err = await new AnthropicProvider(anthropicCfg(), { baseURL: base }).ping().catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(seen[0]!.url).toBe('/v1/models/claude-opus-5-5');
  });
});
