import { randomBytes } from 'node:crypto';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * UUIDv7 (RFC 9562): 48-bit Unix milliseconds, version, 74 random bits. Time-ordered, so the
 * call id alone tells which partition holds the event.
 */
export function uuidv7(now: number = Date.now(), rand: Uint8Array = randomBytes(10)): string {
  const b = new Uint8Array(16);
  let ms = Math.max(0, Math.floor(now));
  for (let i = 5; i >= 0; i--) {
    b[i] = ms % 256;
    ms = Math.floor(ms / 256);
  }
  b[6] = 0x70 | (rand[0]! & 0x0f);
  b[7] = rand[1]!;
  b[8] = 0x80 | (rand[2]! & 0x3f);
  for (let i = 9; i < 16; i++) b[i] = rand[i - 6]!;
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function isUuidv7(id: string): boolean {
  return UUID_RE.test(id);
}

/** Timestamp embedded in a UUIDv7; `undefined` for any other id. */
export function uuidv7Time(id: string): Date | undefined {
  if (!isUuidv7(id)) return undefined;
  const hex = id.replace(/-/g, '').slice(0, 12);
  return new Date(parseInt(hex, 16));
}
