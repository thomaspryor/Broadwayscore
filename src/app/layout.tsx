import type { Metadata } from 'next';
import './globals.css';
import Link from 'next/link';
import ScrollToTop from '@/components/ScrollToTop';

const BASE_URL = 'https://thomaspryor.github.io/Broadwayscore';

export const metadata: Metadata = {
  metadataBase: new URL(BASE_URL),
  title: {
    default: 'BroadwayMetaScores - Aggregated Broadway Show Ratings',
    template: '%s | BroadwayMetaScores',
  },
  description: 'Aggregated Broadway show ratings from top critics. Find the best shows on Broadway with transparent, data-driven metascores.',
  keywords: ['Broadway', 'theater', 'musicals', 'reviews', 'ratings', 'metascore', 'critic reviews'],
  authors: [{ name: 'BroadwayMetaScores' }],
  openGraph: {
    type: 'website',
    locale: 'en_US',
    url: BASE_URL,
    siteName: 'BroadwayMetaScores',
    title: 'BroadwayMetaScores - Aggregated Broadway Show Ratings',
    description: 'Aggregated Broadway show ratings from top critics. Transparent, data-driven metascores.',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'BroadwayMetaScores',
    description: 'Aggregated Broadway show ratings from top critics.',
  },
  robots: {
    index: true,
    follow: true,
  },
};

function BottomNav() {
  return (
    <nav className="fixed bottom-0 left-0 right-0 z-50 bg-surface-dark/95 backdrop-blur-lg border-t border-white/10 sm:hidden">
      <div className="flex items-center justify-around h-16">
        <Link href="/" className="flex flex-col items-center gap-1 px-4 py-2 text-gray-400 hover:text-brand active:text-brand transition-colors rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand">
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
          </svg>
          <span className="text-[10px] font-medium">Shows</span>
        </Link>
        <Link href="/#search" className="flex flex-col items-center gap-1 px-4 py-2 text-gray-400 hover:text-brand active:text-brand transition-colors rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand">
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <span className="text-[10px] font-medium">Search</span>
        </Link>
        <Link href="/methodology" className="flex flex-col items-center gap-1 px-4 py-2 text-gray-400 hover:text-brand active:text-brand transition-colors rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand">
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <span className="text-[10px] font-medium">Info</span>
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
        <link rel="canonical" href={BASE_URL} />
      </head>
      <body className="min-h-screen font-sans pb-16 sm:pb-0">
        <header className="glass sticky top-0 z-50">
          <nav className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="flex items-center justify-between h-16 sm:h-18">
              <Link href="/" className="flex items-center group rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-surface">
                <span className="text-xl sm:text-2xl font-extrabold text-white tracking-tight">Broadway</span>
                <span className="text-xl sm:text-2xl font-extrabold text-gradient tracking-tight">MetaScores</span>
              </Link>
              <div className="hidden sm:flex items-center gap-1">
                <Link href="/" className="nav-link nav-link-active rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand">
                  Shows
                </Link>
                <Link href="/methodology" className="nav-link rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand">
                  How It Works
                </Link>
              </div>
            </div>
          </nav>
        </header>
        <main className="min-h-[calc(100vh-200px)]">{children}</main>
        <footer className="border-t border-white/5 mt-12 sm:mt-16 hidden sm:block">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 sm:py-12">
            <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
              <div className="flex items-center">
                <span className="text-lg font-bold text-white">Broadway</span>
                <span className="text-lg font-bold text-gradient">MetaScores</span>
              </div>
              <div className="flex items-center gap-6 text-sm text-gray-400">
                <Link href="/methodology" className="hover:text-white transition-colors">
                  Methodology
                </Link>
                <span className="text-gray-600">|</span>
                <span>Aggregated critic reviews</span>
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
