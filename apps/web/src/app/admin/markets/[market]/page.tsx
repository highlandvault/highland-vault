import { AdminMarketListResponseSchema, type AdminMarket } from '@hv/contracts';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { apiFetch } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { requireSession } from '@/lib/session';
import { canInMarket } from '../../draws/permissions';
import { disableMarket, enableMarket, recordLegalApproval, updateMarketSettings } from '../actions';

// Never cached: this page decides which controls an operator is shown, from
// state the API re-checks on every call anyway.
export const dynamic = 'force-dynamic';

type Params = Promise<{ market: string }>;
type SearchParams = Promise<{
  error?: string;
  saved?: string;
  form?: string;
  missing?: string;
  field?: string;
  enrol?: string;
  stepped?: string;
}>;

/**
 * One market's gate, and the four operations on it (UI-10).
 *
 * ## Where the state comes from
 *
 * `GET /admin/markets` and then a filter, because **there is no single-market
 * admin route** and this slice adds no API. One list is a small read and it is
 * the same shape every mutation returns, so nothing here can disagree with
 * what the API would say next.
 *
 * ## What this page decides, and what it does not
 *
 * It decides what to *show*. `markets.gate.manage` is checked here so an
 * operator who cannot change a gate is not offered forms that would only be
 * refused — but the API checks it again on every call and is the security
 * boundary (ADR-0009). Hiding a form protects nobody; it just stops wasting
 * somebody's time.
 *
 * **The backend is authoritative about readiness too.** `missingSettings` and
 * `legalApproval` are printed exactly as given, and the enable form is offered
 * whatever they say — the API refuses an unready market with
 * `COMPLIANCE_SETTINGS_MISSING` or `LEGAL_APPROVAL_REQUIRED`, and that refusal
 * is the real gate. This page never computes its own verdict on whether a
 * market is launch-ready, because then there would be two.
 *
 * ## O12
 *
 * The compliance values are open owner decisions. Nothing here defaults,
 * suggests or validates them beyond the contract's own bounds: the form shows
 * what is set, says plainly what is not, and carries whatever is typed.
 */
