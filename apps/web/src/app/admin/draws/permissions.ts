import type { MeResponse } from '@hv/contracts';

/** Whether the account holds `permission` for `market` (a global grant or one for that market). */
export function canInMarket(me: MeResponse, permission: string, market: string): boolean {
  return me.permissions.some(
    (grant) =>
      grant.permission === permission && (grant.market === null || grant.market === market),
  );
}

export const ADMIN_MARKETS = ['uk', 'ie', 'de'] as const;
