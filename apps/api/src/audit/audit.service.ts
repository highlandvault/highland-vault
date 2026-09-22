import { Injectable } from '@nestjs/common';
import type { DbExecutor, Json } from '@hv/db';
import type { RequestMeta } from '../common/request-context';

export type AuditActor = { type: 'user'; userId: string } | { type: 'system' };

export interface AuditEntry {
  actor: AuditActor;
  /** dotted, lower case: "market.enabled", "auth.mfa.enrolled" */
  action: string;
  entityType: string;
  entityId: string | null;
  marketId?: string | null;
  reason?: string | null;
  before?: Json | null;
  after?: Json | null;
  meta?: Pick<RequestMeta, 'ip' | 'requestId'> | null;
}

/**
 * Writes the append-only audit log (ADR-0010). Always call it with the SAME
 * transaction as the action being recorded, so both commit or neither does.
 */
@Injectable()
export class AuditService {
  async record(trx: DbExecutor, entry: AuditEntry): Promise<void> {
    await trx
      .insertInto('audit_log')
      .values({
        actor_type: entry.actor.type,
        actor_user_id: entry.actor.type === 'user' ? entry.actor.userId : null,
        action: entry.action,
        entity_type: entry.entityType,
        entity_id: entry.entityId,
        market_id: entry.marketId ?? null,
        reason: entry.reason ?? null,
        before:
          entry.before === undefined || entry.before === null ? null : JSON.stringify(entry.before),
        after:
          entry.after === undefined || entry.after === null ? null : JSON.stringify(entry.after),
        ip: entry.meta?.ip ?? null,
        request_id: entry.meta?.requestId ?? null,
      })
      .execute();
  }
}
