'use client';

import type { PublicSkillQuestion } from '@hv/contracts';
import { useId, useState } from 'react';
import { formatPrice } from '@/lib/format';

interface EntryPanelProps {
  status: string;
  currency: 'GBP' | 'EUR';
  locale: string;
  ticketPriceMinor: number;
  maxPerPerson: number;
  skillQuestion: PublicSkillQuestion;
}

/**
 * The entry area, ready for the ticket engine (Phase 4) and checkout (Phase 5).
 * Today it only shows what an entry involves: the skill question and the cost
 * of a quantity. Nothing is reserved, bought or checked, and the UI says so —
 * there is no answer checking here and no availability count, because neither
 * exists yet.
 */
export function EntryPanel(props: EntryPanelProps) {
  const [quantity, setQuantity] = useState(1);
  const [answer, setAnswer] = useState<string | null>(null);
  const questionId = useId();
  const max = props.maxPerPerson;
  // Integer minor units only: quantity × price, never floats.
  const total = formatPrice(props.ticketPriceMinor * quantity, props.currency, props.locale);

  return (
    <form
      className="entry"
      aria-labelledby={`${questionId}-title`}
      onSubmit={(e) => e.preventDefault()}
    >
      <h2 id={`${questionId}-title`}>Enter this draw</h2>

      <fieldset data-testid="skill-question">
        <legend>{props.skillQuestion.prompt}</legend>
        <div className="options">
          {props.skillQuestion.options.map((option) => (
            <label key={option.id} className="option">
              <input
                type="radio"
                name="answer"
                value={option.id}
                checked={answer === option.id}
                onChange={() => setAnswer(option.id)}
              />
              {option.label}
            </label>
          ))}
        </div>
        <p className="hint">Answering the skill question is part of every entry.</p>
      </fieldset>

      <div>
        <p className="label" id={`${questionId}-qty`}>
          <strong>Entries</strong> <span className="hint">(up to {max} per person)</span>
        </p>
        <div className="stepper" role="group" aria-labelledby={`${questionId}-qty`}>
          <button
            type="button"
            aria-label="One fewer entry"
            disabled={quantity <= 1}
            onClick={() => setQuantity((q) => Math.max(1, q - 1))}
          >
            −
          </button>
          <output aria-live="polite" data-testid="entry-quantity">
            {quantity}
          </output>
          <button
            type="button"
            aria-label="One more entry"
            disabled={quantity >= max}
            onClick={() => setQuantity((q) => Math.min(max, q + 1))}
          >
            +
          </button>
        </div>
      </div>

      <div className="total">
        <span>Total</span>
        <span className="price" data-testid="entry-total">
          {total}
        </span>
      </div>

      <button type="submit" className="button button--gold" disabled style={{ width: '100%' }}>
        {props.status === 'live' ? 'Enter now' : 'Entries not open'}
      </button>
      <p className="notice" role="status" data-testid="entry-unavailable" style={{ marginTop: 12 }}>
        Online entry is not available yet. No tickets are reserved and nothing is charged on this
        page.
      </p>
    </form>
  );
}
