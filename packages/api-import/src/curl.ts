import { msg, type ServerMessage } from '@mcp-gateway/i18n/server';
import { AuthCollector } from './auth';
import { buildOpenApi } from './openapi-builder';
import { suggestName } from './naming';
import { importError, MAX_CURL_COMMANDS, type CapturedBody, type CapturedRequest, type ImportResult, type NameValue } from './types';

type Token = { word: string } | { sep: true };

const ANSI_ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r', '\\': '\\', "'": "'", '"': '"', a: '\x07', b: '\b', e: '\x1b', f: '\f', v: '\v' };

/** POSIX-shell-like tokenizer: quotes, `$'…'`, backslash escapes, line continuations and command separators. */
export function tokenize(input: string): Token[] {
  const out: Token[] = [];
  let word = '';
  let inWord = false;
  const push = () => {
    if (inWord) out.push({ word });
    word = '';
    inWord = false;
  };
  const fail = (error: string) => importError('import.curlParse', { error });
  let i = 0;
  while (i < input.length) {
    const c = input[i]!;
    const next = input[i + 1];
    // line continuations: bash `\`, PowerShell `` ` ``, cmd `^`
    if ((c === '\\' || c === '`' || c === '^') && (next === '\n' || (next === '\r' && input[i + 2] === '\n'))) {
      i += next === '\n' ? 2 : 3;
      continue;
    }
    if (c === '\\') {
      if (next !== undefined) {
        word += next;
        inWord = true;
      }
      i += 2;
      continue;
    }
    if (c === "'") {
      const end = input.indexOf("'", i + 1);
      if (end < 0) throw fail('unterminated single quote');
      word += input.slice(i + 1, end);
      inWord = true;
      i = end + 1;
      continue;
    }
    if (c === '$' && next === "'") {
      i += 2;
      while (i < input.length && input[i] !== "'") {
        if (input[i] === '\\' && i + 1 < input.length) {
          const e = input[i + 1]!;
          if (e === 'x' && /^[0-9a-f]{2}$/i.test(input.slice(i + 2, i + 4))) {
            word += String.fromCharCode(parseInt(input.slice(i + 2, i + 4), 16));
            i += 4;
          } else if (e === 'u' && /^[0-9a-f]{4}$/i.test(input.slice(i + 2, i + 6))) {
            word += String.fromCharCode(parseInt(input.slice(i + 2, i + 6), 16));
            i += 6;
          } else {
            word += ANSI_ESCAPES[e] ?? e;
            i += 2;
          }
          continue;
        }
        word += input[i];
        i++;
      }
      if (i >= input.length) throw fail('unterminated $\' quote');
      inWord = true;
      i++;
      continue;
    }
    if (c === '"') {
      i++;
      while (i < input.length && input[i] !== '"') {
        if (input[i] === '\\' && i + 1 < input.length && '"\\$`\n'.includes(input[i + 1]!)) {
          if (input[i + 1] !== '\n') word += input[i + 1];
          i += 2;
          continue;
        }
        word += input[i];
        i++;
      }
      if (i >= input.length) throw fail('unterminated double quote');
      inWord = true;
      i++;
      continue;
    }
    if (c === '#' && !inWord) {
      while (i < input.length && input[i] !== '\n') i++;
      continue;
    }
    if (c === '\n' || c === ';' || c === '|' || (c === '&' && next === '&')) {
      push();
      out.push({ sep: true });
      i += (c === '&' || (c === '|' && next === '|')) ? 2 : 1;
      continue;
    }
    if (/\s/.test(c)) {
      push();
      i++;
      continue;
    }
    word += c;
    inWord = true;
    i++;
  }
  push();
  return out;
}

