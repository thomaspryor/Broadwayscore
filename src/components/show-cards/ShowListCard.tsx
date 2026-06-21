'use client';

import { memo } from 'react';
import Link from 'next/link';
import { getOptimizedImageUrl } from '@/lib/images';
import ShowImage from '@/components/ShowImage';
import { getScoreTier, getScoreColorClass, ScoreBadge, MustSeeCrown, StatusBadge, FormatPill, ProductionPill, AudienceChip, CategoryBadge } from '@/components/show-cards';
import type { ScoreTier } from '@/components/show-cards';
import { hasEnoughReviews } from '@/config/score-buckets';
import { CURATED_HISTORICAL_SHOWS } from '@/config/scoring';
import { getBroadwayDuration, getRunLength, formatOpeningDate, getDurationSuffix } from '@/lib/date-utils';
import { getMarketLabel, isLondonMarket } from '@/lib/market-utils';
import { isOperaShow, OPERA_DURATION_SUFFIX, OPERA_MARKET_LABEL } from '@/lib/show-market';
import ShowPageBookmark from '@/components/user/ShowPageBookmark';
import { sortTicketLinks } from '@/lib/ticket-utils';
import type { ShowCardShow, ScoreModeParam } from './types';

export interface ShowListCardProps {
  show: ShowCardShow;
  index: number;
  scoreMode: ScoreModeParam;
  hideStatus?: boolean;
  /** 'default' for homepage/market pages, 'compact' for browse lists */
  variant?: 'default' | 'compact';
  /** When provided, shows a rank badge outside the card link */
  rank?: number;
  /** Show performance count instead of duration (browse pages) */
  showPerformances?: boolean;
  /** Show "N reviews" text for low review counts (browse pages) */
  showLowReviewCount?: boolean;
  /** Show category badge (e.g. "Off-Bway") — use on pages that mix categories */
  showCategoryBadge?: boolean;
  /** Show format pill (Musical/Play) — defaults to true */
  showFormatPill?: boolean;
  /** Show closed-show info when mixing open/closed statuses (browse) */
  isMixedStatus?: boolean;
  /** Show ticket CTA below the card */
  showTicketLink?: boolean;
  /** Override the default /show/[slug] href (used by opera pages for clean URLs) */
  overrideHref?: string;
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

// getMarketLabel imported from @/lib/venue-classification

const ShowListCard = memo(function ShowListCard({
  show,
  index,
  scoreMode,
  hideStatus = false,
  variant = 'default',
  rank,
  showPerformances = false,
  showLowReviewCount = false,
  showCategoryBadge = false,
  showFormatPill = true,
  isMixedStatus = false,
  showTicketLink = false,
  overrideHref,
}: ShowListCardProps) {
  const isRevival = show.isRevival === true;
  const category = show.category ?? 'broadway';
  const isCompact = variant === 'compact';

  // Ticket link for CTA (sorted, first link = highest priority affiliate)
  const sortedLinks = show.ticketLinks ? sortTicketLinks(show.ticketLinks) : [];
  const primaryTicket = sortedLinks[0];
  const canShowTicket = showTicketLink && primaryTicket && (show.status === 'open' || show.status === 'previews');
  const isOpera = isOperaShow(show);
  const marketLabel = isOpera ? OPERA_MARKET_LABEL : getMarketLabel(category);
  const durationSuffix = isOpera ? OPERA_DURATION_SUFFIX : getDurationSuffix(category);
  const cardHref = overrideHref ?? `/show/${show.slug}`;

  // Score computation
  let score: number | null | undefined;
  let tier: ScoreTier | null = null;
  let audienceGrade = show.audienceGrade;

  const criticScore = show.criticScore?.score;
  const criticTier = getScoreTier(criticScore, category);
  const reviewCount = show.criticScore?.reviewCount ?? 0;
  const t1t2 = (show.criticScore?.tier1Count ?? 0) + (show.criticScore?.tier2Count ?? 0);

  if (scoreMode === 'audience') {
    if (show.audienceCombinedScore != null && show.status !== 'previews') {
      score = show.audienceCombinedScore;
      audienceGrade = show.audienceGrade;
      if (audienceGrade) {
        tier = { label: audienceGrade.grade, color: audienceGrade.color, tooltip: audienceGrade.tooltip, range: '', glow: false };
      }
    }
  } else {
    score = criticScore;
    tier = hasEnoughReviews(reviewCount, category, t1t2, CURATED_HISTORICAL_SHOWS.has(show.id)) ? getScoreTier(score, category) : null;
    audienceGrade = show.audienceGrade;
  }

  const isOpen = show.status === 'open' || show.status === 'previews' || show.status === 'upcoming';
  const badgeSize = isCompact ? 'md' as const : 'lg' as const;

  // --- Ticket CTA (inline text, desktop only) ---
  // Rendered inside the card's <Link> — uses span+onClick+stopPropagation
  // since nested <a> tags are invalid HTML.
  const ticketCta = canShowTicket ? (
    <span
      role="link"
      tabIndex={0}
      className="hidden sm:inline-flex items-center gap-1 text-amber-400/80 hover:text-amber-300 cursor-pointer text-[11px] font-medium"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        try {
          navigator.sendBeacon('https://us.i.posthog.com/capture/', JSON.stringify({
            api_key: 'phc_xVenlxA1HzyJz0Yjlj3UkF9JVLCPe86Td6vQEK41SF7',
            event: 'ticket_click',
            properties: { distinct_id: 'browse-click', show_id: show.id, show_name: show.title, show_status: show.status ?? null, platform: primaryTicket.platform, page_type: 'browse', is_affiliate: true, link_position: 0 },
            timestamp: new Date().toISOString(),
          }));
        } catch { /* not critical */ }
        window.open(primaryTicket.url, '_blank', 'noopener');
      }}
      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); window.open(primaryTicket.url, '_blank', 'noopener'); } }}
    >
      {primaryTicket.priceFrom ? `· From ${isLondonMarket(category) ? '£' : '$'}${primaryTicket.priceFrom} ↗` : '· Tickets ↗'}
    </span>
  ) : null;

  // --- Info section content differs between default and compact ---
  const infoContent = isCompact ? (
    // Compact variant (Browse): different date formatting, performances support
    <div className="flex-1 min-w-0">
      <h2 className="font-bold text-lg text-white group-hover:text-brand transition-colors line-clamp-2">
        {show.title}
      </h2>
      <div className="flex flex-wrap items-center gap-1.5 mt-1">
        {showFormatPill && <FormatPill type={show.type} />}
        {isRevival && <ProductionPill isRevival={true} />}
      </div>
      <div className="flex flex-wrap items-center gap-1.5 mt-1 text-xs text-gray-500">
        {showPerformances && show.performances ? (
          <span className="text-emerald-400">{show.performances.toLocaleString()} performances</span>
        ) : (
          <>
            {show.status === 'open' && (() => {
              const duration = getBroadwayDuration(show.openingDate, durationSuffix);
              return duration ? <span>{duration}</span> : null;
            })()}
            {show.status === 'open' && show.closingDate && (
              <span className="text-amber-400">
                {getBroadwayDuration(show.openingDate, durationSuffix) && '·'} Closes {new Date(show.closingDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
              </span>
            )}
            {(show.status === 'previews' || show.status === 'upcoming') && show.openingDate && (
              <span className="text-purple-400">
                Opens {new Date(show.openingDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
              </span>
            )}
          </>
        )}
        {isMixedStatus && !isOpen && (
          <span className="text-orange-400">
            {(() => {
              if (!show.closingDate) return 'Closed';
              const when = new Date(show.closingDate).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
              const runLen = getRunLength(show.openingDate, show.closingDate, 'short');
              return runLen ? `Closed ${when}, after ${runLen}` : `Closed ${when}`;
            })()}
          </span>
        )}
        {ticketCta}
      </div>
    </div>
  ) : (
    // Default variant (Home, OB, WE): formatOpeningDate style
    <div className="flex-1 min-w-0">
      {showCategoryBadge && category === 'off-broadway' && !isOpera && (
        <span className="inline-block mb-1 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-purple-300 bg-purple-500/15 border border-purple-500/20 rounded whitespace-nowrap">Off-Broadway</span>
      )}
      <h3 className="font-bold text-white text-lg group-hover:text-brand transition-colors line-clamp-2">
        {show.title}
      </h3>
      <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
        <FormatPill type={show.type} />
        <ProductionPill isRevival={isRevival} />
        {show.isOffWestEnd && <CategoryBadge category="off-west-end" />}
        {!hideStatus && <StatusBadge status={show.status} />}
      </div>
      <p className="text-sm text-gray-400 mt-2.5 truncate">
        {show.status === 'previews' || show.status === 'upcoming' ? (
          <>Opens {formatOpeningDate(show.openingDate)}</>
        ) : show.status === 'closed' ? (
          <span className="text-orange-400">{(() => {
            if (!show.closingDate) return 'Closed';
            const when = formatOpeningDate(show.closingDate);
            const runLen = getRunLength(show.openingDate, show.closingDate, 'short');
            return runLen ? `Closed ${when}, after ${runLen}` : `Closed ${when}`;
          })()}</span>
        ) : (
          <>
            {(() => {
              const duration = getBroadwayDuration(show.openingDate, durationSuffix);
              return duration ? <>{duration}</> : null;
            })()}
            {show.closingDate && (
              <span className="text-amber-400">{getBroadwayDuration(show.openingDate, durationSuffix) ? ' · ' : ''}Closes {formatOpeningDate(show.closingDate)}</span>
            )}
          </>
        )}
      </p>
    </div>
  );

  // --- Score section ---
  const scoreSection = (
    <div className={`flex-shrink-0 flex flex-col items-center ${isCompact ? 'gap-1.5' : 'justify-center gap-1.5'} w-20 sm:w-24 ${isCompact ? '' : 'overflow-visible'}`}>
      {scoreMode === 'audience' ? (
        audienceGrade ? (
          <>
            <span
              className="text-[9px] font-semibold uppercase tracking-wide whitespace-nowrap"
              style={{ color: audienceGrade.color }}
              title={audienceGrade.tooltip}
            >
              {audienceGrade.label}
            </span>
            {isCompact ? (
              // Compact audience badge
              <div
                className="w-12 h-12 sm:w-14 sm:h-14 rounded-xl flex items-center justify-center font-bold text-xl sm:text-2xl"
                style={{ backgroundColor: audienceGrade.color, color: audienceGrade.textColor }}
                title={audienceGrade.tooltip}
              >
                {audienceGrade.grade}
              </div>
            ) : (
              // Default audience badge (larger, with glow + A+ special class)
              <>
                <div
                  className={`score-badge w-16 h-16 sm:w-20 sm:h-20 text-2xl sm:text-3xl rounded-xl font-bold${audienceGrade.grade === 'A+' ? ' audience-top-grade' : ''}`}
                  style={audienceGrade.grade === 'A+' ? {} : {
                    backgroundColor: audienceGrade.color,
                    color: audienceGrade.textColor,
                    boxShadow: `0 2px 8px ${audienceGrade.color}4d`,
                  }}
                  title={audienceGrade.tooltip}
                >
                  {audienceGrade.grade}
                </div>
                {criticScore != null && (
                  <div
                    className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold mt-1"
                    style={{ backgroundColor: `${criticTier?.color ?? '#6b7280'}20`, color: criticTier?.color ?? '#6b7280' }}
                    title={criticTier?.tooltip}
                  >
                    <span className="opacity-60">Critics:</span>
                    <span>{Math.round(criticScore)}</span>
                  </div>
                )}
              </>
            )}
          </>
        ) : isCompact ? (
          // Compact no-data state
          <>
            <span className="text-[9px] font-semibold uppercase tracking-wide text-gray-600 whitespace-nowrap">
              No Data
            </span>
            <div className="w-12 h-12 sm:w-14 sm:h-14 rounded-xl flex items-center justify-center font-bold text-lg bg-surface-overlay text-gray-600 border border-white/10">
              --
            </div>
          </>
        ) : show.status === 'previews' || show.status === 'upcoming' ? (
          <div className="score-badge w-16 h-16 sm:w-20 sm:h-20 text-sm rounded-xl score-none font-bold text-gray-400">
            TBD
          </div>
        ) : null
      ) : (
        // Critics mode
        <>
          {show.status === 'previews' || show.status === 'upcoming' || !hasEnoughReviews(reviewCount, category, t1t2, CURATED_HISTORICAL_SHOWS.has(show.id)) ? (
            <span className="text-[9px] font-semibold uppercase tracking-wide whitespace-nowrap text-gray-500">
              Not Yet Rated
            </span>
          ) : tier ? (
            <span
              className="text-[9px] font-semibold uppercase tracking-wide whitespace-nowrap"
              style={{ color: tier.color }}
              title={tier.tooltip}
            >
              {tier.label}
            </span>
          ) : null}
          <ScoreBadge
            score={score}
            size={badgeSize}
            reviewCount={reviewCount}
            status={show.status}
            showCrown
            category={category}
            tier1And2Count={t1t2}
          />
          {showLowReviewCount && reviewCount > 0 && reviewCount <= 2 ? (
            <span className="text-[9px] text-gray-500 whitespace-nowrap">
              {reviewCount} review{reviewCount > 1 ? 's' : ''}
            </span>
          ) : audienceGrade ? (
            <div className={isCompact ? 'mt-0.5' : 'mt-1'}>
              <AudienceChip grade={audienceGrade} />
            </div>
          ) : null}
        </>
      )}
    </div>
  );

  // --- Thumbnail ---
  // Upcoming/previews shows use poster aspect ratio on mobile (taller, more visual impact)
  const isUpcoming = show.status === 'previews' || show.status === 'upcoming';
  const usePosterLayout = isCompact && isUpcoming;
  const thumbnailSize = usePosterLayout
    ? 'w-16 h-24 sm:w-20 sm:h-20'
    : isCompact
    ? 'w-16 h-16 sm:w-20 sm:h-20'
    : 'w-24 h-24 sm:w-28 sm:h-28';

  const thumbnail = (
    <div className={`relative flex-shrink-0 ${thumbnailSize} rounded-lg overflow-hidden bg-surface-overlay`}>
      <ShowPageBookmark showId={show.id} size="sm" />
      <ShowImage
        sources={usePosterLayout ? [
          show.images?.poster ? getOptimizedImageUrl(show.images.poster, 'thumbnail') : null,
          show.images?.thumbnail ? getOptimizedImageUrl(show.images.thumbnail, 'thumbnail') : null,
          show.images?.hero ? getOptimizedImageUrl(show.images.hero, 'thumbnail') : null,
        ] : [
          show.images?.thumbnail ? getOptimizedImageUrl(show.images.thumbnail, 'thumbnail') : null,
          show.images?.poster ? getOptimizedImageUrl(show.images.poster, 'thumbnail') : null,
          show.images?.hero ? getOptimizedImageUrl(show.images.hero, 'thumbnail') : null,
        ]}
        alt={`${show.title} ${marketLabel} ${show.type}`}
        priority={index < 2}
        loading={index < 2 ? 'eager' : 'lazy'}
        width={usePosterLayout ? 64 : isCompact ? 80 : 112}
        height={usePosterLayout ? 96 : isCompact ? 80 : 112}
        decoding="async"
        sizes={isCompact ? '(min-width: 640px) 80px, 64px' : '(min-width: 640px) 112px, 96px'}
        className={`w-full h-full object-cover group-hover:scale-105 transition-transform duration-300${isCompact ? '' : ' will-change-transform'}`}
        fallback={
          <div className="w-full h-full flex flex-col items-center justify-center text-gray-500 px-2" aria-hidden="true">
            <div className="text-2xl mb-0.5">🎭</div>
            {!isCompact && (show.status === 'previews' || show.status === 'upcoming') && (
              <div className="text-[9px] text-gray-500 text-center font-medium leading-tight">Images<br/>soon</div>
            )}
          </div>
        }
      />
    </div>
  );

  // --- Review year note (between info and score, desktop only) ---
  const reviewYearNote = show.reviewYearNote && scoreMode === 'critics' ? (
    <span className="hidden sm:flex flex-shrink-0 text-[10px] text-gray-400 leading-tight text-right max-w-[4.5rem] self-center">
      {show.reviewYearNote}
    </span>
  ) : null;



  // --- Assemble card ---
  if (isCompact && rank != null) {
    // Browse variant with rank badge: rank outside the link
    return (
      <div className="flex items-center gap-3">
        <div className="hidden sm:block">
          <RankBadge rank={rank} />
        </div>
        <Link
          href={cardHref}
          className="card p-3 sm:p-4 flex items-center gap-3 sm:gap-4 hover:bg-surface-raised/80 transition-colors group flex-1 min-w-0"
        >
          {thumbnail}
          {infoContent}
          {reviewYearNote}
          {scoreSection}
        </Link>
      </div>
    );
  }

  if (isCompact) {
    // Browse variant without rank
    return (
      <Link
        href={cardHref}
        className="card p-3 sm:p-4 flex items-center gap-3 sm:gap-4 hover:bg-surface-raised/80 transition-colors group min-w-0"
      >
        {thumbnail}
        {infoContent}
        {reviewYearNote}
        {scoreSection}
      </Link>
    );
  }

  // Default variant (Home, OB, WE)
  return (
    <Link
      href={cardHref}
      prefetch={false}
      role="listitem"
      data-testid="show-card"
      className="group card-interactive flex items-center gap-4 px-5 py-3 animate-in focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
      style={{ animationDelay: `${index * 30}ms` }}
    >
      {thumbnail}
      {infoContent}
      {reviewYearNote}
      {scoreSection}
    </Link>
  );
});

export default ShowListCard;
