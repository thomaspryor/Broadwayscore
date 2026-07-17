import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';
import ScrollToTop from '@/components/ScrollToTop';
import HeaderSearch from '@/components/HeaderSearch';
import HeaderSubscribeButton from '@/components/HeaderSubscribeButton';
import FooterEmailCapture from '@/components/FooterEmailCapture';
import FooterMarketContent from '@/components/FooterMarketContent';
import FooterExploreCards from '@/components/FooterExploreCards';
import FooterBranding from '@/components/FooterBranding';
import { generateOrganizationSchema, generateWebSiteSchema, BASE_URL } from '@/lib/seo';
import { getDataStats, getMarketStats } from '@/lib/data-core';
import MarketNav from '@/components/MarketNav';
import AnalyticsWrapper from '@/components/AnalyticsWrapper';
import { ProGateProvider } from '@/contexts/ProGateContext';
import { featureFlags } from '@/config/feature-flags';
import UserProviders from '@/components/UserProviders';
import HeaderHamburger from '@/components/HeaderHamburger';
import HeaderUserIcon from '@/components/HeaderUserIcon';
import HeaderSecondaryMarketLink from '@/components/HeaderSecondaryMarketLink';

const inter = Inter({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700', '800', '900'],
  display: 'swap',
  variable: '--font-inter',
});

// Static OG image (API routes don't work with static export)
const homeOgImageUrl = `${BASE_URL}/og/home.png`;

export const metadata: Metadata = {
  metadataBase: new URL(BASE_URL),
  title: {
    default: 'Broadway Scorecard - Aggregated Broadway Show Ratings',
    template: '%s | Broadway Scorecard',
  },
  description: 'Comprehensive theater ratings combining critic reviews, AudienceGrade ratings, and community buzz. Find the best shows on Broadway, the West End, and Off-Broadway with transparent, data-driven scores.',
  keywords: ['Broadway', 'West End', 'Off-Broadway', 'theater', 'musicals', 'reviews', 'ratings', 'scorecard', 'critic reviews', 'AudienceGrade'],
  authors: [{ name: 'Broadway Scorecard' }],
  openGraph: {
    type: 'website',
    locale: 'en_US',
    url: BASE_URL,
    siteName: 'Broadway Scorecard',
    title: 'Broadway Scorecard - Aggregated Broadway Show Ratings',
    description: 'Comprehensive theater ratings combining critic reviews, AudienceGrade ratings, and community buzz for Broadway, West End, and Off-Broadway.',
    images: [{
      url: homeOgImageUrl,
      width: 1200,
      height: 630,
      alt: 'Broadway Scorecard - Aggregated Broadway Show Ratings',
    }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Broadway Scorecard',
    description: 'Aggregated theater ratings from critics, audiences, and community buzz for Broadway, West End, and Off-Broadway.',
    images: [{
      url: homeOgImageUrl,
      width: 1200,
      height: 630,
      alt: 'Broadway Scorecard - Aggregated Broadway Show Ratings',
    }],
  },
  robots: {
    index: true,
    follow: true,
  },
  alternates: {
    canonical: BASE_URL,
    types: {
      'application/rss+xml': `${BASE_URL}/rss.xml`,
    },
  },
  other: {
    'impact-site-verification': '210ec958-0fb2-4221-8150-3f2fa07d559e',
  },
};


export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { totalReviews } = getDataStats();
  const marketStats = getMarketStats();

  return (
    <html lang="en" className={inter.variable}>
      <head>
        <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
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
        <UserProviders>
          <header className="fixed top-0 left-0 right-0 z-[60] bg-surface-raised border-b border-white/10">
            <nav className="max-w-7xl mx-auto px-3 sm:px-6 lg:px-8">
              <div className="flex items-center justify-between h-16 relative">
                <MarketNav stats={marketStats} />
                {/* gap-1 on mobile: with userAccounts on, this row holds search +
                    avatar + hamburger and overflowed the viewport at gap-3,
                    clipping the avatar (owner report, 2026-07-17). */}
                <div className="flex items-center shrink-0 gap-1 sm:gap-3">
                  <HeaderSecondaryMarketLink />
                  <div className="hidden sm:block">
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
            <main id="main-content" className="min-h-[calc(100vh-200px)]">{children}</main>
          </ProGateProvider>
        </UserProviders>
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
              }}
            />

            {/* Email Capture */}
            <div className="max-w-md mx-auto mb-8 pb-8 border-b border-white/5">
              <FooterEmailCapture />
            </div>

            {/* Bottom */}
            <FooterBranding totalReviews={totalReviews} />
          </div>
        </footer>
        <ScrollToTop />
        <AnalyticsWrapper />
      </body>
    </html>
  );
}
