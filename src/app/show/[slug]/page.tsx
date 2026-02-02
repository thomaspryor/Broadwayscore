import { notFound } from 'next/navigation';
import Link from 'next/link';
import { Metadata } from 'next';
import { getShowBySlug, getAllShowSlugs, ComputedShow, getShowGrosses, getGrossesWeekEnding, getShowAwards, getAudienceBuzz, getCriticConsensus, getLotteryRush, getShowCommercial, getShowLastUpdated, getRecoupmentTrend } from '@/lib/data';
import { generateShowSchema, generateBreadcrumbSchema, generateShowFAQSchema, BASE_URL } from '@/lib/seo';
import { getOptimizedImageUrl } from '@/lib/images';
import ShowImage from '@/components/ShowImage';
import StickyScoreHeader from '@/components/StickyScoreHeader';
import ReviewsList from '@/components/ReviewsList';
import BoxOfficeStats from '@/components/BoxOfficeStats';
import AwardsCard from '@/components/AwardsCard';
import AudienceBuzzCard from '@/components/AudienceBuzzCard';
import LotteryRushCard from '@/components/LotteryRushCard';
import BizBuzzCard from '@/components/BizBuzzCard';
import ScoreTooltip from '@/components/ScoreTooltip';
import Breadcrumb from '@/components/Breadcrumb';

export function generateStaticParams() {
  return getAllShowSlugs().map((slug) => ({ slug }));
}

export function generateMetadata({ params }: { params: { slug: string } }): Metadata {
  const show = getShowBySlug(params.slug);
  if (!show) return { title: 'Show Not Found' };

  const score = show.criticScore?.score;
  const roundedScore = score ? Math.round(score) : null;
  const reviewCount = show.criticScore?.reviewCount || 0;
  const description = score
    ? `${show.title} has a critic score of ${roundedScore}/100 based on ${reviewCount} reviews. ${show.synopsis?.slice(0, 100) || ''}`
    : `Reviews and scores for ${show.title} on Broadway. ${show.synopsis?.slice(0, 100) || ''}`;

  const canonicalUrl = `${BASE_URL}/show/${params.slug}`;

  // Use show's hero/poster image for OG, or fallback to homepage OG
  const ogImageUrl = show.images?.hero || show.images?.poster || `${BASE_URL}/og/home.png`;

  return {
    title: `${show.title} - Critic Score & Reviews`,
    description,
    alternates: {
      canonical: canonicalUrl,
    },
    openGraph: {
      title: `${show.title} - Broadway Scorecard`,
      description,
      url: canonicalUrl,
      type: 'article',
      images: [{
        url: ogImageUrl,
        width: 1200,
        height: 630,
        alt: `${show.title} - Score: ${roundedScore ?? 'TBD'} - Broadway Scorecard`,
      }],
    },
    twitter: {
      card: 'summary_large_image',
      title: `${show.title} - Critic Score ${roundedScore ? `${roundedScore}/100` : 'TBD'}`,
      description,
      images: [{
        url: ogImageUrl,
        width: 1200,
        height: 630,
        alt: `${show.title} - Score: ${roundedScore ?? 'TBD'} - Broadway Scorecard`,
      }],
    },
  };
}

