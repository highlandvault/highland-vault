import Link from 'next/link';
import { PageShell } from '@/components/page-shell';
import { hasPermission, requireSession } from '@/lib/session';
import { logout } from '../auth-actions';

export default async function AccountPage() {
  const me = await requireSession('/account');
  return (
    <PageShell>
      <div className="panel auth-card">
        <h1>Account</h1>
        <p data-testid="account-email">{me.user.email}</p>
        <dl className="facts" style={{ marginBottom: 20 }}>
          <div>
            <dt>Email verified</dt>
            <dd>{me.user.emailVerified ? 'Yes' : 'Not yet'}</dd>
          </div>
          <div>
            <dt>Two-step verification</dt>
            <dd>{me.user.mfaEnabled ? 'On' : 'Off'}</dd>
          </div>
          <div>
            <dt>Roles</dt>
            <dd>
              {me.roles.map((r) => (r.market ? `${r.role} (${r.market})` : r.role)).join(', ')}
            </dd>
          </div>
        </dl>
        {hasPermission(me, 'admin.access') && (
          <p>
            <Link className="link-arrow" href="/admin">
              Admin →
            </Link>
          </p>
        )}
        <form action={logout}>
          <button type="submit" className="button button--outline">
            Sign out
          </button>
        </form>
      </div>
    </PageShell>
  );
}
