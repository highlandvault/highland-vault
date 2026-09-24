import { Inject, Injectable } from '@nestjs/common';
import type { MfaVerifyRequest, TotpConfirmResponse, TotpSetupResponse } from '@hv/contracts';
import { type Database, sql, withTransaction } from '@hv/db';
import { SecretBox } from '@hv/domain';
import { AuditService } from '../audit/audit.service';
import { Errors } from '../common/errors';
import type { AuthContext, RequestMeta } from '../common/request-context';
import { API_ENV, type ApiEnv } from '../config/env';
import { DATABASE } from '../database/database.module';
import { RATE_LIMITS, RateLimiter } from './rate-limiter';
import { SessionsRepository } from './sessions.repository';
import { generateTotpSecret, matchTotp, otpauthUri, base32Encode } from './totp';
import { RECOVERY_CODE_COUNT, generateRecoveryCode, normalizeRecoveryCode, sha256 } from './tokens';

const ISSUER = 'Highland Vault';

/**
 * TOTP MFA (Revision 2 B6, ADR-0010): enrolment, sign-in second factor and
 * step-up. Which roles MUST enrol is OPEN O8, so enrolment is never forced
 * here; sensitive operations still require a fresh second factor (AccessGuard).
 */
@Injectable()
export class MfaService {
  private readonly box: SecretBox;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(API_ENV) env: ApiEnv,
    private readonly sessions: SessionsRepository,
    private readonly audit: AuditService,
    private readonly rateLimiter: RateLimiter,
  ) {
    this.box = new SecretBox(env.MFA_ENCRYPTION_KEY, env.MFA_ENCRYPTION_KEY_ID);
  }

  /** Issues (or re-issues) a pending TOTP secret. Refused once MFA is confirmed. */
  async setup(auth: AuthContext): Promise<TotpSetupResponse> {
    const secret = generateTotpSecret();
    const sealed = this.box.seal(secret, auth.userId);
    // The WHERE clause makes a confirmed enrolment impossible to overwrite, even concurrently.
    const row = await this.db
      .insertInto('user_mfa')
      .values({
        user_id: auth.userId,
        totp_secret_encrypted: sealed,
        encryption_key_id: this.box.keyId,
      })
      .onConflict((oc) =>
        oc
          .column('user_id')
          .doUpdateSet({
            totp_secret_encrypted: sealed,
            encryption_key_id: this.box.keyId,
            last_used_step: null,
          })
          .where('user_mfa.confirmed_at', 'is', null),
      )
      .returning('user_id')
      .executeTakeFirst();
    if (!row) throw Errors.conflict('MFA_ALREADY_ENABLED', 'MFA is already enabled.');
    return { secret: base32Encode(secret), otpauthUri: otpauthUri(secret, auth.email, ISSUER) };
  }

  /** Confirms enrolment with a first valid code; returns the recovery codes (shown once). */
  async confirm(auth: AuthContext, code: string, meta: RequestMeta): Promise<TotpConfirmResponse> {
    await this.rateLimiter.consume(RATE_LIMITS.mfaPerUser, auth.userId);
    const recoveryCodes = Array.from({ length: RECOVERY_CODE_COUNT }, generateRecoveryCode);

    return withTransaction(this.db, async (trx) => {
      const mfa = await trx
        .selectFrom('user_mfa')
        .select(['totp_secret_encrypted', 'confirmed_at', 'last_used_step'])
        .where('user_id', '=', auth.userId)
        .forUpdate()
        .executeTakeFirst();
      if (!mfa) throw Errors.conflict('MFA_NOT_ENROLLED', 'Start MFA setup first.');
      if (mfa.confirmed_at) throw Errors.conflict('MFA_ALREADY_ENABLED', 'MFA is already enabled.');

      const secret = this.box.open(mfa.totp_secret_encrypted, auth.userId);
      const step = matchTotp(secret, code, Date.now(), mfa.last_used_step);
      if (step === null) throw Errors.invalidMfaCode();

      await trx
        .updateTable('user_mfa')
        .set({ confirmed_at: sql<Date>`now()`, last_used_step: step })
        .where('user_id', '=', auth.userId)
        .execute();
      await trx.deleteFrom('mfa_recovery_codes').where('user_id', '=', auth.userId).execute();
      await trx
        .insertInto('mfa_recovery_codes')
        .values(
          recoveryCodes.map((recovery) => ({
            user_id: auth.userId,
            code_hash: sha256(normalizeRecoveryCode(recovery)),
          })),
        )
        .execute();
      // The enrolling session has just proven the second factor. Every other
      // session of the user predates MFA and is signed out.
      await this.sessions.markMfaVerified(trx, auth.sessionId);
      await this.sessions.revokeOthers(trx, auth.userId, auth.sessionId);
      await this.audit.record(trx, {
        actor: { type: 'user', userId: auth.userId },
        action: 'auth.mfa.enrolled',
        entityType: 'user',
        entityId: auth.userId,
        after: { method: 'totp', recoveryCodes: RECOVERY_CODE_COUNT },
        meta,
      });
      return { recoveryCodes };
    });
  }

  /**
   * Second factor for a pending sign-in, or step-up for a sensitive operation.
   * TOTP codes and recovery codes are each accepted at most once, enforced by
   * conditional updates, so concurrent replays cannot both succeed.
   */
  async verify(auth: AuthContext, input: MfaVerifyRequest, meta: RequestMeta): Promise<Date> {
    await this.rateLimiter.consume(RATE_LIMITS.mfaPerUser, auth.userId);

    return withTransaction(this.db, async (trx) => {
      const mfa = await trx
        .selectFrom('user_mfa')
        .select(['totp_secret_encrypted', 'last_used_step'])
        .where('user_id', '=', auth.userId)
        .where('confirmed_at', 'is not', null)
        .executeTakeFirst();
      if (!mfa) throw Errors.conflict('MFA_NOT_ENROLLED', 'MFA is not enabled for this account.');

      if ('code' in input) {
        const secret = this.box.open(mfa.totp_secret_encrypted, auth.userId);
        const step = matchTotp(secret, input.code, Date.now(), mfa.last_used_step);
        if (step === null) throw Errors.invalidMfaCode();
        const accepted = await trx
          .updateTable('user_mfa')
          .set({ last_used_step: step })
          .where('user_id', '=', auth.userId)
          .where((eb) => eb.or([eb('last_used_step', 'is', null), eb('last_used_step', '<', step)]))
          .returning('user_id')
          .executeTakeFirst();
        if (!accepted) throw Errors.invalidMfaCode();
      } else {
        const used = await trx
          .updateTable('mfa_recovery_codes')
          .set({ used_at: sql<Date>`now()` })
          .where('user_id', '=', auth.userId)
          .where('code_hash', '=', sha256(normalizeRecoveryCode(input.recoveryCode)))
          .where('used_at', 'is', null)
          .returning('id')
          .executeTakeFirst();
        if (!used) throw Errors.invalidMfaCode();
        await this.audit.record(trx, {
          actor: { type: 'user', userId: auth.userId },
          action: 'auth.mfa.recovery_code_used',
          entityType: 'user',
          entityId: auth.userId,
          meta,
        });
      }
      return this.sessions.markMfaVerified(trx, auth.sessionId);
    });
  }
}
