'use client';

import { useEffect, useState } from 'react';

/**
 * Days, hours and minutes until a draw's deadline.
 *
 * A client component because the number changes while nobody is doing
 * anything, and a server-rendered one would be wrong within a minute. It is
 * told the deadline as an ISO string and works out the rest, so nothing about
 * the customer's clock reaches the server and no request is made to tick.
 *
 * **It decides nothing.** The API owns the draw's status and recomputes it on
 * every read; this only counts. When it reaches zero it says so and stops —
 * the next page load gets the real status from the API rather than this
 * guessing at one.
 *
 * Ticks every 30 seconds, because the smallest unit shown is a minute. No
 * animation, so `prefers-reduced-motion` has nothing to suppress.
 */
export function DrawCountdown({ to, label }: { to: string; label?: string }) {
  // Rendered on the server first: `null` until mounted, so the server and the
  // first client render agree and hydration has nothing to reconcile.
  const [remaining, setRemaining] = useState<number | null>(null);

  useEffect(() => {
    const deadline = Date.parse(to);
    const tick = () => setRemaining(Math.max(0, deadline - Date.now()));
    tick();
    const timer = window.setInterval(tick, 30_000);
    return () => window.clearInterval(timer);
  }, [to]);

  const parts =
    remaining === null
      ? null
      : {
          days: Math.floor(remaining / 86_400_000),
          hours: Math.floor((remaining % 86_400_000) / 3_600_000),
          minutes: Math.floor((remaining % 3_600_000) / 60_000),
        };

  return (
    <div className="countdown-block" data-testid="draw-countdown">
      {label && <p className="countdown-block__label">{label}</p>}
      {/* Before hydration, and after the deadline, the exact time is still on
          the page in a <time> element beside this — so neither state leaves a
          customer without the answer. */}
      <div className="countdown-block__digits" aria-live="off">
        {parts === null ? (
          <span className="countdown-block__pending">&nbsp;</span>
        ) : remaining === 0 ? (
          <span className="countdown-block__closed">Closed</span>
        ) : (
          <>
            <Unit value={parts.days} unit="days" />
            <span className="countdown-block__sep" aria-hidden="true">
              :
            </span>
            <Unit value={parts.hours} unit="hrs" />
            <span className="countdown-block__sep" aria-hidden="true">
              :
            </span>
            <Unit value={parts.minutes} unit="mins" />
          </>
        )}
      </div>
    </div>
  );
}

function Unit({ value, unit }: { value: number; unit: string }) {
  return (
    <span className="countdown-unit">
      <span className="countdown-unit__value">{String(value).padStart(2, '0')}</span>
      <span className="countdown-unit__name">{unit}</span>
    </span>
  );
}
