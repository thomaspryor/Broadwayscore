import Link from 'next/link';
import { Metadata } from 'next';
import { getAllTheaters } from '@/lib/data';
import { generateBreadcrumbSchema, BASE_URL } from '@/lib/seo';

export const metadata: Metadata = {
  title: 'Broadway Theaters Map - All NYC Theater Venues',
  description: 'Explore all Broadway theaters in New York City. Find addresses, current shows, and plan your theater district visit with our comprehensive venue guide.',
  alternates: {
    canonical: `${BASE_URL}/broadway-theaters-map`,
  },
  openGraph: {
    title: 'Broadway Theaters Map - All NYC Theater Venues',
    description: 'Explore all Broadway theaters in New York City with current shows and addresses.',
    url: `${BASE_URL}/broadway-theaters-map`,
    type: 'article',
  },
  twitter: {
    card: 'summary',
    title: 'Broadway Theaters Map',
    description: 'Explore all Broadway theaters in New York City with current shows and addresses.',
  },
};

function MapPinIcon() {
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
    </svg>
  );
}

function getGoogleMapsUrl(address: string): string {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;
}

export default function TheatersMapPage() {
  const theaters = getAllTheaters();

  // Separate theaters with current shows from those without
  const theatersWithShows = theaters.filter(t => t.currentShow);
  const theatersWithoutShows = theaters.filter(t => !t.currentShow);

  const breadcrumbSchema = generateBreadcrumbSchema([
    { name: 'Home', url: BASE_URL },
    { name: 'Broadway Theaters', url: `${BASE_URL}/broadway-theaters-map` },
  ]);

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbSchema) }}
      />

      <div className="max-w-4xl mx-auto px-4 sm:px-6 py-8">
        {/* Breadcrumb */}
        <nav className="text-sm text-gray-400 mb-4" aria-label="Breadcrumb">
          <ol className="flex items-center gap-2">
            <li>
              <Link href="/" className="hover:text-white transition-colors">Home</Link>
            </li>
            <li className="text-gray-600">/</li>
            <li className="text-gray-300">Broadway Theaters</li>
          </ol>
        </nav>

        {/* Back Link */}
        <Link href="/" className="inline-flex items-center gap-1.5 text-brand hover:text-brand-hover text-sm font-medium mb-6 transition-colors">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
          All Shows
        </Link>

        {/* Header */}
        <div className="mb-8">
          <h1 className="text-3xl sm:text-4xl font-bold text-white mb-3">Broadway Theaters Map</h1>
          <p className="text-gray-300 leading-relaxed">
            All Broadway theaters are located in Manhattan&apos;s Theater District, primarily on streets between 41st and 54th Streets,
            from 6th Avenue to 8th Avenue. Here&apos;s a guide to every Broadway venue with their current shows and addresses.
          </p>
          <p className="text-gray-500 text-sm mt-3">
            {theaters.length} theaters | {theatersWithShows.length} currently hosting shows
          </p>
        </div>

        {/* Theaters with Current Shows */}
        <section className="mb-12">
          <h2 className="text-xl font-bold text-white mb-4 flex items-center gap-2">
            <span className="w-3 h-3 bg-emerald-500 rounded-full"></span>
            Theaters with Current Shows ({theatersWithShows.length})
          </h2>
          <div className="grid sm:grid-cols-2 gap-4">
            {theatersWithShows.map(theater => (
              <div key={theater.slug} className="card p-4 hover:bg-surface-raised/80 transition-colors">
                <h3 className="font-bold text-white mb-2">{theater.name}</h3>

                {theater.currentShow && (
                  <Link
                    href={`/show/${theater.currentShow.slug}`}
                    className="block mb-3 p-3 bg-surface-overlay rounded-lg hover:bg-white/5 transition-colors group"
                  >
                    <p className="text-sm text-gray-400 uppercase tracking-wide mb-1">Now Playing</p>
                    <p className="font-medium text-brand group-hover:text-brand-hover transition-colors">
                      {theater.currentShow.title}
                    </p>
                  </Link>
                )}

                {theater.address && (
                  <a
                    href={getGoogleMapsUrl(theater.address)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 text-sm text-gray-400 hover:text-white transition-colors"
                  >
                    <MapPinIcon />
                    {theater.address}
                  </a>
                )}
              </div>
            ))}
          </div>
        </section>

        {/* Theaters without Current Shows */}
        {theatersWithoutShows.length > 0 && (
          <section>
            <h2 className="text-xl font-bold text-white mb-4 flex items-center gap-2">
              <span className="w-3 h-3 bg-gray-500 rounded-full"></span>
              Theaters Between Shows ({theatersWithoutShows.length})
            </h2>
            <div className="grid sm:grid-cols-2 gap-4">
              {theatersWithoutShows.map(theater => (
                <div key={theater.slug} className="card p-4 opacity-75">
                  <h3 className="font-bold text-white mb-2">{theater.name}</h3>
                  <p className="text-sm text-gray-500 mb-2">No current production</p>
                  {theater.address && (
                    <a
                      href={getGoogleMapsUrl(theater.address)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1.5 text-sm text-gray-400 hover:text-white transition-colors"
                    >
                      <MapPinIcon />
                      {theater.address}
                    </a>
                  )}
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Tips Section */}
        <section className="mt-12 card p-6">
          <h2 className="text-lg font-bold text-white mb-4">Theater District Tips</h2>
          <ul className="space-y-3 text-gray-300 text-sm">
            <li className="flex items-start gap-2">
              <span className="text-brand">•</span>
              <span>Most theaters are within walking distance of Times Square (42nd St &amp; Broadway)</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-brand">•</span>
              <span>Take the 1, 2, 3, N, Q, R, W, or S train to Times Square-42nd Street</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-brand">•</span>
              <span>Arrive 20-30 minutes before showtime to find your seat comfortably</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-brand">•</span>
              <span>Many restaurants offer pre-theater prix fixe menus between 5-7pm</span>
            </li>
          </ul>
        </section>

        {/* Related Links */}
        <div className="mt-8 pt-6 border-t border-white/5">
          <h3 className="text-sm font-medium text-gray-400 uppercase tracking-wide mb-3">Explore More</h3>
          <div className="flex flex-wrap gap-2">
            <Link href="/browse/broadway-shows-for-tourists" className="px-4 py-2 rounded-full bg-surface-overlay hover:bg-surface-raised text-sm text-gray-300 hover:text-white transition-colors">
              Shows for Tourists
            </Link>
            <Link href="/browse/first-time-broadway" className="px-4 py-2 rounded-full bg-surface-overlay hover:bg-surface-raised text-sm text-gray-300 hover:text-white transition-colors">
              First-Timer Guide
            </Link>
            <Link href="/browse/broadway-lottery-shows" className="px-4 py-2 rounded-full bg-surface-overlay hover:bg-surface-raised text-sm text-gray-300 hover:text-white transition-colors">
              Lottery Shows
            </Link>
          </div>
        </div>
      </div>
    </>
  );
}
