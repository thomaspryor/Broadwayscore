'use client';

import { useMemo, memo, useCallback, Suspense } from 'react';
import { useSearchParams, useRouter, usePathname } from 'next/navigation';
import Link from 'next/link';
import { getAllShows, ComputedShow, getDataStats, getUpcomingShows, getAudienceBuzz } from '@/lib/data';
import { getOptimizedImageUrl } from '@/lib/images';
import ShowImage from '@/components/ShowImage';
import ScoreTooltip from '@/components/ScoreTooltip';
import FooterEmailCapture from '@/components/FooterEmailCapture';

// URL parameter values
type StatusParam = 'now_playing' | 'closed' | 'upcoming' | 'closing_soon' | 'all';
type SortParam = 'recent' | 'score_desc' | 'score_asc' | 'alpha' | 'audience_buzz';
type TypeParam = 'all' | 'musical' | 'play';
type ScoreModeParam = 'critics' | 'audience';

// Internal filter values
type StatusFilter = 'all' | 'open' | 'closed' | 'previews' | 'closing_soon';

// Defaults
const DEFAULT_STATUS: StatusParam = 'now_playing';
const DEFAULT_SORT: SortParam = 'recent';
const DEFAULT_TYPE: TypeParam = 'all';
const DEFAULT_SCORE_MODE: ScoreModeParam = 'critics';

// Map URL params to internal values
const statusParamToFilter: Record<StatusParam, StatusFilter> = {
  now_playing: 'open',
  closed: 'closed',
  upcoming: 'previews',
  closing_soon: 'closing_soon',
  all: 'all',
};

// Score tier labels and tooltips
const SCORE_TIERS = {
  mustSee: {
    label: 'Must-See',
    tooltip: 'Drop-everything great. If you\'re seeing one show, make it this.',
    range: '85-100',
    color: '#FFD700',
    glow: true,
  },
  recommended: {
    label: 'Recommended',
    tooltip: 'Strong choice—most people will have a great time.',
    range: '75-84',
    color: '#22c55e',
    glow: false,
  },
  worthSeeing: {
    label: 'Worth Seeing',
    tooltip: 'Good, with caveats. Best if the premise/cast/genre is your thing.',
    range: '65-74',
    color: '#14b8a6',
    glow: false,
  },
  skippable: {
    label: 'Skippable',
    tooltip: 'Optional. Fine to miss unless you\'re a completist or super fan.',
    range: '55-64',
    color: '#f59e0b',
    glow: false,
  },
  stayAway: {
    label: 'Stay Away',
    tooltip: 'Not recommended—save your time and money.',
    range: '<55',
    color: '#ef4444',
    glow: false,
  },
};

function getScoreTier(score: number | null | undefined) {
  if (score === null || score === undefined) return null;
  const rounded = Math.round(score);
  if (rounded >= 85) return SCORE_TIERS.mustSee;
  if (rounded >= 75) return SCORE_TIERS.recommended;
  if (rounded >= 65) return SCORE_TIERS.worthSeeing;
  if (rounded >= 55) return SCORE_TIERS.skippable;
  return SCORE_TIERS.stayAway;
}

interface ScoreBadgeProps {
  score?: number | null;
  size?: 'sm' | 'md' | 'lg';
  reviewCount?: number;
  status?: string;
  // Tooltip props (optional)
  tier1Count?: number;
  tier2Count?: number;
  tier3Count?: number;
  showTooltip?: boolean;
}

