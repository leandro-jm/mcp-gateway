import { spawn } from 'node:child_process';
// aliased: the tsup banner of the production bundle already declares `createRequire`
import { createRequire as nodeCreateRequire } from 'node:module';

/**
 * Child process body (plain CommonJS run with `node -e`, so the build needs no extra entrypoint).
 * Serializes and size-checks the result inside the child, under its heap limit.
 */
const CHILD_SOURCE = `
process.once('message', async (job) => {
  let reply;
  try {
    const jsonata = require(job.jsonataPath);
    const value = await jsonata(job.expression, job.limits).evaluate(job.data);
    const json = (value === undefined ? undefined : JSON.stringify(value)) ?? 'null';
    reply = Buffer.byteLength(json) > job.maxResultBytes ? { kind: 'too_large' } : { kind: 'ok', json };
  } catch (err) {
    reply = { kind: 'error', code: err && err.code, message: String((err && err.message) || err) };
  }
  process.send(reply, () => process.exit(0));
});
`;

export type SandboxOutcome =
  | { kind: 'ok'; value: unknown }
  | { kind: 'timeout' }
  | { kind: 'too_large' }
  /** Heap, stack or sequence limit exceeded. */
  | { kind: 'resources' }
  /** Too many queries already running or queued in this process. */
  | { kind: 'busy' }
  | { kind: 'error'; code?: string; message: string };

export interface JsonataSandboxOptions {
  timeoutMs: number;
  maxResultBytes: number;
  maxHeapMb: number;
  maxConcurrent: number;
  /** Queued evaluations beyond `maxConcurrent` before answering `busy`. */
  maxQueued: number;
}

/** Heap sized for the largest artifact (50 MB of JSON by default, several times that once parsed). */
const DEFAULTS: JsonataSandboxOptions = { timeoutMs: 5000, maxResultBytes: 64 * 1024, maxHeapMb: 384, maxConcurrent: 2, maxQueued: 8 };

/** JSONata guardrail codes: D1012 = timeout; D1011 = stack; D2015 = sequence length. */
const LIMIT_CODES: Record<string, SandboxOutcome['kind']> = { D1012: 'timeout', D1011: 'resources', D2015: 'resources' };

/**
 * Evaluates untrusted JSONata in a disposable child process (ADR-013): native guardrails for
 * recursion and loops, a heap limit for expensive builtins and SIGKILL as the hard stop.
 */
export class JsonataSandbox {
  private readonly opts: JsonataSandboxOptions;
  private readonly jsonataPath = nodeCreateRequire(import.meta.url).resolve('jsonata');
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(opts: Partial<JsonataSandboxOptions> = {}) {
    this.opts = { ...DEFAULTS, ...opts };
  }

  async evaluate(expression: string, data: unknown): Promise<SandboxOutcome> {
    if (this.active >= this.opts.maxConcurrent) {
      if (this.queue.length >= this.opts.maxQueued) return { kind: 'busy' };
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active++;
    try {
      return await this.run(expression, data);
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }

  private run(expression: string, data: unknown): Promise<SandboxOutcome> {
    const { timeoutMs, maxResultBytes, maxHeapMb } = this.opts;
    return new Promise((resolve) => {
      // A separate process, not a worker thread: a worker running out of heap on a large
      // allocation aborts the whole parent process despite `resourceLimits`.
      const child = spawn(process.execPath, [`--max-old-space-size=${maxHeapMb}`, '-e', CHILD_SOURCE], {
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        serialization: 'advanced',
        env: {},
      });
      let settled = false;
      const done = (outcome: SandboxOutcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.kill('SIGKILL');
        resolve(outcome);
      };
      // Hard stop for builtins that run long in a single step (the guardrails only check between steps).
      const timer = setTimeout(() => done({ kind: 'timeout' }), timeoutMs + 1000);
      child.once('message', (m: { kind: string; json?: string; code?: string; message?: string }) => {
        if (m.kind === 'ok') return done({ kind: 'ok', value: JSON.parse(m.json!) });
        if (m.kind === 'too_large') return done({ kind: 'too_large' });
        const limit = m.code ? LIMIT_CODES[m.code] : undefined;
        if (limit) return done({ kind: limit } as SandboxOutcome);
        done({ kind: 'error', ...(m.code ? { code: m.code } : {}), message: m.message ?? '' });
      });
      child.once('error', (err) => done({ kind: 'error', message: err.message }));
      child.once('exit', () => done({ kind: 'resources' })); // killed by the heap limit
      child.send({ jsonataPath: this.jsonataPath, expression, data, maxResultBytes, limits: { timeout: timeoutMs, stack: 500, sequence: 1_000_000 } });
    });
  }
}
