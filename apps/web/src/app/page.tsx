import type { Market, PublicDrawSummary } from '@hv/contracts';
import type { Metadata } from 'next';
import Link from 'next/link';
import { DrawCountdown } from '@/components/draw-countdown';
import {
  ArrowIcon,
  BottleIcon,
  CardIcon,
  ClockIcon,
  DiamondIcon,
  HeartIcon,
  ListIcon,
  QuestionIcon,
  ShieldIcon,
  TicketIcon,
  TrophyIcon,
} from '@/components/icons';
import { Scene } from '@/components/scene';
import { fetchDraws } from '@/lib/draws';
import { formatCount, formatDateTime, formatPrice } from '@/lib/format';
import { fetchAvailability } from '@/lib/reservations';
import { fetchMarkets } from '@/markets';
import { CATEGORIES, PROMISES, TRUST } from './home-content';

export const metadata: Metadata = {
  // Not "whisky competitions": one category is open and the draws published
  // today are not all whisky. The brand's own positioning in the header is a
  // separate question and is left as it is.
  title: { absolute: 'Highland Vault — exceptional prizes, one fair draw' },
  // Describes the platform, not an inventory: what is actually listed is
  // whatever the API has published.
  description:
    'Prize draws with transparent entry, clear rules and a skill question on every entry.',
};

export const dynamic = 'force-dynamic';

type Entry = { draw: PublicDrawSummary; market: Market };

/**
 * "Win a Macallan Sherry Oak **30 Year Old**".
 *
 * The design sets the tail of the prize in gold italic and leaves the rest in
 * navy, so the eye lands on what makes this bottle the one. The split is by
 * words rather than by a field, because the API has one `headlinePrize` string
 * and no notion of a qualifier.
 *
 * "A week in a Highland lodge" also loses its capital on the article, so the
 * sentence reads "Win a week in a Highland lodge" rather than "Win A week".
 */
function headline(prize: string) {
  const lead = /^(a|an|the) /i.test(prize) ? prize[0]!.toLowerCase() + prize.slice(1) : prize;
  const words = lead.split(' ');
  // Two words is enough to be a qualifier and short enough not to swallow the
  // whole line; below four words there is nothing to split.
  const tail = words.length >= 4 ? words.splice(-2).join(' ') : '';
  return (
    <>
      Win {words.join(' ')}
      {tail && (
        <>
          {' '}
          <em>{tail}</em>
        </>
      )}
    </>
  );
}

const PROMISE_ICONS = {
  question: QuestionIcon,
  ticket: TicketIcon,
  clock: ClockIcon,
  shield: ShieldIcon,
};
const TRUST_ICONS = { ticket: TicketIcon, list: ListIcon, card: CardIcon, clock: ClockIcon };

/** Live before scheduled, soonest closing first, across every open market. */
async function allDraws(markets: Market[]): Promise<Entry[]> {
  const perMarket = await Promise.all(
    markets.map(async (market) => {
      const result = await fetchDraws(market.code);
      return result.ok ? result.draws.map((draw) => ({ draw, market })) : [];
    }),
  );
  const rank = (s: string) => (s === 'live' ? 0 : 1);
  return perMarket
    .flat()
    .filter(({ draw }) => draw.status === 'live' || draw.status === 'scheduled')
    .sort(
      (a, b) =>
        rank(a.draw.status) - rank(b.draw.status) ||
        Date.parse(a.draw.closesAt) - Date.parse(b.draw.closesAt),
    );
}

