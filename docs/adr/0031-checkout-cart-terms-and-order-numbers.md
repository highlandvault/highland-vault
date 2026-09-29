# ADR-0031: Checkout — cart ownership, the terms gate, and order numbers

## Status

Accepted — 2026-09-25 (owner decisions at the Phase 5 checkout gate). Settles the three questions the Phase 5 scope lock raised as `OWNER DECISION REQUIRED`. Needed by P5-5, P5-6 and P5-7.

## Context

The Phase 5 scope lock (`PROJECT_STATUS.md`, "Phase 5 remaining scope") found three questions that the specification does not answer and that block the remaining checkout tasks. Each changes a schema, so none could be deferred into implementation.

They are recorded together because they are one architecture: a cart belongs to somebody, that somebody accepts a market's terms, and the result is an order they can quote back to support. Splitting them across three ADRs would hide how they fit.

## Decision 1 — A cart is owned by exactly one of a user or a guest session

Revision 2 B4 says the basket is server-side, one per market (ADR-0026), and that "guest and account baskets use the same mechanism". B18 gives `carts`, `cart_items` with "Cart per (session, market)". That was written before ADR-0029 split guest sessions from authenticated ones into deliberately different types, so "session" no longer names one thing.

**A cart carries both `user_id` and `guest_session_id`, and exactly one of them is set:**

```
(user_id IS NOT NULL AND guest_session_id IS NULL)
OR
(user_id IS NULL AND guest_session_id IS NOT NULL)
```

A cart also belongs to exactly one `market_id`. A cart can therefore never belong to an authenticated user and a guest session at the same time.

This keeps the two identities as far apart in the schema as ADR-0029 keeps them in the guard: different columns, different types, and a CHECK that makes "both" unrepresentable rather than merely discouraged. It is the same shape the specification already gives `orders` — `user_id` **or** `guest_email`, exactly one.

### What follows from it

- **One cart per owner per market** cannot be a single unique constraint, because the owner column varies. It is two partial unique indexes — one on `(user_id, market_id)` where `user_id IS NOT NULL`, one on `(guest_session_id, market_id)` where `guest_session_id IS NOT NULL` — following the partial-unique-index precedent already in `0008` (`skill_question_options_one_correct`).
- **Cart ownership and order identity are deliberately different.** A cart points at a `guest_session_id`; an order records a `guest_email`. That is not an inconsistency: the session is the container the basket lives in for 24 hours, while the address is the cap identity (ADR-0008) and has to outlive the session on the order. At order creation the guest's verified email must still be **fresh** (30 minutes, ADR-0020/0029, judged at the point of decision), even though their cart is not.
- **Market isolation is unchanged**: `market_id` on the cart, `MarketGuard` on the route, and a cross-market basket refused by the API (ADR-0026).
- **Authentication is unchanged.** `hvAuth` and `hvGuest` remain distinct, resolved on different branches of `AccessGuard`; a guest cart never makes `hvGuest` satisfy an authenticated authorization decision. Signed-in customers keep their existing behaviour.
- **Ticket-cap identity is unchanged** (ADR-0008: user id, or normalized verified email), and ADR-0021 bridging still applies.

### What is deliberately not decided here

**Nothing in the specification requires a guest cart to be merged into a user cart when a guest signs in or registers.** ADR-0021's merge is about _cap counters_, not baskets, and no other authoritative document mentions carts at sign-in.

So there is no approved merge algorithm, and this ADR does not invent one. **What happens to a guest's cart when they sign in is a P5-5 implementation decision**, to be taken from the ownership model above and reported at the P5-5 gate. Doing nothing — leaving the guest cart where it is and giving the signed-in user their own — is consistent with this ADR. If P5-5 concludes that a merge is needed, that is an architecture decision and needs its own ADR.

## Decision 2 — An active terms version gates checkout

B12 records market terms as `terms_versions` per market with acceptance recorded per user or order at checkout, and marks the content itself "Content: legal". B18 puts `terms_version_id` on `orders`.

**Checkout requires an active terms version for the market being bought in.**

- A market must have an active terms version before checkout can create an order.
- The customer accepts that version as part of the checkout.
- The order references the accepted `terms_version_id`.
- **Missing active terms prevent checkout and order creation** — the refusal comes from the API, not the UI.
- Acceptance is tied to the applicable market and version: a version belongs to one market, and acceptance of another market's version does not count.

