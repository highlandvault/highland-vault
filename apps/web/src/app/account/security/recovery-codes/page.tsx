import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { PageShell } from '@/components/page-shell';
import { readRecoveryCodes } from '@/lib/mfa-handoff';
import { requireSession } from '@/lib/session';
import { acknowledgeRecoveryCodes } from '../security-actions';

export const metadata: Metadata = { title: 'Your recovery codes', robots: { index: false } };

// Never cached and never prerendered. These are credentials.
export const dynamic = 'force-dynamic';

/**
 * The recovery codes, once (UI-9).
 *
 * ## "Once" is the API's guarantee, not this page's
 *
 * The codes exist in plaintext only in the response that created them: the API
 * stores SHA-256 hashes, `confirm` refuses to run twice, and there is no route
 * that lists or re-issues them. So nothing here could show them again even if
 * it wanted to. What this page controls is the few minutes in between, and it
 * keeps that as short as the customer allows — acknowledging deletes the
 * handoff, after which this address has nothing to render.
 *
 * ## Why they are worth this much care
 *
 * Each one is a second factor on its own. They are the only way back into an
 * account whose authenticator is gone, and there is no route to re-issue them,
 * so a customer who loses both is locked out. That is why the wording says to
 * save them before continuing rather than after.
 */
export default async function RecoveryCodesPage() {
  await requireSession('/account/security');

  const codes = await readRecoveryCodes();
  // Already acknowledged, expired, or never there. Nothing to show, and
  // nothing to say about what used to be here.
  if (!codes || codes.length === 0) redirect('/account/security');

  return (
    <PageShell>
      <div className="panel auth-card">
        <h1>Save your recovery codes</h1>

        <p className="notice notice--success" role="status" data-testid="codes-enrolled">
          <strong>Two-step verification is on.</strong>
          <span>Your other devices have been signed out.</span>
        </p>

        <p data-testid="codes-explain">
          These {codes.length} codes are your way in if you lose your authenticator app.{' '}
          <strong>Each one works once.</strong> They are shown here and never again, so save them
          somewhere safe — a password manager, or printed and kept away from your phone.
        </p>

        {/* A real ordered list: the order is how a customer tracks which ones
            they have used, and a screen reader announces the count. */}
        <ol className="recovery-codes" data-testid="recovery-codes">
          {codes.map((code) => (
            <li key={code} className="recovery-code" data-testid="recovery-code">
              {code}
            </li>
          ))}
        </ol>

        {/*
          The same codes as plain text, for selecting and copying in one go.
          Read-only and newline-separated — no clipboard button, because that
          would need client JavaScript for something select-all already does.
        */}
        <label className="field" htmlFor="recovery-codes-text">
          {/* The count comes from the response, like the list above: the API
              issues ten today and this page should not be the thing that has
              to be corrected if it ever issues a different number. */}
          <span className="label">All {codes.length}, to copy</span>
          <textarea
            id="recovery-codes-text"
            className="secret-field recovery-codes__text"
            rows={codes.length}
            value={codes.join('\n')}
            readOnly
            spellCheck={false}
            autoComplete="off"
            data-testid="recovery-codes-text"
          />
        </label>

        <p className="hint" data-testid="codes-warning">
          If you lose both your authenticator app and these codes, you will not be able to sign in,
          and this page cannot give you new ones. Save them before you continue.
        </p>

        <form action={acknowledgeRecoveryCodes}>
          <button type="submit" className="button button--gold" data-testid="codes-acknowledge">
            I have saved these codes
          </button>
        </form>
      </div>
    </PageShell>
  );
}
