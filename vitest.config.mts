import { existsSync } from 'node:fs';
import path from 'node:path';
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// Local runs read the root .env; CI provides the same variables directly.
if (existsSync('.env')) {
  process.loadEnvFile('.env');
}

const root = import.meta.dirname;
const src = (pkg: string, file = 'index.ts') => path.join(root, 'packages', pkg, 'src', file);

export default defineConfig({
  // SWC keeps emitDecoratorMetadata, which NestJS dependency injection relies on.
  plugins: [
    swc.vite({
      jsc: {
        parser: { syntax: 'typescript', decorators: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
        target: 'es2023',
      },
    }),
  ],
  resolve: {
    // Workspace packages are tested from source (same mapping as tsconfig paths).
    alias: [
      { find: /^@hv\/db\/testing$/, replacement: src('db', 'testing/index.ts') },
      { find: /^@hv\/db$/, replacement: src('db') },
      { find: /^@hv\/domain$/, replacement: src('domain') },
      { find: /^@hv\/contracts$/, replacement: src('contracts') },
    ],
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          // Tooling under tools/ is plain ESM with no build step, so its
          // unit tests live beside it rather than in a workspace package.
          include: ['{apps,packages}/*/src/**/*.test.ts', 'tools/**/*.test.mjs'],
          environment: 'node',
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          // Real PostgreSQL + Redis (docker compose). Never mocked.
          include: ['{apps,packages}/*/test/**/*.int.test.ts'],
          environment: 'node',
          globalSetup: ['packages/db/src/testing/global-setup.ts'],
          testTimeout: 30_000,
          hookTimeout: 30_000,
          // Each file starts its own database and NestJS app, and the ticket
          // tests drive real contention. One worker per core starves PostgreSQL
          // and the timing-sensitive tests, which then fail on load rather than
          // on behaviour. Capped, the suite is both green and ~5x faster.
          maxWorkers: 4,
          minWorkers: 1,
        },
      },
    ],
  },
});
