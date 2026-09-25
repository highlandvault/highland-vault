import { money } from '@hv/domain';
import { beforeEach, describe, expect, it } from 'vitest';
import { FAKE_PROVIDER_CODE, FakePaymentProvider, type SignedWebhook } from './fake-provider';
import { PaymentProviderConfigError, PaymentProviderError } from './payment-provider.port';
import { FAKE_SIGNATURE_HEADER, signWebhook } from './webhook-signature';

const SECRET = 'test-webhook-secret';
const NOW = new Date('2026-09-25T12:00:00.000Z');

/** A provider with a pinned clock and pinned identifiers: nothing here is random. */
function deterministicProvider(): FakePaymentProvider {
  const counters = { payment: 0, event: 0, refund: 0 };
  return new FakePaymentProvider({
    webhookSecret: SECRET,
    environment: 'test',
    now: () => NOW,
    newId: (kind) => `${kind}_${++counters[kind]}`,
  });
}

const GBP_10 = money(1000, 'GBP');

function createInput(overrides: Partial<Parameters<FakePaymentProvider['createPayment']>[0]> = {}) {
  return {
    amount: GBP_10,
    orderReference: 'HV-ABCDEFGHIJ',
    idempotencyKey: 'key-1',
    returnUrl: 'https://highlandvault.test/return',
    cancelUrl: 'https://highlandvault.test/cancel',
    ...overrides,
  };
}

/** Rejects with a PaymentProviderError of the given kind, and nothing else. */
async function expectProviderError(
  operation: Promise<unknown>,
  kind: PaymentProviderError['kind'],
): Promise<void> {
  await expect(operation).rejects.toBeInstanceOf(PaymentProviderError);
  await expect(operation).rejects.toMatchObject({ kind });
}

describe('the fake provider config guard', () => {
  it('refuses to exist in production', () => {
    expect(
      () => new FakePaymentProvider({ webhookSecret: SECRET, environment: 'production' }),
    ).toThrow(PaymentProviderConfigError);
  });

  it('refuses an unknown environment rather than assuming it is safe', () => {
    expect(
      () => new FakePaymentProvider({ webhookSecret: SECRET, environment: 'staging' }),
    ).toThrow(PaymentProviderConfigError);
  });

  it('refuses an empty webhook secret', () => {
    expect(() => new FakePaymentProvider({ webhookSecret: '', environment: 'test' })).toThrow(
      PaymentProviderConfigError,
    );
  });

  it('is available in development and test', () => {
    for (const environment of ['development', 'test']) {
      expect(new FakePaymentProvider({ webhookSecret: SECRET, environment }).code).toBe(
        FAKE_PROVIDER_CODE,
      );
    }
  });
});

describe('creating a payment', () => {
  let provider: FakePaymentProvider;
  beforeEach(() => {
    provider = deterministicProvider();
  });

  it('returns a reference, a redirect and a pending state', async () => {
    const created = await provider.createPayment(createInput());
    expect(created).toEqual({
      providerReference: 'payment_1',
      redirectUrl: expect.stringContaining('reference=payment_1') as string,
      state: 'pending',
    });
  });

  it('carries the return URL into the redirect', async () => {
    const created = await provider.createPayment(createInput());
    expect(new URL(created.redirectUrl).searchParams.get('return_to')).toBe(
      'https://highlandvault.test/return',
    );
  });

  it('returns the first payment when the idempotency key is reused', async () => {
    const first = await provider.createPayment(createInput());
    const second = await provider.createPayment(createInput({ orderReference: 'HV-ZZZZZZZZZZ' }));
    expect(second.providerReference).toBe(first.providerReference);
  });

  it('mints a distinct reference for a distinct key', async () => {
    const first = await provider.createPayment(createInput());
    const second = await provider.createPayment(createInput({ idempotencyKey: 'key-2' }));
    expect(second.providerReference).not.toBe(first.providerReference);
  });

  it('does not mark anything paid on its own', async () => {
    const created = await provider.createPayment(createInput());
    const status = await provider.getPaymentStatus(created.providerReference);
    expect(status.state).toBe('pending');
    expect(provider.pendingWebhooks).toBe(0);
  });
});

describe('the trusted status check', () => {
  it('reports the amount as well as the state, so the caller can re-check it', async () => {
    const provider = deterministicProvider();
    const created = await provider.createPayment(createInput());
    provider.complete(created.providerReference);

    await expect(provider.getPaymentStatus(created.providerReference)).resolves.toEqual({
      providerReference: 'payment_1',
      state: 'succeeded',
      amount: GBP_10,
    });
  });

  it('refuses an unknown reference', async () => {
    const provider = deterministicProvider();
    await expectProviderError(provider.getPaymentStatus('payment_missing'), 'unknown_reference');
  });
});

