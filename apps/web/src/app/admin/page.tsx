import { AdminMarketListResponseSchema } from '@hv/contracts';
import { apiFetch } from '@/lib/api';

const yesNo = (value: boolean) => (value ? 'yes' : 'no');

export default async function AdminHomePage() {
  const result = await apiFetch('/admin/markets', {
    parse: (json) => AdminMarketListResponseSchema.parse(json).markets,
  });
  if (!result.ok) {
    return <p role="alert">Market gate state unavailable ({result.code}).</p>;
  }
  return (
    <>
      <h1>Market gates</h1>
      <p className="hint">
        A market is available only when it is enabled here AND listed in the API&apos;s
        ENABLED_MARKETS. Changes are sensitive operations made through the admin API (step-up MFA,
        reason, audit log).
      </p>
      <div className="table-wrap">
        <table className="data" data-testid="market-gates">
          <thead>
            <tr>
              <th>Market</th>
              <th>Currency</th>
              <th>Enabled</th>
              <th>Environment allows</th>
              <th>Available</th>
              <th>Legal approval</th>
              <th>Missing settings</th>
            </tr>
          </thead>
          <tbody>
            {result.data.map((market) => (
              <tr key={market.code} data-testid={`gate-${market.code}`}>
                <td>
                  {market.name} ({market.code})
                </td>
                <td>{market.currency}</td>
                <td>{yesNo(market.isEnabled)}</td>
                <td>{yesNo(market.environmentAllowed)}</td>
                <td>{yesNo(market.available)}</td>
                <td>
                  {market.requiresLegalApproval
                    ? market.legalApproval
                      ? `recorded (${market.legalApproval.reference})`
                      : 'required, not recorded'
                    : 'not required'}
                </td>
                <td>
                  {market.missingSettings.length ? market.missingSettings.join(', ') : 'none'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
