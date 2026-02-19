import { notFound } from 'next/navigation';
import Link from 'next/link';
import { Metadata } from 'next';
import { getBrowseList, getAllBrowseSlugs } from '@/lib/data-core';
import { getShowGrosses } from '@/lib/data-grosses';
import { generateBreadcrumbSchema, generateItemListSchema, generateBrowseFAQSchema, BASE_URL } from '@/lib/seo';
import { getOptimizedImageUrl } from '@/lib/images';
import { getBrowsePageConfig, BROWSE_PAGES } from '@/config/browse-pages';
import { GUIDE_PAGES } from '@/config/guide-pages';
import { ScoreBadge, getScoreTier, FormatPill, ProductionPill } from '@/components/show-cards';
import Breadcrumb from '@/components/Breadcrumb';

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

function getBroadwayDuration(openingDate: string | null): string | null {
  if (!openingDate) return null;
  const open = new Date(openingDate);
  const now = new Date();
  const months = (now.getFullYear() - open.getFullYear()) * 12 + (now.getMonth() - open.getMonth());
  if (months < 1) return 'Just opened';
  if (months < 12) return `${months} month${months === 1 ? '' : 's'} on Broadway`;
  const years = Math.floor(months / 12);
  const remainingMonths = months % 12;
  if (remainingMonths === 0) return `${years} year${years === 1 ? '' : 's'} on Broadway`;
  return `${years}+ year${years === 1 ? '' : 's'} on Broadway`;
}

export default function BrowsePage({ params }: { params: { slug: string } }) {
  const browseList = getBrowseList(params.slug);

  if (!browseList) {
    notFound();
  }

  const { config, shows } = browseList;

  // Cross-link to guide page if one exists for this browse slug
  const matchingGuide = GUIDE_PAGES[params.slug];

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
      ticketLinks: show.ticketLinks,
    })),
    config.title
  );

  const faqSchema = generateBrowseFAQSchema(
    config.title,
    shows.map(show => ({
      title: show.title,
      slug: show.slug,
      venue: show.venue,
      criticScore: show.criticScore ? { score: show.criticScore.score, reviewCount: show.criticScore.reviewCount } : null,
      status: show.status,
      closingDate: show.closingDate,
      type: show.type,
    })),
  );

  // Get related pages info
  const relatedPages = config.relatedPages
    .map(slug => getBrowsePageConfig(slug))
    .filter((p): p is NonNullable<typeof p> => p !== undefined);

  const schemas = [breadcrumbSchema, itemListSchema, faqSchema].filter(Boolean);

  // Only show format pills when the list has mixed types
  const isMixedType = new Set(shows.map(s => s.type)).size > 1;
  // Only show status when the list has mixed statuses
  const statuses = new Set(shows.map(s => s.status === 'open' || s.status === 'previews' ? 'open' : 'closed'));
  const isMixedStatus = statuses.size > 1;

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(schemas) }}
      />

      <div className="max-w-2xl mx-auto px-4 sm:px-6 py-8">
        <Breadcrumb items={[
          { label: 'Home', href: '/' },
          { label: config.title },
        ]} />

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

        {/* Guide Cross-Link */}
        {matchingGuide && (
          <div className="mb-6 p-3 rounded-lg bg-surface-overlay border border-white/5">
            <Link
              href={`/guides/${matchingGuide.slug}`}
              className="flex items-center justify-between text-sm text-gray-300 hover:text-white transition-colors"
            >
              <span>Read our in-depth guide: <span className="text-brand font-medium">{matchingGuide.title}</span></span>
              <svg className="w-4 h-4 flex-shrink-0 ml-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
            </Link>
          </div>
        )}

        {/* Show List */}
        {shows.length > 0 ? (
          <div className="space-y-3">
            {shows.map((show, index) => {
              const tier = getScoreTier(show.criticScore?.score);
              const isOpen = show.status === 'open' || show.status === 'previews';
              const duration = isOpen ? getBroadwayDuration(show.openingDate) : null;
              return (
              <div key={show.id} className="flex items-center gap-3">
                {/* Rank outside the card */}
                {config.limit !== 1 && <RankBadge rank={index + 1} />}

                <Link
                  href={`/show/${show.slug}`}
                  className="card p-3 sm:p-4 flex items-center gap-3 sm:gap-4 hover:bg-surface-raised/80 transition-colors group flex-1 min-w-0"
                >
                  {/* Thumbnail */}
                  <div className="w-16 h-16 sm:w-20 sm:h-20 rounded-lg overflow-hidden bg-surface-overlay flex-shrink-0">
                    {show.images?.thumbnail ? (
                      <img
                        src={getOptimizedImageUrl(show.images.thumbnail, 'thumbnail')}
                        alt={`${show.title} Broadway ${show.type}`}
                        className="w-full h-full object-cover"
                        loading="lazy"
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center">
                        <span className="text-2xl">🎭</span>
                      </div>
                    )}
                  </div>

                  {/* Info */}
                  <div className="flex-1 min-w-0">
                    <h2 className="font-bold text-lg text-white group-hover:text-brand transition-colors truncate">
                      {show.title}
                    </h2>
                    <div className="flex flex-wrap items-center gap-1.5 mt-1">
                      {isMixedType && <FormatPill type={show.type} />}
                      {show.isRevival && <ProductionPill isRevival={true} />}
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5 mt-1 text-xs text-gray-500">
                      {config.sort === 'performances' ? (
                        (() => {
                          const grosses = getShowGrosses(show.slug);
                          const performances = grosses?.allTime?.performances;
                          return performances ? (
                            <span className="text-emerald-400">{performances.toLocaleString()} performances</span>
                          ) : null;
                        })()
                      ) : (
                        <>
                          {duration && <span>{duration}</span>}
                          {isOpen && show.closingDate && (
                            <span className="text-amber-400">
                              {duration && '·'} Closes {new Date(show.closingDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                            </span>
                          )}
                          {show.status === 'previews' && show.openingDate && (
                            <span className="text-purple-400">
                              Opens {new Date(show.openingDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                            </span>
                          )}
                        </>
                      )}
                      {isMixedStatus && !isOpen && (
                        <span className="text-orange-400">
                          Closed{show.closingDate ? ` ${new Date(show.closingDate).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}` : ''}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Score — tier label above badge */}
                  <div className="flex-shrink-0 flex flex-col items-center gap-1.5 w-20 sm:w-24">
                    {tier ? (
                      <span
                        className="text-[9px] font-semibold uppercase tracking-wide whitespace-nowrap"
                        style={{ color: tier.color }}
                      >
                        {tier.label}
                      </span>
                    ) : null}
                    <ScoreBadge score={show.criticScore?.score} size="md" />
                  </div>
                </Link>
              </div>
              );
            })}
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
