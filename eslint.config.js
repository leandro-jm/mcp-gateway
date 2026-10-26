import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// Pure logic packages: no I/O allowed (see CLAUDE.md).
const PURE_PACKAGES = [
  'packages/core',
  'packages/i18n',
  'packages/openapi-toolgen',
  'packages/api-import',
  'packages/policy',
  'packages/redaction',
  'packages/projection',
  'packages/composition',
  'packages/composer',
  'packages/call-analytics',
  'packages/tool-router',
];

const IO_MODULES = [
  'fs',
  'node:fs',
  'fs/promises',
  'node:fs/promises',
  'net',
  'node:net',
  'http',
  'node:http',
  'https',
  'node:https',
  'child_process',
  'node:child_process',
  'pg',
  'ioredis',
  'bullmq',
  'undici',
  '@aws-sdk/client-s3',
  'drizzle-orm',
  '@mcp-gateway/db',
  '@mcp-gateway/artifacts',
];

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**', '**/migrations/**', 'apps/admin-ui/public/**', 'apps/site/public/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },
  {
    files: PURE_PACKAGES.map((p) => `${p}/src/**/*.ts`),
    ignores: ['**/*.test.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { paths: IO_MODULES.map((name) => ({ name, message: 'Pure package: I/O is not allowed.' })) },
      ],
      'no-restricted-globals': ['error', { name: 'fetch', message: 'Pure package: I/O is not allowed.' }],
    },
  },
  {
    files: ['**/*.test.ts', '**/test/**/*.ts'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
  {
    // exemplos de uso imprimem no terminal
    files: ['examples/**/*.ts'],
    rules: { 'no-console': 'off' },
  },
  {
    // k6 scripts run on the k6 runtime (not Node)
    files: ['perf/k6/**/*.js'],
    languageOptions: { globals: { __ENV: 'readonly', __VU: 'readonly', __ITER: 'readonly' } },
  },
  {
    files: ['apps/admin-ui/**/*.{ts,tsx}', 'apps/site/src/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
  },
);
