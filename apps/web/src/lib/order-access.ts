/**
 * The return link's cookie (P6-8; OD-2; **D18 = B**).
 *
 * Shared by the Route Handler that sets it and the page that reads it, so the
 * name, path and lifetime cannot drift apart between the two halves of one
 * mechanism — a cookie written at one path and read at another fails silently,
 * which is the worst way for a credential to fail.
 *
 * Not `server-only`: the Route Handler and the Server Component both import it
 * and neither runs in the browser. It holds no secret, only three constants.
 */

/** Where the plaintext token lives once it is out of the URL. HttpOnly, always. */
export const ACCESS_COOKIE = 'hv_order_access';

/**
 * Scoped to the return pages.
 *
 * Narrow on purpose: a credential that is attached to every request the
 * customer makes for the rest of their visit is a credential with far more
 * opportunities to leak than it needs.
 */
export const ACCESS_COOKIE_PATH = '/checkout/payments';

/**
 * How long the browser keeps it.
 *
 * **This is not the token's lifetime and must never be mistaken for it.** The
 * token expires at `orders.expires_at + ORDER_ACCESS_TOKEN_TAIL_MINUTES`
 * (D19a), decided by the API and enforced in PostgreSQL. This only stops the
 * browser holding a cookie long after it could be useful; an hour is already
 * longer than any link can live, so it can only ever expire *after* the token
 * it carries — it cannot extend anything.
 */
export const ACCESS_COOKIE_MAX_AGE = 60 * 60;
