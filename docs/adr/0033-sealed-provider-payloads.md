# ADR-0033: Provider webhook payloads are normalised, and the original is sealed

## Status

Accepted — 2026-09-25 (owner decisions D7 = B and OD-7a, Phase 6 scope lock). Implemented in Phase 6, task P6-3.

## Context

Revision 2 B18 specifies `payment_events` as carrying the **raw payload**. B19 lists the same table among those where `hv_app` has `UPDATE` and `DELETE` revoked, because the row is the replay-protection record: `UNIQUE (provider, provider_event_id)` is what makes a duplicated webhook a no-op.

Those two requirements pull against each other. Anything stored in a row the application cannot delete is stored for as long as the database exists, and a provider's webhook payload is not a neutral document — it typically carries a billing name, an email address, a postal address and card metadata such as brand, last four digits and issuing country. Under the SAQ-A model a card number never reaches our servers at all, so that is not at risk here; the personal data is.

Phase 5 met exactly this problem with the outbox and answered it in ADR-0028: a payload that cannot later be redacted is sealed with AES-256-GCM, so it exists but is not readable at rest.

## Decision

`payment_events` stores **two representations of every delivery**.

1. **Normalised facts, in columns** — provider, event id, event type, provider reference, amount, currency and a status normalised to Highland Vault's own vocabulary. This is the working record. Every decision the application takes, it takes from these.

2. **The original bytes, sealed** — AES-256-GCM, the same construction and the same key as outbox payloads (`OUTBOX_ENCRYPTION_KEY`), base64 inside the sealed envelope so that what is kept is exactly what arrived rather than a re-serialisation of what we understood. The associated data binds the ciphertext to `provider` and `provider_event_id`, so a sealed payload copied onto another row will not open.

**Access** is the `payments.reconcile` authority — sensitive, so step-up MFA — and every opening is audited. There is deliberately no separate payload-access permission (D13a). A sealed payload is never opened in a request handler, never returned by any API, and never logged.

**Retention** is 90 days (OD-7a). After that the **sealed payload is cleared and the row is kept**. `hv_payment_events_guard` permits `payload_sealed` to move from a value to NULL and in no other direction: it cannot be set, swapped for another value, or put back.

## Consequences

- **A deviation from B18's literal wording**, recorded as such. B18's intent is met — the raw bytes are retained and a dispute can be settled byte for byte — while OD-7's constraint is also met, because nothing sensitive sits in plaintext in a row nobody can delete.
- **Rows are never deleted.** Deleting them after 90 days would reopen replay protection for any event a provider re-sends afterwards, which is precisely the case `UNIQUE (provider, provider_event_id)` exists to defend against. Retention clears the payload, not the record.
- **Reconciliation and disputes beyond 90 days rely on the normalised record** and on the provider's own systems. That is the price of the retention limit and is accepted.
- **Key rotation now affects two subsystems**, the outbox and provider events. They share `OUTBOX_ENCRYPTION_KEY` deliberately: one key with one rotation procedure is easier to operate correctly than two.
- **The exact list of sensitive fields is not yet knowable.** It depends on which provider is chosen, which is OPEN O13. Sealing does not require the list, which is part of why it was chosen over redacting named fields — a redaction list that is missing a field fails silently, and a new field a provider adds later would be retained in the clear by default.
- **Building the retention process is not Phase 6 work.** Phase 6 ensures the schema permits it and that nothing depends on a payload older than 90 days. The process itself runs with elevated privilege, because `hv_app` has no `DELETE` and, by design, cannot do this on its own.
