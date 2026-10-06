'use server';

import { AdminMarketResponseSchema, MeResponseSchema } from '@hv/contracts';
import { isMarketCode } from '@hv/domain';
import { redirect } from 'next/navigation';
import { type ApiResult, apiFetch } from '@/lib/api';

/**
 * Market gate operations (UI-10).
 *
 * Four actions over four routes that already existed. They translate a form
 * into an API call and nothing more: every rule — who may do it, whether a
 * second factor is fresh enough, whether the market's compliance settings are
 * complete, what gets written to the audit log — belongs to the API and is
 * re-checked there on every call (ADR-0009). Hiding a button is a courtesy to
 * the operator, never a boundary.
 *
 * ## Step-up is a redirect, never a replay
 *
 * A sensitive route answers `STEP_UP_REQUIRED` when the session has no second
 * factor verified inside the last fifteen minutes. These actions send the
 * operator to get one and **stop there**. The mutation is not retried, not
 * queued and not remembered: they come back to the market page and submit
 * again if they still mean it.
 *
 * That is deliberate. Replaying a POST after a verification step would mean a
 * market could be enabled by someone who typed a code for a reason they had
 * since changed their mind about, and it would make the audit row's reason a
 * record of an intention rather than of an act.
 *
 * ## The continuation is derived, never accepted
 *
 * The address we send them back to is built here from the market code this
 * action already validated, so there is no return URL to tamper with. Nothing
 * from the query string reaches a `redirect`.
 */

const MARKETS = '/admin/markets';

/** The market segment, validated before it is used to build any path. */
function marketOrFail(value: string): string {
  if (!isMarketCode(value)) redirect(MARKETS);
  return value;
}

