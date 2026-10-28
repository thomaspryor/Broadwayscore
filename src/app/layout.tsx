import type { Metadata } from 'next';
import './globals.css';
import ScrollToTop from '@/components/ScrollToTop';
import HeaderSearch from '@/components/HeaderSearch';
import HeaderSubscribeButton from '@/components/HeaderSubscribeButton';
import FooterEmailCapture from '@/components/FooterEmailCapture';
import FooterAccountBox from '@/components/FooterAccountBox';
import FooterMarketContent from '@/components/FooterMarketContent';
import { isCategoryEnabled } from '@/lib/markets';
import FooterExploreCards from '@/components/FooterExploreCards';
import FooterBranding from '@/components/FooterBranding';
import { generateOrganizationSchema, generateWebSiteSchema, BASE_URL, SITE_OG_IMAGE } from '@/lib/seo';
import { siteRobots } from '@/lib/indexable-deploy';
import { getSiteStats, getMarketStats, getUkRegionalShows } from '@/lib/data-core';
import { getEffectiveMarket } from '@/lib/show-market';
import { ShowMarketProvider } from '@/hooks/useCurrentMarket';
import MarketNav from '@/components/MarketNav';
import AnalyticsWrapper from '@/components/AnalyticsWrapper';
import { ProGateProvider } from '@/contexts/ProGateContext';
import { featureFlags } from '@/config/feature-flags';
import { isFantasyListed } from '@/config/fantasy-listing';
import UserProviders from '@/components/UserProviders';
import HeaderHamburger from '@/components/HeaderHamburger';
import HeaderUserIcon from '@/components/HeaderUserIcon';
import HeaderSecondaryMarketLink from '@/components/HeaderSecondaryMarketLink';
import { ADSENSE_CLIENT } from '@/lib/ads';

// Inter is self-hosted (see the @font-face block at the top of globals.css for
// why next/font/google was removed). This is the one file the browser needs for
// first paint — the latin-ext subset loads on demand via its unicode-range.
const INTER_LATIN_WOFF2 = '/fonts/Inter-latin-var.3100e775.woff2';

export const metadata: Metadata = {
  metadataBase: new URL(BASE_URL),
  title: {
    default: 'Broadway Scorecard - Aggregated Broadway Show Ratings',
    template: '%s | Broadway Scorecard',
  },
  description: 'Comprehensive theater ratings combining critic reviews, AudienceGrade ratings, and community buzz. Find the best shows on Broadway, the West End, and Off-Broadway with transparent, data-driven scores.',
  keywords: ['Broadway', 'West End', 'Off-Broadway', 'theater', 'musicals', 'reviews', 'ratings', 'scorecard', 'critic reviews', 'AudienceGrade'],
  authors: [{ name: 'Broadway Scorecard' }],
  // Link-preview defaults only (BRO-5529). Next fills og:title and
  // og:description from each page's own title and description when openGraph
  // leaves them out, and a page's twitter title, description and image from
  // its openGraph. Set here, the homepage's values overrode them, so every
  // page without its own openGraph (and on X, every page without its own
  // twitter) previewed as the homepage. The homepage sets its own in page.tsx.
  openGraph: {
    type: 'website',
    locale: 'en_US',
    siteName: 'Broadway Scorecard',
    images: [SITE_OG_IMAGE],
  },
  twitter: { card: 'summary_large_image' },
  robots: siteRobots(),
  // Declared as metadata (not a <link> in <head>) so a section can replace it:
  // the Fantasy League sets its own icons in src/app/fantasy/layout.tsx.
  icons: { icon: { url: '/favicon.svg', type: 'image/svg+xml' } },
  alternates: {
    canonical: BASE_URL,
    types: {
      'application/rss+xml': `${BASE_URL}/rss.xml`,
    },
  },
  other: {
    'impact-site-verification': '210ec958-0fb2-4221-8150-3f2fa07d559e',
    // AdSense site verification (BRO-5893). Not the ad script: no ad code
    // loads from this tag.
    'google-adsense-account': ADSENSE_CLIENT,
  },
};


