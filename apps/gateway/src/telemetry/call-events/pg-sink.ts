import type { CallEvent } from '@mcp-gateway/call-analytics';
import type { CallEventWriter } from '@mcp-gateway/db';
import type { GatewayConfig } from '../../config';
import type { Logger } from '../../logger';
import type { Metrics } from '../metrics';
import { BatchingCallEventSink, type CallEventSink } from './sink';

/**
 * Postgres sink (ADR-016 §3): batched multi-row inserts into the daily-partitioned `call_events`.
 * Sanitization runs at flush time, off the call's hot path.
 */
export function createPgCallEventSink(
  writer: CallEventWriter,
  config: GatewayConfig,
  metrics: Metrics,
  logger: Logger,
  sanitize: (ev: CallEvent) => CallEvent = (ev) => ev,
): CallEventSink {
  return new BatchingCallEventSink({
    writeBatch: async (batch) => {
      await writer.insertBatchWithRefs(batch.map((q) => ({ event: sanitize(q.event), ...(q.refs ? { refs: q.refs } : {}) })));
    },
    flushMs: config.CALL_EVENTS_FLUSH_MS,
    batchSize: config.CALL_EVENTS_BATCH_SIZE,
    bufferMax: config.CALL_EVENTS_BUFFER_MAX,
    metrics,
    logger,
  });
}
