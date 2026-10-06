import 'server-only';
import { z } from 'zod';

const WebServerEnvSchema = z.object({
  /** Server-side base URL of the API. Never exposed to the browser. */
  API_BASE_URL: z.url().default('http://127.0.0.1:4000'),
  /**
   * Seals the MFA enrolment handoff cookies (UI-9), and nothing else.
   *
   * Its own key rather than a share of the API's `MFA_ENCRYPTION_KEY`: this one
   * protects a value for a few minutes in a browser, the API's protects TOTP
   * secrets at rest for the life of an account, and the web tier has no
   * business being able to read the latter. See `lib/mfa-handoff.ts`.
   *
   * **Required, and deliberately without a placeholder guard of its own.** The
   * API refuses its placeholder keys when `NODE_ENV` says production, but
   * NODE_ENV is the wrong signal here and the repository already knows it:
   * `next start` reports production on any machine, so the same guard would
   * fire on a developer running the production build locally with
   * `.env.example` — the trap the return-route's `overHttps` comment
   * describes, met from another direction. Keeping the placeholder out of a
   * real deployment therefore belongs to that deployment's secret management,
   * which is where `.env.example` says these values come from.
   */
  MFA_HANDOFF_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/, 'must be 64 hex characters'),
});

export type WebServerEnv = z.infer<typeof WebServerEnvSchema>;

export function webServerEnv(): WebServerEnv {
  const result = WebServerEnvSchema.safeParse(process.env);
  if (!result.success) {
    throw new Error(
      `Invalid web environment: ${result.error.issues.map((i) => i.path.join('.')).join(', ')}`,
    );
  }
  return result.data;
}
