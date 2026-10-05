import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { main: 'src/main.ts' },
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  splitting: false,
  noExternal: [/^@mcp-gateway\//],
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
});
