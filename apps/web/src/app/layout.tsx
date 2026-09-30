import type { Metadata, Viewport } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { BrandMark } from '@/components/brand-mark';
import {
  ArrowIcon,
  CaretIcon,
  CartIcon,
  SearchIcon,
  SocialIcon,
  UserIcon,
} from '@/components/icons';
import { fetchMarkets } from '@/markets';
import { COMPANY_ADDRESS, NAV, SOCIALS } from './home-content';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'Highland Vault', template: '%s · Highland Vault' },
  description: 'Whisky competitions from Highland Vault.',
  // Not for indexing until launch. Several claims in the footer and on the
  // homepage are unsubstantiated placeholders (see `home-content.ts`), so this
  // must stay off until they are verified or removed.
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#ffffff',
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  // The footer lists the markets that are actually open, which only the API
  // knows (ADR-0005). A failed lookup is an empty list: a footer is not worth
  // failing a page over.
  const markets = (await fetchMarkets()) ?? [];
  const searchHref = markets.length === 1 ? `/${markets[0]!.code}/draws` : '/#competitions';
  const basketHref = markets.length === 1 ? `/${markets[0]!.code}/basket` : '/#competitions';

  return (
    <html lang="en">
      <body>
        <a className="visually-hidden" href="#main">
          Skip to content
        </a>

        <header className="site-header">
          <div className="container site-header__inner">
            <Link href="/" className="brand">
              <BrandMark />
              <span className="brand__name">
                Highland Vault
                <small className="brand__tag">Whisky competitions</small>
              </span>
            </Link>

            <nav className="site-nav" aria-label="Sections">
              {NAV.map((item) =>
                item.href ? (
                  <Link key={item.label} href={item.href}>
                    {item.label}
                    {item.caret && <CaretIcon className="site-nav__caret" />}
                  </Link>
                ) : (
                  // No page exists for this yet, so it is text rather than a
                  // link that would 404.
                  <span key={item.label} className="site-nav__soon" aria-disabled="true">
                    {item.label}
                  </span>
                ),
              )}
            </nav>

            <div className="site-header__actions">
              <Link className="icon-link" href={searchHref} aria-label="Search">
                <SearchIcon />
              </Link>
              <Link className="icon-link icon-link--labelled" href="/account">
                <UserIcon />
                <span>My Account</span>
              </Link>
              {/* The basket is per market, and its contents need a signed-in
                  request the header does not make, so no count is shown. */}
              <Link className="icon-link icon-link--cart" href={basketHref} aria-label="Basket">
                <CartIcon />
              </Link>
              <Link className="button button--blue button--sm" href="/#competitions">
                Enter now
                <ArrowIcon className="button__arrow" />
              </Link>
            </div>
          </div>
        </header>

        {children}

        <footer className="site-footer">
          <div className="container site-footer__inner">
            <div className="site-footer__brand">
              <Link href="/" className="brand">
                <BrandMark />
                <span className="brand__name">
                  Highland Vault
                  <small className="brand__tag">Whisky competitions</small>
                </span>
              </Link>
            </div>

            <nav className="site-footer__nav" aria-label="Footer">
              {NAV.map((item) =>
                item.href ? (
                  <Link key={item.label} href={item.href}>
                    {item.label}
                  </Link>
                ) : (
                  <span key={item.label} className="site-footer__soon" aria-disabled="true">
                    {item.label}
                  </span>
                ),
              )}
            </nav>

            {/* Placeholder: no social account is configured in this repository,
                so the marks render without linking somewhere that may not be
                ours. See `home-content.ts`. */}
            <ul className="site-footer__social">
              {SOCIALS.map((s) => (
                <li key={s.name}>
                  <span className="social" title={s.name}>
                    <SocialIcon name={s.name} />
                    <span className="visually-hidden">{s.name}</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>

          <div className="container site-footer__base">
            {/* Placeholder: taken from the design. A registered address is a
                legal disclosure — confirm it before launch. */}
            <p className="site-footer__address">{COMPANY_ADDRESS}</p>
            <p className="site-footer__legal">
              © {new Date().getFullYear()} Highland Vault · Pre-release build. Tickets can be added
              to a basket, bought and paid for; a live payment provider has not been chosen yet.
            </p>
            {markets.length > 0 && (
              <p className="site-footer__markets">
                {markets.map((m, i) => (
                  <span key={m.code}>
                    {i > 0 && ' · '}
                    <Link href={`/${m.code}/draws`}>
                      {m.name} <span className="site-footer__meta">{m.currency}</span>
                    </Link>
                  </span>
                ))}
              </p>
            )}
          </div>
        </footer>
      </body>
    </html>
  );
}