function ScoreBadge({ score, size = 'lg', reviewCount, status }: { score?: number | null; size?: 'md' | 'lg' | 'xl'; reviewCount?: number; status?: string }) {
  const sizeClasses = {
    md: 'w-14 h-14 text-2xl rounded-xl',
    lg: 'w-20 h-20 text-4xl rounded-2xl',
    xl: 'w-24 h-24 text-5xl rounded-2xl',
  };

  // Show TBD for previews shows
  if (status === 'previews') {
    return (
      <div className={`${sizeClasses[size]} bg-surface-overlay text-gray-400 border border-white/10 flex items-center justify-center font-extrabold`}>
        TBD
      </div>
    );
  }

  // Show TBD if fewer than 5 reviews
  if (reviewCount !== undefined && reviewCount < 5) {
    return (
      <div className={`${sizeClasses[size]} bg-surface-overlay text-gray-400 border border-white/10 flex items-center justify-center font-extrabold`}>
        TBD
      </div>
    );
  }

  if (score === undefined || score === null) {
    return (
      <div className={`${sizeClasses[size]} bg-surface-overlay text-gray-500 border border-white/10 flex items-center justify-center font-extrabold`}>
        —
      </div>
    );
  }

  const roundedScore = Math.round(score);
  let colorClass: string;

  if (roundedScore >= 85) {
    // Must-See - premium gold
    colorClass = 'score-must-see';
  } else if (roundedScore >= 75) {
    // Great - green
    colorClass = 'score-great';
  } else if (roundedScore >= 65) {
    // Good - teal
    colorClass = 'score-good';
  } else if (roundedScore >= 55) {
    // Tepid - yellow
    colorClass = 'score-tepid';
  } else {
    // Skip - orange-red
    colorClass = 'score-skip';
  }

  return (
    <div className={`${sizeClasses[size]} ${colorClass} flex items-center justify-center font-extrabold`}>
      {roundedScore}
    </div>
  );
}

// Status pill - subtle background with accent color
function StatusBadge({ status }: { status: string }) {
  const label = {
    open: 'NOW PLAYING',
    closed: 'CLOSED',
    previews: 'IN PREVIEWS',
  }[status] || status.toUpperCase();

  const colorClass = {
    open: 'bg-emerald-500/15 text-emerald-400',
    closed: 'bg-gray-500/15 text-gray-400',
    previews: 'bg-purple-500/15 text-purple-400',
  }[status] || 'bg-gray-500/15 text-gray-400';

  return (
    <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-[10px] font-semibold uppercase tracking-wide ${colorClass}`}>
      {label}
    </span>
  );
}

function TierBadge({ tier }: { tier: number }) {
  const colors: Record<number, string> = {
    1: 'bg-accent-gold/20 text-accent-gold',
    2: 'bg-gray-500/20 text-gray-400',
    3: 'bg-surface-overlay text-gray-500',
  };

  return (
    <span className={`px-2 py-0.5 rounded-md text-xs font-medium ${colors[tier] || colors[3]}`}>
      Tier {tier}
    </span>
  );
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
  if (isNaN(date.getTime()) || date.getFullYear() < 1990) {
    return ''; // Hide date instead of showing garbage
  }

  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[date.getUTCMonth()]} ${date.getUTCDate()}, ${date.getUTCFullYear()}`;
}

function BackArrow() {
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
    </svg>
  );
}

function ExternalLinkIcon() {
  return (
    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
    </svg>
  );
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

// Format pill - outline style
function FormatPill({ type }: { type: string }) {
  const isMusical = type === 'musical' || type === 'revival';
  const label = isMusical ? 'MUSICAL' : 'PLAY';
  const colorClass = isMusical
    ? 'border-purple-500/50 text-purple-400'
    : 'border-blue-500/50 text-blue-400';

  return (
    <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-[10px] font-semibold uppercase tracking-wide border ${colorClass}`}>
      {label}
    </span>
  );
}

// Production pill - solid muted fill
function ProductionPill({ isRevival }: { isRevival: boolean }) {
  const label = isRevival ? 'REVIVAL' : 'ORIGINAL';
  const colorClass = isRevival
    ? 'bg-gray-500/20 text-gray-400'
    : 'bg-amber-500/20 text-amber-400';

  return (
    <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-[10px] font-semibold uppercase tracking-wide ${colorClass}`}>
      {label}
    </span>
  );
}

// Limited Run badge - eye-catching for shows ending soon
function LimitedRunBadge() {
  return (
    <span className="inline-flex items-center px-2.5 py-1 rounded-full text-[10px] font-semibold uppercase tracking-wide bg-rose-500/15 text-rose-400 border border-rose-500/30">
      LIMITED RUN
    </span>
  );
}

