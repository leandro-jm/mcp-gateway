import { describe, expect, it } from 'vitest';
import { JsonataSandbox } from '../src/proxy/jsonata-sandbox';

/** ADR-013: untrusted JSONata must not block the gateway's event loop nor exhaust its heap. */
describe('JsonataSandbox', () => {
  const sandbox = new JsonataSandbox({ timeoutMs: 500, maxResultBytes: 1024, maxHeapMb: 64 });

  /** Runs `fn` while counting event-loop ticks of the main thread. */
  async function withTicks<T>(fn: () => Promise<T>): Promise<{ value: T; ticks: number }> {
    let ticks = 0;
    const timer = setInterval(() => ticks++, 20);
    try {
      return { value: await fn(), ticks };
    } finally {
      clearInterval(timer);
    }
  }

  it('evaluates and returns plain JSON', async () => {
    expect(await sandbox.evaluate('items[n > 1].n', { items: [{ n: 1 }, { n: 2 }, { n: 3 }] })).toEqual({ kind: 'ok', value: [2, 3] });
    expect(await sandbox.evaluate('missing', {})).toEqual({ kind: 'ok', value: null });
  });

  it('stops exponential recursion without blocking the main thread', async () => {
    const { value, ticks } = await withTicks(() => sandbox.evaluate('( $f := function($n){ $n>0 ? $f($n-1)+$f($n-1) : 0 }; $f(40) )', {}));
    expect(value).toEqual({ kind: 'timeout' });
    expect(ticks).toBeGreaterThan(5);
  });

  it('stops deep recursion and huge builtins (heap limit)', async () => {
    expect(await sandbox.evaluate('( $f := function($n){ $n>0 ? 1+$f($n-1) : 0 }; $f(100000) )', {})).toEqual({ kind: 'resources' });
    const pad = await sandbox.evaluate('$length($pad("", 500000000))', {});
    expect(['resources', 'timeout']).toContain(pad.kind);
  }, 15_000);

  it('rejects results over the byte limit and reports evaluation errors', async () => {
    expect(await sandbox.evaluate('[1..1000]', {})).toEqual({ kind: 'too_large' });
    expect(await sandbox.evaluate('$number("x") + {}', {})).toMatchObject({ kind: 'error' });
  });

  it('answers busy when the queue is full', async () => {
    const tiny = new JsonataSandbox({ timeoutMs: 300, maxConcurrent: 1, maxQueued: 0 });
    const slow = tiny.evaluate('( $f := function($n){ $n>0 ? $f($n-1)+$f($n-1) : 0 }; $f(40) )', {});
    expect(await tiny.evaluate('1', {})).toEqual({ kind: 'busy' });
    await slow;
  });
});
