import { notFound } from 'next/navigation';
import Link from 'next/link';
import { Metadata } from 'next';
import { getShowBySlug, getAllShowSlugs, getShowLastUpdated, slugify, getRelatedShowsOpen, getRelatedShowsClosed, getOtherProductions } from '@/lib/data-core';
import { getShowGrosses, getGrossesWeekEnding } from '@/lib/data-grosses';
import { getShowAwards } from '@/lib/data-awards';
import { getAudienceBuzz, getShowScoreUrl, getAudienceGrade, getTotalAudienceReviews, hasEnoughAudienceReviews, getAudiencePlatformUrl } from '@/lib/data-audience';
import { getCriticConsensus } from '@/lib/data-consensus';
import { getLotteryRush } from '@/lib/data-lottery';
import { getShowSchedule, getScheduleCurrentMonday } from '@/lib/data-showtimes';
import { getShowCommercial, getRecoupmentTrend } from '@/lib/data-commercial';
import { getCastChanges } from '@/lib/data-cast';
import { getShowCastFile } from '@/lib/data-cast-obc';
import { getActorSlugMap } from '@/lib/data-actors';
import { getCreativeLink } from '@/lib/data-creative';
import { getShowCastTonyMap } from '@/lib/data-tony-noms';
import { getOutletSlugById, getCriticSlugByName } from '@/lib/data-reviews';
import { getShowSeasonGoldLists } from '@/lib/data-gold-list-badges';
import { getBlogReviewByShowSlug } from '@/lib/data-reviews-blog';
import { GOLD_LIST_MAP } from '@/config/gold-lists';
import { GoldListBadge } from '@/components/gold-list/GoldListBadge';
import { featureFlags } from '@/config/feature-flags';
import type { ComputedShow } from '@/lib/data-types';
import { generateShowSchema, generateBreadcrumbSchema, generateShowFAQSchema, BASE_URL, toAbsoluteUrl } from '@/lib/seo';
import { isLondonMarket, getMarketLabel } from '@/lib/venue-classification';
import { getOptimizedImageUrl } from '@/lib/images';
import ShowImage from '@/components/ShowImage';
import StickyScoreHeader from '@/components/StickyScoreHeader';
import ReviewsList from '@/components/ReviewsList';
import BoxOfficeStats from '@/components/BoxOfficeStats';
import AwardsCard from '@/components/AwardsCard';
import AudienceBuzzCard from '@/components/AudienceBuzzCard';
import HowThisWorks from '@/components/HowThisWorks';
import LotteryRushCard from '@/components/LotteryRushCard';
import ShowtimesCard from '@/components/ShowtimesCard';
import BizBuzzCard from '@/components/BizBuzzCard';
import CastUpdatesCard from '@/components/CastUpdatesCard';
import CastSection from '@/components/CastSection';
import Breadcrumb from '@/components/Breadcrumb';
import ShowFollowBanner from '@/components/ShowFollowBanner';
import RelatedShows from '@/components/RelatedShows';
import { StatusBadge, FormatPill, ProductionPill, CategoryBadge, getScoreColorClass, getScoreTier, getScoreTextColorClass } from '@/components/show-cards';
import { hasEnoughReviews } from '@/config/score-buckets';
import { getBroadwayDuration, getRunLength } from '@/lib/date-utils';
import TicketLink from '@/components/TicketLink';
import { getComparisonsForShow } from '@/config/comparisons';
import ShowPageRatingConnected from '@/components/user/ShowPageRatingConnected';
import ShowPageWatchlistButton from '@/components/user/ShowPageWatchlistButton';
import ShowPageAddToListButton from '@/components/user/ShowPageAddToListButton';
import ShowPageBookmark from '@/components/user/ShowPageBookmark';

export const revalidate = 86400;

/** Map category + show type to the correct browse page slug */
function getBrowseSlug(category: string | undefined, type: string): string {
  const isMusical = type === 'musical';
  switch (category) {
    case 'west-end': return isMusical ? 'best-west-end-musicals' : 'best-west-end-plays';
    case 'off-west-end': return isMusical ? 'best-off-west-end-musicals' : 'best-off-west-end-plays';
    case 'off-broadway': return isMusical ? 'best-off-broadway-musicals' : 'best-off-broadway-plays';
    default: return isMusical ? 'best-broadway-musicals' : 'best-broadway-dramas';
  }
}

export function generateStaticParams() {
  // Pre-render open + previews + recently closed shows (high traffic).
  // Rest generated on-demand via ISR, cached at Vercel edge until next deploy.
  const allSlugs = getAllShowSlugs();
  const sixMonthsAgo = new Date(Date.now() - 180 * 86400000);
  const allShows = allSlugs
    .map(slug => getShowBySlug(slug))
    .filter(Boolean) as ComputedShow[];
  return allShows
    .filter(s =>
      s.status === 'open' || s.status === 'previews' ||
      (s.closingDate != null && new Date(s.closingDate) > sixMonthsAgo)
    )
    .map(s => ({ slug: s.slug }));
}

export function generateMetadata({ params }: { params: { slug: string } }): Metadata {
  const show = getShowBySlug(params.slug);
  if (!show) return { title: 'Show Not Found' };

  const score = show.criticScore?.score;
  const roundedScore = score ? Math.round(score) : null;
  const reviewCount = show.criticScore?.reviewCount || 0;
  const synopsisSnippet = show.synopsis
    ? show.synopsis.slice(0, 120).replace(/\s+\S*$/, '...')
    : '';
  const isLondonMeta = isLondonMarket(show.category);
  const isOffBroadwayMeta = show.category === 'off-broadway';
  const siteName = isLondonMeta ? 'West End Scorecard' : isOffBroadwayMeta ? 'Off-Broadway Scorecard' : 'Broadway Scorecard';
  const marketLabel = isLondonMeta ? 'in the West End' : isOffBroadwayMeta ? 'Off-Broadway' : 'on Broadway';
  const statusLabel = show.status === 'open' ? 'Now Playing' : show.status === 'previews' ? 'In Previews' : show.status === 'upcoming' ? 'Upcoming' : '';
  const description = score
    ? `${show.title} ${marketLabel} scores ${roundedScore}/100 from ${reviewCount} critic reviews.${statusLabel ? ` ${statusLabel} at ${show.venue}.` : ''} ${synopsisSnippet}`.trim().slice(0, 160)
    : `Read ${reviewCount > 0 ? reviewCount : ''} critic reviews for ${show.title} ${marketLabel}.${statusLabel ? ` ${statusLabel} at ${show.venue}.` : ''} ${synopsisSnippet}`.trim().slice(0, 160);

  const canonicalUrl = `${BASE_URL}/show/${params.slug}`;

  // Use show's hero/poster image for OG, or fallback to homepage OG
  const ogImageUrl = show.images?.hero
    ? toAbsoluteUrl(show.images.hero)
    : show.images?.poster
      ? toAbsoluteUrl(show.images.poster)
      : `${BASE_URL}/og/home.png`;

  return {
    title: {
      absolute: roundedScore
        ? `${show.title} Reviews (${roundedScore}/100) — ${reviewCount} Critic Reviews Aggregated | ${siteName}`
        : `${show.title} Reviews ${marketLabel} — ${siteName}`,
    },
    description,
    alternates: {
      canonical: canonicalUrl,
    },
    openGraph: {
      title: `${show.title} - ${siteName}`,
      description,
      url: canonicalUrl,
      type: 'article',
      images: [{
        url: ogImageUrl,
        width: 1200,
        height: 630,
        alt: `${show.title} - Score: ${roundedScore ?? 'TBD'} - ${siteName}`,
      }],
    },
    twitter: {
      card: 'summary_large_image',
      title: `${show.title} - CriticScore ${roundedScore ? `${roundedScore}/100` : 'TBD'}`,
      description,
      images: [{
        url: ogImageUrl,
        width: 1200,
        height: 630,
        alt: `${show.title} - Score: ${roundedScore ?? 'TBD'} - ${siteName}`,
      }],
    },
  };
}

