import type { ArtifactStore } from '@mcp-gateway/artifacts';
import { decryptJson, encryptJson } from '@mcp-gateway/core';
import type { DebugCapture, DebugCaptureMaintenance, DebugCapturesRepo, Keyring } from '@mcp-gateway/db';
import type { Logger } from '../logger';
import type { CallContext } from './executor';

/** What a debug capture keeps of a call (encrypted with the tenant data key, ADR-017). */
export interface CapturedCall {
  callId: string;
  tool: string;
  capturedAt: string;
  principal: { sub: string; roles: string[]; groups: string[]; clientId?: string; claims: Record<string, unknown> };
  /** Arguments as the agent sent them. */
  args: unknown;
  /** Raw upstream response (simple tools). */
  upstream?: { status: number; body: unknown };
  /** Raw step responses (composites), in completion order. */
  steps?: Array<{ stepId: string; tool: string; index?: number; status: number; body: unknown }>;
  /** Result the agent received. */
  final: unknown;
}

export interface CaptureSlot {
  captureId: string;
}

const CACHE_MS = 5000;

/**
 * Opt-in debug capture (F15.17, ADR-017): gateway-admin opens a capture with a reason, a filter,
 * a cap and an expiry; matching calls are stored encrypted in S3 for a short time so the call
 * explorer can show raw × final and replay them. Off unless `DEBUG_CAPTURE_ENABLED` and S3.
 */
export class DebugCaptureService {
  private readonly cache = new Map<string, { at: number; captures: DebugCapture[] }>();

  constructor(
    private readonly repo: DebugCapturesRepo,
    private readonly maintenance: DebugCaptureMaintenance,
    private readonly keyring: Keyring,
    private readonly logger: Logger,
    private readonly opts: { enabled: boolean; retentionHours: number },
    private readonly store?: ArtifactStore,
  ) {}

  get enabled(): boolean {
    return this.opts.enabled && Boolean(this.store);
  }

  /** Forgets the cached captures of a tenant (after create/stop). */
  invalidate(tenantId: string): void {
    this.cache.delete(tenantId);
  }

  private async activeCaptures(tenantId: string): Promise<DebugCapture[]> {
    const hit = this.cache.get(tenantId);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.captures;
    const captures = await this.repo.active(tenantId);
    this.cache.set(tenantId, { at: Date.now(), captures });
    return captures;
  }

  /** The capture that wants this call, if any (cheap: cached per tenant). */
  async match(ctx: CallContext, tool: string): Promise<CaptureSlot | undefined> {
    if (!this.enabled) return undefined;
    const captures = await this.activeCaptures(ctx.tenantId);
    const c = captures.find(
      (x) =>
        new Date(x.expiresAt).getTime() > Date.now() &&
        (!x.filter.tool || x.filter.tool === tool) &&
        (!x.filter.subject || x.filter.subject === ctx.principal.sub) &&
        (!x.filter.clientId || x.filter.clientId === ctx.principal.clientId) &&
        (!x.filter.sessionKey || x.filter.sessionKey === ctx.sessionKey),
    );
    return c ? { captureId: c.id } : undefined;
  }

  /** Stores the call (after the response; never blocks the agent). */
  async record(tenantId: string, slot: CaptureSlot, call: CapturedCall): Promise<void> {
    if (!this.store) return;
    try {
      if (!(await this.repo.claim(tenantId, slot.captureId))) {
        this.invalidate(tenantId);
        return;
      }
      const key = await this.keyring.dataKey(tenantId);
      const body = encryptJson(key, call, `debug:${tenantId}:${call.callId}`);
      const objectKey = `debug/${tenantId}/${slot.captureId}/${call.callId}.json`;
      await this.store.put(objectKey, body, 'application/octet-stream');
      await this.repo.addItem(tenantId, {
        callId: call.callId,
        captureId: slot.captureId,
        toolName: call.tool,
        objectKey,
        sizeBytes: Buffer.byteLength(body),
        expiresAt: new Date(Date.now() + this.opts.retentionHours * 3_600_000),
      });
    } catch (err) {
      this.logger.warn({ err, tenantId, captureId: slot.captureId }, 'failed to record debug capture');
    }
  }

  /** Decrypted capture of a call, or `undefined` when there is none (or it expired). */
  async read(tenantId: string, callId: string): Promise<CapturedCall | undefined> {
    if (!this.store) return undefined;
    const item = await this.repo.item(tenantId, callId);
    if (!item) return undefined;
    const text = await this.store.getText(item.objectKey);
    return decryptJson<CapturedCall>(await this.keyring.dataKey(tenantId), text, `debug:${tenantId}:${callId}`);
  }

  /** Maintenance: removes expired items (S3 + rows) and closes expired captures. */
  async cleanup(now = new Date()): Promise<number> {
    await this.maintenance.expireCaptures(now);
    if (!this.store) return 0;
    const expired = await this.maintenance.expiredItems(now);
    if (!expired.length) return 0;
    await this.store.deleteMany(expired.map((e) => e.objectKey));
    await this.maintenance.deleteItems(expired.map((e) => e.callId));
    return expired.length;
  }
}
