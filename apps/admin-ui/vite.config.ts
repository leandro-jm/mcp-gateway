import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const gateway = process.env.GATEWAY_URL ?? 'http://localhost:4000';

export default defineConfig({
  plugins: [react()],
  // one React for the whole app, also when @mcp-ui-kit/* is pnpm-linked from a local checkout
  resolve: { dedupe: ['react', 'react-dom'] },
  // the lazy `charts` chunk carries the tree-shaken ECharts (~660 kB, ~225 kB gzip; ADR-028),
  // loaded only by the pages that draw charts
  build: { chunkSizeWarningLimit: 700 },
  server: {
    port: 5180,
    strictPort: true,
    // In dev, the UI talks to the gateway through the same origin (no CORS).
    proxy: { '/admin': gateway, '/mcp': gateway, '/sdk': gateway },
  },
  preview: { port: 5180, strictPort: true, proxy: { '/admin': gateway, '/mcp': gateway, '/sdk': gateway } },
});
