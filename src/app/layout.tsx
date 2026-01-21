import type { Metadata } from 'next';
import './globals.css';
import Link from 'next/link';

const BASE_URL = 'https://thomaspryor.github.io/Broadwayscore';

export const metadata: Metadata = {
  metadataBase: new URL(BASE_URL),
  title: {
    default: 'Broadway Metascore - Aggregated Broadway Show Ratings',
    template: '%s | Broadway Metascore',
  },
  description: 'Comprehensive Broadway show ratings combining critic reviews, audience scores, and community buzz. Find the best shows on Broadway with transparent, data-driven scores.',
  keywords: ['Broadway', 'theater', 'musicals', 'reviews', 'ratings', 'metascore', 'critic reviews', 'audience scores'],
  authors: [{ name: 'Broadway Metascore' }],
  openGraph: {
    type: 'website',
    locale: 'en_US',
    url: BASE_URL,
    siteName: 'Broadway Metascore',
    title: 'Broadway Metascore - Aggregated Broadway Show Ratings',
    description: 'Comprehensive Broadway show ratings combining critic reviews, audience scores, and community buzz.',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Broadway Metascore',
    description: 'Aggregated Broadway show ratings from critics, audiences, and community buzz.',
  },
  robots: {
    index: true,
    follow: true,
  },
};

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
      <body className="font-sans min-h-screen">
        <header className="border-b border-gray-700/50 bg-surface-raised/95 backdrop-blur-sm sticky top-0 z-50">
          <nav className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="flex items-center justify-between h-14 sm:h-16">
              <Link href="/" className="flex items-center gap-1.5 sm:gap-2 group">
                <span className="text-lg sm:text-2xl font-bold text-white">Broadway</span>
                <span className="text-lg sm:text-2xl font-bold text-brand group-hover:text-brand-hover transition">Metascore</span>
              </Link>
              <div className="flex items-center gap-1 sm:gap-2">
                <Link href="/" className="btn-ghost text-sm">
                  Shows
                </Link>
                <Link href="/methodology" className="btn-ghost text-sm">
                  How It Works
                </Link>
              </div>
            </div>
          </nav>
        </header>
        <main className="min-h-[calc(100vh-180px)]">{children}</main>
        <footer className="border-t border-gray-700/50 mt-8 sm:mt-12 py-6 sm:py-8 text-center text-gray-400 text-xs sm:text-sm px-4">
          <p className="max-w-xl mx-auto">Broadway Metascore aggregates critic reviews, audience ratings, and community discussion.</p>
          <p className="mt-2">
            All ratings and reviews belong to their respective sources.{' '}
            <Link href="/methodology" className="text-brand hover:underline">
              See methodology
            </Link>
            .
          </p>
        </footer>
      </body>
    </html>
  );
}
