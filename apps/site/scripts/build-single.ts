/**
 * Builds the landing page as one self-contained HTML file (no network, works from file://):
 * JS, CSS, fonts, favicon and the Admin UI screenshots are inlined as data URIs.
 * Fonts keep only the latin subset in woff2, which covers en, pt-BR and es.
 *
 * Usage: pnpm --filter @mcp-gateway/site build:single
 * Output: apps/site/dist/mcp-gateway-landing.html (override with OUT=path).
 */
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = join(ROOT, 'public');
const OUT = resolve(process.env.OUT ?? join(ROOT, 'dist', 'mcp-gateway-landing.html'));

const MIME: Record<string, string> = {
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
};

async function dataUri(file: string): Promise<string> {
  const mime = MIME[extname(file)] ?? 'application/octet-stream';
  return `data:${mime};base64,${(await readFile(file)).toString('base64')}`;
}

/** Keeps only latin (not latin-ext) @font-face rules, woff2 only, with the font inlined. */
async function inlineFonts(css: string, assetsDir: string): Promise<string> {
  const rules = css.match(/@font-face\{[^}]*\}/g) ?? [];
  let out = css;
  for (const rule of rules) {
    const woff2 = /url\(\.\/([^)]+-latin-\d+-normal-[^)]+\.woff2)\)/.exec(rule);
    if (!woff2) {
      out = out.replace(rule, () => '');
      continue;
    }
    const src = `src:url(${await dataUri(join(assetsDir, woff2[1]!))})format("woff2");`;
    out = out.replace(rule, () => rule.replace(/src:[^;]*;/, () => src));
  }
  return out;
}

/** `</script` inside inlined JS would close the tag early. */
const scriptSafe = (js: string) => js.replace(/<\/script/gi, '<\\/script');

async function main(): Promise<void> {
  const tmp = await mkdtemp(join(tmpdir(), 'mcp-gw-site-'));
  try {
    await build({ root: ROOT, base: './', logLevel: 'warn', build: { outDir: tmp, emptyOutDir: true } });
    const assetsDir = join(tmp, 'assets');
    const files = await readdir(assetsDir);
    const jsFile = files.find((f) => f.endsWith('.js'));
    const cssFile = files.find((f) => f.endsWith('.css'));
    if (!jsFile || !cssFile) throw new Error('vite build produced no JS/CSS bundle');

    const css = await inlineFonts(await readFile(join(assetsDir, cssFile), 'utf8'), assetsDir);
    const js = await readFile(join(assetsDir, jsFile), 'utf8');

    // Screenshots are picked at runtime by `asset()` (src/lib/links.ts), so they go in a lookup map.
    const assets: Record<string, string> = {};
    for (const f of await readdir(join(PUBLIC_DIR, 'screens'))) {
      if (MIME[extname(f)]) assets[`screens/${f}`] = await dataUri(join(PUBLIC_DIR, 'screens', f));
    }

    let html = await readFile(join(tmp, 'index.html'), 'utf8');
    const favicon = await dataUri(join(PUBLIC_DIR, 'favicon.svg'));
    html = html
      .replace(/<link rel="icon" href="[^"]*"/, () => `<link rel="icon" href="${favicon}"`)
      .replace(/\s*<script type="module" crossorigin src="[^"]*"><\/script>/, () => '')
      .replace(/\s*<link rel="stylesheet" crossorigin href="[^"]*">/, () => '')
      .replace('</head>', () => `    <style>${css}</style>\n  </head>`)
      .replace(
        '</body>',
        () =>
          `    <script>window.__SITE_ASSETS__=${scriptSafe(JSON.stringify(assets))};</script>\n` +
          `    <script type="module">${scriptSafe(js)}</script>\n  </body>`,
      );

    await mkdir(dirname(OUT), { recursive: true });
    await writeFile(OUT, html);
    process.stdout.write(`wrote ${OUT} (${(Buffer.byteLength(html) / 1024 / 1024).toFixed(2)} MB)\n`);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

await main();
