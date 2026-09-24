# ADR-0029: Guest sessions

## Status

Accepted — 2026-09-24 (owner approval during Phase 5, task P5-3). Makes ADR-0020's "bound to the session for a short time" concrete, and supplies the identity ADR-0008 keys a guest's ticket cap on.

## Context

Checkout must work without an account (D8). A guest still needs a stable identity across the handful of requests a checkout takes, and somewhere to record the email address they have verified.

The existing `sessions` table cannot carry one: `user_id` is `NOT NULL`, and every session joins a user to decide MFA and permissions. Making that column nullable would weaken the strongest statement the schema makes about who a session belongs to, and would put guests one forgotten `WHERE` clause away from an authorization decision.

ADR-0020 also says a guest's verified email is "bound to the session for a short time". When that was written there was no guest session, so "the session" was ambiguous. This ADR settles it.

## Decision

### A separate table

Guest sessions live in `guest_sessions` (migration `0012`), not in `sessions`. There is **no foreign key to `users`** and no `users` row is created for being a guest.

Token handling is identical to authenticated sessions (Revision 2 B6), reusing the same helpers rather than copies of them: a 256-bit opaque token from `generateSessionToken()`, only its SHA-256 stored, and a malformed token rejected by `isWellFormedSessionToken()` before the database is touched.

### It is not authentication

A guest session resolves to a `GuestContext`, which has no user id, no roles and no MFA state — it cannot answer an authorization question because it does not carry the facts one needs.

`AccessGuard` resolves it **only on the `public` branch**, for routes declared `@Public({ identify: true })`, and attaches it to `request.hvGuest`. Every path below that point in the guard is an authorization decision, and none of them reads `hvGuest`. A signed-in caller is never also treated as a guest.

The two identities therefore cannot be confused: they are different fields, holding different types, resolved from different cookies, on different branches. The cookie is `hv_guest`, built by the same code as `hv_session` so their `HttpOnly`, `SameSite=Lax` and `Secure` attributes cannot drift apart.

### Lifetimes

- **A guest session lasts 24 hours** (`GUEST_SESSION_TTL_HOURS`). Long enough to finish a checkout and come back to it; short enough that an abandoned browser does not carry an identity around for a week.
- **A verified email is good for 30 minutes** (`GUEST_VERIFIED_EMAIL_TTL_MINUTES`), judged on every use rather than cached, so a binding cannot go stale in someone's session and still be accepted at checkout. Proving you can read an inbox should not be good for the rest of the day.

Both are enforced by the database clock, not the caller's.

### The verified email is the cap identity

`verified_email` is `citext` and normalized exactly as `users.email` is — `lower(btrim(…))`, enforced by CHECK. That is what makes ADR-0008 work: a guest and an account holder who type the same address differently are one person to the ticket cap. ADR-0021's bridging depends on it too.

It is recorded with the moment it was verified rather than as a boolean, because "verified at some point" is not the question the window asks.

**A verified address cannot be replaced.** The guard trigger refuses a second address on the same session, and the repository's update is conditional as well, so a cap identity cannot change underneath a basket that was built with the first one. Verifying a different address means a new session.

### Nothing is deleted

`hv_app` has no `DELETE` or `TRUNCATE` on the table. Sessions end by expiring or being revoked; a deleted row would take the record of a verified address with it. Pruning lapsed sessions is an operator task, and no retention policy is set here — that belongs with the compliance values in Phase 12 (O12).

## Consequences

- P5-4 has somewhere to put a verified address, and a window to judge it by.
- Guests still cannot reserve tickets: the reservation API accepts signed-in customers only, and P5-3 does not change that.
- The cookie helpers now build two cookies from one implementation.
- The API gains `@CurrentGuest()`, which is always optional and never a substitute for `@CurrentAuth()`.
- Lapsed guest sessions accumulate until something prunes them.
