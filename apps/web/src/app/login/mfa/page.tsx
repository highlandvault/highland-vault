import { errorMessage } from '@/lib/session';
import { verifyMfa } from '../../auth-actions';

type SearchParams = Promise<{ error?: string; next?: string }>;

export default async function MfaPage({ searchParams }: { searchParams: SearchParams }) {
  const { error, next } = await searchParams;
  const message = errorMessage(error);
  return (
    <>
      <h1>Two-step verification</h1>
      {message && (
        <p role="alert" data-testid="form-error">
          {message}
        </p>
      )}
      <form action={verifyMfa}>
        <input type="hidden" name="next" value={next ?? '/account'} />
        <p>
          <label>
            Code from your authenticator app, or a recovery code{' '}
            <input name="code" autoComplete="one-time-code" required />
          </label>
        </p>
        <button type="submit">Verify</button>
      </form>
    </>
  );
}
