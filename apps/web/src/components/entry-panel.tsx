'use client';

import Link from 'next/link';
import { useId, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { formatCount, formatPrice } from '@/lib/format';

interface EntryPanelProps {
  /** Effective status: only a live draw takes entries. */
  status: string;
  currency: 'GBP' | 'EUR';
  locale: string;
  ticketPriceMinor: number;
  maxPerPerson: number;
  /** Display-only availability from the API (a few seconds old at most); null if unknown. */
  available: number | null;
  totalTickets: number;
  /** Entries the signed-in customer may still take; null when signed out. */
  allowance: number | null;
  loginHref: string;
  error: string | null;
  action: (form: FormData) => Promise<void>;
}

/**
 * Choose a quantity, see the exact total, reserve. The limits shown here are
 * for guidance only: the API enforces availability, the per-person cap and the
 * price, and its answer is what the customer sees.
 */
export function EntryPanel(props: EntryPanelProps) {
  const id = useId();
  const signedIn = props.allowance !== null;
  const max = Math.max(
    0,
    Math.min(
      props.maxPerPerson,
      props.allowance ?? props.maxPerPerson,
      props.available ?? props.maxPerPerson,
    ),
  );
  const [quantity, setQuantity] = useState(1);
  const q = Math.min(Math.max(quantity, 1), Math.max(max, 1));
  // Integer minor units only: quantity × price, never floats.
  const total = formatPrice(props.ticketPriceMinor * q, props.currency, props.locale);
  const open = props.status === 'live';
  const soldOut = props.available === 0;
  const capReached = props.allowance === 0;
  const canReserve = open && signedIn && max > 0;

  return (
    <form className="entry" id="entry" aria-labelledby={`${id}-title`} action={props.action}>
      <h2 id={`${id}-title`}>Enter this draw</h2>

      {props.available !== null && (
        <p className="availability" data-testid="availability">
          <strong>{formatCount(props.available, props.locale)}</strong> of{' '}
          {formatCount(props.totalTickets, props.locale)} tickets available
        </p>
      )}

      {props.error && (
        <p className="notice notice--danger" role="alert" data-testid="entry-error">
          {props.error}
        </p>
      )}

      <div>
        <p className="label" id={`${id}-qty`}>
          <strong>Entries</strong>{' '}
          <span className="hint">
            (up to {props.maxPerPerson} per person
            {signedIn && props.allowance! < props.maxPerPerson
              ? `; ${props.allowance} left for you`
              : ''}
            )
          </span>
        </p>
        <div className="stepper" role="group" aria-labelledby={`${id}-qty`}>
          <button
            type="button"
            aria-label="One fewer entry"
            disabled={q <= 1}
            onClick={() => setQuantity(q - 1)}
          >
            −
          </button>
          <output aria-live="polite" data-testid="entry-quantity">
            {q}
          </output>
          <button
            type="button"
            aria-label="One more entry"
            disabled={q >= max}
            onClick={() => setQuantity(q + 1)}
          >
            +
          </button>
        </div>
        <input type="hidden" name="quantity" value={q} />
      </div>

      <div className="total">
        <span>Total</span>
        <span className="price" data-testid="entry-total">
          {total}
        </span>
      </div>

      {!open ? (
        <button type="button" className="button button--gold button--block" disabled>
          Entries not open
        </button>
      ) : !signedIn ? (
        <Link className="button button--gold button--block" href={props.loginHref}>
          Sign in to reserve
        </Link>
      ) : soldOut ? (
        <button type="button" className="button button--gold button--block" disabled>
          Sold out
        </button>
      ) : capReached ? (
        <button type="button" className="button button--gold button--block" disabled>
          Entry limit reached
        </button>
      ) : (
        <ReserveButton disabled={!canReserve} />
      )}
      <p className="hint" style={{ marginTop: 12 }}>
        Reserving holds your ticket numbers for 10 minutes. Nothing is charged on this page.
      </p>
    </form>
  );
}

function ReserveButton({ disabled }: { disabled: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className="button button--gold button--block"
      disabled={disabled || pending}
    >
      {pending ? 'Reserving…' : 'Reserve tickets'}
    </button>
  );
}
