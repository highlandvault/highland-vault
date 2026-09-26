import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Redis } from 'ioredis';
import { Errors } from '../common/errors';
import { REDIS } from '../redis/redis.module';

export interface RateLimit {
  /** Stable name, part of the Redis key. */
  readonly name: string;
  readonly limit: number;
  readonly windowSeconds: number;
}

/**
 * Limits for authentication endpoints (Revision 2 B19). These are security
 * engineering values, not business rules; they are tuned here.
 */
export const RATE_LIMITS = {
  loginPerIp: { name: 'login-ip', limit: 100, windowSeconds: 15 * 60 },
  loginPerEmail: { name: 'login-email', limit: 10, windowSeconds: 15 * 60 },
  registerPerIp: { name: 'register-ip', limit: 20, windowSeconds: 60 * 60 },
  mfaPerUser: { name: 'mfa-user', limit: 5, windowSeconds: 15 * 60 },
  reservePerUser: { name: 'reserve-user', limit: 30, windowSeconds: 10 * 60 },
  // Basket changes per owner (ADR-0031), keyed on the user or the guest
  // session rather than the address, so it holds for both kinds of checkout.
  // Same value and window as reservePerUser: adding to a basket allocates
  // tickets through the same engine and costs the same.
  cartItemsPerOwner: { name: 'cart-owner', limit: 30, windowSeconds: 10 * 60 },
  // Checkout, which B19 names among the routes that must be limited. Same
  // value and window as the basket and reservation limits, keyed on the
  // checkout identity so a guest and an account each get their own bucket.
  //
  // It bounds CHECKOUT ATTEMPTS. It is not an answer-attempt counter, and
  // ADR-0030 deliberately does not introduce one: a caller inside this limit
  // still has more attempts than a skill question has options.
  checkoutPerOwner: { name: 'checkout-owner', limit: 30, windowSeconds: 10 * 60 },
  // Starting a payment, per checkout identity (B19, Phase 6). Same value and
  // window as checkout: it is the step immediately after one, and a caller who
  // may attempt thirty checkouts may reasonably attempt thirty payments.
  //
  // It is not what stops a customer opening several provider sessions — one
  // live attempt per order is a partial unique index, not a counter. This
  // bounds the cost of asking.
  paymentsPerOwner: { name: 'payments-owner', limit: 30, windowSeconds: 10 * 60 },
  // Guest verification codes per address per hour (ADR-0020). Keyed on the
  // address so one inbox cannot be flooded from many sessions.
  verificationCodePerEmail: { name: 'verify-email', limit: 3, windowSeconds: 60 * 60 },
  // And per IP, because the limit above bounds one inbox but not one caller:
  // rotating addresses would otherwise mean unlimited mail to strangers and
  // unlimited rows on tables hv_app cannot delete from. Same value and window
  // as registerPerIp — the nearest thing in this codebase, another public,
  // unauthenticated write that creates a durable identity.
  verificationCodePerIp: { name: 'verify-ip', limit: 20, windowSeconds: 60 * 60 },
} as const satisfies Record<string, RateLimit>;

/**
 * Fixed-window counters in Redis. Identifiers are hashed, so Redis never holds
 * email addresses or IPs in clear text.
 *
 * Fails CLOSED: if Redis cannot be reached, authentication is refused with 503
 * rather than running without brute-force protection.
 */
@Injectable()
export class RateLimiter {
  private readonly logger = new Logger(RateLimiter.name);

  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async consume(rule: RateLimit, identifier: string): Promise<void> {
    const digest = createHash('sha256').update(identifier).digest('hex').slice(0, 32);
    const key = `hv:rl:${rule.name}:${digest}`;
    let count: number;
    let ttl: number;
    try {
      const results = await this.redis
        .multi()
        .incr(key)
        .expire(key, rule.windowSeconds, 'NX')
        .ttl(key)
        .exec();
      if (!results || results.some(([error]) => error)) throw new Error('transaction failed');
      count = Number(results[0]![1]);
      ttl = Number(results[2]![1]);
    } catch (error) {
      this.logger.warn(`rate limiter unavailable: ${(error as Error).message}`);
      throw Errors.serviceUnavailable();
    }
    if (count > rule.limit) {
      throw Errors.rateLimited(ttl > 0 ? ttl : rule.windowSeconds);
    }
  }
}
