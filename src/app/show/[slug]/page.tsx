import { notFound } from 'next/navigation';
import Link from 'next/link';
import { Metadata } from 'next';
import { getShowBySlug, getAllShowSlugs, getShowLastUpdated, slugify, getRelatedShowsOpen, getRelatedShowsClosed, getOtherProductions, getTheaterBySlug } from '@/lib/data-core';
import { getShowGrosses, getGrossesWeekEnding } from '@/lib/data-grosses';
import { getShowAwards } from '@/lib/data-awards';
import { getAudienceBuzz, getShowScoreUrl, getAudienceGrade, getTotalAudienceReviews, hasEnoughAudienceReviews, getAudiencePlatformUrl } from '@/lib/data-audience';
import { getCriticConsensus } from '@/lib/data-consensus';
import { getLotteryRush } from '@/lib/data-lottery';
import { getShowSchedule, getScheduleCurrentMonday, getShowShowtimeIds } from '@/lib/data-showtimes';
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
import { generateShowSchema, generateBreadcrumbSchema, generateShowFAQSchema, generateCriticReviewsSchema, BASE_URL } from '@/lib/seo';
import { isLondonMarket, getMarketLabel } from '@/lib/venue-classification';
import { getCurrencySymbol } from '@/lib/market-utils';
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
import VideoReviewsShelf from '@/components/VideoReviewsShelf';
import { getVideoReviews } from '@/lib/data-video-reviews';
import { StatusBadge, FormatPill, ProductionPill, CategoryBadge, getScoreColorClass, getScoreTier, getScoreTextColorClass, ScoreBreakdownBar } from '@/components/show-cards';
import MiniShowCard from '@/components/show-cards/MiniShowCard';
import { hasEnoughReviews, reviewsRemainingForScore } from '@/config/score-buckets';
import { getBroadwayDuration, getRunLength } from '@/lib/date-utils';
import TicketLink from '@/components/TicketLink';
import TicketButtonsAB from '@/components/TicketButtonsAB';
import { sortTicketLinks } from '@/lib/ticket-utils';
import { getComparisonsForShow } from '@/config/comparisons';
import ShowPageRatingConnected from '@/components/user/ShowPageRatingConnected';
import ShowPageWatchlistButton from '@/components/user/ShowPageWatchlistButton';
import ShowHeroRedesign from '@/components/show-page/ShowHeroRedesign';
import ShowPageAddToListButton from '@/components/user/ShowPageAddToListButton';
import ShowPageBookmark from '@/components/user/ShowPageBookmark';
import TheaterScorecardCard from '@/components/TheaterScorecardCard';
import SeatingGuidanceCard from '@/components/SeatingGuidanceCard';
import SocialPulseCard from '@/components/show-page/SocialPulseCard';
import { getSocialPulse } from '@/lib/data-social-pulse';

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
  const tier1Count = show.criticScore?.tier1Count || 0;
  const tier2Count = show.criticScore?.tier2Count || 0;
  // Match the on-page UI's TBD gate (StickyScoreHeader + show body): previews
  // and upcoming shows never broadcast a score in metadata even if reviews
  // exist; scored shows must clear the per-market minimum-reviews threshold.
  // Without this, a previews show with 2 high-T1 reviews would show "Rave
  // Reviews (84/100)" in OG/Twitter/title while the page itself shows TBD.
  const isTBD = show.status === 'previews' || show.status === 'upcoming' ||
    !hasEnoughReviews(reviewCount, show.category, tier1Count + tier2Count);
  const synopsisSnippet = show.synopsis
    ? show.synopsis.slice(0, 120).replace(/\s+\S*$/, '...')
    : '';
  const isLondonMeta = isLondonMarket(show.category);
  const isOffWestEndMeta = show.category === 'off-west-end';
  const isOffBroadwayMeta = show.category === 'off-broadway';
  const siteName = isOffWestEndMeta ? 'Off-West End Scorecard' : isLondonMeta ? 'West End Scorecard' : isOffBroadwayMeta ? 'Off-Broadway Scorecard' : 'Broadway Scorecard';
  const marketLabel = isOffWestEndMeta ? 'Off-West End' : isLondonMeta ? 'in the West End' : isOffBroadwayMeta ? 'Off-Broadway' : 'on Broadway';
  const statusLabel = show.status === 'open' ? 'Now Playing' : show.status === 'previews' ? 'In Previews' : show.status === 'upcoming' ? 'Upcoming' : '';

  // Sentiment label maps tier → SEO-friendly phrase used in title + description.
  // Suppressed for TBD shows (previews/upcoming or below review-count threshold)
  // so metadata never broadcasts a verdict the show page itself doesn't show.
  const tier = (!isTBD && roundedScore) ? getScoreTier(roundedScore, show.category) : null;
  const SEO_SENTIMENT: Record<string, string> = {
    'Critical Gold': 'Rave Reviews',
    'Recommended': 'Positive Reviews',
    'Worth Seeing': 'Worth Seeing',
    'Skippable': 'Mixed Reviews',
    'Critical Miss': 'Poor Reviews',
  };
  const sentimentLabel = tier ? (SEO_SENTIMENT[tier.label] ?? null) : null;

  // OG/Twitter titles are seen on social shares (FB, Twitter, iMessage, Slack
  // previews) where a "Mixed Reviews" or "Poor Reviews" label would actively
  // discourage clicks. The <title> tag already has sentiment for SEO/SERP
  // visibility on the tiers where it helps. Restrict OG/Twitter sentiment to
  // tiers where the label is unambiguously positive — anything else falls back
  // to a neutral title that doesn't broadcast a negative signal in shares.
  const OG_POSITIVE_TIERS = new Set(['Critical Gold', 'Recommended']);
  const ogShowsSentiment = !!(tier && roundedScore && sentimentLabel && OG_POSITIVE_TIERS.has(tier.label));
  const ogTitle = ogShowsSentiment
    ? `${show.title} — ${sentimentLabel} (${roundedScore}/100) | ${siteName}`
    : `${show.title} - ${siteName}`;
  const twitterTitle = ogShowsSentiment
    ? `${show.title} — ${sentimentLabel} (${roundedScore}/100)`
    : `${show.title} - CriticScore ${(!isTBD && roundedScore) ? `${roundedScore}/100` : 'TBD'}`;

  // Sentiment-aware description: lead with verdict, not database dump
  const statusPart = statusLabel ? ` ${statusLabel} at ${show.venue}.` : '';
  const synopsisPart = synopsisSnippet ? ` ${synopsisSnippet}` : '';
  const SENTIMENT_PHRASES: Record<string, string> = {
    'Critical Gold': `Critics rave about ${show.title} — ${roundedScore}/100 from ${reviewCount} reviews.`,
    'Recommended': `${show.title} earns positive reviews — ${roundedScore}/100 from ${reviewCount} critics.`,
    'Worth Seeing': `Critics say ${show.title} is worth seeing — ${roundedScore}/100 from ${reviewCount} reviews.`,
    'Skippable': `Critics are mixed on ${show.title} — ${roundedScore}/100 from ${reviewCount} reviews.`,
    'Critical Miss': `${show.title} gets poor reviews from critics — ${roundedScore}/100 from ${reviewCount} reviews.`,
  };
  const description = (score && roundedScore && tier
    ? `${SENTIMENT_PHRASES[tier.label] ?? `${show.title} ${marketLabel} scores ${roundedScore}/100 from ${reviewCount} critic reviews.`}${statusPart}${synopsisPart}`
    : `Read ${reviewCount > 0 ? reviewCount : ''} critic reviews for ${show.title} ${marketLabel}.${statusLabel ? ` ${statusLabel} at ${show.venue}.` : ''} ${synopsisSnippet}`
  ).trim();
  const truncatedDescription = description.length > 160
    ? description.slice(0, 157).replace(/\s\S*$/, '...')
    : description;

  const canonicalUrl = `${BASE_URL}/show/${params.slug}`;

  // OG image is generated by opengraph-image.tsx in this route —
  // Next.js file-based metadata convention auto-injects it into
  // openGraph.images and twitter.images. Renders show hero/poster
  // full-bleed with score badge overlay in bottom-right.

  return {
    title: {
      absolute: roundedScore && sentimentLabel
        ? `${show.title} — ${sentimentLabel} (${roundedScore}/100) | ${siteName}`
        : `${show.title} Reviews ${marketLabel} — ${siteName}`,
    },
    description: truncatedDescription,
    alternates: {
      canonical: canonicalUrl,
    },
    openGraph: {
      title: ogTitle,
      description: truncatedDescription,
      url: canonicalUrl,
      type: 'article',
      siteName,
    },
    twitter: {
      card: 'summary_large_image',
      title: twitterTitle,
      description: truncatedDescription,
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
    label: tier?.label ?? 'Critical Miss',
    colorClass: getScoreTextColorClass(score, category),
  };
}

