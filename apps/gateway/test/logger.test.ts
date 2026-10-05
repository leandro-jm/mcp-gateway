import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger } from '../src/logger';

describe('logger', () => {
  it('does not leak credentials or sensitive headers', () => {
    const lines: string[] = [];
    const dest = new Writable({
      write(chunk, _enc, cb) {
        lines.push(String(chunk));
        cb();
      },
    });
    const log = createLogger('info', dest);
    log.info({ req: { headers: { authorization: 'Bearer tok-123', 'x-api-key': 'key-456' } } }, 'req');
    log.info({ credential: { config: { clientSecret: 'sec-789' } }, clientSecret: 'sec-000', password: 'pwd' }, 'cred');
    const out = lines.join('');
    for (const s of ['tok-123', 'key-456', 'sec-789', 'sec-000', '"pwd"']) expect(out).not.toContain(s);
    expect(out).toContain('[REDACTED]');
  });
});
