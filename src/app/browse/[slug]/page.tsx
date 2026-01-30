import { notFound } from 'next/navigation';
import Link from 'next/link';
import { Metadata } from 'next';
import { getBrowseList, getAllBrowseSlugs, getShowGrosses } from '@/lib/data';
import { generateBreadcrumbSchema, generateItemListSchema, BASE_URL } from '@/lib/seo';
import { getOptimizedImageUrl } from '@/lib/images';
import { getBrowsePageConfig, BROWSE_PAGES } from '@/config/browse-pages';

export function generateStaticParams() {
  return getAllBrowseSlugs().map((slug) => ({ slug }));
}

export function generateMetadata({ params }: { params: { slug: string } }): Metadata {
  const config = getBrowsePageConfig(params.slug);
  if (!config) return { title: 'Page Not Found' };

  const canonicalUrl = `${BASE_URL}/browse/${params.slug}`;

  // Get top show poster for OG image, or use default
  const browseList = getBrowseList(params.slug);
  const topPoster = browseList?.shows[0]?.images?.hero || browseList?.shows[0]?.images?.poster;
  const ogImageUrl = topPoster || `${BASE_URL}/og/home.png`;

  return {
    title: config.metaTitle,
    description: config.metaDescription,
    alternates: {
      canonical: canonicalUrl,
    },
    openGraph: {
      title: config.metaTitle,
      description: config.metaDescription,
      url: canonicalUrl,
      type: 'article',
      images: [{
        url: ogImageUrl,
        width: 1200,
        height: 630,
        alt: config.h1,
      }],
    },
    twitter: {
      card: 'summary_large_image',
      title: config.metaTitle,
      description: config.metaDescription,
      images: [{
        url: ogImageUrl,
        width: 1200,
        height: 630,
        alt: config.h1,
      }],
    },
  };
}

function ScoreBadge({ score, reviewCount }: { score?: number | null; reviewCount?: number }) {
  // Show TBD if fewer than 5 reviews
  if (reviewCount !== undefined && reviewCount < 5) {
    return (
      <div className="w-10 h-10 sm:w-12 sm:h-12 bg-surface-overlay text-gray-400 border border-white/10 flex items-center justify-center font-bold text-xs sm:text-sm rounded-lg sm:rounded-xl">
        TBD
      </div>
    );
  }

  if (score === undefined || score === null) {
    return (
      <div className="w-10 h-10 sm:w-12 sm:h-12 bg-surface-overlay text-gray-500 border border-white/10 flex items-center justify-center font-bold text-base sm:text-lg rounded-lg sm:rounded-xl">
        -
      </div>
    );
  }

  const roundedScore = Math.round(score);
  let colorClass: string;

  if (roundedScore >= 85) {
    colorClass = 'score-must-see';
  } else if (roundedScore >= 75) {
    colorClass = 'score-great';
  } else if (roundedScore >= 65) {
    colorClass = 'score-good';
  } else if (roundedScore >= 55) {
    colorClass = 'score-tepid';
  } else {
    colorClass = 'score-skip';
  }

  return (
    <div className={`w-10 h-10 sm:w-12 sm:h-12 ${colorClass} flex items-center justify-center font-bold text-base sm:text-lg rounded-lg sm:rounded-xl`}>
      {roundedScore}
    </div>
  );
}

function RankBadge({ rank }: { rank: number }) {
  const isTop3 = rank <= 3;
  return (
    <div className={`w-8 h-8 rounded-full flex items-center justify-center font-bold text-sm ${
      isTop3 ? 'bg-accent-gold text-gray-900' : 'bg-surface-overlay text-gray-400 border border-white/10'
    }`}>
      {rank}
    </div>
  );
}

