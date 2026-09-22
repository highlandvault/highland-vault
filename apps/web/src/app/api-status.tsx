import { ReadinessResponseSchema, type ReadinessResponse } from '@hv/contracts';
import { webServerEnv } from '@/env';

async function fetchReadiness(): Promise<ReadinessResponse | { error: string }> {
  try {
    const response = await fetch(`${webServerEnv().API_BASE_URL}/health/ready`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(3_000),
    });
    const parsed = ReadinessResponseSchema.safeParse(await response.json());
    return parsed.success ? parsed.data : { error: 'unexpected response shape' };
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'unreachable' };
  }
}

/** Server component: shows whether the API and its dependencies are reachable. */
export async function ApiStatus() {
  const readiness = await fetchReadiness();
  return (
    <section aria-labelledby="api-status" className="hint">
      <h2 id="api-status" className="visually-hidden">
        API status
      </h2>
      {'error' in readiness ? (
        <p data-testid="api-status">API unavailable ({readiness.error})</p>
      ) : (
        <p data-testid="api-status">
          API {readiness.status} — database {readiness.checks.database.status}, redis{' '}
          {readiness.checks.redis.status}
        </p>
      )}
    </section>
  );
}
