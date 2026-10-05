import type { CredentialType } from '@mcp-gateway/core';
import { msg, translate, type ServerMessage } from '@mcp-gateway/i18n/server';

export type ImportFormat = 'openapi' | 'curl' | 'postman' | 'har';
export type OpenApiDocument = Record<string, unknown>;

/** Credential type the imported requests used. Never carries the secret value. */
export interface SuggestedCredential {
  type: CredentialType;
  in?: 'header' | 'query';
  name?: string;
}

export interface ImportResult {
  format: ImportFormat;
  /** OpenAPI 3.1 for cURL/Postman/HAR; the parsed spec itself for OpenAPI input. */
  openapi: OpenApiDocument;
  /** Candidate base URLs, most frequent first. */
  baseUrlCandidates: string[];
  /** snake_case source name (≤ 32 chars) derived from the title or host. */
  suggestedName?: string;
  suggestedCredential?: SuggestedCredential;
  warnings: ServerMessage[];
}

/** Invalid import input. `message` is English (logs); `msg` is rendered in the caller's locale. */
export class ImportError extends Error {
  constructor(readonly msg: ServerMessage) {
    super(translate(msg));
    this.name = 'ImportError';
  }
}

export const importError = (...args: Parameters<typeof msg>) => new ImportError(msg(...args));

/** Limits against oversized input (ADR-003 T11, ADR-014). */
export const MAX_OPERATIONS = 500;
export const MAX_HAR_ENTRIES = 5000;
export const MAX_CURL_COMMANDS = 500;
export const MAX_INFERRED_NODES = 2000;
/** Samples per operation used for schema inference. */
export const MAX_SAMPLES = 20;

// ------------------------------------------------- intermediate model shared by the importers

export interface NameValue {
  name: string;
  value: string;
}

export interface CapturedBody {
  contentType: string;
  kind: 'json' | 'form' | 'text';
  json?: unknown;
  fields?: Array<NameValue & { binary?: boolean }>;
}

export interface CapturedResponse {
  status: number;
  contentType?: string;
  json?: unknown;
}

/** One request seen in the input (a cURL command, a Postman item, a HAR entry). */
export interface CapturedRequest {
  /** Human label used in warnings (no query string, no credentials). */
  label: string;
  method: string;
  /** `scheme://host[:port]`; null when unknown (e.g. unresolved Postman variable). */
  origin: string | null;
  /** Decoded path; segments may already be templated (`{id}`, `:id`, `{{id}}`). */
  path: string;
  /** Descriptions of path parameters declared by the source format. */
  pathParamDescriptions?: Record<string, string>;
  query: NameValue[];
  headers: NameValue[];
  body?: CapturedBody;
  responses: CapturedResponse[];
  summary?: string;
  description?: string;
  tag?: string;
}