function ScoreLabel({ score }: { score: number }) {
  const roundedScore = Math.round(score);
  let label: string;
  let bgClass: string;
  let textClass: string;

  if (roundedScore >= 85) {
    label = 'Must-See';
    bgClass = 'bg-score-must-see/20 border border-score-must-see/50';
    textClass = 'text-score-must-see';
  } else if (roundedScore >= 75) {
    label = 'Great';
    bgClass = 'bg-score-great/20';
    textClass = 'text-score-great';
  } else if (roundedScore >= 65) {
    label = 'Good';
    bgClass = 'bg-score-good/20';
    textClass = 'text-score-good';
  } else if (roundedScore >= 55) {
    label = 'Tepid';
    bgClass = 'bg-score-tepid/20';
    textClass = 'text-score-tepid';
  } else {
    label = 'Skip';
    bgClass = 'bg-score-skip/20';
    textClass = 'text-score-skip';
  }

  return (
    <span className={`inline-block px-3 py-1 rounded-full text-sm font-bold uppercase tracking-wide ${bgClass} ${textClass}`}>
      {label}
    </span>
  );
}

function getSentimentLabel(score: number): { label: string; colorClass: string } {
  const roundedScore = Math.round(score);
  if (roundedScore >= 85) return { label: 'Must-See', colorClass: 'text-score-must-see' };
  if (roundedScore >= 75) return { label: 'Recommended', colorClass: 'text-score-great' };
  if (roundedScore >= 65) return { label: 'Worth Seeing', colorClass: 'text-score-good' };
  if (roundedScore >= 55) return { label: 'Skippable', colorClass: 'text-score-tepid' };
  return { label: 'Stay Away', colorClass: 'text-score-skip' };
}

interface ReviewForBreakdown {
  reviewScore: number;
}

function ScoreBreakdownBar({ reviews }: { reviews: ReviewForBreakdown[] }) {
  const positive = reviews.filter(r => r.reviewScore >= 65).length;
  const mixed = reviews.filter(r => r.reviewScore >= 55 && r.reviewScore < 65).length;
  const negative = reviews.filter(r => r.reviewScore < 55).length;
  const total = reviews.length;

  if (total === 0) return null;

  const positivePct = Math.round((positive / total) * 100);
  const mixedPct = Math.round((mixed / total) * 100);
  const negativePct = Math.round((negative / total) * 100);

  return (
    <div className="space-y-2" role="img" aria-label={`Review breakdown: ${positive} positive, ${mixed} mixed, ${negative} negative out of ${total} total reviews`}>
      {/* Bar */}
      <div className="h-3 rounded-full overflow-hidden flex bg-surface-overlay" aria-hidden="true">
        {positivePct > 0 && (
          <div
            className="bg-score-great h-full"
            style={{ width: `${positivePct}%` }}
          />
        )}
        {mixedPct > 0 && (
          <div
            className="bg-score-tepid h-full"
            style={{ width: `${mixedPct}%` }}
          />
        )}
        {negativePct > 0 && (
          <div
            className="bg-score-skip h-full"
            style={{ width: `${negativePct}%` }}
          />
        )}
      </div>
      {/* Legend */}
      <div className="flex items-center gap-4 text-xs">
        {positive > 0 && (
          <div className="flex items-center gap-1.5">
            <div className="w-3 h-3 rounded-sm bg-score-great" aria-hidden="true" />
            <span className="text-gray-400">{positive} Positive</span>
          </div>
        )}
        {mixed > 0 && (
          <div className="flex items-center gap-1.5">
            <div className="w-3 h-3 rounded-sm bg-score-tepid" aria-hidden="true" />
            <span className="text-gray-400">{mixed} Mixed</span>
          </div>
        )}
        {negative > 0 && (
          <div className="flex items-center gap-1.5">
            <div className="w-3 h-3 rounded-sm bg-score-skip" aria-hidden="true" />
            <span className="text-gray-400">{negative} Negative</span>
          </div>
        )}
      </div>
    </div>
  );
}