/** Splits tokens into `curl` invocations; other commands (`| jq`, `export X=…`) are ignored. */
export function splitCommands(tokens: Token[]): string[][] {
  const commands: string[][] = [];
  let current: string[] = [];
  const flush = () => {
    while (current[0] === '$') current.shift();
    if (current.length && /(^|[/\\])curl(\.exe)?$/i.test(current[0]!)) commands.push(current.slice(1));
    current = [];
  };
  for (const t of tokens) {
    if ('sep' in t) flush();
    else current.push(t.word);
  }
  flush();
  return commands;
}

type FlagKind = 'request' | 'header' | 'data' | 'data-raw' | 'data-urlencode' | 'json' | 'form' | 'form-string' | 'user' | 'cookie' | 'url' | 'bearer' | 'upload' | 'ignore';

const VALUE_FLAGS: Record<string, FlagKind> = {
  '-X': 'request', '--request': 'request',
  '-H': 'header', '--header': 'header',
  '-d': 'data', '--data': 'data', '--data-binary': 'data', '--data-ascii': 'data',
  '--data-raw': 'data-raw', '--data-urlencode': 'data-urlencode', '--json': 'json',
  '-F': 'form', '--form': 'form', '--form-string': 'form-string',
  '-u': 'user', '--user': 'user', '-b': 'cookie', '--cookie': 'cookie',
  '--url': 'url', '--oauth2-bearer': 'bearer', '-T': 'upload', '--upload-file': 'upload',
  '-A': 'ignore', '--user-agent': 'ignore', '-e': 'ignore', '--referer': 'ignore', '-o': 'ignore', '--output': 'ignore',
  '-m': 'ignore', '--max-time': 'ignore', '--connect-timeout': 'ignore', '--cacert': 'ignore', '--capath': 'ignore',
  '-E': 'ignore', '--cert': 'ignore', '--key': 'ignore', '--cert-type': 'ignore', '--key-type': 'ignore', '-x': 'ignore',
  '--proxy': 'ignore', '-U': 'ignore', '--proxy-user': 'ignore', '-w': 'ignore', '--write-out': 'ignore', '--retry': 'ignore',
  '--retry-delay': 'ignore', '--retry-max-time': 'ignore', '--resolve': 'ignore', '--connect-to': 'ignore', '--max-redirs': 'ignore',
  '-c': 'ignore', '--cookie-jar': 'ignore', '--limit-rate': 'ignore', '-r': 'ignore', '--range': 'ignore', '-z': 'ignore',
  '--time-cond': 'ignore', '--interface': 'ignore', '--dns-servers': 'ignore', '--ciphers': 'ignore', '--unix-socket': 'ignore',
  '--request-target': 'ignore', '-K': 'ignore', '--config': 'ignore', '--trace': 'ignore', '--trace-ascii': 'ignore',
  '-D': 'ignore', '--dump-header': 'ignore', '--stderr': 'ignore', '-y': 'ignore', '-Y': 'ignore',
};

const BOOL_FLAGS = new Set([
  '-k', '--insecure', '-s', '--silent', '-S', '--show-error', '-L', '--location', '--location-trusted', '-v', '--verbose',
  '-i', '--include', '-I', '--head', '-G', '--get', '--compressed', '-f', '--fail', '--fail-with-body', '-N', '--no-buffer',
  '-#', '--progress-bar', '--http1.0', '--http1.1', '--http2', '--http2-prior-knowledge', '--http3', '-g', '--globoff',
  '-n', '--netrc', '-O', '--remote-name', '-J', '--remote-header-name', '-4', '-6', '--ipv4', '--ipv6', '--tlsv1.2',
  '--tlsv1.3', '-q', '--disable', '--no-keepalive', '--tcp-nodelay', '--raw', '--digest', '--ntlm', '--negotiate',
  '--anyauth', '--basic', '--path-as-is', '--ssl-no-revoke', '--no-progress-meter', '-Z', '--parallel', '--no-sessionid',
]);

