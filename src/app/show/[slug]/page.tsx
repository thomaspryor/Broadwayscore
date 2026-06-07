import { notFound } from 'next/navigation';
import Link from 'next/link';
import { Metadata } from 'next';
import { Suspense } from 'react';
import dynamic from 'next/dynamic';
import { getShowBySlug, getRecentShowSlugs, getShowLastUpdated, slugify, getRelatedShowsOpen, getRelatedShowsClosed, getOtherProductions, getTheaterBySlug, getOperaTitleSlug } from '@/lib/data-core';
import { getShowGrosses, getGrossesWeekEnding } from '@/lib/data-grosses';
import { getShowAwards } from '@/lib/data-awards';
import { getTonyNamesByCategory } from '@/lib/data-tony-noms';
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
import { getBlogReviewByShowSlug } from '@/lib/data-reviews-blog';
import { featureFlags } from '@/config/feature-flags';
import { generateShowSchema, generateBreadcrumbSchema, generateShowFAQSchema, generateCriticReviewsSchema, BASE_URL } from '@/lib/seo';
import { isLondonMarket } from '@/lib/venue-classification';
import { getCurrencySymbol } from '@/lib/market-utils';
import { isOperaShow } from '@/lib/show-market';
import { getOptimizedImageUrl } from '@/lib/images';
import ShowImage from '@/components/ShowImage';
import StickyScoreHeader from '@/components/StickyScoreHeader';
import ReviewsList from '@/components/ReviewsList';
import Breadcrumb from '@/components/Breadcrumb';
import ShowFollowBanner from '@/components/ShowFollowBanner';
import ShowPageBelowFoldLoader from '@/components/show-page/ShowPageBelowFoldLoader';
import { getVideoReviews } from '@/lib/data-video-reviews';
import { StatusBadge, FormatPill, ProductionPill, CategoryBadge, getScoreColorClass, getScoreTier, getScoreTextColorClass, ScoreBreakdownBar } from '@/components/show-cards';
import { hasEnoughReviews, reviewsRemainingForScore } from '@/config/score-buckets';
import { CURATED_HISTORICAL_SHOWS } from '@/config/scoring';
import { getBroadwayDuration, getRunLength } from '@/lib/date-utils';
import TicketLink from '@/components/TicketLink';
import TicketButtonsAB from '@/components/TicketButtonsAB';
import { sortTicketLinks } from '@/lib/ticket-utils';
import { getComparisonsForShow } from '@/config/comparisons';
import ShowHeroRedesign from '@/components/show-page/ShowHeroRedesign';
import ShowPageBookmark from '@/components/user/ShowPageBookmark';
import { RedesignOn, RedesignOff } from '@/components/show-page/RedesignGate';
import { getSocialPulse } from '@/lib/data-social-pulse';
import { getShowRanks } from '@/lib/data-show-ranks';
import { getBrowseSlug } from '@/lib/browse-slugs';
import HeroRankLine from '@/components/show-page/HeroRankLine';
import { AwardsNavLink } from '@/components/AwardsNavLink';

// Group A: personalized, auth-dependent — ssr:false so they don't block
// the pre-rendered HTML, Suspense prevents hydration mismatch.
const ShowPageRatingConnected = dynamic(
  () => import('@/components/user/ShowPageRatingConnected'),
  { ssr: false }
);
const ShowPageWatchlistButton = dynamic(
  () => import('@/components/user/ShowPageWatchlistButton'),
  { ssr: false }
);
const ShowPageAddToListButton = dynamic(
  () => import('@/components/user/ShowPageAddToListButton'),
  { ssr: false }
);

export const revalidate = 86400;

// getBrowseSlug moved to src/lib/browse-slugs.ts so WhereItRanks + breadcrumb
// share the same mapping (plays land on best-broadway-dramas, etc.). See that
// file for documentation on the dramas-vs-plays slug convention.

