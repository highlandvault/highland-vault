import Link from 'next/link';
import { hasPermission, requireSession } from '@/lib/session';
import { logout } from '../auth-actions';

export default async function AccountPage() {
  const me = await requireSession('/account');
  return (
    <>
      <h1>Account</h1>
      <p data-testid="account-email">{me.user.email}</p>
      <ul>
        <li>Email verified: {me.user.emailVerified ? 'yes' : 'not yet'}</li>
        <li>Two-step verification: {me.user.mfaEnabled ? 'on' : 'off'}</li>
        <li>
          Roles: {me.roles.map((r) => (r.market ? `${r.role} (${r.market})` : r.role)).join(', ')}
        </li>
      </ul>
      {hasPermission(me, 'admin.access') && (
        <p>
          <Link href="/admin">Admin</Link>
        </p>
      )}
      <form action={logout}>
        <button type="submit">Sign out</button>
      </form>
    </>
  );
}
