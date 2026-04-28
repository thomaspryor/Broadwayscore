/**
 * Server-rendered featured row for LCP optimization.
 * Renders the "Best Recent Shows" shelf as static HTML so the LCP image
 * appears in the initial document — no JS hydration needed to paint it.
 *
 * Uses plain <img> tags instead of ShowImage (which is 'use client').
 */
import Link from 'next/link';
import { getOptimizedImageUrl, getCdnSrcSet } from '@/lib/images';
import { getMarketLabel } from '@/lib/venue-classification';
import { MustSeeCrown, getScoreColorClass } from '@/components/show-cards/ScoreBadge';
import { isCriticalGold, hasEnoughReviews } from '@/config/score-buckets';
import { CURATED_HISTORICAL_SHOWS } from '@/config/scoring';
import ShowPageBookmark from '@/components/user/ShowPageBookmark';
import type { HomepageShow } from '@/components/HomePageClient';

function ServerMiniShowCard({ show, priority }: { show: HomepageShow; priority: boolean }) {
  const reviewCount = show.criticScore?.reviewCount ?? 0;
  const t1t2 = (show.criticScore?.tier1Count ?? 0) + (show.criticScore?.tier2Count ?? 0);
  const rawScore = show.criticScore?.score;
  const score = rawScore != null && hasEnoughReviews(reviewCount, show.category, t1t2, CURATED_HISTORICAL_SHOWS.has(show.id)) ? rawScore : null;
  const category = show.category ?? 'broadway';
  const imgSrc = show.images?.poster
    ? getOptimizedImageUrl(show.images.poster, 'card')
    : show.images?.thumbnail
      ? getOptimizedImageUrl(show.images.thumbnail, 'card')
      : show.images?.hero
        ? getOptimizedImageUrl(show.images.hero, 'card')
        : null;

  const srcSet = imgSrc ? getCdnSrcSet(imgSrc) : '';

  return (
    <Link
      href={`/show/${show.slug}`}
      prefetch={false}
      className="flex-shrink-0 w-28 sm:w-32 group"
    >
      <div className="relative mb-1.5">
        <div className="relative rounded-lg overflow-hidden bg-surface-overlay aspect-[2/3]">
          <ShowPageBookmark showId={show.id} size="sm" />
          {imgSrc ? (
            <img
              src={imgSrc}
              srcSet={srcSet || undefined}
              sizes={srcSet ? '(min-width: 640px) 128px, 112px' : undefined}
              alt={`${show.title} ${getMarketLabel(show.category)} ${show.type}`}
              loading={priority ? 'eager' : 'lazy'}
              fetchPriority={priority ? 'high' : undefined}
              decoding="async"
              className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
            />
          ) : (
            <div className="w-full h-full flex flex-col items-center justify-center text-gray-500 px-2" aria-hidden="true">
              <div className="text-2xl mb-1">🎭</div>
            </div>
          )}
        </div>
        {/* Score overlay */}
        <div className="absolute bottom-1.5 right-1.5">
          <div className="relative overflow-visible">
            {isCriticalGold(score, category) && (
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
    </Link>
  );
}

const ChevronRightIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="m9 18 6-6-6-6"/></svg>
);

export default function FeaturedRowServer({ shows }: { shows: HomepageShow[] }) {
  if (shows.length === 0) return null;

  return (
    <section className="mb-4 sm:mb-6">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-base font-bold text-white">Best Recent Shows</h2>
        <Link
          href="/browse/best-recent-shows"
          prefetch={false}
          className="flex items-center gap-1 text-xs text-gray-400 hover:text-brand transition-colors"
        >
          See all <ChevronRightIcon />
        </Link>
      </div>
      <div className="flex gap-3 overflow-x-auto pb-3 -mx-4 px-4 sm:mx-0 sm:px-0 scrollbar-hide">
        {shows.map((show, index) => (
          <ServerMiniShowCard key={show.id} show={show} priority={index < 4} />
        ))}
      </div>
    </section>
  );
}
