'use client';

import { memo } from 'react';
import Link from 'next/link';
import { getOptimizedImageUrl } from '@/lib/images';
import ShowImage from '@/components/ShowImage';
import { getScoreColorClass, MustSeeCrown } from '@/components/show-cards';
import { isCriticalGold, hasEnoughReviews } from '@/config/score-buckets';
import { CURATED_HISTORICAL_SHOWS } from '@/config/scoring';
import { getMarketLabel } from '@/lib/market-utils';
import ShowPageBookmark from '@/components/user/ShowPageBookmark';
import HoverRateStars from '@/components/user/HoverRateStars';
import type { ShowCardShow } from './types';

export interface MiniShowCardProps {
  show: ShowCardShow;
  priority?: boolean;
}

// Compact card for featured/horizontal scroll rows
// NOTE: Poster images use 2:3 aspect ratio (standard Broadway poster format, e.g., 480x720)
// Never use a landscape/hero image as a poster — source proper portrait images instead
const MiniShowCard = memo(function MiniShowCard({ show, priority = false }: MiniShowCardProps) {
  const category = show.category ?? 'broadway';
  const reviewCount = show.criticScore?.reviewCount ?? 0;
  const t1t2 = (show.criticScore?.tier1Count ?? 0) + (show.criticScore?.tier2Count ?? 0);
  const rawScore = show.criticScore?.score;
  const score = rawScore != null && hasEnoughReviews(reviewCount, category, t1t2, CURATED_HISTORICAL_SHOWS.has(show.id)) ? rawScore : null;
  const marketLabel = getMarketLabel(category);

  // For not-yet-open shows there's no score, so the badge slot would just read
  // "—". Surface the start date there instead — the most useful fact for an
  // upcoming show. Everything else keeps the score badge.
  const startDate = show.previewsStartDate || show.openingDate;
  const showDateBadge = score == null && (show.status === 'upcoming' || show.status === 'previews') && !!startDate;
  const dateBadge = showDateBadge
    ? (() => {
        const d = new Date(startDate.slice(0, 10) + 'T12:00:00');
        return Number.isNaN(d.getTime())
          ? null
          : {
              month: d.toLocaleDateString('en-US', { month: 'short' }).toUpperCase(),
              day: d.getDate(),
              full: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
            };
      })()
    : null;

  // An open show with no score yet is awaiting reviews — show a distinct "TBD"
  // chip (status-open green) instead of the neutral gray "—" used for other
  // no-score cases (e.g. closed historical), so the awaiting state reads on the
  // card itself, not just via the shelf heading.
  const isAwaiting = score == null && show.status === 'open';

  return (
    <Link
      href={`/show/${show.slug}`}
      prefetch={false}
      className="flex-shrink-0 w-28 sm:w-32 group"
    >
      {/* Poster container wrapper — relative so score overlay can escape overflow-hidden */}
      <div className="relative mb-1.5">
        <div className="relative rounded-lg overflow-hidden bg-surface-overlay aspect-[2/3]">
          <ShowPageBookmark showId={show.id} size="sm" />
          <HoverRateStars showId={show.id} showHref={`/show/${show.slug}`} />
          <ShowImage
            sources={[
              show.images?.poster ? getOptimizedImageUrl(show.images.poster, 'card') : null,
              show.images?.thumbnail ? getOptimizedImageUrl(show.images.thumbnail, 'card') : null,
              show.images?.hero ? getOptimizedImageUrl(show.images.hero, 'card') : null,
            ]}
            alt={`${show.title} ${marketLabel} ${show.type}`}
            priority={priority}
            loading={priority ? "eager" : "lazy"}
            sizes="(min-width: 640px) 128px, 112px"
            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
            fallback={
              <div className="w-full h-full flex flex-col items-center justify-center text-gray-500 px-2" aria-hidden="true">
                <div className="text-2xl mb-1">🎭</div>
                {(show.status === 'previews' || show.status === 'upcoming') && (
                  <div className="text-[10px] text-gray-500 text-center font-medium">Images<br/>coming soon</div>
                )}
              </div>
            }
          />
        </div>
        {/* Score / date overlay — outside overflow-hidden so crown can escape */}
        <div className="absolute bottom-1.5 right-1.5">
          <div className="relative overflow-visible">
            {isCriticalGold(score, category) && (
              <MustSeeCrown size="mini" />
            )}
            {dateBadge ? (
              <div
                className="w-9 rounded-lg flex flex-col items-center justify-center leading-none bg-surface-elevated ring-1 ring-white/10 shadow-card py-1"
                title={`Starts ${dateBadge.full}`}
              >
                <span className="text-[7px] font-bold uppercase tracking-wide text-gray-300">Starts</span>
                <span className="text-[8px] font-bold uppercase tracking-wide text-brand mt-0.5">{dateBadge.month}</span>
                <span className="text-sm font-bold text-white">{dateBadge.day}</span>
              </div>
            ) : isAwaiting ? (
              <div
                className="w-9 h-9 rounded-lg flex items-center justify-center text-xs font-bold bg-status-open-bg text-status-open ring-1 ring-status-open/25 shadow-card"
                title="Awaiting reviews — score coming soon"
              >
                TBD
              </div>
            ) : (
              <div className={`w-9 h-9 rounded-lg flex items-center justify-center text-sm font-bold ${
                score === undefined || score === null ? 'bg-surface-overlay text-gray-400' : getScoreColorClass(score, category)
              }`}>
                {score !== undefined && score !== null ? Math.round(score) : '—'}
              </div>
            )}
          </div>
        </div>
      </div>
      <h3 className="font-semibold text-white text-sm group-hover:text-brand transition-colors line-clamp-2 leading-tight">
        {show.title}
      </h3>
      {/* The date badge already carries "Starts <date>", so drop the duplicate subtitle. */}
      {show.subtitle && !(dateBadge && /^starts /i.test(show.subtitle)) && (
        <p className={`text-[11px] font-medium mt-0.5 leading-tight ${show.subtitleColor || 'text-emerald-400'}`}>{show.subtitle}</p>
      )}
    </Link>
  );
});

export default MiniShowCard;
