import { describe, expect, it } from 'vitest';
import { clientInfoOf, issueSessionId, parseSessionId } from '../src/mcp/session-id';

describe('stateless session id (F15.4)', () => {
  it('round-trips the client info', () => {
    const id = issueSessionId({ name: 'claude-code', version: '2.1.0' });
    expect(id).toMatch(/^mgs1_[A-Za-z0-9_-]+$/);
    expect(parseSessionId(id)).toMatchObject({ name: 'claude-code', version: '2.1.0', sid: expect.any(String) });
    expect(parseSessionId(issueSessionId({ name: 'x' }))?.sid).not.toBe(parseSessionId(issueSessionId({ name: 'x' }))?.sid);
  });

  it('reads clientInfo from initialize (single or batch), cleaning and truncating it', () => {
    const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: `bad\u0000name${'x'.repeat(100)}`, version: '1' } } };
    expect(clientInfoOf(init)?.name).toHaveLength(64);
    expect(clientInfoOf(init)?.name?.includes('\u0000')).toBe(false);
    expect(clientInfoOf([{ method: 'notifications/initialized' }, init])?.version).toBe('1');
    expect(clientInfoOf({ method: 'tools/call' })).toBeUndefined();
  });

  it('rejects malformed or oversized ids', () => {
    expect(parseSessionId('mgs1_***')).toBeUndefined();
    expect(parseSessionId(`mgs1_${'a'.repeat(300)}`)).toBeUndefined();
    expect(parseSessionId(`mgs1_${Buffer.from('{"cn":"x"}').toString('base64url')}`)).toBeUndefined();
    expect(parseSessionId('3b241101-e2bb-4255-8caf-4136c566a962')).toBeUndefined();
    expect(issueSessionId({ name: 'n'.repeat(64), version: 'v'.repeat(32) }).length).toBeLessThanOrEqual(256);
  });
});
