import { notFound } from 'next/navigation';
import Link from 'next/link';
import { Metadata } from 'next';
import {
  getGuideList,
  buildTemplateVars,
  getGuideEditorial,
  getCriticConsensus,
} from '@/lib/data-guides';
import {
  getAllGuideSlugs,
  getGuideConfig,
  parseGuideSlug,
  interpolateTemplate,
  GUIDE_PAGES,
} from '@/config/guide-pages';
import {
  generateBreadcrumbSchema,
  generateItemListSchema,
  generateBrowseFAQSchema,
  BASE_URL,
} from '@/lib/seo';
import { getOptimizedImageUrl } from '@/lib/images';
import { getBrowsePageConfig } from '@/config/browse-pages';

export function generateStaticParams() {
  return getAllGuideSlugs().map((slug) => ({ slug }));
}

export function generateMetadata({ params }: { params: { slug: string } }): Metadata {
  const guideList = getGuideList(params.slug);
  if (!guideList) return { title: 'Page Not Found' };

  const { config, shows, metadata } = guideList;
  const vars = buildTemplateVars(metadata);
  const { year } = parseGuideSlug(params.slug);

  const metaTitle = interpolateTemplate(config.metaTitleTemplate, vars);
  const metaDescription = interpolateTemplate(config.metaDescriptionTemplate, vars);
  const canonicalUrl = `${BASE_URL}/guides/${params.slug}`;

  // Top show poster for OG image
  const topPoster = shows[0]?.images?.hero || shows[0]?.images?.poster;
  const ogImageUrl = topPoster || `${BASE_URL}/og/home.png`;

  // Noindex year pages older than 3 years
  const currentYear = new Date().getFullYear();
  const isOldYearPage = year !== undefined && year < currentYear - 2;

  return {
    title: metaTitle,
    description: metaDescription,
    alternates: { canonical: canonicalUrl },
    ...(isOldYearPage && {
      robots: { index: false, follow: true },
    }),
    openGraph: {
      title: metaTitle,
      description: metaDescription,
      url: canonicalUrl,
      type: 'article',
      images: [{ url: ogImageUrl, width: 1200, height: 630, alt: config.title }],
    },
    twitter: {
      card: 'summary_large_image',
      title: metaTitle,
      description: metaDescription,
      images: [{ url: ogImageUrl, width: 1200, height: 630, alt: config.title }],
    },
  };
}

function ScoreBadge({ score, reviewCount }: { score?: number | null; reviewCount?: number }) {
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
  if (roundedScore >= 85) colorClass = 'score-must-see';
  else if (roundedScore >= 75) colorClass = 'score-great';
  else if (roundedScore >= 65) colorClass = 'score-good';
  else if (roundedScore >= 55) colorClass = 'score-tepid';
  else colorClass = 'score-skip';

  return (
    <div className={`w-10 h-10 sm:w-12 sm:h-12 ${colorClass} flex items-center justify-center font-bold text-base sm:text-lg rounded-lg sm:rounded-xl`}>
      {roundedScore}
    </div>
  );
}

function RankBadge({ rank }: { rank: number }) {
  const isTop3 = rank <= 3;
  return (
    <div className={`w-8 h-8 rounded-full flex items-center justify-center font-bold text-sm flex-shrink-0 ${
      isTop3 ? 'bg-accent-gold text-gray-900' : 'bg-surface-overlay text-gray-400 border border-white/10'
    }`}>
      {rank}
    </div>
  );
}

