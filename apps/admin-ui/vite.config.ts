import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const gateway = process.env.GATEWAY_URL ?? 'http://localhost:4000';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5180,
    strictPort: true,
    // In dev, the UI talks to the gateway through the same origin (no CORS).
    proxy: { '/admin': gateway, '/mcp': gateway, '/sdk': gateway },
  },
  preview: { port: 5180, strictPort: true, proxy: { '/admin': gateway, '/mcp': gateway, '/sdk': gateway } },
});
