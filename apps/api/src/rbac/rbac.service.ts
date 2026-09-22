import { Inject, Injectable } from '@nestjs/common';
import type { PermissionGrant } from '@hv/contracts';
import type { Database } from '@hv/db';
import { DATABASE } from '../database/database.module';
import { type PermissionScope, RbacRepository } from './rbac.repository';

export interface UserAccess {
  roles: { role: string; market: string | null }[];
  permissions: PermissionGrant[];
}

@Injectable()
export class RbacService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly repository: RbacRepository,
  ) {}

  hasPermission(userId: string, permission: string, scope: PermissionScope): Promise<boolean> {
    return this.repository.hasPermission(this.db, userId, permission, scope);
  }

  async accessOf(userId: string): Promise<UserAccess> {
    const grants = await this.repository.grants(this.db, userId);
    const roles = new Map<string, { role: string; market: string | null }>();
    const permissions = new Map<string, PermissionGrant>();
    for (const grant of grants) {
      roles.set(`${grant.role}|${grant.marketCode}`, {
        role: grant.role,
        market: grant.marketCode,
      });
      if (grant.permission) {
        permissions.set(`${grant.permission}|${grant.marketCode}`, {
          permission: grant.permission,
          market: grant.marketCode,
        });
      }
    }
    return { roles: [...roles.values()], permissions: [...permissions.values()] };
  }
}