export default async function AdminMarketPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: SearchParams;
}) {
  const { market: code } = await params;
  const me = await requireSession(`/admin/markets/${code}`);
  const query = await searchParams;

  const result = await apiFetch('/admin/markets', {
    parse: (json) => AdminMarketListResponseSchema.parse(json).markets,
  });
  if (!result.ok) {
    return (
      <>
        <h1>Market</h1>
        <p className="notice notice--danger" role="alert" data-testid="market-error">
          {result.status === 403
            ? 'You do not have access to market administration.'
            : `Market state unavailable (${result.code}).`}
        </p>
      </>
    );
  }
  const market = result.data.find((m) => m.code === code);
  // An unknown market code is a 404, the same answer the API gives.
  if (!market) notFound();

  const mayManage = canInMarket(me, 'markets.gate.manage', market.code);
  const message = errorFor(query, market);
  const saved = SAVED[query.saved ?? ''] ?? null;
  const when = (iso: string) => formatDateTime(iso, market.locale, market.code);

  return (
    <>
      <nav className="breadcrumbs" aria-label="Breadcrumb">
        <Link href="/admin/markets">Markets</Link> &rsaquo;{' '}
        <span aria-current="page">{market.name}</span>
      </nav>

      <h1>
        {market.name} ({market.code})
      </h1>

      {message && (
        <p className="notice notice--danger" role="alert" data-testid="market-op-error">
          {message}
          {query.enrol === '1' && (
            <>
              {' '}
              <Link href="/account/security" data-testid="market-stepup-enrol">
                Set up two-step verification
              </Link>
              , then come back to this page and submit again.
            </>
          )}
        </p>
      )}

      {saved && !message && (
        <p className="notice notice--success" role="status" data-testid="market-op-saved">
          {saved}
        </p>
      )}

      {query.stepped && !message && (
        <p className="notice notice--info" role="status" data-testid="market-stepped">
          Your second factor is verified. Submit the operation again to carry it out — nothing was
          changed while you were away.
        </p>
      )}

      {/* ---------------------------------------------------------- state */}
      <section className="panel" aria-labelledby="state-heading">
        <h2 id="state-heading">Current state</h2>
        <dl className="facts">
          <div>
            <dt>Gate</dt>
            <dd data-testid="state-gate">{market.isEnabled ? 'enabled' : 'disabled'}</dd>
          </div>
          <div>
            <dt>Allowed by this deployment</dt>
            <dd>{market.environmentAllowed ? 'yes' : 'no'}</dd>
          </div>
          <div>
            <dt>Available to customers</dt>
            <dd data-testid="state-available">{market.available ? 'yes' : 'no'}</dd>
          </div>
          <div>
            <dt>Currency</dt>
            <dd>
              {market.currency} &middot; {market.locale}
            </dd>
          </div>
          <div>
            <dt>Minimum age</dt>
            <dd data-testid="state-min-age">{market.settings.minAge ?? <em>not set</em>}</dd>
          </div>
          <div>
            <dt>Self-exclusion required</dt>
            <dd data-testid="state-self-exclusion">
              {market.settings.selfExclusionRequired === null ? (
                <em>not set</em>
              ) : market.settings.selfExclusionRequired ? (
                'yes'
              ) : (
                'no'
              )}
            </dd>
          </div>
        </dl>

        <p className="hint" data-testid="state-missing">
          {market.missingSettings.length
            ? `Required settings still unset: ${market.missingSettings.join(', ')}. The API refuses to enable this market until they are set.`
            : 'All required compliance settings are set.'}
        </p>
        <p className="hint" data-testid="state-legal">
          {market.requiresLegalApproval
            ? market.legalApproval
              ? `Legal approval recorded ${when(market.legalApproval.approvedAt)}, reference ${market.legalApproval.reference}.`
              : 'Legal approval is required for this market and is not recorded.'
            : 'This market does not require a recorded legal approval.'}
        </p>
      </section>

      {!mayManage ? (
        <p className="notice notice--info" data-testid="market-read-only">
          You can see this market&apos;s state but not change it. Gate changes need the{' '}
          <code>markets.gate.manage</code> permission.
        </p>
      ) : (
        <>
          {/* ------------------------------------------------- settings */}
          <section className="panel" aria-labelledby="settings-heading">
            <h2 id="settings-heading">Compliance settings</h2>
            <p className="hint">
              These are entered by staff and never defaulted. Leave a field as &ldquo;not set&rdquo;
              to clear it.
            </p>
            <form action={updateMarketSettings.bind(null, market.code)} className="form">
              <div className="field">
                <label htmlFor="minAge">Minimum age (1–99, or blank for not set)</label>
                <input
                  id="minAge"
                  name="minAge"
                  type="number"
                  min={1}
                  max={99}
                  step={1}
                  inputMode="numeric"
                  defaultValue={market.settings.minAge ?? ''}
                  aria-describedby="minAge-help"
                  data-testid="settings-min-age"
                />
                <p className="hint" id="minAge-help">
                  Currently {market.settings.minAge ?? 'not set'}.
                </p>
              </div>
              <div className="field">
                <label htmlFor="selfExclusionRequired">Self-exclusion required</label>
                <select
                  id="selfExclusionRequired"
                  name="selfExclusionRequired"
                  defaultValue={
                    market.settings.selfExclusionRequired === null
                      ? ''
                      : String(market.settings.selfExclusionRequired)
                  }
                  data-testid="settings-self-exclusion"
                >
                  <option value="">not set</option>
                  <option value="true">yes</option>
                  <option value="false">no</option>
                </select>
              </div>
              <ReasonField id="settings-reason" testId="settings-reason" />
              <button type="submit" className="button button--gold" data-testid="settings-submit">
                Save settings
              </button>
            </form>
          </section>

          {/* -------------------------------------------- legal approval */}
          {market.requiresLegalApproval && !market.legalApproval && (
            <section className="panel" aria-labelledby="legal-heading">
              <h2 id="legal-heading">Record legal approval</h2>
              <p className="hint">
                A reference to the approval held elsewhere — a ticket, a document id, a sign-off
                record. No legal wording is stored here.
              </p>
              <form action={recordLegalApproval.bind(null, market.code)} className="form">
                <div className="field">
                  <label htmlFor="reference">Approval reference</label>
                  <input
                    id="reference"
                    name="reference"
                    required
                    maxLength={200}
                    data-testid="legal-reference"
                  />
                </div>
                <ReasonField id="legal-reason" testId="legal-reason" />
                <button type="submit" className="button button--gold" data-testid="legal-submit">
                  Record approval
                </button>
              </form>
            </section>
          )}

          {/* ------------------------------------------------ the gate */}
          <section className="panel" aria-labelledby="gate-heading">
            <h2 id="gate-heading">
              {market.isEnabled ? 'Disable this market' : 'Enable this market'}
            </h2>
            {market.isEnabled ? (
              <p data-testid="gate-explain">
                Disabling stops new customers reaching {market.name}. Existing orders and holds are
                not touched by this.
              </p>
            ) : (
              <p data-testid="gate-explain">
                Enabling makes {market.name} available to customers, provided this deployment also
                lists it in <code>ENABLED_MARKETS</code>. Draws, baskets and checkout open to the
                public.
              </p>
            )}
            {/* Typed confirmation, not a second button: this is the one
                operation here that changes what the outside world sees. */}
            <form
              action={
                market.isEnabled
                  ? disableMarket.bind(null, market.code)
                  : enableMarket.bind(null, market.code)
              }
              className="form"
            >
              <div className="field">
                <label htmlFor="confirm">
                  Type <strong>{market.code.toUpperCase()}</strong> to confirm
                </label>
                <input
                  id="confirm"
                  name="confirm"
                  required
                  autoComplete="off"
                  aria-describedby="confirm-help"
                  data-testid="gate-confirm"
                />
                <p className="hint" id="confirm-help">
                  So this cannot be done by one stray click.
                </p>
              </div>
              <ReasonField id="gate-reason" testId="gate-reason" />
              <button
                type="submit"
                className={`button ${market.isEnabled ? 'button--danger' : 'button--gold'}`}
                data-testid="gate-submit"
              >
                {market.isEnabled
                  ? `Disable ${market.code.toUpperCase()}`
                  : `Enable ${market.code.toUpperCase()}`}
              </button>
            </form>
          </section>
        </>
      )}
    </>
  );
}

