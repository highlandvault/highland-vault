'use server';

import { TotpConfirmResponseSchema, TotpSetupResponseSchema } from '@hv/contracts';
import { redirect } from 'next/navigation';
import { apiFetch } from '@/lib/api';
import {
  CODES_COOKIE,
  SETUP_COOKIE,
  clearHandoff,
  putPendingSetup,
  putRecoveryCodes,
} from '@/lib/mfa-handoff';

/**
 * Enrolling a second factor (UI-9).
 *
 * Three actions for three steps, and **they are the only things that call the
 * MFA routes.** No page renders a POST: `setup` mints a fresh secret every
 * time it is called and nulls the replay counter, so a page that called it
 * during render would hand the customer a new secret on every refresh and
 * invalidate the one they had just typed into their authenticator. It runs
 * from a button press, once, and nowhere else.
 *
 * The API is unchanged by this slice. Enrolment stays **optional for every
 * role** — which roles must use MFA is owner decision O8 and is still open, so
 * nothing here requires or implies it.
 */

const SECURITY = '/account/security';
const SETUP = '/account/security/setup';
const CODES = '/account/security/recovery-codes';

/**
 * Starts enrolment: asks the API for a secret and hands it to the setup page.
 *
 * `MFA_ALREADY_ENABLED` is not an error to show on the setup page, because
 * there will be no setup page — the factor exists, so there is nothing to
 * enrol. It goes back to the overview, which reads the live state from
 * `/auth/me` and will now say "On".
 */
export async function beginTotpSetup(): Promise<void> {
  const result = await apiFetch('/auth/mfa/totp/setup', {
    method: 'POST',
    parse: (json) => TotpSetupResponseSchema.parse(json),
  });
  if (!result.ok) {
    // Nothing pending survives a refused start.
    await clearHandoff(SETUP_COOKIE, CODES_COOKIE);
    redirect(`${SECURITY}?error=${result.code}`);
  }
  await putPendingSetup(result.data);
  redirect(SETUP);
}

/**
 * Confirms it with the first code from the authenticator.
 *
 * **A wrong code keeps the handoff.** That is the whole reason the secret is
 * carried at all: the customer's authenticator already holds it, the API's
 * pending row still holds it, and re-running setup to redraw the page would
 * replace both. So a refusal returns to the same page, with the same secret,
 * and only an error code in the URL.
 *
 * The two conflict codes mean the pending row is gone, in opposite directions
 * — already confirmed, or never created — and both make the handoff stale, so
 * both clear it and return to the overview rather than offering a retry
 * against a secret the API no longer has.
 */
export async function confirmTotpSetup(form: FormData): Promise<void> {
  const value = form.get('code');
  const code = (typeof value === 'string' ? value : '').trim();

  // The API validates this too and is the authority; checking here only saves
  // a round trip and spends none of the five attempts a quarter-hour allows.
  if (!/^\d{6}$/.test(code)) redirect(`${SETUP}?error=INVALID_MFA_CODE`);

  const result = await apiFetch('/auth/mfa/totp/confirm', {
    method: 'POST',
    body: { code },
    parse: (json) => TotpConfirmResponseSchema.parse(json),
  });
  if (!result.ok) {
    if (result.code === 'MFA_ALREADY_ENABLED' || result.code === 'MFA_NOT_ENROLLED') {
      await clearHandoff(SETUP_COOKIE, CODES_COOKIE);
      redirect(`${SECURITY}?error=${result.code}`);
    }
    // INVALID_MFA_CODE, RATE_LIMITED, or anything else: the secret is still
    // good and still theirs to retry with.
    redirect(`${SETUP}?error=${result.code}`);
  }

  // Enrolled. The secret has done its job and must not outlive it by a second;
  // the codes take its place.
  await clearHandoff(SETUP_COOKIE);
  await putRecoveryCodes(result.data.recoveryCodes);
  redirect(CODES);
}

/**
 * "I have saved these codes."
 *
 * Deleting the cookie is the whole action. The codes are not stored anywhere
 * else in the web tier and the API keeps only their hashes, so once this runs
 * the page has nothing to render and says so — which is what "shown once"
 * means here.
 */
export async function acknowledgeRecoveryCodes(): Promise<void> {
  await clearHandoff(CODES_COOKIE, SETUP_COOKIE);
  redirect(`${SECURITY}?enrolled=1`);
}
