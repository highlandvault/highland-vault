import 'server-only';
import { z } from 'zod';

const WebServerEnvSchema = z.object({
  /** Server-side base URL of the API. Never exposed to the browser. */
  API_BASE_URL: z.url().default('http://127.0.0.1:4000'),
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
