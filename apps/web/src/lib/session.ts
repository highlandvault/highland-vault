import 'server-only';
import { type MeResponse, MeResponseSchema } from '@hv/contracts';
import { redirect } from 'next/navigation';
import { apiFetch } from './api';

/** The signed-in account, or a redirect to sign-in (or to the second-factor step). */
export async function requireSession(returnTo: string): Promise<MeResponse> {
  const result = await apiFetch('/auth/me', { parse: (json) => MeResponseSchema.parse(json) });
  if (result.ok) return result.data;
  const next = encodeURIComponent(returnTo);
  if (result.code === 'MFA_REQUIRED') redirect(`/login/mfa?next=${next}`);
  if (result.status === 401) redirect(`/login?next=${next}`);
  throw new Error(`Session lookup failed: ${result.code}`);
}

export function hasPermission(me: MeResponse, permission: string): boolean {
  return me.permissions.some((grant) => grant.permission === permission);
}

const MESSAGES: Record<string, string> = {
  INVALID_CREDENTIALS: 'The email or password is incorrect.',
  ACCOUNT_DISABLED: 'This account is disabled.',
  RATE_LIMITED: 'Too many attempts. Try again later.',
  INVALID_MFA_CODE: 'That code is invalid or has already been used.',
  EMAIL_TAKEN: 'An account with this email already exists.',
  VALIDATION_FAILED: 'Check the details: passwords need at least 12 characters.',
  ORIGIN_NOT_ALLOWED: 'This request was refused (origin not allowed).',
  UNREACHABLE: 'The service is unavailable. Try again shortly.',
};

export function errorMessage(code: string | undefined): string | null {
  if (!code) return null;
  return MESSAGES[code] ?? 'Something went wrong. Try again.';
}
