import type { AuthContext } from '../common/request-context';
import type { GuestContext } from '../guests/guest-sessions.repository';
import { Errors } from '../common/errors';

/**
 * Who is checking out: a signed-in customer, or a guest (ADR-0029, ADR-0031).
 *
 * This is a discriminated union on purpose. The two identities are different
 * types carrying different facts, and code downstream has to say which one it
 * is holding rather than reaching for whichever field happens to be set.
 *
 * It is NOT an authorization decision and cannot become one. `AccessGuard`
 * still decides who may call what; this only answers "whose basket is this",
 * and a guest never reaches it on a route that required a session.
 */
export type CheckoutIdentity =
  { kind: 'user'; auth: AuthContext } | { kind: 'guest'; guest: GuestContext };

/**
 * Resolves the basket's owner from what the guard attached.
 *
 * A signed-in caller always wins: the guard does not resolve a guest alongside
 * an authenticated session, and if both were somehow present the account is
 * the stronger identity. A caller with neither has nothing to own a basket
 * with and is told so, without being told which one was missing.
 */
export function checkoutIdentity(
  auth: AuthContext | null,
  guest: GuestContext | null,
): CheckoutIdentity {
  if (auth) return { kind: 'user', auth };
  if (guest) return { kind: 'guest', guest };
  throw Errors.badRequest(
    'CHECKOUT_IDENTITY_REQUIRED',
    'Sign in, or verify your email address, before using a basket.',
  );
}