// Use UTC-based formatting to avoid timezone-related hydration mismatch
function formatDate(dateStr: string | null | undefined): string {
  // Return empty string for null/undefined/empty dates
  if (!dateStr) {
    return '';
  }

  // Strip ordinal suffixes (1st, 2nd, 3rd, 4th, etc.) that break Date parsing
  const cleanedDateStr = dateStr.replace(/(\d+)(st|nd|rd|th)/gi, '$1');
  const date = new Date(cleanedDateStr);

  // Check for invalid date or Unix epoch (which indicates missing date)
  if (isNaN(date.getTime()) || date.getFullYear() < 1950) {
    return ''; // Hide date instead of showing garbage
  }

  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[date.getUTCMonth()]} ${date.getUTCDate()}, ${date.getUTCFullYear()}`;
}

function MapPinIcon() {
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
    </svg>
  );
}

function PlayIcon() {
  return (
    <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M8 5v14l11-7z" />
    </svg>
  );
}

function GlobeIcon() {
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9" />
    </svg>
  );
}

function TicketIcon() {
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 5v2m0 4v2m0 4v2M5 5a2 2 0 00-2 2v3a2 2 0 110 4v3a2 2 0 002 2h14a2 2 0 002-2v-3a2 2 0 110-4V7a2 2 0 00-2-2H5z" />
    </svg>
  );
}

// Limited Run badge - eye-catching for shows ending soon
function LimitedRunBadge() {
  return (
    <span className="inline-flex items-center px-2.5 py-1 rounded-full text-[10px] leading-none font-semibold uppercase tracking-wide bg-rose-500/15 text-rose-400 border border-rose-500/30">
      LIMITED RUN
    </span>
  );
}

function getSentimentLabel(score: number, category?: string): { label: string; colorClass: string } {
  const tier = getScoreTier(score, category);
  return {
    label: tier?.label ?? 'Stay Away',
    colorClass: getScoreTextColorClass(score, category),
  };
}

function getGoogleMapsUrl(address: string): string {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;
}

export default function ShowPage({ params }: { params: { slug: string } }) {
  const show = getShowBySlug(params.slug);

  if (!show) {
    notFound();
  }

  const lastUpdated = getShowLastUpdated(show.id);
  const castFileForSchema = getShowCastFile(show.id);
  const performers = castFileForSchema?.openingNightCast
    ?.filter(m => m.name && !m.flags?.includes('Standby') && !m.flags?.includes('Understudy'))
    .map(m => ({ name: m.name }));
  const showSchema = generateShowSchema(show, lastUpdated || undefined, performers);
  const isWestEnd = isLondonMarket(show.category);
  const isOffBroadway = show.category === 'off-broadway';
  const breadcrumbSchema = generateBreadcrumbSchema([
    { name: 'Home', url: isWestEnd ? `${BASE_URL}/west-end` : isOffBroadway ? `${BASE_URL}/off-broadway` : BASE_URL },
    { name: show.type === 'musical' ? 'Musicals' : 'Plays', url: `${BASE_URL}/browse/${getBrowseSlug(show.category, show.type)}` },
    { name: show.title, url: `${BASE_URL}/show/${show.slug}` },
  ]);
  const faqSchema = generateShowFAQSchema(show);
  const score = show.criticScore?.score;
  const grosses = getShowGrosses(params.slug);
  const weekEnding = getGrossesWeekEnding();
  const awards = getShowAwards(show.id);
  const audienceBuzz = getAudienceBuzz(show.id);
  const consensus = getCriticConsensus(show.id);
  const lotteryRush = getLotteryRush(show.id);
  const showSchedule = getShowSchedule(show.id);
  const commercial = getShowCommercial(show.slug);
  const castChangesData = getCastChanges(show.id);
  const castFile = getShowCastFile(show.id);
  // Pre-compute actor slug map for clickable cast names
  const castActorSlugs: Record<string, string> = {};
  if (featureFlags.castPages && castFile) {
    const allPersonIds = [
      ...(castFile.openingNightCast || []),
      ...(castFile.currentCast || []),
      ...(castFile.replacements || []),
    ].map(m => m.ibdbPersonId).filter((id): id is string => !!id);
    const slugMap = getActorSlugMap(allPersonIds);
    for (const [id, slug] of Array.from(slugMap.entries())) {
      castActorSlugs[id] = slug;
    }
  }
  const goldListMemberships = getShowSeasonGoldLists(show.id);
  const blogReview = getBlogReviewByShowSlug(show.slug);
  const relatedShowsOpen = getRelatedShowsOpen(show);
  const relatedShowsClosed = (show.category !== 'west-end' && show.category !== 'off-west-end') ? getRelatedShowsClosed(show) : [];
  const otherProductions = getOtherProductions(show);
  const comparisons = getComparisonsForShow(show.slug);

  // Combine schemas, filtering out null FAQ schema
  const schemas = [showSchema, breadcrumbSchema, faqSchema].filter(Boolean);

  // Pre-compute score variables for redesigned mobile header
  const reviewCount = show.criticScore?.reviewCount || 0;
  const tier1Count = show.criticScore?.tier1Count || 0;
  const tier2Count = show.criticScore?.tier2Count || 0;
  const showTBD = show.status === 'previews' || show.status === 'upcoming' || !hasEnoughReviews(reviewCount, show.category, tier1Count + tier2Count);
  const roundedScore = score ? Math.round(score) : null;
  const sentiment = score ? getSentimentLabel(score, show.category) : null;
  const scoreColorClass = (!showTBD && roundedScore !== null)
    ? getScoreColorClass(roundedScore, show.category)
    : 'bg-surface-overlay text-gray-400 border border-white/10';
  const hasAudience = !showTBD && audienceBuzz != null && audienceBuzz.combinedScore != null && hasEnoughAudienceReviews(audienceBuzz);
  const audienceGrade = hasAudience ? getAudienceGrade(audienceBuzz!.combinedScore!) : null;
  const totalAudienceCount = audienceBuzz ? getTotalAudienceReviews(audienceBuzz) : 0;

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(schemas) }}
      />

      {/* Sticky Score Header */}
      <StickyScoreHeader title={show.title} score={score} category={show.category} backHref={isWestEnd ? '/west-end' : isOffBroadway ? '/off-broadway' : '/'} />

      <div className="max-w-3xl mx-auto px-4 sm:px-6 pt-6 sm:pt-8">
        <Breadcrumb items={[
          { label: 'Home', href: isWestEnd ? '/west-end' : isOffBroadway ? '/off-broadway' : '/' },
          { label: show.type === 'musical' ? 'Musicals' : 'Plays', href: `/browse/${getBrowseSlug(show.category, show.type)}` },
          { label: show.title },
        ]} />

        {/* Redesigned mobile header — feature-flagged, demo only */}
        {featureFlags.showPageRedesign && (
          <div className="sm:hidden card p-5 mb-6" data-testid="show-header-card-v2">
            {/* Row 1: Image + Info */}
            <div className="flex gap-4">
              <div className="flex-shrink-0 w-28">
                <div className="relative aspect-[2/3] rounded-xl overflow-visible shadow-2xl border border-white/10 bg-surface-raised">
                  <ShowPageBookmark showId={show.id} size="compact" />
                  <div className="absolute inset-0 rounded-xl overflow-hidden">
                  <ShowImage
                    sources={[
                      show.images?.poster ? getOptimizedImageUrl(show.images.poster, 'poster') : null,
                      show.images?.thumbnail ? getOptimizedImageUrl(show.images.thumbnail, 'poster') : null,
                      show.images?.hero ? getOptimizedImageUrl(show.images.hero, 'poster') : null,
                    ]}
                    alt={`${show.title} poster`}
                    width={176}
                    height={264}
                    decoding="async"
                    priority
                    sizes="112px"
                    className="w-full h-full object-cover"
                    fallback={
                      <div className="w-full h-full flex items-center justify-center bg-surface-overlay">
                        <span className="text-4xl text-gray-500">🎭</span>
                      </div>
                    }
                  />
                  </div>
                </div>
              </div>
              <div className="flex-1 min-w-0">
                {/* Pills */}
                <div className="flex flex-wrap gap-1.5 mb-2">
                  {show.category && show.category !== 'broadway' && (
                    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] leading-none font-semibold uppercase tracking-wide ${show.category === 'west-end' ? 'bg-teal-500/15 text-teal-400 border border-teal-500/30' : show.category === 'off-west-end' ? 'bg-violet-500/15 text-violet-400 border border-violet-500/30' : 'bg-indigo-500/15 text-indigo-400 border border-indigo-500/30'}`}>
                      {show.category === 'west-end' ? 'West End' : show.category === 'off-west-end' ? 'Off-West End' : 'Off-Bway'}
                    </span>
                  )}
                  <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] leading-none font-semibold uppercase tracking-wide ${show.type === 'musical' ? 'bg-purple-500/15 text-purple-400 border border-purple-500/30' : 'bg-blue-500/15 text-blue-400 border border-blue-500/30'}`}>
                    {show.type === 'musical' ? 'Musical' : 'Play'}
                  </span>
                  {show.isRevival && (
                    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] leading-none font-semibold uppercase tracking-wide bg-gray-500/15 text-gray-400 border border-gray-500/30">
                      Revival
                    </span>
                  )}
                  {show.limitedRun && (
                    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] leading-none font-semibold uppercase tracking-wide bg-rose-500/15 text-rose-400 border border-rose-500/30">
                      Limited
                    </span>
                  )}
                </div>
                {/* Title */}
                <h1 className="text-2xl font-extrabold text-white tracking-tight leading-tight mb-2">
                  {show.title}
                </h1>
                {/* Meta — stacked for clarity */}
                <div className="text-gray-400 text-sm space-y-0.5 leading-relaxed">
                  {isWestEnd || isOffBroadway ? (
                    <div className="text-gray-300 font-medium">{show.venue}</div>
                  ) : (
                    <div><Link href={`/theater/${slugify(show.venue)}`} className="text-gray-300 font-medium hover:text-brand transition-colors">{show.venue}</Link></div>
                  )}
                  {show.runtime && <div>{show.runtime}</div>}
                  {show.status === 'previews' || show.status === 'upcoming' ? (
                    formatDate(show.openingDate) ? <div>Opens {formatDate(show.openingDate)}</div> : null
                  ) : (
                    <>
                      {formatDate(show.openingDate) && <div>Opened {formatDate(show.openingDate)}</div>}
                      {show.closingDate && (
                        <div className="text-amber-400">
                          {show.status === 'closed' ? 'Closed' : 'Closes'} {formatDate(show.closingDate)}
                        </div>
                      )}
                    </>
                  )}
                </div>
              </div>
            </div>

            {/* Row 2: Dual Score Boxes + Rating + Links */}
            <div className="mt-4 space-y-4">
              {/* Full-width separator */}
              <div className="-mx-5 border-t border-white/10" />

              {/* Score boxes */}
              <div className="flex gap-3">
                {/* Critic Score */}
                <a href="#critic-reviews" className="flex items-center gap-2 flex-1 min-w-0">
                  <div className={`w-14 h-14 rounded-lg flex items-center justify-center flex-shrink-0 ${scoreColorClass}`}>
                    <span className="text-2xl font-extrabold">
                      {showTBD ? 'TBD' : roundedScore}
                    </span>
                  </div>
                  <div className="min-w-0">
                    {showTBD ? (
                      <div className="text-base font-bold text-gray-400">Awaiting Reviews</div>
                    ) : sentiment && (
                      <div className={`text-base font-bold truncate ${sentiment.colorClass}`}>{sentiment.label}</div>
                    )}
                    <div className="text-xs text-gray-500 leading-snug truncate">
                      {reviewCount > 0 ? `${reviewCount} critic ${reviewCount === 1 ? 'review' : 'reviews'}` : 'No reviews yet'}
                    </div>
                  </div>
                </a>
                {/* Audience Score */}
                {hasAudience && audienceGrade && (
                  <a href="#audience" className="flex items-center gap-2 flex-1 min-w-0">
                    <div className="w-14 h-14 rounded-lg flex items-center justify-center flex-shrink-0 text-xl font-extrabold" style={{ background: audienceGrade.color, color: audienceGrade.textColor }}>
                      {audienceGrade.grade}
                    </div>
                    <div className="min-w-0">
                      <div className="text-base font-bold truncate" style={{ color: audienceGrade.color }}>{audienceGrade.label}</div>
                      <div className="text-xs text-gray-500 leading-snug truncate">
                        {totalAudienceCount.toLocaleString()} audience reviews
                      </div>
                    </div>
                  </a>
                )}
              </div>

              {/* Full-width separator */}
              <div className="-mx-5 border-t border-white/10" />

              {/* User Rating — compact, internal border stripped */}
              <div className="[&>div]:border-t-0 [&>div]:mt-0 [&>div]:pt-0 [&>div]:-mb-0">
                <ShowPageRatingConnected
                  showId={show.id}
                  showTitle={show.title}
                  previewDate={show.previewsStartDate}
                  closingDate={show.closingDate}
                />
              </div>

              {/* Full-width separator */}
              <div className="-mx-5 border-t border-white/10" />

              {/* Action Links + Watchlist — links scroll, watchlist always visible */}
              <div className="flex items-center gap-2">
                <div className="flex-1 min-w-0 overflow-x-auto flex-nowrap scrollbar-hide">
                  <div className="flex gap-2 pb-1">
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
                        pageType="show"
                        totalLinks={(show.ticketLinks?.length ?? 0) + 1}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-surface-overlay hover:bg-white/10 text-gray-300 hover:text-white text-xs leading-none font-medium transition-colors border border-white/10 whitespace-nowrap flex-shrink-0"
                      >
                        <GlobeIcon />
                        Official Site
                      </TicketLink>
                    )}
                    {show.ticketLinks && show.ticketLinks.length > 0 && show.status !== 'closed' && show.ticketLinks.map((link, i) => (
                      <TicketLink
                        key={i}
                        showName={show.title}
                        showId={show.id}
                        showSlug={show.slug}
                        showStatus={show.status}
                        showCategory={show.category}
                        showScore={show.criticScore?.score ?? null}
                        platform={link.platform}
                        url={link.url}
                        pageType="show"
                        linkPosition={i}
                        totalLinks={show.ticketLinks?.length ?? 0}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-surface-overlay hover:bg-white/10 text-gray-300 hover:text-white text-xs leading-none font-medium transition-colors border border-white/10 whitespace-nowrap flex-shrink-0"
                      >
                        <TicketIcon />
                        {link.platform}
                      </TicketLink>
                    ))}
                    {show.trailerUrl && (
                      <a
                        href={show.trailerUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-surface-overlay hover:bg-white/10 text-gray-300 hover:text-white text-xs leading-none font-medium transition-colors border border-white/10 whitespace-nowrap flex-shrink-0"
                      >
                        <PlayIcon />
                        Trailer
                      </a>
                    )}
                    {featureFlags.discountTickets && lotteryRush && show.status !== 'closed' && (
                      <a
                        href="#discount-tickets"
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-400 hover:text-emerald-300 text-xs leading-none font-medium transition-colors border border-emerald-500/30 whitespace-nowrap flex-shrink-0"
                      >
                        <TicketIcon />
                        {lotteryRush.lottery ? `$${lotteryRush.lottery.price} Lottery` : lotteryRush.rush ? `$${lotteryRush.rush.price} Rush` : 'Discount Tickets'}
                      </a>
                    )}
                  </div>
                </div>
                <ShowPageWatchlistButton showId={show.id} />
              </div>
            </div>
          </div>
        )}

        {/* Metacritic-style Header: Poster + Title/Score integrated */}
        <div className={`card p-5 sm:p-6 mb-6 ${featureFlags.showPageRedesign ? 'hidden sm:block' : ''}`} data-testid="show-header-card">
          <div className="flex gap-4 sm:gap-6">
            {/* Poster Card + pills underneath on mobile */}
            <div className="flex-shrink-0 w-28 sm:w-36 lg:w-40 flex flex-col gap-2">
              <div className="relative aspect-[2/3] rounded-xl overflow-visible shadow-2xl border border-white/10 bg-surface-raised">
                <ShowPageBookmark showId={show.id} />
                <div className="absolute inset-0 rounded-xl overflow-hidden">
                <ShowImage
                  sources={[
                    show.images?.poster ? getOptimizedImageUrl(show.images.poster, 'poster') : null,
                    show.images?.thumbnail ? getOptimizedImageUrl(show.images.thumbnail, 'poster') : null,
                    show.images?.hero ? getOptimizedImageUrl(show.images.hero, 'poster') : null,
                  ]}
                  alt={`${show.title} ${isWestEnd ? 'West End' : isOffBroadway ? 'Off-Broadway' : 'Broadway'} ${show.type} poster`}
                  width={176}
                  height={264}
                  decoding="async"
                  priority
                  sizes="(min-width: 1024px) 160px, (min-width: 640px) 144px, 112px"
                  className="w-full h-full object-cover"
                  fallback={
                    <div className="w-full h-full flex items-center justify-center bg-surface-overlay">
                      <span className="text-4xl text-gray-500">🎭</span>
                    </div>
                  }
                />
                </div>
              </div>
              {/* Compact pill labels under poster — mobile only */}
              <div className="flex sm:hidden flex-wrap justify-center gap-x-1.5 gap-y-0.5 text-[9px] font-semibold uppercase tracking-wide leading-none" data-testid="show-pills-poster">
                {show.category && show.category !== 'broadway' && (
                  <span className={show.category === 'west-end' ? 'text-teal-400' : show.category === 'off-west-end' ? 'text-violet-400' : 'text-indigo-400'}>{show.category === 'west-end' ? 'West End' : show.category === 'off-west-end' ? 'Off-West End' : 'Off-Bway'}</span>
                )}
                <span className={show.type === 'musical' ? 'text-purple-400' : 'text-blue-400'}>{show.type === 'musical' ? 'Musical' : 'Play'}</span>
                <span className={show.isRevival ? 'text-gray-400' : 'text-amber-400'}>{show.isRevival ? 'Revival' : 'Original'}</span>
                {show.limitedRun && <span className="text-red-400">Limited</span>}
              </div>
            </div>

            {/* Right side: Title, Meta, Score Box, and Breakdown */}
            <div className="flex-1 min-w-0">
              {/* Pills row — desktop only (mobile pills moved below poster) */}
              <div className="hidden sm:flex flex-wrap items-center gap-1.5 mb-2" data-testid="show-pills-row">
                <CategoryBadge category={show.category} />
                <FormatPill type={show.type} />
                <ProductionPill isRevival={show.isRevival === true} />
                {show.limitedRun && <LimitedRunBadge />}
                <StatusBadge status={show.status} />
              </div>

              {/* Title */}
              <h1 className="text-xl sm:text-2xl lg:text-3xl font-extrabold text-white tracking-tight leading-tight mb-2">
                {show.title}
              </h1>

              {/* Meta line — inline text so it wraps naturally on mobile */}
              <p className="text-gray-400 text-xs sm:text-sm mb-4 leading-relaxed" data-testid="show-meta-line">
                {isWestEnd || isOffBroadway ? (
                  <span className="text-gray-300">{show.venue}</span>
                ) : (
                  <Link href={`/theater/${slugify(show.venue)}`} className="text-gray-300 hover:text-brand transition-colors">{show.venue}</Link>
                )}
                {show.runtime && (
                  <span className="whitespace-nowrap"> <span className="text-gray-500">·</span> {show.runtime}</span>
                )}
                {show.status === 'previews' || show.status === 'upcoming' ? (
                  formatDate(show.openingDate) ? <span> <span className="text-gray-500">·</span> Opens {formatDate(show.openingDate)}</span> : null
                ) : show.closingDate ? (
                  <>
                    {formatDate(show.openingDate) && <span> <span className="text-gray-500">·</span> Opened {formatDate(show.openingDate)}</span>}
                    <span> <span className="text-gray-500">·</span> <span className="text-amber-400">{show.status === 'closed' ? 'Closed' : 'Closes'} {formatDate(show.closingDate)}</span></span>
                    {show.status === 'closed' && (() => {
                      const runLen = getRunLength(show.openingDate, show.closingDate, 'precise');
                      return runLen ? <span> <span className="text-gray-500">·</span> Ran for {runLen}</span> : null;
                    })()}
                  </>
                ) : formatDate(show.openingDate) ? (
                  <>
                    <span> <span className="text-gray-500">·</span> Opened {formatDate(show.openingDate)}</span>
                    {(() => {
                      const durationSuffix = isWestEnd ? 'in the West End' : isOffBroadway ? 'Off-Broadway' : 'on Broadway';
                      const dur = getBroadwayDuration(show.openingDate, durationSuffix);
                      return dur ? <span> <span className="text-gray-500">·</span> {dur}</span> : null;
                    })()}
                  </>
                ) : null}
              </p>

              {/* Score Box + Sentiment + Review Count - Metacritic style */}
              {(() => {
                const reviewCount = show.criticScore?.reviewCount || 0;
                const tier1Count = show.criticScore?.tier1Count || 0;
                const tier2Count = show.criticScore?.tier2Count || 0;
                const showTBD = show.status === 'previews' || show.status === 'upcoming' || !hasEnoughReviews(reviewCount, show.category, tier1Count + tier2Count);
                const roundedScore = score ? Math.round(score) : null;
                const sentiment = score ? getSentimentLabel(score, show.category) : null;

                const scoreColorClass = (!showTBD && roundedScore !== null)
                  ? getScoreColorClass(roundedScore, show.category)
                  : 'bg-surface-overlay text-gray-400 border border-white/10';

                const scoreBox = (
                  <div className={`w-16 h-16 sm:w-20 sm:h-20 rounded-lg flex items-center justify-center flex-shrink-0 ${scoreColorClass}`}>
                    <span className="text-2xl sm:text-4xl font-extrabold">
                      {showTBD ? 'TBD' : roundedScore}
                    </span>
                  </div>
                );

                const hasAudience = !showTBD && audienceBuzz && audienceBuzz.combinedScore != null && hasEnoughAudienceReviews(audienceBuzz);
                const audienceGrade = hasAudience ? getAudienceGrade(audienceBuzz!.combinedScore!) : null;

                return (
                  <div className="space-y-2" data-testid="show-score-section">
                    {/* Score row: box + label + review count */}
                    <div className="flex items-start gap-3 sm:gap-4">
                      {scoreBox}
                      <div className="pt-0.5 min-w-0">
                        {showTBD ? (
                          <div className="text-base sm:text-lg font-bold text-gray-400">Awaiting Reviews</div>
                        ) : sentiment && (
                          <div className={`text-base sm:text-lg font-bold ${sentiment.colorClass}`}>{sentiment.label}</div>
                        )}
                        <div className="flex items-center gap-2 sm:gap-3 flex-wrap mt-0.5">
                          {reviewCount > 0 && (
                            <a
                              href="#critic-reviews"
                              className="text-xs sm:text-sm text-gray-500 hover:text-brand transition-colors"
                            >
                              Based on {reviewCount} Critic {reviewCount === 1 ? 'Review' : 'Reviews'}
                            </a>
                          )}
                          {/* Audience chip — inline on desktop where there's room */}
                          {hasAudience && audienceGrade && (
                            <a href="#audience" className="hidden sm:inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold hover:brightness-125 transition-all" style={{ background: `${audienceGrade.color}15`, color: audienceGrade.color }}>
                              <span className="opacity-60">Audience:</span> {audienceGrade.grade} · {audienceGrade.label}
                            </a>
                          )}
                        </div>
                        {/* Review age note for long-running shows */}
                        {(() => {
                          if (!show.openingDate || show.status === 'closed') return null;
                          const openYear = new Date(show.openingDate).getFullYear();
                          const yearsAgo = new Date().getFullYear() - openYear;
                          if (yearsAgo < 10 || reviewCount < 3) return null;
                          return (
                            <p className="text-[10px] sm:text-xs text-gray-500 mt-1 leading-snug">
                              Most reviews from {yearsAgo} years ago
                            </p>
                          );
                        })()}
                      </div>
                    </div>
                    {/* Review breakdown bar */}
                    {(() => {
                      const revs = show.criticScore?.reviews || [];
                      const pos = revs.filter(r => r.reviewScore >= 65).length;
                      const mix = revs.filter(r => r.reviewScore >= 40 && r.reviewScore < 65).length;
                      const neg = revs.filter(r => r.reviewScore < 40).length;
                      const tot = revs.length;
                      if (tot === 0 || showTBD) return null;
                      const posPct = Math.round((pos / tot) * 100);
                      const mixPct = Math.round((mix / tot) * 100);
                      const negPct = 100 - posPct - mixPct;
                      return (
                        <div className="space-y-1">
                          <div className="h-2 rounded-full overflow-hidden flex bg-surface-overlay">
                            {posPct > 0 && <div className="bg-score-great h-full" style={{ width: `${posPct}%` }} />}
                            {mixPct > 0 && <div className="bg-score-tepid h-full" style={{ width: `${mixPct}%` }} />}
                            {negPct > 0 && <div className="bg-score-skip h-full" style={{ width: `${negPct}%` }} />}
                          </div>
                          <div className="flex items-center gap-2 sm:gap-3 text-[10px] sm:text-xs">
                            {pos > 0 && (
                              <div className="flex items-center gap-1">
                                <div className="w-2 h-2 rounded-sm bg-score-great" />
                                <span className="text-gray-400">{pos} Positive</span>
                              </div>
                            )}
                            {mix > 0 && (
                              <div className="flex items-center gap-1">
                                <div className="w-2 h-2 rounded-sm bg-score-tepid" />
                                <span className="text-gray-400">{mix} Mixed</span>
                              </div>
                            )}
                            {neg > 0 && (
                              <div className="flex items-center gap-1">
                                <div className="w-2 h-2 rounded-sm bg-score-skip" />
                                <span className="text-gray-400">{neg} Negative</span>
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })()}
                    {/* Audience chip — below breakdown bar on mobile */}
                    {hasAudience && audienceGrade && (
                      <a href="#audience" className="sm:hidden inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold hover:brightness-125 transition-all" style={{ background: `${audienceGrade.color}15`, color: audienceGrade.color }}>
                        <span className="opacity-60">Audience:</span> {audienceGrade.grade} · {audienceGrade.label}
                      </a>
                    )}
                  </div>
                );
              })()}
            </div>
          </div>

          {/* Critics' Take - inline below the poster/score row */}
          {consensus && show.criticScore ? (
            <div className="mt-4 pt-4 border-t border-white/5">
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Critics&apos; Take</p>
              <p className="text-gray-300 text-sm leading-relaxed">{consensus.text}</p>
            </div>
          ) : show.synopsis ? (
            <p className="text-gray-400 text-sm leading-relaxed mt-4 pt-4 border-t border-white/5">
              {show.synopsis}
            </p>
          ) : null}

          {/* Links row: Official Site, Tickets, Trailer, Lottery/Rush + Watchlist */}
          <div className="flex items-center gap-2 mt-4 flex-nowrap">
            <div className="flex flex-wrap gap-2 min-w-0 flex-1">
              {/* Official Website */}
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
                  pageType="show"
                  totalLinks={(show.ticketLinks?.length ?? 0) + 1}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-surface-overlay hover:bg-white/10 text-gray-300 hover:text-white text-xs leading-none font-medium transition-colors border border-white/10"
                >
                  <GlobeIcon />
                  Official Site
                </TicketLink>
              )}

              {/* Ticket Links */}
              {show.ticketLinks && show.ticketLinks.length > 0 && show.status !== 'closed' && show.ticketLinks.map((link, i) => (
                <TicketLink
                  key={i}
                  showName={show.title}
                  showId={show.id}
                  showSlug={show.slug}
                  showStatus={show.status}
                  showCategory={show.category}
                  showScore={show.criticScore?.score ?? null}
                  platform={link.platform}
                  url={link.url}
                  pageType="show"
                  linkPosition={i}
                  totalLinks={show.ticketLinks?.length ?? 0}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-surface-overlay hover:bg-white/10 text-gray-300 hover:text-white text-xs leading-none font-medium transition-colors border border-white/10"
                >
                  <TicketIcon />
                  {link.platform}
                </TicketLink>
              ))}

              {/* Trailer */}
              {show.trailerUrl && (
                <a
                  href={show.trailerUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-surface-overlay hover:bg-white/10 text-gray-300 hover:text-white text-xs leading-none font-medium transition-colors border border-white/10"
                >
                  <PlayIcon />
                  Trailer
                </a>
              )}

              {/* Lottery/Rush Quick Link */}
              {featureFlags.discountTickets && lotteryRush && show.status !== 'closed' && (
                <a
                  href="#discount-tickets"
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-400 hover:text-emerald-300 text-xs leading-none font-medium transition-colors border border-emerald-500/30"
                >
                  <TicketIcon />
                  {lotteryRush.lottery ? `$${lotteryRush.lottery.price} Lottery` : lotteryRush.rush ? `$${lotteryRush.rush.price} Rush` : 'Discount Tickets'}
                </a>
              )}
            </div>

            {/* Watchlist + List buttons — right-aligned */}
            <ShowPageAddToListButton showId={show.id} />
            <ShowPageWatchlistButton showId={show.id} />
          </div>

          {/* User Rating — feature-flagged */}
          <ShowPageRatingConnected
            showId={show.id}
            showTitle={show.title}
            previewDate={show.previewsStartDate}
            closingDate={show.closingDate}
          />
        </div>

        {/* Gold List Badges */}
        {featureFlags.goldLists && goldListMemberships.length > 0 && (
          <div className="flex gap-2 mb-6 overflow-x-auto scrollbar-hide">
            {goldListMemberships.map(m => {
              const listConfig = GOLD_LIST_MAP[m.listType];
              if (!listConfig) return null;
              return (
                <Link
                  key={`${m.listType}-${m.season}`}
                  href={`/lists/${m.listType}/${m.season}`}
                  className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium whitespace-nowrap flex-shrink-0 ${listConfig.bgClass} ${listConfig.color} border ${listConfig.borderClass} hover:brightness-125 transition-all`}
                >
                  <GoldListBadge type={m.listType} size="xs" />
                  <span>{listConfig.shortTitle} Gold List #{m.rank}</span>
                  <span className="text-gray-500">({m.season})</span>
                </Link>
              );
            })}
          </div>
        )}

        {/* Historical Production banner — for old closed shows with no reviews */}
        {show.status === 'closed' && (!show.criticScore || show.criticScore.reviewCount === 0) && (() => {
          const bannerYear = show.openingDate ? parseInt(show.openingDate.substring(0, 4)) : null;
          if (bannerYear === null || bannerYear >= 2024) return null;
          return (
            <div className="card p-4 sm:p-5 mb-6 border border-blue-500/20 bg-blue-500/5">
              <div className="flex items-start gap-3">
                <div className="flex-shrink-0 w-8 h-8 rounded-lg flex items-center justify-center bg-blue-500/15">
                  <svg className="w-4 h-4 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                </div>
                <div>
                  <p className="text-sm font-semibold text-blue-300">Historical Production</p>
                  <p className="text-xs text-gray-400 mt-0.5">
                    {`${isWestEnd ? 'West End Scorecard' : isOffBroadway ? 'Off-Broadway Scorecard' : 'Broadway Scorecard'}'s critic review coverage begins in ${isWestEnd ? '2020' : '2005'}. Cast, creative team, and production details are available for this historical production.`}
                  </p>
                </div>
              </div>
            </div>
          );
        })()}

        {/* Blog Review Cross-Link */}
        {blogReview && (
          <Link
            href={`/reviews/${blogReview.slug}`}
            className="card card-interactive p-4 sm:p-5 mb-4 flex items-center justify-between gap-4 group"
          >
            <div className="min-w-0">
              <p className="text-xs font-medium text-brand uppercase tracking-wide mb-1">Our Review</p>
              <p className="text-sm text-gray-200 font-medium truncate">{blogReview.title}</p>
            </div>
            <div className="flex items-center gap-3 flex-shrink-0">
              <span className="text-2xl font-bold text-white">{blogReview.score}</span>
              <span className="text-gray-400 group-hover:text-brand transition-colors">&rarr;</span>
            </div>
          </Link>
        )}

        {/* Section Jump Links — hidden by default, re-enable via sectionJumpLinks feature flag */}
        {featureFlags.sectionJumpLinks && (
        <nav className="flex flex-wrap gap-2 mb-6 text-xs" aria-label="Page sections">
          {show.criticScore && show.criticScore.reviews.length > 0 && (
            <a href="#critic-reviews" className="inline-flex items-center px-3 py-1.5 rounded-full bg-surface-overlay hover:bg-white/10 text-gray-400 hover:text-white leading-none transition-colors">Reviews</a>
          )}
          {audienceBuzz && audienceBuzz.combinedScore != null && (
            <a href="#audience" className="inline-flex items-center px-3 py-1.5 rounded-full bg-surface-overlay hover:bg-white/10 text-gray-400 hover:text-white leading-none transition-colors">Audience</a>
          )}
          {featureFlags.awards && awards && (
            <a href="#awards" className="inline-flex items-center px-3 py-1.5 rounded-full bg-surface-overlay hover:bg-white/10 text-gray-400 hover:text-white leading-none transition-colors">Awards</a>
          )}
          {featureFlags.boxOffice && !isWestEnd && !isOffBroadway && grosses && (
            <a href="#box-office" className="inline-flex items-center px-3 py-1.5 rounded-full bg-surface-overlay hover:bg-white/10 text-gray-400 hover:text-white leading-none transition-colors">Box Office</a>
          )}
          {featureFlags.discountTickets && !isWestEnd && !isOffBroadway && lotteryRush && (
            <a href="#discount-tickets" className="inline-flex items-center px-3 py-1.5 rounded-full bg-surface-overlay hover:bg-white/10 text-gray-400 hover:text-white leading-none transition-colors">Tickets</a>
          )}
          {featureFlags.creativePages && show.creativeTeam && show.creativeTeam.length > 0 && (
            <a href="#creative-team" className="inline-flex items-center px-3 py-1.5 rounded-full bg-surface-overlay hover:bg-white/10 text-gray-400 hover:text-white leading-none transition-colors">Creative</a>
          )}
          {featureFlags.castPages && castFile && (castFile.openingNightCast.length > 0 || (castFile.replacements && castFile.replacements.length > 0)) && (
            <a href="#cast" className="inline-flex items-center px-3 py-1.5 rounded-full bg-surface-overlay hover:bg-white/10 text-gray-400 hover:text-white leading-none transition-colors">Cast</a>
          )}
        </nav>
        )}

        {/* Critic Reviews */}
        {show.criticScore && show.criticScore.reviews.length > 0 ? (
          <div id="critic-reviews" className="card p-5 sm:p-6 mb-8 scroll-mt-20">
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-lg font-bold text-white">Critic Reviews</h2>
              <span className="text-sm text-gray-400 font-medium">{show.criticScore.reviewCount} {show.criticScore.reviewCount === 1 ? 'review' : 'reviews'}</span>
            </div>

            {/* Breakdown bar — shown when redesign moves it out of the header card */}
            {featureFlags.showPageRedesign && (() => {
              const revs = show.criticScore?.reviews || [];
              const pos = revs.filter(r => r.reviewScore >= 65).length;
              const mix = revs.filter(r => r.reviewScore >= 40 && r.reviewScore < 65).length;
              const neg = revs.filter(r => r.reviewScore < 40).length;
              const tot = revs.length;
              if (tot === 0) return null;
              const posPct = Math.round((pos / tot) * 100);
              const mixPct = Math.round((mix / tot) * 100);
              const negPct = 100 - posPct - mixPct;
              return (
                <div className="sm:hidden space-y-1.5 mb-4">
                  <div className="h-2.5 rounded-full overflow-hidden flex bg-surface-overlay">
                    {posPct > 0 && <div className="bg-score-great h-full" style={{ width: `${posPct}%` }} />}
                    {mixPct > 0 && <div className="bg-score-tepid h-full" style={{ width: `${mixPct}%` }} />}
                    {negPct > 0 && <div className="bg-score-skip h-full" style={{ width: `${negPct}%` }} />}
                  </div>
                  <div className="flex items-center gap-3 text-xs">
                    {pos > 0 && (
                      <div className="flex items-center gap-1">
                        <div className="w-2.5 h-2.5 rounded-sm bg-score-great" />
                        <span className="text-gray-400">{pos} Positive</span>
                      </div>
                    )}
                    {mix > 0 && (
                      <div className="flex items-center gap-1">
                        <div className="w-2.5 h-2.5 rounded-sm bg-score-tepid" />
                        <span className="text-gray-400">{mix} Mixed</span>
                      </div>
                    )}
                    {neg > 0 && (
                      <div className="flex items-center gap-1">
                        <div className="w-2.5 h-2.5 rounded-sm bg-score-skip" />
                        <span className="text-gray-400">{neg} Negative</span>
                      </div>
                    )}
                  </div>
                </div>
              );
            })()}

            <ReviewsList reviews={show.criticScore.reviews.map(r => ({
              ...r,
              outletSlug: getOutletSlugById(r.outletId) || undefined,
              criticSlug: r.criticName ? getCriticSlugByName(r.criticName) : null,
            }))} initialCount={5} category={show.category} />
          </div>
        ) : show.status === 'previews' || show.status === 'upcoming' ? (
          <div id="critic-reviews" className="card p-5 sm:p-6 mb-8 scroll-mt-20">
            <h2 className="text-lg font-bold text-white mb-3">Critic Reviews</h2>
            <p className="text-gray-400 text-sm">
              Reviews coming after {isWestEnd ? 'press night' : 'opening night'}: <span className="text-white font-medium">{formatDate(show.openingDate)}</span>
            </p>
          </div>
        ) : (
          <div id="critic-reviews" className="card p-5 sm:p-6 mb-8 scroll-mt-20">
            <h2 className="text-lg font-bold text-white mb-3">Critic Reviews</h2>
            <p className="text-gray-400 text-sm">
              Archived critic reviews for this production are being collected and will appear here as they&apos;re processed.
            </p>
          </div>
        )}

        {/* Audience Buzz Section - below Critic Reviews */}
        <div id="audience" className="scroll-mt-20" />
        {audienceBuzz && audienceBuzz.combinedScore != null && (() => {
          // Minimum 5 total reviews across all sources to display
          const totalReviews = Object.values(audienceBuzz.sources || {}).reduce((sum, s) => sum + (s?.reviewCount || 0), 0);
          return totalReviews >= 5;
        })() ? (() => {
          const sourceCount = Object.values(audienceBuzz.sources || {}).filter(Boolean).length;
          const showYear = show.openingDate ? parseInt(show.openingDate.substring(0, 4)) : null;
          const isHistorical = show.status === 'closed' && showYear !== null && showYear < 2015;
          return (
            <AudienceBuzzCard
              buzz={audienceBuzz}
              showScoreUrl={audienceBuzz.sources.showScore ? getShowScoreUrl(show.id) : undefined}
              limitedSources={isHistorical && sourceCount <= 1}
              market={(show.category as 'broadway' | 'west-end' | 'off-broadway' | 'off-west-end') || 'broadway'}
              platformUrls={Object.fromEntries(
                Object.keys(audienceBuzz.sources)
                  .filter(k => k !== 'showScore')
                  .map(k => [k, getAudiencePlatformUrl(k, show.id, show.title)])
                  .filter((entry): entry is [string, string] => entry[1] != null)
              )}
            />
          );
        })() : show.status === 'previews' || show.status === 'upcoming' ? (
          <section className="card p-5 sm:p-6 mb-6">
            <h2 className="text-lg font-bold text-white mb-3">Audience Grade</h2>
            <p className="text-gray-400 text-sm">Audience data will be added once the show opens and reviews come in.</p>
          </section>
        ) : show.status === 'closed' && (() => {
          const showYear = show.openingDate ? parseInt(show.openingDate.substring(0, 4)) : null;
          const isPreDigital = showYear !== null && showYear < 2015;
          return isPreDigital ? (
            <section className="card p-5 sm:p-6 mb-6">
              <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wide mb-3">Audience Grade</h2>
              <p className="text-sm text-gray-500">This show predates most audience rating platforms. Critic reviews only.</p>
            </section>
          ) : null;
        })()}

        {/* Awards - above Box Office */}
        <div id="awards" className="scroll-mt-20" />
        {featureFlags.awards && <AwardsCard showId={show.id} awards={awards} openingDate={show.openingDate} />}

        {/* Box Office Stats — Broadway only (no public OB/WE gross data) */}
        <div id="box-office" className="scroll-mt-20" />
        {featureFlags.boxOffice && !isWestEnd && !isOffBroadway && (
          grosses && ((show.status !== 'previews' && show.status !== 'upcoming') || grosses.thisWeek) ? (
            <BoxOfficeStats grosses={grosses} weekEnding={weekEnding} />
          ) : show.status === 'previews' || show.status === 'upcoming' ? (
            <section className="card p-5 sm:p-6 mb-6">
              <h2 className="text-lg font-bold text-white mb-3">Box Office</h2>
              <p className="text-gray-400 text-sm">Box office data starts one week after previews begin.</p>
            </section>
          ) : null
        )}

        {/* Commercial Scorecard — Broadway only */}
        {featureFlags.commercial && !isWestEnd && !isOffBroadway && (
          commercial ? (
            <BizBuzzCard
              commercial={commercial}
              showTitle={show.title}
              trend={getRecoupmentTrend(show.slug)}
              weeklyGross={grosses?.thisWeek?.gross}
              showStatus={show.status as 'open' | 'closed' | 'previews' | 'upcoming'}
              allTimeGross={grosses?.allTime?.gross}
            />
          ) : show.status === 'previews' || show.status === 'upcoming' ? (
            <section className="card p-5 sm:p-6 mb-6">
              <h2 className="text-lg font-bold text-white mb-3">Commercial Performance</h2>
              <p className="text-gray-400 text-sm">Financial data not available yet.</p>
            </section>
          ) : null
        )}

        {/* Showtimes — Broadway only */}
        <div id="showtimes" className="scroll-mt-20" />
        {!isWestEnd && !isOffBroadway && showSchedule &&
          (show.status === 'open' || show.status === 'previews' || show.status === 'upcoming') && (
          <ShowtimesCard
            schedule={showSchedule}
            currentMonday={getScheduleCurrentMonday()}
            showStatus={show.status}
            todayTixUrl={show.ticketLinks?.find(l => l.platform === 'TodayTix')?.url}
            showName={show.title}
            showId={show.id}
            showSlug={show.slug}
          />
        )}

        {/* Lottery/Rush Tickets — Broadway only */}
        <div id="discount-tickets" className="scroll-mt-20" />
        {featureFlags.discountTickets && !isWestEnd && !isOffBroadway && lotteryRush && (() => {
          // Don't show until previews have started
          if (show.previewsStartDate) {
            const previewsStart = new Date(show.previewsStartDate);
            const today = new Date();
            if (today < previewsStart) return null;
          }
          return <LotteryRushCard data={lotteryRush} showStatus={show.status} />;
        })()}

        {/* Cast Updates - below Lottery/Rush */}
        {featureFlags.castChanges && castChangesData && (
          <CastUpdatesCard castChanges={castChangesData} showStatus={show.status} />
        )}

        {/* Creative Team — show only principal roles */}
        <div id="creative-team" className="scroll-mt-20" />
        {featureFlags.creativePages && show.creativeTeam && show.creativeTeam.length > 0 && (() => {
          const PRINCIPAL_ROLES = /^(director|co-director|book|music|lyrics|playwright|composer|lyricist|book writer|co-writer|author|translator|adaptation|english lyrics)/i;
          const principals = show.creativeTeam.filter(m => PRINCIPAL_ROLES.test(m.role));
          return principals.length > 0 ? (
          <div className="mb-8">
            <div className="card p-5 sm:p-6">
              <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wide mb-3">Creative Team</h2>
              <ul className="space-y-2.5 sm:space-y-2">
                {principals.map((member, i) => {
                  const creativeLink = getCreativeLink(member.name, member.role);
                  return (
                  <li key={i} className="flex flex-col sm:flex-row sm:items-baseline text-sm gap-0.5 sm:gap-0">
                    {featureFlags.creativePages && creativeLink ? (
                      <Link href={creativeLink} className="text-white font-medium hover:text-brand transition-colors">{member.name}</Link>
                    ) : (
                      <span className="text-white font-medium">{member.name}</span>
                    )}
                    <span className="text-gray-500 text-xs sm:text-sm sm:before:content-['·'] sm:before:mx-2 sm:before:text-gray-600">{member.role}</span>
                  </li>
                  );
                })}
              </ul>
            </div>
          </div>
          ) : null;
        })()}

        {/* Cast — OBC and current cast from IBDB */}
        <div id="cast" className="scroll-mt-20" />
        {featureFlags.castPages && castFile && (castFile.openingNightCast.length > 0 || (castFile.replacements && castFile.replacements.length > 0)) && (
          <CastSection
            openingNightCast={castFile.openingNightCast}
            currentCast={castFile.currentCast}
            currentCastUpdatedAt={castFile.currentCastUpdatedAt || null}
            replacements={castFile.replacements}
            showStatus={show.status}
            category={show.category}
            actorSlugs={castActorSlugs}
            tonyMap={getShowCastTonyMap(show.id)}
          />
        )}

        {/* Quick Facts - Structured data for users and AI systems */}
        <div className="card p-4 sm:p-5 mb-8">
          <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wide mb-4">Quick Facts</h2>
          <dl className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4 text-sm">
            {/* Key metrics first for AI extractability */}
            {score && show.criticScore && hasEnoughReviews(show.criticScore.reviewCount, show.category, (show.criticScore.tier1Count || 0) + (show.criticScore.tier2Count || 0)) && (
              <div>
                <dt className="text-gray-500">CriticScore</dt>
                <dd className="text-white mt-0.5 font-semibold">{Math.round(score)}/100 <span className="font-normal text-gray-400">({show.criticScore.reviewCount} {show.criticScore.reviewCount === 1 ? 'review' : 'reviews'})</span></dd>
              </div>
            )}
            <div>
              <dt className="text-gray-500">Status</dt>
              <dd className="text-white mt-0.5">
                {show.status === 'open' ? 'Now Playing' : show.status === 'previews' ? 'In Previews' : show.status === 'upcoming' ? 'Upcoming' : 'Closed'}
              </dd>
            </div>
            <div>
              <dt className="text-gray-500">{show.status === 'previews' || show.status === 'upcoming' ? 'Opens' : 'Opened'}</dt>
              <dd className="text-white mt-0.5">{formatDate(show.openingDate)}</dd>
            </div>
            {show.previewsStartDate && (show.status === 'previews' || show.status === 'upcoming') && (
              <div>
                <dt className="text-gray-500">Previews Start</dt>
                <dd className="text-white mt-0.5">{formatDate(show.previewsStartDate)}</dd>
              </div>
            )}
            {show.closingDate && (
              <div>
                <dt className="text-gray-500">{show.status === 'closed' ? 'Closed' : 'Closes'}</dt>
                <dd className="text-white mt-0.5">{formatDate(show.closingDate)}</dd>
              </div>
            )}
            {show.status === 'closed' && (() => {
              const runLen = getRunLength(show.openingDate, show.closingDate, 'precise');
              return runLen ? (
                <div>
                  <dt className="text-gray-500">Run Length</dt>
                  <dd className="text-white mt-0.5">{runLen}</dd>
                </div>
              ) : null;
            })()}
            {show.status === 'open' && (() => {
              const durationSuffix = isWestEnd ? 'in the West End' : isOffBroadway ? 'Off-Broadway' : 'on Broadway';
              const dur = getBroadwayDuration(show.openingDate, durationSuffix);
              return dur ? (
                <div>
                  <dt className="text-gray-500">Running</dt>
                  <dd className="text-white mt-0.5">{dur}</dd>
                </div>
              ) : null;
            })()}
            <div>
              <dt className="text-gray-500">Runtime</dt>
              <dd className="text-white mt-0.5">{show.runtime}</dd>
            </div>
            {show.intermissions !== undefined && (
              <div>
                <dt className="text-gray-500">Intermissions</dt>
                <dd className="text-white mt-0.5">{show.intermissions}</dd>
              </div>
            )}
            {show.ageRecommendation && (
              <div>
                <dt className="text-gray-500">Age</dt>
                <dd className="text-white mt-0.5">{show.ageRecommendation}</dd>
              </div>
            )}
            <div className="sm:col-span-2">
              <dt className="text-gray-500">Theater</dt>
              <dd className="text-white mt-0.5">
                {isWestEnd || isOffBroadway ? (
                  <span>{show.venue}</span>
                ) : (
                  <Link href={`/theater/${slugify(show.venue)}`} className="hover:text-brand transition-colors">{show.venue}</Link>
                )}
                {show.theaterAddress && (
                  <>
                    {' — '}
                    <a
                      href={getGoogleMapsUrl(show.theaterAddress)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-gray-400 hover:text-brand transition-colors"
                    >
                      <MapPinIcon />
                      {show.theaterAddress}
                    </a>
                  </>
                )}
              </dd>
            </div>
            {show.synopsis && (
              <div className="sm:col-span-2 pt-2 mt-2 border-t border-white/5">
                <dt className="text-gray-500">Synopsis</dt>
                <dd className="text-gray-300 mt-1 leading-relaxed">{show.synopsis}</dd>
              </div>
            )}
            {lastUpdated && (
              <div className="sm:col-span-2 pt-2 mt-2 border-t border-white/5">
                <dt className="text-gray-500">Data Last Updated</dt>
                <dd className="text-gray-400 mt-0.5 text-xs">
                  {new Date(lastUpdated).toLocaleDateString('en-US', {
                    month: 'long',
                    day: 'numeric',
                    year: 'numeric'
                  })}
                </dd>
              </div>
            )}
          </dl>
        </div>

        {/* Other Productions of the same show */}
        {otherProductions.length > 0 && (
          <div className="mt-6 bg-surface-raised border border-white/10 rounded-xl p-4">
            <h3 className="text-sm font-semibold text-gray-300 uppercase tracking-wide mb-3">
              Other Productions of {show.title}
            </h3>
            <div className="space-y-2">
              {otherProductions.map(prod => {
                const market = prod.category === 'west-end' ? 'West End' : prod.category === 'off-west-end' ? 'Off-West End' : prod.category === 'off-broadway' ? 'Off-Broadway' : 'Broadway';
                const year = prod.openingDate ? new Date(prod.openingDate).getFullYear() : null;
                const statusLabel = prod.status === 'open' ? 'Now Playing' : prod.status === 'previews' ? 'In Previews' : prod.status === 'upcoming' ? 'Upcoming' : 'Closed';
                return (
                  <Link key={prod.id} href={`/show/${prod.slug}`} className="flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-white/5 transition-colors group">
                    <span className="text-sm text-white group-hover:text-brand transition-colors">{prod.title}{year ? ` (${year})` : ''}</span>
                    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium ${prod.category === 'west-end' ? 'bg-teal-500/20 text-teal-400' : prod.category === 'off-west-end' ? 'bg-violet-500/20 text-violet-400' : prod.category === 'off-broadway' ? 'bg-indigo-500/20 text-indigo-400' : 'bg-amber-500/20 text-amber-400'}`}>{market}</span>
                    <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${prod.status === 'open' ? 'bg-emerald-500/20 text-emerald-400' : prod.status === 'previews' ? 'bg-purple-500/20 text-purple-400' : prod.status === 'upcoming' ? 'bg-blue-500/20 text-blue-400' : 'bg-gray-500/20 text-gray-400'}`}>{statusLabel}</span>
                  </Link>
                );
              })}
            </div>
          </div>
        )}

        {/* Related Shows */}
        <RelatedShows shows={relatedShowsOpen} title="Open Shows You Might Like" />
        {show.category !== 'west-end' && show.category !== 'off-west-end' && (
          <RelatedShows shows={relatedShowsClosed} title="Closed Shows You Might Like" />
        )}

        {/* Compare This Show */}
        {comparisons.length > 0 && (
          <div className="mt-4 text-sm text-gray-400">
            <span className="text-gray-500">Compare: </span>
            {comparisons.slice(0, 6).map((comp, i) => (
              <span key={comp.slug}>
                {i > 0 && <span className="text-gray-600"> · </span>}
                <Link href={`/compare/${comp.slug}`} className="text-gray-400 hover:text-white transition-colors">
                  vs {comp.otherSlug.replace(/-\d{4}$/, '').replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}
                </Link>
              </span>
            ))}
          </div>
        )}

        {/* How Scores Work */}
        <HowThisWorks heading="How This Score Works" className="mt-6">
          <p>
            The CriticScore is a weighted average of professional critic reviews.
            {isWestEnd
              ? ' Top-tier outlets (The Guardian, The Times, The Telegraph) carry more weight than smaller publications.'
              : ' Top-tier outlets (NYT, Vulture, Variety) carry more weight than smaller publications.'}
            {' '}Each review is scored 0&ndash;100 based on the critic&apos;s language and explicit ratings.
          </p>
        </HowThisWorks>
      </div>

      {/* Follow Show Banner */}
      {show.status !== 'closed' && (
        <ShowFollowBanner showId={show.id} showTitle={show.title} />
      )}
    </>
  );
}
