import Link from 'next/link';
import { errorMessage } from '@/lib/session';
import { login } from '../auth-actions';

type SearchParams = Promise<{ error?: string; next?: string }>;

export default async function LoginPage({ searchParams }: { searchParams: SearchParams }) {
  const { error, next } = await searchParams;
  const message = errorMessage(error);
  return (
    <>
      <h1>Sign in</h1>
      {message && (
        <p role="alert" data-testid="form-error">
          {message}
        </p>
      )}
      <form action={login}>
        <input type="hidden" name="next" value={next ?? '/account'} />
        <p>
          <label>
            Email <input name="email" type="email" autoComplete="email" required />
          </label>
        </p>
        <p>
          <label>
            Password{' '}
            <input name="password" type="password" autoComplete="current-password" required />
          </label>
        </p>
        <button type="submit">Sign in</button>
      </form>
      <p>
        No account? <Link href="/register">Register</Link>
      </p>
    </>
  );
}
