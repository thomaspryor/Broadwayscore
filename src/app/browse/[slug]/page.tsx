import { notFound } from 'next/navigation';
import Link from 'next/link';
import { Metadata } from 'next';
import { getBrowseList, getAllBrowseSlugs, getShowById } from '@/lib/data-core';
import { getShowGrosses } from '@/lib/data-grosses';
import { serializeShowForClient } from '@/lib/serialize-show';
import { generateBreadcrumbSchema, generateItemListSchema, generateBrowseFAQSchema, BASE_URL, toAbsoluteUrl } from '@/lib/seo';
import { getBrowsePageConfig } from '@/config/browse-pages';
import { GUIDE_PAGES } from '@/config/guide-pages';
import { isCategoryEnabled } from '@/lib/markets';
import Breadcrumb from '@/components/Breadcrumb';
import BrowseListClient from '@/components/BrowseListClient';
import HowThisWorks from '@/components/HowThisWorks';
import ToursByCity from '@/components/ToursByCity';
import { getTourCities } from '@/lib/data-tour-cities';
import type { BrowseShow } from '@/components/BrowseListClient';
import { displaysCriticScore } from '@/lib/critic-score-display';
import FeaturedRowServer from '@/components/FeaturedRowServer';
import type { TourCityOption } from '@/components/TourCityPicker';
import { getTourNowNextForShow, getTourStopTickets } from '@/lib/data-tour-schedule';
import { isLiveTour, isTourScored, isTourScoreHidden } from '@/lib/tour-listing';
import { shortCity, stopKey } from '@/lib/tour-schedule';
import { stopDateRange } from '@/lib/tour-cities';
import { ukHubForCity, ukHubFilterOptions } from '@/lib/uk-hubs';

// "How This Works" default per market. The Broadway outlets (NYT, Vulture,
// Variety) also review Off-Broadway; London and regional runs are reviewed by
// other papers (BRO-4601). A page's own config.howItWorks wins.
const HOW_IT_WORKS_BY_SOURCE: Partial<Record<string, string>> = {
  broadway: 'Shows are ranked by CriticScore, a weighted average of reviews from dozens of outlets. Top-tier publications (NYT, Vulture, Variety) carry more weight than smaller outlets. Toggle to Audience mode to see letter grades based on audience sentiment from multiple sources.',
  'west-end': 'Shows are ranked by CriticScore, a weighted average of reviews from UK critics at outlets like The Guardian, The Telegraph, Time Out, WhatsOnStage and The Stage. Major publications carry more weight than smaller outlets. Toggle to Audience mode to see letter grades based on audience sentiment from multiple sources.',
  regional: 'Shows are ranked by CriticScore, a weighted average of reviews from local and national critics, from papers like The Washington Post and the Los Angeles Times to regional outlets. Major publications carry more weight than smaller outlets. Toggle to Audience mode to see letter grades where audiences have rated the production itself.',
};
HOW_IT_WORKS_BY_SOURCE['off-broadway'] = HOW_IT_WORKS_BY_SOURCE.broadway;
HOW_IT_WORKS_BY_SOURCE['off-west-end'] = HOW_IT_WORKS_BY_SOURCE['west-end'];

export function generateStaticParams() {
  return getAllBrowseSlugs().map((slug) => ({ slug }));
}

export async function generateMetadata(props: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const params = await props.params;
  const config = getBrowsePageConfig(params.slug);
  if (!config) return { title: 'Page Not Found' };
  if (config.source && !isCategoryEnabled(config.source)) return { title: 'Page Not Found' };

  const canonicalUrl = `${BASE_URL}/browse/${params.slug}`;

  // Get top show poster for OG image, or use default
  const browseList = getBrowseList(params.slug);
  const topPoster = browseList?.shows[0]?.images?.hero || browseList?.shows[0]?.images?.poster;
  // Tours borrow their Broadway parent's art, so the top tour's poster would
  // show one Broadway show as the face of all tours: use the site image.
  const ogImageUrl = topPoster && config.source !== 'tour' ? toAbsoluteUrl(topPoster) : `${BASE_URL}/og/home.png`;

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
function getAvailableSorts(config: { sort?: string; customSort?: unknown; slug: string; source?: string }): Array<'score' | 'alpha' | 'newest' | 'oldest' | 'closing' | 'performances' | 'custom'> {
  const sorts: Array<'score' | 'alpha' | 'newest' | 'oldest' | 'closing' | 'performances' | 'custom'> = [];

  // Tours hub (BRO-6544): newest tour first by default, like the homepage.
  if (config.source === 'tour') return ['newest', 'score', 'alpha'];

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
  } else if (config.sort === 'opening-date') {
    // Default order is newest-first. Offer both directions so the active
    // default is a visible, selectable toggle — otherwise these pages showed
    // only Critics/A-Z chips, hiding the real order and surfacing a useless
    // score sort on all-unrated pages (e.g. recently-opened-off-broadway).
    sorts.push('newest');
    sorts.push('oldest');
  } else if (config.slug.includes('new-') || config.slug.includes('-season')) {
    sorts.push('newest');
  }

  // Always offer A-Z
  sorts.push('alpha');

  return sorts;
}

