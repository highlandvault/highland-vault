import Link from 'next/link';
import { SORTS, STATUSES, type ListingQuery } from '@/lib/draw-listing';

/**
 * The catalogue controls.
 *
 * A plain `<form method="get">`, which is the whole point: it submits without
 * JavaScript, the result is an ordinary URL that can be shared, bookmarked and
 * reached with the back button, and the page stays a Server Component. There
 * is no client state here to fall out of step with what is on screen.
 *
 * The browser replaces the entire query string on a GET submission, so every
 * control has to be in this form or it would be dropped on the next submit.
 *
 * `Apply` is visible rather than relying on a change event, because a select
 * that navigates the moment it is touched is hostile to a keyboard — arrowing
 * through the options would fire a request per option.
 */
export function ListingToolbar({
  action,
  query,
  filtered,
  resultLabel,
}: {
  /** Where the form submits: this market's listing, with no query of its own. */
  action: string;
  query: ListingQuery;
  filtered: boolean;
  /** e.g. "3 competitions · 2 open · 1 opening soon". Announced when it changes. */
  resultLabel: string;
}) {
  return (
    <form className="toolbar" method="get" action={action} role="search">
      <div className="toolbar__field toolbar__field--search">
        <label htmlFor="listing-q">Search competitions</label>
        <input
          id="listing-q"
          name="q"
          type="search"
          defaultValue={query.q}
          placeholder="Search by title"
          maxLength={80}
          autoComplete="off"
        />
      </div>

      <div className="toolbar__field">
        <label htmlFor="listing-status">Show</label>
        <select id="listing-status" name="status" defaultValue={query.status}>
          {STATUSES.map((status) => (
            <option key={status.value} value={status.value}>
              {status.label}
            </option>
          ))}
        </select>
      </div>

      <div className="toolbar__field">
        <label htmlFor="listing-sort">Sort by</label>
        <select id="listing-sort" name="sort" defaultValue={query.sort}>
          {SORTS.map((sort) => (
            <option key={sort.value} value={sort.value}>
              {sort.label}
            </option>
          ))}
        </select>
      </div>

      <div className="toolbar__actions">
        <button type="submit" className="button button--outline">
          Apply
        </button>
        {filtered && (
          <Link className="link-arrow" href={action} data-testid="clear-filters">
            Clear filters
          </Link>
        )}
      </div>

      {/* The count lives inside the form so a screen reader hears the result of
          a submission, not just that the page changed. */}
      <p className="toolbar__results" role="status" data-testid="result-summary">
        {resultLabel}
      </p>
    </form>
  );
}
