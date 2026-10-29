import { notFound } from 'next/navigation';
import { foldVenueName } from '@/lib/venue-fold';
import { noCriticReviewsExpected } from '@/lib/review-expectation';
import Link from 'next/link';
import { Metadata } from 'next';
import { Suspense } from 'react';
import { isCategoryEnabled } from '@/lib/markets';
import { HIDDEN_LONDON_IDS } from '../../../../scripts/lib/page-name-sources';
import { getShowBySlug, getRecentShowSlugs, getShowLastUpdated, slugify, getRelatedShowsOpen, getRelatedShowsClosed, getOtherProductions, getTheaterBySlug, getOffBroadwayTheaterBySlug, getOperaTitleSlug, getSharedTitleYear } from '@/lib/data-core';
import { getTourReviewYears } from '@/lib/tour-display';
import { isLiveTour } from '@/lib/tour-listing';
import { getShowGrosses, getGrossesWeekEnding } from '@/lib/data-grosses';
import { getBoxOfficeHistoryStats } from '@/lib/data-grosses-history';
import { getShowAwards, getAwardsSummary } from '@/lib/data-awards';
import { getTonyNamesByCategory } from '@/lib/data-tony-noms';
import { getAudienceBuzz, getShowScoreUrl, getAudienceGrade, getTotalAudienceReviews, hasEnoughAudienceReviews, getAudiencePlatformUrl } from '@/lib/data-audience';
import { getCriticConsensus } from '@/lib/data-consensus';
import { getCriticsTakeDisplayMode } from '../../../../scripts/lib/critics-take-display';
import { getPriorRunLabel } from '../../../../scripts/lib/prior-run-label';
import { getLotteryRush } from '@/lib/data-lottery';
import { getShowSchedule, getScheduleCurrentMonday, getShowShowtimeIds } from '@/lib/data-showtimes';
import { getShowCommercial, getRecoupmentTrend, getShowBoxOfficeV2, getBoxOfficeFacts } from '@/lib/data-commercial';
import { toBoxOfficeV2Card, toFactsCard, showsBreakEven } from '@/lib/box-office-v2-display';
import { toPublicShowCommercial, hasCommercialCard } from '@/lib/commercial-display';
import { getCastChanges } from '@/lib/data-cast';
import { getShowCastFile } from '@/lib/data-cast-obc';
import { getActorSlugMap } from '@/lib/data-actors';
import { getCreativeLink } from '@/lib/data-creative';
import { getShowCastTonyMap } from '@/lib/data-tony-noms';
import { getOutletSlugById, getCriticSlugByName } from '@/lib/data-reviews';
import { getOutletBadge } from '@/config/outlet-logos';
import { getBlogReviewByShowSlug } from '@/lib/data-reviews-blog';
import { featureFlags } from '@/config/feature-flags';
import { generateShowSchema, generateBreadcrumbSchema, generateShowFAQSchema, getShowFAQs, BASE_URL } from '@/lib/seo';
import { isLondonMarket } from '@/lib/venue-classification';
import { getCurrencySymbol, isUkRegionalShow } from '@/lib/market-utils';
import { isOperaShow } from '@/lib/show-market';
import { getOptimizedImageUrl } from '@/lib/images';
import ShowImage from '@/components/ShowImage';
import StickyScoreHeader from '@/components/StickyScoreHeader';
import ReviewsList from '@/components/ReviewsList';
import { getReviewListItems, REVIEWS_INLINE_COUNT } from '@/lib/show-review-items';
import Breadcrumb from '@/components/Breadcrumb';
import ShowFollowBanner from '@/components/ShowFollowBanner';
import ShowPageBelowFoldLoader from '@/components/show-page/ShowPageBelowFoldLoader';
import { getVideoReviews } from '@/lib/data-video-reviews';
import { StatusBadge, ReviewsSyncingBadge, FormatPill, ProductionPill, CategoryBadge, ScoreBadge, getScoreTier, getScoreTextColorClass, ScoreBreakdownBar } from '@/components/show-cards';
import { hasEnoughReviews, reviewsRemainingForScore, applyCoverageFloor } from '@/config/score-buckets';
import { CURATED_HISTORICAL_SHOWS, TOP_CRITICS } from '@/config/scoring';
import { getBroadwayDuration, formatShowDate } from '@/lib/date-utils';
import { getShowDateLineSegments, getHeroDurationSuffix, getReviewAgeNote, formatShowDate as formatDate } from '@/lib/show-date-line';
import TicketLink from '@/components/TicketLink';
import ShowPageTicketCTA from '@/components/ShowPageTicketCTA';
import { sortTicketLinks } from '@/lib/ticket-utils';
import { getComparisonsForShow } from '@/config/comparisons';
import { createShowSerializer } from '@/lib/serialize-show';
import RelatedShowsCompactAB from '@/components/RelatedShowsCompactAB';
import { pickCompactRelated } from '../../../../scripts/lib/related-shows-ab';
import type { ComputedShowWithReviews, ComputedReview } from '@/lib/engine';
import ShowHeroRedesign from '@/components/show-page/ShowHeroRedesign';
import { shouldShowReviewsSyncing } from '../../../../scripts/lib/show-page-provisional-state';
import ShowTrustLines from '@/components/show-page/ShowTrustLines';
import ShowPageBookmark from '@/components/user/ShowPageBookmark';
import { RedesignOn, RedesignOff } from '@/components/show-page/RedesignGate';
import LimitedRunBadge from '@/components/show-page/LimitedRunBadge';
import { getShowRanks } from '@/lib/data-show-ranks';
import { getBrowseSlug } from '@/lib/browse-slugs';
import HeroRankLine from '@/components/show-page/HeroRankLine';
import { AwardsNavLink } from '@/components/AwardsNavLink';
import { showFormatTitle, showFormatTextClass, showFormatPlural } from '@/lib/show-format';
import { getTourSchedule, getTourScheduleSource, getTourNowNextForShow, getTourTicketLinks, getTourStopTickets } from '@/lib/data-tour-schedule';
import { stopForReview, stopKey } from '@/lib/tour-schedule';
import TourScheduleCard from '@/components/show-page/TourScheduleCard';
import AdSlot from '@/components/ads/AdSlot';
import { getTourCities } from '@/lib/data-tour-cities';
import { HUB_CITIES } from '@/lib/city-hub';
import { isShowIndexable } from '@/lib/seo-indexability';

// Group A: personalized, auth-dependent, client-only (see ShowPageUserButtons).
import { ShowPageWatchlistButton, ShowPageAddToListButton } from '@/components/user/ShowPageUserButtons';

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