function field(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

/** Back to the market page with a message, never with a secret or a payload. */
function back(market: string, params: Record<string, string>): never {
  const query = new URLSearchParams(params).toString();
  redirect(`${MARKETS}/${market}${query ? `?${query}` : ''}`);
}

/**
 * One place that decides what a refusal means, so four actions cannot drift.
 *
 * `STEP_UP_REQUIRED` is the only code that moves the operator anywhere, and
 * where it moves them depends on something only `/auth/me` knows.
 *
 * **Enrolled, but the fifteen minutes have lapsed** — they need to prove the
 * factor again, so they go to the existing verification page with a `next`
 * this server built. That page and its action are reused exactly as the
 * sign-in step uses them; no second TOTP implementation exists here.
 *
 * **Not enrolled at all** — a verification form would be a dead end, because
 * they have nothing to verify with. They come back to the market page instead,
 * which explains the situation and links to the enrolment surface. The
 * explanation lives there rather than on the security page: that page is UI-9's
 * and says nothing about markets, and an operator who lands on it cold has no
 * idea why.
 *
 * Everything else comes back to the page it came from, as a message beside the
 * form that produced it.
 */
async function refused(
  market: string,
  action: string,
  result: Extract<ApiResult<unknown>, { ok: false }>,
): Promise<never> {
  if (result.code === 'STEP_UP_REQUIRED') {
    const me = await apiFetch('/auth/me', { parse: (json) => MeResponseSchema.parse(json) });
    if (me.ok && me.data.user.mfaEnabled) {
      // Built here from a validated market code, so there is no return URL to
      // tamper with; `safeNext` in the auth actions refuses anything that is
      // not same-site in any case.
      const next = encodeURIComponent(`${MARKETS}/${market}?stepped=${action}`);
      redirect(`/login/mfa?next=${next}`);
    }
    back(market, { error: 'STEP_UP_REQUIRED', enrol: '1', form: action });
  }
  const missing = (result.details as { missingSettings?: string[] } | undefined)?.missingSettings;
  back(market, {
    error: result.code,
    ...(missing?.length ? { missing: missing.join(',') } : {}),
    form: action,
  });
}

/** PUT /admin/markets/:market/settings — the O12 compliance values, as typed. */
export async function updateMarketSettings(code: string, form: FormData): Promise<void> {
  const market = marketOrFail(code);
  const reason = field(form, 'reason');
  const age = field(form, 'minAge');
  const exclusion = field(form, 'selfExclusionRequired');

  /*
   * Null is a real value here, not a missing one.
   *
   * The contract takes `number | null` and `boolean | null`, and null is how a
   * setting goes back to unset — which is a thing an operator may legitimately
   * need to do. So an empty age field means null, and the select has an
   * explicit "not set" option rather than a blank that could be a mistake.
   *
   * **No compliance value is defaulted or suggested anywhere.** What the right
   * minimum age is, and whether self-exclusion is required, is owner decision
   * O12 and is still open; this form carries whatever the operator types.
   */
  const minAge = age === '' ? null : Number(age);
  if (minAge !== null && !Number.isInteger(minAge)) {
    back(market, { error: 'VALIDATION_FAILED', field: 'minAge', form: 'settings' });
  }
  const selfExclusionRequired =
    exclusion === '' ? null : exclusion === 'true' ? true : exclusion === 'false' ? false : null;

  const result = await apiFetch(`/admin/markets/${market}/settings`, {
    method: 'PUT',
    body: { minAge, selfExclusionRequired, reason },
    parse: (json) => AdminMarketResponseSchema.parse(json).market,
  });
  if (!result.ok) await refused(market, 'settings', result);
  back(market, { saved: 'settings' });
}

/** POST /admin/markets/:market/legal-approval — a reference to an approval held elsewhere. */
export async function recordLegalApproval(code: string, form: FormData): Promise<void> {
  const market = marketOrFail(code);
  /*
   * A reference, not a document.
   *
   * The contract has one string and no content field, and that is the whole
   * model: the approval itself lives with whoever gave it, and this records
   * that it exists and where to find it. Nothing here invents legal wording,
   * and there is no place to put any.
   */
  const result = await apiFetch(`/admin/markets/${market}/legal-approval`, {
    method: 'POST',
    body: { reference: field(form, 'reference'), reason: field(form, 'reason') },
    parse: (json) => AdminMarketResponseSchema.parse(json).market,
  });
  if (!result.ok) await refused(market, 'legal', result);
  back(market, { saved: 'legal' });
}

/**
 * POST /admin/markets/:market/enable — opening a market to the public.
 *
 * The confirmation is a typed acknowledgement rather than a second button,
 * because this is the one operation here that changes what the outside world
 * can see. The API refuses it anyway when compliance settings are missing or a
 * required legal approval is not recorded, and that refusal — not this form —
 * is what actually protects the gate.
 */
export async function enableMarket(code: string, form: FormData): Promise<void> {
  const market = marketOrFail(code);
  if (field(form, 'confirm').toUpperCase() !== market.toUpperCase()) {
    back(market, { error: 'CONFIRM_MISMATCH', form: 'enable' });
  }
  const result = await apiFetch(`/admin/markets/${market}/enable`, {
    method: 'POST',
    body: { reason: field(form, 'reason') },
    parse: (json) => AdminMarketResponseSchema.parse(json).market,
  });
  if (!result.ok) await refused(market, 'enable', result);
  back(market, { saved: 'enable' });
}

/** POST /admin/markets/:market/disable — closing it again. Also confirmed, also audited. */
export async function disableMarket(code: string, form: FormData): Promise<void> {
  const market = marketOrFail(code);
  if (field(form, 'confirm').toUpperCase() !== market.toUpperCase()) {
    back(market, { error: 'CONFIRM_MISMATCH', form: 'disable' });
  }
  const result = await apiFetch(`/admin/markets/${market}/disable`, {
    method: 'POST',
    body: { reason: field(form, 'reason') },
    parse: (json) => AdminMarketResponseSchema.parse(json).market,
  });
  if (!result.ok) await refused(market, 'disable', result);
  back(market, { saved: 'disable' });
}
