import { LOG_REDACT_PATHS } from '@mcp-gateway/core';
import pino, { type DestinationStream, type Logger } from 'pino';

export type { Logger };

export function createLogger(level: string, destination?: DestinationStream): Logger {
  return pino({ level, base: { service: 'mcp-crawler' }, redact: { paths: LOG_REDACT_PATHS, censor: '[REDACTED]' } }, destination);
}
