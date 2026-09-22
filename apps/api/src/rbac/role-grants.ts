import { type Database, withTransaction } from '@hv/db';
import { parseEmail } from '@hv/domain';
import type { AuditActor, AuditService } from '../audit/audit.service';

export interface GrantRoleInput {
  email: string;
  role: string;
  /** Market code for a market-scoped grant; null/undefined = all markets. */
  market?: string | null;
  reason: string;
  actor: AuditActor;
}

export type GrantRoleResult = 'granted' | 'already_granted';

export class RoleGrantError extends Error {
  override readonly name = 'RoleGrantError';
}

/**
 * Grants a role, audited in the same transaction. Used by the operator CLI to
 * bootstrap the first staff accounts; an admin API for role management is a
 * later phase (O9 decides whether it is a sensitive operation).
 */
export async function grantRole(
  db: Database,
  audit: AuditService,
  input: GrantRoleInput,
): Promise<GrantRoleResult> {
  if (input.reason.trim().length < 3) throw new RoleGrantError('a reason is required');
  const email = parseEmail(input.email);

  return withTransaction(db, async (trx) => {
    const user = await trx
      .selectFrom('users')
      .select('id')
      .where('email', '=', email)
      .executeTakeFirst();
    if (!user) throw new RoleGrantError(`no user with email ${email}`);

    const role = await trx
      .selectFrom('roles')
      .select('code')
      .where('code', '=', input.role)
      .executeTakeFirst();
    if (!role) throw new RoleGrantError(`unknown role ${input.role}`);

    let marketId: string | null = null;
    if (input.market) {
      const market = await trx
        .selectFrom('markets')
        .select('id')
        .where('code', '=', input.market)
        .executeTakeFirst();
      if (!market) throw new RoleGrantError(`unknown market ${input.market}`);
      marketId = market.id;
    }

    const inserted = await trx
      .insertInto('user_roles')
      .values({
        user_id: user.id,
        role_code: role.code,
        market_id: marketId,
        granted_by: input.actor.type === 'user' ? input.actor.userId : null,
      })
      .onConflict((oc) => oc.constraint('user_roles_user_role_market_key').doNothing())
      .returning('id')
      .executeTakeFirst();
    if (!inserted) return 'already_granted';

    await audit.record(trx, {
      actor: input.actor,
      action: 'rbac.role.granted',
      entityType: 'user',
      entityId: user.id,
      marketId,
      reason: input.reason.trim(),
      after: { role: role.code, market: input.market ?? null },
    });
    return 'granted';
  });
}