export default function BrowsePage({ params }: { params: { slug: string } }) {
  const browseList = getBrowseList(params.slug);

  if (!browseList) {
    notFound();
  }

  const { config, shows } = browseList;

  const breadcrumbSchema = generateBreadcrumbSchema([
    { name: 'Home', url: BASE_URL },
    { name: 'Browse', url: `${BASE_URL}/browse` },
    { name: config.title, url: `${BASE_URL}/browse/${params.slug}` },
  ]);

  const itemListSchema = generateItemListSchema(
    shows.map(show => ({
      name: show.title,
      url: `${BASE_URL}/show/${show.slug}`,
      image: show.images?.hero,
      score: show.criticScore?.score ? Math.round(show.criticScore.score) : undefined,
      reviewCount: show.criticScore?.reviewCount,
      venue: show.venue,
      theaterAddress: show.theaterAddress,
      startDate: show.openingDate,
      endDate: show.closingDate,
      description: show.synopsis,
      status: show.status,
      cast: show.cast,
      ticketLinks: show.ticketLinks,
    })),
    config.title
  );

  // Get related pages info
  const relatedPages = config.relatedPages
    .map(slug => getBrowsePageConfig(slug))
    .filter((p): p is NonNullable<typeof p> => p !== undefined);

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify([breadcrumbSchema, itemListSchema]) }}
      />

      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8">
        {/* Breadcrumb */}
        <nav className="text-sm text-gray-400 mb-4" aria-label="Breadcrumb">
          <ol className="flex items-center gap-2">
            <li>
              <Link href="/" className="hover:text-white transition-colors">Home</Link>
            </li>
            <li className="text-gray-600">/</li>
            <li className="text-gray-300">{config.title}</li>
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
          <h1 className="text-3xl sm:text-4xl font-bold text-white mb-3">{config.h1}</h1>
          <p className="text-gray-300 leading-relaxed">{config.intro}</p>
          <p className="text-gray-500 text-sm mt-3">
            {shows.length} {shows.length === 1 ? 'show' : 'shows'} | Last updated: {new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}
          </p>
        </div>

        {/* Show List */}
        {shows.length > 0 ? (
          <div className="space-y-3 sm:space-y-4">
            {shows.map((show, index) => (
              <Link
                key={show.id}
                href={`/show/${show.slug}`}
                className="card p-3 sm:p-4 flex items-center gap-3 sm:gap-4 hover:bg-surface-raised/80 transition-colors group min-h-[72px]"
              >
                {config.limit !== 1 && <RankBadge rank={index + 1} />}

                {/* Thumbnail - smaller on mobile */}
                <div className="w-14 h-14 sm:w-16 sm:h-16 rounded-lg overflow-hidden bg-surface-overlay flex-shrink-0">
                  {show.images?.thumbnail ? (
                    <img
                      src={getOptimizedImageUrl(show.images.thumbnail, 'thumbnail')}
                      alt={`${show.title} Broadway ${show.type}`}
                      className="w-full h-full object-contain"
                      loading="lazy"
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center">
                      <span className="text-xl sm:text-2xl">🎭</span>
                    </div>
                  )}
                </div>

                {/* Info */}
                <div className="flex-1 min-w-0">
                  <h2 className="font-bold text-white text-sm sm:text-base group-hover:text-brand transition-colors truncate">
                    {show.title}
                  </h2>
                  <p className="text-gray-400 text-xs sm:text-sm truncate">
                    {show.venue} {show.runtime && `• ${show.runtime}`}
                  </p>
                  {config.sort === 'performances' ? (
                    (() => {
                      const grosses = getShowGrosses(show.slug);
                      const performances = grosses?.allTime?.performances;
                      return performances ? (
                        <p className="text-emerald-400 text-xs mt-0.5 sm:mt-1">
                          {performances.toLocaleString()} performances
                        </p>
                      ) : null;
                    })()
                  ) : show.status === 'previews' ? (
                    <p className="text-purple-400 text-xs mt-0.5 sm:mt-1">
                      Opens {new Date(show.openingDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                    </p>
                  ) : show.closingDate && (
                    <p className="text-rose-400 text-xs mt-0.5 sm:mt-1">
                      {show.status === 'closed' ? 'Closed' : 'Closes'} {new Date(show.closingDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                    </p>
                  )}
                </div>

                {/* Score - slightly smaller on mobile */}
                <ScoreBadge score={show.criticScore?.score} reviewCount={show.criticScore?.reviewCount} />
              </Link>
            ))}
          </div>
        ) : (
          <div className="card p-6 sm:p-8 text-center">
            <div className="text-3xl sm:text-4xl mb-4">🎭</div>
            <h2 className="text-lg sm:text-xl font-bold text-white mb-2">No Shows Currently</h2>
            <p className="text-gray-400 text-sm sm:text-base mb-6">
              There are no shows matching this category right now. Check back soon as Broadway is always changing!
            </p>
            <div className="flex flex-wrap justify-center gap-2">
              {relatedPages.slice(0, 3).map(page => (
                <Link
                  key={page.slug}
                  href={`/browse/${page.slug}`}
                  className="px-4 py-2.5 sm:py-2 rounded-full bg-surface-overlay hover:bg-surface-raised text-sm text-gray-300 hover:text-white transition-colors min-h-[44px] sm:min-h-0 flex items-center"
                >
                  {page.title.replace('Best ', '').replace('Broadway ', '')}
                </Link>
              ))}
            </div>
          </div>
        )}

        {/* Related Categories */}
        {relatedPages.length > 0 && (
          <div className="mt-10 sm:mt-12 pt-6 sm:pt-8 border-t border-white/10">
            <h3 className="text-base sm:text-lg font-bold text-white mb-3 sm:mb-4">See Also</h3>
            <div className="flex flex-wrap gap-2">
              {relatedPages.map(page => (
                <Link
                  key={page.slug}
                  href={`/browse/${page.slug}`}
                  className="px-4 py-2.5 sm:py-2 rounded-full bg-surface-overlay hover:bg-surface-raised text-sm text-gray-300 hover:text-white transition-colors min-h-[44px] sm:min-h-0 flex items-center"
                >
                  {page.title.replace('Best ', '').replace('Broadway ', '')}
                </Link>
              ))}
            </div>
          </div>
        )}

        {/* Methodology Link */}
        <div className="mt-8 text-sm text-gray-500 border-t border-white/5 pt-6">
          <Link href="/methodology" className="text-brand hover:text-brand-hover transition-colors">
            How are scores calculated? →
          </Link>
        </div>
      </div>
    </>
  );
}
