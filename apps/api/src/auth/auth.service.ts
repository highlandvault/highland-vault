import { Inject, Injectable } from '@nestjs/common';
import type { LoginRequest, MeResponse, RegisterRequest } from '@hv/contracts';
import { type Database, lockEntrantEmail, withTransaction } from '@hv/db';
import { EmailError, parseEmail } from '@hv/domain';
import { randomBytes } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import { Errors } from '../common/errors';
import { isUniqueViolation } from '../common/pg-errors';
import type { AuthContext, RequestMeta } from '../common/request-context';
import { DATABASE } from '../database/database.module';
import { RbacService } from '../rbac/rbac.service';
import { CapBridgingRepository } from '../tickets/cap-bridging.repository';
import { UsersRepository } from '../users/users.repository';
import { hashPassword, needsRehash, verifyPassword } from './password';
import { RATE_LIMITS, RateLimiter } from './rate-limiter';
import { type IssuedSession, SessionsService } from './sessions.service';

export interface SignInResult {
  status: 'authenticated' | 'mfa_required';
  session: IssuedSession;
}

/**
 * Registration, sign-in and sign-out (Revision 2 B6). Email verification and
 * password reset need transactional email, which Revision 2 routes through the
 * outbox (Phase 5); they are not part of this phase.
 */
@Injectable()
export class AuthService {
  /** Verified against for unknown emails, so both paths cost one Argon2id run. */
  private dummyHash: Promise<string> | undefined;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly users: UsersRepository,
    private readonly sessions: SessionsService,
    private readonly rbac: RbacService,
    private readonly rateLimiter: RateLimiter,
    private readonly capBridging: CapBridgingRepository,
    private readonly audit: AuditService,
  ) {}

  async register(input: RegisterRequest, meta: RequestMeta): Promise<SignInResult> {
    await this.rateLimiter.consume(RATE_LIMITS.registerPerIp, meta.ip ?? 'unknown');
    const email = this.parseEmailOrFail(input.email);
    // Hash outside the transaction: never hold a connection during expensive CPU work.
    const passwordHash = await hashPassword(input.password);

    try {
      return await withTransaction(this.db, async (trx) => {
        // Before the account exists, so a guest allocation for this same
        // address either finishes first and is bridged below, or waits here
        // and then resolves to the account (ADR-0021). A row lock cannot do
        // this: the counter row it would write may not exist yet.
        await lockEntrantEmail(trx, email);

        const user = await this.users.insert(trx, email, passwordHash);
        await trx
          .insertInto('user_roles')
          .values({ user_id: user.id, role_code: 'customer' })
          .execute();

        // Whatever this address already holds as a guest becomes the
        // account's, counters and live holds together (ADR-0021). In the same
        // transaction as the account: a half-bridged cap is worse than none.
        const bridged = await this.capBridging.bridge(trx, email, user.id);
        if (bridged.counters > 0 || bridged.reservations > 0) {
          await this.audit.record(trx, {
            actor: { type: 'user', userId: user.id },
            action: 'entrant.cap.bridged',
            entityType: 'user',
            entityId: user.id,
            // Counts only. The address is the account's own and is already on
            // the user row; repeating it here adds nothing but exposure.
            after: {
              draws: bridged.counters,
              reservations: bridged.reservations,
              tickets: bridged.tickets,
            },
            meta: { ip: meta.ip, requestId: meta.requestId },
          });
        }

        const session = await this.sessions.issue(trx, user.id, false, meta);
        return { status: 'authenticated' as const, session };
      });
    } catch (error) {
      if (isUniqueViolation(error, 'users_email_key')) {
        throw Errors.conflict('EMAIL_TAKEN', 'An account with this email already exists.');
      }
      throw error;
    }
  }

  async login(input: LoginRequest, meta: RequestMeta): Promise<SignInResult> {
    await this.rateLimiter.consume(RATE_LIMITS.loginPerIp, meta.ip ?? 'unknown');
    let email: string;
    try {
      email = parseEmail(input.email);
    } catch {
      throw Errors.invalidCredentials();
    }
    await this.rateLimiter.consume(RATE_LIMITS.loginPerEmail, email);

    const user = await this.users.findByEmail(this.db, email);
    const valid = await verifyPassword(user?.passwordHash ?? (await this.dummy()), input.password);
    if (!user || !valid) throw Errors.invalidCredentials();
    // Revealed only to someone who knows the password.
    if (user.status !== 'active') throw Errors.accountDisabled();

    const rehash = needsRehash(user.passwordHash) ? await hashPassword(input.password) : null;

    return withTransaction(this.db, async (trx) => {
      if (rehash) await this.users.updatePasswordHash(trx, user.id, rehash);
      const mfa = await trx
        .selectFrom('user_mfa')
        .select('confirmed_at')
        .where('user_id', '=', user.id)
        .executeTakeFirst();
      const mfaRequired = Boolean(mfa?.confirmed_at);
      const session = await this.sessions.issue(trx, user.id, mfaRequired, meta);
      return { status: mfaRequired ? 'mfa_required' : 'authenticated', session };
    });
  }

  logout(auth: AuthContext): Promise<void> {
    return this.sessions.revoke(auth.sessionId);
  }

  async me(auth: AuthContext): Promise<MeResponse> {
    const [user, mfa, access] = await Promise.all([
      this.users.findById(this.db, auth.userId),
      this.db
        .selectFrom('user_mfa')
        .select('confirmed_at')
        .where('user_id', '=', auth.userId)
        .executeTakeFirst(),
      this.rbac.accessOf(auth.userId),
    ]);
    if (!user) throw Errors.unauthenticated();
    return {
      user: {
        id: user.id,
        email: user.email,
        emailVerified: user.emailVerifiedAt !== null,
        mfaEnabled: Boolean(mfa?.confirmed_at),
      },
      session: {
        expiresAt: auth.expiresAt.toISOString(),
        mfaVerifiedAt: auth.mfaVerifiedAt?.toISOString() ?? null,
      },
      roles: access.roles,
      permissions: access.permissions,
    };
  }

  private parseEmailOrFail(input: string): string {
    try {
      return parseEmail(input);
    } catch (error) {
      if (error instanceof EmailError) {
        throw Errors.validation({ issues: [{ path: 'email', message: error.message }] });
      }
      throw error;
    }
  }

  private dummy(): Promise<string> {
    this.dummyHash ??= hashPassword(randomBytes(32).toString('base64'));
    return this.dummyHash;
  }
}