interface ParsedCommand {
  method?: string;
  head: boolean;
  get: boolean;
  url?: string;
  headers: NameValue[];
  data: Array<{ kind: 'data' | 'data-raw' | 'data-urlencode' | 'json'; value: string }>;
  form: Array<NameValue & { binary?: boolean }>;
  user: boolean;
  bearer: boolean;
  cookie: boolean;
  fileData?: string;
}

function parseFlags(args: string[], warnings: ServerMessage[], warnedFlags: Set<string>): ParsedCommand {
  const cmd: ParsedCommand = { head: false, get: false, headers: [], data: [], form: [], user: false, bearer: false, cookie: false };
  const positionals: string[] = [];
  const apply = (kind: FlagKind, value: string) => {
    switch (kind) {
      case 'request':
        cmd.method = value.toUpperCase();
        return;
      case 'header': {
        const idx = value.indexOf(':');
        if (idx > 0) cmd.headers.push({ name: value.slice(0, idx).trim(), value: value.slice(idx + 1).trim() });
        return;
      }
      case 'data':
      case 'data-raw':
      case 'data-urlencode':
      case 'json':
        if (kind !== 'data-raw' && /^@/.test(value)) cmd.fileData ??= value;
        else cmd.data.push({ kind, value });
        if (kind === 'json') {
          cmd.headers.push({ name: 'Content-Type', value: 'application/json' });
        }
        return;
      case 'form':
      case 'form-string': {
        const idx = value.indexOf('=');
        if (idx <= 0) return;
        const name = value.slice(0, idx);
        const v = value.slice(idx + 1);
        cmd.form.push(kind === 'form' && /^[@<]/.test(v) ? { name, value: '', binary: v.startsWith('@') } : { name, value: v });
        return;
      }
      case 'user':
        cmd.user = true;
        return;
      case 'bearer':
        cmd.bearer = true;
        return;
      case 'cookie':
        if (value.includes('=')) cmd.cookie = true;
        return;
      case 'url':
        cmd.url ??= value;
        return;
      case 'upload':
        cmd.fileData ??= value;
        return;
      case 'ignore':
        return;
    }
  };
  const warnFlag = (flag: string) => {
    if (warnedFlags.has(flag)) return;
    warnedFlags.add(flag);
    warnings.push(msg('import.unknownCurlFlag', { flag }));
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '-I' || arg === '--head') cmd.head = true;
    if (arg === '-G' || arg === '--get') cmd.get = true;
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      const name = eq > 0 ? arg.slice(0, eq) : arg;
      const kind = VALUE_FLAGS[name];
      if (kind) {
        const value = eq > 0 ? arg.slice(eq + 1) : args[++i];
        if (value !== undefined) apply(kind, value);
      } else if (!BOOL_FLAGS.has(arg)) {
        warnFlag(name);
      }
      continue;
    }
    if (arg.startsWith('-') && arg.length > 1) {
      // short flags: `-XPOST`, `-H'…'`, `-sSL`, `-sX POST`
      for (let j = 1; j < arg.length; j++) {
        const flag = `-${arg[j]}`;
        const kind = VALUE_FLAGS[flag];
        if (kind) {
          const rest = arg.slice(j + 1);
          const value = rest || args[++i];
          if (value !== undefined) apply(kind, value);
          break;
        }
        if (flag === '-I') cmd.head = true;
        if (flag === '-G') cmd.get = true;
        if (!BOOL_FLAGS.has(flag)) warnFlag(flag);
      }
      continue;
    }
    positionals.push(arg);
  }
  cmd.url ??= positionals.find((p) => p.includes('://')) ?? positionals[0];
  return cmd;
}

function urlencodedFields(text: string): NameValue[] {
  return [...new URLSearchParams(text)].map(([name, value]) => ({ name, value }));
}

function headerValue(headers: NameValue[], name: string): string | undefined {
  return headers.findLast((h) => h.name.toLowerCase() === name)?.value;
}

