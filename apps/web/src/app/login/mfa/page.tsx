import { PageShell } from '@/components/page-shell';
import { errorMessage } from '@/lib/session';
import { verifyMfa } from '../../auth-actions';

type SearchParams = Promise<{ error?: string; next?: string }>;

export default async function MfaPage({ searchParams }: { searchParams: SearchParams }) {
  const { error, next } = await searchParams;
  const message = errorMessage(error);
  return (
    <PageShell>
      <div className="panel auth-card">
        <h1>Two-step verification</h1>
        {message && (
          <p className="notice notice--danger" role="alert" data-testid="form-error">
            {message}
          </p>
        )}
        <form action={verifyMfa} className="form">
          <input type="hidden" name="next" value={next ?? '/account'} />
          <div className="field">
            <label htmlFor="code">Code from your authenticator app, or a recovery code</label>
            <input id="code" name="code" autoComplete="one-time-code" required />
          </div>
          <button type="submit" className="button button--gold">
            Verify
          </button>
        </form>
      </div>
    </PageShell>
  );
}
