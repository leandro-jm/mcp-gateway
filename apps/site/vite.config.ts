import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// GitHub Pages serves the site under /mcp-gateway/; the workflow sets SITE_BASE (ADR-020).
export default defineConfig({
  base: process.env.SITE_BASE ?? '/',
  plugins: [react()],
  server: { port: 5190, strictPort: true },
  preview: { port: 5190, strictPort: true },
});
