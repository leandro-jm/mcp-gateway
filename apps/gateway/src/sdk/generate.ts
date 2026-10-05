import type { McpToolDescriptor } from '../proxy/executor';

type Schema = Record<string, unknown>;
const isObj = (v: unknown): v is Schema => typeof v === 'object' && v !== null && !Array.isArray(v);
const IDENT = /^[A-Za-z_$][\w$]*$/;

const pascal = (s: string) =>
  s
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((p) => p[0]!.toUpperCase() + p.slice(1))
    .join('');
const camel = (s: string) => {
  const p = pascal(s);
  return p[0]!.toLowerCase() + p.slice(1);
};
const key = (k: string) => (IDENT.test(k) ? k : JSON.stringify(k));
const doc = (text: unknown, pad: string) =>
  typeof text === 'string' && text.trim() ? `${pad}/** ${text.replace(/\*\//g, '* /').replace(/\s+/g, ' ').trim()} */\n` : '';

/** JSON Schema → TypeScript type (the subset used by generated tools). */
export function tsType(s: unknown, depth = 0): string {
  if (!isObj(s) || depth > 8) return 'unknown';
  if (s.const !== undefined) return JSON.stringify(s.const);
  if (Array.isArray(s.enum)) return s.enum.map((v) => JSON.stringify(v)).join(' | ') || 'never';
  for (const k of ['oneOf', 'anyOf'] as const) {
    if (Array.isArray(s[k])) return (s[k] as unknown[]).map((b) => wrap(tsType(b, depth + 1))).join(' | ') || 'unknown';
  }
  if (Array.isArray(s.allOf)) return (s.allOf as unknown[]).map((b) => wrap(tsType(b, depth + 1))).join(' & ') || 'unknown';
  const types = Array.isArray(s.type) ? (s.type as string[]) : typeof s.type === 'string' ? [s.type] : [];
  if (!types.length) {
    if (isObj(s.properties)) return objectType(s, depth);
    if (isObj(s.items)) return `${wrap(tsType(s.items, depth + 1))}[]`;
    return 'unknown';
  }
  return types
    .map((t) => {
      switch (t) {
        case 'string':
          return 'string';
        case 'number':
        case 'integer':
          return 'number';
        case 'boolean':
          return 'boolean';
        case 'null':
          return 'null';
        case 'array':
          return `${wrap(tsType(s.items, depth + 1))}[]`;
        case 'object':
          return objectType(s, depth);
        default:
          return 'unknown';
      }
    })
    .join(' | ');
}

function wrap(t: string): string {
  return /[|&]/.test(t) && !t.startsWith('{') ? `(${t})` : t;
}

function objectType(s: Schema, depth: number): string {
  const props = isObj(s.properties) ? s.properties : {};
  const required = new Set(Array.isArray(s.required) ? (s.required as string[]) : []);
  const pad = '  '.repeat(depth + 1);
  const lines = Object.entries(props).map(
    ([k, v]) => `${doc(isObj(v) ? v.description : undefined, pad)}${pad}${key(k)}${required.has(k) ? '' : '?'}: ${tsType(v, depth + 1)};`,
  );
  if (s.additionalProperties !== false && (s.additionalProperties !== undefined || !Object.keys(props).length)) {
    lines.push(`${pad}[key: string]: unknown;`);
  }
  if (!lines.length) return 'Record<string, never>';
  return `{\n${lines.join('\n')}\n${'  '.repeat(depth)}}`;
}

export interface SdkOptions {
  tenant: string;
  mcpUrl: string;
  generatedAt?: Date;
}

/**
 * Typed SDK (F8.5): one function per tool the subject may use, calling `/mcp`
 * via JSON-RPC (`tools/call`). Useful for agents that write and run code.
 * Generated code is always English (like generated JSON Schema texts, ADR-012).
 */