export async function generateMetadata(props: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const params = await props.params;
  const show = getShowBySlug(params.slug);
  // Flag-gated categories (tour, regional) 404 at request time too, not just at prebuild.
  if (!show || !isCategoryEnabled(show.category)) return { title: 'Show Not Found' };

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
  const isTBD = applyCoverageFloor(
    !hasEnoughReviews(reviewCount, show.category, tier1Count + tier2Count, isCuratedHistorical)
      || show.status === 'previews' || show.status === 'upcoming',
    { scorePublicSince: show.scorePublicSince, coverageState: show.cov?.state, coverageAcked: show.coverageAcked },
  );
  const synopsisSnippet = show.synopsis
    ? show.synopsis.slice(0, 120).replace(/\s+\S*$/, '...')
    : '';
  const isLondonMeta = isLondonMarket(show.category);
  const isOffWestEndMeta = show.category === 'off-west-end';
  const isOffBroadwayMeta = show.category === 'off-broadway';
  const isRegionalMeta = show.category === 'regional';
  // UK flagship houses (RSC, Chichester, ...) are filed under Beyond London, not Broadway tryouts (BRO-5103).
  const isUkRegionalMeta = isRegionalMeta && isUkRegionalShow(show);
  const isTourMeta = show.category === 'tour';
  // A tour shares its Broadway parent's title; the <title>/OG name must tell them apart.
  const seoTitle = isTourMeta ? `${show.title} National Tour` : show.title;
  // Revivals share a title with their other productions: add the production year so
  // each <title> is distinct, keeping "[Show] Reviews" front-loaded (BRO-5970).
  const sharedYear = getSharedTitleYear(show);
  const titleYearSuffix = sharedYear ? ` (${sharedYear})` : '';
  const isOperaMeta = isOperaShow(show);
  // Regional shows roll up under the Broadway Scorecard brand (site name), but must NOT be
  // labelled "on Broadway" — use a neutral, honest market label in titles/meta.
  const siteName = isOperaMeta ? 'Opera Scorecard' : isOffWestEndMeta ? 'Off-West End Scorecard' : isLondonMeta ? 'West End Scorecard' : isOffBroadwayMeta ? 'Off-Broadway Scorecard' : 'Broadway Scorecard';
  const marketLabel = isOperaMeta ? 'at the Met' : isOffWestEndMeta ? 'Off-West End' : isLondonMeta ? 'in the West End' : isOffBroadwayMeta ? 'Off-Broadway' : isUkRegionalMeta ? 'in the UK' : isRegionalMeta ? 'in a regional production' : isTourMeta ? 'on its national tour' : 'on Broadway';
  const statusLabel = show.status === 'open' ? 'Now Playing' : show.status === 'previews' ? 'In Previews' : show.status === 'upcoming' ? 'Upcoming' : '';

  // Sentiment label maps tier → SEO-friendly phrase used in title + description.
  // Suppressed for TBD shows (previews/upcoming or below review-count threshold)
  // so metadata never broadcasts a verdict the show page itself doesn't show.
  const tier = (!isTBD && roundedScore) ? getScoreTier(roundedScore, show.category) : null;
  const SEO_SENTIMENT: Record<string, string> = {
    'Critical Gold': 'Rave Reviews',
    'Recommended': 'Positive Reviews',
    'Worth Seeing': 'Worth Seeing',
    'Mixed': 'Mixed Reviews',
    'Critical Miss': 'Poor Reviews',
  };
  const sentimentLabel = tier ? (SEO_SENTIMENT[tier.label] ?? null) : null;
  // For the <title> tag we front-load the exact-match "[Show] Reviews" keyword
  // (the query users actually type), then append the sentiment WORD with its
  // redundant "Reviews" suffix stripped so we don't print "Reviews — … Reviews".
  // Before this, the 'Worth Seeing' tier produced a title with NO "review(s)"
  // keyword at all (e.g. "Glengarry Glen Ross — Worth Seeing (65/100)"), making a
  // whole tier of shows invisible to "[show] reviews" searches. Front-loading also
  // matches the title pattern our aggregator competitor (Show-Score) outranks us
  // with: "[Show] (Broadway) NYC Reviews". 2026-06-21 SERP audit.
  const titleSentimentWord = sentimentLabel ? sentimentLabel.replace(/\s*reviews?$/i, '').trim() : null;

  // OG/Twitter titles are seen on social shares (FB, Twitter, iMessage, Slack
  // previews) where a "Mixed Reviews" or "Poor Reviews" label would actively
  // discourage clicks. The <title> tag already has sentiment for SEO/SERP
  // visibility on the tiers where it helps. Restrict OG/Twitter sentiment to
  // tiers where the label is unambiguously positive — anything else falls back
  // to a neutral title that doesn't broadcast a negative signal in shares.
  const OG_POSITIVE_TIERS = new Set(['Critical Gold', 'Recommended']);
  const ogShowsSentiment = !!(tier && roundedScore && sentimentLabel && OG_POSITIVE_TIERS.has(tier.label));
  const ogTitle = ogShowsSentiment
    ? `${seoTitle}: ${sentimentLabel} (${roundedScore}/100) | ${siteName}`
    : `${seoTitle} - ${siteName}`;
  const twitterTitle = ogShowsSentiment
    ? `${seoTitle}: ${sentimentLabel} (${roundedScore}/100)`
    : `${seoTitle} - CriticScore ${(!isTBD && roundedScore) ? `${roundedScore}/100` : 'TBD'}`;

  // Sentiment-aware description: lead with verdict, not database dump
  // "Now Playing at North American Tour." reads wrong; a tour has no single house.
  // A tour's description names where it plays now (BRO-4601 SEO: "<show> <city>").
  const tourNow = isTourMeta && show.status !== 'closed' ? getTourNowNextForShow(show)?.now : null;
  const venuePhrase = (label: string) => (tourNow
    ? ` Now in ${tourNow.city} (${tourNow.venue}) through ${formatShowDate(tourNow.end, { month: 'short', day: 'numeric' })}.`
    : isTourMeta ? ` ${label} on tour.` : show.venue ? ` ${label} at ${show.venue}.` : ` ${label}.`);
  const statusPart = statusLabel ? venuePhrase(statusLabel) : '';
  const synopsisPart = synopsisSnippet ? ` ${synopsisSnippet}` : '';
  const SENTIMENT_PHRASES: Record<string, string> = {
    'Critical Gold': `Critics rave about ${show.title}: ${roundedScore}/100 from ${reviewCount} reviews.`,
    'Recommended': `${show.title} earns positive reviews: ${roundedScore}/100 from ${reviewCount} critics.`,
    'Worth Seeing': `Critics say ${show.title} is worth seeing: ${roundedScore}/100 from ${reviewCount} reviews.`,
    'Mixed': `Critics are mixed on ${show.title}: ${roundedScore}/100 from ${reviewCount} reviews.`,
    'Critical Miss': `${show.title} gets poor reviews from critics: ${roundedScore}/100 from ${reviewCount} reviews.`,
  };
  const description = (score && roundedScore && tier
    ? `${SENTIMENT_PHRASES[tier.label] ?? `${show.title} ${marketLabel} scores ${roundedScore}/100 from ${reviewCount} critic reviews.`}${statusPart}${synopsisPart}`
    : `${noCriticReviewsExpected(show, reviewCount)
      ? `${show.title} ${marketLabel}: no critic reviews were found for this event.`
      : isLiveTour(show) && reviewCount === 0
      ? `Reviews of ${show.title} ${marketLabel} are coming in as local critics see it in each city.`
      : `Read ${reviewCount > 0 ? `${reviewCount} ` : ''}critic reviews for ${show.title} ${marketLabel}.`}${statusLabel ? venuePhrase(statusLabel) : ''} ${synopsisSnippet}`
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
      absolute: roundedScore && titleSentimentWord
        ? `${seoTitle}${titleYearSuffix} Reviews: ${titleSentimentWord} ${roundedScore}/100 | ${siteName}`
        // A tour's seoTitle already says "National Tour"; the market label would repeat it.
        : `${seoTitle}${titleYearSuffix} Reviews${isTourMeta ? '' : ` ${marketLabel}`} | ${siteName}`,
    },
    // An unscored tour is indexed once it is live with a schedule (the page's
    // own content); a closed or unscheduled one with no score stays out of
    // search, the sitemap and the search index (isTourIndexableShow, BRO-4931).
    ...(!isShowIndexable(show, params.slug) ? { robots: { index: false, follow: true } } : {}),
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

function TicketIcon() {
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 5v2m0 4v2m0 4v2M5 5a2 2 0 00-2 2v3a2 2 0 110 4v3a2 2 0 002 2h14a2 2 0 002-2v-3a2 2 0 110-4V7a2 2 0 00-2-2H5z" />
    </svg>
  );
}

