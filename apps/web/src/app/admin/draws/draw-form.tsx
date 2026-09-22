import type { AdminDraw } from '@hv/contracts';
import {
  MARKET_TIME_ZONES,
  type MarketCode,
  money,
  toDecimalString,
  utcToZonedLocal,
} from '@hv/domain';

/** Draft configuration form, used for creating and editing. Times are in the market's zone. */
export function DrawForm({
  market,
  draw,
  action,
  submitLabel,
}: {
  market: MarketCode;
  draw?: AdminDraw;
  action: (form: FormData) => Promise<void>;
  submitLabel: string;
}) {
  const zone = MARKET_TIME_ZONES[market];
  const local = (iso: string | undefined) =>
    iso ? utcToZonedLocal(new Date(iso), zone) : undefined;
  return (
    <form action={action} className="form form--wide" data-testid="draw-form">
      <div className="field-row">
        <div className="field">
          <label htmlFor="title">Title</label>
          <input id="title" name="title" required maxLength={200} defaultValue={draw?.title} />
        </div>
        <div className="field">
          <label htmlFor="slug">URL slug</label>
          <input
            id="slug"
            name="slug"
            required
            maxLength={80}
            pattern="[a-z0-9]+(-[a-z0-9]+)*"
            title="lower-case letters, digits and single hyphens"
            defaultValue={draw?.slug}
          />
        </div>
      </div>
      <div className="field">
        <label htmlFor="description">Description</label>
        <textarea
          id="description"
          name="description"
          maxLength={10000}
          defaultValue={draw?.description}
        />
      </div>
      <div className="field-row field-row--3">
        <div className="field">
          <label htmlFor="price">
            Entry price ({draw?.currency ?? (market === 'uk' ? 'GBP' : 'EUR')})
          </label>
          <input
            id="price"
            name="price"
            required
            inputMode="decimal"
            placeholder="2.50"
            defaultValue={
              draw ? toDecimalString(money(draw.ticketPriceMinor, draw.currency)) : undefined
            }
          />
        </div>
        <div className="field">
          <label htmlFor="totalTickets">Total tickets</label>
          <input
            id="totalTickets"
            name="totalTickets"
            type="number"
            min={1}
            required
            defaultValue={draw?.totalTickets}
          />
        </div>
        <div className="field">
          <label htmlFor="maxPerPerson">Maximum per person</label>
          <input
            id="maxPerPerson"
            name="maxPerPerson"
            type="number"
            min={1}
            required
            defaultValue={draw?.maxPerPerson}
          />
        </div>
      </div>
      <div className="field-row field-row--3">
        <div className="field">
          <label htmlFor="winnerPositions">Winner positions</label>
          <input
            id="winnerPositions"
            name="winnerPositions"
            type="number"
            min={1}
            required
            defaultValue={draw?.winnerPositions ?? 1}
          />
        </div>
        <div className="field">
          <label htmlFor="opensAt">Opens ({zone})</label>
          <input
            id="opensAt"
            name="opensAt"
            type="datetime-local"
            required
            defaultValue={local(draw?.opensAt)}
          />
        </div>
        <div className="field">
          <label htmlFor="closesAt">Closes ({zone})</label>
          <input
            id="closesAt"
            name="closesAt"
            type="datetime-local"
            required
            defaultValue={local(draw?.closesAt)}
          />
        </div>
      </div>
      <div>
        <button type="submit" className="button button--gold">
          {submitLabel}
        </button>
      </div>
    </form>
  );
}
