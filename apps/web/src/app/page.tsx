import type { Market, PublicDrawSummary } from '@hv/contracts';
import type { Metadata } from 'next';
import Link from 'next/link';
import { DrawCountdown } from '@/components/draw-countdown';
import {
  ArrowIcon,
  BottleIcon,
  CardIcon,
  CashIcon,
  DiamondIcon,
  GiftIcon,
  HeartIcon,
  ListIcon,
  QuestionIcon,
  ShieldIcon,
  StarIcon,
  TicketIcon,
  TrophyIcon,
  TruckIcon,
  UsersIcon,
} from '@/components/icons';
import { Scene } from '@/components/scene';
import { fetchDraws } from '@/lib/draws';
import { formatCount, formatDateTime, formatPrice } from '@/lib/format';
import { fetchAvailability } from '@/lib/reservations';
import { fetchMarkets } from '@/markets';
import {
  CATEGORIES,
  DRAW_TAGS,
  INSTANT_PRIZES,
  PROMISES,
  SOCIAL_PROOF,
  TRUST,
} from './home-content';

export const metadata: Metadata = {
  title: { absolute: 'Highland Vault — whisky competitions' },
  description:
    'Rare bottles, collector’s editions and exceptional prizes. Transparent entry, clear rules and a skill question on every entry.',
};

export const dynamic = 'force-dynamic';

type Entry = { draw: PublicDrawSummary; market: Market };

