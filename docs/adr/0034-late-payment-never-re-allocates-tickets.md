# ADR-0034: A late payment is never re-allocated tickets

## Status

Accepted — 2026-09-25 (owner decision D14 = A, resolving conflict C10 in the Phase 6 scope lock). Implemented in Phase 6, task **P6-4**.

This ADR records a decision that was already made and already built. It introduces no new policy.

## Context

Revision 2 **B10**'s late-payment rule reads: "If the draw is still live and tickets are available, **re-allocate**. Otherwise the order goes to `paid_unfulfillable`…".

The Phase 6 audit found that the first branch is **structurally impossible on the Phase 5 schema**. Re-allocation would have to point the order at a different reservation, and `0016_orders.sql` forbids that three times over:

- `hv_order_items_guard` raises on **any** UPDATE of `order_items` — "an order line is fixed when the order is placed";
- `REVOKE UPDATE, DELETE, TRUNCATE ON order_items FROM hv_app`;
- `order_items_order_draw_key UNIQUE (order_id, draw_id)` forbids inserting a _second_ line for the same draw, and `order_items_reservation_key UNIQUE (reservation_id)` forbids reusing a reservation.

Implementing B10's preferred branch would therefore require a migration that **deliberately weakens order-line immutability** — a protection introduced on purpose and reviewed twice.

This is **not** a defect in the schema. **OD-3**'s instruction — "do not invent tickets… use the existing `paid_unfulfillable` state… create the required refund/recovery path" — is exactly what the schema permits, and the schema is the stronger position. The conflict is recorded as **C10** in [PHASE_6_SCOPE_LOCK.md §3a](../PHASE_6_SCOPE_LOCK.md#3a-conflicts-found-during-the-decision-audit).

## Decision

**Owner decision D14 = A, 2026-09-25:**

> **Phase 6 implements only the `paid_unfulfillable` + refund branch. Order tickets are never re-allocated.**

A confirmed payment that cannot be fulfilled moves the order to the existing **`paid_unfulfillable`** status, records the payment as succeeded, touches no ticket, and raises a refund for the full amount to the original provider payment instrument (D15a). No new order status is invented, and no order line is created, edited or repointed.

**The deviation from B10 is deliberate and is recorded here rather than resolved silently.** Order-line immutability is the stronger position, and the schema enforces it three ways.

**If re-allocation is ever wanted, it needs its own ADR and its own migration, and must not be smuggled into Phase 6.**

## Explicit invariants and constraints

| Constraint                                                                                               | Enforcement                                                                                                                                               |
| -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **No ticket is invented, allocated or re-allocated** on the late-payment path                            | procedural — the unfulfillable path contains no `INSERT` into `order_items` and no ticket sale at all                                                     |
| **An order line never changes**                                                                          | **structural** — `hv_order_items_guard` raises on any UPDATE; `hv_app` holds no `UPDATE`/`DELETE`/`TRUNCATE` on `order_items`                             |
| **A second line for the same draw cannot be added, and a reservation cannot be reused**                  | **structural** — `order_items_order_draw_key UNIQUE (order_id, draw_id)`, `order_items_reservation_key UNIQUE (reservation_id)`                           |
| **`paid_unfulfillable` is the only outcome** for a confirmed payment that cannot be fulfilled            | **structural** — `hv_orders_status_guard` permits exactly the B7 transitions (D4 = C)                                                                     |
| **The payment is still recorded as `succeeded`** — the customer really did pay                           | procedural — conditional `UPDATE`, so an attempt already terminal is left terminal (I21) while the **order** still carries the outcome                    |
| **The refund is raised in the same transaction as the state change**, and raising it twice is impossible | **structural** — `refunds.idempotency_key UNIQUE` (I16), keyed `refund:order:<orderId>:unfulfillable`                                                     |
| **`order.unfulfillable` claims only that a refund was _initiated_**                                      | procedural — D16a. The refund-completion message is P10's, and no Phase 6 code path may emit it                                                           |
| **The customer's money is never silently kept, and a ticket is never silently invented**                 | both of the above, together. Those two sentences are the whole rule ([§10](../PHASE_6_SCOPE_LOCK.md#10-late-payment-behaviour--proposed-per-locked-od-3)) |