### What follows from it

- **The gate is on checkout, not on market enablement.** `hv_market_missing_settings` decides whether a market may be _enabled_ and is not extended here. A market can be enabled and browsable with no terms version; what it cannot do is take an order. This keeps Phase 5 independent of the O12 compliance values, which still block enablement on their own terms.
- **No legal content is written by this project.** The mechanism is built with the content absent, exactly as `market_settings` already carries nullable compliance columns. Terms content stays Phase 12 and comes from legal. Nothing in the codebase, its fixtures or its tests may invent terms wording; test fixtures use placeholders, as they already do for compliance values.
- Because acceptance is recorded in the order-creation transaction, a checkout rejected for any reason — including a wrong skill answer (ADR-0030) — records no acceptance.

### What an acceptance is linked to, and what it is not

B18 lists `terms_acceptances` as `terms_version_id`, `user_id` **or** `order_id`. This design records `user_id` **or** `guest_session_id`, and links the order through `orders.terms_version_id`.

For a signed-in customer that is B18 exactly. For a guest it is not: a guest has no `user_id`, so B18's remaining option would be `order_id`, and this uses a third column instead — for the same reason cart ownership does, because B18 predates ADR-0029's separation of guest sessions from authenticated ones.

Reviewed again at the P5-8 gate and **kept**. The version an order was placed under is unambiguous, which is what an order needs. What is _not_ recorded is which acceptance **event** backs a given order: for a guest the join runs `orders.guest_email` → `guest_sessions.verified_email` → `terms_acceptances.guest_session_id`, and if the same address verified on two sessions there are two acceptance rows with no way to say which one the order used. Accept that, or add `order_id` — a later decision, not a Phase 5 blocker.

## Decision 3 — `order_number` is an opaque `HV-` identifier

B18 requires `order_number UNIQUE` and says nothing else. It is customer-facing: it appears in emails, and people read it aloud to support.

**`orders.order_number` is a unique, customer-facing, opaque identifier of the form `HV-` followed by an uppercase alphanumeric suffix.** For example, `HV-7F4K92M8`.

The contract:

- begins with the literal prefix `HV-`;
- the suffix is uppercase alphanumeric;
- generated randomly and collision-resistantly, using the project's existing random-identifier conventions (`node:crypto`, as `generateSessionToken` and `generateRecoveryCode` already do) — never a counter, never derived from a timestamp, never guessable from another order's number;
- `UNIQUE` in PostgreSQL, enforced by the database rather than by the application;
- **never the primary key.** Primary keys stay `uuid` from `uuidv7()`, as everywhere else in this schema.

**Order numbers are not sequential.** A sequential number leaks how many orders exist and how fast they arrive, and lets anyone holding one guess its neighbours.

### Length, and a note for the implementer

**No length is fixed here**, because nothing in the specification, the schema or the tests constrains one. P5-7 chooses it and records the choice with its reasoning; it should be long enough that collisions are not something the retry path exercises in normal operation.

One piece of existing convention is worth weighing at that point, as guidance rather than a constraint: `generateRecoveryCode` produces the project's other customer-facing typed-back identifier, and it uses base32, whose alphabet has no `0`/`O` or `1`/`I` to confuse when a number is read down a phone line. The approved format is "uppercase alphanumeric", which is wider than that. P5-7 may use the full alphanumeric range or narrow it; either satisfies this ADR.

## Consequences

- **P5-5 is unblocked.** Migration `0014` designs `carts` and `cart_items` from Decision 1. Cart-merge-on-sign-in remains an implementation decision to be reported at the P5-5 gate.
- **P5-6 is unblocked.** Migration `0015` adds `terms_versions`, `terms_acceptances` and the market's active version; the enablement gate is not touched.
- **P5-7 is unblocked.** Migration `0016` adds `orders` and `order_items`, with `order_number` per Decision 3 and `terms_version_id` per Decision 2.
- No decision here moves anything out of Phase 6: no payment, no webhooks, no `reserved → sold`, no Gate 4 (ADR-0006, Option A).
- ADR-0026 (one basket and order per market), ADR-0029 (guest sessions), ADR-0008 (cap identity) and ADR-0021 (bridging) are all unchanged. This ADR builds on them and supersedes none of them.