export default async function HomePage() {
  const markets = (await fetchMarkets()) ?? [];
  const all = markets.length > 0 ? await allDraws(markets) : [];
  const featured = all[0] ?? null;
  const rest = all.slice(1, 4);

  // One request, for the headline draw only. Asking per card is the N+1 this
  // project has refused before; the cards below use the list payload.
  const availability = featured
    ? await fetchAvailability(featured.market.code, featured.draw.slug)
    : null;
  const taken = availability ? availability.total - availability.available : null;
  const percent =
    availability && availability.total > 0 && taken !== null
      ? Math.min(100, Math.round((taken / availability.total) * 100))
      : null;

  const href = (e: Entry) => `/${e.market.code}/draws/${e.draw.slug}`;
  const browse = markets.length === 1 ? `/${markets[0]!.code}/draws` : '#competitions';
  const enterHref = featured ? href(featured) : browse;
  /*
   * The first draw that can actually be entered, which is not always the
   * featured one.
   *
   * `featured` is whatever ranks first, and a scheduled draw ranks above
   * nothing at all — so on a day with no live draw the hero would otherwise
   * invite somebody to enter a competition that has not opened. This is the
   * only thing the hero's call to action is allowed to be built from.
   */
  const open = all.find((e) => e.draw.status === 'live') ?? null;
  const money = (e: Entry) =>
    formatPrice(e.draw.ticketPriceMinor, e.draw.currency, e.market.locale);

  return (
    <main id="main" className="home">
      {/* ================================================================ hero */}
      <section className="hero-shot" aria-labelledby="hero-heading">
        <Scene kind="highland" className="hero-shot__bg" />
        <div className="container hero-shot__inner">
          <div className="hero-shot__copy">
            <p className="rule-eyebrow">
              {/*
                "Featured draw" only when there is one. With no draw to
                feature the hero falls back to the heading the h1 already
                carries, and the eyebrow names the brand instead of announcing
                a feature that is not there.
              */}
              <span className="eyebrow">{featured ? 'Featured draw' : 'Highland Vault'}</span>
              <span className="rule-eyebrow__rule" aria-hidden="true" />
            </p>
            <h1 id="hero-heading" className="hero-shot__title" data-testid="hero-title">
              {featured ? headline(featured.draw.headlinePrize ?? featured.draw.title) : null}
              {!featured && (
                <>
                  Exceptional prizes.
                  <br />
                  <em>One fair draw.</em>
                </>
              )}
            </h1>
            {/*
              The design put a line of copy about a bottle here. The featured
              draw is whatever the API ranks first, and the list payload
              carries no description to put in its place, so this states the
              mechanism instead — both halves of which are true of every draw.
            */}
            <p className="hero-shot__lede">
              Every entry answers a skill question, and your ticket numbers are shown as soon as
              they are held.
            </p>
            <ul className="promise-row" data-testid="hero-values">
              {PROMISES.map((p) => {
                const I = PROMISE_ICONS[p.icon];
                return (
                  <li key={p.title}>
                    <I className="promise-row__icon" />
                    <span>
                      <strong>{p.title}</strong>
                      {p.note}
                    </span>
                  </li>
                );
              })}
            </ul>
            {/*
              The invitation matches what is possible. With a live draw it
              leads to that draw; without one it leads down the page to the
              open-draws section, which states plainly that nothing is open
              rather than sending somebody to a competition they cannot enter.
            */}
            <Link
              className="button button--blue button--lg"
              href={open ? href(open) : '#competitions'}
              data-testid="hero-cta"
            >
              {open ? 'Enter now' : 'View open draws'}
              <ArrowIcon className="button__arrow" />
            </Link>
          </div>

          {/* ------------------------------------------------- the draw card */}
          {featured && (
            <aside className="draw-ticket" data-testid="hero-card" aria-label="This draw">
              <DrawCountdown
                to={
                  featured.draw.status === 'live' ? featured.draw.closesAt : featured.draw.opensAt
                }
                label={featured.draw.status === 'live' ? 'Draw closes in' : 'Draw opens in'}
              />

              {taken !== null && percent !== null && availability && (
                <div className="meter" data-testid="hero-entries">
                  <p className="meter__figures">
                    <strong>{formatCount(taken, featured.market.locale)}</strong>
                    <span className="meter__of">
                      / {formatCount(availability.total, featured.market.locale)} entries
                    </span>
                    <span className="meter__percent">{percent}%</span>
                  </p>
                  <div
                    className="meter__track"
                    role="progressbar"
                    aria-valuenow={percent}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-label="Entries taken"
                  >
                    <span className="meter__fill" style={{ width: `${percent}%` }} />
                  </div>
                </div>
              )}

              <p className="draw-ticket__price">
                <span className="price">{money(featured)}</span>
                <span className="draw-ticket__per">per entry</span>
              </p>

              <Link className="button button--blue button--block" href={enterHref}>
                Enter now
                <ArrowIcon className="button__arrow" />
              </Link>

              {/*
                The design lists "Instant win" and "VIP experience" here.
                Instant wins are a later phase with no table, contract or API
                field, and there is no VIP experience concept anywhere — so
                both would be telling a customer this draw includes something
                it cannot.
              */}
            </aside>
          )}
        </div>
      </section>

      {/* ========================================================== categories */}
      <section className="home-section" aria-labelledby="categories-heading">
        <div className="container">
          <div className="rule-head">
            <h2 id="categories-heading" className="rule-head__title">
              Choose your category
            </h2>
            <span className="rule-head__rule" aria-hidden="true" />
            <p className="rule-head__aside">One category is open; the rest are on the way</p>
          </div>

          <ul className="cat-row" data-testid="categories">
            {CATEGORIES.map((cat, i) => {
              const inner = (
                <>
                  <span className="cat__art">
                    <Scene kind={cat.scene} />
                    {/*
                      On the card, not in a tooltip: a tile that looks like
                      every other tile and leads nowhere reads as broken, and
                      one that looks live promises draws this build has none
                      of. The word is the whole difference.
                    */}
                    {!cat.available && <span className="cat__soon">Coming soon</span>}
                  </span>
                  <span className="cat__body">
                    <span className="cat__head">
                      <BottleIcon className="cat__icon" />
                      <span className="cat__title">{cat.title}</span>
                    </span>
                    <span className="cat__blurb">{cat.blurb}</span>
                    {cat.available && (
                      <span className="cat__go" aria-hidden="true">
                        <ArrowIcon />
                      </span>
                    )}
                  </span>
                </>
              );
              const className = `cat${i === 0 ? ' cat--lead' : ''}`;
              return (
                <li key={cat.slug}>
                  {cat.available ? (
                    // There is no category filter, so the one open category
                    // leads to the listing — the place its draws actually are.
                    <Link className={className} href={browse}>
                      {inner}
                    </Link>
                  ) : (
                    <span className={`${className} cat--inert`} aria-disabled="true">
                      {inner}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      </section>

      {/* ========================================================= whisky draws */}
      <section className="home-section" id="competitions" aria-labelledby="draws-heading">
        <div className="container">
          <div className="section-intro">
            {/*
              The design titles this "Whisky Draws" over a lede about iconic
              bottles from the world's finest distilleries. What is listed
              below is whatever the API has published, which is not whisky by
              definition and is not ours to describe in advance — so the
              heading names the list and the lede describes how entering
              works, both of which stay true whatever the draws turn out to be.
            */}
            <h2 id="draws-heading" className="section-intro__title">
              <BottleIcon className="section-intro__icon" />
              Open Draws
            </h2>
            <p className="section-intro__lede">
              Every draw shows its prize, the price of an entry and the moment it closes, before you
              enter.
            </p>
          </div>

          {!featured ? (
            <div className="empty-state" data-testid="no-draws">
              <h3>No competitions are open right now</h3>
              <p>New draws appear here as soon as they are published.</p>
            </div>
          ) : (
            <>
              {/* ------------------------------------- featured + instant prizes */}
              <div className="showcase">
                <article className="showcase__draw" data-testid="featured-draw">
                  <div className="showcase__media">
                    <span className="showcase__flag">Featured</span>
                    <Scene kind="whisky" />
                  </div>

                  <div className="showcase__body">
                    <div className="showcase__top">
                      <h3 className="showcase__title">
                        <Link href={enterHref}>{featured.draw.title}</Link>
                      </h3>
                      <button type="button" className="heart" aria-label="Save this draw">
                        <HeartIcon />
                      </button>
                    </div>

                    {featured.draw.headlinePrize && (
                      <p className="showcase__prize">{featured.draw.headlinePrize}</p>
                    )}

                    <p className="showcase__price">
                      <span className="price">{money(featured)}</span>
                      <span className="showcase__per">per entry</span>
                    </p>

                    {taken !== null && percent !== null && availability && (
                      <div className="meter meter--warm">
                        <div
                          className="meter__track"
                          role="progressbar"
                          aria-valuenow={percent}
                          aria-valuemin={0}
                          aria-valuemax={100}
                          aria-label="Entries taken"
                        >
                          <span className="meter__fill" style={{ width: `${percent}%` }} />
                        </div>
                        <p className="meter__figures">
                          <span className="meter__of">
                            {formatCount(taken, featured.market.locale)} /{' '}
                            {formatCount(availability.total, featured.market.locale)} entries
                          </span>
                          <span className="meter__percent">{percent}%</span>
                        </p>
                      </div>
                    )}

                    <DrawCountdown
                      to={
                        featured.draw.status === 'live'
                          ? featured.draw.closesAt
                          : featured.draw.opensAt
                      }
                      label={featured.draw.status === 'live' ? 'Draw ends in' : 'Draw opens in'}
                    />

                    <Link className="button button--blue button--block" href={enterHref}>
                      Enter now
                      <ArrowIcon className="button__arrow" />
                    </Link>
                  </div>
                </article>{' '}
              </div>

              {/* ------------------------------------------- the three cards */}
              {rest.length > 0 && (
                <ul className="mini-row" data-testid="home-draws">
                  {rest.map((entry) => (
                    <li key={`${entry.market.code}/${entry.draw.slug}`}>
                      <article className="mini" data-testid="row-card">
                        <div className="mini__media">
                          <Scene kind="whisky" />
                        </div>
                        <div className="mini__body">
                          <div className="mini__top">
                            <h3 className="mini__title">
                              <Link href={href(entry)}>{entry.draw.title}</Link>
                            </h3>
                            <button type="button" className="heart" aria-label="Save this draw">
                              <HeartIcon />
                            </button>
                          </div>
                          {entry.draw.headlinePrize && (
                            <p className="mini__prize">{entry.draw.headlinePrize}</p>
                          )}
                          <p className="mini__price">
                            <span className="price">{money(entry)}</span>
                            <span className="mini__per">per entry</span>
                          </p>
                          <p className="mini__when">
                            <time dateTime={entry.draw.closesAt}>
                              {formatDateTime(
                                entry.draw.closesAt,
                                entry.market.locale,
                                entry.market.code,
                              )}
                            </time>
                          </p>
                          <Link className="button button--blue button--block" href={href(entry)}>
                            Enter now
                            <ArrowIcon className="button__arrow" />
                          </Link>
                        </div>
                        <div className="mini__ends">
                          <DrawCountdown
                            to={
                              entry.draw.status === 'live'
                                ? entry.draw.closesAt
                                : entry.draw.opensAt
                            }
                            label={entry.draw.status === 'live' ? 'Ends in' : 'Opens in'}
                          />
                        </div>
                      </article>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      </section>

      {/* ============================================================== banner */}
      <section className="home-section home-section--flush" aria-labelledby="discover-heading">
        <div className="container">
          <div className="banner">
            <Scene kind="barrels" className="banner__bg" />
            <DiamondIcon className="banner__icon" />
            {/*
              "Discover rare whiskies · From iconic distilleries to limited
              editions" described a cellar nobody here can vouch for. The band
              keeps its weight and says what the platform is instead: the tone
              is the design's, the claim is gone.
            */}
            <div className="banner__copy">
              <h2 id="discover-heading" className="banner__title">
                Exceptional prizes, one fair draw
              </h2>
              <p>
                A numbered ticket, a question of skill and a closing time you can see. Nothing
                hidden, nothing weighted.
              </p>
            </div>
            <Link className="button button--sand" href={browse}>
              See the open draws
              <ArrowIcon className="button__arrow" />
            </Link>
          </div>
        </div>
      </section>

      {/* ========================================================= how it works */}
      <section className="home-section" id="how-it-works" aria-labelledby="how-heading">
        <div className="container">
          <div className="rule-head">
            <h2 id="how-heading" className="rule-head__title">
              How it works
            </h2>
            <span className="rule-head__rule" aria-hidden="true" />
          </div>

          <ol className="flow">
            {[
              {
                Icon: ListIcon,
                title: 'Choose a Category',
                note: 'Browse our exciting competitions.',
              },
              {
                Icon: TicketIcon,
                title: 'Select a Draw',
                note: 'Pick your favourite prize and choose your entries.',
              },
              {
                Icon: QuestionIcon,
                title: 'Enter & Win',
                note: 'Complete your entry securely online.',
              },
              {
                Icon: TrophyIcon,
                // Settlement and winner selection are a later phase, so this
                // describes what happens without implying it happens yet.
                title: 'Draw Outcome',
                note: 'See the result once the draw has closed and been settled.',
              },
            ].map((step, i) => (
              <li className="flow__step" key={step.title}>
                <span className="flow__disc" aria-hidden="true">
                  <step.Icon />
                </span>
                <div>
                  <h3 className="flow__title">
                    <span className="flow__number">{i + 1}.</span> {step.title}
                  </h3>
                  <p>{step.note}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* =========================================================== trust strip */}
      <section className="trust-strip" aria-labelledby="trust-heading">
        <div className="container">
          <h2 id="trust-heading" className="visually-hidden">
            What to expect
          </h2>
          <ul className="trust-strip__row" data-testid="trust-strip">
            {TRUST.map((item) => {
              const I = TRUST_ICONS[item.icon];
              return (
                <li key={item.title}>
                  <I className="trust-strip__icon" />
                  <span>
                    <strong>{item.title}</strong>
                    {item.note}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      </section>
    </main>
  );
}