function CriticScoreSection({ score, reviewCount, reviews, status }: { score: number; reviewCount: number; reviews: ReviewForBreakdown[]; status?: string }) {
  const roundedScore = Math.round(score);
  const { label: sentimentLabel, colorClass } = getSentimentLabel(score);

  // Show TBD for previews shows or if fewer than 5 reviews
  const showTBD = status === 'previews' || reviewCount < 5;

  let scoreColorClass: string;
  if (roundedScore >= 85) {
    scoreColorClass = 'score-must-see';
  } else if (roundedScore >= 75) {
    scoreColorClass = 'score-great';
  } else if (roundedScore >= 65) {
    scoreColorClass = 'score-good';
  } else if (roundedScore >= 55) {
    scoreColorClass = 'score-tepid';
  } else {
    scoreColorClass = 'score-skip';
  }

  return (
    <section className="card p-5 sm:p-6 mb-6" aria-labelledby="critic-score-heading">
      <div className="flex items-start gap-4 sm:gap-6 mb-4">
        {/* Large Score Badge */}
        {showTBD ? (
          <div
            className="w-20 h-20 sm:w-24 sm:h-24 rounded-lg flex items-center justify-center flex-shrink-0 bg-surface-overlay text-gray-400 border border-white/10"
            role="status"
            aria-label="Score to be determined - fewer than 5 reviews"
          >
            <span className="text-3xl sm:text-4xl font-extrabold" aria-hidden="true">TBD</span>
          </div>
        ) : (
          <div
            className={`w-20 h-20 sm:w-24 sm:h-24 rounded-lg flex items-center justify-center flex-shrink-0 ${scoreColorClass}`}
            role="meter"
            aria-valuenow={roundedScore}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={`Critic Score: ${roundedScore} out of 100 - ${sentimentLabel}`}
          >
            <span className="text-4xl sm:text-5xl font-extrabold" aria-hidden="true">{roundedScore}</span>
          </div>
        )}

        {/* Critic Score Label and Sentiment */}
        <div className="flex-1 pt-1">
          <h2 id="critic-score-heading" className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-1">Critic Score</h2>
          {showTBD ? (
            <div className="text-lg sm:text-xl font-bold text-gray-400">Awaiting Reviews</div>
          ) : (
            <div className={`text-lg sm:text-xl font-bold ${colorClass}`}>{sentimentLabel}</div>
          )}
          <a
            href="#critic-reviews"
            className="text-sm text-gray-500 hover:text-brand transition-colors mt-1 inline-block"
          >
            Based on {reviewCount} Critic {reviewCount === 1 ? 'Review' : 'Reviews'}{showTBD ? ' (5+ needed)' : ''}
          </a>
        </div>
      </div>

      {/* Score Breakdown Bar */}
      <ScoreBreakdownBar reviews={reviews} />
    </section>
  );
}

function getGoogleMapsUrl(address: string): string {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;
}



