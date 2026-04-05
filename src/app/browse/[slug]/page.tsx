import { notFound } from 'next/navigation';
import Link from 'next/link';
import { Metadata } from 'next';
import { getBrowseList, getAllBrowseSlugs } from '@/lib/data-core';
import { getShowGrosses } from '@/lib/data-grosses';
import { serializeShowForClient } from '@/lib/serialize-show';
import { generateBreadcrumbSchema, generateItemListSchema, generateBrowseFAQSchema, BASE_URL, toAbsoluteUrl } from '@/lib/seo';
import { getBrowsePageConfig } from '@/config/browse-pages';
import { GUIDE_PAGES } from '@/config/guide-pages';
import Breadcrumb from '@/components/Breadcrumb';
import BrowseListClient from '@/components/BrowseListClient';
import HowThisWorks from '@/components/HowThisWorks';
import type { BrowseShow } from '@/components/BrowseListClient';

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
  const ogImageUrl = topPoster ? toAbsoluteUrl(topPoster) : `${BASE_URL}/og/home.png`;

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

// Determine which sort options make sense for this page
function getAvailableSorts(config: { sort?: string; customSort?: unknown; slug: string }): Array<'score' | 'alpha' | 'newest' | 'oldest' | 'closing' | 'performances' | 'custom'> {
  const sorts: Array<'score' | 'alpha' | 'newest' | 'oldest' | 'closing' | 'performances' | 'custom'> = [];

  // Pages with customSort preserve server ordering as default
  if (config.customSort) {
    sorts.push('custom');
  }

  // Always offer score sort
  sorts.push('score');

  // Add context-appropriate sorts
  if (config.sort === 'performances') {
    sorts.push('performances');
  }
  if (config.slug === 'broadway-shows-closing-soon') {
    sorts.push('closing');
  }
  // opening-date-asc pages get oldest sort (default) + newest toggle
  if (config.sort === 'opening-date-asc') {
    sorts.push('oldest');
    sorts.push('newest');
  } else if (config.slug.includes('new-') || config.slug.includes('-season')) {
    sorts.push('newest');
  }

  // Always offer A-Z
  sorts.push('alpha');

  return sorts;
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
      category: show.category,
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
      category: show.category,
    })),
  );

  // Get related pages info
  const relatedPages = config.relatedPages
    .map(slug => getBrowsePageConfig(slug))
    .filter((p): p is NonNullable<typeof p> => p !== undefined);

  const schemas = [breadcrumbSchema, itemListSchema, faqSchema].filter(Boolean);

  // Compute display flags
  const isMixedType = new Set(shows.map(s => s.type)).size > 1;
  const statuses = new Set(shows.map(s => s.status === 'open' || s.status === 'previews' || s.status === 'upcoming' ? 'open' : 'closed'));
  const isMixedStatus = statuses.size > 1;
  const hasPerformanceData = config.sort === 'performances';

  // Serialize shows with audience data for client
  const serializedShows: BrowseShow[] = shows.map(show => {
    const grosses = hasPerformanceData ? getShowGrosses(show.slug) : null;
    return serializeShowForClient(show, {
      performances: grosses?.allTime?.performances ?? undefined,
    });
  });

  // Compute section group labels (server-side, since sectionGroup uses ComputedShow)
  const sectionLabels = config.sectionGroup
    ? shows.map(show => config.sectionGroup!(show))
    : undefined;

  // Determine available sorts and filters for this page
  const availableSorts = getAvailableSorts(config);
  const showTypeFilter = isMixedType;
  // Show score toggle on pages that aren't specifically about critic rankings
  // Season pages, general browse, closing soon etc. all make sense for audience toggle
  const showScoreToggle = true;

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

        {/* Interactive Show List */}
        <BrowseListClient
          shows={serializedShows}
          showRanks={config.limit !== 1 && config.sort !== 'opening-date-asc' && config.sort !== 'opening-date' && config.sort !== 'closing-date'}
          isMixedType={isMixedType}
          isMixedStatus={isMixedStatus}
          defaultSort={config.customSort ? 'custom' : (config.sort || 'score')}
          hasPerformanceData={hasPerformanceData}
          availableSorts={availableSorts}
          showTypeFilter={showTypeFilter}
          showScoreToggle={showScoreToggle}
          sectionLabels={sectionLabels}
        />

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

        {/* How This Works */}
        <HowThisWorks className="mt-8">
          <p>
            Shows are ranked by CriticScore, a weighted average of reviews from dozens of outlets.
            Top-tier publications (NYT, Vulture, Variety) carry more weight than smaller outlets.
            Toggle to Audience mode to see letter grades based on audience sentiment from multiple sources.
          </p>
        </HowThisWorks>
      </div>
    </>
  );
}
