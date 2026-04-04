'use client';

import { memo } from 'react';
import Link from 'next/link';
import { getOptimizedImageUrl } from '@/lib/images';
import ShowImage from '@/components/ShowImage';
import { getScoreColorClass, MustSeeCrown } from '@/components/show-cards';
import { getGoldThreshold } from '@/config/score-buckets';
import { getMarketLabel } from '@/lib/market-utils';
import ShowPageBookmark from '@/components/user/ShowPageBookmark';
import type { ShowCardShow } from './types';

export interface MiniShowCardProps {
  show: ShowCardShow;
  priority?: boolean;
}

// Compact card for featured/horizontal scroll rows
// NOTE: Poster images use 2:3 aspect ratio (standard Broadway poster format, e.g., 480x720)
// Never use a landscape/hero image as a poster — source proper portrait images instead
const MiniShowCard = memo(function MiniShowCard({ show, priority = false }: MiniShowCardProps) {
  const score = show.criticScore?.score;
  const category = show.category ?? 'broadway';
  const marketLabel = getMarketLabel(category);

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
        {/* Score overlay — outside overflow-hidden so crown can escape */}
        <div className="absolute bottom-1.5 right-1.5">
          <div className="relative overflow-visible">
            {score !== undefined && score !== null && score >= getGoldThreshold(category) && (
              <MustSeeCrown size="mini" />
            )}
            <div className={`w-9 h-9 rounded-lg flex items-center justify-center text-sm font-bold ${
              score === undefined || score === null ? 'bg-surface-overlay text-gray-400' : getScoreColorClass(score, category)
            }`}>
              {score !== undefined && score !== null ? Math.round(score) : '—'}
            </div>
          </div>
        </div>
      </div>
      <h3 className="font-semibold text-white text-sm group-hover:text-brand transition-colors line-clamp-2 leading-tight">
        {show.title}
      </h3>
      {show.subtitle && (
        <p className="text-[11px] text-emerald-400 font-medium mt-0.5 leading-tight">{show.subtitle}</p>
      )}
    </Link>
  );
});

export default MiniShowCard;
