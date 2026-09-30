'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

interface CountdownProps {
  expiresAt: string;
  /** The API's clock when this page was rendered: the countdown follows the server, not the device. */
  serverTime: string;
}

/**
 * Time left on a reservation. The remaining time is recomputed from the
 * clock on every tick (never by counting ticks), so a sleeping laptop or a
 * throttled background tab shows the right value the moment it wakes. At zero,
 * and whenever the tab becomes visible again, the page is refreshed so the
 * server — which decides expiry — has the final word.
 */
export function ReservationCountdown({ expiresAt, serverTime }: CountdownProps) {
  const router = useRouter();
  const expires = Date.parse(expiresAt);
  const server = Date.parse(serverTime);
  // The first render uses only server values, so server and client HTML match.
  const [remaining, setRemaining] = useState(Math.max(0, expires - server));
  const refreshed = useRef(false);

  useEffect(() => {
    const offset = server - Date.now();
    refreshed.current = false;
    const tick = () => {
      const left = Math.max(0, expires - (Date.now() + offset));
      setRemaining(left);
      if (left === 0 && !refreshed.current) {
        refreshed.current = true;
        router.refresh();
      }
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
