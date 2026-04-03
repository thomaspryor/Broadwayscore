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
  toAbsoluteUrl,
} from '@/lib/seo';
import { getOptimizedImageUrl } from '@/lib/images';
import { getMarketLabel } from '@/lib/venue-classification';
import { getBrowsePageConfig } from '@/config/browse-pages';
import { getLotteryRush } from '@/lib/data-lottery';
import { ScoreBadge, StatusBadge, FormatPill, AudienceChip } from '@/components/show-cards';
import { getAudienceBuzz, getAudienceGrade, hasEnoughAudienceReviews } from '@/lib/data-audience';
import ShowImage from '@/components/ShowImage';
import TicketLink from '@/components/TicketLink';
import { sortTicketLinks } from '@/lib/ticket-utils';
import Breadcrumb from '@/components/Breadcrumb';

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
  const metaDescription = shows.length > 0
    ? interpolateTemplate(config.metaDescriptionTemplate, vars)
    : `${config.title} — guide by Broadway Scorecard. Check back soon for updated listings.`;
  const canonicalUrl = `${BASE_URL}/guides/${params.slug}`;

  // Top show poster for OG image
  const topPoster = shows[0]?.images?.hero || shows[0]?.images?.poster;
  const ogImageUrl = topPoster ? toAbsoluteUrl(topPoster) : `${BASE_URL}/og/home.png`;

  // Noindex year pages older than 3 years, or empty guide pages
  const currentYear = new Date().getFullYear();
  const isOldYearPage = year !== undefined && year < currentYear - 2;
  const isEmpty = shows.length === 0;

  return {
    title: metaTitle,
    description: metaDescription,
    alternates: { canonical: canonicalUrl },
    ...((isOldYearPage || isEmpty) && {
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

  // Editorial intro (LLM or fallback) — skip editorial if show count drifted significantly
  const editorial = getGuideEditorial(params.slug, shows.length);
  const rawIntro = editorial?.intro || interpolateTemplate(config.introFallback, vars);
  // Strip markdown heading (e.g., "# Best Broadway Musicals: March 2026\n\n") from LLM-generated editorials
  const intro = rawIntro.replace(/^#[^\n]*\n+/, '');

  // H1
  const h1 = interpolateTemplate(config.h1Template, vars);

  // Breadcrumb title (include year for year pages)
  const breadcrumbTitle = year ? `${config.title} ${year}` : config.title;

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
    { name: breadcrumbTitle, url: `${BASE_URL}/guides/${params.slug}` },
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

  // Event schema for upcoming shows — helps Google surface opening dates
  const eventSchemas = params.slug === 'upcoming-broadway-shows' && shows.length > 0
    ? shows.filter(s => s.openingDate).map(show => ({
        '@context': 'https://schema.org',
        '@type': 'TheaterEvent',
        name: show.title,
        startDate: show.openingDate,
        endDate: show.closingDate || undefined,
        url: `${BASE_URL}/show/${show.slug}`,
        location: show.venue ? {
          '@type': 'PerformingArtsTheater',
          name: show.venue,
          address: show.theaterAddress || undefined,
        } : undefined,
        description: show.synopsis || undefined,
        image: show.images?.hero || undefined,
        eventStatus: 'https://schema.org/EventScheduled',
        eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode',
        offers: show.ticketLinks?.[0] ? {
          '@type': 'Offer',
          url: show.ticketLinks[0].url,
          availability: 'https://schema.org/InStock',
        } : undefined,
      }))
    : [];

  const schemas = [breadcrumbSchema, itemListSchema, faqSchema, ...eventSchemas].filter(Boolean);

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
        <Breadcrumb className="mb-4" items={[
          { label: 'Home', href: '/' },
          { label: 'Guides', href: '/guides' },
          { label: breadcrumbTitle },
        ]} />

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

          {/* Editorial Intro — hidden on empty pages to avoid stale show references */}
          {shows.length > 0 && (
            <div className="text-gray-300 leading-relaxed text-base sm:text-lg space-y-3">
              {intro.split('\n\n').filter(Boolean).map((para, i) => (
                <p key={i}>{para.replace(/\*\*(.*?)\*\*/g, '$1')}</p>
              ))}
            </div>
          )}

          {/* Meta line */}
          {shows.length > 0 && (
            <p className="text-gray-500 text-sm mt-3">
              {shows.length} {shows.length === 1 ? 'show' : 'shows'} | Last updated: {metadata.monthYear}
            </p>
          )}

          {/* Methodology blurb — E-E-A-T trust signal */}
          {shows.length > 0 && (
            <details className="mt-4 text-sm border border-white/10 rounded-lg px-4 py-3 group">
              <summary className="text-gray-300 hover:text-white cursor-pointer font-medium transition-colors flex items-center gap-2 list-none [&::-webkit-details-marker]:hidden">
                <svg className="w-4 h-4 text-gray-500 transition-transform group-open:rotate-90" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
                How We Rank
              </summary>
              <p className="mt-3 text-gray-400 leading-relaxed">
                Rankings are based on CriticScore, an aggregate of professional reviews from 400+ outlets
                including The New York Times, Vulture, and Variety. Top-tier outlets carry the most weight
                in the composite score. Each show needs a minimum number of reviews to qualify. Scores are
                recalculated weekly.{' '}
                <Link href="/methodology" className="text-brand hover:text-brand-hover transition-colors">
                  Learn more about our methodology
                </Link>.
              </p>
            </details>
          )}
        </div>

        {/* Year Page Navigation */}
        {yearPages.length > 0 && (
          <div className="mb-8 flex flex-wrap gap-2">
            <span className="text-gray-500 text-sm py-1.5">By year:</span>
            <Link
              href={`/guides/${config.slug}`}
              className={`px-3 py-1.5 rounded-full text-sm transition-colors ${
                !year ? 'bg-brand text-white' : 'bg-surface-overlay hover:bg-surface-raised text-gray-400 hover:text-white'
              }`}
            >
              All
            </Link>
            {yearPages.filter(y => y <= currentYear).reverse().map(y => (
              <Link
                key={y}
                href={`/guides/${config.slug}-${y}`}
                className={`px-3 py-1.5 rounded-full text-sm transition-colors ${
                  year === y ? 'bg-brand text-white' : 'bg-surface-overlay hover:bg-surface-raised text-gray-400 hover:text-white'
                }`}
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
              const ticketLinks = sortTicketLinks(show.ticketLinks?.filter(Boolean) || []);
              const lotteryRush = getLotteryRush(show.id);
              const displayText = consensus || show.synopsis;
              const buzz = getAudienceBuzz(show.id);
              const audienceGrade = buzz && hasEnoughAudienceReviews(buzz) ? getAudienceGrade(buzz.combinedScore) : null;

              return (
                <div key={show.id} className="card p-4 sm:p-5">
                  <div className="flex items-start gap-3 sm:gap-4">
                    <RankBadge rank={index + 1} />

                    {/* Thumbnail — clickable, with ShowImage fallback */}
                    <Link href={`/show/${show.slug}`} className="w-20 h-20 sm:w-24 sm:h-24 rounded-lg overflow-hidden bg-surface-overlay flex-shrink-0 block">
                      <ShowImage
                        sources={[
                          show.images?.thumbnail ? getOptimizedImageUrl(show.images.thumbnail, 'thumbnail') : null,
                          show.images?.poster ? getOptimizedImageUrl(show.images.poster, 'thumbnail') : null,
                          show.images?.hero,
                        ]}
                        alt={`${show.title} ${getMarketLabel(show.category)} ${show.type}`}
                        className="w-full h-full object-cover"
                        loading="lazy"
                        fallback={
                          <div className="w-full h-full flex items-center justify-center bg-surface-overlay">
                            <span className="text-3xl text-gray-500">🎭</span>
                          </div>
                        }
                      />
                    </Link>

                    {/* Info */}
                    <div className="flex-1 min-w-0">
                      <h2 className="text-base sm:text-lg font-bold">
                        <Link
                          href={`/show/${show.slug}`}
                          className="text-white hover:text-brand transition-colors"
                        >
                          {show.title}
                        </Link>
                      </h2>
                      {/* Pills */}
                      <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                        <StatusBadge status={show.status} />
                        <FormatPill type={show.type} />
                      </div>
                      <p className="text-gray-400 text-xs sm:text-sm truncate mt-1">
                        {show.venue} {show.runtime && `\u00B7 ${show.runtime}`}
                      </p>
                      {(show.status === 'previews' || show.status === 'upcoming') && show.openingDate && (
                        <p className="text-purple-400 text-xs mt-0.5">
                          Opens {new Date(show.openingDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                        </p>
                      )}
                      {show.closingDate && show.status === 'open' && (
                        <p className="text-rose-400 text-xs mt-0.5">
                          Closes {new Date(show.closingDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                        </p>
                      )}
                    </div>

                    {/* Score — shared component, large size */}
                    <div className="flex-shrink-0 flex flex-col items-center gap-1.5">
                      <ScoreBadge
                        score={show.criticScore?.score}
                        size="lg"
                        reviewCount={show.criticScore?.reviewCount}
                        status={show.status}
                        showCrown
                      />
                      {audienceGrade && audienceGrade.grade !== '—' && (
                        <AudienceChip grade={audienceGrade} />
                      )}
                    </div>
                  </div>

                  {/* Primary "Get Tickets" CTA — prominent, aligned with show info */}
                  {show.status === 'open' && ticketLinks.length > 0 && (
                    <div className="mt-3 flex sm:pl-[160px]">
                      <TicketLink
                        showName={show.title}
                        showId={show.id}
                        showSlug={show.slug}
                        showStatus={show.status}
                        showCategory={show.category}
                        showScore={show.criticScore?.score ?? null}
                        platform={ticketLinks[0].platform}
                        url={ticketLinks[0].url}
                        pageType="guide"
                        linkPosition={0}
                        totalLinks={ticketLinks.length}
                        className="inline-flex items-center justify-center gap-2 w-full sm:w-auto px-5 py-2.5 rounded-lg bg-accent-gold hover:bg-accent-gold/80 text-gray-900 text-sm font-bold transition-colors min-h-[44px] shadow-sm shadow-accent-gold/20"
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 5v2m0 4v2m0 4v2M5 5a2 2 0 00-2 2v3a2 2 0 110 4v3a2 2 0 002 2h14a2 2 0 002-2v-3a2 2 0 110-4V7a2 2 0 00-2-2H5z" />
                        </svg>
                        Get Tickets{ticketLinks[0].priceFrom ? ` from $${ticketLinks[0].priceFrom}` : ''}
                      </TicketLink>
                    </div>
                  )}

                  {/* Critic Consensus or Synopsis fallback */}
                  {displayText && (
                    <p className="text-gray-400 text-sm leading-relaxed mt-3">
                      {displayText}
                    </p>
                  )}

                  {/* Lottery/Rush — always visible (not collapsed) */}
                  {lotteryRush && show.status !== 'closed' && (
                    <div className="mt-2 flex">
                      <Link
                        href={`/show/${show.slug}#discount-tickets`}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-surface-overlay hover:bg-white/10 text-gray-500 hover:text-gray-300 text-sm font-medium transition-colors border border-white/5 min-h-[44px] sm:min-h-0"
                      >
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 5v2m0 4v2m0 4v2M5 5a2 2 0 00-2 2v3a2 2 0 110 4v3a2 2 0 002 2h14a2 2 0 002-2v-3a2 2 0 110-4V7a2 2 0 00-2-2H5z" />
                        </svg>
                        {lotteryRush.lottery ? `$${lotteryRush.lottery.price} Lottery` : lotteryRush.rush ? `$${lotteryRush.rush.price} Rush` : 'Discount Tickets'}
                      </Link>
                    </div>
                  )}

                  {/* Secondary ticket options — collapsed to reduce card height */}
                  {(show.officialUrl || (ticketLinks.length > 1 && show.status === 'open')) && (
                    <details className="mt-2 group/tickets">
                      <summary className="text-gray-500 hover:text-gray-400 text-xs cursor-pointer transition-colors list-none [&::-webkit-details-marker]:hidden inline-flex items-center gap-1">
                        <svg className="w-3 h-3 transition-transform group-open/tickets:rotate-90" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                        </svg>
                        More ticket options
                      </summary>
                      <div className="mt-2 flex flex-wrap gap-2">
                        {show.status === 'open' && ticketLinks.slice(1).map((link, i) => (
                          <TicketLink
                            key={link.platform}
                            showName={show.title}
                            showId={show.id}
                            showSlug={show.slug}
                            showStatus={show.status}
                            showCategory={show.category}
                            showScore={show.criticScore?.score ?? null}
                            platform={link.platform}
                            url={link.url}
                            pageType="guide"
                            linkPosition={i + 1}
                            totalLinks={ticketLinks.length}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-surface-overlay hover:bg-white/10 text-gray-300 hover:text-white text-xs font-medium transition-colors border border-white/10 min-h-[44px] sm:min-h-0"
                          >
                            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 5v2m0 4v2m0 4v2M5 5a2 2 0 00-2 2v3a2 2 0 110 4v3a2 2 0 002 2h14a2 2 0 002-2v-3a2 2 0 110-4V7a2 2 0 00-2-2H5z" />
                            </svg>
                            {link.platform}{link.priceFrom ? ` from $${link.priceFrom}` : ''}
                          </TicketLink>
                        ))}
                        {show.officialUrl && (
                          <TicketLink
                            showName={show.title}
                            showId={show.id}
                            showSlug={show.slug}
                            showStatus={show.status}
                            showCategory={show.category}
                            showScore={show.criticScore?.score ?? null}
                            platform="Official Site"
                            url={show.officialUrl}
                            pageType="guide"
                            totalLinks={(ticketLinks?.length ?? 0) + 1}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-surface-overlay hover:bg-white/10 text-gray-300 hover:text-white text-xs font-medium transition-colors border border-white/10 min-h-[44px] sm:min-h-0"
                          >
                            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
                            </svg>
                            Official Site
                          </TicketLink>
                        )}
                      </div>
                    </details>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          /* Empty State */
          <div className="card p-6 sm:p-8 text-center">
            <div className="text-3xl sm:text-4xl mb-4">🎭</div>
            <h2 className="text-lg sm:text-xl font-bold text-white mb-2">No Shows Right Now</h2>
            <p className="text-gray-400 text-sm sm:text-base mb-6">
              There are no shows matching this guide at the moment. This page updates automatically — check back soon!
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
              <h2 className="text-base sm:text-lg font-bold text-white mb-3">Related Guides</h2>
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
              <h2 className="text-base sm:text-lg font-bold text-white mb-3">Browse by Category</h2>
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
