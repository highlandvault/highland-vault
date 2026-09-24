import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { MarketCode } from '@hv/domain';
import type { FastifyRequest } from 'fastify';
import type { GuestContext } from '../guests/guest-sessions.repository';
import { Errors } from './errors';

/** The authenticated session behind a request (set by AccessGuard). */
export interface AuthContext {
  readonly sessionId: string;
  readonly userId: string;
  readonly email: string;
  readonly mfaRequired: boolean;
  readonly mfaVerifiedAt: Date | null;
  readonly expiresAt: Date;
}

/** The resolved, available market of a market-scoped request (set by MarketGuard). */
export interface MarketContext {
  readonly id: string;
  readonly code: MarketCode;
  readonly name: string;
  readonly currency: 'GBP' | 'EUR';
  readonly locale: string;
}

/** Request facts recorded in the audit log and on sessions. */
export interface RequestMeta {
  readonly ip: string | null;
  readonly requestId: string;
  readonly userAgent: string | null;
}

declare module 'fastify' {
  interface FastifyRequest {
    hvAuth?: AuthContext;
    hvMarket?: MarketContext;
    /**
     * The guest behind a public request, if any (ADR-0029).
     *
     * Deliberately a different field from hvAuth, holding a different type
     * with no user and no permissions. Nothing on the authenticated or
     * permission paths reads it, so a guest cookie can never satisfy them.
     */
    hvGuest?: GuestContext;
  }
}

export function requestMeta(request: FastifyRequest): RequestMeta {
  const userAgent = request.headers['user-agent'];
  return {
    ip: request.ip || null,
    requestId: String(request.id),
    userAgent: typeof userAgent === 'string' ? userAgent.slice(0, 512) : null,
  };
}

export const CurrentAuth = createParamDecorator((_: unknown, ctx: ExecutionContext) => {
  const auth = ctx.switchToHttp().getRequest<FastifyRequest>().hvAuth;
  if (!auth) throw Errors.unauthenticated();
  return auth;
});

/** The signed-in caller if there is one (routes declared with @Public({ identify: true })). */
export const OptionalAuth = createParamDecorator(
  (_: unknown, ctx: ExecutionContext) =>
    ctx.switchToHttp().getRequest<FastifyRequest>().hvAuth ?? null,
);

/**
 * The guest behind the request, if any.
 *
 * Always optional and never a substitute for @CurrentAuth: a route that needs
 * a signed-in customer asks for authentication, and this returns null for one.
 */
export const CurrentGuest = createParamDecorator(
  (_: unknown, ctx: ExecutionContext) =>
    ctx.switchToHttp().getRequest<FastifyRequest>().hvGuest ?? null,
);

export const CurrentMarket = createParamDecorator((_: unknown, ctx: ExecutionContext) => {
  const market = ctx.switchToHttp().getRequest<FastifyRequest>().hvMarket;
  // Only reachable if a handler forgot @UseGuards(MarketGuard): fail closed.
  if (!market) throw Errors.marketNotAvailable();
  return market;
});

export const Meta = createParamDecorator((_: unknown, ctx: ExecutionContext) =>
  requestMeta(ctx.switchToHttp().getRequest<FastifyRequest>()),
);
