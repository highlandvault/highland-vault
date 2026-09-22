import { PageShell } from '@/components/page-shell';
import { errorMessage } from '@/lib/session';
import { register } from '../auth-actions';

type SearchParams = Promise<{ error?: string }>;

export default async function RegisterPage({ searchParams }: { searchParams: SearchParams }) {
  const message = errorMessage((await searchParams).error);
  return (
    <PageShell>
      <div className="panel auth-card">
        <h1>Create an account</h1>
        <p className="hint">One account works in every Highland Vault market.</p>
        {message && (
          <p className="notice notice--danger" role="alert" data-testid="form-error">
            {message}
          </p>
        )}
        <form action={register} className="form">
          <div className="field">
            <label htmlFor="email">Email</label>
            <input id="email" name="email" type="email" autoComplete="email" required />
          </div>
          <div className="field">
            <label htmlFor="password">Password (at least 12 characters)</label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="new-password"
              minLength={12}
              required
            />
          </div>
          <button type="submit" className="button button--gold">
            Create account
          </button>
        </form>
      </div>
    </PageShell>
  );
}
