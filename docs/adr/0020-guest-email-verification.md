# ADR-0020: Guest email verification

## Status

Accepted — 2026-09-21 (owner approval of O1, Revision 2 Part G). Needed by Phase 5.

> The owner approved this item on 2026-09-21 without restating it, so it is recorded exactly as proposed in Revision 2 Part G. If the approved decision differs, amend this ADR.

## Context

ADR-0008 requires a **verified** email as the cap identity for guests.

## Decision

- Guest email is verified by a **6-digit one-time code emailed during checkout, before the order is created**.
- The verified email is bound to the session for a short time.

## Consequences

- Codes are stored hashed, with limited attempts and a short expiry. The exact values are implementation choices, documented in Phase 5.

## Implementation (Phase 5, task P5-4)

The values the owner approved at the Phase 5 planning gate, recorded here as this ADR asked:

| Parameter                   | Value      | Why                                                                                                  |
| --------------------------- | ---------- | ---------------------------------------------------------------------------------------------------- |
| Code length                 | 6 digits   | ADR-0020. One in a million, which is only safe because guessing is bounded by the three limits below |
| Expiry                      | 10 minutes | Long enough to fetch an email, short enough that an abandoned code is not a standing target          |
| Attempts per code           | 5          | Counted under a row lock, before the comparison, and committed whatever the verdict                  |
| Sends per address, per hour | 3          | Limits flooding an inbox someone else owns                                                           |
| Sends per IP, per hour      | 20         | Bounds a caller who rotates addresses; the same value as `registerPerIp` (B19)                       |
| Verified email lifetime     | 30 minutes | `GUEST_VERIFIED_EMAIL_TTL_MINUTES` (ADR-0029); proving you can read an inbox is not a day pass       |

How the properties above are actually enforced:

- **Hashed, never stored in clear.** `guest_email_verifications.code_hash` is the SHA-256 of the code, with a `CHECK` on its length. The plaintext exists in the API for the length of one request and in the worker while the message is built.
- **The plaintext still has to travel**, because the stored form is a hash — so the outbox payload is **sealed** (ADR-0028). An outbox row can never be updated or deleted, so a plaintext code written there could never be redacted.
- **Single use**, enforced conditionally (`consumed_at IS NULL`) and again by the guard trigger, so two correct guesses racing consume the code once.
- **One transaction** issues the code, stores the hash and writes the outbox event: no email for a code that was not stored, no stored code that goes unsent.
- **Every failure returns the same error.** A wrong code, an expired one, a used one, one belonging to another session and one that never existed are indistinguishable to the caller — the difference is exactly what a guesser wants.
- **Attempts are committed even when the code is wrong.** The verifying transaction returns a verdict and the error is thrown outside it; throwing inside would roll back the counter and a guess that costs nothing is not a limit.
- **The binding is to the guest session**, not to the browser or the address alone, and `guest_sessions.verified_email` cannot be replaced once set (ADR-0029).
