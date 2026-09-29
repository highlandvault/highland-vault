# ADR-0032: Checkout request identity — self-describing purchase intent

## Status

Accepted — 2026-09-25 (owner decision during Phase 5, task P5-7). Fills a gap the specification leaves open. Needed by P5-7 and by Phase 6.

## Context

**The specification does not define this.** A read-only review of Revision 2 found everything it says about checkout idempotency, and it is only this:

| Where         | What it says                                                      | Label          |
| ------------- | ----------------------------------------------------------------- | -------------- |
| B5 (line 159) | "Every mutating endpoint **accepts** an `Idempotency-Key` header" | PROPOSED       |
| B6 (line 302) | "unique order idempotency key"                                    | **REQ**        |
| B18           | `orders.idempotency_key UNIQUE`                                   | schema         |
| Part F        | Phase 5 exit criterion: "Idempotency-key replay test"             | exit criterion |

The word "replay" is never defined, no checkout request shape is given anywhere, and nothing states whether a checkout request describes the purchase or simply says "convert my basket". B4's "the basket is server-side" leans towards the latter, but leaning is not defining.

P5-7 was built on the unstated assumption that a checkout is **basket-defined** for its contents — quantity, reservations and price all read from the locked cart — while its idempotency digest was **request-defined**, hashing only the market, buyer, terms label and skill answers. Those two halves do not agree, and the disagreement is visible:

- reusing a key with different **answers** was rejected;
- reusing a key with a different **basket** was accepted, and silently returned the earlier order.

There is no coherent rule under which both of those are correct. The gap had to be closed by a decision rather than by more reading.

## Decision

**A Highland Vault checkout request is self-describing.** It states the purchase the customer intends to make, and the server checks that intent against what it is actually holding for them.

1. **This is an owner architectural decision filling a specification gap**, not an interpretation of Revision 2. The specification is silent, and this ADR is the authority for checkout request identity from here on.
2. **Checkout requests are self-describing.** The request says what is being bought, rather than pointing at server state and trusting it to still mean the same thing.
3. **The request identifies the intended draw and quantity, and the skill-answer option where the draw asks a question.** A draw with no question carries no option.
4. **The server validates that intent against the locked server-side basket and its reservations**, inside the order transaction. A material difference is refused.
5. **Server-side reservation and cart state remain authoritative.** The request is intent; it is never evidence.
6. **Price and currency always come from the reservation**, never from the request. The same is true of the market, availability, reservation ownership, ticket eligibility and whether an answer is correct.
7. **The idempotency identity is the semantic checkout request** — what the customer asked to buy, canonically serialised.
8. **Same key, same semantic request → the original order is returned.**
9. **Same key, materially different semantic request → refused**, with the existing generic idempotency-conflict error.
10. **Cross-customer key reuse is refused without disclosing the existing order.** The buyer is part of the identity and is also checked separately; the refusal carries no detail about what the key already bought.
11. **A genuinely new checkout attempt is expected to use a fresh `Idempotency-Key`.** Reusing one is how a client says "this is the same purchase as before".
12. **Nothing here changes payment behaviour or Phase 6 scope.** An order still stops at `awaiting_payment`, its reservation stays active and its tickets stay `reserved`.

## Consequences

- **The client has to know what it is buying**, which it does: the basket response already reports each line's draw and quantity. The checkout page sends back what it displayed.
- **A confirmation page now means something.** Under the previous behaviour the server could not tell whether the order it was about to create matched what the customer had been shown — a second tab, or a hold that lapsed and was re-added at a different quantity, would change the purchase silently. That mismatch is now refused. This is the main reason the decision went this way, and it is about integrity at the point of taking money rather than about idempotency.
- **A new failure mode exists**, where the request and the basket disagree. It is a generic conflict: the customer is told their basket has changed and to review it, without being told which line or in which direction.
- **The digest becomes principled.** Every input that can change the resulting order is in it, so "same key, different request" is decidable rather than partially decidable.
- **No schema change.** `orders.idempotency_key` and `orders.idempotency_digest` from migration `0016` already carry this; only what goes into the digest changes.
- **PostgreSQL remains the idempotency authority.** The key is claimed by the `INSERT … ON CONFLICT` on its UNIQUE constraint. No cache is involved, and Redis is not consulted.
- The alternative — defining the key as identifying the _operation_ of converting a basket, and dropping the content check entirely — was considered and rejected. It is closer to what the specification describes, and it is a legitimate reading of idempotency, but it cannot tell a customer that their basket changed underneath them.
