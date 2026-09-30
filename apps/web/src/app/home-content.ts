/**
 * Everything on the homepage that is NOT from the API.
 *
 * ## Read this before shipping
 *
 * The homepage design calls for content this product does not yet have:
 * prize categories, instant-win prizes, brand promises and review scores.
 * None of it exists in the database, the contracts or the API, so it lives
 * here — in one file, under one heading — rather than being scattered through
 * the page where it would be indistinguishable from real data.
 *
 * **Two kinds of thing are in this file, and they are not equally safe.**
 *
 * `CATEGORIES`, `INSTANT_PRIZES` and the badge labels are *structural
 * placeholders*: the shape of data that Phase 8 and a future category feature
 * will provide. They are safe to show in a pre-release build and should be
 * replaced by real queries when those features land.
 *
 * `PROMISES`, `SOCIAL_PROOF` and `TRUST` contain **claims about the world** —
 * "100% genuine", "10,000+ winners", "4.9/5 from 2,500+ reviews", a Trustpilot
 * score. Nothing in this repository substantiates any of them. They are here
 * because the design calls for them and the owner asked for the design. They
 * must be verified, sourced or removed before this site is indexed or shown to
 * a customer: a fabricated review score is a consumer-protection problem, not
 * a styling one. The root layout still sets `robots: { index: false }`.
 *
 * Nothing here is imported by the API, the worker or any other page.
 */

export interface Category {
  readonly slug: string;
  readonly title: string;
  readonly blurb: string;
  /** Which drawn scene backs the card until real photography exists (O14). */
  readonly scene: 'whisky' | 'tech' | 'cars' | 'property' | 'experiences';
  /** Where the card goes. `null` until the category has draws of its own. */
  readonly href: string | null;
}

/**
 * PLACEHOLDER — there is no category concept in the API.
 *
 * `PublicDrawSummary` carries no category, and no endpoint groups draws by
 * one. Whisky is the only category with anything behind it, so it is the only
 * one that leads anywhere; the rest are marked and inert.
 */
export const CATEGORIES: readonly Category[] = [
  {
    slug: 'whisky',
    title: 'Whisky',
    blurb: 'Rare bottles & exclusive releases',
    scene: 'whisky',
    href: null,
  },
  {
    slug: 'tech',
    title: 'Tech',
    blurb: 'Latest gadgets & cutting-edge tech',
    scene: 'tech',
    href: null,
  },
  {
    slug: 'cars',
    title: 'Cars',
    blurb: 'Luxury, performance & dream cars',
    scene: 'cars',
    href: null,
  },
  {
    slug: 'property',
    title: 'Property',
    blurb: 'Exceptional homes & property opportunities',
    scene: 'property',
    href: null,
  },
  {
    slug: 'experiences',
    title: 'Experiences',
    blurb: 'Unforgettable luxury experiences',
    scene: 'experiences',
    href: null,
  },
];

export interface InstantPrize {
  readonly label: string;
  readonly remaining: string;
  readonly kind: 'cash' | 'credit';
}

/**
 * PLACEHOLDER — instant wins are Phase 8.
 *
 * The only trace of them in the repository is the RBAC permission string
 * `instant_wins.write`. There is no table, no contract and no API field, so
 * none of these amounts or counts is real.
 */
export const INSTANT_PRIZES: readonly InstantPrize[] = [
  { label: '£50 Cash', remaining: '1 of 1 left', kind: 'cash' },
  { label: '£50 Site Credit', remaining: '0 of 1 left', kind: 'credit' },
  { label: '£10 Site Credit', remaining: '2 of 2 left', kind: 'credit' },
  { label: '£5 Site Credit', remaining: '2 of 2 left', kind: 'credit' },
  { label: '£1 Site Credit', remaining: '10 of 10 left', kind: 'credit' },
];

/** PLACEHOLDER — draws carry no tags, so these are not read from one. */
export const DRAW_TAGS = ['Whisky', 'Rare & exclusive', 'Instant win'] as const;

/**
 * UNSUBSTANTIATED CLAIMS — see the file header.
 *
 * "100% genuine", "verified results" and "where available" are promises about
 * how the business operates. Nothing in this repository backs them.
 */
export const PROMISES = [
  { title: 'Authentic bottles', note: '100% genuine', icon: 'diamond' },
  { title: 'Secure & trusted', note: 'Safe checkout', icon: 'shield' },
  { title: 'Real winners', note: 'Verified results', icon: 'trophy' },
  { title: 'Global shipping', note: 'Where available', icon: 'truck' },
] as const;

/**
 * UNSUBSTANTIATED FIGURES — see the file header.
 *
 * There is no winners table (settlement is a later phase) and no review
 * integration of any kind. Both numbers are invented by the design.
 */
export const SOCIAL_PROOF = {
  winners: '10,000+ winners worldwide',
  rating: '4.9/5',
  reviews: 'from 2,500+ reviews',
} as const;

/** UNSUBSTANTIATED — the Trustpilot score especially. See the file header. */
export const TRUST = [
  { title: '100% secure checkout', note: 'Your details are always protected', icon: 'shield' },
  { title: '4.5/5 on Trustpilot', note: 'Real reviews from real winners', icon: 'star' },
  { title: '10,000+ winners', note: 'People just like you', icon: 'users' },
  { title: 'Exceptional prizes', note: 'Iconic bottles, luxury items & more', icon: 'gift' },
] as const;

/**
 * PLACEHOLDER — no address is configured anywhere in this repository.
 *
 * Taken from the design. A registered address is a legal disclosure; confirm
 * it before launch.
 */
export const COMPANY_ADDRESS = '412, Tower A, Bestech Business Tower, Mohali, Punjab, India';

/**
 * PLACEHOLDER — no social accounts are configured anywhere.
 *
 * `href` is null for every one, so the icons render without linking somewhere
 * that may not be ours. Fill them in when the accounts exist.
 */
export const SOCIALS = [
  { name: 'Facebook', href: null },
  { name: 'Instagram', href: null },
  { name: 'YouTube', href: null },
  { name: 'TikTok', href: null },
] as const;

/** The header's sections. `href` is null where no page exists yet. */
export const NAV = [
  { label: 'Competitions', href: '/#competitions', caret: true },
  { label: 'Winners', href: null, caret: false },
  { label: 'How It Works', href: '/#how-it-works', caret: false },
  { label: 'About', href: null, caret: false },
  { label: 'Contact', href: null, caret: false },
] as const;
