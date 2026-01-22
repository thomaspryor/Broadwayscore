import Link from 'next/link';
import { Metadata } from 'next';
import { getAllTheaters } from '@/lib/data';
import { generateBreadcrumbSchema } from '@/lib/seo';

const BASE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://broadwayscore-ayv17ggvd-thomaspryors-projects.vercel.app';

export const metadata: Metadata = {
  title: 'Broadway Theaters - All NYC Theater Venues',
  description: 'Browse all Broadway theaters in New York City. See what shows are currently playing at each venue with critic scores and reviews.',
  alternates: {
    canonical: `${BASE_URL}/theater`,
  },
  openGraph: {
    title: 'Broadway Theaters',
    description: 'Browse all Broadway theaters and see what shows are currently playing.',
    url: `${BASE_URL}/theater`,
  },
};

export default function TheatersIndexPage() {
  const theaters = getAllTheaters();

  const breadcrumbSchema = generateBreadcrumbSchema([
    { name: 'Home', url: BASE_URL },
    { name: 'Theaters', url: `${BASE_URL}/theater` },
  ]);

  // Separate theaters with current shows from those without
  const withCurrentShow = theaters.filter(t => t.currentShow);
  const withoutCurrentShow = theaters.filter(t => !t.currentShow);

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbSchema) }}
      />

      <div className="max-w-4xl mx-auto px-4 sm:px-6 py-8">
        {/* Header */}
        <div className="mb-8">
          <Link href="/" className="inline-flex items-center gap-1.5 text-brand hover:text-brand-hover text-sm font-medium mb-4 transition-colors">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
            All Shows
          </Link>
          <h1 className="text-3xl sm:text-4xl font-bold text-white">Broadway Theaters</h1>
          <p className="text-gray-400 mt-2">
            {theaters.length} theaters in the Broadway district
          </p>
        </div>

        {/* Currently Active Theaters */}
        {withCurrentShow.length > 0 && (
          <section className="mb-10">
            <h2 className="text-xl font-bold text-white mb-4 flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-status-open animate-pulse"></span>
              Theaters with Current Shows
            </h2>
            <div className="grid gap-4">
              {withCurrentShow.map(theater => (
                <Link
                  key={theater.slug}
                  href={`/theater/${theater.slug}`}
                  className="card p-5 hover:bg-surface-raised/80 transition-colors group"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <h3 className="font-bold text-white text-lg group-hover:text-brand transition-colors">
                        {theater.name}
                      </h3>
                      {theater.address && (
                        <p className="text-gray-500 text-sm mt-1 truncate">
                          {theater.address}
                        </p>
                      )}
                    </div>
                    <div className="flex-shrink-0 text-right">
                      <span className="text-xs text-gray-500 uppercase tracking-wide">Now Playing</span>
                      <p className="text-brand font-medium truncate max-w-[200px]">
                        {theater.currentShow?.title}
                      </p>
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          </section>
        )}

        {/* Other Theaters */}
        {withoutCurrentShow.length > 0 && (
          <section>
            <h2 className="text-xl font-bold text-white mb-4 flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-gray-500"></span>
              Other Broadway Theaters
            </h2>
            <div className="grid gap-3">
              {withoutCurrentShow.map(theater => (
                <Link
                  key={theater.slug}
                  href={`/theater/${theater.slug}`}
                  className="card p-4 flex items-center justify-between hover:bg-surface-raised/80 transition-colors group opacity-75 hover:opacity-100"
                >
                  <div>
                    <h3 className="font-semibold text-white group-hover:text-brand transition-colors">
                      {theater.name}
                    </h3>
                    <p className="text-gray-500 text-sm">
                      {theater.showCount} {theater.showCount === 1 ? 'show' : 'shows'} in history
                    </p>
                  </div>
                  <svg className="w-5 h-5 text-gray-600 group-hover:text-brand transition-colors" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                </Link>
              ))}
            </div>
          </section>
        )}
      </div>
    </>
  );
}