function getGoogleMapsUrl(address: string): string {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;
}

export default async function ShowPage({ params }: { params: { slug: string } }) {
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
  const isOffWestEnd = show.category === 'off-west-end';
  const isOffBroadway = show.category === 'off-broadway';

  // Theater scorecard lookup (Broadway only)
  const theater = !isWestEnd && !isOffBroadway && show.venue ? getTheaterBySlug(slugify(show.venue)) : undefined;

  const breadcrumbSchema = generateBreadcrumbSchema([
    { name: 'Home', url: isWestEnd ? `${BASE_URL}/west-end` : isOffBroadway ? `${BASE_URL}/off-broadway` : BASE_URL },
    { name: show.type === 'musical' ? 'Musicals' : 'Plays', url: `${BASE_URL}/browse/${getBrowseSlug(show.category, show.type)}` },
    { name: show.title, url: `${BASE_URL}/show/${show.slug}` },
  ]);
  const faqSchema = generateShowFAQSchema(show);
  // Top-level Review objects with itemReviewed → TheaterEvent. Eligible for
  // Google's review snippet rich result; safer than nesting reviews inside Event
  // (which GSC rejected — see seo.ts comment + commit de1f2cba09).
  const criticReviewSchemas = show.criticScore?.reviews
    ? generateCriticReviewsSchema(show, show.criticScore.reviews)
    : [];
  const score = show.criticScore?.score;
  const grosses = getShowGrosses(params.slug);
  const weekEnding = getGrossesWeekEnding();
  const awards = getShowAwards(show.id);
  const audienceBuzz = getAudienceBuzz(show.id);
  const consensus = getCriticConsensus(show.id);
  const lotteryRush = getLotteryRush(show.id);
  const showSchedule = getShowSchedule(show.id);
  const socialPulse = getSocialPulse(show.id);
  const commercial = getShowCommercial(show.slug);
  const sortedTicketLinks = show.ticketLinks ? sortTicketLinks(show.ticketLinks) : [];
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
  const blogReview = await getBlogReviewByShowSlug(show.slug);
  const relatedShowsOpen = getRelatedShowsOpen(show);
  const relatedShowsClosed = (show.category !== 'west-end' && show.category !== 'off-west-end') ? getRelatedShowsClosed(show) : [];
  const otherProductions = getOtherProductions(show);
  const comparisons = getComparisonsForShow(show.slug);
  const videoReviews = getVideoReviews(show.id);

  // Combine schemas, filtering out null FAQ schema
  const schemas = [showSchema, breadcrumbSchema, faqSchema, ...criticReviewSchemas].filter(Boolean);

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

        {/* Redesigned mobile header — feature-flagged. v2 (Broadway Radar–inspired) lives
            entirely inside ShowHeroRedesign; the legacy block below is kept only for the
            unflagged path and for sm: viewports. See memory/feedback_show_page_redesign_v2_decisions.md. */}
        {featureFlags.showPageRedesign && (
          <div className="mb-6">
            <ShowHeroRedesign
              show={show}
              consensusText={consensus?.text ?? null}
              audienceGrade={audienceGrade}
              audienceCount={totalAudienceCount}
              hasAudience={hasAudience}
              hasEnoughCriticReviews={!showTBD}
              sortedTicketLinks={sortedTicketLinks}
              lotteryRush={lotteryRush ?? null}
              isWestEnd={isWestEnd}
              isOffBroadway={isOffBroadway}
            />
          </div>
        )}

        {/* Metacritic-style Header: Poster + Title/Score integrated.
            Hidden when showPageRedesign flag is on — v2 hero handles all sizes. */}
        <div className={`card p-5 sm:p-6 mb-6 ${featureFlags.showPageRedesign ? 'hidden' : ''}`} data-testid="show-header-card">
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
                {isWestEnd ? (
                  <Link href={`/west-end/theater/${slugify(show.venue)}`} className="text-gray-300 hover:text-brand transition-colors">{show.venue}</Link>
                ) : isOffBroadway ? (
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
                      const durationSuffix = isOffWestEnd ? 'Off-West End' : isWestEnd ? 'in the West End' : isOffBroadway ? 'Off-Broadway' : 'on Broadway';
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
                          {(() => {
                            // When TBD is due to low review count (not previews/upcoming),
                            // tell the user how many more reviews are needed rather than a
                            // bare "Based on N Critic Reviews" (which sits next to "TBD" and
                            // reads as contradictory).
                            const remaining = showTBD
                              ? reviewsRemainingForScore(reviewCount, show.category, tier1Count + tier2Count)
                              : 0;
                            const isGatedByReviewCount = showTBD && show.status !== 'previews' && show.status !== 'upcoming' && remaining > 0;
                            if (isGatedByReviewCount) {
                              return (
                                <a href="#critic-reviews" className="text-xs sm:text-sm text-gray-500 hover:text-brand transition-colors">
                                  {reviewCount} {reviewCount === 1 ? 'review' : 'reviews'} · {remaining} more for a CriticScore
                                </a>
                              );
                            }
                            if (reviewCount > 0) {
                              return (
                                <a href="#critic-reviews" className="text-xs sm:text-sm text-gray-500 hover:text-brand transition-colors">
                                  Based on {reviewCount} Critic {reviewCount === 1 ? 'Review' : 'Reviews'}
                                </a>
                              );
                            }
                            return null;
                          })()}
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
                    {/* Review breakdown bar (desktop only — mobile version is rendered full-width below the flex row) */}
                    {!showTBD && show.criticScore?.reviews && show.criticScore.reviews.length > 0 && (
                      <ScoreBreakdownBar
                        reviews={show.criticScore.reviews}
                        category={show.category}
                        className="hidden sm:block"
                      />
                    )}
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

          {/* Mobile-only breakdown bar — rendered full card width below the poster/score row
              so the legend labels don't truncate inside the narrow right column on mobile.
              ariaHidden=true because the desktop copy (rendered inside the right column) already
              has the aria-label; we don't want screen readers reading the same distribution twice. */}
          {(() => {
            const reviewCount = show.criticScore?.reviewCount || 0;
            const tier1Count = show.criticScore?.tier1Count || 0;
            const tier2Count = show.criticScore?.tier2Count || 0;
            const showTBD = show.status === 'previews' || show.status === 'upcoming' || !hasEnoughReviews(reviewCount, show.category, tier1Count + tier2Count);
            if (showTBD || !show.criticScore?.reviews || show.criticScore.reviews.length === 0) return null;
            return (
              <ScoreBreakdownBar
                reviews={show.criticScore.reviews}
                category={show.category}
                className="sm:hidden mt-3"
                ariaHidden
              />
            );
          })()}

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

          {/* Links row: Tickets, Official Site, Trailer, Lottery/Rush + Watchlist */}
          <div className="flex items-center gap-2 mt-4 flex-nowrap">
            <div className="flex flex-wrap gap-2 min-w-0 flex-1">
              {/* Ticket Links — A/B tested (which platform gets the filled primary CTA) */}
              <TicketButtonsAB
                showName={show.title}
                showId={show.id}
                showSlug={show.slug}
                showStatus={show.status}
                showCategory={show.category}
                showScore={show.criticScore?.score ?? null}
                ticketLinks={sortedTicketLinks}
                officialUrl={show.officialUrl}
                pageType="show"
                buttonClassName="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-surface-overlay hover:bg-white/10 text-gray-300 hover:text-white text-xs leading-none font-medium transition-colors border border-white/10"
              />

              {/* Lottery/Rush — subdued style, not a revenue link */}
              {featureFlags.discountTickets && lotteryRush && show.status !== 'closed' && (
                <a
                  href="#discount-tickets"
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-surface-overlay hover:bg-white/10 text-gray-500 hover:text-gray-300 text-xs leading-none font-medium transition-colors border border-white/5"
                >
                  <TicketIcon />
                  {lotteryRush.lottery ? (lotteryRush.lottery.price ? `${getCurrencySymbol(show.category)}${lotteryRush.lottery.price} Lottery` : 'Lottery Tickets') : lotteryRush.rush ? (lotteryRush.rush.price ? `${getCurrencySymbol(show.category)}${lotteryRush.rush.price} Rush` : 'Rush Tickets') : 'Discount Tickets'}
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
          {featureFlags.discountTickets && lotteryRush && (
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
            {featureFlags.showPageRedesign && show.criticScore?.reviews && show.criticScore.reviews.length > 0 && (
              <ScoreBreakdownBar
                reviews={show.criticScore.reviews}
                category={show.category}
                className="sm:hidden mb-4"
              />
            )}

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

        {/* Video Reviews — below Audience Grade, behind feature flag */}
        {featureFlags.videoReviews && videoReviews.length > 0 && (
          <VideoReviewsShelf reviews={videoReviews} />
        )}

        {/* Showtimes — all markets (Broadway via bwayrush, WE/OB via TodayTix) */}
        <div id="showtimes" className="scroll-mt-20" />
        {showSchedule &&
          (show.status === 'open' || show.status === 'previews' || show.status === 'upcoming') && (
          <ShowtimesCard
            schedule={showSchedule}
            currentMonday={getScheduleCurrentMonday()}
            showStatus={show.status}
            ticketLinks={sortedTicketLinks}
            todaytixShowtimes={getShowShowtimeIds(show.id)}
            showName={show.title}
            showId={show.id}
            showSlug={show.slug}
            market={show.category}
          />
        )}

        {/* Seating Chart Scorecard — directly under Showtimes */}
        {theater && (
          <SeatingGuidanceCard
            sections={theater.structuredTips?.seating?.sections}
            bestSeats={theater.structuredTips?.seating?.bestSeats}
            variant="show"
          />
        )}

        {/* Theater Scorecard — directly under Seating Scorecard */}
        {theater?.venueScores && (
          <TheaterScorecardCard
            venueScores={theater.venueScores}
            accessibility={theater.accessibility}
            externalLinks={theater.externalLinks}
            theaterName={theater.name}
            theaterSlug={theater.slug}
          />
        )}

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

        {/* Social Buzz — weekly X+TikTok+Instagram mention tiering */}
        <div id="social-buzz" className="scroll-mt-20" />
        <SocialPulseCard sp={socialPulse} />

        {/* Lottery/Rush Tickets */}
        <div id="discount-tickets" className="scroll-mt-20" />
        {featureFlags.discountTickets && lotteryRush && (() => {
          // Don't show until previews have started
          if (show.previewsStartDate) {
            const previewsStart = new Date(show.previewsStartDate);
            const today = new Date();
            if (today < previewsStart) return null;
          }
          return <LotteryRushCard data={lotteryRush} showStatus={show.status} showCategory={show.category} />;
        })()}

        {/* Awards */}
        <div id="awards" className="scroll-mt-20" />
        {featureFlags.awards && <AwardsCard showId={show.id} awards={awards} openingDate={show.openingDate} />}

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
              const durationSuffix = isOffWestEnd ? 'Off-West End' : isWestEnd ? 'in the West End' : isOffBroadway ? 'Off-Broadway' : 'on Broadway';
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
              <dt className="text-gray-500">{isWestEnd ? 'Theatre' : 'Theater'}</dt>
              <dd className="text-white mt-0.5">
                {isWestEnd ? (
                  <Link href={`/west-end/theater/${slugify(show.venue)}`} className="hover:text-brand transition-colors">{show.venue}</Link>
                ) : isOffBroadway ? (
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
          <section className="mt-8 pt-6 border-t border-white/5">
            <h2 className="text-base font-bold text-white mb-3">Other Productions of {show.title}</h2>
            <div className="flex gap-3 overflow-x-auto pb-3 -mx-4 px-4 sm:mx-0 sm:px-0 scrollbar-hide">
              {otherProductions.map(prod => {
                const openYear = prod.openingDate ? new Date(prod.openingDate + 'T12:00:00').getFullYear() : null;
                const closeYear = prod.closingDate ? new Date(prod.closingDate + 'T12:00:00').getFullYear() : null;
                const yearRange = openYear
                  ? closeYear && closeYear !== openYear
                    ? `${openYear}\u2013${String(closeYear).slice(-2)}`
                    : String(openYear)
                  : null;
                const market = getMarketLabel(prod.category ?? 'broadway');
                const subtitle = [market, yearRange].filter(Boolean).join(' · ');
                const subtitleColor = prod.status === 'open' || prod.status === 'previews' ? 'text-emerald-400' : 'text-gray-400';
                return (
                  <MiniShowCard
                    key={prod.id}
                    show={{ ...prod as unknown as import('@/components/show-cards/types').ShowCardShow, subtitle, subtitleColor }}
                  />
                );
              })}
            </div>
          </section>
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