export function generateStaticParams() {
  // Pre-render open + previews + recently closed shows (high traffic).
  // Rest generated on-demand via ISR, cached at Vercel edge until next deploy.
  // Uses getRecentShowSlugs() which reads shows.json directly — skips the
  // ComputedShow scoring graph that getShowBySlug() per slug would trigger.
  return getRecentShowSlugs().map(slug => ({ slug }));
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
  const isCuratedHistorical = CURATED_HISTORICAL_SHOWS.has(show.id);
  const isTBD = show.status === 'previews' || show.status === 'upcoming' ||
    !hasEnoughReviews(reviewCount, show.category, tier1Count + tier2Count, isCuratedHistorical);
  const synopsisSnippet = show.synopsis
    ? show.synopsis.slice(0, 120).replace(/\s+\S*$/, '...')
    : '';
  const isLondonMeta = isLondonMarket(show.category);
  const isOffWestEndMeta = show.category === 'off-west-end';
  const isOffBroadwayMeta = show.category === 'off-broadway';
  const isOperaMeta = isOperaShow(show);
  const siteName = isOperaMeta ? 'Opera Scorecard' : isOffWestEndMeta ? 'Off-West End Scorecard' : isLondonMeta ? 'West End Scorecard' : isOffBroadwayMeta ? 'Off-Broadway Scorecard' : 'Broadway Scorecard';
  const marketLabel = isOperaMeta ? 'at the Met' : isOffWestEndMeta ? 'Off-West End' : isLondonMeta ? 'in the West End' : isOffBroadwayMeta ? 'Off-Broadway' : 'on Broadway';
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

export default async function ShowPage({ params }: { params: { slug: string } }) {
  const show = getShowBySlug(params.slug);

  if (!show) {
    notFound();
  }

  const lastUpdated = getShowLastUpdated(show.id);
  const castFileForSchema = getShowCastFile(show.id);
  const performers = castFileForSchema?.openingNightCast
    ?.filter(m =>
      m.name &&
      m.ibdbPersonId &&  // exclude orphans — UI tells users "not in our DB" via tooltip; don't contradict that in schema.org
      !m.flags?.includes('Standby') &&
      !m.flags?.includes('Understudy')
    )
    .map(m => ({ name: m.name }));
  const showSchema = generateShowSchema(show, lastUpdated || undefined, performers);
  const isWestEnd = isLondonMarket(show.category);
  const isOffWestEnd = show.category === 'off-west-end';
  const isOffBroadway = show.category === 'off-broadway';
  const isOpera = isOperaShow(show);

  // Theater scorecard lookup (Broadway only)
  const theater = !isWestEnd && !isOffBroadway && show.venue ? getTheaterBySlug(slugify(show.venue)) : undefined;

  const breadcrumbSchema = isOpera
    ? generateBreadcrumbSchema([
        { name: 'Home', url: BASE_URL },
        { name: 'Opera', url: `${BASE_URL}/opera` },
        { name: show.title, url: `${BASE_URL}/opera/${getOperaTitleSlug(show.slug)}` },
      ])
    : generateBreadcrumbSchema([
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
  const tonyNamesByCategory = getTonyNamesByCategory(show.id);
  const audienceBuzz = getAudienceBuzz(show.id);
  const consensus = getCriticConsensus(show.id);
  const lotteryRush = getLotteryRush(show.id);
  const showSchedule = getShowSchedule(show.id);
  // Social buzz is only meaningful for currently-running shows. getSocialPulse
  // already suppresses stale fetches; this status gate additionally hides the
  // card for upcoming/closed shows (whose files are frozen and never refresh).
  const socialPulse =
    show.status === 'open' || show.status === 'previews' ? getSocialPulse(show.id) : null;
  // Cross-show ranks. Flag-gated for safe rollout — toggle in Vercel env
  // (NEXT_PUBLIC_FEATURES=showRanks). O(1) lookup after the module-scope
  // index is built on first call. 'all' format slice powers the hero rank
  // line; the bottom WhereItRanks card additionally requests the show's-own-
  // format slice.
  const ranks = featureFlags.showRanks ? getShowRanks(show.id, { format: 'all' }) : null;
  const ranksByFormat = featureFlags.showRanks && (show.type === 'musical' || show.type === 'play')
    ? getShowRanks(show.id, { format: show.type })
    : null;
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
  const blogReview = await getBlogReviewByShowSlug(show.slug);
  const relatedShowsOpen = getRelatedShowsOpen(show);
  const relatedShowsClosed = (show.category !== 'west-end' && show.category !== 'off-west-end') ? getRelatedShowsClosed(show) : [];
  const otherProductions = getOtherProductions(show);
  const comparisons = getComparisonsForShow(show.slug);
  const videoReviews = getVideoReviews(show.id);

  // Pre-compute values that would require data-module imports in a client component.
  // These are passed as serializable props to ShowPageBelowFoldLoader.
  const audienceShowScoreUrl = audienceBuzz?.sources.showScore ? getShowScoreUrl(show.id) : undefined;
  const audiencePlatformUrls: Record<string, string> = audienceBuzz ? Object.fromEntries(
    Object.keys(audienceBuzz.sources)
      .filter(k => k !== 'showScore')
      .map(k => [k, getAudiencePlatformUrl(k, show.id, show.title)])
      .filter((entry): entry is [string, string] => entry[1] != null)
  ) : {};
  const currentMonday = getScheduleCurrentMonday();
  const showtimeIds = getShowShowtimeIds(show.id);
  const castTonyMap = featureFlags.castPages ? getShowCastTonyMap(show.id) : {};
  const recoupmentTrend = getRecoupmentTrend(show.slug);
  const venueSlug = show.venue ? slugify(show.venue) : null;
  const PRINCIPAL_ROLES = /^(director|co-director|book|music|lyrics|playwright|composer|lyricist|book writer|co-writer|author|translator|adaptation|english lyrics)/i;
  const creativePrincipals = featureFlags.creativePages && show.creativeTeam
    ? show.creativeTeam
        .filter(m => PRINCIPAL_ROLES.test(m.role))
        .map(m => ({ name: m.name, role: m.role, link: getCreativeLink(m.name, m.role) }))
    : [];

  // Combine schemas, filtering out null FAQ schema
  const schemas = [showSchema, breadcrumbSchema, faqSchema, ...criticReviewSchemas].filter(Boolean);

  // Pre-compute score variables for redesigned mobile header
  const reviewCount = show.criticScore?.reviewCount || 0;
  const tier1Count = show.criticScore?.tier1Count || 0;
  const tier2Count = show.criticScore?.tier2Count || 0;
  const isCuratedHistoricalShow = CURATED_HISTORICAL_SHOWS.has(show.id);
  const showTBD = show.status === 'previews' || show.status === 'upcoming' || !hasEnoughReviews(reviewCount, show.category, tier1Count + tier2Count, isCuratedHistoricalShow);
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
        dangerouslySetInnerHTML={{ __html: JSON.stringify({
          '@context': 'https://schema.org',
          // Strip per-schema @context keys — they're invalid inside @graph (spec requires
          // @context only at the document root, not on member objects).
          '@graph': schemas.map(s => {
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            const { '@context': _ctx, ...rest } = s as Record<string, unknown>;
            return rest;
          }),
        }) }}
      />

      {/* Sticky Score Header */}
      <StickyScoreHeader title={show.title} score={score} category={show.category} backHref={isWestEnd ? '/west-end' : isOffBroadway ? '/off-broadway' : '/'} />

      <div className="max-w-3xl mx-auto px-4 sm:px-6 pt-6 sm:pt-8">
        <Breadcrumb items={isOpera ? [
          { label: 'Home', href: '/' },
          { label: 'Opera', href: '/opera' },
          { label: show.title },
        ] : [
          { label: 'Home', href: isWestEnd ? '/west-end' : isOffBroadway ? '/off-broadway' : '/' },
          { label: show.type === 'musical' ? 'Musicals' : 'Plays', href: `/browse/${getBrowseSlug(show.category, show.type)}` },
          { label: show.title },
        ]} />

        {/* Redesigned mobile header — feature-flagged. v2 (Broadway Radar–inspired) lives
            entirely inside ShowHeroRedesign; the legacy block below is kept only for the
            unflagged path and for sm: viewports. See memory/feedback_show_page_redesign_v2_decisions.md.
            RedesignOn/RedesignOff live in 'use client' so the demo-flag check runs both
            during build (with the demo source-rewrite) and at hydration (without it). */}
        <RedesignOn>
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
              ranks={ranks}
            />
          </div>
        </RedesignOn>

        {/* Metacritic-style Header: Poster + Title/Score integrated. Rendered only
            when the redesign is off; visual-regression.spec.ts asserts on this id
            in the prod build (where the flag is false). */}
        <RedesignOff>
        <div className="card p-5 sm:p-6 mb-6" data-testid="show-header-card">
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
                  alt={`${show.title} ${isOpera ? 'Met Opera' : isWestEnd ? 'West End' : isOffBroadway ? 'Off-Broadway' : 'Broadway'} ${show.type} poster`}
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
                {show.category && show.category !== 'broadway' && !isOpera && (
                  <span className={show.category === 'west-end' ? 'text-teal-400' : show.category === 'off-west-end' ? 'text-violet-400' : 'text-indigo-400'}>{show.category === 'west-end' ? 'West End' : show.category === 'off-west-end' ? 'Off-West End' : 'Off-Bway'}</span>
                )}
                <span className={isOpera ? 'text-indigo-400' : show.type === 'musical' ? 'text-purple-400' : 'text-blue-400'}>{isOpera ? 'Opera' : show.type === 'musical' ? 'Musical' : 'Play'}</span>
                <span className={show.isRevival ? 'text-gray-400' : 'text-amber-400'}>{show.isRevival ? 'Revival' : 'Original'}</span>
                {show.limitedRun && <span className="text-red-400">Limited</span>}
              </div>
            </div>

            {/* Right side: Title, Meta, Score Box, and Breakdown */}
            <div className="flex-1 min-w-0">
              {/* Pills row — desktop only (mobile pills moved below poster) */}
              <div className="hidden sm:flex flex-wrap items-center gap-1.5 mb-2" data-testid="show-pills-row">
                <CategoryBadge category={show.category} isOpera={isOpera} />
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
                      const durationSuffix = isOpera ? 'at the Met' : isOffWestEnd ? 'Off-West End' : isWestEnd ? 'in the West End' : isOffBroadway ? 'Off-Broadway' : 'on Broadway';
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
                const showTBD = show.status === 'previews' || show.status === 'upcoming' || !hasEnoughReviews(reviewCount, show.category, tier1Count + tier2Count, isCuratedHistoricalShow);
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
                              ? reviewsRemainingForScore(reviewCount, show.category, tier1Count + tier2Count, isCuratedHistoricalShow)
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
                        {/* Hero rank line — Variant B. Same component as the redesigned hero
                            so flipping the redesign flag doesn't change the rank line's look. */}
                        {!showTBD && (
                          <HeroRankLine ranks={ranks} market={show.category} />
                        )}
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
            const showTBD = show.status === 'previews' || show.status === 'upcoming' || !hasEnoughReviews(reviewCount, show.category, tier1Count + tier2Count, isCuratedHistoricalShow);
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

          {/* Critics' Take — inline below the score row, no border/card chrome.
              Matches the redesign hero treatment so the consensus reads as a
              continuous block with whatever sits above it. */}
          {consensus && show.criticScore ? (
            <div className="mt-3">
              <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-gray-500 mb-1.5">Critics&apos; Take</p>
              <p className="text-gray-300 text-sm leading-relaxed">{consensus.text}</p>
            </div>
          ) : show.synopsis ? (
            <p className="text-gray-400 text-sm leading-relaxed mt-3">
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
            <Suspense fallback={null}><ShowPageAddToListButton showId={show.id} /></Suspense>
            <Suspense fallback={null}><ShowPageWatchlistButton showId={show.id} /></Suspense>
          </div>

          {/* User Rating — feature-flagged */}
          <Suspense fallback={null}>
            <ShowPageRatingConnected
              showId={show.id}
              showTitle={show.title}
              previewDate={show.previewsStartDate}
              closingDate={show.closingDate}
            />
          </Suspense>
        </div>
        </RedesignOff>

        {/* Gold List Badges moved down to just above the "Where it ranks"
            card per UX ordering 2026-05-17. They sit better next to the
            ranks data (both convey leaderboard position) than between the
            hero and Critic Reviews. */}

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
                    {`${isOpera ? 'Opera Scorecard' : isWestEnd ? 'West End Scorecard' : isOffBroadway ? 'Off-Broadway Scorecard' : 'Broadway Scorecard'}'s critic review coverage begins in ${isWestEnd ? '2020' : '2005'}. Cast, creative team, and production details are available for this historical production.`}
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

        {/* Section Jump Links removed entirely 2026-05-19 per user feedback —
            the pill row took ~80px of mobile vertical for an affordance most
            users skip in favor of scrolling. featureFlags.sectionJumpLinks
            is now effectively dead; leaving the flag in place in case we
            revisit, but no surface renders it. */}

        {/* Critic Reviews / Scorecard */}
        {show.criticScore && show.criticScore.reviews.length > 0 ? (
          <section id="critic-reviews" className="card p-5 sm:p-6 pb-4 sm:pb-5 mb-5 sm:mb-8 scroll-mt-20" aria-labelledby="critic-scorecard-heading">
            {/* Unified scorecard chrome: eyebrow + lowercase meta count */}
            <header className="flex items-center justify-between gap-3 mb-4">
              <h2 id="critic-scorecard-heading" className="text-[11px] font-bold uppercase tracking-[0.12em] text-gray-400 leading-none m-0">Critic Scorecard</h2>
              <span className="text-[11px] font-medium tracking-[0.06em] text-gray-500 lowercase shrink-0">
                {show.criticScore.reviewCount} {show.criticScore.reviewCount === 1 ? 'review' : 'reviews'}
              </span>
            </header>

            {/* Breakdown bar — shown when redesign moves it out of the header card */}
            {show.criticScore?.reviews && show.criticScore.reviews.length > 0 && (
              <RedesignOn>
                <ScoreBreakdownBar
                  reviews={show.criticScore.reviews}
                  category={show.category}
                  className="sm:hidden mb-4"
                />
              </RedesignOn>
            )}

            <ReviewsList reviews={show.criticScore.reviews.map(r => ({
              ...r,
              outletSlug: getOutletSlugById(r.outletId) || undefined,
              criticSlug: r.criticName ? getCriticSlugByName(r.criticName) : null,
            }))} initialCount={5} category={show.category} />

            {/* Subtle in-card methodology link — explains how CriticScore is
                computed without a verbose accordion. Links to the same
                methodology page the page-footer link uses. */}
            <p className="mt-4 pt-3 border-t border-white/5 text-xs text-gray-500">
              <Link href="/methodology" className="hover:text-brand-hover transition-colors">
                How this score works →
              </Link>
            </p>
          </section>
        ) : show.status === 'previews' || show.status === 'upcoming' ? (
          <section id="critic-reviews" className="card p-5 sm:p-6 pb-4 sm:pb-5 mb-5 sm:mb-8 scroll-mt-20" aria-labelledby="critic-scorecard-heading-pending">
            <header className="flex items-center justify-between gap-3 mb-3">
              <h2 id="critic-scorecard-heading-pending" className="text-[11px] font-bold uppercase tracking-[0.12em] text-gray-400 leading-none m-0">Critic Scorecard</h2>
              <span className="text-[11px] font-medium tracking-[0.06em] text-gray-500 lowercase shrink-0">tbd</span>
            </header>
            <p className="text-gray-400 text-sm">
              Reviews coming after {isWestEnd ? 'press night' : 'opening night'}: <span className="text-white font-medium">{formatDate(show.openingDate)}</span>
            </p>
          </section>
        ) : (
          <section id="critic-reviews" className="card p-5 sm:p-6 pb-4 sm:pb-5 mb-5 sm:mb-8 scroll-mt-20" aria-labelledby="critic-scorecard-heading-archived">
            <header className="flex items-center justify-between gap-3 mb-3">
              <h2 id="critic-scorecard-heading-archived" className="text-[11px] font-bold uppercase tracking-[0.12em] text-gray-400 leading-none m-0">Critic Scorecard</h2>
            </header>
            <p className="text-gray-400 text-sm">
              Archived critic reviews for this production are being collected and will appear here as they&apos;re processed.
            </p>
          </section>
        )}

        {/* === SECTION ORDERING ===
            ABOVE FOLD (server component):
              1. Critic Reviews
            BELOW FOLD (ShowPageBelowFold lazy chunk):
              2. Video Reviews
              3. Audience Scorecard
              4. Awards Scorecard
              5. Box Office Scorecard
              6. Commercial Scorecard
              7. Where it ranks
              8. Showtimes
              9. Socials Scorecard
             10. Theater Scorecard
             11. Seating Scorecard
             12. Discount Tickets
             13. Cast Updates
             14. Cast
             15. Creative Team
             16. Quick Facts                                                  */}

        <ShowPageBelowFoldLoader
          show={show}
          videoReviews={videoReviews}
          audienceBuzz={audienceBuzz}
          audienceShowScoreUrl={audienceShowScoreUrl}
          audiencePlatformUrls={audiencePlatformUrls}
          awards={awards ?? null}
          tonyNamesByCategory={tonyNamesByCategory}
          grosses={grosses ?? null}
          weekEnding={weekEnding}
          commercial={commercial}
          recoupmentTrend={recoupmentTrend}
          ranks={ranks}
          ranksByFormat={ranksByFormat}
          showSchedule={showSchedule ?? null}
          currentMonday={currentMonday}
          showtimeIds={showtimeIds}
          sortedTicketLinks={sortedTicketLinks}
          socialPulse={socialPulse}
          theater={theater}
          lotteryRush={lotteryRush}
          castChangesData={castChangesData}
          castFile={castFile}
          castActorSlugs={castActorSlugs}
          castTonyMap={castTonyMap}
          creativePrincipals={creativePrincipals}
          otherProductions={otherProductions}
          relatedShowsOpen={relatedShowsOpen}
          relatedShowsClosed={relatedShowsClosed}
          comparisons={comparisons}
          venueSlug={venueSlug}
          isWestEnd={isWestEnd}
          isOffBroadway={isOffBroadway}
          isOffWestEnd={isOffWestEnd}
          isOpera={isOpera}
          isCuratedHistoricalShow={isCuratedHistoricalShow}
          lastUpdated={lastUpdated}
          score={score}
        />

      </div>

      {/* Follow Show Banner */}
      {show.status !== 'closed' && (
        <ShowFollowBanner showId={show.id} showTitle={show.title} />
      )}
    </>
  );
}
