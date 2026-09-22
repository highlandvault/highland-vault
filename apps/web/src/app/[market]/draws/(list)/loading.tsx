/** Scoped to the listing only: a loading boundary around the detail page would stream it and turn its 404s into 200s. */
export default function LoadingDraws() {
  return (
    <div aria-busy="true" aria-live="polite" data-testid="draws-loading">
      <span className="visually-hidden">Loading draws…</span>
      <ul className="draw-grid">
        {[0, 1, 2].map((i) => (
          <li key={i}>
            <div className="skeleton" />
          </li>
        ))}
      </ul>
    </div>
  );
}
