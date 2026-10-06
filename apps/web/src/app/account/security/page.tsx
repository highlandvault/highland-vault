import type { Metadata } from 'next';
import Link from 'next/link';
import { PageShell } from '@/components/page-shell';
import { errorMessage, requireSession } from '@/lib/session';
import { beginTotpSetup } from './security-actions';

export const metadata: Metadata = { title: 'Security', robots: { index: false } };

// The MFA state is read per request and must never be served from a cache:
// a stale "Off" would offer enrolment to an account that already has a factor.
export const dynamic = 'force-dynamic';

type SearchParams = Promise<{ error?: string; enrolled?: string }>;

/**
 * Two-step verification for the signed-in account (UI-9).
 *
 * The state shown is **the API's**, read from `/auth/me` on every request.
 * `mfaEnabled` means the factor is confirmed; this page never infers it from a
 * cookie, a query string or anything the browser carries.
 *
 * ## Enrolment is optional, and says so
 *
 * Which roles must use MFA is owner decision **O8**, still open, so the API
 * forces enrolment on nobody and neither does this page. It explains what the
 * second factor buys and leaves the choice alone.
 *
 * ## What it deliberately does not offer
 *
 * No way to turn the factor off, replace it, or re-issue recovery codes. Not
 * an oversight and not a thing to work around in the browser: **the API has no
 * route for any of them.** The page says so plainly, because a customer who
 * cannot find the switch deserves to know there is not one rather than hunt
 * for it.
 *
 * It also cannot say how many recovery codes are left, for the same reason —
 * nothing exposes that — so it does not guess.
 */
export default async function SecurityPage({ searchParams }: { searchParams: SearchParams }) {
  const me = await requireSession('/account/security');
  const { error, enrolled } = await searchParams;
  const message = errorMessage(error);
  const on = me.user.mfaEnabled;

  return (
    <PageShell>
      <div className="panel auth-card">
        <nav className="breadcrumbs" aria-label="Breadcrumb">
          <Link href="/account">Account</Link> &rsaquo; <span aria-current="page">Security</span>
        </nav>

        <h1>Two-step verification</h1>

        {/* An error arriving here has already ended whatever attempt produced
            it — a refused start, or a stale attempt the API no longer knows
            about. The live state below is the answer either way. */}
        {message && (
          <p className="notice notice--danger" role="alert" data-testid="security-error">
            {message}
          </p>
        )}

        {enrolled === '1' && !message && (
          <p className="notice notice--success" role="status" data-testid="security-enrolled">
            Two-step verification is on. You will be asked for a code the next time you sign in.
          </p>
        )}

        <dl className="facts" style={{ marginBottom: 20 }}>
          <div>
            <dt>Status</dt>
            {/* The word carries the state, never the colour. */}
            <dd data-testid="mfa-status">{on ? 'On' : 'Off'}</dd>
          </div>
          <div>
            <dt>Account</dt>
            <dd>{me.user.email}</dd>
          </div>
        </dl>

        {on ? (
          <>
            <p data-testid="mfa-on-note">
              Your account asks for a code from your authenticator app when you sign in, and again
              before certain staff actions.
            </p>
            <p className="hint" data-testid="mfa-no-changes">
              Two-step verification cannot be turned off, moved to a new authenticator, or given
              fresh recovery codes from here yet. If you lose both your authenticator and your
              recovery codes, contact support.
            </p>
          </>
        ) : (
          <>
            <p>
              A second step means that knowing your password is not enough to sign in as you. You
              use an authenticator app on your phone, which shows a six-digit code that changes
              every thirty seconds.
            </p>
            <p data-testid="mfa-optional">
              This is <strong>optional</strong> for your account. You can set it up now or leave it.
            </p>
            <p className="hint">
              Setting it up signs out your other devices, because they were signed in before the
              second step existed. You will stay signed in here.
            </p>
            {/*
              A plain form, so this works with scripting off. The action is the
              only caller of the setup route — see `security-actions.ts` for why
              it must never run from a page render.
            */}
            <form action={beginTotpSetup}>
              <button type="submit" className="button button--gold" data-testid="mfa-begin">
                Set up two-step verification
              </button>
            </form>
          </>
        )}

        <p style={{ marginTop: 24 }}>
          <Link className="link-arrow" href="/account">
            Back to your account
          </Link>
        </p>
      </div>
    </PageShell>
  );
}