const PROMISE_ICONS = {
  diamond: DiamondIcon,
  shield: ShieldIcon,
  trophy: TrophyIcon,
  truck: TruckIcon,
};
const TRUST_ICONS = { shield: ShieldIcon, star: StarIcon, users: UsersIcon, gift: GiftIcon };

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
              <span className="eyebrow">Featured draw</span>
              <span className="rule-eyebrow__rule" aria-hidden="true" />
            </p>

            <h1 id="hero-heading" className="hero-shot__title" data-testid="hero-title">
              {featured ? (
                <>
                  Win <em>{featured.draw.headlinePrize ?? featured.draw.title}</em>
                </>
              ) : (
                <>
                  Exceptional prizes.
                  <br />
                  <em>One fair draw.</em>
                </>
              )}
            </h1>

            <p className="hero-shot__lede">
              A legendary expression. A once-in-a-lifetime opportunity.
            </p>

            <ul className="tag-row" data-testid="hero-badges">
              {DRAW_TAGS.map((tag, i) => (
                <li key={tag}>
                  <span className="tag">
                    {i === 0 ? (
                      <BottleIcon className="tag__icon" />
                    ) : i === 1 ? (
                      <DiamondIcon className="tag__icon" />
                    ) : (
                      <TicketIcon className="tag__icon" />
                    )}
                    {tag}
                  </span>
                </li>
              ))}
            </ul>

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

            <Link className="button button--blue button--lg" href={enterHref}>
              Enter now
              <ArrowIcon className="button__arrow" />
            </Link>

            <div className="proof" data-testid="social-proof">
              <span className="proof__faces" aria-hidden="true">
                <span />
                <span />
                <span />
              </span>
              <span className="proof__copy">
                <strong>{SOCIAL_PROOF.winners}</strong>
                <span className="proof__stars">
                  {[0, 1, 2, 3, 4].map((i) => (
                    <StarIcon key={i} />
                  ))}
                  <span>
                    {SOCIAL_PROOF.rating} {SOCIAL_PROOF.reviews}
                  </span>
                </span>
              </span>
            </div>
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

              <ul className="draw-ticket__notes">
                <li>
                  <TicketIcon className="draw-ticket__note-icon" />
                  Instant win
                </li>
                <li>
                  <StarIcon className="draw-ticket__note-icon" />
                  VIP experience
                </li>
              </ul>
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
            <p className="rule-head__aside">Select a category to view its current draws</p>
          </div>

          <ul className="cat-row" data-testid="categories">
            {CATEGORIES.map((cat, i) => {
              const inner = (
                <>
                  <span className="cat__art">
                    <Scene kind={cat.scene} />
                  </span>
                  <span className="cat__body">
                    <span className="cat__head">
                      <BottleIcon className="cat__icon" />
                      <span className="cat__title">{cat.title}</span>
                    </span>
                    <span className="cat__blurb">{cat.blurb}</span>
                    <span className="cat__go" aria-hidden="true">
                      <ArrowIcon />
                    </span>
                  </span>
                </>
              );
              const className = `cat${i === 0 ? ' cat--lead' : ''}`;
              return (
                <li key={cat.slug}>
                  {cat.href ? (
                    <Link className={className} href={cat.href}>
                      {inner}
                    </Link>
                  ) : (
                    // No category endpoint exists, so these lead nowhere yet.
                    <span className={`${className} cat--inert`}>{inner}</span>
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
            <h2 id="draws-heading" className="section-intro__title">
              <BottleIcon className="section-intro__icon" />
              Whisky draws
            </h2>
            <p className="section-intro__lede">
              Iconic bottles, rare releases and collector’s editions from the world’s finest
              distilleries.
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

                    <ul className="tag-row tag-row--sm">
                      <li>
                        <span className="tag tag--green">
                          <DiamondIcon className="tag__icon" />
                          {DRAW_TAGS[1]}
                        </span>
                      </li>
                      <li>
                        <span className="tag tag--blue">
                          <TicketIcon className="tag__icon" />
                          {DRAW_TAGS[2]}
                        </span>
                      </li>
                    </ul>

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
                </article>

                {/* Placeholder content: instant wins are Phase 8 and have no
                    table, contract or API field. See `home-content.ts`. */}
                <aside className="instant" aria-labelledby="instant-heading" data-testid="instant">
                  <div className="instant__head">
                    <GiftIcon className="instant__head-icon" />
                    <h3 id="instant-heading">Instant prizes in this draw</h3>
                    <span className="instant__help">How instant prizes work →</span>
                  </div>

                  <ul className="instant__grid">
                    {INSTANT_PRIZES.map((prize) => (
                      <li key={prize.label} className="ip">
                        <span className="ip__art">
                          {prize.kind === 'cash' ? <CashIcon /> : <CardIcon />}
                        </span>
                        <span className="ip__label">{prize.label}</span>
                        <span className="ip__left">{prize.remaining}</span>
                        <span className="ip__kind">
                          {prize.kind === 'cash' ? 'Cash' : 'Site credit'}
                        </span>
                      </li>
                    ))}
                  </ul>

                  <ul className="instant__foot">
                    <li>
                      <DiamondIcon />
                      <span>
                        <strong>Verified product</strong>100% genuine
                      </span>
                    </li>
                    <li>
                      <TruckIcon />
                      <span>
                        <strong>Worldwide shipping</strong>Where available
                      </span>
                    </li>
                    <li>
                      <ShieldIcon />
                      <span>
                        <strong>Secure checkout</strong>Your details are protected
                      </span>
                    </li>
                  </ul>
                </aside>
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
                          <ul className="tag-row tag-row--sm">
                            <li>
                              <span className="tag tag--green">{DRAW_TAGS[1]}</span>
                            </li>
                            <li>
                              <span className="tag tag--blue">{DRAW_TAGS[2]}</span>
                            </li>
                          </ul>
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
            <div className="banner__copy">
              <h2 id="discover-heading" className="banner__title">
                Discover rare whiskies
              </h2>
              <p>
                From iconic distilleries to limited editions. Exceptional bottles. Extraordinary
                stories.
              </p>
            </div>
            <Link className="button button--sand" href={browse}>
              Explore whisky draws
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
                title: 'See the Results',
                note: 'Follow your order and see the outcome when the draw is settled.',
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
