import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { PageShell } from '@/components/page-shell';
import { readPendingSetup } from '@/lib/mfa-handoff';
import { errorMessage, requireSession } from '@/lib/session';
import { confirmTotpSetup } from '../security-actions';

export const metadata: Metadata = {
  title: 'Set up two-step verification',
  robots: { index: false },
};

// Never cached, never prerendered: this page renders a secret, and it renders a
// different one for every attempt.
export const dynamic = 'force-dynamic';

type SearchParams = Promise<{ error?: string }>;

/**
 * The pending secret, and the form that confirms it (UI-9).
 *
 * ## This page does not start enrolment
 *
 * It reads the handoff the Server Action left and renders it. It **cannot**
 * call `POST /auth/mfa/totp/setup`: that would mint a new secret on every
 * render, so a refresh — or a wrong code — would silently replace the one the
 * customer had already scanned. (It could not call it in any case: a POST
 * during a plain navigation carries no `Origin`, and the API refuses
 * state-changing requests without one.)
 *
 * No handoff means there is nothing to show, so it goes back to the overview
 * rather than inventing an attempt.
 *
 * ## No QR code
 *
 * Out of scope for this slice, deliberately: the web app has five runtime
 * dependencies and none of them can draw one, so a QR would mean adding a
 * dependency. Every mainstream authenticator accepts a typed key, and the
 * `otpauth://` URI is shown in full for anyone whose app or password manager
 * can take it directly.
 */
export default async function TotpSetupPage({ searchParams }: { searchParams: SearchParams }) {
  // Enrolment is an account action: no session, no page. Checked before the
  // handoff, so a signed-out visitor is sent to sign in rather than told
  // whether an attempt exists.
  await requireSession('/account/security/setup');

  const pending = await readPendingSetup();
  // Nothing pending — expired, acknowledged, from another browser, or the page
  // was opened directly. All the same answer: start from the overview.
  if (!pending) redirect('/account/security');

  const { error } = await searchParams;
  // Two codes get wording of their own here, because the shared map is written
  // for the SIGN-IN step: that one also accepts a recovery code, so it cannot
  // say "the six-digit code from your authenticator" — and on this page that is
  // the only thing that works.
  const message = error ? (SETUP_MESSAGES[error] ?? errorMessage(error)) : null;

  return (
    <PageShell>
      <div className="panel auth-card">
        <nav className="breadcrumbs" aria-label="Breadcrumb">
          <Link href="/account">Account</Link> &rsaquo;{' '}
          <Link href="/account/security">Security</Link> &rsaquo;{' '}
          <span aria-current="page">Set up</span>
        </nav>

        <h1>Set up two-step verification</h1>

        <ol className="setup-steps">
          <li>Open your authenticator app and add a new account.</li>
          <li>Enter the key below, or open the setup link if your app accepts one.</li>
          <li>Type the six-digit code it shows, to prove it is working.</li>
        </ol>

        <h2 className="eyebrow">Your setup key</h2>
        {/*
          `tabIndex` and `readOnly`, not a plain block: the key has to be
          selectable and reachable by keyboard for anyone who cannot drag a
          mouse across thirty-two characters. It is an input so that select-all
          works, and read-only because there is nothing here to edit.

          The value is the EXACT base32 the API issued. The spaced copy beside
          it is for reading aloud and typing; only this field is the key.
        */}
        <label className="field" htmlFor="totp-secret">
          <span className="label">Key, for manual entry</span>
          <input
            id="totp-secret"
            className="secret-field"
            value={pending.secret}
            readOnly
            tabIndex={0}
            spellCheck={false}
            autoComplete="off"
            data-testid="totp-secret"
            aria-describedby="totp-secret-help"
          />
        </label>
        <p className="hint" id="totp-secret-help">
          Easier to read in groups:{' '}
          <span className="secret-grouped" data-testid="totp-secret-grouped">
            {group(pending.secret)}
          </span>
          . Spaces and lower case do not matter when you type it in.
        </p>

        <h2 className="eyebrow">Or use the setup link</h2>
        <p className="hint">
          Some apps and password managers take this directly. It contains your key, so treat it like
          a password.
        </p>
        <p className="secret-uri" data-testid="totp-otpauth-uri">
          {pending.otpauthUri}
        </p>

        <hr className="setup-rule" />

        <h2>Confirm the code</h2>
        {message && (
          <p
            className="notice notice--danger"
            role="alert"
            id="totp-code-error"
            data-testid="setup-error"
          >
            {message}
          </p>
        )}
        <form action={confirmTotpSetup} className="form">
          <div className="field">
            <label htmlFor="code">Six-digit code from your authenticator app</label>
            <input
              id="code"
              name="code"
              // The server validates and is the authority; these only help the
              // browser offer the right keyboard and the right autofill.
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              maxLength={6}
              required
              autoFocus
              aria-describedby={message ? 'totp-code-error totp-code-help' : 'totp-code-help'}
              data-testid="totp-code"
            />
            <p className="hint" id="totp-code-help">
              The code changes every thirty seconds. If it is about to change, wait for the next
              one.
            </p>
          </div>
          <button type="submit" className="button button--gold" data-testid="totp-confirm">
            Turn on two-step verification
          </button>
        </form>

        <p style={{ marginTop: 20 }}>
          <Link className="link-arrow" href="/account/security">
            Cancel and go back
          </Link>
        </p>
      </div>
    </PageShell>
  );
}

/**
 * What this page says for the two refusals it can actually meet.
 *
 * The rate limit is five confirmations per quarter-hour per account and is
 * **shared with the step-up check**, so a customer who exhausts it here is also
 * briefly unable to confirm a sensitive action. Worth saying how long, and
 * worth not pretending the wait is shorter than it is.
 */
const SETUP_MESSAGES: Record<string, string> = {
  INVALID_MFA_CODE:
    'That code is invalid or has already been used. Enter the current 6-digit code from your authenticator.',
  RATE_LIMITED:
    'Too many attempts. You can try five codes every fifteen minutes — wait for the limit to pass, then enter the code showing then. Your setup key below is still valid.',
};

/** Four-character groups, for reading and typing. Never for submitting. */
function group(secret: string): string {
  return secret.match(/.{1,4}/g)?.join(' ') ?? secret;
}
