'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

interface CountdownProps {
  expiresAt: string;
  /** The API's clock when this page was rendered: the countdown follows the server, not the device. */
  serverTime: string;
}

/**
 * How often to ask again once the clock has run out, and how many times.
 *
 * Only at the boundary, and only while the server still disagrees. Twenty
 * attempts three seconds apart covers a minute — long enough to outlast a slow
 * render or a brief API stall, short enough that a genuinely unreachable API
 * is not hammered. After that the page waits: `visibilitychange` still
 * refreshes when the customer comes back to the tab.
 */
const RETRY_EVERY_MS = 3_000;
const MAX_RETRIES = 20;

/**
 * Time left on a reservation. The remaining time is recomputed from the
 * clock on every tick (never by counting ticks), so a sleeping laptop or a
 * throttled background tab shows the right value the moment it wakes. At zero,
 * and whenever the tab becomes visible again, the page is refreshed so the
 * server — which decides expiry — has the final word.
 *
 * ## Why zero asks more than once
 *
 * It used to refresh exactly once, behind a `refreshed` flag that was never
 * cleared. One refresh is enough only if that refresh both arrives and comes
 * back with the answer, and neither is guaranteed:
 *
 * - the server decides expiry lazily, comparing `expires_at <= now()` on each
 *   read, so a refresh issued a moment early gets `active` and is correct to;
 * - the render behind that refresh calls the API, which can be slow or briefly
 *   unreachable — `apiFetch` gives up after five seconds.
 *
 * Either way the flag stayed set, the interval went on counting down from a
 * value already pinned at zero, and the page showed "Your tickets are
 * reserved" until something else happened to reload it. A run of the e2e
 * suite caught exactly that: expiry at 301 seconds, the page still `active` at
 * 531, and not one request to the reservation route in between.
 *
 * So zero now asks again, on a fixed cadence, a bounded number of times. It
 * stops on its own the moment the server agrees: the page renders the expired
 * branch, this component is no longer on it, and the interval is cleaned up.
 */
export function ReservationCountdown({ expiresAt, serverTime }: CountdownProps) {
  const router = useRouter();
  const expires = Date.parse(expiresAt);
  const server = Date.parse(serverTime);
  // The first render uses only server values, so server and client HTML match.
  const [remaining, setRemaining] = useState(Math.max(0, expires - server));
  const lastAsked = useRef(0);
  const asked = useRef(0);

  // The budget belongs to the reservation, not to the render. A successful
  // refresh brings a new `serverTime` and re-runs the effect below; resetting
  // there would hand back a fresh twenty attempts every time and turn a
  // disagreement into an unbounded loop.
  useEffect(() => {
    lastAsked.current = 0;
    asked.current = 0;
  }, [expires]);

  useEffect(() => {
    const offset = server - Date.now();
    const tick = () => {
      const left = Math.max(0, expires - (Date.now() + offset));
      setRemaining(left);
      if (left > 0) return;

      // Past the deadline by our reckoning, and the page is still showing the
      // reservation as live — which means the server has not agreed yet.
      const now = Date.now();
      if (asked.current >= MAX_RETRIES) return;
      if (now - lastAsked.current < RETRY_EVERY_MS) return;
      lastAsked.current = now;
      asked.current += 1;
      router.refresh();
    };
    tick();
    const timer = window.setInterval(tick, 1000);
    const onVisible = () => {
      if (document.visibilityState === 'visible') router.refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [expires, server, router]);

  const seconds = Math.ceil(remaining / 1000);
  const label = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  const urgent = seconds <= 60;

  return (
    <div className={`countdown${urgent ? ' countdown--urgent' : ''}`}>
      <span className="countdown__label">Reserved for</span>
      <span
        className="countdown__time"
        role="timer"
        aria-label={`${Math.floor(seconds / 60)} minutes ${seconds % 60} seconds left`}
        data-testid="countdown"
      >
        {label}
      </span>
    </div>
  );
}
