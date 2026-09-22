import { Injectable } from '@nestjs/common';
import type { DbExecutor } from '@hv/db';

/** Where a permission must hold. */
export type PermissionScope =
  /** Granted for all markets (user_roles.market_id IS NULL). */
  | { kind: 'global' }
  /** Granted for all markets, or for this market specifically. */
  | { kind: 'market'; marketId: string }
  /** Granted in at least one scope (for example: may open the admin shell at all). */
  | { kind: 'any' };

export interface Grant {
  role: string;
  permission: string | null;
  marketCode: string | null;
}

@Injectable()
export class RbacRepository {
  async hasPermission(
    db: DbExecutor,
    userId: string,
    permission: string,
    scope: PermissionScope,
  ): Promise<boolean> {
    let query = db
      .selectFrom('user_roles as ur')
      .innerJoin('role_permissions as rp', 'rp.role_code', 'ur.role_code')
      .select('ur.id')
      .where('ur.user_id', '=', userId)
      .where('rp.permission_code', '=', permission);
    if (scope.kind === 'global') {
      query = query.where('ur.market_id', 'is', null);
    } else if (scope.kind === 'market') {
      const { marketId } = scope;
      query = query.where((eb) =>
        eb.or([eb('ur.market_id', 'is', null), eb('ur.market_id', '=', marketId)]),
      );
    }
    return (await query.limit(1).executeTakeFirst()) !== undefined;
  }

  /** Every role grant of a user with its permissions (one row per role × permission). */
  async grants(db: DbExecutor, userId: string): Promise<Grant[]> {
    const rows = await db
      .selectFrom('user_roles as ur')
      .leftJoin('role_permissions as rp', 'rp.role_code', 'ur.role_code')
      .leftJoin('markets as m', 'm.id', 'ur.market_id')
      .select(['ur.role_code', 'rp.permission_code', 'm.code as market_code'])
      .where('ur.user_id', '=', userId)
      .orderBy('ur.role_code')
      .orderBy('rp.permission_code')
      .execute();
    return rows.map((row) => ({
      role: row.role_code,
      permission: row.permission_code,
      marketCode: row.market_code,
    }));
  }
}
