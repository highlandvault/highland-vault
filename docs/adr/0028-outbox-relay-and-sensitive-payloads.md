# ADR-0028: Outbox relay to target queues, and encrypted sensitive payloads

## Status

Accepted — 2026-09-24 (owner approval during Phase 5, task P5-2). Implements the `outbox` and `notifications` queues described in the Platform Specification, Part B17.

## Context

Phase 5 task P5-1 built the transactional outbox (migration `0011`): producers write an event in the same transaction as their business change, and a worker claims due events with `FOR UPDATE SKIP LOCKED` and delivers them at least once.

P5-1 delivered events **in process**, through a handler registered on a topic dispatcher. Part B17 of the specification describes something different:

| Queue           | Jobs                                             | Safety                                |
| --------------- | ------------------------------------------------ | ------------------------------------- |
| `outbox`        | Relay committed outbox rows to **target queues** | Row status + `FOR UPDATE SKIP LOCKED` |
| `notifications` | Transactional email per market/locale            | **Outbox id as job id**               |

The locking half already matched; the relay half did not. P5-2 adds the first side effect that needs a target queue (email), so the difference had to be resolved rather than deferred.

The relay is also better on its own merits, independently of the specification: under in-process delivery an outbox run holds a claim of up to 100 events and performs SMTP serially inside the lease, so slow mail stalls the whole drain. A separate queue lets delivery have its own concurrency and rate limiting.

## Decision

### Relay

- The **`outbox` queue relays**: it claims due rows and enqueues a job on the target queue. It never performs the side effect and never marks a row published.
- The **`notifications` queue delivers**: it decrypts the payload, sends the email, and only then marks the outbox row published.
- The BullMQ job id is the **outbox row id**, so a relay that runs again while a job is still waiting or active does not create a second job.

### `published_at`

`published_at` means **the side effect actually happened** — for email, that the SMTP server accepted the message. It does **not** mean "queued in Redis". PostgreSQL stays the source of truth: nothing is inferred from Redis, and if Redis is emptied, every unpublished row is relayed again once its lease lapses.

### Retry ownership

**PostgreSQL owns retry, exclusively.** Notification jobs are created with `attempts: 1` and no BullMQ backoff. The outbox lease, `attempts` column and `retryDelaySeconds` backoff from P5-1 remain the only retry mechanism. Two retry systems would multiply attempts and make `attempts` and `last_error` meaningless.

### BullMQ job options

Notification jobs use `attempts: 1`, `removeOnComplete: true` and `removeOnFail: true`.

This is not a tidiness preference. It was established by direct experiment against BullMQ:

| Situation                                                                 | Result                                            |
| ------------------------------------------------------------------------- | ------------------------------------------------- |
| Same job id added twice while the job is **waiting**                      | One job; the first add's data wins (dedupe works) |
| Job **completed** and retained (`removeOnComplete: 100`), then re-added   | **Re-add silently ignored**                       |
| Job **failed** and retained (`removeOnFail: 1000`), then re-added         | **Re-add silently ignored**                       |
| `removeOnComplete: true` / `removeOnFail: true`, re-added after a failure | Re-add accepted; the retry reaches the worker     |

With retained jobs, a failed email would leave a retained failed job under the row's id. The lease would lapse, the relay would enqueue again, BullMQ would **silently drop the enqueue**, and the row would spin forever: attempts climbing, `last_error` unset, the email never sent. Retention here would quietly destroy the retry guarantee, so job ids must be free to be reused.

The cost is that completed and failed notification jobs are not retained for inspection. That is acceptable because the outbox row — its `attempts`, `last_error`, `published_at` and timestamps — is the delivery record (see also: no audit-log entry is written for email delivery).

### Delivery guarantee and its consequence

Delivery remains **at least once**. A worker can send an email and then die before recording success; once the lease lapses the event is relayed again and **the customer receives the verification email twice**. This is accepted. The alternative — marking a row published before delivering — would lose emails instead of repeating them, which is worse for a one-time code.

Handlers must therefore be safe to run twice.

### Failure windows

- **Crash between the enqueue and a database write.** There is none to lose: the relay performs no database write after enqueuing. Its only write is the claim, which happens first.
- **Crash between the claim and the enqueue.** The row stays leased, then becomes claimable again and is relayed. One extra counted attempt, no loss.
- **Crash after sending, before marking published.** The row is relayed again and the email is sent twice (above).
- **Redis lost entirely.** Every unpublished row is relayed again after its lease. No loss.
- **Delivery outliving the lease.** A second job can be created for a send still in flight, so the SMTP timeout is kept well below the lease.

### Sensitive payloads

Guest verification codes are stored **hashed** (ADR-0020), so a hash cannot be emailed: the plaintext code has to reach the mail handler through the event. But an outbox payload is immutable by trigger and `hv_app` cannot delete outbox rows, so anything written there cannot later be redacted.

Therefore **payloads carrying a one-time code or recipient address are encrypted**, with the same AES-256-GCM construction already used for TOTP secrets (`SecretBox`, moved to `@hv/domain` so the API and the worker share one implementation and one key-management model). The envelope is a JSON object, so `outbox.payload` needs no schema change:

```json
{ "v": 1, "kid": "k1", "sealed": "<base64 nonce || tag || ciphertext>" }
```

The topic is the associated data, so a sealed payload cannot be moved to another topic and still open. The key comes from configuration (`OUTBOX_ENCRYPTION_KEY`), never from the database and never committed. Because the job carries the sealed payload unchanged, the plaintext code is absent from Redis as well; it exists only in memory, inside the handler, for as long as it takes to send the message.

Plaintext codes and decrypted payloads are never logged.

### Provider independence

`MailPort` has one operation, `send`. The only implementation in Phase 5 is an SMTP adapter aimed at Mailpit for development and tests; `nodemailer` exists behind that adapter and nowhere else. No production provider is chosen — that is **O14**, still open — and a production configuration without explicit mail settings fails closed at startup rather than silently dropping mail.

## Consequences

- P5-1's `OutboxHandler` gains an outcome: a handler may return `'deferred'` to say "accepted, not yet delivered", which is what the relay returns. Returning nothing still means published, so **no P5-1 behaviour changes**. `PublishResult` does gain a `deferred` count, so P5-1 tests that asserted its exact shape were updated to assert the new one; none of them was weakened.
- `markOutboxPublished` and `markOutboxFailed` become part of the module's surface, because completion now happens in a different worker from the claim.
- Duplicate verification emails are possible and accepted.
- Mailpit becomes part of the CI infrastructure.
- Retention of notification job history is given up in exchange for a working retry path.
- A production mail provider, and any per-market or per-locale templates, remain out of scope (O14; templates are Phase 12).
