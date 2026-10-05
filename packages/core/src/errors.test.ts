import { msg, raw } from '@mcp-gateway/i18n/server';
import { describe, expect, it } from 'vitest';
import {
  Forbidden,
  isGatewayError,
  JSONRPC,
  NotFound,
  RateLimited,
  ToolDisabled,
  ToolNotFound,
  UpstreamError,
  ValidationError,
} from './errors';

describe('error catalog', () => {
  it('maps ToolNotFound and ToolDisabled to InvalidParams protocol errors', () => {
    for (const err of [new ToolNotFound('x'), new ToolDisabled('x', 'disabled')]) {
      expect(err.delivery).toBe('protocol');
      expect(err.toMcpError().code).toBe(JSONRPC.InvalidParams);
      expect(err.toMcpError().data.type).toBe(err.code);
    }
  });

  it('maps Forbidden, ValidationError and UpstreamError to tool results with isError', () => {
    const cases = [new Forbidden(), new ValidationError(raw('invalid arg'), { path: '/id' }), new UpstreamError(raw('502'), 502)];
    for (const err of cases) {
      expect(err.delivery).toBe('tool');
      const r = err.toToolResult();
      expect(r.isError).toBe(true);
      expect(JSON.parse(r.content[0]!.text)).toMatchObject({ error: err.code });
    }
  });

  it('does not expose the stack in the result', () => {
    const r = new UpstreamError(raw('timeout'), undefined, { timeoutMs: 1000 }).toToolResult();
    expect(r.content[0]!.text).not.toContain('at ');
    expect(JSON.parse(r.content[0]!.text)).toEqual({ error: 'UPSTREAM_ERROR', message: 'timeout', details: { timeoutMs: 1000 } });
    expect(r).not.toHaveProperty('structuredContent');
  });

  it('identifies gateway errors and keeps name and status', () => {
    const e = new RateLimited('tenant', 1500);
    expect(isGatewayError(e)).toBe(true);
    expect(isGatewayError(new Error('x'))).toBe(false);
    expect(e.name).toBe('RateLimited');
    expect(e.httpStatus).toBe(429);
    expect(e.message).toContain('2s');
  });

  it('keeps an English message for logs and renders it in the requested locale', () => {
    const e = new ToolNotFound('rh_x');
    expect(e.message).toBe('Unknown tool: rh_x');
    expect(e.toJSON('pt-BR')).toEqual({ error: 'TOOL_NOT_FOUND', message: 'Tool desconhecida: rh_x', details: { tool: 'rh_x' } });
    expect(e.toMcpError('es').message).toBe('Tool desconocida: rh_x');
    expect(JSON.parse(new Forbidden().toToolResult('pt-BR').content[0]!.text).message).toBe('Acesso negado');
  });

  it('translates the resource name of NotFound and keeps its id in details', () => {
    const e = new NotFound('user', '42');
    expect(e.message).toBe('user not found: 42');
    expect(e.localize('pt-BR')).toBe('Não encontrado: usuário 42');
    expect(e.details).toEqual({ resource: 'user', id: '42' });
  });

  it('renders nested messages in the same locale', () => {
    const e = new Forbidden(msg('policy.explicitDeny', { rule: 'r1', subjectType: 'role', subject: 'rh', pattern: '*' }));
    expect(e.localize('es')).toBe('denegado por la regla r1 (role:rh → *)');
  });
});