/** Every sensitive operation carries a reason, which the API stores in the audit row. */
function ReasonField({ id, testId }: { id: string; testId: string }) {
  return (
    <div className="field">
      <label htmlFor={id}>Reason (recorded in the audit log)</label>
      <input
        id={id}
        name="reason"
        required
        minLength={3}
        maxLength={500}
        aria-describedby={`${id}-help`}
        data-testid={testId}
      />
      <p className="hint" id={`${id}-help`}>
        At least 3 characters. Say why, for whoever reads the audit log later.
      </p>
    </div>
  );
}

const SAVED: Record<string, string> = {
  settings: 'Compliance settings saved.',
  legal: 'Legal approval recorded.',
  enable: 'Market enabled.',
  disable: 'Market disabled.',
};

/**
 * A sentence for every refusal this page can actually produce.
 *
 * Only codes the API really returns, plus the two this page raises itself. No
 * raw code, no JSON and no stack trace reaches an operator — but the code is
 * appended for anything unrecognised, because an operator reporting a problem
 * needs something to quote.
 */
function errorFor(
  query: { error?: string; missing?: string; field?: string },
  market: AdminMarket,
): string | null {
  const code = query.error;
  if (!code) return null;
  switch (code) {
    case 'STEP_UP_REQUIRED':
      return 'This operation needs a second factor verified in the last fifteen minutes.';
    case 'CONFIRM_MISMATCH':
      return `The confirmation did not match. Type ${market.code.toUpperCase()} exactly.`;
    case 'VALIDATION_FAILED':
      return query.field === 'minAge'
        ? 'The minimum age must be a whole number between 1 and 99, or blank.'
        : 'Check the values: a reason of at least 3 characters is required.';
    case 'COMPLIANCE_SETTINGS_MISSING':
      return `This market cannot be enabled until its required settings are set${
        query.missing ? `: ${query.missing.split(',').join(', ')}` : ''
      }.`;
    case 'LEGAL_APPROVAL_REQUIRED':
      return 'This market cannot be enabled until a legal approval is recorded.';
    case 'LEGAL_APPROVAL_ALREADY_RECORDED':
      return 'Legal approval is already recorded for this market.';
    case 'LEGAL_APPROVAL_NOT_APPLICABLE':
      return 'This market does not require a recorded legal approval.';
    case 'FORBIDDEN':
      return 'You do not have permission to change this market.';
    case 'RATE_LIMITED':
      return 'Too many attempts. Wait a little and try again.';
    case 'UNAUTHENTICATED':
      return 'Your session has ended. Sign in and try again.';
    case 'UNREACHABLE':
      return 'The service is unavailable. Try again shortly.';
    default:
      return `The operation was refused (${code}).`;
  }
}
