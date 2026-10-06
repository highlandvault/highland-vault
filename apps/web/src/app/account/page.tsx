import Link from 'next/link';
import { PageShell } from '@/components/page-shell';
import { hasPermission, requireSession } from '@/lib/session';
import { fetchMarkets } from '@/markets';
import { logout } from '../auth-actions';

/**
 * The account, and the ways out of it.
 *
 * Orders are listed **per market** (UI-8), because that is the shape of the
 * API: `GET /markets/{market}/checkout/orders` answers for one market, and
 * there is no account-wide endpoint to aggregate them. So this offers one link
 * per market the API currently serves rather than inventing a combined view
 * the server cannot answer in one call.
 *
 * `fetchMarkets` is the same request-cached list the footer and the homepage
 * use, and it is the API's own answer about which markets are open — this page
 * keeps no list of its own (ADR-0005). When it cannot say, the links are
 * simply not offered.
 */
export default async function AccountPage() {
  const me = await requireSession('/account');
  const markets = (await fetchMarkets()) ?? [];
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
        {markets.length > 0 && (
          <div data-testid="account-orders" style={{ marginBottom: 20 }}>
            <h2 className="eyebrow">Your orders</h2>
            {/* One market per link, separated the way the footer separates
                them. A customer with one market sees one link. */}
            <p>
              {markets.map((market, i) => (
                <span key={market.code}>
                  {i > 0 && ' · '}
                  <Link
                    href={`/${market.code}/orders`}
                    data-testid={`account-orders-${market.code}`}
                  >
                    {market.name}
                  </Link>
                </span>
              ))}
            </p>
          </div>
        )}
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