export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { totalReviews } = getSiteStats();
  const marketStats = getMarketStats();
  // Only ship the small set whose venue changes its navigation market.
  const showMarkets = Object.fromEntries(getUkRegionalShows().map(show => [show.slug, getEffectiveMarket(show)]));

  return (
    // suppressHydrationWarning: the Profitability Scorecard gate's boot script sets
    // data-money-unlocked on <html> before hydration (BRO-6210,
    // src/lib/money-gate.ts). One level deep: children still warn.
    <html lang="en" suppressHydrationWarning>
      <head>
        <link
          rel="preload"
          href={INTER_LATIN_WOFF2}
          as="font"
          type="font/woff2"
          crossOrigin="anonymous"
        />
        <link rel="alternate" type="application/rss+xml" title="Broadway Scorecard" href="/rss.xml" />
        {/* Preconnect to image CDN for faster LCP */}
        <link
          rel="preconnect"
          href="https://images.ctfassets.net"
          crossOrigin="anonymous"
        />
        <link
          rel="dns-prefetch"
          href="https://images.ctfassets.net"
        />
        <link
          rel="preconnect"
          href="https://res.cloudinary.com"
          crossOrigin="anonymous"
        />
        <link
          rel="dns-prefetch"
          href="https://res.cloudinary.com"
        />
      </head>
      <body className="min-h-screen font-sans pt-16">
        {/* Site-wide structured data */}
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify([
            generateOrganizationSchema(),
            generateWebSiteSchema(),
          ]) }}
        />
        {/* Skip Link for keyboard navigation */}
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:absolute focus:top-4 focus:left-4 focus:z-[100] focus:px-4 focus:py-2 focus:bg-brand focus:text-white focus:rounded-lg focus:outline-none"
        >
          Skip to main content
        </a>
        <ShowMarketProvider showMarkets={showMarkets}>
        <UserProviders>
          <header className="fixed top-0 left-0 right-0 z-[60] bg-surface-raised border-b border-white/10">
            <nav className="max-w-7xl mx-auto px-3 sm:px-6 lg:px-8">
              <div className="flex items-center justify-between h-16 relative">
                <MarketNav stats={marketStats} />
                {/* gap-1 on mobile: with userAccounts on, this row holds search +
                    avatar + hamburger and overflowed the viewport at gap-3,
                    clipping the avatar (owner report, 2026-07-17).
                    Tablet widths overflowed too (BRO-4575: 946px of content at
                    768): Subscribe shows from xl only (the footer has the email
                    capture), search collapses to its icon below lg, and the
                    Sign in / My Shows label hides below md. Guard:
                    scripts/check-header-overflow.mjs. */}
                <div className="flex items-center shrink-0 gap-1 sm:gap-3">
                  <HeaderSecondaryMarketLink />
                  <div className="hidden xl:block empty:hidden">
                    <HeaderSubscribeButton />
                  </div>
                  <HeaderSearch />
                  <HeaderUserIcon />
                  <HeaderHamburger />
                </div>
              </div>
            </nav>
          </header>
          <ProGateProvider>
            {/* tabIndex={-1} + scroll-mt-16: the skip link above was a DEAD
                CONTROL (ux-walkthrough dead-control detector, mobile__diary_grid,
                card #325). The anchor scrolled to #main-content, but <main> was
                not focusable, so keyboard focus never moved, and it sat under the
                64px fixed header (body pt-16 / header h-16), so on short pages the
                scroll was a no-op too — activating it changed nothing. Making the
                landmark focusable is the canonical skip-link pattern: focus moves
                even when there is nothing to scroll. */}
            <main
              id="main-content"
              tabIndex={-1}
              className="min-h-[calc(100vh-200px)] scroll-mt-16 focus:outline-none"
            >
              {children}
            </main>
          </ProGateProvider>
        {/* The footer sits inside UserProviders on purpose: its email box
            offers email-list members a free account and must know who is
            signed in (BRO-4893). Don't move </UserProviders> back above it. */}
        <footer className="border-t border-white/5 mt-6 sm:mt-8">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 sm:py-12">
            {/* Explore More Theatre — promoted market cards, reordered by current market */}
            {(featureFlags.offBroadway || featureFlags.westEnd) && (
              <FooterExploreCards />
            )}

            <FooterMarketContent
              totalReviews={totalReviews}
              featureFlags={{
                discountTickets: featureFlags.discountTickets,
                tonyPredictions: featureFlags.tonyPredictions,
                tonyPeople: featureFlags.tonyPeople,
                goldLists: featureFlags.goldLists,
                boxOffice: featureFlags.boxOffice,
                commercial: featureFlags.commercial,
                criticPages: featureFlags.criticPages,
                creativePages: featureFlags.creativePages,
                castPages: featureFlags.castPages,
                fantasyLeague: isFantasyListed(),
                tours: isCategoryEnabled('tour'),
              }}
            />

            {/* Email list and free account side by side (BRO-4946): the footer
                used to offer only the email list. grid-cols-1 keeps the phone
                track at minmax(0,1fr): an implicit track sizes to the email
                form's min-content and pushed every page wider than 320-360px
                phones (BRO-4949). */}
            <div className="max-w-3xl mx-auto mb-8 pb-8 border-b border-white/5 grid grid-cols-1 gap-2 md:grid-cols-2 md:gap-10">
              <FooterEmailCapture />
              <FooterAccountBox />
            </div>

            {/* Bottom */}
            <FooterBranding totalReviews={totalReviews} />
          </div>
        </footer>
        </UserProviders>
        </ShowMarketProvider>
        <ScrollToTop />
        <AnalyticsWrapper />
      </body>
    </html>
  );
}