export default function ShowPage({ params }: { params: { slug: string } }) {
  const show = getShowBySlug(params.slug);

  if (!show) {
    notFound();
  }

  const showSchema = generateShowSchema(show);
  const breadcrumbSchema = generateBreadcrumbSchema([
    { name: 'Home', url: BASE_URL },
    { name: show.type === 'musical' || show.type === 'revival' ? 'Musicals' : 'Plays', url: `${BASE_URL}/browse/${show.type === 'musical' || show.type === 'revival' ? 'best-broadway-musicals' : 'best-broadway-dramas'}` },
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
  const commercial = getShowCommercial(show.slug);
  const lastUpdated = getShowLastUpdated(show.id);

  // Combine schemas, filtering out null FAQ schema
  const schemas = [showSchema, breadcrumbSchema, faqSchema].filter(Boolean);

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(schemas) }}
      />

      {/* Sticky Score Header */}
      <StickyScoreHeader title={show.title} score={score} />

      <div className="max-w-3xl mx-auto px-4 sm:px-6 pt-6 sm:pt-8">
        <Breadcrumb items={[
          { label: 'Home', href: '/' },
          { label: show.type === 'musical' || show.type === 'revival' ? 'Musicals' : 'Plays', href: `/browse/${show.type === 'musical' || show.type === 'revival' ? 'best-broadway-musicals' : 'best-broadway-dramas'}` },
          { label: show.title },
        ]} />

        {/* Metacritic-style Header: Poster + Title/Score integrated */}
        <div className="card p-4 sm:p-6 mb-6">
          <div className="flex gap-4 sm:gap-6">
            {/* Poster Card - fetchpriority high for LCP optimization */}
            <div className="flex-shrink-0 w-28 sm:w-36 lg:w-40">
              <div className="aspect-[2/3] rounded-xl overflow-hidden shadow-2xl border border-white/10 bg-surface-raised">
                <ShowImage
                  sources={[
                    show.images?.poster ? getOptimizedImageUrl(show.images.poster, 'poster') : null,
                    show.images?.thumbnail ? getOptimizedImageUrl(show.images.thumbnail, 'poster') : null,
                  ]}
                  alt={show.title}
                  width={176}
                  height={264}
                  decoding="async"
                  priority
                  className="w-full h-full object-cover"
                  fallback={
                    <div className="w-full h-full flex items-center justify-center bg-surface-overlay">
                      <span className="text-4xl text-gray-600">🎭</span>
                    </div>
                  }
                />
              </div>
            </div>

            {/* Right side: Title, Meta, Score Box, and Breakdown */}
            <div className="flex-1 min-w-0">
              {/* Pills row */}
              <div className="flex flex-wrap items-center gap-1.5 mb-2">
                <FormatPill type={show.type} />
                <ProductionPill isRevival={show.type === 'revival'} />
                {show.limitedRun && <LimitedRunBadge />}
                <StatusBadge status={show.status} />
              </div>

              {/* Title */}
              <h1 className="text-xl sm:text-2xl lg:text-3xl font-extrabold text-white tracking-tight leading-tight mb-2">
                {show.title}
              </h1>

              {/* Meta line */}
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-gray-400 text-xs sm:text-sm mb-4">
                <span className="text-gray-300">{show.venue}</span>
                {show.runtime && (
                  <>
                    <span className="text-gray-600">•</span>
                    <span>{show.runtime}</span>
                  </>
                )}
                <span className="text-gray-600">•</span>
                {show.status === 'previews' ? (
                  <span>Opens {formatDate(show.openingDate)}</span>
                ) : show.closingDate ? (
                  <>
                    <span className="text-amber-400">{show.status === 'closed' ? 'Closed' : 'Closes'} {formatDate(show.closingDate)}</span>
                    <span className="text-gray-600">•</span>
                    <span>Opened {formatDate(show.openingDate)}</span>
                  </>
                ) : (
                  <span>Opened {formatDate(show.openingDate)}</span>
                )}
              </div>

              {/* Score Box + Sentiment + Review Count - Metacritic style */}
              {(() => {
                const reviewCount = show.criticScore?.reviewCount || 0;
                const showTBD = show.status === 'previews' || reviewCount < 5;
                const roundedScore = score ? Math.round(score) : null;
                const sentiment = score ? getSentimentLabel(score) : null;

                // Get tier counts for tooltip
                const tier1Count = show.criticScore?.tier1Count || 0;
                const tier2Count = show.criticScore?.tier2Count || 0;
                const tier3Count = show.criticScore?.tier3Count || 0;

                // Calculate breakdown
                const reviews = show.criticScore?.reviews || [];
                const positive = reviews.filter(r => r.reviewScore >= 65).length;
                const mixed = reviews.filter(r => r.reviewScore >= 55 && r.reviewScore < 65).length;
                const negative = reviews.filter(r => r.reviewScore < 55).length;
                const total = reviews.length;
                const positivePct = total > 0 ? Math.round((positive / total) * 100) : 0;
                const mixedPct = total > 0 ? Math.round((mixed / total) * 100) : 0;
                const negativePct = total > 0 ? Math.round((negative / total) * 100) : 0;

                let scoreColorClass = 'bg-surface-overlay text-gray-400 border border-white/10';
                if (!showTBD && roundedScore !== null) {
                  if (roundedScore >= 85) scoreColorClass = 'score-must-see';
                  else if (roundedScore >= 75) scoreColorClass = 'score-great';
                  else if (roundedScore >= 65) scoreColorClass = 'score-good';
                  else if (roundedScore >= 55) scoreColorClass = 'score-tepid';
                  else scoreColorClass = 'score-skip';
                }

                const scoreBox = (
                  <div className={`w-16 h-16 sm:w-20 sm:h-20 rounded-lg flex items-center justify-center flex-shrink-0 ${scoreColorClass}`}>
                    <span className="text-2xl sm:text-4xl font-extrabold">
                      {showTBD ? 'TBD' : roundedScore}
                    </span>
                  </div>
                );

                return (
                  <div className="space-y-3">
                    {/* Score row */}
                    <div className="flex items-center gap-3 sm:gap-4">
                      {/* Score box with tooltip */}
                      {!showTBD && roundedScore !== null && sentiment ? (
                        <ScoreTooltip
                          score={roundedScore}
                          label={sentiment.label}
                          tier1Count={tier1Count}
                          tier2Count={tier2Count}
                          tier3Count={tier3Count}
                          totalReviews={reviewCount}
                        >
                          {scoreBox}
                        </ScoreTooltip>
                      ) : (
                        scoreBox
                      )}
                      {/* Sentiment and review count */}
                      <div>
                        {showTBD ? (
                          <div className="text-base sm:text-lg font-bold text-gray-400">Awaiting Reviews</div>
                        ) : sentiment && (
                          <div className={`text-base sm:text-lg font-bold ${sentiment.colorClass}`}>{sentiment.label}</div>
                        )}
                        <a
                          href="#critic-reviews"
                          className="text-xs sm:text-sm text-gray-500 hover:text-brand transition-colors"
                        >
                          Based on {reviewCount} Critic {reviewCount === 1 ? 'Review' : 'Reviews'}
                        </a>
                      </div>
                    </div>

                    {/* Breakdown bar */}
                    {total > 0 && (
                      <div className="space-y-1.5">
                        <div className="h-2.5 rounded-full overflow-hidden flex bg-surface-overlay">
                          {positivePct > 0 && <div className="bg-score-great h-full" style={{ width: `${positivePct}%` }} />}
                          {mixedPct > 0 && <div className="bg-score-tepid h-full" style={{ width: `${mixedPct}%` }} />}
                          {negativePct > 0 && <div className="bg-score-skip h-full" style={{ width: `${negativePct}%` }} />}
                        </div>
                        <div className="flex items-center gap-3 text-[10px] sm:text-xs">
                          {positive > 0 && (
                            <div className="flex items-center gap-1">
                              <div className="w-2.5 h-2.5 rounded-sm bg-score-great" />
                              <span className="text-gray-400">{positive} Positive</span>
                            </div>
                          )}
                          {mixed > 0 && (
                            <div className="flex items-center gap-1">
                              <div className="w-2.5 h-2.5 rounded-sm bg-score-tepid" />
                              <span className="text-gray-400">{mixed} Mixed</span>
                            </div>
                          )}
                          {negative > 0 && (
                            <div className="flex items-center gap-1">
                              <div className="w-2.5 h-2.5 rounded-sm bg-score-skip" />
                              <span className="text-gray-400">{negative} Negative</span>
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })()}
            </div>
          </div>

          {/* Critics' Take - inline below the poster/score row */}
          {consensus ? (
            <div className="mt-4 pt-4 border-t border-white/5">
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">Critics&apos; Take</p>
              <p className="text-gray-300 text-sm leading-relaxed">{consensus.text}</p>
            </div>
          ) : show.synopsis ? (
            <p className="text-gray-400 text-sm leading-relaxed mt-4 pt-4 border-t border-white/5">
              {show.synopsis}
            </p>
          ) : null}

          {/* Links row: Official Site, Tickets, Trailer, Lottery/Rush */}
          {(show.officialUrl || show.trailerUrl || (show.ticketLinks && show.ticketLinks.length > 0 && show.status !== 'closed') || (lotteryRush && show.status !== 'closed')) && (
            <div className="flex flex-wrap gap-2 mt-4">
              {/* Official Website */}
              {show.officialUrl && (
                <a
                  href={show.officialUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-surface-overlay hover:bg-white/10 text-gray-300 hover:text-white text-xs font-medium transition-colors border border-white/10"
                >
                  <GlobeIcon />
                  Official Site
                </a>
              )}

              {/* Ticket Links */}
              {show.ticketLinks && show.ticketLinks.length > 0 && show.status !== 'closed' && show.ticketLinks.map((link, i) => (
                <a
                  key={i}
                  href={link.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-surface-overlay hover:bg-white/10 text-gray-300 hover:text-white text-xs font-medium transition-colors border border-white/10"
                >
                  <TicketIcon />
                  {link.platform}
                </a>
              ))}

              {/* Trailer */}
              {show.trailerUrl && (
                <a
                  href={show.trailerUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-surface-overlay hover:bg-white/10 text-gray-300 hover:text-white text-xs font-medium transition-colors border border-white/10"
                >
                  <PlayIcon />
                  Trailer
                </a>
              )}

              {/* Lottery/Rush Quick Link */}
              {lotteryRush && show.status !== 'closed' && (
                <a
                  href="#discount-tickets"
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-400 hover:text-emerald-300 text-xs font-medium transition-colors border border-emerald-500/30"
                >
                  <TicketIcon />
                  {lotteryRush.lottery ? `$${lotteryRush.lottery.price} Lottery` : lotteryRush.rush ? `$${lotteryRush.rush.price} Rush` : 'Discount Tickets'}
                </a>
              )}
            </div>
          )}
        </div>

        {/* Critic Reviews */}
        {show.criticScore && show.criticScore.reviews.length > 0 ? (
          <div id="critic-reviews" className="card p-5 sm:p-6 mb-8 scroll-mt-20">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-bold text-white">Critic Reviews</h2>
              <span className="text-sm text-gray-400 font-medium">{show.criticScore.reviewCount} reviews</span>
            </div>

            <ReviewsList reviews={show.criticScore.reviews} initialCount={5} />
          </div>
        ) : show.status === 'previews' && (
          <div id="critic-reviews" className="card p-5 sm:p-6 mb-8 scroll-mt-20">
            <h2 className="text-lg font-bold text-white mb-3">Critic Reviews</h2>
            <p className="text-gray-400 text-sm">
              Reviews coming after opening night: <span className="text-white font-medium">{formatDate(show.openingDate)}</span>
            </p>
          </div>
        )}

        {/* Audience Buzz Section - below Critic Reviews */}
        {audienceBuzz ? (
          <AudienceBuzzCard
            buzz={audienceBuzz}
            showScoreUrl={audienceBuzz.sources.showScore ? `https://www.show-score.com/broadway-shows/${show.slug}` : undefined}
          />
        ) : show.status === 'previews' && (
          <section className="card p-5 sm:p-6 mb-6">
            <h2 className="text-lg font-bold text-white mb-3">Audience Buzz</h2>
            <p className="text-gray-400 text-sm">Audience data will be added once the show opens and reviews come in.</p>
          </section>
        )}

        {/* Awards - above Box Office */}
        <AwardsCard showId={show.id} awards={awards} />

        {/* Box Office Stats */}
        {grosses ? (
          <BoxOfficeStats grosses={grosses} weekEnding={weekEnding} />
        ) : show.status === 'previews' && (
          <section className="card p-5 sm:p-6 mb-6">
            <h2 className="text-lg font-bold text-white mb-3">Box Office</h2>
            <p className="text-gray-400 text-sm">Box office data starts one week after previews begin.</p>
          </section>
        )}

        {/* Commercial Scorecard */}
        {commercial ? (
          <BizBuzzCard
            commercial={commercial}
            showTitle={show.title}
            trend={getRecoupmentTrend(show.slug)}
            weeklyGross={grosses?.thisWeek?.gross}
            showStatus={show.status as 'open' | 'closed' | 'previews'}
          />
        ) : show.status === 'previews' && (
          <section className="card p-5 sm:p-6 mb-6">
            <h2 className="text-lg font-bold text-white mb-3">Commercial Performance</h2>
            <p className="text-gray-400 text-sm">Financial data not available yet.</p>
          </section>
        )}

        {/* Lottery/Rush Tickets - below Commercial Performance, only show after previews start */}
        {lotteryRush && (() => {
          // Don't show until previews have started
          if (show.previewsStartDate) {
            const previewsStart = new Date(show.previewsStartDate);
            const today = new Date();
            if (today < previewsStart) return null;
          }
          return <LotteryRushCard data={lotteryRush} showStatus={show.status} />;
        })()}

        {/* Creative Team */}
        {show.creativeTeam && show.creativeTeam.length > 0 && (
          <div className="mb-8">
            <div className="card p-4 sm:p-5">
              <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wide mb-3">Creative Team</h2>
              <ul className="space-y-2.5 sm:space-y-2">
                {show.creativeTeam.map((member, i) => (
                  <li key={i} className="flex flex-col sm:flex-row sm:justify-between text-sm gap-0.5 sm:gap-2">
                    <span className="text-white font-medium">{member.name}</span>
                    <span className="text-gray-500 text-xs sm:text-sm">{member.role}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}

        {/* Quick Facts - Structured data for users and AI systems */}
        <div className="card p-4 sm:p-5 mb-8">
          <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wide mb-4">Quick Facts</h2>
          <dl className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4 text-sm">
            {/* Key metrics first for AI extractability */}
            {score && show.criticScore && show.criticScore.reviewCount >= 5 && (
              <div>
                <dt className="text-gray-500">Critic Score</dt>
                <dd className="text-white mt-0.5 font-semibold">{Math.round(score)}/100 <span className="font-normal text-gray-400">({show.criticScore.reviewCount} reviews)</span></dd>
              </div>
            )}
            <div>
              <dt className="text-gray-500">Status</dt>
              <dd className="text-white mt-0.5">
                {show.status === 'open' ? 'Now Playing' : show.status === 'previews' ? 'In Previews' : 'Closed'}
              </dd>
            </div>
            <div>
              <dt className="text-gray-500">{show.status === 'previews' ? 'Opens' : 'Opened'}</dt>
              <dd className="text-white mt-0.5">{formatDate(show.openingDate)}</dd>
            </div>
            {show.previewsStartDate && show.status === 'previews' && (
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
                {show.theaterAddress ? (
                  <a
                    href={getGoogleMapsUrl(show.theaterAddress)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 hover:text-brand transition-colors"
                  >
                    <MapPinIcon />
                    {show.venue} — {show.theaterAddress}
                  </a>
                ) : (
                  show.venue
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

        {/* Footer */}
        <div className="text-sm text-gray-500 border-t border-white/5 pt-6">
          <Link href="/methodology" className="text-brand hover:text-brand-hover transition-colors">
            How are scores calculated? →
          </Link>
        </div>
      </div>
    </>
  );
}
