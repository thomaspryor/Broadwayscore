/**
 * Server-rendered featured row for LCP optimization.
 * Renders the "Best Recent Shows" shelf as static HTML so the LCP image
 * appears in the initial document — no JS hydration needed to paint it.
 *
 * Uses plain <img> tags instead of ShowImage (which is 'use client').
 */
import Link from 'next/link';
import { getOptimizedImageUrl } from '@/lib/images';
import { getServerImageSrcSet } from '@/lib/show-image-srcset.server';
import { getMarketLabel } from '@/lib/venue-classification';
import { MustSeeCrown, getScoreColorClass } from '@/components/show-cards/ScoreBadge';
import { isCriticalGold, hasEnoughReviews } from '@/config/score-buckets';
import { CURATED_HISTORICAL_SHOWS } from '@/config/scoring';
import ShowPageBookmark from '@/components/user/ShowPageBookmark';
import HoverRateStars from '@/components/user/HoverRateStars';
import ScrollRow from '@/components/ScrollRow';

/**
 * Minimal structural shape used by the server shelf. HomepageShow / WestEndShow /
 * OffBroadwayShow all satisfy it, so the same shelf can front any market page.
 */
export interface ServerShelfShow {
  id: string;
  slug: string;
  title: string;
  type: string;
  category?: string;
  venue?: string;
  status?: string;
  previewsStartDate?: string | null;
  openingDate?: string | null;
  images?: { thumbnail?: string; poster?: string; hero?: string };
  criticScore?: { score?: number; reviewCount?: number; tier1Count?: number; tier2Count?: number };
}

function ServerMiniShowCard({ show, priority, eager, caption }: { show: ServerShelfShow; priority: boolean; eager: boolean; caption?: string }) {
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

  const srcSet = imgSrc ? getServerImageSrcSet(imgSrc) : '';

  return (
    <Link
      href={`/show/${show.slug}`}
      prefetch={false}
      className="flex-shrink-0 w-28 sm:w-32 group"
    >
      <div className="relative mb-1.5">
        <div className="relative rounded-lg overflow-hidden bg-surface-overlay aspect-[2/3]">
          <ShowPageBookmark showId={show.id} size="sm" />
          {/* Server component: pass only the gate's fields, not the whole show, into the client payload. */}
          <HoverRateStars showId={show.id} show={{ status: show.status, previewsStartDate: show.previewsStartDate, openingDate: show.openingDate }} showHref={`/show/${show.slug}`} />
          {imgSrc ? (
            <img
              src={imgSrc}
              srcSet={srcSet || undefined}
              sizes={srcSet ? '(min-width: 640px) 128px, 112px' : undefined}
              alt={`${show.title} ${getMarketLabel(show.category, show.venue)} ${show.type}`}
              loading={eager ? 'eager' : 'lazy'}
              fetchPriority={priority ? 'high' : undefined}
              decoding="async"
              className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
            />
          ) : (
            <div className="w-full h-full flex flex-col items-center justify-center text-fg-muted px-2" aria-hidden="true">
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
              {score !== undefined && score !== null ? Math.round(score) : '–'}
            </div>
          </div>
        </div>
      </div>
      <h3 className="font-semibold text-white text-sm group-hover:text-brand transition-colors line-clamp-2 leading-tight">
        {show.title}
      </h3>
      {caption && <p className="text-xs text-fg-muted mt-0.5 line-clamp-1">{caption}</p>}
    </Link>
  );
}

const ChevronRightIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="m9 18 6-6-6-6"/></svg>
);

export default function FeaturedRowServer({
  shows,
  title = 'Best Recent Shows',
  subtitle,
  viewAllHref,
  captions,
}: {
  shows: ServerShelfShow[];
  /** Shelf heading. Defaults to the homepage's "Best Recent Shows". */
  title?: string;
  /** Optional caption below the heading (e.g. "Ranked by critical consensus"). */
  subtitle?: string;
  /** When set, renders a "See all" link to this href. Omit to hide it (matches
   *  the West End / Off-Broadway inline shelves, which have no See-all link). */
  viewAllHref?: string;
  /** Optional one-line caption under each card's title, keyed by show id
   *  (the tours hub's "Now in Detroit", BRO-6544). */
  captions?: Record<string, string>;
}) {
  if (shows.length === 0) return null;

  return (
    <section className="mb-4 sm:mb-6">
      <div className={`flex items-center justify-between ${subtitle ? 'mb-1' : 'mb-3'}`}>
        <h2 className="text-base font-bold text-white">{title}</h2>
        {viewAllHref && (
          <Link
            href={viewAllHref}
            prefetch={false}
            className="flex items-center gap-1 text-xs text-gray-400 hover:text-brand transition-colors"
          >
            See all <ChevronRightIcon />
          </Link>
        )}
      </div>
      {subtitle && <p className="text-xs text-fg-muted mb-2">{subtitle}</p>}
      <ScrollRow>
        {shows.map((show, index) => (
          // One high-priority image per page: the LCP poster. Four high
          // ones (plus the list below) split the bandwidth and delayed it.
          <ServerMiniShowCard key={show.id} show={show} priority={index === 0} eager={index < 4} caption={captions?.[show.id]} />
        ))}
      </ScrollRow>
    </section>
  );
}
