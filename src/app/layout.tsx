import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';
import Link from 'next/link';
import ScrollToTop from '@/components/ScrollToTop';

const inter = Inter({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-inter',
});

const BASE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://broadwayscore-ayv17ggvd-thomaspryors-projects.vercel.app';

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
  alternates: {
    canonical: BASE_URL,
  },
};

// Organization schema for search engine knowledge panel
const organizationSchema = {
  '@context': 'https://schema.org',
  '@type': 'Organization',
  name: 'BroadwayMetaScores',
  url: BASE_URL,
  description: 'Aggregated Broadway show ratings from professional critics. Find the best shows on Broadway based on weighted critic review scores.',
  sameAs: [],
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className={`${inter.className} min-h-screen pb-16 sm:pb-0`}>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(organizationSchema) }}
        />
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
        <ScrollToTop />
      </body>
    </html>
  );
}
