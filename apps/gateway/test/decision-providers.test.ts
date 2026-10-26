import { UpstreamError, ValidationError, type GatewayError } from '@mcp-gateway/core';
import { translate } from '@mcp-gateway/i18n/server';
import { startFakeDecisions, type FakeDecisionsServer } from '@mcp-gateway/testkit';
import type { DecisionRequest } from '@mcp-gateway/tool-router';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createDecisionProvider, type DecisionClientConfig } from '../src/router';

const KEY = 'sk-test-decisions-secret-key-0123456789';
const open = { allowPrivate: true, allowedHosts: [] };
const REQ: DecisionRequest = {
  input: 'An AI agent.\n<data name="request">listar férias do colaborador</data>',
  questions: [
    { name: 'tool', type: 'choice', instructions: 'Which tool?', choices: [{ value: 't1', description: 'Lista férias (rh_ferias_list): férias dos colaboradores' }, { value: 't2', description: 'Lista pagamentos (fin_pagamentos_list)' }, { value: 'none', description: 'None' }] },
    { name: 'risky', type: 'predicate', instructions: 'Risky?' },
  ],
};

let fake: FakeDecisionsServer;
beforeAll(async () => {
  fake = await startFakeDecisions({ apiKey: KEY });
});
afterAll(() => fake.close());
afterEach(() => {
  fake.requests.length = 0;
  fake.failWith = undefined;
  fake.delayMs = 0;
});

const cfg = (provider: DecisionClientConfig['provider'], extra: Partial<DecisionClientConfig> = {}): DecisionClientConfig => ({
  provider,
  model: provider === 'jev' ? 'jev-latest' : 'gpt-6-luna',
  baseUrl: `${fake.url}/`,
  apiKey: KEY,
  ...extra,
});

async function failure(p: Promise<unknown>): Promise<GatewayError> {
  try {
    await p;
  } catch (err) {
    return err as GatewayError;
  }
  throw new Error('expected a failure');
}

describe.each(['openai_decisions', 'jev'] as const)('%s provider (F19.4)', (provider) => {
  it('sends the provider wire format and maps the answers back', async () => {
    const r = await createDecisionProvider(cfg(provider), open).decide(REQ);
    expect(r.answers.tool).toMatchObject({ type: 'choice', choice: 't1' });
    // no tool block in the input: the fake reads it as read-only
    expect(r.answers.risky).toEqual({ type: 'predicate', probability: 0.05 });
    const [seen] = fake.requests;
    if (provider === 'jev') {
      expect(seen!.path).toBe('/v1/systemone');
      expect(seen!.body).toMatchObject({ model: 'jev-latest', state: REQ.input, questions: { risky: { type: 'noul' } } });
    } else {
      expect(seen!.path).toBe('/v1/decisions');
      expect(seen!.body).toMatchObject({ model: 'gpt-6-luna', input: REQ.input, questions: [{ name: 'tool', type: 'choice' }, { name: 'risky', type: 'predicate' }] });
    }
  });

  it('maps a rejected key without echoing the key', async () => {
    const err = await failure(createDecisionProvider(cfg(provider, { apiKey: 'sk-wrong-key-000000000000' }), open).decide(REQ));
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.msg.key).toBe('router.invalidKey');
    expect(`${err.message} ${JSON.stringify(err.details)}`).not.toContain(KEY);
  });

  it('maps rate limiting and provider errors', async () => {
    fake.failWith = 429;
    expect((await failure(createDecisionProvider(cfg(provider), open).decide(REQ))).msg.key).toBe('router.providerRateLimited');
    fake.failWith = 500;
    const err = await failure(createDecisionProvider(cfg(provider), open).decide(REQ));
    expect(err).toBeInstanceOf(UpstreamError);
    expect(translate(err.msg)).toBe('decision provider error: HTTP 500');
  });

  it('maps an aborted call to a timeout', async () => {
    fake.delayMs = 300;
    const err = await failure(createDecisionProvider(cfg(provider), open).decide(REQ, AbortSignal.timeout(50)));
    expect(err.msg.key).toBe('router.timeout');
  });

  it('blocks private destinations when the network policy does not allow them', async () => {
    const err = await failure(createDecisionProvider(cfg(provider), { allowPrivate: false, allowedHosts: [] }).decide(REQ));
    expect(err).toBeInstanceOf(ValidationError);
    expect(fake.requests).toHaveLength(0);
  });

  it('ping is a one-predicate decision', async () => {
    await createDecisionProvider(cfg(provider), open).ping();
    expect(fake.requests).toHaveLength(1);
  });
});
