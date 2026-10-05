import { jsonBytes } from '@mcp-gateway/call-analytics';
import { UpstreamError } from '@mcp-gateway/core';
import { msg } from '@mcp-gateway/i18n/server';
import type { CapturedCall } from './debug-capture';
import type { UpstreamAdapter, UpstreamCall, UpstreamResult } from './types';

/**
 * Replay-mock (F15.18): answers with the responses recorded by a debug capture instead of calling
 * the upstream. Composite steps get their recordings in order, per tool.
 */
export class RecordedUpstreamAdapter implements UpstreamAdapter {
  readonly kind = 'recorded';
  private readonly queues = new Map<string, Array<{ status: number; body: unknown }>>();

  constructor(private readonly recorded: Pick<CapturedCall, 'tool' | 'upstream' | 'steps'>) {
    if (recorded.upstream) this.queues.set(recorded.tool, [recorded.upstream]);
    for (const step of recorded.steps ?? []) {
      const q = this.queues.get(step.tool) ?? [];
      q.push({ status: step.status, body: step.body });
      this.queues.set(step.tool, q);
    }
  }

  async call(call: UpstreamCall): Promise<UpstreamResult> {
    const next = this.queues.get(call.tool.name)?.shift();
    if (!next) throw new UpstreamError(msg('analytics.notCaptured', { callId: call.tool.name }));
    return {
      status: next.status,
      contentType: typeof next.body === 'string' ? 'text/plain' : 'application/json',
      body: next.body,
      bytes: jsonBytes(next.body),
      durationMs: 0,
      attempts: 1,
    };
  }
}
