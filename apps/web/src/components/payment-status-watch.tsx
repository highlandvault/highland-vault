'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

interface WatchProps {
  /** Where to ask. Built by the page from what the API already told it. */
  endpoint: string;
  /** The order status the server rendered this page with. */
  initialOrderStatus: string;
}

/** How often to ask. Comfortably inside the route's own limit, and not a loop. */
const INTERVAL_MS = 4000;
/**
 * How long to keep asking.
 *
 * Two minutes, because that is how long an attempt lives (D3a = 120s). Past
 * that there is nothing left to wait for: either something resolved it or the
 * attempt lapsed, and both are states the page should be re-read for rather
 * than waited on indefinitely.
 */
const LIMIT_MS = 120_000;

/**
 * The order statuses worth stopping on.
 *
 * Anything that is not `awaiting_payment` has been decided by the only things
 * allowed to decide it, so the page is refreshed and this component stops. The
 * list is deliberately "everything else" rather than an enumeration of the
 * good outcomes: a status this build has not heard of still means the waiting
 * is over, and treating it as "keep waiting" would leave somebody staring at a
 * spinner over a settled order.
 */
function settled(status: string): boolean {
  return status !== 'awaiting_payment';
}

/**
 * Waiting for a payment to resolve, without making the customer press reload
 * (UI-6).
 *
 * ## It is an enhancement, and nothing depends on it
 *
 * The page it sits on is server-rendered and already correct. This asks a
 * read-only endpoint whether anything changed and, when something has, calls
 * `router.refresh()` so the SERVER re-renders the authoritative state. It never
 * renders an outcome itself — it has no wording for `paid` and cannot acquire
 * any — so a bug here can delay good news but cannot invent it. With
 * JavaScript off, none of this runs and the page is exactly as valid.
 *
 * ## Why it may poll at all
 *
 * The endpoint behind it reconciles nothing, finalises nothing and contacts no
 * provider (ADR-0035): asking is free and changes nothing. It still stops —
 * on resolution, on the attempt's own lifetime, and whenever the answer says
 * the waiting is over — because a page left polling forever is a page nobody
 * closed.
 *
 * ## What it says out loud
 *
 * One live region, polite, carrying the stage rather than every poll. A
 * screen-reader user hears "still waiting" once, not every four seconds, and
 * hears the outcome when the refreshed page states it.
 */
export function PaymentStatusWatch({ endpoint, initialOrderStatus }: WatchProps) {
  const router = useRouter();
  const [phase, setPhase] = useState<'waiting' | 'resolved' | 'timed_out'>(
    settled(initialOrderStatus) ? 'resolved' : 'waiting',
  );
  // So the refresh is asked for once, however many answers arrive.
  const refreshed = useRef(false);

  useEffect(() => {
    if (settled(initialOrderStatus)) return;
    refreshed.current = false;
    let stopped = false;
    const startedAt = Date.now();

    const resolve = () => {
      if (refreshed.current) return;
      refreshed.current = true;
      setPhase('resolved');
      // The server has the final word, and it is about to have it.
      router.refresh();
    };

    const ask = async () => {
      if (stopped) return;
      if (Date.now() - startedAt >= LIMIT_MS) {
        stopped = true;
        setPhase('timed_out');
        return;
      }
      try {
        const response = await fetch(endpoint, {
          cache: 'no-store',
          headers: { accept: 'application/json' },
        });
        if (!response.ok) return; // Nothing to act on; the next tick may do better.
        const body: unknown = await response.json();
        const order =
          typeof body === 'object' && body !== null && 'order' in body ? body.order : null;
        if (typeof order === 'string' && settled(order)) {
          stopped = true;
          resolve();
        }
      } catch {
        // Offline, a dropped connection, a navigation mid-flight. The page is
        // still right; the next tick tries again.
      }
    };

    void ask();
    const timer = window.setInterval(() => void ask(), INTERVAL_MS);
    // Coming back to the tab is the moment a customer most wants the answer.
    const onVisible = () => {
      if (document.visibilityState === 'visible') void ask();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [endpoint, initialOrderStatus, router]);

  if (phase === 'resolved') {
    return (
      <p className="hint" role="status" aria-live="polite" data-testid="payment-watch">
        Updating…
      </p>
    );
  }

  if (phase === 'timed_out') {
    return (
      <p className="hint" role="status" aria-live="polite" data-testid="payment-watch">
        {/* Truthful: we stopped asking. Nothing here claims the payment failed. */}
        Still waiting for confirmation. Reload this page to check again.
      </p>
    );
  }

  return (
    <p className="payment-waiting" role="status" aria-live="polite" data-testid="payment-watch">
      {/* The spinner is decorative; the sentence is the status. */}
      <span className="payment-waiting__spinner" aria-hidden="true" />
      <span>Checking for confirmation…</span>
    </p>
  );
}
