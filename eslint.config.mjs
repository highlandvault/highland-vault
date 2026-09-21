import nextCoreWebVitals from 'eslint-config-next/core-web-vitals';
import base from '@hv/config/eslint';

const WEB_FILES = ['apps/web/**/*.{ts,tsx}'];

export default [
  ...base,
  // Next.js rules apply to the web app only.
  ...nextCoreWebVitals.map((config) => ({
    ...config,
    files: WEB_FILES,
    settings: { ...config.settings, next: { rootDir: 'apps/web' } },
  })),
  {
    files: ['**/*.test.ts', '**/*.int.test.ts', 'apps/web/e2e/**/*.ts'],
    rules: {
      // Tests assert on shapes they just created; non-null assertions keep them readable.
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
];
