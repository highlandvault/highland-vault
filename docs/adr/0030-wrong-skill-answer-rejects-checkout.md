# ADR-0030: An incorrect skill answer rejects the checkout

## Status

Accepted — 2026-09-24 (owner decision at the Phase 5 planning gate, confirmed 2026-09-25 at the Phase 5 scope lock). Settles the part of **O12** that Phase 5 needs. Needed by the order-creation task (P5-7).

## Context

A skill question is what makes this a competition of skill rather than a lottery, so the answer has to be checked where it cannot be tampered with. Revision 2 B20 fixes the mechanism — a per-draw question, the answer **validated server-side before order creation**, and the chosen option stored on `order_items.skill_answer_option_id` — but left the behaviour on a wrong answer open as part of O12, along with whether retries are allowed.

Until now that decision was recorded only as prose in `PROJECT_STATUS.md`, while two other tables in the same file still listed it as unresolved and blocking checkout. A decision of this kind needs an ADR (DEVELOPMENT_RULES §3), which is what this is.

Phase 3 already established the half that never changes: correct options never leave the admin API.

## Decision

An incorrect answer **rejects the whole checkout**.

- **No order is created.** Not a draft, not a rejected one — the order-creation transaction rolls back in full, so there is no partial record of the attempt in `orders` or `order_items`.
- **No payment is taken or initiated.** Phase 5 does not reach payment at all (Option A), and Phase 6 must not treat a rejected checkout as payable.
- **The reservation is left alone.** It stays active and expires on its own schedule. The customer keeps the tickets they were holding for the rest of the reservation window and may try the checkout again within it; nothing about a wrong answer shortens or cancels the hold.
- **Retries are therefore bounded by the reservation, not by an attempt counter.** No separate retry limit is introduced.
- **The error is generic.** It does not say which line was wrong, does not name the correct option, and does not distinguish "wrong option" from "option belonging to another draw's question" or "option that does not exist". The whole point of the question is defeated by an API that narrows it down.
- **The answer is validated server-side, always.** The client is never trusted, and a submitted option is checked to belong to the question of the draw being bought.
- **Correct options never leave the admin API** (unchanged from Phase 3).

## Consequences

- Checkout is all-or-nothing on the skill answer. A basket spanning several draws is rejected as a whole, because one order covers one market's basket (ADR-0026) and there is no partial order to fall back on.
- Guessing is limited by the reservation window and by the existing checkout rate limits (B19), not by a counter on the question. If that proves insufficient in practice it needs its own decision, not a quiet change here.
- The generic error is a deliberate usability cost: a customer who mistypes learns only that the answer was wrong. That is the same trade already accepted for verification codes (ADR-0020).
- **The remainder of O12 is untouched.** Minimum age, self-exclusion scope, consent channels and wording, retention and the masked-name format stay open and still block market enablement (Phase 12). This ADR settles the skill-answer question only.
- Terms acceptance is recorded in the same transaction as the order (`orders.terms_version_id`), so a rejected checkout records no acceptance either.