## Consequences

- **A recorded deviation from B10's re-allocation branch.** B10's second branch is implemented exactly; its first branch is not implemented at all, and this ADR is the reason on file.
- **Late payment is not rare, and this path is load-bearing.** Under **C1**/**D1 = B** any customer who takes longer than the margin allows reaches `paid_unfulfillable` and a refund. That is a real support cost, accepted knowingly rather than discovered later.
- **The same path now carries three later owner decisions.** **D21** (attempt expired, hold still live) and **D23** (order already expired), locked 2026-09-28, both route to `paid_unfulfillable` with an automatic refund and **no re-allocation**, as does D14's original case. One path, one rule, whatever led to it.
- **D21 releases holds that were still live.** Where D14's original case finds the tickets already gone, D21 finds them present and **returns them to the pool** with `hv_end_reservation(…, 'released')`, so the tickets and the cap allowance both go back. They are still never re-allocated to this order.
- **`tickets_status_valid` has no `'void'` value, and Phase 6 never needs one**, because it only refunds orders whose tickets were never sold. **O7**'s wider answer must account for this, since the proposal on file assumes tickets can be voided.
- **Re-allocation remains available as a future decision**, at the price it always had: its own ADR, its own migration, and an explicit choice to weaken order-line immutability.

## Relationship to the Phase 6 scope lock

| Scope-lock reference                                                                                            | What it says                                                                                          |
| --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| [§3a — C10](../PHASE_6_SCOPE_LOCK.md#c10--b10s-re-allocation-path-is-structurally-impossible--blocker-for-od-3) | The conflict, the three structural reasons, and the owner's resolution                                |
| [§3b](../PHASE_6_SCOPE_LOCK.md#3b-owner-decisions-recorded)                                                     | D14 = A recorded against C10, and the ADR this document discharges                                    |
| [§4 — OD-3](../PHASE_6_SCOPE_LOCK.md#od-3--payment-success-after-reservation-loss-locked)                       | The locked instruction this implements                                                                |
| [§10](../PHASE_6_SCOPE_LOCK.md#10-late-payment-behaviour--proposed-per-locked-od-3)                             | The step-by-step late-payment behaviour, including "no ticket is invented, allocated or re-allocated" |
| [§25](../PHASE_6_SCOPE_LOCK.md#25-explicit-out-of-scope-list--locked)                                           | "Order re-allocation after late payment — **not implemented** — C10; needs its own ADR and migration" |

## Where the behaviour shipped

**Phase 6, slice P6-4 — atomic payment finalization.**

| Artefact                                                | Role                                                                                                                                                                                                                                            |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api/src/payments/payment-finalization.service.ts` | `settleUnfulfillable` — the single path into `paid_unfulfillable`. It transitions the order, conditionally succeeds the payment, releases any still-live hold, raises the refund and writes the audit and outbox rows. It creates no order line |
| `apps/api/src/payments/refunds.repository.ts`           | `raiseIfNew`, and `refundKeys.unfulfillable(orderId)`                                                                                                                                                                                           |
| `packages/db/migrations/0023_refunds.sql`               | The `refunds` table (B18, D15a, D15b)                                                                                                                                                                                                           |
| `packages/db/migrations/0016_orders.sql`                | Unchanged, and the reason this ADR exists: `hv_order_items_guard`, the `hv_app` revokes and the two unique keys                                                                                                                                 |
| `apps/api/test/payment-finalization.int.test.ts`        | Asserts the unfulfillable outcome, exactly one refund however many times the event is delivered, and that no ticket is sold                                                                                                                     |
| `apps/api/test/checkout-orders.int.test.ts`             | Proves order-line immutability in raw SQL, with the application bypassed                                                                                                                                                                        |

**D14 = A was decided before P6-4 and scheduled to be recorded with P6-6.** The path it describes shipped in P6-4 instead, because the later D21 and D23 decisions required the unfulfillable path and its refund at finalization time. This ADR was written on 2026-09-28 to close that gap; the decision itself is unchanged and dates from 2026-09-25.
