# ADR-0035: The customer payment-status GET is read-only

## Status

Accepted — 2026-09-29 (owner decision, P6-9 WP-3). Implemented in Phase 6, task **P6-9**.

## Context

`GET /markets/:market/checkout/orders/:order/payments/:payment` tells a customer where their payment attempt stands. Until this decision it did something else as well:

```ts
if (attempt.status === 'pending' || attempt.status === 'processing') {
  await this.reconcile.reconcile(attempt.id);
}
```

`PaymentsReconcileService.reconcile` calls `provider.getPaymentStatus` — an outbound request on our merchant account — and hands the answer to `PaymentFinalizationService.confirm`, which is the same code a verified webhook reaches. So the route could, in one GET:

- move an order to `paid` or `paid_unfulfillable`, and a payment to `succeeded`;
- sell reserved tickets, or release the holds;
- raise a refund, and then call the provider to execute it;
- write `order.paid` or `order.unfulfillable` outbox rows, which P12's relay turns into customer email;
- write `payment.anomaly_detected` audit rows for a second capture or a capture without settlement.

This was deliberate, not accidental. Revision 2 **B10** names the "trusted server-side status check" as a legitimate confirmation path beside the webhook, and the route's own docstring said plainly that it might finalise. The re-read afterwards meant it never reported an outcome the database had not committed, so it was honest about its answer.

What it was not was a read.

Three things brought it to a decision:

1. **P6-8 faced the same question and answered it.** The order-access return link ran the same check. In the P6-8 corrective pass the owner decided (S2) that opening a link must not be able to capture money, and `statusByAccess` became a read. Leaving the neighbouring route as it was would have meant two answers to one question.
2. **The route has no caller.** `fetchPaymentStatus` in `apps/web/src/lib/checkout.ts` was the only web-side wrapper, and nothing called it — the basket-first rework left it behind. There is no polling anywhere in the web app.
3. **The advancement it provided is already provided twice over.** P6-5 built the scheduled reconciler (every 60 seconds, five-minute lookback) precisely so that a lost webhook is recovered without anybody looking at a page.

## Decision

**The customer payment-status GET reads the database and does nothing else.**

It must never call `PaymentsReconcileService.reconcile`, `provider.getPaymentStatus` or `PaymentFinalizationService.confirm`, and must not mutate payment, order, ticket, refund, audit or outbox state.

Everything else about the route is unchanged and remains required:

| Control                                                         | State     |
| --------------------------------------------------------------- | --------- |
| `@Public({ identify: true })`, `MarketGuard`                    | unchanged |
| Ownership — someone else's order is a **404**, never a 403      | unchanged |
| Guest callers must hold a fresh verified email                  | unchanged |
| `attempt.orderId !== orderId` → 404                             | unchanged |
| `paymentStatusPerOwner` rate limit, consumed first, fail-closed | unchanged |
| The provider reference is never returned                        | unchanged |

**Authority for advancing a payment is unchanged**, and lives where it already lived:

- the **verified provider webhook**, which remains authoritative;
- the **P6-5 scheduled reconciliation** through the internal listener, which remains the recovery path for a webhook that never arrived.

Neither is modified by this decision.

**No `POST …/check` replacement is introduced.** There is no caller that needs one, and adding a route nobody calls would expand the API surface to preserve a capability nothing is asking for. If a caller appears, that is the moment to design it.

**Staff keep the other half, and it is a POST.** `POST admin/markets/:market/orders/:order/payments/:payment/reconcile` still asks the provider directly, behind the `payments.reconcile` permission, step-up MFA and a required reason, and it audits who asked. That is the distinction this ADR draws: asking a third party about somebody's money is an **action**, and it is spelled as one. A customer looking at their own order is not.

## Consequences

**A customer who returns before the webhook lands sees the attempt as still live.** That is true, and the page says so. In the worst case the wait is one reconciler cycle — about 60 seconds — and in the ordinary case the webhook has already arrived.

**An anomaly is found a little later.** A second capture or a capture without settlement used to be discovered by whichever customer happened to refresh; it is now discovered by the scheduled check. The audit row is identical and the worklist keeps a stuck attempt in scope for five minutes, so nothing is lost but the coincidence.

**The provider is asked less often**, and never on a schedule a stranger controls. The rate limit is kept anyway: B19's "endpoint abuse" concern is about how fast a route can be asked, not only about what an ask costs us.

**Dead code removed.** `fetchPaymentStatus` is gone. The API route stays.

**Alignment.** Both customer-facing status reads — this route and `GET /checkout/order-access` — now have the same shape, the same guarantee and the same reason for it.

## Alternatives considered

**Leave it as it was, and record the reasoning.** Defensible: the route is ownership-checked, rate limited and fail-closed, and B10 sanctions the check. Rejected because the semantics would still differ from the order-access route decided six hours earlier, and because a safe method that can take money is a thing reviewers have to keep rediscovering.

**Split it: `GET` reads, `POST …/check` reconciles.** Honest about both operations. Rejected for this slice: it adds surface for a capability with no caller, and the staff route already provides a deliberate, audited way to ask the provider.

## What this does not decide

**K-3** (a capture against a `cancelled` order), **K-c** (what makes an order failed), **O7**, **O9**, **O12** and **O13** are untouched and remain open owner decisions.

## References

- [PHASE_6_SCOPE_LOCK.md](../PHASE_6_SCOPE_LOCK.md) — B10, OD-5, D12 = A, D12a, B19
- [ADR-0033](0033-sealed-provider-payloads.md) — the webhook path this decision leaves authoritative
- `apps/api/src/payments/payments.service.ts` — `status`
- `apps/api/src/payments/payments-reconcile.service.ts` — the check this route no longer makes
- `apps/api/test/payment-reconciliation.int.test.ts` — `the customer status route performs no provider work`
