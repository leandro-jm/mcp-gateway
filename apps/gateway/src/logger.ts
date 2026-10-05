import { LOG_REDACT_PATHS } from '@mcp-gateway/core';
import pino, { type DestinationStream, type Logger } from 'pino';

export type { Logger };

/** Logger that redacts sensitive keys (auth headers, secrets, credential configs). */
export function createLogger(level: string, destination?: DestinationStream): Logger {
  return pino(
    {
      level,
      base: { service: 'mcp-gateway' },
      redact: { paths: LOG_REDACT_PATHS, censor: '[REDACTED]' },
    },
    destination,
  );
}
