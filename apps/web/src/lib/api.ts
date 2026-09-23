import 'server-only';
import { type ErrorCode, ErrorResponseSchema } from '@hv/contracts';
import { cookies, headers } from 'next/headers';
import { webServerEnv } from '@/env';

/**
 * Server-side client for the Highland Vault API (the security boundary,
 * ADR-0009). The browser never talks to the API directly and never sees the
 * session token: the web server keeps it in its own HttpOnly cookie and
 * forwards it on every call.
 */
export const SESSION_COOKIE = 'hv_session';

export type ApiResult<T> =
  | { ok: true; status: number; data: T; response: Response }
  | {
      ok: false;
      status: number;
      code: ErrorCode | 'UNREACHABLE';
      message: string;
      details?: unknown;
    };

export async function apiFetch<T>(
  path: string,
  init: { method?: 'GET' | 'POST' | 'PUT'; body?: unknown; parse?: (json: unknown) => T } = {},
): Promise<ApiResult<T>> {
  const [cookieStore, incoming] = await Promise.all([cookies(), headers()]);
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  const outgoing: Record<string, string> = { accept: 'application/json' };
  if (token) outgoing.cookie = `${SESSION_COOKIE}=${token}`;
  if (init.body !== undefined) outgoing['content-type'] = 'application/json';
  // State-changing calls carry the browser's Origin; Next.js has already checked
  // it for server actions, and the API checks it against WEB_ORIGINS (CSRF).
  const origin = incoming.get('origin');
  if (origin) outgoing.origin = origin;
  const forwardedFor = incoming.get('x-forwarded-for');
  if (forwardedFor) outgoing['x-forwarded-for'] = forwardedFor;

  let response: Response;
  try {
    response = await fetch(`${webServerEnv().API_BASE_URL}${path}`, {
      method: init.method ?? 'GET',
      headers: outgoing,
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      cache: 'no-store',
      signal: AbortSignal.timeout(5_000),
    });
  } catch (error) {
    return {
      ok: false,
      status: 503,
      code: 'UNREACHABLE',
      message: error instanceof Error ? error.message : 'API unreachable',
    };
  }

  if (!response.ok) {
    const parsed = ErrorResponseSchema.safeParse(await response.json().catch(() => null));
    return parsed.success
      ? {
          ok: false,
          status: response.status,
          code: parsed.data.error.code,
          message: parsed.data.error.message,
          details: parsed.data.error.details,
        }
      : {
          ok: false,
          status: response.status,
          code: 'INTERNAL_ERROR',
          message: 'Unexpected API response',
        };
  }
  const json: unknown = response.status === 204 ? null : await response.json();
  return {
    ok: true,
    status: response.status,
    data: init.parse ? init.parse(json) : (json as T),
    response,
  };
}

/**
 * Copies the session cookie the API issued (or cleared) onto the web origin,
 * keeping the API's attributes: HttpOnly, SameSite=Lax, Secure, expiry.
 */
export async function adoptSessionCookie(response: Response): Promise<void> {
  const header = response.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`));
  if (!header) return;
  const [pair, ...attributes] = header.split(';').map((part) => part.trim());
  const value = pair!.slice(SESSION_COOKIE.length + 1);
  const maxAge = Number(attributes.find((a) => /^max-age=/i.test(a))?.split('=')[1] ?? 0);
  const store = await cookies();
  if (!value || maxAge <= 0) {
    store.delete(SESSION_COOKIE);
    return;
  }
  store.set(SESSION_COOKIE, value, {
    httpOnly: true,
    sameSite: 'lax',
    secure: attributes.some((a) => a.toLowerCase() === 'secure'),
    path: '/',
    maxAge,
  });
}