describe('verifying a webhook', () => {
  let provider: FakePaymentProvider;
  let webhook: SignedWebhook;

  beforeEach(async () => {
    provider = deterministicProvider();
    const created = await provider.createPayment(createInput());
    provider.complete(created.providerReference);
    [webhook] = provider.takeWebhooks() as [SignedWebhook];
  });

  it('accepts a webhook the provider signed', async () => {
    await expect(provider.verifyWebhook(webhook.rawBody, webhook.headers)).resolves.toEqual({
      providerEventId: 'event_1',
      eventType: 'payment.succeeded',
      providerReference: 'payment_1',
      state: 'succeeded',
      amount: GBP_10,
      occurredAt: NOW,
    });
  });

  it('refuses a body altered after signing', async () => {
    const tampered = Buffer.from(webhook.rawBody.toString('utf8').replace('1000', '100'), 'utf8');
    await expectProviderError(
      provider.verifyWebhook(tampered, webhook.headers),
      'signature_invalid',
    );
  });

  it('refuses a missing signature header', async () => {
    await expectProviderError(
      provider.verifyWebhook(webhook.rawBody, { 'content-type': 'application/json' }),
      'signature_invalid',
    );
  });

  it('refuses a repeated signature header rather than picking one', async () => {
    await expectProviderError(
      provider.verifyWebhook(webhook.rawBody, {
        [FAKE_SIGNATURE_HEADER]: ['a', 'b'],
      }),
      'signature_invalid',
    );
  });

  it('refuses a signature made with another key', async () => {
    const other = new FakePaymentProvider({ webhookSecret: 'other', environment: 'test' });
    await expectProviderError(
      other.verifyWebhook(webhook.rawBody, webhook.headers),
      'signature_invalid',
    );
  });

  it('refuses a body that is not JSON', async () => {
    const body = Buffer.from('not json', 'utf8');
    await expectProviderError(
      provider.verifyWebhook(body, {
        [FAKE_SIGNATURE_HEADER]: signWebhook(SECRET, body),
      }),
      'malformed_payload',
    );
  });

  it.each([
    ['a missing field', { id: 'evt', type: 't', reference: 'r', state: 'succeeded' }],
    [
      'an unknown state',
      {
        id: 'evt',
        type: 't',
        reference: 'r',
        state: 'refunded',
        amountMinor: 1000,
        currency: 'GBP',
        occurredAt: NOW.toISOString(),
      },
    ],
    [
      'an unsupported currency',
      {
        id: 'evt',
        type: 't',
        reference: 'r',
        state: 'succeeded',
        amountMinor: 1000,
        currency: 'USD',
        occurredAt: NOW.toISOString(),
      },
    ],
    [
      'a fractional amount',
      {
        id: 'evt',
        type: 't',
        reference: 'r',
        state: 'succeeded',
        amountMinor: 10.5,
        currency: 'GBP',
        occurredAt: NOW.toISOString(),
      },
    ],
    [
      'an unreadable timestamp',
      {
        id: 'evt',
        type: 't',
        reference: 'r',
        state: 'succeeded',
        amountMinor: 1000,
        currency: 'GBP',
        occurredAt: 'yesterday',
      },
    ],
    ['a JSON value that is not an object', 42],
  ])('refuses %s even when correctly signed', async (_name, payload) => {
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    await expectProviderError(
      provider.verifyWebhook(body, { [FAKE_SIGNATURE_HEADER]: signWebhook(SECRET, body) }),
      'malformed_payload',
    );
  });

  it('verifies an event for a reference it has never seen', async () => {
    // An event can arrive for a payment this instance did not create. The port
    // reports what the event says; deciding what to do with it is the caller's.
    const body = Buffer.from(
      JSON.stringify({
        id: 'evt_unknown',
        type: 'payment.succeeded',
        reference: 'payment_elsewhere',
        state: 'succeeded',
        amountMinor: 1000,
        currency: 'GBP',
        occurredAt: NOW.toISOString(),
      }),
      'utf8',
    );
    await expect(
      provider.verifyWebhook(body, { [FAKE_SIGNATURE_HEADER]: signWebhook(SECRET, body) }),
    ).resolves.toMatchObject({ providerReference: 'payment_elsewhere' });
  });
});

