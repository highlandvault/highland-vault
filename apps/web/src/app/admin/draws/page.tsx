import { AdminDrawListResponseSchema } from '@hv/contracts';
import { isMarketCode } from '@hv/domain';
import Link from 'next/link';
import { StatusBadge } from '@/components/status-badge';
import { apiFetch } from '@/lib/api';
import { formatDateTime, formatPrice } from '@/lib/format';
import { requireSession } from '@/lib/session';
import { ADMIN_MARKETS, canInMarket } from './permissions';

const LOCALES = { uk: 'en-GB', ie: 'en-IE', de: 'de-DE' } as const;

export default async function AdminDrawsPage({
  searchParams,
}: {
  searchParams: Promise<{ market?: string }>;
}) {
  const requested = (await searchParams).market ?? 'uk';
  const market = isMarketCode(requested) ? requested : 'uk';
  const me = await requireSession(`/admin/draws?market=${market}`);
  const result = await apiFetch(`/admin/markets/${market}/draws`, {
    parse: (json) => AdminDrawListResponseSchema.parse(json).draws,
  });

  return (
    <>
      <div className="section-head">
        <h1>Draws</h1>
        {canInMarket(me, 'draws.write', market) && (
          <Link className="button button--gold" href={`/admin/draws/${market}/new`}>
            New draw
          </Link>
        )}
      </div>
      <nav className="tabs" aria-label="Market">
        {ADMIN_MARKETS.map((code) => (
          <Link
            key={code}
            href={`/admin/draws?market=${code}`}
            aria-current={code === market ? 'page' : undefined}
          >
            {code.toUpperCase()}
          </Link>
        ))}
      </nav>

      {!result.ok ? (
        <p className="notice notice--danger" role="alert">
          {result.status === 403
            ? 'You do not have access to this market.'
            : `Draws unavailable (${result.code}).`}
        </p>
      ) : result.data.length === 0 ? (
        <div className="empty-state">
          <p>No draws in this market yet.</p>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="data" data-testid="admin-draws">
            <thead>
              <tr>
                <th>Title</th>
                <th>Status</th>
                <th>Price</th>
                <th>Opens</th>
                <th>Closes</th>
              </tr>
            </thead>
            <tbody>
              {result.data.map((draw) => (
                <tr key={draw.id}>
                  <td>
                    <Link href={`/admin/draws/${market}/${draw.id}`}>{draw.title}</Link>
                    <div className="hint">/{draw.slug}</div>
                  </td>
                  <td>
                    <StatusBadge status={draw.effectiveStatus} />
                  </td>
                  <td>{formatPrice(draw.ticketPriceMinor, draw.currency, LOCALES[market])}</td>
                  <td>{formatDateTime(draw.opensAt, LOCALES[market], market)}</td>
                  <td>{formatDateTime(draw.closesAt, LOCALES[market], market)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
