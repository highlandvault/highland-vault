import Link from 'next/link';
import { PageShell } from '@/components/page-shell';
import { errorMessage } from '@/lib/session';
import { login } from '../auth-actions';

type SearchParams = Promise<{ error?: string; next?: string }>;

export default async function LoginPage({ searchParams }: { searchParams: SearchParams }) {
  const { error, next } = await searchParams;
  const message = errorMessage(error);
  return (
    <PageShell>
      <div className="panel auth-card">
        <h1>Sign in</h1>
        {message && (
          <p className="notice notice--danger" role="alert" data-testid="form-error">
            {message}
          </p>
        )}
        <form action={login} className="form">
          <input type="hidden" name="next" value={next ?? '/account'} />
          <div className="field">
            <label htmlFor="email">Email</label>
            <input id="email" name="email" type="email" autoComplete="email" required />
          </div>
          <div className="field">
            <label htmlFor="password">Password</label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
            />
          </div>
          <button type="submit" className="button button--gold">
            Sign in
          </button>
        </form>
        <p className="hint" style={{ marginTop: 16 }}>
          No account? <Link href="/register">Register</Link>
        </p>
      </div>
    </PageShell>
  );
}