export default function GuidePage({ params }: { params: { slug: string } }) {
  const guideList = getGuideList(params.slug);
  if (!guideList) notFound();

  const { config, shows, metadata } = guideList;
  const vars = buildTemplateVars(metadata);
  const { year } = parseGuideSlug(params.slug);

  // Editorial intro (LLM or fallback)
  const editorial = getGuideEditorial(params.slug);
  const intro = editorial?.intro || interpolateTemplate(config.introFallback, vars);

  // H1
  const h1 = interpolateTemplate(config.h1Template, vars);

  // Related content
  const relatedGuides = config.relatedGuides
    .map(slug => GUIDE_PAGES[slug])
    .filter(Boolean);

  const relatedBrowse = config.relatedBrowse
    .map(slug => getBrowsePageConfig(slug))
    .filter((p): p is NonNullable<typeof p> => p !== undefined);

  // JSON-LD schemas
  const breadcrumbSchema = generateBreadcrumbSchema([
    { name: 'Home', url: BASE_URL },
    { name: 'Guides', url: `${BASE_URL}/guides` },
    { name: config.title, url: `${BASE_URL}/guides/${params.slug}` },
  ]);

  const itemListSchema = shows.length > 0
    ? generateItemListSchema(
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
        h1
      )
    : null;

  const faqSchema = shows.length > 0
    ? generateBrowseFAQSchema(
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
      )
    : null;

  const schemas = [breadcrumbSchema, itemListSchema, faqSchema].filter(Boolean);

  // Year page links
  const yearPages = config.yearPages || [];
  const currentYear = new Date().getFullYear();

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(schemas) }}
      />

      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8">
        {/* Breadcrumb */}
        <nav className="text-sm text-gray-400 mb-4" aria-label="Breadcrumb">
          <ol className="flex items-center gap-2">
            <li><Link href="/" className="hover:text-white transition-colors">Home</Link></li>
            <li className="text-gray-500">/</li>
            <li><Link href="/guides" className="hover:text-white transition-colors">Guides</Link></li>
            <li className="text-gray-500">/</li>
            <li className="text-gray-300">{config.title}</li>
          </ol>
        </nav>

        {/* Back Link */}
        <Link href="/guides" className="inline-flex items-center gap-1.5 text-brand hover:text-brand-hover text-sm font-medium mb-6 transition-colors">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
          All Guides
        </Link>

        {/* Header */}
        <div className="mb-8">
          <h1 className="text-3xl sm:text-4xl font-bold text-white mb-4">{h1}</h1>

          {/* Editorial Intro */}
          <p className="text-gray-300 leading-relaxed text-base sm:text-lg">{intro}</p>

          {/* Meta line */}
          <p className="text-gray-500 text-sm mt-3">
            {shows.length} {shows.length === 1 ? 'show' : 'shows'} | Last updated: {metadata.monthYear}
          </p>
        </div>

        {/* Year Page Navigation */}
        {yearPages.length > 0 && !year && (
          <div className="mb-8 flex flex-wrap gap-2">
            <span className="text-gray-500 text-sm py-1.5">By year:</span>
            {yearPages.filter(y => y <= currentYear).reverse().map(y => (
              <Link
                key={y}
                href={`/guides/${config.slug}-${y}`}
                className="px-3 py-1.5 rounded-full bg-surface-overlay hover:bg-surface-raised text-sm text-gray-400 hover:text-white transition-colors"
              >
                {y}
              </Link>
            ))}
          </div>
        )}

        {/* Show List */}
        {shows.length > 0 ? (
          <div className="space-y-4">
            {shows.map((show, index) => {
              const consensus = getCriticConsensus(show.id);
              const ticketLink = show.ticketLinks?.[0];

              return (
                <div key={show.id} className="card p-4 sm:p-5">
                  <div className="flex items-start gap-3 sm:gap-4">
                    <RankBadge rank={index + 1} />

                    {/* Thumbnail */}
                    <div className="w-14 h-14 sm:w-16 sm:h-16 rounded-lg overflow-hidden bg-surface-overlay flex-shrink-0">
                      {show.images?.thumbnail ? (
                        <img
                          src={getOptimizedImageUrl(show.images.thumbnail, 'thumbnail')}
                          alt={`${show.title} Broadway ${show.type}`}
                          className="w-full h-full object-cover"
                          loading="lazy"
                        />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center">
                          <span className="text-xl">🎭</span>
                        </div>
                      )}
                    </div>

                    {/* Info */}
                    <div className="flex-1 min-w-0">
                      <Link
                        href={`/show/${show.slug}`}
                        className="font-bold text-white text-sm sm:text-base hover:text-brand transition-colors"
                      >
                        {show.title}
                      </Link>
                      <p className="text-gray-400 text-xs sm:text-sm truncate">
                        {show.venue} {show.runtime && `\u00B7 ${show.runtime}`}
                      </p>
                      {show.closingDate && show.status === 'open' && (
                        <p className="text-rose-400 text-xs mt-0.5">
                          Closes {new Date(show.closingDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                        </p>
                      )}
                    </div>

                    {/* Score */}
                    <ScoreBadge score={show.criticScore?.score} reviewCount={show.criticScore?.reviewCount} />
                  </div>

                  {/* Critic Consensus */}
                  {consensus && (
                    <p className="text-gray-400 text-sm leading-relaxed mt-3 pl-11 sm:pl-12">
                      {consensus}
                    </p>
                  )}

                  {/* Ticket CTA */}
                  {ticketLink && show.status === 'open' && (
                    <div className="mt-3 pl-11 sm:pl-12">
                      <a
                        href={ticketLink.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1.5 px-4 py-2 bg-brand hover:bg-brand-hover text-white font-medium rounded-lg text-sm transition-colors min-h-[44px]"
                      >
                        Get Tickets{ticketLink.priceFrom ? ` from $${ticketLink.priceFrom}` : ''}
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                        </svg>
                      </a>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          /* Empty State */
          <div className="card p-6 sm:p-8 text-center">
            <div className="text-3xl sm:text-4xl mb-4">🎭</div>
            <h2 className="text-lg sm:text-xl font-bold text-white mb-2">No Shows Currently</h2>
            <p className="text-gray-400 text-sm sm:text-base mb-6">
              There are no shows matching this guide right now. Check back soon as Broadway is always changing!
            </p>
            {relatedGuides.length > 0 && (
              <div className="flex flex-wrap justify-center gap-2">
                {relatedGuides.slice(0, 3).map(guide => (
                  <Link
                    key={guide.slug}
                    href={`/guides/${guide.slug}`}
                    className="px-4 py-2.5 sm:py-2 rounded-full bg-surface-overlay hover:bg-surface-raised text-sm text-gray-300 hover:text-white transition-colors min-h-[44px] sm:min-h-0 flex items-center"
                  >
                    {guide.title}
                  </Link>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Related Content */}
        <div className="mt-10 sm:mt-12 pt-6 sm:pt-8 border-t border-white/10 space-y-6">
          {/* Related Guides */}
          {relatedGuides.length > 0 && (
            <div>
              <h3 className="text-base sm:text-lg font-bold text-white mb-3">Related Guides</h3>
              <div className="flex flex-wrap gap-2">
                {relatedGuides.map(guide => (
                  <Link
                    key={guide.slug}
                    href={`/guides/${guide.slug}`}
                    className="px-4 py-2.5 sm:py-2 rounded-full bg-surface-overlay hover:bg-surface-raised text-sm text-gray-300 hover:text-white transition-colors min-h-[44px] sm:min-h-0 flex items-center"
                  >
                    {guide.title}
                  </Link>
                ))}
              </div>
            </div>
          )}

          {/* Related Browse Pages */}
          {relatedBrowse.length > 0 && (
            <div>
              <h3 className="text-base sm:text-lg font-bold text-white mb-3">Browse by Category</h3>
              <div className="flex flex-wrap gap-2">
                {relatedBrowse.map(page => (
                  <Link
                    key={page.slug}
                    href={`/browse/${page.slug}`}
                    className="px-4 py-2.5 sm:py-2 rounded-full bg-surface-overlay hover:bg-surface-raised text-sm text-gray-300 hover:text-white transition-colors min-h-[44px] sm:min-h-0 flex items-center"
                  >
                    {page.title}
                  </Link>
                ))}
              </div>
            </div>
          )}
        </div>

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
