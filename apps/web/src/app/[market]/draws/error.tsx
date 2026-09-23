'use client';

/** Shown when draws cannot be loaded (API unreachable or failing). */
export default function DrawsError({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="empty-state" role="alert" data-testid="draws-error">
      <h2>Draws could not be loaded</h2>
      <p>Something went wrong on our side. Please try again in a moment.</p>
      <button type="button" className="button button--outline" onClick={reset}>
        Try again
      </button>
    </div>
  );
}
