import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Database } from '@hv/db';
import type { FastifyRequest } from 'fastify';
import { SessionsService } from '../auth/sessions.service';
import { GuestSessionsService } from '../guests/guest-sessions.service';
import { Errors } from '../common/errors';
import { DATABASE } from '../database/database.module';
import { MarketsRepository } from '../markets/markets.repository';
import { ACCESS_POLICY, type AccessPolicy, STEP_UP_WINDOW_MS } from './access';
import type { PermissionScope } from './rbac.repository';
import { RbacService } from './rbac.service';

/**
 * Global guard: authentication, permission and step-up checks for every route.
 *
 *   no policy        → 403 (deny by default)
 *   public           → allowed
 *   authenticated    → valid session; MFA completed unless allowMfaPending
 *   permission       → as above + RBAC grant in the required market scope
 *                      (+ fresh step-up MFA for sensitive operations)
 *
 * The frontend may hide things, but this guard is the security boundary (ADR-0009).
 */
@Injectable()
export class AccessGuard implements CanActivate {
  private readonly logger = new Logger(AccessGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionsService,
    private readonly guests: GuestSessionsService,
    private readonly rbac: RbacService,
    private readonly markets: MarketsRepository,
    @Inject(DATABASE) private readonly db: Database,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const policy = this.reflector.getAllAndOverride<AccessPolicy | undefined>(ACCESS_POLICY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const request = context.switchToHttp().getRequest<FastifyRequest>();

    if (!policy) {
      this.logger.error(`route ${request.method} ${request.url} has no access policy — denied`);
      throw Errors.forbidden();
    }
    if (policy.kind === 'public') {
      if (policy.identify) {
        const auth = await this.sessions.authenticate(request);
        // A half-signed-in session (MFA pending) stays anonymous.
        if (auth && !(auth.mfaRequired && auth.mfaVerifiedAt === null)) request.hvAuth = auth;
        // A guest, if there is one. Resolved ONLY here, on the public branch:
        // every path below this point is an authorization decision, and none of
        // them reads hvGuest, so a guest cookie can never satisfy one
        // (ADR-0029). A signed-in caller is never also treated as a guest.
        if (!request.hvAuth) {
          const guest = await this.guests.resolve(request);
          if (guest) request.hvGuest = guest;
        }
      }
      return true;
    }

    const auth = await this.sessions.authenticate(request);
    if (!auth) throw Errors.unauthenticated();
    const mfaPending = auth.mfaRequired && auth.mfaVerifiedAt === null;
    if (mfaPending && !(policy.kind === 'authenticated' && policy.allowMfaPending)) {
      throw Errors.mfaRequired();
    }
    request.hvAuth = auth;
    if (policy.kind === 'authenticated') return true;

    const scope = await this.resolveScope(policy.scope, request);
    if (!(await this.rbac.hasPermission(auth.userId, policy.permission, scope))) {
      throw Errors.forbidden();
    }
    if (policy.sensitive) {
      const verifiedAt = auth.mfaVerifiedAt?.getTime();
      if (verifiedAt === undefined || Date.now() - verifiedAt > STEP_UP_WINDOW_MS) {
        throw Errors.stepUpRequired();
      }
    }
    return true;
  }

  private async resolveScope(
    scope: 'global' | 'any' | { param: string },
    request: FastifyRequest,
  ): Promise<PermissionScope> {
    if (scope === 'global' || scope === 'any') return { kind: scope };
    const code = (request.params as Record<string, string | undefined>)[scope.param];
    const market =
      code && /^[a-z]{2}$/.test(code) ? await this.markets.findByCode(this.db, code) : null;
    if (!market) throw Errors.notFound('Market');
    return { kind: 'market', marketId: market.id };
  }
}
