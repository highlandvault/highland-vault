import { isMarketCode } from '@hv/domain';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { createDraw } from '../../actions';
import { DrawForm } from '../../draw-form';

export default async function NewDrawPage({
  params,
  searchParams,
}: {
  params: Promise<{ market: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { market } = await params;
  if (!isMarketCode(market)) notFound();
  const { error } = await searchParams;
  return (
    <>
      <p className="breadcrumbs">
        <Link href={`/admin/draws?market=${market}`}>Draws</Link> › New ({market.toUpperCase()})
      </p>
      <h1>New draw</h1>
      <p className="hint">
        The draw is saved as a draft. Add prizes and a skill question, then publish it.
      </p>
      {error && (
        <p className="notice notice--danger" role="alert" data-testid="form-error">
          {error}
        </p>
      )}
      <div className="panel">
        <DrawForm
          market={market}
          action={createDraw.bind(null, market)}
          submitLabel="Create draft"
        />
      </div>
    </>
  );
}
