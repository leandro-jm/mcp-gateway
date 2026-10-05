import { DEFAULT_LOCALE, type Locale } from '@mcp-gateway/i18n';
import { msg, translate, type ResourceName, type ServerMessage } from '@mcp-gateway/i18n/server';

/**
 * Domain error catalog and MCP mapping.
 *
 * Errors carry a translatable `Message` (ADR-012) and are rendered in the caller's locale at the
 * edge (`toJSON`, `toMcpError`, `toToolResult`). `error.message` is always English, for logs.
 *
 * Two delivery modes for MCP clients:
 * - `protocol`: JSON-RPC error (e.g. unknown tool; the MCP spec uses -32602).
 * - `tool`: tool result with `isError: true`, visible to the model so it can correct itself.
 */

export const JSONRPC = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
} as const;

export type McpDelivery = 'protocol' | 'tool';

export interface McpErrorShape {
  code: number;
  message: string;
  data: { type: string; details?: unknown };
}

/**
 * Tool error result. It has no `structuredContent`: MCP clients validate
 * `structuredContent` against the tool's `outputSchema` even on errors.
 */
export interface McpToolErrorResult {
  isError: true;
  content: Array<{ type: 'text'; text: string }>;
}

export abstract class GatewayError extends Error {
  abstract readonly code: string;
  abstract readonly httpStatus: number;
  abstract readonly delivery: McpDelivery;
  readonly jsonRpcCode: number = JSONRPC.InternalError;

  constructor(
    readonly msg: ServerMessage,
    readonly details?: unknown,
  ) {
    super(translate(msg));
    this.name = new.target.name;
  }

  /** The message rendered in `locale`. */
  localize(locale: Locale = DEFAULT_LOCALE): string {
    return translate(this.msg, locale);
  }

  toMcpError(locale: Locale = DEFAULT_LOCALE): McpErrorShape {
    return {
      code: this.jsonRpcCode,
      message: this.localize(locale),
      data: this.details === undefined ? { type: this.code } : { type: this.code, details: this.details },
    };
  }

  toToolResult(locale: Locale = DEFAULT_LOCALE): McpToolErrorResult {
    const payload: Record<string, unknown> = { error: this.code, message: this.localize(locale) };
    if (this.details !== undefined) payload.details = this.details;
    return { isError: true, content: [{ type: 'text', text: JSON.stringify(payload) }] };
  }

  toJSON(locale: Locale = DEFAULT_LOCALE): Record<string, unknown> {
    return { error: this.code, message: this.localize(locale), ...(this.details === undefined ? {} : { details: this.details }) };
  }
}

export class ToolNotFound extends GatewayError {
  readonly code = 'TOOL_NOT_FOUND';
  readonly httpStatus = 404;
  readonly delivery = 'protocol';
  override readonly jsonRpcCode = JSONRPC.InvalidParams;
  constructor(toolName: string) {
    super(msg('common.toolNotFound', { tool: toolName }), { tool: toolName });
  }
}

export class ToolDisabled extends GatewayError {
  readonly code = 'TOOL_DISABLED';
  readonly httpStatus = 409;
  readonly delivery = 'protocol';
  override readonly jsonRpcCode = JSONRPC.InvalidParams;
  constructor(toolName: string, state: string) {
    super(msg('common.toolDisabled', { tool: toolName, state }), { tool: toolName, state });
  }
}

export class Forbidden extends GatewayError {
  readonly code = 'FORBIDDEN';
  readonly httpStatus = 403;
  readonly delivery = 'tool';
  constructor(message: ServerMessage = msg('common.forbidden'), details?: unknown) {
    super(message, details);
  }
}

export class Unauthorized extends GatewayError {
  readonly code = 'UNAUTHORIZED';
  readonly httpStatus = 401;
  readonly delivery = 'protocol';
  override readonly jsonRpcCode = JSONRPC.InvalidRequest;
  constructor(message: ServerMessage = msg('common.unauthorized'), details?: unknown) {
    super(message, details);
  }
}

export class ValidationError extends GatewayError {
  readonly code = 'VALIDATION_ERROR';
  readonly httpStatus = 400;
  readonly delivery = 'tool';
  override readonly jsonRpcCode = JSONRPC.InvalidParams;
  constructor(message: ServerMessage, details?: unknown) {
    super(message, details);
  }
}

export class NotFound extends GatewayError {
  readonly code = 'NOT_FOUND';
  readonly httpStatus = 404;
  readonly delivery = 'protocol';
  override readonly jsonRpcCode = JSONRPC.InvalidParams;
  constructor(resource: ResourceName, id: string) {
    super(msg('common.notFound', { resource: msg(`resource.${resource}`), id }), { resource, id });
  }
}

export class Conflict extends GatewayError {
  readonly code = 'CONFLICT';
  readonly httpStatus = 409;
  readonly delivery = 'protocol';
  constructor(message: ServerMessage, details?: unknown) {
    super(message, details);
  }
}

export class UpstreamError extends GatewayError {
  readonly code = 'UPSTREAM_ERROR';
  readonly httpStatus = 502;
  readonly delivery = 'tool';
  constructor(
    message: ServerMessage,
    readonly upstreamStatus?: number,
    details?: unknown,
  ) {
    super(message, upstreamStatus === undefined ? details : { status: upstreamStatus, ...(details as object) });
  }
}

export class RateLimited extends GatewayError {
  readonly code = 'RATE_LIMITED';
  readonly httpStatus = 429;
  readonly delivery = 'tool';
  constructor(scope: string, retryAfterMs: number) {
    super(msg('common.rateLimited', { scope, seconds: Math.ceil(retryAfterMs / 1000) }), { scope, retryAfterMs });
  }
}

export function isGatewayError(e: unknown): e is GatewayError {
  return e instanceof GatewayError;
}