function ScoreBadge({ score, size = 'md', reviewCount, status, tier1Count, tier2Count, tier3Count, showTooltip = false }: ScoreBadgeProps) {
  const sizeClass = {
    sm: 'w-11 h-11 text-lg rounded-lg',
    md: 'w-14 h-14 text-2xl rounded-xl',
    lg: 'w-16 h-16 sm:w-20 sm:h-20 text-3xl rounded-xl',
  }[size];

  // Show TBD for previews shows
  if (status === 'previews') {
    return (
      <div className={`score-badge ${sizeClass} score-none font-bold text-gray-400`}>
        TBD
      </div>
    );
  }

  // Show TBD if fewer than 5 reviews
  if (reviewCount !== undefined && reviewCount < 5) {
    return (
      <div className={`score-badge ${sizeClass} score-none font-bold text-gray-400`}>
        TBD
      </div>
    );
  }

  if (score === undefined || score === null) {
    return (
      <div className={`score-badge ${sizeClass} score-none font-bold`}>
        —
      </div>
    );
  }

  const roundedScore = Math.round(score);
  let colorClass: string;
  let label: string;

  if (roundedScore >= 85) {
    colorClass = 'score-must-see';
    label = 'Must-See';
  } else if (roundedScore >= 75) {
    colorClass = 'score-great';
    label = 'Recommended';
  } else if (roundedScore >= 65) {
    colorClass = 'score-good';
    label = 'Worth Seeing';
  } else if (roundedScore >= 55) {
    colorClass = 'score-tepid';
    label = 'Mixed';
  } else {
    colorClass = 'score-skip';
    label = 'Skip';
  }

  const badge = (
    <div className={`score-badge ${sizeClass} ${colorClass} font-bold`}>
      {roundedScore}
    </div>
  );

  // Wrap with tooltip if enabled and we have the necessary data
  if (showTooltip && reviewCount !== undefined && tier1Count !== undefined) {
    return (
      <ScoreTooltip
        score={roundedScore}
        label={label}
        tier1Count={tier1Count}
        tier2Count={tier2Count || 0}
        tier3Count={tier3Count || 0}
        totalReviews={reviewCount}
        size="sm"
      >
        {badge}
      </ScoreTooltip>
    );
  }

  return badge;
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

// Use UTC-based formatting to avoid timezone-related hydration mismatch
function formatOpeningDate(dateStr: string): string {
  const date = new Date(dateStr);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

function SearchIcon() {
  return (
    <svg className="w-5 h-5 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
    </svg>
  );
}

function ChevronRightIcon() {
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
    </svg>
  );
}

const ShowCard = memo(function ShowCard({ show, index, hideStatus, scoreMode }: { show: ComputedShow; index: number; hideStatus: boolean; scoreMode: ScoreModeParam }) {
  const isRevival = show.type === 'revival';

  // Get the appropriate score based on mode
  let score: number | null | undefined;
  let label: string | undefined;
  let tier: typeof SCORE_TIERS.mustSee | null = null;
  let audienceIcon: string | null = null;

  if (scoreMode === 'audience') {
    const audienceBuzz = getAudienceBuzz(show.id);
    if (audienceBuzz) {
      score = audienceBuzz.combinedScore;  // Used for sorting only, never displayed
      label = audienceBuzz.designation;
      // Map audience designation to colors and emojis
      if (audienceBuzz.designation === 'Loving') {
        tier = { label: 'Loving', color: '#22c55e', tooltip: 'Audiences love it', range: '', glow: false };
        audienceIcon = '🔥';
      } else if (audienceBuzz.designation === 'Liking') {
        tier = { label: 'Liking', color: '#14b8a6', tooltip: 'Audiences like it', range: '', glow: false };
        audienceIcon = '👍';
      } else if (audienceBuzz.designation === 'Shrugging') {
        tier = { label: 'Shrugging', color: '#f59e0b', tooltip: 'Mixed audience reaction', range: '', glow: false };
        audienceIcon = '🤷';
      } else if (audienceBuzz.designation === 'Loathing') {
        tier = { label: 'Loathing', color: '#ef4444', tooltip: 'Audiences dislike it', range: '', glow: false };
        audienceIcon = '💩';
      }
    }
  } else {
    score = show.criticScore?.score;
    tier = getScoreTier(score);
  }

  return (
    <Link
      href={`/show/${show.slug}`}
      role="listitem"
      className="group card-interactive flex gap-4 p-4 animate-in focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
      style={{ animationDelay: `${index * 30}ms` }}
    >
      {/* Thumbnail - larger square image */}
      <div className="flex-shrink-0 w-24 h-24 sm:w-28 sm:h-28 rounded-lg overflow-hidden bg-surface-overlay">
        <ShowImage
          sources={[
            show.images?.thumbnail ? getOptimizedImageUrl(show.images.thumbnail, 'thumbnail') : null,
          ]}
          alt={`${show.title} Broadway ${show.type}`}
          priority={index < 4}
          loading={index < 4 ? "eager" : "lazy"}
          width={112}
          height={112}
          decoding="async"
          className="w-full h-full object-contain group-hover:scale-105 transition-transform duration-300 will-change-transform"
          fallback={
            <div className="w-full h-full flex flex-col items-center justify-center text-gray-600 px-2" aria-hidden="true">
              <div className="text-2xl mb-0.5">🎭</div>
              {show.status === 'previews' && (
                <div className="text-[9px] text-gray-500 text-center font-medium leading-tight">Images<br/>soon</div>
              )}
            </div>
          }
        />
      </div>

      {/* Info */}
      <div className="flex-1 min-w-0">
        <h3 className="font-bold text-white text-lg group-hover:text-brand transition-colors truncate">
          {show.title}
        </h3>
        <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
          <FormatPill type={show.type} />
          <ProductionPill isRevival={isRevival} />
          {!hideStatus && <StatusBadge status={show.status} />}
        </div>
        <p className="text-sm text-gray-400 mt-2.5 truncate">
          {show.status === 'previews' ? (
            <>Opens {formatOpeningDate(show.openingDate)}</>
          ) : show.closingDate ? (
            <>
              <span className="text-amber-400">{show.status === 'closed' ? 'Closed' : 'Closes'} {formatOpeningDate(show.closingDate)}</span>
              <span className="text-gray-500"> • Opened {formatOpeningDate(show.openingDate)}</span>
            </>
          ) : (
            <>Opened {formatOpeningDate(show.openingDate)}</>
          )}
        </p>
      </div>

      {/* Score Badge */}
      <div className="flex-shrink-0 flex flex-col items-center gap-1.5 w-20 sm:w-24">
        {scoreMode === 'audience' ? (
          // Audience mode: Show designation badge with emoji (no numeric score)
          tier && audienceIcon && (
            <div className="flex flex-col items-center gap-1.5 w-full">
              <div
                className="text-5xl sm:text-6xl leading-none flex items-center justify-center"
                aria-hidden="true"
              >
                {audienceIcon}
              </div>
              <span
                className="text-[10px] sm:text-[11px] font-extrabold uppercase tracking-wider whitespace-nowrap px-2.5 py-1 rounded-md text-center w-full"
                style={{
                  color: tier.color,
                  backgroundColor: `${tier.color}20`,
                }}
                title={tier.tooltip}
              >
                {tier.label}
              </span>
            </div>
          )
        ) : (
          // Critics mode: Show tier label + numeric score badge
          <>
            {tier && (
              <span
                className="text-[9px] font-semibold uppercase tracking-wide whitespace-nowrap"
                style={{ color: tier.color }}
                title={tier.tooltip}
              >
                {tier.label}
              </span>
            )}
            <ScoreBadge
              score={score}
              size="lg"
              reviewCount={show.criticScore?.reviewCount}
              status={show.status}
              tier1Count={show.criticScore?.tier1Count}
              tier2Count={show.criticScore?.tier2Count}
              tier3Count={show.criticScore?.tier3Count}
              showTooltip={true}
            />
          </>
        )}
      </div>
    </Link>
  );
});

// Compact card for featured rows
// NOTE: Poster images use 2:3 aspect ratio (standard Broadway poster format, e.g., 480x720)
// Always preserve original aspect ratio - never crop show artwork
const MiniShowCard = memo(function MiniShowCard({ show, priority = false }: { show: ComputedShow; priority?: boolean }) {
  const score = show.criticScore?.score;

  return (
    <Link
      href={`/show/${show.slug}`}
      className="flex-shrink-0 w-28 sm:w-32 group"
    >
      {/* Poster container - 2:3 aspect ratio matches standard Broadway poster dimensions */}
      <div className="relative rounded-lg overflow-hidden bg-surface-overlay aspect-[2/3] mb-1.5">
        <ShowImage
          sources={[
            show.images?.poster ? getOptimizedImageUrl(show.images.poster, 'card') : null,
            show.images?.thumbnail ? getOptimizedImageUrl(show.images.thumbnail, 'card') : null,
          ]}
          alt={`${show.title} Broadway ${show.type}`}
          priority={priority}
          loading={priority ? "eager" : "lazy"}
          className="w-full h-full object-contain group-hover:scale-105 transition-transform duration-300"
          fallback={
            <div className="w-full h-full flex flex-col items-center justify-center text-gray-600 px-2" aria-hidden="true">
              <div className="text-2xl mb-1">🎭</div>
              {show.status === 'previews' && (
                <div className="text-[10px] text-gray-500 text-center font-medium">Images<br/>coming soon</div>
              )}
            </div>
          }
        />
        {/* Score overlay */}
        <div className="absolute bottom-1.5 right-1.5">
          <div className={`w-9 h-9 rounded-lg flex items-center justify-center text-sm font-bold ${
            score === undefined || score === null ? 'bg-surface-overlay text-gray-400' :
            score >= 85 ? 'score-must-see' :
            score >= 75 ? 'score-great' :
            score >= 65 ? 'score-good' :
            score >= 55 ? 'score-tepid' :
            'score-skip'
          }`}>
            {score !== undefined && score !== null ? Math.round(score) : '—'}
          </div>
        </div>
      </div>
      <h3 className="font-semibold text-white text-sm group-hover:text-brand transition-colors line-clamp-2 leading-tight">
        {show.title}
      </h3>
    </Link>
  );
});

// Featured row with horizontal scroll
function FeaturedRow({ title, shows, viewAllHref }: { title: string; shows: ComputedShow[]; viewAllHref?: string }) {
  if (shows.length === 0) return null;

  return (
    <section className="mb-6">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-base font-bold text-white">{title}</h2>
        {viewAllHref && (
          <Link
            href={viewAllHref}
            className="flex items-center gap-1 text-xs text-gray-400 hover:text-brand transition-colors"
          >
            See all <ChevronRightIcon />
          </Link>
        )}
      </div>
      <div className="flex gap-3 overflow-x-auto pb-3 -mx-4 px-4 sm:mx-0 sm:px-0 scrollbar-hide">
        {shows.map((show, index) => (
          <MiniShowCard key={show.id} show={show} priority={index < 4} />
        ))}
      </div>
    </section>
  );
}

// Inner component that uses searchParams
function HomePageInner() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  // Parse URL params with defaults
  const statusParam = (searchParams.get('status') as StatusParam) || DEFAULT_STATUS;
  const sortParam = (searchParams.get('sort') as SortParam) || DEFAULT_SORT;
  const typeParam = (searchParams.get('type') as TypeParam) || DEFAULT_TYPE;
  const scoreModeParam = (searchParams.get('scoreMode') as ScoreModeParam) || DEFAULT_SCORE_MODE;
  const searchQuery = searchParams.get('q') || '';

  // Validate params (use default if invalid)
  const status: StatusParam = ['now_playing', 'closed', 'upcoming', 'all'].includes(statusParam) ? statusParam : DEFAULT_STATUS;
  const sort: SortParam = ['recent', 'score_desc', 'score_asc', 'alpha', 'closing_soon', 'audience_buzz'].includes(sortParam) ? sortParam : DEFAULT_SORT;
  const type: TypeParam = ['all', 'musical', 'play'].includes(typeParam) ? typeParam : DEFAULT_TYPE;
  const scoreMode: ScoreModeParam = ['critics', 'audience'].includes(scoreModeParam) ? scoreModeParam : DEFAULT_SCORE_MODE;

  // Internal status filter value
  const statusFilter = statusParamToFilter[status];

  // Update URL helper
  const updateParams = useCallback((updates: Record<string, string | null>) => {
    const params = new URLSearchParams(searchParams.toString());

    for (const [key, value] of Object.entries(updates)) {
      if (value === null) {
        params.delete(key);
      } else {
        // Don't include default values in URL
        const isDefault =
          (key === 'status' && value === DEFAULT_STATUS) ||
          (key === 'sort' && value === DEFAULT_SORT) ||
          (key === 'type' && value === DEFAULT_TYPE) ||
          (key === 'scoreMode' && value === DEFAULT_SCORE_MODE) ||
          (key === 'q' && value === '');

        if (isDefault) {
          params.delete(key);
        } else {
          params.set(key, value);
        }
      }
    }

    const paramString = params.toString();
    router.push(paramString ? `${pathname}?${paramString}` : pathname, { scroll: false });
  }, [searchParams, pathname, router]);

  // Clear all filters
  const clearAllFilters = useCallback(() => {
    router.push(pathname, { scroll: false });
  }, [pathname, router]);

  const shows = useMemo(() => getAllShows(), []);

  // Featured rows data - only shows opened in last 12 months
  const twelveMonthsAgo = useMemo(() => {
    const date = new Date();
    date.setMonth(date.getMonth() - 12);
    return date;
  }, []);

  const bestNewMusicals = useMemo(() => {
    return shows
      .filter(show => {
        const isMusical = show.type === 'musical' || show.type === 'revival';
        const openDate = new Date(show.openingDate);
        return isMusical && show.status === 'open' && openDate >= twelveMonthsAgo && show.criticScore?.score;
      })
      .sort((a, b) => (b.criticScore?.score || 0) - (a.criticScore?.score || 0));
  }, [shows, twelveMonthsAgo]);

  const bestNewPlays = useMemo(() => {
    return shows
      .filter(show => {
        const openDate = new Date(show.openingDate);
        return show.type === 'play' && show.status === 'open' && openDate >= twelveMonthsAgo && show.criticScore?.score;
      })
      .sort((a, b) => (b.criticScore?.score || 0) - (a.criticScore?.score || 0));
  }, [shows, twelveMonthsAgo]);

  const upcomingShows = useMemo(() => getUpcomingShows(), []);

  // Tony Winners - shows tagged as tony-winner
  const tonyWinners = useMemo(() => {
    return shows
      .filter(show => {
        if (show.status !== 'open') return false;
        const tags = show.tags?.map(t => t.toLowerCase()) || [];
        return tags.includes('tony-winner');
      })
      .sort((a, b) => (b.criticScore?.score || 0) - (a.criticScore?.score || 0));
  }, [shows]);

  // Date Night - romantic or drama shows (not family-oriented)
  const dateNightShows = useMemo(() => {
    return shows
      .filter(show => {
        if (show.status !== 'open') return false;
        const tags = show.tags?.map(t => t.toLowerCase()) || [];
        const ageRec = show.ageRecommendation?.toLowerCase() || '';
        return (tags.includes('romantic') || tags.includes('drama')) &&
               !ageRec.includes('ages 6') &&
               !ageRec.includes('ages 8');
      })
      .sort((a, b) => (b.criticScore?.score || 0) - (a.criticScore?.score || 0));
  }, [shows]);

  // Shows for Kids - family-friendly shows
  const kidsShows = useMemo(() => {
    return shows
      .filter(show => {
        if (show.status !== 'open') return false;
        const tags = show.tags?.map(t => t.toLowerCase()) || [];
        const ageRec = show.ageRecommendation?.toLowerCase() || '';
        return tags.includes('family') ||
               tags.includes('accessible') ||
               ageRec.includes('ages 6') ||
               ageRec.includes('ages 8') ||
               ageRec.includes('all ages');
      })
      .sort((a, b) => (b.criticScore?.score || 0) - (a.criticScore?.score || 0));
  }, [shows]);

  // Closing Soon - shows with closing dates within 60 days
  const closingSoonShows = useMemo(() => {
    const now = new Date();
    return shows
      .filter(show => {
        if (show.status !== 'open' || !show.closingDate) return false;
        const closing = new Date(show.closingDate);
        const diffDays = Math.ceil((closing.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
        return diffDays > 0 && diffDays <= 60;
      })
      .sort((a, b) => new Date(a.closingDate!).getTime() - new Date(b.closingDate!).getTime());
  }, [shows]);

  // Jukebox Musicals
  const jukeboxMusicals = useMemo(() => {
    return shows
      .filter(show => {
        if (show.status !== 'open') return false;
        const tags = show.tags?.map(t => t.toLowerCase()) || [];
        return tags.includes('jukebox');
      })
      .sort((a, b) => (b.criticScore?.score || 0) - (a.criticScore?.score || 0));
  }, [shows]);

  const filteredAndSortedShows = useMemo(() => {
    // When searching, include ALL shows (ignore status/type filters)
    // This ensures users can find any show in the database
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      let result = shows.filter(show =>
        show.title.toLowerCase().includes(query) ||
        show.venue.toLowerCase().includes(query)
      );
      // Sort search results by relevance (title match first, then by score)
      result.sort((a, b) => {
        const aTitle = a.title.toLowerCase();
        const bTitle = b.title.toLowerCase();
        const aStartsWith = aTitle.startsWith(query);
        const bStartsWith = bTitle.startsWith(query);
        if (aStartsWith && !bStartsWith) return -1;
        if (!aStartsWith && bStartsWith) return 1;
        return (b.criticScore?.score ?? 0) - (a.criticScore?.score ?? 0);
      });
      return result;
    }

    // Non-search filtering: apply score mode, status, and type filters
    let result = shows.filter(show => {
      if (scoreMode === 'audience') {
        // Only show shows with audience buzz data
        const buzz = getAudienceBuzz(show.id);
        return buzz !== null;
      } else {
        // Only show shows with at least 5 critic reviews (hides TBD shows)
        return show.criticScore && show.criticScore.reviewCount >= 5;
      }
    });

    // Status filter
    if (statusFilter === 'closing_soon') {
      // Filter for shows closing within 90 days
      const now = new Date();
      const ninetyDaysFromNow = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);
      result = result.filter(show => {
        if (show.status !== 'open' || !show.closingDate) return false;
        const closing = new Date(show.closingDate);
        return closing > now && closing <= ninetyDaysFromNow;
      });
    } else if (statusFilter !== 'all') {
      result = result.filter(show => show.status === statusFilter);
    }

    // Type filter
    if (type !== 'all') {
      result = result.filter(show => {
        const isMusical = show.type === 'musical' || show.type === 'revival';
        return type === 'musical' ? isMusical : !isMusical;
      });
    }

    // Sort - when filtering by closing_soon, default to sorting by closing date
    if (statusFilter === 'closing_soon') {
      result.sort((a, b) => {
        const aClose = a.closingDate ? new Date(a.closingDate).getTime() : Infinity;
        const bClose = b.closingDate ? new Date(b.closingDate).getTime() : Infinity;
        return aClose - bClose;
      });
    } else {
      result.sort((a, b) => {
        switch (sort) {
          case 'score_desc': {
            if (scoreMode === 'audience') {
              const aBuzz = getAudienceBuzz(a.id);
              const bBuzz = getAudienceBuzz(b.id);
              return (bBuzz?.combinedScore ?? -1) - (aBuzz?.combinedScore ?? -1);
            }
            return (b.criticScore?.score ?? -1) - (a.criticScore?.score ?? -1);
          }
          case 'score_asc': {
            if (scoreMode === 'audience') {
              const aBuzz = getAudienceBuzz(a.id);
              const bBuzz = getAudienceBuzz(b.id);
              return (aBuzz?.combinedScore ?? -1) - (bBuzz?.combinedScore ?? -1);
            }
            return (a.criticScore?.score ?? -1) - (b.criticScore?.score ?? -1);
          }
          case 'audience_buzz': {
            // Sort by audience buzz combined score (highest first)
            // NOTE: Numeric scores are used ONLY for sorting, never displayed to users
            const aBuzz = getAudienceBuzz(a.id);
            const bBuzz = getAudienceBuzz(b.id);
            const aScore = aBuzz?.combinedScore ?? -1;
            const bScore = bBuzz?.combinedScore ?? -1;
            return bScore - aScore;
          }
          case 'alpha':
            return a.title.toLowerCase().localeCompare(b.title.toLowerCase());
          case 'recent':
          default:
            // Most recent opening date first
            return new Date(b.openingDate).getTime() - new Date(a.openingDate).getTime();
        }
      });
    }

    return result;
  }, [shows, statusFilter, type, searchQuery, sort, scoreMode]);

  // Hide status chip when it would be redundant
  const shouldHideStatus = statusFilter !== 'all';

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
      {/* Hero - Large heading on desktop only */}
      <div className="mb-6 sm:mb-8">
        <h1 className="hidden sm:block text-5xl lg:text-6xl font-extrabold text-white mb-3 tracking-tight">
          Broadway<span className="text-gradient">Scorecard</span>
        </h1>
        <p className="text-gray-400 text-base sm:text-lg">
          Every show. Every review. One score.
        </p>
      </div>

      {/* Search */}
      <div id="search" className="relative mb-6 scroll-mt-24" role="search">
        <label htmlFor="show-search" className="sr-only">Search Broadway shows</label>
        <div className="absolute inset-y-0 left-4 flex items-center pointer-events-none">
          <SearchIcon />
        </div>
        <input
          id="show-search"
          type="search"
          placeholder="Search shows..."
          value={searchQuery}
          onChange={(e) => updateParams({ q: e.target.value })}
          className="search-input pl-12 focus-visible:outline-none"
          autoComplete="off"
        />
      </div>

      {/* Type Pills & Score Mode Toggle Row */}
      <div className="flex items-center justify-between gap-4 mb-4">
        {/* Type Filter Pills (Left) */}
        <div className="flex items-center gap-2" role="group" aria-label="Filter by type">
          {(['all', 'musical', 'play'] as const).map((t) => (
            <button
              key={t}
              onClick={() => updateParams({ type: t })}
              aria-pressed={type === t}
              className={`px-4 py-2.5 sm:py-2 rounded-full text-sm font-semibold transition-all min-h-[44px] sm:min-h-0 ${
                type === t
                  ? 'bg-brand text-gray-900 shadow-glow-sm'
                  : 'bg-surface-raised text-gray-400 border border-white/10 hover:text-white hover:border-white/20'
              }`}
            >
              {t === 'all' ? 'All' : t === 'musical' ? 'Musicals' : 'Plays'}
            </button>
          ))}
        </div>

        {/* Score Mode Toggle (Right) - Segmented Control Style */}
        <div className="flex items-center gap-0 bg-surface-overlay rounded-lg p-0.5 border border-white/10" role="group" aria-label="Score mode">
          {(['critics', 'audience'] as const).map((mode) => (
            <button
              key={mode}
              onClick={() => {
                // When switching to audience mode, auto-set sort to highest
                if (mode === 'audience') {
                  updateParams({ scoreMode: mode, sort: 'score_desc' });
                } else {
                  updateParams({ scoreMode: mode });
                }
              }}
              aria-pressed={scoreMode === mode}
              className={`px-3 py-1.5 sm:px-4 sm:py-2 rounded-md text-[11px] sm:text-xs font-bold uppercase tracking-wider transition-all min-h-[44px] sm:min-h-0 ${
                scoreMode === mode
                  ? 'bg-white/10 text-white shadow-sm'
                  : 'text-gray-500 hover:text-gray-300'
              }`}
            >
              {mode === 'critics' ? 'Critics' : 'Audience'}
            </button>
          ))}
        </div>
      </div>

      {/* Status & Sort Filters */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-6 text-sm">
        <div className="flex items-center gap-1 sm:gap-2 flex-wrap" role="group" aria-label="Filter by status">
          <span className="text-[11px] font-medium uppercase tracking-wider text-gray-400 mr-1">STATUS:</span>
          {(['now_playing', 'closing_soon', 'all', 'closed'] as const).map((s) => (
            <button
              key={s}
              onClick={() => updateParams({ status: s })}
              aria-pressed={status === s}
              className={`px-2.5 py-2 sm:px-2 sm:py-1 rounded transition-colors text-[11px] font-medium uppercase tracking-wider min-h-[44px] sm:min-h-0 ${
                status === s ? 'text-brand bg-brand/10 sm:bg-transparent' : 'text-gray-300 hover:text-white'
              }`}
            >
              {s === 'all' ? 'ALL' : s === 'now_playing' ? 'PLAYING' : s === 'closing_soon' ? 'CLOSING' : 'CLOSED'}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-1 sm:gap-2 flex-wrap" role="group" aria-label="Sort shows">
          <span className="text-[11px] font-medium uppercase tracking-wider text-gray-400 mr-1">SORT:</span>
          {(['recent', 'score_desc', 'audience_buzz', 'alpha'] as const).map((s) => (
            <button
              key={s}
              onClick={() => updateParams({ sort: s })}
              aria-pressed={sort === s}
              className={`px-2.5 py-2 sm:px-2 sm:py-1 rounded text-[11px] font-medium uppercase tracking-wider transition-colors min-h-[44px] sm:min-h-0 ${
                sort === s ? 'text-brand bg-brand/10 sm:bg-transparent' : 'text-gray-300 hover:text-white'
              }`}
            >
              {s === 'recent' ? 'NEWEST' : s === 'score_desc' ? 'HIGHEST' : s === 'audience_buzz' ? 'BUZZ' : 'A-Z'}
            </button>
          ))}
        </div>
      </div>

      {/* Show List */}
      <h2 className="sr-only">Broadway Shows</h2>
      <div className="space-y-3" role="list" aria-label="Broadway shows">
        {filteredAndSortedShows.map((show, index) => (
          <ShowCard key={show.id} show={show} index={index} hideStatus={shouldHideStatus} scoreMode={scoreMode} />
        ))}
      </div>

      {filteredAndSortedShows.length === 0 && (
        <div className="card text-center py-16 px-6" role="status" aria-live="polite">
          <div className="w-16 h-16 rounded-full bg-surface-overlay mx-auto mb-4 flex items-center justify-center">
            <svg className="w-8 h-8 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
          </div>
          <h3 className="text-lg font-semibold text-white mb-2">No shows found</h3>
          <p className="text-gray-400 mb-6 max-w-sm mx-auto">
            {searchQuery
              ? `No shows match "${searchQuery}". Try adjusting your search or filters.`
              : 'No shows match your current filters.'}
          </p>
          <button
            onClick={clearAllFilters}
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-pill bg-brand/10 text-brand hover:bg-brand/20 transition-colors text-sm font-semibold"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            Reset filters
          </button>
        </div>
      )}

      <div className="mt-8 flex items-baseline justify-between text-sm text-gray-400">
        <span>{filteredAndSortedShows.length} shows</span>
        <Link href="/methodology" className="text-brand hover:text-brand-hover transition-colors">
          How scores work →
        </Link>
      </div>

      {/* Score Legend */}
      <div className="flex flex-wrap items-center justify-center gap-4 mt-8 mb-4 text-xs text-gray-400">
        <div className="flex items-center gap-1.5 cursor-help" title={SCORE_TIERS.mustSee.tooltip}>
          <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: SCORE_TIERS.mustSee.color, boxShadow: '0 0 6px rgba(255, 215, 0, 0.5)' }}></div>
          <span>{SCORE_TIERS.mustSee.range} {SCORE_TIERS.mustSee.label}</span>
        </div>
        <div className="flex items-center gap-1.5 cursor-help" title={SCORE_TIERS.recommended.tooltip}>
          <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: SCORE_TIERS.recommended.color }}></div>
          <span>{SCORE_TIERS.recommended.range} {SCORE_TIERS.recommended.label}</span>
        </div>
        <div className="flex items-center gap-1.5 cursor-help" title={SCORE_TIERS.worthSeeing.tooltip}>
          <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: SCORE_TIERS.worthSeeing.color }}></div>
          <span>{SCORE_TIERS.worthSeeing.range} {SCORE_TIERS.worthSeeing.label}</span>
        </div>
        <div className="flex items-center gap-1.5 cursor-help" title={SCORE_TIERS.skippable.tooltip}>
          <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: SCORE_TIERS.skippable.color }}></div>
          <span>{SCORE_TIERS.skippable.range} {SCORE_TIERS.skippable.label}</span>
        </div>
        <div className="flex items-center gap-1.5 cursor-help" title={SCORE_TIERS.stayAway.tooltip}>
          <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: SCORE_TIERS.stayAway.color }}></div>
          <span>{SCORE_TIERS.stayAway.range} {SCORE_TIERS.stayAway.label}</span>
        </div>
      </div>

      {/* Email Capture */}
      <div id="subscribe" className="mt-8 max-w-md mx-auto">
        <FooterEmailCapture />
      </div>

      {/* Featured Rows */}
      <div className="mt-8 pt-8 border-t border-white/5">
        <FeaturedRow
          title="Best Recent Musicals"
          shows={bestNewMusicals}
          viewAllHref="/browse/best-recent-musicals"
        />
        <FeaturedRow
          title="Best Recent Plays"
          shows={bestNewPlays}
          viewAllHref="/browse/best-recent-plays"
        />
        <FeaturedRow
          title="Upcoming"
          shows={upcomingShows}
          viewAllHref="/browse/upcoming-broadway-shows"
        />
        <FeaturedRow
          title="Tony Winners"
          shows={tonyWinners}
          viewAllHref="/browse/tony-winners-on-broadway"
        />
        <FeaturedRow
          title="Perfect for Date Night"
          shows={dateNightShows}
          viewAllHref="/browse/broadway-shows-for-date-night"
        />
        <FeaturedRow
          title="Great for Kids"
          shows={kidsShows}
          viewAllHref="/browse/broadway-shows-for-kids"
        />
        <FeaturedRow
          title="Closing Soon"
          shows={closingSoonShows}
          viewAllHref="/browse/broadway-shows-closing-soon"
        />
        <FeaturedRow
          title="Jukebox Musicals"
          shows={jukeboxMusicals}
          viewAllHref="/browse/jukebox-musicals-on-broadway"
        />
      </div>

      {/* Total Review Count */}
      <div className="mt-2 text-center">
        <p className="text-gray-500 text-xs">
          Aggregating <span className="text-gray-400 font-medium">{getDataStats().totalReviews.toLocaleString()}</span> reviews
        </p>
      </div>
    </div>
  );
}

// Main export with Suspense boundary for useSearchParams
export default function HomePage() {
  return (
    <Suspense fallback={
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
        <div className="mb-8 sm:mb-10">
          <div className="text-4xl sm:text-6xl font-extrabold text-white mb-3 tracking-tight" aria-hidden="true">
            Broadway<span className="text-gradient">Scorecard</span>
          </div>
          <p className="text-gray-400 text-lg sm:text-xl">
            Every show. Every review. One score.
          </p>
        </div>
        <div className="animate-pulse space-y-4">
          <div className="h-12 bg-surface-overlay rounded-xl"></div>
          <div className="h-8 bg-surface-overlay rounded w-3/4"></div>
          <div className="space-y-3">
            {[1, 2, 3].map(i => (
              <div key={i} className="h-24 bg-surface-overlay rounded-xl"></div>
            ))}
          </div>
        </div>
      </div>
    }>
      <HomePageInner />
    </Suspense>
  );
}
