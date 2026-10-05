import type { CallEvent } from '@mcp-gateway/call-analytics';
import type { Logger } from '../../logger';
import type { Metrics } from '../metrics';

/** LGPD subject fingerprint collected during a call (ADR-017). */
export interface SubjectRef {
  detector: string;
  fp: Buffer;
  direction: 'request' | 'response';
}

export interface QueuedCallEvent {
  event: CallEvent;
  refs?: SubjectRef[];
}

/**
 * Write side of analytics (ADR-016 §3). `write` never blocks the call: events are buffered and
 * flushed in batches. A ClickHouse sink can replace the Postgres one behind this interface.
 */
export interface CallEventSink {
  write(event: CallEvent, refs?: SubjectRef[]): void;
  /** Writes everything buffered so far. */
  flush(): Promise<void>;
  /** Flushes (within a time budget) and stops accepting events. */
  close(): Promise<void>;
}

export interface BatchingSinkOptions {
  writeBatch: (batch: QueuedCallEvent[]) => Promise<void>;
  flushMs: number;
  batchSize: number;
  bufferMax: number;
  metrics: Metrics;
  logger?: Logger;
  closeBudgetMs?: number;
}

/**
 * In-memory buffer flushed every `flushMs` or every `batchSize` events, one flush at a time.
 * When the buffer is full, new events are dropped (and counted): losing analytics under a spike
 * is acceptable, slowing the agent down is not. Audit stays synchronous.
 */
export class BatchingCallEventSink implements CallEventSink {
  private buffer: QueuedCallEvent[] = [];
  private inflight: Promise<void> | undefined;
  private closed = false;
  private readonly timer: NodeJS.Timeout;

  constructor(private readonly opts: BatchingSinkOptions) {
    this.timer = setInterval(() => void this.flush(), opts.flushMs);
    this.timer.unref();
  }

  write(event: CallEvent, refs?: SubjectRef[]): void {
    if (this.closed) {
      this.opts.metrics.callEventsDropped.inc({ reason: 'closed' });
      return;
    }
    if (this.buffer.length >= this.opts.bufferMax) {
      this.opts.metrics.callEventsDropped.inc({ reason: 'buffer_full' });
      return;
    }
    this.buffer.push(refs?.length ? { event, refs } : { event });
    this.opts.metrics.callEventsBuffer.set(this.buffer.length);
    if (this.buffer.length >= this.opts.batchSize) void this.flush();
  }

  flush(): Promise<void> {
    if (!this.inflight) {
      this.inflight = this.drain().finally(() => {
        this.inflight = undefined;
      });
    }
    return this.inflight;
  }

  private async drain(): Promise<void> {
    while (this.buffer.length) {
      const batch = this.buffer.splice(0, this.opts.batchSize);
      this.opts.metrics.callEventsBuffer.set(this.buffer.length);
      const end = this.opts.metrics.callEventsFlushDuration.startTimer();
      try {
        await this.writeWithRetry(batch);
        this.opts.metrics.callEventsWritten.inc(batch.length);
      } catch (err) {
        this.opts.metrics.callEventsDropped.inc({ reason: 'flush_error' }, batch.length);
        this.opts.logger?.warn({ err, events: batch.length }, 'failed to write call events');
      } finally {
        end();
      }
    }
  }

  private async writeWithRetry(batch: QueuedCallEvent[]): Promise<void> {
    try {
      await this.opts.writeBatch(batch);
    } catch {
      await this.opts.writeBatch(batch);
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    let timeout: NodeJS.Timeout | undefined;
    await Promise.race([
      this.flush(),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, this.opts.closeBudgetMs ?? 5000);
        timeout.unref();
      }),
    ]);
    clearTimeout(timeout);
  }
}

/** Keeps events in memory (tests, and deployments without analytics). */
export class MemoryCallEventSink implements CallEventSink {
  readonly events: QueuedCallEvent[] = [];

  write(event: CallEvent, refs?: SubjectRef[]): void {
    this.events.push(refs?.length ? { event, refs } : { event });
  }

  async flush(): Promise<void> {}

  async close(): Promise<void> {}
}
