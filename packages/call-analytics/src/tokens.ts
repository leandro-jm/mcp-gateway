/**
 * Token estimates (ADR-016 §11): bytes / 4. Good enough to compare mechanisms and price savings;
 * not a billing figure (real tokenization depends on the model).
 */
export const BYTES_PER_TOKEN = 4;

export function estimateTokens(bytes: number | null | undefined): number {
  if (!bytes || bytes <= 0) return 0;
  return Math.ceil(bytes / BYTES_PER_TOKEN);
}

export function jsonBytes(value: unknown): number {
  if (value === undefined) return 0;
  return Buffer.byteLength(JSON.stringify(value) ?? '');
}

/** Tokens a tool descriptor (or a whole `tools/list` result) costs in the model context. */
export function descriptorTokens(descriptor: unknown): number {
  return estimateTokens(jsonBytes(descriptor));
}

/** Tokens saved between two sizes (never negative). */
export function tokensSaved(bytesBefore: number | null | undefined, bytesAfter: number | null | undefined): number {
  return Math.max(0, estimateTokens(bytesBefore) - estimateTokens(bytesAfter));
}
