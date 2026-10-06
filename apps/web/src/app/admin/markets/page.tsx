import { AdminMarketListResponseSchema } from '@hv/contracts';
import Link from 'next/link';
import { apiFetch } from '@/lib/api';

// The gate state is read per request: a stale "enabled" here would be a claim
// about what the public can see.
export const dynamic = 'force-dynamic';

/**
 * Every market, as staff see it (UI-10).
 *
 * **`GET /admin/markets` is the source of truth**, not a list in the web app.
 * That matters more here than anywhere else: the customer-facing
 * `GET /markets` returns only markets that are *available*, so a web-side list
 * would hide exactly the markets an operator needs to work on — a disabled one
 * being the main thing anybody comes to this page to fix. Germany is disabled
 * by design and appears here like any other.
 *
 * Read-only. Every mutation lives on the market's own page, behind a reason
 * and a fresh second factor.
 */
export default async function AdminMarketsPage() {
  const result = await apiFetch('/admin/markets', {
    parse: (json) => AdminMarketListResponseSchema.parse(json).markets,
  });

  if (!result.ok) {
    return (
      <>
        <h1>Markets</h1>
        <p className="notice notice--danger" role="alert" data-testid="markets-error">
          {result.status === 403
            ? 'You do not have access to market administration.'
            : `Market state unavailable (${result.code}).`}
        </p>
      </>
    );
  }

  return (
    <>
      <h1>Markets</h1>
      <p className="hint">
        A market is available to customers only when it is enabled here <strong>and</strong> allowed
        by this deployment&apos;s <code>ENABLED_MARKETS</code>. Changing a gate is a sensitive
        operation: it needs the right permission, a reason, and a recently verified second factor.
      </p>

      <div className="table-wrap">
        <table className="data" data-testid="admin-markets">
          <thead>
            <tr>
              <th scope="col">Market</th>
              <th scope="col">Currency</th>
              <th scope="col">Gate</th>
              <th scope="col">Available</th>
              <th scope="col">Legal approval</th>
              <th scope="col">Required settings</th>
            </tr>
          </thead>
          <tbody>
            {result.data.map((market) => (
              <tr key={market.code} data-testid={`market-row-${market.code}`}>
                <td>
                  <Link href={`/admin/markets/${market.code}`}>{market.name}</Link>
                  <div className="hint">{market.code}</div>
                </td>
                <td>{market.currency}</td>
                {/* Words, not colour: "enabled"/"disabled" is the state. */}
                <td data-testid={`market-gate-${market.code}`}>
                  {market.isEnabled ? 'enabled' : 'disabled'}
                  {!market.environmentAllowed && (
                    <div className="hint">not in ENABLED_MARKETS here</div>
                  )}
                </td>
                <td>{market.available ? 'yes' : 'no'}</td>
                <td>
                  {market.requiresLegalApproval
                    ? market.legalApproval
                      ? `recorded (${market.legalApproval.reference})`
                      : 'required, not recorded'
                    : 'not required'}
                </td>
                <td data-testid={`market-missing-${market.code}`}>
                  {market.missingSettings.length ? market.missingSettings.join(', ') : 'complete'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
