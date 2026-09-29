import type { FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import {
  PROVIDER_WEBHOOK_ROUTES,
  WEBHOOK_MAX_BODY_BYTES,
  isProviderWebhookRoute,
  rawBodyOf,
} from './webhook-request';

const asRequest = (routeUrl: string | undefined, extra: object = {}) =>
  ({ routeOptions: routeUrl === undefined ? {} : { url: routeUrl }, ...extra }) as FastifyRequest;

describe('the provider webhook exemption', () => {
  it('covers the declared webhook route', () => {
    expect(isProviderWebhookRoute(asRequest('/webhooks/payments/:provider'))).toBe(true);
  });

  it('covers nothing else', () => {
    for (const url of [
      '/markets/uk/cart/items',
      '/markets/uk/checkout/orders',
      '/auth/login',
      '/webhooks',
      '/webhooks/payments',
      '/webhooks/payments/:provider/extra',
      // The exemption matches a ROUTE PATTERN, not a path. A concrete path
      // never appears here, because Fastify reports the pattern it matched.
      '/webhooks/payments/fake',
    ]) {
      expect(isProviderWebhookRoute(asRequest(url))).toBe(false);
    }
  });

  it('refuses a request whose route could not be identified', () => {
    // No matched route means no exemption. Failing closed is the only safe
    // default for something that turns a security check off.
    expect(isProviderWebhookRoute(asRequest(undefined))).toBe(false);
    expect(isProviderWebhookRoute({} as FastifyRequest)).toBe(false);
  });

  it('is a short, explicit list rather than a prefix', () => {
    // A prefix would quietly grow to cover routes added later. Widening this
    // means writing another pattern down.
    expect(PROVIDER_WEBHOOK_ROUTES).toHaveLength(1);
    for (const pattern of PROVIDER_WEBHOOK_ROUTES) {
      expect(pattern.startsWith('/')).toBe(true);
    }
  });

  it('keeps the webhook body limit under the API-wide 64 KB', () => {
    // So that an oversized provider message is our own refusal, with its own
    // answer, rather than the framework's — which reads nothing like the real
    // problem.
    expect(WEBHOOK_MAX_BODY_BYTES).toBeLessThan(64 * 1024);
    expect(WEBHOOK_MAX_BODY_BYTES).toBeGreaterThan(0);
  });
});

describe('the raw body', () => {
  it('is whatever the hook kept', () => {
    const bytes = Buffer.from('{"a":1}', 'utf8');
    expect(rawBodyOf(asRequest('/webhooks/payments/:provider', { rawBody: bytes }))).toBe(bytes);
  });

  it('is absent on a route that never kept it', () => {
    expect(rawBodyOf(asRequest('/auth/login'))).toBeUndefined();
  });
});
