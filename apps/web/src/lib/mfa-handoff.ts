import 'server-only';
import { SecretBox } from '@hv/domain';
import { cookies, headers } from 'next/headers';
import { webServerEnv } from '@/env';

/**
 * Carrying the TOTP secret, and then the recovery codes, from the Server
 * Action that obtained them to the page that renders them (UI-9).
 *
 * ## Why anything has to be carried at all
 *
 * `POST /auth/mfa/totp/setup` returns the secret **once** and there is no GET
 * to read a pending one back. Calling setup again does not re-issue the same
 * secret: it mints a fresh one and nulls `last_used_step`, which would
 * invalidate whatever the customer has just typed into their authenticator. So
 * a wrong confirmation code must not re-run setup, and the only way for the
 * retry to show the SAME secret is for the web tier to hold it across one
 * redirect.
 *
 * A URL is not an option — query strings reach browser history, `Referer`
 * headers and anything that logs a request line — so it is a cookie, which is
 * the same mechanism the order-access return link already uses.
 *
 * ## Why the cookie is encrypted, and not merely HttpOnly
 *
 * HttpOnly stops page scripts reading it. It does **not** make it secret: the
 * value sits in the browser's cookie store in the clear, where an infostealer
 * or anyone with the browser profile can read it.
 *
 * For the pending secret that is close to harmless — such an attacker also has
 * `hv_session` and could simply run the enrolment themselves. The recovery
 * codes are different: they are ten standing second-factor bypasses, and they
 * **outlive the session**. A cookie jar exfiltrated after the session expired
 * would still yield ten usable codes. Sealing the payload removes that, because
 * the key never leaves the web server.
 *
 * `SecretBox` is the same AES-256-GCM primitive the API uses for TOTP secrets
 * at rest (ADR-0028's sibling), reused rather than reinvented. The associated
 * data binds a payload to one purpose **and one session**, so a sealed setup
 * blob cannot be replayed as a recovery-code blob, and neither can be moved to
 * another browser: a cookie copied to a different session simply fails to open.
 *
 * ## What this is not
 *
 * Not a session store, and not general-purpose. Two names, two purposes, a few
 * minutes of life each, scoped to one path, and nothing reads them but the
 * three pages of this one flow.
 */

/** The pending setup, between `beginSetup` and the page that displays it. */
export const SETUP_COOKIE = 'hv_mfa_setup';

/** The recovery codes, between a successful confirm and the page that shows them. */
export const CODES_COOKIE = 'hv_mfa_codes';

/**
 * Scoped to the enrolment pages.
 *
 * Narrow on purpose, exactly as `ACCESS_COOKIE_PATH` is: a sealed secret
 * attached to every request the customer makes for the rest of their visit is
 * a secret with far more chances to leak than it needs.
 */
export const HANDOFF_COOKIE_PATH = '/account/security';

/**
 * How long the browser keeps either of them.
 *
 * Ten minutes is longer than enrolling takes and far shorter than a session.
 * It is a ceiling on the handoff, not a lifetime the customer should rely on:
 * the setup blob also stops working the moment the factor is confirmed, and
 * the codes blob is deleted the moment they acknowledge it.
 */
export const HANDOFF_MAX_AGE_SECONDS = 10 * 60;

export interface PendingSetup {
  /** Base32, exactly as the API issued it. */
  secret: string;
  otpauthUri: string;
}

function box(): SecretBox {
  const { MFA_HANDOFF_KEY } = webServerEnv();
  return new SecretBox(MFA_HANDOFF_KEY, 'web');
}

/**
 * Binds a sealed payload to its purpose and to the session that created it.
 *
 * The session token is already in this request's cookies and never leaves the
 * server. Using it here means a sealed blob is useless in any other browser,
 * and useless after signing out, without the web tier keeping any state of its
 * own to check that against.
 */
async function associatedData(purpose: string): Promise<string> {
  const session = (await cookies()).get('hv_session')?.value ?? '';
  return `${purpose}:${session}`;
}

function overHttps(forwardedProto: string | null, host: string | null): boolean {
  // Behind a TLS-terminating proxy the forwarded scheme is authoritative.
  if (forwardedProto) return forwardedProto.split(',')[0]?.trim().toLowerCase() === 'https';
  // No forwarded scheme: fall back to the host the browser asked for, treating
  // anything that is not a loopback name as a real deployment. NODE_ENV is the
  // wrong signal — `next start` reports production on any machine — and this
  // errs towards setting Secure, so the failure mode is a cookie the browser
  // refuses on a plain-HTTP host rather than one it sends in the clear.
  return host !== null && !/^(localhost|127\.0\.0\.1|\[::1\])(:|$)/.test(host);
}

async function write(name: string, purpose: string, payload: unknown): Promise<void> {
  const [store, incoming] = await Promise.all([cookies(), headers()]);
  const sealed = box().seal(
    Buffer.from(JSON.stringify(payload), 'utf8'),
    await associatedData(purpose),
  );
  store.set(name, sealed.toString('base64url'), {
    httpOnly: true,
    sameSite: 'lax',
    secure: overHttps(incoming.get('x-forwarded-proto'), incoming.get('host')),
    path: HANDOFF_COOKIE_PATH,
    maxAge: HANDOFF_MAX_AGE_SECONDS,
  });
}

async function read<T>(name: string, purpose: string): Promise<T | null> {
  const raw = (await cookies()).get(name)?.value;
  if (!raw) return null;
  try {
    const opened = box().open(Buffer.from(raw, 'base64url'), await associatedData(purpose));
    return JSON.parse(opened.toString('utf8')) as T;
  } catch {
    // Tampered with, sealed under another key, or belonging to another session.
    // All of them mean the same thing to the caller: there is nothing to show.
    return null;
  }
}

export const putPendingSetup = (setup: PendingSetup) => write(SETUP_COOKIE, 'setup', setup);
export const readPendingSetup = () => read<PendingSetup>(SETUP_COOKIE, 'setup');

export const putRecoveryCodes = (recoveryCodes: string[]) =>
  write(CODES_COOKIE, 'codes', recoveryCodes);
export const readRecoveryCodes = () => read<string[]>(CODES_COOKIE, 'codes');

/**
 * Deleting a handoff. Called on every path that ends one, successful or not.
 *
 * `delete` has to repeat the path: a cookie written at `/account/security` is a
 * different cookie from one written at `/`, and clearing the wrong one leaves
 * the real value in the browser while looking like it worked.
 */
export async function clearHandoff(...names: string[]): Promise<void> {
  const store = await cookies();
  for (const name of names) store.delete({ name, path: HANDOFF_COOKIE_PATH });
}
