export const VERSION = '0.1.0';
export const REPO_URL = 'https://github.com/leandro-jm/mcp-gateway';
export const AUTHOR = { name: 'Leandro Martins', url: 'https://github.com/leandro-jm' };

/** Link to a file or folder on the default branch. */
export const repoFile = (path: string) => `${REPO_URL}/blob/main/${path}`;
export const repoTree = (path: string) => `${REPO_URL}/tree/main/${path}`;

declare global {
  interface Window {
    /** Public assets inlined as data URIs by the single-file build (scripts/build-single.ts). */
    __SITE_ASSETS__?: Record<string, string>;
  }
}

/** Public asset URL that honors the Vite `base` (GitHub Pages serves under /mcp-gateway/). */
export const asset = (path: string) => window.__SITE_ASSETS__?.[path] ?? `${import.meta.env.BASE_URL}${path}`;