describe('misbehaving on demand', () => {
  /** Two completed payments, so ordering and duplication are observable. */
  async function twoEvents(): Promise<FakePaymentProvider> {
    const provider = deterministicProvider();
    const first = await provider.createPayment(createInput());
    const second = await provider.createPayment(createInput({ idempotencyKey: 'key-2' }));
    provider.complete(first.providerReference);
    provider.fail(second.providerReference);
    return provider;
  }

  async function eventIds(webhooks: SignedWebhook[], provider: FakePaymentProvider) {
    const verified = await Promise.all(
      webhooks.map((webhook) => provider.verifyWebhook(webhook.rawBody, webhook.headers)),
    );
    return verified.map((event) => event.providerEventId);
  }

  it('delivers in order by default', async () => {
    const provider = await twoEvents();
    expect(await eventIds(provider.takeWebhooks(), provider)).toEqual(['event_1', 'event_2']);
  });

  it('delivers duplicates', async () => {
    const provider = await twoEvents();
    expect(await eventIds(provider.takeWebhooks('duplicated'), provider)).toEqual([
      'event_1',
      'event_1',
      'event_2',
      'event_2',
    ]);
  });

  it('delivers out of order', async () => {
    const provider = await twoEvents();
    expect(await eventIds(provider.takeWebhooks('out_of_order'), provider)).toEqual([
      'event_2',
      'event_1',
    ]);
  });

  it('withholds, then delivers late', async () => {
    const provider = await twoEvents();
    expect(provider.takeWebhooks('withheld')).toEqual([]);
    expect(provider.pendingWebhooks).toBe(2);

    // The same events, arriving later. This is "late"; never calling it again
    // would be "missing".
    expect(await eventIds(provider.takeWebhooks(), provider)).toEqual(['event_1', 'event_2']);
    expect(provider.pendingWebhooks).toBe(0);
  });

  it('empties the queue once delivered', async () => {
    const provider = await twoEvents();
    expect(provider.takeWebhooks()).toHaveLength(2);
    expect(provider.takeWebhooks()).toEqual([]);
  });

  it('produces byte-identical duplicates, so a replay is a true replay', async () => {
    const provider = await twoEvents();
    const [first, second] = provider.takeWebhooks('duplicated') as [SignedWebhook, SignedWebhook];
    expect(first.rawBody.equals(second.rawBody)).toBe(true);
    expect(first.headers).toEqual(second.headers);
  });

  it('refuses to drive a payment it does not know', () => {
    const provider = deterministicProvider();
    expect(() => provider.complete('payment_missing')).toThrow(PaymentProviderError);
  });

  it('records an expiry as its own event type', async () => {
    const provider = deterministicProvider();
    const created = await provider.createPayment(createInput());
    provider.expire(created.providerReference);
    const [webhook] = provider.takeWebhooks() as [SignedWebhook];
    await expect(provider.verifyWebhook(webhook.rawBody, webhook.headers)).resolves.toMatchObject({
      eventType: 'payment.expired',
      state: 'expired',
    });
  });
});

describe('refunds', () => {
  async function succeededPayment(): Promise<[FakePaymentProvider, string]> {
    const provider = deterministicProvider();
    const created = await provider.createPayment(createInput());
    provider.complete(created.providerReference);
    return [provider, created.providerReference];
  }

  it('refunds a succeeded payment', async () => {
    const [provider, reference] = await succeededPayment();
    await expect(
      provider.refund({ providerReference: reference, amount: GBP_10, idempotencyKey: 'refund-1' }),
    ).resolves.toEqual({ providerRefundReference: 'refund_1', state: 'succeeded' });
  });

  it('returns the first result when the idempotency key is reused', async () => {
    const [provider, reference] = await succeededPayment();
    const input = {
      providerReference: reference,
      amount: GBP_10,
      idempotencyKey: 'refund-1',
    };
    const first = await provider.refund(input);
    const second = await provider.refund(input);
    expect(second).toEqual(first);
  });

  it('refuses a payment that never succeeded', async () => {
    const provider = deterministicProvider();
    const created = await provider.createPayment(createInput());
    await expectProviderError(
      provider.refund({
        providerReference: created.providerReference,
        amount: GBP_10,
        idempotencyKey: 'refund-1',
      }),
      'provider_rejected',
    );
  });

  it('refuses an unknown reference', async () => {
    const provider = deterministicProvider();
    await expectProviderError(
      provider.refund({
        providerReference: 'payment_missing',
        amount: GBP_10,
        idempotencyKey: 'refund-1',
      }),
      'unknown_reference',
    );
  });

  it('refuses more than was paid', async () => {
    const [provider, reference] = await succeededPayment();
    await expectProviderError(
      provider.refund({
        providerReference: reference,
        amount: money(1001, 'GBP'),
        idempotencyKey: 'refund-1',
      }),
      'provider_rejected',
    );
  });

  it('refuses a different currency', async () => {
    const [provider, reference] = await succeededPayment();
    await expectProviderError(
      provider.refund({
        providerReference: reference,
        amount: money(1000, 'EUR'),
        idempotencyKey: 'refund-1',
      }),
      'provider_rejected',
    );
  });
});

describe('error classification', () => {
  it('marks only an unreachable provider as retryable', () => {
    expect(new PaymentProviderError('provider_unavailable', 'x').retryable).toBe(true);
    for (const kind of [
      'signature_invalid',
      'malformed_payload',
      'unknown_reference',
      'provider_rejected',
    ] as const) {
      expect(new PaymentProviderError(kind, 'x').retryable).toBe(false);
    }
  });
});
