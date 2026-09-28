/**
 * The internal listener (Phase 6, task P6-5; owner decision K-a).
 *
 * A second Fastify socket, carrying exactly one route, for the worker's
 * reconciler to call. It is a separate instance rather than a path on the
 * public one, and that distinction is the whole point:
 *
 *   * the CSRF origin hook is not attached here, so nothing had to be exempted
 *     from it — `PROVIDER_WEBHOOK_ROUTES` stays as narrow as P6-3 left it;
 *   * `AccessGuard`, sessions and guest resolution are not attached here, so a
 *     stolen cookie cannot authenticate against this port. Nothing reads
 *     cookies, so there is nothing for one to satisfy;
 *   * the public listener has no such route at all, so "the public API must not
 *     expose this" is a fact about what was registered, not a rule someone
 *     could edit.
 *
 * The token is required regardless of what the socket is bound to. Binding to
 * loopback or to a private network is a second defence, never the only one.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';

export const INTERNAL_TOKEN_HEADER = 'x-hv-internal-token';
export const INTERNAL_RECONCILE_ROUTE = '/internal/payments/:payment/reconcile';
export const INTERNAL_RETRY_REFUNDS_ROUTE = '/internal/refunds/retry';

/** What the listener reports back. Deliberately thin: kinds, never provider detail. */
export interface InternalReconcileResult {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

export interface InternalListenerOptions {
  readonly token: string;
  /** Reconciles one attempt. Errors propagate and become a 500. */
  readonly reconcile: (paymentId: string) => Promise<InternalReconcileResult>;
  /** Retries every refund still owed. Errors propagate and become a 500. */
  readonly retryRefunds: () => Promise<InternalReconcileResult>;
  readonly log?: {
    warn(message: string): void;
    error(message: string): void;
  };
}

/**
 * Whether the presented token is the configured one, in constant time.
 *
 * Both sides are hashed first. `timingSafeEqual` requires equal lengths and
 * throws otherwise, so comparing raw strings would mean checking the length
 * first and returning early — which answers "how long is the secret?" to anyone
 * willing to time it. Hashing makes every comparison the same 32 bytes, so a
 * wrong length and a wrong value are indistinguishable, and neither is faster.
 */
export function tokenMatches(presented: string | undefined, expected: string): boolean {
  if (presented === undefined) return false;
  const digest = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest();
  return timingSafeEqual(digest(presented), digest(expected));
}

/**
 * Builds the internal Fastify instance. It is not listening yet: the caller
 * binds it, so a failure to bind fails the thing that owns the lifecycle.
 */
export function createInternalListener(options: InternalListenerOptions): FastifyInstance {
  // Small on purpose. The only body this route accepts is none.
  const fastify = Fastify({ logger: false, bodyLimit: 1024 });

  fastify.addHook('onRequest', (request, reply, done) => {
    const header = request.headers[INTERNAL_TOKEN_HEADER];
    const presented = typeof header === 'string' ? header : undefined;
    if (!tokenMatches(presented, options.token)) {
      // No detail, and the same answer for a missing token, a wrong one and a
      // wrong-length one. A caller learns only that it is not authorised.
      options.log?.warn(`internal listener rejected a ${request.method} ${request.url}`);
      void reply.status(401).send({ error: { code: 'UNAUTHORIZED', message: 'Not authorised.' } });
      return;
    }
    done();
  });

  fastify.post<{ Params: { payment: string } }>(
    INTERNAL_RECONCILE_ROUTE,
    async (request, reply) => {
      const { payment } = request.params;
      // A uuid, or nothing. Anything else never reaches the database.
      if (!UUID.test(payment)) {
        return reply
          .status(400)
          .send({ error: { code: 'BAD_REQUEST', message: 'Bad payment id.' } });
      }
      // The payment id is the ONLY input. Market, order, provider, currency and
      // amount are all derived from the row, so there is no value a caller could
      // send that would reach across markets or change what is owed.
      const result = await options.reconcile(payment);
      return reply.status(result.status).send(result.body);
    },
  );

  // Refund retry (K-2, I25). It takes no input at all: what is owed is a
  // question for the database, never for the caller.
  fastify.post(INTERNAL_RETRY_REFUNDS_ROUTE, async (_request, reply) => {
    const result = await options.retryRefunds();
    return reply.status(result.status).send(result.body);
  });

  fastify.setErrorHandler((error: Error, request, reply) => {
    options.log?.error(`internal ${request.method} ${request.url} failed: ${error.message}`);
    void reply
      .status(500)
      .send({ error: { code: 'INTERNAL_ERROR', message: 'Something went wrong.' } });
  });

  return fastify;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
