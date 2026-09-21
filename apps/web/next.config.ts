import { existsSync } from 'node:fs';
import path from 'node:path';
import type { NextConfig } from 'next';

// next build/dev/start always run with apps/web as the working directory.
const repoRoot = path.resolve(process.cwd(), '../..');

// Next.js only reads .env files from apps/web; the monorepo keeps one root .env.
const rootEnv = path.join(repoRoot, '.env');
if (existsSync(rootEnv)) {
  process.loadEnvFile(rootEnv);
}

const nextConfig: NextConfig = {
  // Workspace packages (e.g. @hv/contracts) are compiled from source.
  turbopack: { root: repoRoot },
  outputFileTracingRoot: repoRoot,
  poweredByHeader: false,
  reactStrictMode: true,
};

export default nextConfig;
