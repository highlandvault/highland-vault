import { errorMessage } from '@/lib/session';
import { register } from '../auth-actions';

type SearchParams = Promise<{ error?: string }>;

export default async function RegisterPage({ searchParams }: { searchParams: SearchParams }) {
  const message = errorMessage((await searchParams).error);
  return (
    <>
      <h1>Create an account</h1>
      <p>One account works in every Highland Vault market.</p>
      {message && (
        <p role="alert" data-testid="form-error">
          {message}
        </p>
      )}
      <form action={register}>
        <p>
          <label>
            Email <input name="email" type="email" autoComplete="email" required />
          </label>
        </p>
        <p>
          <label>
            Password (at least 12 characters){' '}
            <input
              name="password"
              type="password"
              autoComplete="new-password"
              minLength={12}
              required
            />
          </label>
        </p>
        <button type="submit">Create account</button>
      </form>
    </>
  );
}