function toRequest(cmd: ParsedCommand, auth: AuthCollector, warnings: ServerMessage[]): CapturedRequest {
  if (!cmd.url) throw importError('import.curlNoUrl');
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(cmd.url) ? cmd.url : `http://${cmd.url}`);
  } catch {
    throw importError('import.curlParse', { error: 'invalid URL' });
  }
  if (cmd.user) auth.basic('option', '--user');
  if (cmd.bearer) auth.bearer('option', '--oauth2-bearer');
  if (cmd.cookie) auth.dropped('option', '--cookie');
  if (url.username || url.password) auth.basic('url', 'userinfo');

  const query: NameValue[] = [...url.searchParams].map(([name, value]) => ({ name, value }));
  const method = cmd.method ?? (cmd.head ? 'HEAD' : cmd.data.length && !cmd.get ? 'POST' : cmd.form.length || cmd.fileData ? 'POST' : 'GET');
  const label = `${method} ${url.origin}${url.pathname}`;
  let body: CapturedBody | undefined;

  const joined = cmd.data.map((d) => d.value).join('&');
  if (cmd.get && cmd.data.length) {
    query.push(...urlencodedFields(joined));
  } else if (cmd.form.length) {
    body = { contentType: 'multipart/form-data', kind: 'form', fields: cmd.form };
  } else if (cmd.data.length) {
    const declared = headerValue(cmd.headers, 'content-type');
    const looksJson = /^\s*[[{]/.test(joined);
    if ((declared && /[/+]json\b/i.test(declared)) || (!declared && looksJson)) {
      try {
        body = { contentType: declared ?? 'application/json', kind: 'json', json: JSON.parse(joined) };
      } catch {
        warnings.push(msg('import.bodyNotJson', { operation: label }));
        body = { contentType: declared ?? 'text/plain', kind: 'text' };
      }
    } else if (!declared || /x-www-form-urlencoded/i.test(declared)) {
      body = joined.includes('=')
        ? { contentType: 'application/x-www-form-urlencoded', kind: 'form', fields: cmd.data.flatMap((d) => urlencodedFields(d.kind === 'data-urlencode' && !d.value.includes('=') ? `=${d.value}` : d.value)).filter((f) => f.name) }
        : { contentType: declared ?? 'text/plain', kind: 'text' };
    } else {
      body = { contentType: declared, kind: 'text' };
    }
  } else if (cmd.fileData) {
    warnings.push(msg('import.curlFileData', { value: cmd.fileData }));
    body = { contentType: headerValue(cmd.headers, 'content-type') ?? 'application/octet-stream', kind: 'text' };
  }
  if (cmd.fileData && cmd.data.length) warnings.push(msg('import.curlFileData', { value: cmd.fileData }));

  return {
    label,
    method,
    origin: /^https?:$/.test(url.protocol) ? url.origin : null,
    path: url.pathname,
    query,
    headers: cmd.headers,
    ...(body ? { body } : {}),
    responses: [],
  };
}

/** Converts one or more pasted cURL commands into OpenAPI 3.1. */
export function importCurl(text: string): ImportResult {
  const commands = splitCommands(tokenize(text));
  if (!commands.length) throw importError('import.curlNoUrl');
  if (commands.length > MAX_CURL_COMMANDS) throw importError('import.tooManyEntries', { max: MAX_CURL_COMMANDS });
  const warnings: ServerMessage[] = [];
  const auth = new AuthCollector(warnings);
  const warnedFlags = new Set<string>();
  const requests = commands.map((args) => toRequest(parseFlags(args, warnings, warnedFlags), auth, warnings));
  const host = requests.find((r) => r.origin)?.origin;
  const { openapi, baseUrlCandidates } = buildOpenApi(requests, { title: host ? new URL(host).host : 'Imported API', auth, warnings });
  return {
    format: 'curl',
    openapi,
    baseUrlCandidates,
    ...(host ? { suggestedName: suggestName(new URL(host).hostname) } : {}),
    ...(auth.suggestion ? { suggestedCredential: auth.suggestion } : {}),
    warnings,
  };
}