function getSentimentLabel(score: number, category?: string): { label: string; colorClass: string } {
  const tier = getScoreTier(score, category);
  return {
    label: tier?.label ?? 'Critical Miss',
    colorClass: getScoreTextColorClass(score, category),
  };
}

export default async function ShowPage(props: { params: Promise<{ slug: string }> }) {
  const params = await props.params;
  const show = getShowBySlug(params.slug);

  if (!show || !isCategoryEnabled(show.category)) {
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
  const isWestEnd = isLondonMarket(show.category);
  const isOffWestEnd = show.category === 'off-west-end';
  const isOffBroadway = show.category === 'off-broadway';
  const isRegional = show.category === 'regional';
  const isTour = show.category === 'tour';
  const isOpera = isOperaShow(show);

  // Theater scorecard lookup (Broadway only) — regional/off-broadway/tour venues aren't Broadway houses
  const theater = !isWestEnd && !isOffBroadway && !isRegional && !isTour && show.venue ? getTheaterBySlug(slugify(foldVenueName(show.venue))) : undefined;
  // Off-Broadway venue page lookup — undefined if the venue string didn't resolve
  // (freeform data entry, unlike the curated Broadway/West End venue lists), in
  // which case the venue name renders as plain text rather than a dead link.
  const offBroadwayTheater = isOffBroadway && show.venue ? getOffBroadwayTheaterBySlug(slugify(foldVenueName(show.venue))) : undefined;
  const showSchema = generateShowSchema(show, lastUpdated || undefined, performers, theater ? `${BASE_URL}/theater/${theater.slug}` : undefined,
    show.category === 'tour' ? { stops: getTourSchedule(show.id), today: new Date().toISOString().slice(0, 10), tickets: getTourStopTickets(show) } : undefined);

  // null when no browse page exists for this show's format (opera/special) —
  // drop that breadcrumb level rather than link to a mismatched page.
  // UK flagship houses (RSC, Chichester, ...) live under the West End page's
  // Beyond London shelf (BRO-5103): back/breadcrumb go there, and no Broadway
  // browse list is a mismatched middle level.
  const isUkRegional = isUkRegionalShow(show);
  // /west-end 404s when the westEnd flag is off; fall back to home there.
  const homeHref = isWestEnd || (isUkRegional && featureFlags.westEnd) ? '/west-end' : isOffBroadway ? '/off-broadway' : '/';
  const browseSlug = isUkRegional ? null : getBrowseSlug(show.category, show.type);
  const breadcrumbHome = { name: 'Home', url: `${BASE_URL}${homeHref === '/' ? '' : homeHref}` };
  const breadcrumbSchema = isOpera
    ? generateBreadcrumbSchema([
        { name: 'Home', url: BASE_URL },
        { name: 'Opera', url: `${BASE_URL}/opera` },
        { name: show.title, url: `${BASE_URL}/opera/${getOperaTitleSlug(show.slug)}` },
      ])
    : generateBreadcrumbSchema(browseSlug ? [
        breadcrumbHome,
        { name: isTour ? 'Tours' : showFormatPlural(show.type), url: `${BASE_URL}/browse/${browseSlug}` },
        { name: isTour ? `${show.title} (Tour)` : show.title, url: `${BASE_URL}/show/${show.slug}` },
      ] : [
        breadcrumbHome,
        { name: show.title, url: `${BASE_URL}/show/${show.slug}` },
      ]);
  const faqSchema = generateShowFAQSchema(show, getCriticConsensus(show.id)?.text ?? null, isTour ? getTourNowNextForShow(show) : null);
  const score = show.criticScore?.score;
  const grosses = getShowGrosses(params.slug);
  const weekEnding = getGrossesWeekEnding();
  // History-derived card extras (sparkline, rank, market share, attendance
  // deltas). Server-only import — keeps the 5.5 MB history out of the client.
  const boxOfficeHistory = grosses ? getBoxOfficeHistoryStats(params.slug) : null;
  const awards = getShowAwards(show.id);
  const awardsSummary = awards ? getAwardsSummary(show.id, show.openingDate, show.category) : null;
  const tonyNamesByCategory = getTonyNamesByCategory(show.id);
  const audienceBuzz = getAudienceBuzz(show.id);
  const consensus = getCriticConsensus(show.id);
  const lotteryRush = getLotteryRush(show.id);
  const showSchedule = getShowSchedule(show.id);
  // Cross-show ranks. Flag-gated for safe rollout — toggle in Vercel env
  // (NEXT_PUBLIC_FEATURES=showRanks). O(1) lookup after the module-scope
  // index is built on first call. 'all' format slice powers the hero rank
  // line; the bottom WhereItRanks card additionally requests the show's-own-
  // format slice.
  const ranks = featureFlags.showRanks ? getShowRanks(show.id, { format: 'all' }) : null;
  const ranksByFormat = featureFlags.showRanks && (show.type === 'musical' || show.type === 'play')
    ? getShowRanks(show.id, { format: show.type })
    : null;
  // The Profitability Scorecard was released 2026-10-26 (BRO-6192); to pull it, set the
  // commercial getter back to has('commercial') and rebuild. ShowPageBelowFold
  // is a client component, so anything passed to it lands in the page's RSC
  // payload even when its section is hidden.
  // Only the allowlisted, publishable part of the
  // record is sent (toPublicShowCommercial): raw research notes would
  // otherwise sit in the page source though the card never prints them.
  const rawCommercial = featureFlags.commercial ? getShowCommercial(show.slug) : undefined;
  const commercial = rawCommercial ? toPublicShowCommercial(rawCommercial) : undefined;
  // Box Office Scorecard v3 and the Profitability Scorecard's break-even section
  // (BRO-5007, unreleased): same rule, computed only when both flags are on,
  // so a flags-off build carries none of their data.
  const boxOfficeV2Raw = featureFlags.commercial && featureFlags.boxOfficeV2 && show.category === 'broadway' ? getShowBoxOfficeV2(show.slug) : null;
  const breakEvenCard = boxOfficeV2Raw && showsBreakEven(boxOfficeV2Raw) ? toBoxOfficeV2Card(boxOfficeV2Raw) : null;
  const boxOfficeFactsRaw = featureFlags.commercial && featureFlags.boxOfficeV2 && show.category === 'broadway' ? getBoxOfficeFacts(show.slug) : null;
  const boxOfficeFacts = boxOfficeFactsRaw ? toFactsCard(boxOfficeFactsRaw, !!commercial && hasCommercialCard(commercial), show.status === 'closed') : null;
  // A tour with no ticket links of its own gets TodayTix's for the stop it
  // plays now or next (BRO-4601).
  const ticketLinks = show.ticketLinks?.length || show.category !== 'tour' ? show.ticketLinks : getTourTicketLinks(show);
  const sortedTicketLinks = ticketLinks ? sortTicketLinks(ticketLinks) : [];
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
  // Card-shape these before they cross the client boundary. getRelatedShows*/
  // getOtherProductions return full ComputedShow objects, each carrying its own
  // criticScore.reviews array — passing them raw to ShowPageBelowFoldLoader
  // ('use client') serialized ~20 shows' entire review corpora into the inlined
  // RSC flight payload. On /show/hamilton that was 645KB of the 781KB document,
  // 643 review objects, none of which any card renders (the cards read only
  // criticScore.{score,reviewCount,tier1Count,tier2Count}). Card #419.
  // One memoized slim serializer for every card list: a show in both the compact
  // row and a shelf is emitted once, and the cards never read creativeTeam/runtime (BRO-6278).
  const serialize = createShowSerializer();
  const serializeRelated = (s: Parameters<typeof serialize>[0]) => serialize(s, { slim: true });
  const relatedShowsOpenRaw = getRelatedShowsOpen(show);
  const relatedShowsOpen = relatedShowsOpenRaw.map(s => serializeRelated(s));
  // A show already in "Open Shows You Might Like" (e.g. Oh, Mary! playing Off-Broadway)
  // must not reappear in "Closed" for its Broadway run, so drop closed recs whose title matches.
  const openRecTitles = new Set(relatedShowsOpen.map(s => s.title.toLowerCase().replace(/\s*\(\d{4}\)\s*$/, '').trim()));
  const relatedShowsClosedRaw = (show.category !== 'west-end' && show.category !== 'off-west-end')
    ? getRelatedShowsClosed(show, 12)
        .filter(s => !openRecTitles.has(s.title.toLowerCase().replace(/\s*\(\d{4}\)\s*$/, '').trim()))
        .slice(0, 6)
    : [];
  const relatedShowsClosed = relatedShowsClosedRaw.map(s => serializeRelated(s));
  // related-shows-position A/B (BRO-5989): reuses the page's own open/closed rec lists
  // (West End exclusion and open/closed title dedupe included), then keeps only pages
  // the sitemap would list so the test row never links a noindex page. Pages with no
  // reviews yet get no row (it sits after the reviews card). Open recs first.
  const compactRelated = (show.criticScore?.reviews?.length ?? 0) > 0
    ? pickCompactRelated(
        [...relatedShowsOpenRaw, ...relatedShowsClosedRaw],
        show.id,
        (s: (typeof relatedShowsOpenRaw)[number]) => isShowIndexable(s, s.slug),
      ).map(s => serializeRelated(s))
    : [];
  const otherProductions = getOtherProductions(show).map(s => serializeRelated(s));
  const comparisons = getComparisonsForShow(show.slug);
  const videoReviews = getVideoReviews(show.id);

  // Narrow the show's OWN criticScore.reviews at each client boundary that doesn't
  // need the full review objects. ReviewsList (below) is the only consumer that
  // needs criticName/outlet/url/quote/etc; ShowHeroRedesign only needs reviewScore
  // (for ScoreBreakdownBar); ShowPageBelowFoldLoader/WhereItRanks need none at all.
  // Passing the same full show object across all three boundaries tripled this
  // show's own review array in the RSC payload — 117 review objects inlined for
  // 39 real reviews on /show/hamilton. Card #962, follow-up to #419.
  // National tour (BRO-4601): the city it plays now replaces the placeholder
  // venue "North American Tour" in the hero and Quick Facts.
  const tourStops = isTour ? getTourSchedule(show.id) : [];
  const tourToday = new Date().toISOString().slice(0, 10);
  const tourNowNext = isTour ? getTourNowNextForShow(show, tourToday) : null;
  const tourVenue = tourNowNext?.now
    ? `Now in ${tourNowNext.now.city} · ${tourNowNext.now.venue}`
    : tourNowNext?.next ? `Next: ${tourNowNext.next.city}, ${formatShowDate(tourNowNext.next.start, { month: 'short', day: 'numeric' })}` : null;
  const tourReviewCounts: Record<string, number> = {};
  for (const r of show.criticScore?.reviews ?? []) {
    const stop = stopForReview(tourStops, r.publishDate);
    if (stop) tourReviewCounts[stopKey(stop)] = (tourReviewCounts[stopKey(stop)] ?? 0) + 1;
  }

  const reviewItems = getReviewListItems(show);
  const showForHero: ComputedShowWithReviews<Pick<ComputedReview, 'reviewScore'>> = {
    ...show,
    venue: tourVenue ?? show.venue,
    criticScore: show.criticScore
      ? { ...show.criticScore, reviews: show.criticScore.reviews.map(r => ({ reviewScore: r.reviewScore })) }
      : null,
  };
  const showForBelowFold: ComputedShowWithReviews<never> = {
    ...show,
    venue: tourVenue ?? show.venue,
    criticScore: show.criticScore ? { ...show.criticScore, reviews: [] } : null,
  };

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
  const recoupmentTrend = featureFlags.commercial ? getRecoupmentTrend(show.slug) : 'unknown';
  // A hidden London id (ABBA Arena) has no /west-end/theater page: render the venue as text, not a 404 link (BRO-5970).
  const londonVenueHidden = HIDDEN_LONDON_IDS.has(show.id);
  const venueSlug = show.venue ? slugify(foldVenueName(show.venue)) : null;
  const PRINCIPAL_ROLES = /^(director|co-director|book|music|lyrics|playwright|composer|lyricist|book writer|co-writer|author|translator|adaptation|english lyrics)/i;
  const creativePrincipals = featureFlags.creativePages && show.creativeTeam
    ? show.creativeTeam
        .filter(m => PRINCIPAL_ROLES.test(m.role))
        .map(m => ({ name: m.name, role: m.role, link: getCreativeLink(m.name, m.role) }))
    : [];

  // Combine schemas, filtering out null FAQ schema
  const schemas = [showSchema, breadcrumbSchema, faqSchema].filter(Boolean);

  // Pre-compute score variables for redesigned mobile header
  const reviewCount = show.criticScore?.reviewCount || 0;
  const tier1Count = show.criticScore?.tier1Count || 0;
  const tier2Count = show.criticScore?.tier2Count || 0;
  const isCuratedHistoricalShow = CURATED_HISTORICAL_SHOWS.has(show.id);
  const showTBD = applyCoverageFloor(
    !hasEnoughReviews(reviewCount, show.category, tier1Count + tier2Count, isCuratedHistoricalShow)
      || show.status === 'previews' || show.status === 'upcoming',
    { scorePublicSince: show.scorePublicSince, coverageState: show.cov?.state, coverageAcked: show.coverageAcked },
  );
  // Computed here from the full review list (showForHero strips publishDate)
  // and shared by both heroes, so they always agree on whether it shows.
  const reviewAgeNote = showTBD ? null : getReviewAgeNote(show, show.criticScore?.reviews);
  // Hero extras the legacy header carried: how many more reviews unlock a
  // CriticScore (only when review count, not previews/upcoming, is the gate)
  // and which fallback fills the Critics' Take slot when there's no consensus.
  // One server-side verdict for every place on the page (see review-expectation.ts).
  const noReviewsExpected = noCriticReviewsExpected(show, reviewCount);
  const reviewsSyncing = shouldShowReviewsSyncing(show);
  const reviewsRemaining = showTBD && show.status !== 'previews' && show.status !== 'upcoming'
    ? reviewsRemainingForScore(reviewCount, show.category, tier1Count + tier2Count, isCuratedHistoricalShow)
    : 0;
  const criticsTakeMode = getCriticsTakeDisplayMode(!!consensus, !!show.criticScore, reviewCount, !!show.synopsis);
  const sentiment = score ? getSentimentLabel(score, show.category) : null;
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
            const { '@context': _ctx, ...rest } = s as Record<string, unknown>;
            return rest;
          }),
        }) }}
      />

      {/* Sticky Score Header */}
      <StickyScoreHeader title={show.title} score={score} category={show.category} backHref={homeHref} />

      <div className="max-w-3xl mx-auto px-4 sm:px-6 pt-6 sm:pt-8">
        <Breadcrumb items={isOpera ? [
          { label: 'Home', href: '/' },
          { label: 'Opera', href: '/opera' },
          { label: show.title },
        ] : browseSlug ? [
          { label: 'Home', href: homeHref },
          { label: isTour ? 'Tours' : showFormatPlural(show.type), href: `/browse/${browseSlug}` },
          { label: isTour ? `${show.title} (Tour)` : show.title },
        ] : [
          { label: 'Home', href: homeHref },
          { label: show.title },
        ]} />

        {/* Redesigned header. v2 (Broadway Radar–inspired) lives entirely inside
            ShowHeroRedesign; showPageRedesign launched on prod with userAccounts
            (2026-10-02, BRO-4525), so the legacy block below only renders if the
            flag is turned back off. See memory/feedback_show_page_redesign_v2_decisions.md. */}
        <RedesignOn>
          <div className="mb-6">
            <ShowHeroRedesign
              show={showForHero}
              consensusText={consensus?.text ?? null}
              audienceGrade={audienceGrade}
              audienceCount={totalAudienceCount}
              hasAudience={hasAudience}
              hasEnoughCriticReviews={!showTBD}
              reviewAgeNote={reviewAgeNote}
              sortedTicketLinks={sortedTicketLinks}
              lotteryRush={lotteryRush ?? null}
              isWestEnd={isWestEnd}
              isOffBroadway={isOffBroadway}
              offBroadwayVenueSlug={offBroadwayTheater?.slug ?? null}
              londonVenueHidden={londonVenueHidden}
              reviewsRemaining={reviewsRemaining}
              noReviewsExpected={noReviewsExpected}
              criticsTakeMode={criticsTakeMode}
              ranks={ranks}
              tourReviewYears={isTour && !show.openingDate ? getTourReviewYears(show.criticScore?.reviews) : null}
              trustLines={<ShowTrustLines show={show} />}
            />
          </div>
        </RedesignOn>

        {/* Metacritic-style Header: Poster + Title/Score integrated. Legacy layout,
            rendered only when showPageRedesign is off (kept as the rollback path). */}
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
                  alt={`${show.title} ${isOpera ? 'Met Opera' : isWestEnd ? 'West End' : isOffBroadway ? 'Off-Broadway' : isRegional ? 'Regional' : isTour ? 'National Tour' : 'Broadway'} ${show.type} poster`}
                  width={176}
                  height={264}
                  decoding="async"
                  priority
                  sizes="(min-width: 1024px) 160px, (min-width: 640px) 144px, 112px"
                  className="w-full h-full object-cover"
                  fallback={
                    <div className="w-full h-full flex items-center justify-center bg-surface-overlay">
                      <span className="text-4xl text-fg-muted">🎭</span>
                    </div>
                  }
                />
                </div>
              </div>
              {/* Compact pill labels under poster — mobile only */}
              <div className="flex sm:hidden flex-wrap justify-center gap-x-1.5 gap-y-0.5 text-[9px] font-semibold uppercase tracking-wide leading-none" data-testid="show-pills-poster">
                {show.category && show.category !== 'broadway' && !isOpera && (
                  <span className={show.category === 'west-end' ? 'text-teal-400' : show.category === 'off-west-end' ? 'text-violet-400' : show.category === 'regional' ? 'text-emerald-400' : show.category === 'tour' ? 'text-sky-400' : 'text-indigo-400'}>{show.category === 'west-end' ? 'West End' : show.category === 'off-west-end' ? 'Off-West End' : show.category === 'regional' ? 'Regional' : show.category === 'tour' ? 'Tour' : 'Off-Bway'}</span>
                )}
                <span className={isOpera ? 'text-indigo-400' : showFormatTextClass(show.type)}>{isOpera ? 'Opera' : showFormatTitle(show.type)}</span>
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

              {/* Title — matches Metacritic/Rotten Tomatoes convention: just the show
                  name, not "[Show] Reviews". The "Reviews" keyword lives in the <title>
                  tag above (what Google/browser tabs show), not the on-page H1. */}
              <h1 className="text-xl sm:text-2xl lg:text-3xl font-extrabold text-white tracking-tight leading-tight mb-2">
                {show.title}
                {/* A tour shares its Broadway parent's title and poster; say which one this is (inside the H1). */}
                {isTour && (
                  <span className="block mt-1 text-sm sm:text-base font-semibold tracking-normal text-sky-300" data-testid="tour-subtitle">National Tour</span>
                )}
              </h1>

              {/* No separate verdict sentence here — SXO fix 2026-07-19 tried one and it
                  duplicated the score box below (same 91/100, same review count, same
                  rave/positive/mixed breakdown as the color bar) while also being prone
                  to wrapping/truncating in this narrow poster-adjacent column. Matches
                  Metacritic/Rotten Tomatoes: the score badge below IS the verdict, no
                  redundant prose restating it. It already renders directly under the H1,
                  above the venue/runtime/date metadata line — that's the actual fix. */}

              {/* Score Box + Sentiment + Review Count - Metacritic style */}
              {(() => {
                const reviewCount = show.criticScore?.reviewCount || 0;
                const tier1Count = show.criticScore?.tier1Count || 0;
                const tier2Count = show.criticScore?.tier2Count || 0;
                const showTBD = applyCoverageFloor(
                  !hasEnoughReviews(reviewCount, show.category, tier1Count + tier2Count, isCuratedHistoricalShow)
                    || show.status === 'previews' || show.status === 'upcoming',
                  { scorePublicSince: show.scorePublicSince, coverageState: show.cov?.state, coverageAcked: show.coverageAcked },
                );
                const sentiment = score ? getSentimentLabel(score, show.category) : null;

                // The page has already applied the coverage floor. Rechecking
                // raw counts here would hide scores that the floor protects.
                const scoreBox = (
                  <ScoreBadge
                    score={score}
                    size="lg"
                    category={show.category}
                    reviewCount={showTBD ? 0 : undefined}
                  />
                );

                const hasAudience = !showTBD && audienceBuzz && audienceBuzz.combinedScore != null && hasEnoughAudienceReviews(audienceBuzz);
                const audienceGrade = hasAudience ? getAudienceGrade(audienceBuzz!.combinedScore!) : null;

                return (
                  <div className="space-y-2" data-testid="show-score-section">
                    {/* Score row: box + label + review count */}
                    <div className="flex items-start gap-3 sm:gap-4">
                      <div className="flex-shrink-0">{scoreBox}</div>
                      <div className="pt-0.5 min-w-0 break-words">
                        {reviewsSyncing ? <ReviewsSyncingBadge show={show} /> : showTBD ? (
                          <div className="text-base sm:text-lg font-bold text-gray-400">{isLiveTour(show) ? 'Reviews coming in' : 'Awaiting Reviews'}</div>
                        ) : sentiment && (
                          <div className={`text-base sm:text-lg font-bold ${sentiment.colorClass}`}>{sentiment.label}</div>
                        )}
                        <div className="flex items-center gap-2 sm:gap-3 flex-wrap mt-0.5">
                          {(() => {
                            if (reviewsSyncing) {
                              return <span className="text-xs sm:text-sm text-gray-400">Critic reviews are being collected.</span>;
                            }
                            // When TBD is due to low review count (not previews/upcoming),
                            // tell the user how many more reviews are needed rather than a
                            // bare "Based on N Critic Reviews" (which sits next to "TBD" and
                            // reads as contradictory).
                            const remaining = showTBD
                              ? reviewsRemainingForScore(reviewCount, show.category, tier1Count + tier2Count, isCuratedHistoricalShow)
                              : 0;
                            if (noReviewsExpected) {
                              return <span className="text-xs sm:text-sm text-fg-muted">No critic reviews expected</span>;
                            }
                            const isGatedByReviewCount = showTBD && show.status !== 'previews' && show.status !== 'upcoming' && show.status !== 'announced' && remaining > 0;
                            if (isGatedByReviewCount) {
                              return (
                                <a href="#critic-reviews" className="text-xs sm:text-sm text-fg-muted hover:text-brand transition-colors">
                                  {reviewCount} {reviewCount === 1 ? 'review' : 'reviews'} · {remaining} more for a CriticScore
                                </a>
                              );
                            }
                            if (reviewCount > 0) {
                              return (
                                <a href="#critic-reviews" className="text-xs sm:text-sm text-fg-muted hover:text-brand transition-colors">
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
                        {reviewAgeNote && (
                          <p className="text-[10px] sm:text-xs text-fg-muted mt-1 leading-snug">
                            {reviewAgeNote}
                          </p>
                        )}
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

              {/* Meta line — inline text so it wraps naturally on mobile. Moved below
                  the verdict/score block 2026-07-19 (SXO fix) — production metadata
                  used to lead the page ahead of any reviews-intent content. */}
              <p className="text-gray-400 text-xs sm:text-sm mt-3 mb-1 leading-relaxed" data-testid="show-meta-line">
                {!show.venue ? (
                  <span className="text-gray-300">Theater to be announced</span>
                ) : isWestEnd ? (
                  londonVenueHidden
                    ? <span className="text-gray-300">{show.venue}</span>
                    : <Link href={`/west-end/theater/${slugify(foldVenueName(show.venue))}`} className="text-gray-300 hover:text-brand transition-colors">{show.venue}</Link>
                ) : isOffBroadway && offBroadwayTheater ? (
                  <Link href={`/off-broadway/theater/${offBroadwayTheater.slug}`} className="text-gray-300 hover:text-brand transition-colors">{show.venue}</Link>
                ) : isOffBroadway || isRegional || isTour ? (
                  <span className="text-gray-300">{show.venue}</span>
                ) : (
                  <Link href={`/theater/${slugify(foldVenueName(show.venue))}`} className="text-gray-300 hover:text-brand transition-colors">{show.venue}</Link>
                )}
                {show.runtime && (
                  <span className="whitespace-nowrap"> <span className="text-fg-muted">·</span> {show.runtime}</span>
                )}
                {/* Date-line segments come from the shared show-date-line
                    module (src/lib/show-date-line.ts) — the single source
                    of truth for start/closing/duration rules, also consumed
                    by DateLine in ShowHeroRedesign.tsx. Do not fork this
                    logic back into inline branches (task #951). */}
                {(() => {
                  const durationSuffix = getHeroDurationSuffix(show);
                  const durationText = durationSuffix ? getBroadwayDuration(show.openingDate, durationSuffix) : null;
                  const segments = getShowDateLineSegments(show, durationText);
                  return segments.map((seg, i) => (
                    <span key={i}> <span className="text-fg-muted">·</span> {seg.emphasize ? <span className="text-amber-400">{seg.text}</span> : seg.text}</span>
                  ));
                })()}
                {isTour && !show.openingDate && (() => {
                  // Only while the tour's own dates are unknown; the date line covers it otherwise.
                  const years = getTourReviewYears(show.criticScore?.reviews);
                  return years ? <span> <span className="text-fg-muted">·</span> reviewed {years}</span> : null;
                })()}
              </p>

              <ShowTrustLines show={show} />
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
            const showTBD = applyCoverageFloor(
              !hasEnoughReviews(reviewCount, show.category, tier1Count + tier2Count, isCuratedHistoricalShow)
                || show.status === 'previews' || show.status === 'upcoming',
              { scorePublicSince: show.scorePublicSince, coverageState: show.cov?.state, coverageAcked: show.coverageAcked },
            );
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
          {(() => {
            const mode = getCriticsTakeDisplayMode(!!consensus, !!show.criticScore, reviewCount, !!show.synopsis);
            if (mode === 'consensus') {
              return (
                <div className="mt-3">
                  <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-fg-muted mb-1.5">Critics&apos; Take</p>
                  <p className="text-gray-300 text-sm leading-relaxed">{consensus!.text}</p>
                </div>
              );
            }
            if (mode === 'coming-soon') {
              return (
                <p className="text-fg-muted text-sm leading-relaxed mt-3 italic">
                  Critics&apos; Take coming soon.
                </p>
              );
            }
            if (mode === 'synopsis') {
              return (
                <p className="text-gray-400 text-sm leading-relaxed mt-3">
                  {show.synopsis}
                </p>
              );
            }
            return null;
          })()}

          {/* Links row: Tickets, Official Site, Trailer, Lottery/Rush + Watchlist */}
          <div className="flex items-center gap-2 mt-4 flex-nowrap">
            <div className="flex flex-wrap gap-2 min-w-0 flex-1">
              {/* Ticket Links — A/B tested (which platform gets the filled primary CTA) */}
              <ShowPageTicketCTA
                showName={show.title}
                showId={show.id}
                showSlug={show.slug}
                showStatus={show.status}
                showCategory={show.category}
                showVenue={show.venue}
                showScore={show.criticScore?.score ?? null}
                ticketLinks={sortedTicketLinks}
                rawTicketLinks={show.ticketLinks}
                officialUrl={show.officialUrl}
                pageType="show"
                buttonClassName="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-surface-overlay hover:bg-white/10 text-gray-300 hover:text-white text-xs leading-none font-medium transition-colors border border-white/10"
              />

              {/* Lottery/Rush — subdued style, not a revenue link */}
              {featureFlags.discountTickets && lotteryRush && show.status !== 'closed' && (
                <a
                  href="#discount-tickets"
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-surface-overlay hover:bg-white/10 text-fg-muted hover:text-gray-300 text-xs leading-none font-medium transition-colors border border-white/5"
                >
                  <TicketIcon />
                  {lotteryRush.lottery ? (lotteryRush.lottery.price ? `${getCurrencySymbol(show.category, show.venue)}${lotteryRush.lottery.price} Lottery` : 'Lottery Tickets') : lotteryRush.rush ? (lotteryRush.rush.price ? `${getCurrencySymbol(show.category, show.venue)}${lotteryRush.rush.price} Rush` : 'Rush Tickets') : 'Discount Tickets'}
                </a>
              )}
            </div>

            {/* Watchlist + List buttons — right-aligned */}
            <Suspense fallback={null}><ShowPageAddToListButton showId={show.id} /></Suspense>
            <Suspense fallback={null}>
              <ShowPageWatchlistButton
                showId={show.id}
                title={show.title}
                slug={show.slug}
                category={show.category}
                venue={show.venue}
                theaterAddress={show.theaterAddress}
                runtime={show.runtime}
              />
            </Suspense>
          </div>

          {/* The rating widget lives in ShowHeroRedesign; this legacy layout has none,
              so turning showPageRedesign off also hides rating on show pages. */}
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
              <span className="text-[11px] font-medium tracking-[0.06em] text-fg-muted lowercase shrink-0">
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

            {/* Only the cards in the server markup go inline; the rest load from reviews.json (BRO-6278). */}
            <ReviewsList
              reviews={reviewItems.slice(0, REVIEWS_INLINE_COUNT)}
              more={reviewItems.length > REVIEWS_INLINE_COUNT ? {
                url: `/show/${show.slug}/reviews.json`,
                totalCount: reviewItems.length,
                hasTierChips: reviewItems.some(r => r.tier),
                hasStops: reviewItems.some(r => r.stopLabel),
              } : undefined}
              initialCount={REVIEWS_INLINE_COUNT}
              category={show.category}
              showTiers={!isOpera}
            />

            {/* Subtle in-card methodology link — explains how CriticScore is
                computed without a verbose accordion. Links to the same
                methodology page the page-footer link uses. */}
            <p className="mt-4 pt-3 border-t border-white/5 text-xs text-fg-muted">
              <Link href="/methodology" className="hover:text-brand-hover transition-colors">
                How this score works →
              </Link>
            </p>
          </section>
        ) : isLiveTour(show) ? (
          // A live tour with no reviews yet (BRO-4931): the page is indexed for
          // its schedule, so say plainly that reviews are on the way instead of
          // the "archived reviews" or "opening night" copy.
          <section id="critic-reviews" className="card p-5 sm:p-6 pb-4 sm:pb-5 mb-5 sm:mb-8 scroll-mt-20" aria-labelledby="critic-scorecard-heading-tour-pending" data-testid="tour-reviews-coming-in">
            <header className="flex items-center justify-between gap-3 mb-3">
              <h2 id="critic-scorecard-heading-tour-pending" className="text-[11px] font-bold uppercase tracking-[0.12em] text-gray-400 leading-none m-0">Critic Scorecard</h2>
              <span className="text-[11px] font-medium tracking-[0.06em] text-fg-muted lowercase shrink-0">no score yet</span>
            </header>
            <p className="text-gray-400 text-sm">
              The CriticScore appears once enough local critics have reviewed the tour.
            </p>
          </section>
        ) : show.status === 'previews' || show.status === 'upcoming' ? (
          <section id="critic-reviews" className="card p-5 sm:p-6 pb-4 sm:pb-5 mb-5 sm:mb-8 scroll-mt-20" aria-labelledby="critic-scorecard-heading-pending">
            <header className="flex items-center justify-between gap-3 mb-3">
              <h2 id="critic-scorecard-heading-pending" className="text-[11px] font-bold uppercase tracking-[0.12em] text-gray-400 leading-none m-0">Critic Scorecard</h2>
              <span className="text-[11px] font-medium tracking-[0.06em] text-fg-muted lowercase shrink-0">tbd</span>
            </header>
            {/* openingDate is often null Off-Broadway — without the guard this
                rendered a dangling "Reviews coming after opening night:" with
                nothing after the colon (owner report on The Pass, 2026-08-02). */}
            <p className="text-gray-400 text-sm">
              {show.openingDate ? (
                <>
                  Reviews coming after {isWestEnd ? 'press night' : 'opening night'}:{' '}
                  <span className="text-white font-medium">{formatDate(show.openingDate)}</span>
                </>
              ) : (
                <>Reviews coming after {isWestEnd ? 'press night' : 'opening night'}.</>
              )}
            </p>
          </section>
        ) : (
          <section id="critic-reviews" className="card p-5 sm:p-6 pb-4 sm:pb-5 mb-5 sm:mb-8 scroll-mt-20" aria-labelledby="critic-scorecard-heading-archived">
            <header className="flex items-center justify-between gap-3 mb-3">
              <h2 id="critic-scorecard-heading-archived" className="text-[11px] font-bold uppercase tracking-[0.12em] text-gray-400 leading-none m-0">Critic Scorecard</h2>
            </header>
            <p className="text-gray-400 text-sm">
              {noReviewsExpected
                ? 'We found no critic reviews for this event.'
                : <>Archived critic reviews for this production are being collected and will appear here as they&apos;re processed.</>}
            </p>
          </section>
        )}

        <RelatedShowsCompactAB shows={compactRelated} sourceShowId={show.id} />

        {/* One fixed 300x250 AdSense unit (BRO-5893). Renders nothing unless the
            PostHog `ads` flag, auth, region and automation checks all pass and
            the script loaded; ships dark (flag at 0% `ads`). Kept here,
            far below the hero's ticket buttons and above ShowtimesCard. */}
        <AdSlot slot="showInline" />

        {/* National tour: where it plays now, next, and every stop (BRO-4601). */}
        {tourStops.length > 0 && (
          <TourScheduleCard stops={tourStops} today={tourToday} reviewCounts={tourReviewCounts} source={getTourScheduleSource(show.id)} tickets={getTourStopTickets(show)} show={{ id: show.id, title: show.title, slug: show.slug, status: show.status }} cityPages={new Set([...Array.from(getTourCities().keys()), ...Object.keys(HUB_CITIES)])} />
        )}

        {/* === SECTION ORDERING ===
            ABOVE FOLD (server component):
              1. Critic Reviews
              1.5. Ad slot (AdSlot, client; usually renders nothing)
            BELOW FOLD (ShowPageBelowFold lazy chunk):
              2. Video Reviews
              3. Audience Scorecard
              4. Awards Scorecard
              5. Box Office Scorecard
              6. Profitability Scorecard
              7. Where it ranks
              8. Showtimes
              8.5. FAQ / PAA block (owner move, 2026-08-02 — was 1.5)
              9. Socials Scorecard
             10. Theater Scorecard
             11. Seating Scorecard
             12. Discount Tickets
             13. Cast Updates
             14. Cast
             15. Creative Team
             16. Quick Facts                                                  */}

        <ShowPageBelowFoldLoader
          show={showForBelowFold}
          videoReviews={videoReviews}
          audienceBuzz={audienceBuzz}
          audienceShowScoreUrl={audienceShowScoreUrl}
          audiencePlatformUrls={audiencePlatformUrls}
          awards={awards ?? null}
          awardsSummary={awardsSummary}
          tonyNamesByCategory={tonyNamesByCategory}
          grosses={grosses ?? null}
          weekEnding={weekEnding}
          boxOfficeHistory={boxOfficeHistory}
          commercial={commercial}
          boxOfficeFacts={boxOfficeFacts}
          breakEvenCard={breakEvenCard}
          recoupmentTrend={recoupmentTrend}
          ranks={ranks}
          ranksByFormat={ranksByFormat}
          showSchedule={showSchedule ?? null}
          currentMonday={currentMonday}
          showtimeIds={showtimeIds}
          sortedTicketLinks={sortedTicketLinks}
          theater={theater && {
            name: theater.name,
            slug: theater.slug,
            venueScores: theater.venueScores,
            accessibility: theater.accessibility,
            externalLinks: theater.externalLinks,
            structuredTips: theater.structuredTips,
          }}
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
          venueSlug={londonVenueHidden ? null : venueSlug}
          offBroadwayVenueSlug={offBroadwayTheater?.slug ?? null}
          isWestEnd={isWestEnd}
          isOffBroadway={isOffBroadway}
          isOffWestEnd={isOffWestEnd}
          isOpera={isOpera}
          isRegional={isRegional}
          isTour={isTour}
          isCuratedHistoricalShow={isCuratedHistoricalShow}
          lastUpdated={lastUpdated}
          score={score}
          faqs={getShowFAQs(show, consensus?.text ?? null, isTour ? getTourNowNextForShow(show) : null)}
        />

      </div>

      {/* Follow Show Banner */}
      {show.status !== 'closed' && (
        <ShowFollowBanner showId={show.id} showTitle={show.title} />
      )}
    </>
  );
}
