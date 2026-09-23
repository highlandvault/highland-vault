import { SetMetadata } from '@nestjs/common';

/**
 * Every route declares exactly one access policy. AccessGuard denies any route
 * that declares none (deny by default, ADR-0010), so forgetting a decorator
 * can never expose an endpoint.
 */
export type AccessPolicy =
  /** identify: attach the caller's session when there is a valid one, never require it. */
  | { kind: 'public'; identify?: boolean }
  | { kind: 'authenticated'; allowMfaPending: boolean }
  | {
      kind: 'permission';
      permission: string;
      /**
       * 'global': the grant must cover all markets.
       * 'any': a grant in any market scope suffices (for example to open the admin shell).
       * { param }: the grant must cover the market named by that route parameter.
       */
      scope: 'global' | 'any' | { param: string };
      /**
       * Sensitive operation (ADR-0010): additionally requires step-up MFA within
       * STEP_UP_WINDOW_MS. The handler must also take a reason and write the
       * audit record in the same transaction.
       */
      sensitive: boolean;
    };

export const ACCESS_POLICY = 'hv:access-policy';

/** Sensitive operations need a second factor verified within the last 15 minutes (Revision 2 B7). */
export const STEP_UP_WINDOW_MS = 15 * 60 * 1000;

export const Public = (options: { identify?: boolean } = {}) =>
  SetMetadata(ACCESS_POLICY, {
    kind: 'public',
    ...(options.identify ? { identify: true } : {}),
  } satisfies AccessPolicy);

export const Authenticated = (options: { allowMfaPending?: boolean } = {}) =>
  SetMetadata(ACCESS_POLICY, {
    kind: 'authenticated',
    allowMfaPending: options.allowMfaPending ?? false,
  } satisfies AccessPolicy);

export const RequirePermission = (
  permission: string,
  options: { scope?: 'global' | 'any' | { param: string }; sensitive?: boolean } = {},
) =>
  SetMetadata(ACCESS_POLICY, {
    kind: 'permission',
    permission,
    scope: options.scope ?? 'global',
    sensitive: options.sensitive ?? false,
  } satisfies AccessPolicy);