export function generateSdk(tools: McpToolDescriptor[], opts: SdkOptions): { ts: string; dts: string } {
  const header = `/* MCP Gateway SDK — tenant "${opts.tenant}" — generated at ${(opts.generatedAt ?? new Date()).toISOString()}. Do not edit. */\n`;
  const sorted = [...tools].sort((a, b) => a.name.localeCompare(b.name));
  const types: string[] = [];
  const methods: string[] = [];
  const decls: string[] = [];
  for (const t of sorted) {
    const base = pascal(t.name);
    const input = { ...t.inputSchema };
    types.push(`${doc(`Input of ${t.name}`, '')}export type ${base}Input = ${tsType(input)};\n`);
    types.push(`${doc(`Output of ${t.name}`, '')}export type ${base}Output = ${t.outputSchema ? tsType(t.outputSchema) : 'unknown'};\n`);
    const hasRequired = Array.isArray(input.required) && input.required.length > 0;
    const param = `input: ${base}Input${hasRequired ? '' : ' = {} as ' + base + 'Input'}`;
    const ann = (t.annotations ?? {}) as Record<string, unknown>;
    const flags = [ann.readOnlyHint ? 'read-only' : 'changes data', ann.destructiveHint ? 'destructive' : ''].filter(Boolean).join(', ');
    const description = `${t.description} (${flags})`;
    methods.push(`${doc(description, '  ')}  ${camel(t.name)}(${param}): Promise<${base}Output> {\n    return this.callTool<${base}Output>(${JSON.stringify(t.name)}, input as Record<string, unknown>);\n  }\n`);
    decls.push(`${doc(description, '  ')}  ${camel(t.name)}(input${hasRequired ? '' : '?'}: ${base}Input): Promise<${base}Output>;\n`);
  }

  const runtime = `
export interface GatewayClientOptions {
  /** MCP endpoint (default: the gateway that generated this SDK). */
  url?: string;
  /** Bearer token (or a function returning a valid token). */
  token: string | (() => string | Promise<string>);
  fetch?: typeof fetch;
}

export class GatewayToolError extends Error {
  constructor(readonly tool: string, readonly payload: unknown) {
    super(\`tool \${tool} failed: \${typeof payload === 'object' && payload && 'message' in payload ? String((payload as { message: unknown }).message) : JSON.stringify(payload)}\`);
    this.name = 'GatewayToolError';
  }
}

export class GatewayClient {
  private readonly url: string;
  private readonly fetchFn: typeof fetch;
  private seq = 0;

  constructor(private readonly opts: GatewayClientOptions) {
    this.url = opts.url ?? ${JSON.stringify(opts.mcpUrl)};
    this.fetchFn = opts.fetch ?? fetch;
  }

  /** Generic call (\`tools/call\`). */
  async callTool<T = unknown>(name: string, args: Record<string, unknown>): Promise<T> {
    const token = typeof this.opts.token === 'function' ? await this.opts.token() : this.opts.token;
    const res = await this.fetchFn(this.url, {
      method: 'POST',
      headers: { authorization: \`Bearer \${token}\`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++this.seq, method: 'tools/call', params: { name, arguments: args } }),
    });
    if (!res.ok) throw new GatewayToolError(name, { status: res.status, message: await res.text() });
    const msg = (await res.json()) as { result?: { isError?: boolean; structuredContent?: unknown; content?: Array<{ type: string; text?: string }> }; error?: { code: number; message: string } };
    if (msg.error) throw new GatewayToolError(name, msg.error);
    const result = msg.result ?? {};
    const text = (result.content ?? []).find((c) => c.type === 'text')?.text;
    const parsed: unknown = result.structuredContent ?? (text !== undefined ? safeJson(text) : undefined);
    if (result.isError) throw new GatewayToolError(name, parsed);
    return parsed as T;
  }
`;
  const ts = `${header}\n${types.join('\n')}${runtime}\n${methods.join('\n')}}\n\nfunction safeJson(text: string): unknown {\n  try {\n    return JSON.parse(text);\n  } catch {\n    return text;\n  }\n}\n`;

  const dts = `${header}\n${types.join('\n')}
export interface GatewayClientOptions {
  url?: string;
  token: string | (() => string | Promise<string>);
  fetch?: typeof fetch;
}
export declare class GatewayToolError extends Error {
  readonly tool: string;
  readonly payload: unknown;
  constructor(tool: string, payload: unknown);
}
export declare class GatewayClient {
  constructor(opts: GatewayClientOptions);
  callTool<T = unknown>(name: string, args: Record<string, unknown>): Promise<T>;
${decls.join('')}}
`;
  return { ts, dts };
}