export default async function BrowsePage(props: { params: Promise<{ slug: string }> }) {
  const params = await props.params;
  const browseList = getBrowseList(params.slug);

  if (!browseList) {
    notFound();
  }
  // Flag-off builds 404 flag-gated browse pages (regional, tour): their show
  // links are excluded from the site while the flag is off (ship-check P1
  // 2026-07-12). markets.json decides which categories are gated.
  const gatedSource = getBrowsePageConfig(params.slug)?.source;
  if (gatedSource && !isCategoryEnabled(gatedSource)) {
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

  // Long lists render only their first cards in the server HTML (BRO-5968): a 700+
  // show page was 7MB, and Googlebot reads only the first 2MB. The rest are plain
  // links below, and the full list renders after hydration.
  const INITIAL_RENDER_LIMIT = 100;
  const isLongList = shows.length > INITIAL_RENDER_LIMIT + 50;
  const itemListSchema = generateItemListSchema(
    (isLongList ? shows.slice(0, INITIAL_RENDER_LIMIT) : shows).map(show => ({
      name: show.title,
      url: `${BASE_URL}/show/${show.slug}`,
      image: show.images?.hero,
      score: show.criticScore?.score && displaysCriticScore(show) ? Math.round(show.criticScore.score) : undefined,
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
      id: show.id,
      title: show.title,
      slug: show.slug,
      venue: show.venue,
      criticScore: show.criticScore ? { score: show.criticScore.score, reviewCount: show.criticScore.reviewCount, tier1Count: show.criticScore.tier1Count, tier2Count: show.criticScore.tier2Count } : null,
      status: show.status,
      closingDate: show.closingDate,
      type: show.type,
      category: show.category,
    })),
  );

  // Get related pages info
  const relatedPages = config.relatedPages
    .map(slug => getBrowsePageConfig(slug))
    // A flag-gated page (regional, tour) is a 404 while its flag is off.
    .filter((p): p is NonNullable<typeof p> => p !== undefined && (!p.source || isCategoryEnabled(p.source)));

  const schemas = [breadcrumbSchema, itemListSchema, faqSchema].filter(Boolean);

  // Compute display flags
  const isMixedType = new Set(shows.map(s => s.type)).size > 1;
  const statuses = new Set(shows.map(s => s.status === 'open' || s.status === 'previews' || s.status === 'upcoming' ? 'open' : 'closed'));
  const isMixedStatus = statuses.size > 1;
  const hasPerformanceData = config.sort === 'performances';

  // Serialize shows with audience data for client
  const serializedShows: BrowseShow[] = shows.map(show => {
    const grosses = hasPerformanceData ? getShowGrosses(show.slug) : null;
    // Browse cards never render these; dropping them keeps long lists under
    // Googlebot's 2MB fetch limit (BRO-5968).
    const { creativeTeam: _ct, tags: _tags, ageRecommendation: _age, subtitle: _sub, subtitleColor: _subc, ...slim } = serializeShowForClient(show, {
      performances: grosses?.allTime?.performances ?? undefined,
    });
    return config.cityFilter ? { ...slim, hub: ukHubForCity(show.city) } : slim;
  });
  // One pill per hub with shows; a single hub is no choice to offer.
  const hubOptions = config.cityFilter ? ukHubFilterOptions(serializedShows.map(s => s.hub!)) : [];
  const cityFilterOptions = hubOptions.length > 1 ? hubOptions : undefined;

  // Tours hub (BRO-6544): Status filter + Newest default replace the section
  // headings; the server order (customSort) still feeds the ItemList schema.
  const isTourHub = config.source === 'tour';
  const today = new Date().toISOString().slice(0, 10);

  // Top Touring Shows: the best-scored tours on the road now, each with where it is.
  const shelfIds = new Set(isTourHub
    ? shows
        // Same gate as the show page's badge, so the shelf never shows a number the page hides.
        .filter(s => isLiveTour(s) && isTourScored(s) && !isTourScoreHidden(s) && s.criticScore?.score != null)
        .sort((a, b) => (b.criticScore!.score - a.criticScore!.score) || a.title.localeCompare(b.title))
        .slice(0, 12)
        .map(s => s.id)
    : []);
  const shelfShows = serializedShows
    .filter(s => shelfIds.has(s.id))
    .sort((a, b) => (b.criticScore!.score! - a.criticScore!.score!) || a.title.localeCompare(b.title));
  const shelfCaptions: Record<string, string> = {};
  for (const s of shelfShows) {
    const nn = getTourNowNextForShow(s, today);
    if (nn?.now) shelfCaptions[s.id] = `Now in ${shortCity(nn.now.city)}`;
    else if (nn?.next) shelfCaptions[s.id] = `Next: ${shortCity(nn.next.city)}, ${stopDateRange(nn.next.start, nn.next.start)}`;
  }

  // "Touring near you": every city with a page and something still to come; the
  // five busiest as chips. Stops are kept through yesterday (UTC build date):
  // the picker re-filters in the visitor's own time zone, so a run's last
  // night in the Americas survives an evening build.
  const listedIds = new Set(serializedShows.map(s => s.id));
  const keepFrom = new Date(Date.parse(`${today}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
  const tourCityList = isTourHub
    ? Array.from(getTourCities().values()).filter(c => c.stops.some(st => st.end >= today && listedIds.has(st.showId)))
    : [];
  const chipSlugs = new Set(
    [...tourCityList].sort((a, b) => b.upcomingListed - a.upcomingListed || a.city.localeCompare(b.city)).slice(0, 5).map(c => c.slug),
  );
  const tourCities: TourCityOption[] = tourCityList
    .map(c => ({
      slug: c.slug,
      city: c.city,
      chip: chipSlugs.has(c.slug),
      stops: c.stops
        .filter(st => st.end >= keepFrom && listedIds.has(st.showId))
        .map(st => ({
          showId: st.showId, venue: st.venue, start: st.start, end: st.end,
          ticketUrl: getTourStopTickets(st.show)[stopKey(st)],
        })),
    }))
    .sort((a, b) => a.city.localeCompare(b.city));

  // Compute section group labels (server-side, since sectionGroup uses ComputedShow)
  const sectionLabels = !isTourHub && config.sectionGroup
    ? shows.map(show => config.sectionGroup!(show, getShowById, { getShowGrosses }))
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
          <h1 className="text-3xl sm:text-4xl leading-tight sm:leading-tight font-bold text-white mb-3">{config.h1}</h1>
          <p className="text-gray-300 leading-relaxed">{config.intro}</p>
          <p className="text-fg-muted text-sm mt-3">
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
          showRanks={!config.hideRanks && config.limit !== 1 && config.sort !== 'opening-date-asc' && config.sort !== 'opening-date' && config.sort !== 'closing-date'}
          isMixedType={isMixedType}
          isMixedStatus={isMixedStatus}
          defaultSort={isTourHub ? 'opening-date' : config.customSort ? 'custom' : (config.sort || 'score')}
          hasPerformanceData={hasPerformanceData}
          availableSorts={availableSorts}
          showTypeFilter={showTypeFilter}
          cityFilterOptions={cityFilterOptions}
          showScoreToggle={showScoreToggle}
          sectionLabels={sectionLabels}
          upcomingContext={config.slug.startsWith('upcoming-')}
          initialRenderLimit={isLongList ? INITIAL_RENDER_LIMIT : undefined}
          statusFilter={isTourHub}
          tourCities={isTourHub ? tourCities : undefined}
          beforeControls={shelfShows.length > 0 ? (
            <FeaturedRowServer shows={shelfShows} title="Top Touring Shows" captions={shelfCaptions} />
          ) : undefined}
        />

        {(isLongList || isTourHub) && (
          <details className="mt-6 card p-4">
            <summary className="cursor-pointer text-sm font-medium text-gray-300">
              Plain list of all {shows.length} {isTourHub ? 'tours' : 'shows'}
            </summary>
            <ul className="mt-3 columns-1 sm:columns-2 gap-6 text-sm text-gray-400">
              {shows.map(show => (
                <li key={show.id} className="truncate">
                  <Link href={`/show/${show.slug}`} className="hover:text-white transition-colors">{show.title}</Link>
                </li>
              ))}
            </ul>
          </details>
        )}

        {/* National tours: links into the /tours/<city> pages (BRO-4723) */}
        {config.source === 'tour' && <ToursByCity cities={Array.from(getTourCities().values())} />}

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
          <p>{config.howItWorks ?? HOW_IT_WORKS_BY_SOURCE[config.source ?? 'broadway'] ?? HOW_IT_WORKS_BY_SOURCE.broadway}</p>
        </HowThisWorks>
      </div>
    </>
  );
}
