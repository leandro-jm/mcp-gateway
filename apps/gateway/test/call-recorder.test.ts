import { Forbidden, RateLimited, ToolNotFound, UpstreamError, ValidationError } from '@mcp-gateway/core';
import { msg } from '@mcp-gateway/i18n/server';
import { describe, expect, it } from 'vitest';
import type { CallContext } from '../src/proxy/executor';
import { CircuitOpen } from '../src/proxy/guards';
import { UpstreamTimeout } from '../src/proxy/rest-adapter';
import { toAuditInput } from '../src/telemetry/call-events/derive';
import { CallRecorder, classifyError } from '../src/telemetry/call-events/recorder';

const ctx = {
  tenantId: 't1',
  principal: { sub: 'agent', roles: ['agent'], groups: [], claims: {}, clientId: 'bot', locale: 'en' },
  snapshot: { tenant: { slug: 'acme', settings: {} } },
  sessionKey: 's-abc',
  identity: { endpoint: 'omni', sessionSource: 'header', agentName: 'claude-code', agentVersion: '2' },
  inboundTrace: { source: 'meta', parentSpanId: 'aaaaaaaaaaaaaaaa' },
} as unknown as CallContext;

describe('classifyError (F15.7)', () => {
  it('maps gateway errors to code, stage and message key', () => {
    expect(classifyError(new Forbidden(msg('proxy.argsNotObject')))).toMatchObject({ code: 'FORBIDDEN', stage: 'authz' });
    expect(classifyError(new ValidationError(msg('proxy.argsNotObject')))).toEqual({ code: 'VALIDATION_ERROR', stage: 'validation', key: 'proxy.argsNotObject' });
    expect(classifyError(new RateLimited('tenant', 1000)).stage).toBe('rate_limit');
    expect(classifyError(new ToolNotFound('x')).stage).toBe('protocol');
    expect(classifyError(new CircuitOpen('rh', 1000))).toMatchObject({ code: 'CIRCUIT_OPEN', stage: 'circuit' });
    expect(classifyError(new UpstreamTimeout(10))).toMatchObject({ code: 'UPSTREAM_TIMEOUT', stage: 'upstream' });
    expect(classifyError(new UpstreamError(msg('proxy.argsNotObject'), undefined, { step: 'colab' })).stage).toBe('composite');
    expect(classifyError(new Error('boom'), 'projection')).toEqual({ code: 'INTERNAL_ERROR', stage: 'projection' });
  });
});

describe('CallRecorder (F15.7)', () => {
  it('fills identity from the context and closes with tokens and latency', async () => {
    const rec = new CallRecorder(ctx, { kind: 'tool', toolName: 'x', started: 1000 });
    expect(rec.ev).toMatchObject({ tenantSlug: 'acme', endpoint: 'omni', viaOmni: true, agentName: 'claude-code', sessionSource: 'header', inboundParentSpanId: 'aaaaaaaaaaaaaaaa', clientId: 'bot' });
    await rec.stage('upstream', async () => undefined);
    rec.addStage('upstream', 10);
    rec.upstream({ status: 200, attempts: 2, bytes: 4000 });
    rec.projection(4000, 1000, 'p1', false);
    rec.artifact('a1', 2000, 400);
    rec.responseBytes(400);
    rec.redactions(2, { cpf: 2 });
    rec.redactions(1, { cpf: 1 });
    const ev = rec.finish(1250);
    expect(ev.latencyMs).toBe(250);
    expect(ev.stages!.upstream).toBeGreaterThanOrEqual(10);
    expect(ev).toMatchObject({ rawTokens: 1000, responseTokens: 100, tokensSavedProjection: 750, tokensSavedArtifact: 400, redactionsCount: 3, redactionsByDetector: { cpf: 3 } });
    expect(rec.projectedBytesSaved).toBe(3000);
  });

  it('a deny keeps its decision on failure and the audit keeps the old detail shape', () => {
    const rec = new CallRecorder(ctx, { kind: 'tool', toolName: 'x' });
    rec.policy({
      effect: 'deny',
      reason: 'explicit_deny',
      ruleId: 'r1',
      explanation: msg('proxy.argsNotObject'),
      obligations: { rateLimits: [] },
      trace: [{ ruleId: 'r1', effect: 'deny', matched: true, note: msg('proxy.argsTooLarge', { limit: 123 }) }],
    });
    rec.fail(new Forbidden(msg('proxy.argsNotObject')));
    rec.finish();
    expect(rec.ev).toMatchObject({ decision: 'deny', policyRuleId: 'r1', errorStage: 'authz' });
    expect(rec.ev.policyTrace).toEqual([{ ruleId: 'r1', effect: 'deny', matched: true, note: 'proxy.argsTooLarge' }]);
    expect(toAuditInput(rec, 'tools/call')).toMatchObject({ decision: 'deny', details: { reason: 'explicit_deny', ruleId: 'r1' } });
  });

  it('an allow puts the deciding rule into the audit details', () => {
    const rec = new CallRecorder(ctx, { kind: 'tool', toolName: 'x' });
    rec.policy({ effect: 'allow', reason: 'allow', ruleId: 'r9', explanation: msg('proxy.argsNotObject'), obligations: { rateLimits: [] }, trace: [] });
    rec.finish();
    expect(rec.ev.policyTrace).toBeUndefined();
    expect(toAuditInput(rec, 'tools/call').details).toEqual({ ruleId: 'r9' });
  });
});
