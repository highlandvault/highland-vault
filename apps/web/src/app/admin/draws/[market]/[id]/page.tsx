import { AdminDrawResponseSchema, InventoryResponseSchema } from '@hv/contracts';
import { isMarketCode } from '@hv/domain';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { StatusBadge } from '@/components/status-badge';
import { apiFetch } from '@/lib/api';
import { formatCount, formatDateTime, formatPrice, ordinal } from '@/lib/format';
import { requireSession } from '@/lib/session';
import { cancelDraw, publishDraw, savePrizes, saveSkillQuestion, updateDraw } from '../../actions';
import { DrawForm } from '../../draw-form';
import { canInMarket } from '../../permissions';

const LOCALES = { uk: 'en-GB', ie: 'en-IE', de: 'de-DE' } as const;
const BLOCKERS: Record<string, string> = {
  skill_question_missing: 'Add a skill question.',
  skill_question_incomplete:
    'The skill question needs at least two options and exactly one correct option.',
  prizes_incomplete: 'Add exactly one prize for every winner position.',
  closes_at_in_past: 'The closing time has passed.',
};

export default async function AdminDrawPage({
  params,
  searchParams,
}: {
  params: Promise<{ market: string; id: string }>;
  searchParams: Promise<{ error?: string; saved?: string }>;
}) {
  const { market, id } = await params;
  if (!isMarketCode(market) || !/^[0-9a-f-]{36}$/.test(id)) notFound();
  const { error, saved } = await searchParams;
  const me = await requireSession(`/admin/draws/${market}/${id}`);
  const result = await apiFetch(`/admin/markets/${market}/draws/${id}`, {
    parse: (json) => AdminDrawResponseSchema.parse(json).draw,
  });
  if (!result.ok) {
    if (result.status === 404 || result.status === 403) notFound();
    throw new Error(`Draw unavailable: ${result.code}`);
  }
  const draw = result.data;
  // Tickets exist from publication on (ADR-0027). Read-only: there are no inventory controls.
  const inventory =
    draw.status === 'draft'
      ? null
      : await apiFetch(`/admin/markets/${market}/draws/${draw.id}/inventory`, {
          parse: (json) => InventoryResponseSchema.parse(json).inventory,
        }).then((r) => (r.ok ? r.data : null));
  const locale = LOCALES[market];
  const canWrite = canInMarket(me, 'draws.write', market);
  const isDraft = draw.status === 'draft';
  const bound = (fn: (market: string, id: string, form: FormData) => Promise<void>) =>
    fn.bind(null, market, draw.id);

  return (
    <div className="stack">
      <div>
        <p className="breadcrumbs">
          <Link href={`/admin/draws?market=${market}`}>Draws</Link> › {draw.title}
        </p>
        <div className="section-head">
          <div>
            <h1 style={{ marginBottom: 8 }}>{draw.title}</h1>
            <StatusBadge status={draw.effectiveStatus} />{' '}
            <span className="hint" data-testid="admin-draw-status">
              stored status: {draw.status}
            </span>
          </div>
          {draw.effectiveStatus !== 'draft' && draw.effectiveStatus !== 'cancelled' && (
            <Link className="link-arrow" href={`/${market}/draws/${draw.slug}`}>
              Customer page →
            </Link>
          )}
        </div>
        {error && (
          <p className="notice notice--danger" role="alert" data-testid="form-error">
            {error}
          </p>
        )}
        {saved && (
          <p className="notice" role="status" data-testid="form-saved">
            Saved ({saved}).
          </p>
        )}
      </div>

      <section className="panel" aria-labelledby="summary">
        <h2 id="summary">Summary</h2>
        <dl className="facts">
          <div>
            <dt>Price</dt>
            <dd>{formatPrice(draw.ticketPriceMinor, draw.currency, locale)}</dd>
          </div>
          <div>
            <dt>Tickets / per person</dt>
            <dd>
              {draw.totalTickets} / {draw.maxPerPerson}
            </dd>
          </div>
          <div>
            <dt>Opens</dt>
            <dd>{formatDateTime(draw.opensAt, locale, market)}</dd>
          </div>
          <div>
            <dt>Closes</dt>
            <dd>{formatDateTime(draw.closesAt, locale, market)}</dd>
          </div>
        </dl>
      </section>

      {inventory && (
        <section className="panel" aria-labelledby="inventory" data-testid="inventory">
          <h2 id="inventory">Ticket inventory</h2>
          <dl className="facts">
            {(
              [
                ['Total', inventory.total, 'inventory-total'],
                ['Available', inventory.available, 'inventory-available'],
                ['Reserved', inventory.reserved, 'inventory-reserved'],
                ['Purchased', inventory.sold, 'inventory-sold'],
              ] as const
            ).map(([label, value, testId]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd data-testid={testId}>{formatCount(value, locale)}</dd>
              </div>
            ))}
          </dl>
          <p className="hint" data-testid="inventory-reservations">
            Reservations: {formatCount(inventory.reservations.active, locale)} active,{' '}
            {formatCount(inventory.reservations.released, locale)} released,{' '}
            {formatCount(inventory.reservations.expired, locale)} expired. Reservations expire
            automatically; tickets cannot be changed by hand.
          </p>
        </section>
      )}

      {isDraft && canWrite && (
        <>
          <section className="panel" aria-labelledby="details">
            <h2 id="details">Details</h2>
            <DrawForm
              market={market}
              draw={draw}
              action={bound(updateDraw)}
              submitLabel="Save details"
            />
          </section>

          <section className="panel" aria-labelledby="prizes">
            <h2 id="prizes">Prizes ({draw.winnerPositions} winner positions)</h2>
            <form action={bound(savePrizes)} className="form form--wide" data-testid="prizes-form">
              <input type="hidden" name="winnerPositions" value={draw.winnerPositions} />
              {Array.from({ length: draw.winnerPositions }, (_, i) => i + 1).map((position) => {
                const prize = draw.prizes.find((p) => p.position === position);
                return (
                  <div className="field-row" key={position}>
                    <div className="field">
                      <label htmlFor={`prize-${position}-title`}>{ordinal(position)} prize</label>
                      <input
                        id={`prize-${position}-title`}
                        name={`prize-${position}-title`}
                        maxLength={200}
                        defaultValue={prize?.title}
                      />
                    </div>
                    <div className="field">
                      <label htmlFor={`prize-${position}-description`}>Description</label>
                      <input
                        id={`prize-${position}-description`}
                        name={`prize-${position}-description`}
                        maxLength={2000}
                        defaultValue={prize?.description}
                      />
                    </div>
                  </div>
                );
              })}
              <div>
                <button type="submit" className="button button--outline">
                  Save prizes
                </button>
              </div>
            </form>
          </section>

          <section className="panel" aria-labelledby="question">
            <h2 id="question">Skill question</h2>
            <form
              action={bound(saveSkillQuestion)}
              className="form form--wide"
              data-testid="question-form"
            >
              <div className="field">
                <label htmlFor="prompt">Question</label>
                <input
                  id="prompt"
                  name="prompt"
                  required
                  maxLength={500}
                  defaultValue={draw.skillQuestion?.prompt}
                />
              </div>
              {[1, 2, 3, 4].map((n) => {
                const option = draw.skillQuestion?.options[n - 1];
                return (
                  <div className="field-row" key={n}>
                    <div className="field">
                      <label htmlFor={`option-${n}`}>Option {n}</label>
                      <input
                        id={`option-${n}`}
                        name={`option-${n}`}
                        maxLength={200}
                        defaultValue={option?.label}
                      />
                    </div>
                    <label className="option" style={{ alignSelf: 'end' }}>
                      <input
                        type="radio"
                        name="correct"
                        value={n}
                        required
                        defaultChecked={option?.isCorrect ?? false}
                      />
                      Correct answer
                    </label>
                  </div>
                );
              })}
              <div>
                <button type="submit" className="button button--outline">
                  Save skill question
                </button>
              </div>
            </form>
          </section>

          <section className="panel" aria-labelledby="publish">
            <h2 id="publish">Publish</h2>
            {draw.publishBlockers.length > 0 ? (
              <ul data-testid="publish-blockers">
                {draw.publishBlockers.map((b) => (
                  <li key={b}>{BLOCKERS[b] ?? b}</li>
                ))}
              </ul>
            ) : (
              <p className="hint">
                Publishing freezes the configuration, prizes and skill question. The draw opens
                automatically at its opening time.
              </p>
            )}
            <form action={bound(publishDraw)} className="form">
              <div className="field">
                <label htmlFor="publish-reason">Note for the audit log (optional)</label>
                <input id="publish-reason" name="reason" maxLength={500} />
              </div>
              <div>
                <button
                  type="submit"
                  className="button button--gold"
                  disabled={draw.publishBlockers.length > 0}
                >
                  Publish draw
                </button>
              </div>
            </form>
          </section>
        </>
      )}

      {!isDraft && (
        <section className="panel" aria-labelledby="published">
          <h2 id="published">Prizes and skill question</h2>
          <ol className="prize-list">
            {draw.prizes.map((p) => (
              <li key={p.position}>
                <span className="prize-rank">{ordinal(p.position)}</span>
                <div>
                  <h3>{p.title}</h3>
                  {p.description && <p>{p.description}</p>}
                </div>
              </li>
            ))}
          </ol>
          {draw.skillQuestion && (
            <p style={{ marginTop: 16 }}>
              <strong>{draw.skillQuestion.prompt}</strong> —{' '}
              {draw.skillQuestion.options
                .map((o) => (o.isCorrect ? `${o.label} ✓` : o.label))
                .join(' · ')}
            </p>
          )}
          <p className="hint">
            Published draws cannot be edited (changes after publishing are OPEN O9).
          </p>
        </section>
      )}

      {canWrite &&
        (draw.status === 'draft' || draw.status === 'scheduled') &&
        draw.effectiveStatus !== 'live' && (
          <section className="panel" aria-labelledby="cancel">
            <h2 id="cancel">Cancel draw</h2>
            <form action={bound(cancelDraw)} className="form">
              <div className="field">
                <label htmlFor="cancel-reason">Reason (recorded in the audit log)</label>
                <input id="cancel-reason" name="reason" required minLength={3} maxLength={500} />
              </div>
              <div>
                <button type="submit" className="button button--danger">
                  Cancel draw
                </button>
              </div>
            </form>
          </section>
        )}
      {draw.effectiveStatus === 'live' && (
        <p className="hint">Live draws cannot be cancelled: the policy is not decided yet (O6).</p>
      )}
    </div>
  );
}
