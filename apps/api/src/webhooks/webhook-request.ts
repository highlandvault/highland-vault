import type { FastifyRequest } from 'fastify';

/**
 * The provider webhook boundary (Phase 6, owner decisions D5 = B and D6 = C).
 *
 * A provider webhook and a browser request are authenticated by different
 * things, and neither can supply what the other proves.
 *
 * A browser request carries a session cookie the browser attaches by itself,
 * so the danger is our own customer's browser being used against them by
 * another site. The defence is provenance: `Origin` is evidence only a browser
 * can give honestly. A provider webhook carries no cookie and no session — it
 * has no authority at all until it proves some — so the danger is forgery by
 * anyone on the internet, and the defence is a signature over the bytes. A
 * provider cannot report a trustworthy `Origin`, and a browser cannot keep a
 * shared secret. Requiring an origin here would refuse every legitimate
 * request while stopping nothing.
 *
 * So the origin check does not apply to these routes. That removes no
 * protection they ever had — they have no ambient credential to protect — and
 * it is safe only because the signature genuinely replaces it.
 *
 * The exemption is an exact list of ROUTE PATTERNS, not a path prefix. A near
 * miss like `/webhooksfoo` matches no route and is a 404 from Fastify's router
 * before any of this is consulted, and widening the exemption means adding a
 * pattern here deliberately rather than editing a string that happens to match
 * more than it used to.
 */
export const PROVIDER_WEBHOOK_ROUTES: readonly string[] = Object.freeze([
  '/webhooks/payments/:provider',
]);

/**
 * How much of a provider's message is read.
 *
 * A payment event is small — a few fields and some provider metadata — so this
 * is set well under the API's global 64 KB, and a body above it is refused by
 * our own code with its own answer rather than by the framework with a message
 * that looks nothing like the real problem.
 *
 * O13 may require raising it: what a real provider actually sends is one of
 * the characteristics still to be gathered.
 */
export const WEBHOOK_MAX_BODY_BYTES = 32 * 1024;

/** Whether the matched route is authenticated by a provider signature. */
export function isProviderWebhookRoute(request: FastifyRequest): boolean {
  const url = request.routeOptions?.url;
  return typeof url === 'string' && PROVIDER_WEBHOOK_ROUTES.includes(url);
}

/** A request whose original bytes were kept, because its signature covers them. */
export interface WithRawBody {
  rawBody?: Buffer;
}

/** The exact bytes as they arrived, or undefined if this route did not keep them. */
export function rawBodyOf(request: FastifyRequest): Buffer | undefined {
  return (request as FastifyRequest & WithRawBody).rawBody;
}
