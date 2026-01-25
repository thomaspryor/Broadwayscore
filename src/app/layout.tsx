import type { Metadata } from 'next';
import './globals.css';
import Link from 'next/link';
import ScrollToTop from '@/components/ScrollToTop';
import { generateOrganizationSchema, generateWebSiteSchema, BASE_URL } from '@/lib/seo';
import { getAllShows } from '@/lib/data';

// Get top 3 show posters for homepage OG image
function getTopShowPosters(): string[] {
  try {
    const shows = getAllShows();
    return shows
      .filter(show => show.status === 'open' && show.criticScore?.score && show.images?.poster)
      .sort((a, b) => (b.criticScore?.score || 0) - (a.criticScore?.score || 0))
      .slice(0, 3)
      .map(show => show.images!.poster!)
      .filter((url): url is string => !!url);
  } catch {
    return [];
  }
}

const topPosters = getTopShowPosters();
const homeOgParams = new URLSearchParams({
  type: 'home',
  ...(topPosters.length > 0 && { posters: topPosters.join(',') }),
});
const homeOgImageUrl = `${BASE_URL}/api/og?${homeOgParams.toString()}`;

export const metadata: Metadata = {
  metadataBase: new URL(BASE_URL),
  title: {
    default: 'Broadway Scorecard - Aggregated Broadway Show Ratings',
    template: '%s | Broadway Scorecard',
  },
  description: 'Comprehensive Broadway show ratings combining critic reviews, audience scores, and community buzz. Find the best shows on Broadway with transparent, data-driven scores.',
  keywords: ['Broadway', 'theater', 'musicals', 'reviews', 'ratings', 'scorecard', 'critic reviews', 'audience scores'],
  authors: [{ name: 'Broadway Scorecard' }],
  openGraph: {
    type: 'website',
    locale: 'en_US',
    url: BASE_URL,
    siteName: 'Broadway Scorecard',
    title: 'Broadway Scorecard - Aggregated Broadway Show Ratings',
    description: 'Comprehensive Broadway show ratings combining critic reviews, audience scores, and community buzz.',
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
    description: 'Aggregated Broadway show ratings from critics, audiences, and community buzz.',
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
};

function BottomNav() {
  return (
    <nav
      className="fixed bottom-0 left-0 right-0 z-50 bg-surface/98 backdrop-blur-sm border-t border-white/10 sm:hidden safe-area-bottom"
      aria-label="Mobile navigation"
    >
      <div className="flex items-center justify-around h-16">
        <Link href="/" className="flex flex-col items-center justify-center gap-0.5 min-w-[72px] min-h-[48px] text-brand" aria-current="page">
          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
          </svg>
          <span className="text-xs font-medium">Home</span>
        </Link>
        <Link href="/#search" className="flex flex-col items-center justify-center gap-0.5 min-w-[72px] min-h-[48px] text-gray-400 hover:text-white transition-colors">
          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <span className="text-xs font-medium">Search</span>
        </Link>
        <Link href="/methodology" className="flex flex-col items-center justify-center gap-0.5 min-w-[72px] min-h-[48px] text-gray-400 hover:text-white transition-colors">
          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <span className="text-xs font-medium">Info</span>
        </Link>
      </div>
    </nav>
  );
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <head>
        <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
        <link rel="canonical" href={BASE_URL} />
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
        {/* Preload Inter font for faster text rendering */}
        <link
          rel="preconnect"
          href="https://fonts.googleapis.com"
          crossOrigin="anonymous"
        />
        <link
          rel="preconnect"
          href="https://fonts.gstatic.com"
          crossOrigin="anonymous"
        />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap"
          rel="stylesheet"
        />
        {/* Preconnect to image CDN for faster image loading */}
        <link rel="preconnect" href="https://images.ctfassets.net" />
        <link rel="dns-prefetch" href="https://images.ctfassets.net" />
      </head>
      <body className="min-h-screen font-sans pb-16 sm:pb-0">
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
        <header className="sticky top-0 z-50 bg-surface-raised/95 backdrop-blur-sm border-b border-white/10">
          <nav className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="flex items-center justify-between h-16 sm:h-18">
              <Link href="/" className="flex items-center group">
                <span className="text-xl sm:text-2xl font-extrabold text-white tracking-tight">Broadway</span>
                <span className="text-xl sm:text-2xl font-extrabold text-gradient tracking-tight">Scorecard</span>
              </Link>
              <div className="hidden sm:flex items-center gap-1">
                <Link href="/" className="nav-link nav-link-active">
                  Shows
                </Link>
                <Link href="/methodology" className="nav-link">
                  How It Works
                </Link>
              </div>
            </div>
          </nav>
        </header>
        <main id="main-content" className="min-h-[calc(100vh-200px)]">{children}</main>
        <footer className="border-t border-white/5 mt-12 sm:mt-16 hidden sm:block">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 sm:py-12">
            {/* Browse Categories */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-8 mb-8 pb-8 border-b border-white/5">
              <div>
                <h4 className="text-sm font-semibold text-white uppercase tracking-wide mb-3">By Category</h4>
                <ul className="space-y-2 text-sm text-gray-400">
                  <li><Link href="/browse/best-broadway-musicals" className="hover:text-white transition-colors">Best Musicals</Link></li>
                  <li><Link href="/browse/best-broadway-dramas" className="hover:text-white transition-colors">Best Dramas</Link></li>
                  <li><Link href="/browse/best-broadway-comedies" className="hover:text-white transition-colors">Comedies</Link></li>
                  <li><Link href="/browse/best-broadway-revivals" className="hover:text-white transition-colors">Revivals</Link></li>
                </ul>
              </div>
              <div>
                <h4 className="text-sm font-semibold text-white uppercase tracking-wide mb-3">By Audience</h4>
                <ul className="space-y-2 text-sm text-gray-400">
                  <li><Link href="/browse/broadway-shows-for-kids" className="hover:text-white transition-colors">Shows for Kids</Link></li>
                  <li><Link href="/browse/broadway-shows-for-date-night" className="hover:text-white transition-colors">Date Night</Link></li>
                  <li><Link href="/browse/broadway-shows-for-tourists" className="hover:text-white transition-colors">For Tourists</Link></li>
                  <li><Link href="/browse/first-time-broadway" className="hover:text-white transition-colors">First-Timers</Link></li>
                </ul>
              </div>
              <div>
                <h4 className="text-sm font-semibold text-white uppercase tracking-wide mb-3">Deals & Tickets</h4>
                <ul className="space-y-2 text-sm text-gray-400">
                  <li><Link href="/browse/broadway-lottery-shows" className="hover:text-white transition-colors">Lottery Shows</Link></li>
                  <li><Link href="/browse/broadway-rush-tickets" className="hover:text-white transition-colors">Rush Tickets</Link></li>
                  <li><Link href="/browse/short-broadway-shows" className="hover:text-white transition-colors">Short Shows</Link></li>
                  <li><Link href="/browse/broadway-shows-closing-soon" className="hover:text-white transition-colors">Closing Soon</Link></li>
                </ul>
              </div>
              <div>
                <h4 className="text-sm font-semibold text-white uppercase tracking-wide mb-3">More</h4>
                <ul className="space-y-2 text-sm text-gray-400">
                  <li><Link href="/browse/tony-winners-on-broadway" className="hover:text-white transition-colors">Tony Winners</Link></li>
                  <li><Link href="/browse/jukebox-musicals-on-broadway" className="hover:text-white transition-colors">Jukebox Musicals</Link></li>
                  <li><Link href="/broadway-theaters-map" className="hover:text-white transition-colors">Theater Map</Link></li>
                  <li><Link href="/methodology" className="hover:text-white transition-colors">How It Works</Link></li>
                </ul>
              </div>
            </div>

            {/* Bottom */}
            <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
              <div className="flex items-center">
                <span className="text-lg font-bold text-white">Broadway</span>
                <span className="text-lg font-bold text-gradient">Scorecard</span>
              </div>
              <div className="flex items-center gap-6 text-sm text-gray-400">
                <Link href="/methodology" className="hover:text-white transition-colors">
                  Methodology
                </Link>
                <span className="text-gray-600">|</span>
                <span>Data from critics, audiences & Reddit</span>
              </div>
            </div>
            <p className="mt-6 pt-6 border-t border-white/5 text-center text-xs text-gray-500">
              All ratings and reviews belong to their respective sources.
            </p>
          </div>
        </footer>
        <BottomNav />
        <ScrollToTop />
      </body>
    </html>
  );
}
