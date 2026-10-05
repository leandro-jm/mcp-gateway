import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { main: 'src/main.ts', migrate: '../../packages/db/src/cli.ts' },
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  splitting: false,
  // pacotes do workspace exportam .ts: entram no bundle; dependências de terceiros ficam externas
  noExternal: [/^@mcp-gateway\//],
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
});
