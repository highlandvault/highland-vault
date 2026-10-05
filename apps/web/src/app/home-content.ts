/**
 * Everything on the homepage that is NOT from the API.
 *
 * ## What used to be here, and why it is not
 *
 * The design called for review scores, a winner count, a Trustpilot rating, a
 * registered address, social accounts and a list of instant prizes. **Nothing
 * in this repository substantiated any of it**: there is no winners table
 * (settlement is a later phase), no review integration of any kind, no
 * configured address, no social accounts, and instant wins have no table, no
 * contract and no API field — only the RBAC string `instant_wins.write`.
 *
 * So they are gone rather than softened. A fabricated review score is a
 * consumer-protection problem rather than a styling one, and a number nobody
 * can trace is not improved by being made vaguer. What replaced them, where
 * anything replaced them at all, is a statement about how this product
 * actually works, each one checkable in the code: the skill question, the
 * numbered tickets, the per-person cap, the hold on a basket, the terms gate.
 *
 * ## What is still a placeholder
 *
 * `CATEGORIES` is the shape of a feature that does not exist — no draw carries
 * a category and no endpoint groups them — so every card is inert and leads
 * nowhere. It is a structural placeholder, carrying no figure and no promise,
 * and it should become a real query when categories land.
 *
 * `NAV` has the same character: entries with no page are rendered as text
 * rather than as links that would 404.
 *
 * The root layout still sets `robots: { index: false }`.
 *
 * Nothing here is imported by the API, the worker or any other page.
 */

export interface Category {
  readonly slug: string;
  readonly title: string;
  /** What the category *is*, never what is currently in it. */
  readonly blurb: string;
  /** Which drawn scene backs the card until real photography exists (O14). */
  readonly scene: 'whisky' | 'tech' | 'cars' | 'property' | 'experiences';
  /**
   * Whether draws can be entered in this category today.
   *
   * There is no category system — no draw carries one and no endpoint groups
   * them — so this is not a filter, and a card that is available leads to the
   * draws listing rather than to a category of its own. The four that are not
   * say so on the card: presenting them as live sections would promise draws
   * this build cannot show.
   */
  readonly available: boolean;
}

/**
 * PLACEHOLDER — there is no category concept in the API.
 *
 * `PublicDrawSummary` carries no category, and no endpoint groups draws by
 * one. Whisky is the only category with anything behind it, so it is the only
 * one that leads anywhere; the rest are marked and inert.
 */
export const CATEGORIES: readonly Category[] = [
  // The one the platform runs draws in today. Its card leads to the listing,
  // which is where the draws actually are.
  {
    slug: 'whisky',
    title: 'Whisky',
    blurb: 'Bottles and collections',
    scene: 'whisky',
    available: true,
  },
  // Named, and marked as not yet open. The blurbs say what each category would
  // hold, in the plainest words available, and claim nothing about stock.
  { slug: 'tech', title: 'Tech', blurb: 'Devices and gadgets', scene: 'tech', available: false },
  { slug: 'cars', title: 'Cars', blurb: 'Cars and motorcycles', scene: 'cars', available: false },
  {
    slug: 'property',
    title: 'Property',
    blurb: 'Homes and land',
    scene: 'property',
    available: false,
  },
  {
    slug: 'experiences',
    title: 'Experiences',
    blurb: 'Trips, stays and events',
    scene: 'experiences',
    available: false,
  },
];

/**
 * How entering works, in the hero.
 *
 * Four statements, each one true of this build and checkable in it: the skill
 * question is required on every line and marked by the API (ADR-0030); ticket
 * numbers are sequential and shown on the reservation (ADR-0027); the hold is
 * a real reservation with a TTL that releases it; and every draw carries a
 * `maxPerPerson` the ticket engine enforces.
 *
 * They replace "100% genuine", "Safe checkout", "Verified results" and
 * "Global shipping" — a product with no fulfilment module should not promise
 * shipping, and nothing here could verify a result.
 */
export const PROMISES = [
  { title: 'A skill question', note: 'On every entry', icon: 'question' },
  { title: 'Numbered tickets', note: 'Yours are shown to you', icon: 'ticket' },
  { title: 'Held while you decide', note: 'Released if you do not', icon: 'clock' },
  { title: 'A limit per person', note: 'Set on every draw', icon: 'shield' },
] as const;

/**
 * What happens to an order, in the closing band.
 *
 * The same rule as `PROMISES` and no overlap with it: the basket holds tickets
 * and takes no money, the terms version in force is shown and recorded at
 * checkout (ADR-0031), prices are the market's own currency, and the draw's
 * closing time is published on its page.
 *
 * It replaces a Trustpilot score, a winner count and "100% secure checkout" —
 * two invented figures and an absolute claim about security.
 */
export const TRUST = [
  { title: 'Nothing charged in a basket', note: 'It holds tickets, not money', icon: 'ticket' },
  { title: 'Terms shown at checkout', note: 'Accepted before an order exists', icon: 'list' },
  { title: 'Priced in your market', note: 'Pounds or euro, never converted', icon: 'card' },
  { title: 'A published closing time', note: 'On every draw', icon: 'clock' },
] as const;

/** The header's sections. `href` is null where no page exists yet. */
export const NAV = [
  { label: 'Competitions', href: '/#competitions', caret: true },
  { label: 'Winners', href: null, caret: false },
  { label: 'How It Works', href: '/#how-it-works', caret: false },
  { label: 'About', href: null, caret: false },
  { label: 'Contact', href: null, caret: false },
] as const;
