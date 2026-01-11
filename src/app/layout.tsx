import type { Metadata } from 'next';
import './globals.css';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'Broadway Metascore',
  description: 'Comprehensive Broadway show ratings combining critic reviews, audience scores, and community buzz.',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="font-sans bg-gray-900 text-gray-100 min-h-screen">
        <header className="border-b border-gray-700 bg-gray-800">
          <nav className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="flex items-center justify-between h-16">
              <Link href="/" className="flex items-center space-x-2">
                <span className="text-2xl font-bold text-white">Broadway</span>
                <span className="text-2xl font-bold text-green-400">Metascore</span>
              </Link>
              <div className="flex space-x-6">
                <Link href="/" className="text-gray-300 hover:text-white transition">
                  Shows
                </Link>
                <Link href="/methodology" className="text-gray-300 hover:text-white transition">
                  Methodology
                </Link>
                <Link href="/data" className="text-gray-300 hover:text-white transition">
                  Data
                </Link>
              </div>
            </div>
          </nav>
        </header>
        <main>{children}</main>
        <footer className="border-t border-gray-700 mt-12 py-8 text-center text-gray-400 text-sm">
          <p>Broadway Metascore aggregates critic reviews, audience ratings, and community discussion.</p>
          <p className="mt-2">All ratings and reviews belong to their respective sources. <Link href="/methodology" className="text-green-400 hover:underline">See methodology</Link>.</p>
        </footer>
      </body>
    </html>
  );
}
