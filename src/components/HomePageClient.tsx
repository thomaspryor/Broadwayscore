'use client';

import { useMemo, useCallback, useState, startTransition, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import Fuse from 'fuse.js';
import FooterEmailCapture from '@/components/FooterEmailCapture';
import { SCORE_TIERS, ToggleBar, ScoreToggle, ShowListCard, MiniShowCard } from '@/components/show-cards';
import type { ScoreModeParam } from '@/components/show-cards';
import { hasEnoughReviews } from '@/config/score-buckets';

// Serialized show data passed from server component
export interface HomepageShow {
  id: string;
  slug: string;
  title: string;
  venue: string;
  openingDate: string;
  closingDate?: string;
  status: string;
  type: string;
  isRevival?: boolean;
  tags?: string[];
  ageRecommendation?: string;
  creativeTeam?: Array<{ name: string; role: string }>;
  reviewYearNote?: string;
  images?: { thumbnail?: string; poster?: string; hero?: string };
  criticScore?: { score?: number; reviewCount?: number; tier1Count?: number; tier2Count?: number };
  // Pre-computed server-side (avoids importing data-audience.ts on client)
  audienceCombinedScore: number | null;
  audienceGrade: { grade: string; label: string; color: string; textColor: string; tooltip: string } | null;
  category?: string;
}

interface HomePageClientProps {
  shows: HomepageShow[];
  upcomingShows: HomepageShow[];
  offBroadwayShows?: HomepageShow[];
  westEndShows?: HomepageShow[];
  totalShows: number;
  totalReviews: number;
  skipHero?: boolean;
  skipFirstMusicals?: boolean;
}

// URL parameter values
type StatusParam = 'now_playing' | 'closed' | 'upcoming' | 'closing_soon' | 'all';
type SortParam = 'recent' | 'score_desc' | 'score_asc' | 'alpha' | 'audience_buzz';
type TypeParam = 'all' | 'musical' | 'play';
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

function ShowCardList({ shows, hideStatus, scoreMode }: { shows: HomepageShow[]; hideStatus: boolean; scoreMode: ScoreModeParam }) {
  return (
    <div className="space-y-3" role="list" aria-label="Broadway shows">
      {shows.map((show, index) => (
        <ShowListCard key={show.id} show={show} index={index} hideStatus={hideStatus} scoreMode={scoreMode} showCategoryBadge />
      ))}
    </div>
  );
}

// Featured row with horizontal scroll
function FeaturedRow({ title, shows, viewAllHref }: { title: string; shows: HomepageShow[]; viewAllHref?: string }) {
  if (shows.length <= 3) return null;

  return (
    <section className="mb-6">
      <div className="flex items-center justify-between mb-3">
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
      <div className="flex gap-3 overflow-x-auto pb-3 -mx-4 px-4 sm:mx-0 sm:px-0 scrollbar-hide">
        {shows.map((show, index) => (
          <MiniShowCard key={show.id} show={show} />
        ))}
      </div>
    </section>
  );
}

// Inner component that uses searchParams
function HomePageInner({ shows, upcomingShows, offBroadwayShows = [], westEndShows = [], totalShows, totalReviews, skipHero, skipFirstMusicals }: HomePageClientProps) {
  const initialSearchParams = useSearchParams();

  // Local state for instant updates (no full-page reload)
  const [filters, setFilters] = useState(() => ({
    status: (['now_playing', 'closed', 'upcoming', 'closing_soon', 'all'].includes(initialSearchParams.get('status') as string)
      ? initialSearchParams.get('status') as StatusParam : DEFAULT_STATUS),
    sort: (['recent', 'score_desc', 'score_asc', 'alpha', 'audience_buzz'].includes(initialSearchParams.get('sort') as string)
      ? initialSearchParams.get('sort') as SortParam : DEFAULT_SORT),
    type: (['all', 'musical', 'play'].includes(initialSearchParams.get('type') as string)
      ? initialSearchParams.get('type') as TypeParam : DEFAULT_TYPE),
    scoreMode: (['critics', 'audience'].includes(initialSearchParams.get('scoreMode') as string)
      ? initialSearchParams.get('scoreMode') as ScoreModeParam : DEFAULT_SCORE_MODE),
    q: initialSearchParams.get('q') || '',
  }));

  // Off-Broadway toggle (URL-synced)
  const [includeOB, setIncludeOB] = useState(() => initialSearchParams.get('offBway') === 'true');

  const toggleOB = useCallback(() => {
    setIncludeOB(prev => {
      const next = !prev;
      const urlParams = new URLSearchParams(window.location.search);
      if (next) urlParams.set('offBway', 'true');
      else urlParams.delete('offBway');
      const paramString = urlParams.toString();
      window.history.replaceState({}, '', paramString ? `/?${paramString}` : '/');
      return next;
    });
  }, []);

  // When OB toggle is active, show ONLY OB shows (not mixed with Broadway)
  const allShows = useMemo(() => {
    if (includeOB && offBroadwayShows.length > 0) return offBroadwayShows;
    return shows;
  }, [shows, offBroadwayShows, includeOB]);

  // Separate synchronous state for search input to avoid startTransition dropping keystrokes
  const [searchInput, setSearchInput] = useState(() => initialSearchParams.get('q') || '');

  const status = filters.status;
  const sort = filters.sort;
  const type = filters.type;
  const scoreMode = filters.scoreMode;
  const searchQuery = filters.q;

  // Internal status filter value
  const statusFilter = statusParamToFilter[status];

  // Update state + URL without reload
  const updateParams = useCallback((updates: Record<string, string | null>) => {
    startTransition(() => setFilters(prev => {
      const next = { ...prev };
      for (const [key, value] of Object.entries(updates)) {
        if (value === null) {
          (next as Record<string, string>)[key] =
            key === 'status' ? DEFAULT_STATUS :
            key === 'sort' ? DEFAULT_SORT :
            key === 'type' ? DEFAULT_TYPE :
            key === 'scoreMode' ? DEFAULT_SCORE_MODE : '';
        } else {
          (next as Record<string, string>)[key] = value;
        }
      }

      // Sync to URL without triggering navigation
      const urlParams = new URLSearchParams();
      if (next.status !== DEFAULT_STATUS) urlParams.set('status', next.status);
      if (next.sort !== DEFAULT_SORT) urlParams.set('sort', next.sort);
      if (next.type !== DEFAULT_TYPE) urlParams.set('type', next.type);
      if (next.scoreMode !== DEFAULT_SCORE_MODE) urlParams.set('scoreMode', next.scoreMode);
      if (next.q) urlParams.set('q', next.q);

      const paramString = urlParams.toString();
      window.history.replaceState({}, '', paramString ? `/?${paramString}` : '/');

      return next;
    }));
  }, []);

  // Clear all filters
  const clearAllFilters = useCallback(() => {
    setSearchInput('');
    setFilters({
      status: DEFAULT_STATUS,
      sort: DEFAULT_SORT,
      type: DEFAULT_TYPE,
      scoreMode: DEFAULT_SCORE_MODE,
      q: '',
    });
    window.history.replaceState({}, '', '/');
  }, []);

  // Search should span ALL shows (Broadway + OB + West End) regardless of toggle state
  const allShowsForSearch = useMemo(() => {
    const ids = new Set(shows.map(s => s.id));
    const extra = [...offBroadwayShows, ...westEndShows].filter(s => !ids.has(s.id));
    return extra.length > 0 ? [...shows, ...extra] : shows;
  }, [shows, offBroadwayShows, westEndShows]);

  // Fuse.js instance for fuzzy search across title, venue, and creative team
  const fuse = useMemo(() => new Fuse(allShowsForSearch, {
    keys: [
      { name: 'title', weight: 0.6 },
      { name: 'venue', weight: 0.2 },
      { name: 'creativeTeamSearch', weight: 0.2 },
    ],
    threshold: 0.35,
    ignoreLocation: true,
    minMatchCharLength: 2,
    getFn: (obj, path) => {
      const key = Array.isArray(path) ? path[0] : path;
      if (key === 'creativeTeamSearch') {
        return (obj as HomepageShow).creativeTeam?.map(m => m.name).join(', ') || '';
      }
      return Fuse.config.getFn(obj, path);
    },
  }), [allShowsForSearch]);

  // Featured rows data - only shows opened in last 12 months
  const twelveMonthsAgo = useMemo(() => {
    const date = new Date();
    date.setMonth(date.getMonth() - 12);
    return date;
  }, []);

  const bestNewMusicals = useMemo(() => {
    return shows
      .filter(show => {
        const isMusical = show.type === 'musical';
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

  // Tony Winning Shows - shows tagged as tony-winner
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

  // Best Off-Broadway shows (sorted by score)
  const bestOffBroadway = useMemo(() => {
    return offBroadwayShows
      .filter(show => show.criticScore?.score && hasEnoughReviews(show.criticScore.reviewCount ?? 0, show.category, (show.criticScore.tier1Count ?? 0) + (show.criticScore.tier2Count ?? 0)))
      .sort((a, b) => (b.criticScore?.score || 0) - (a.criticScore?.score || 0));
  }, [offBroadwayShows]);

  const filteredAndSortedShows = useMemo(() => {
    // When searching, include ALL shows (ignore status/type filters)
    // This ensures users can find any show in the database
    if (searchQuery) {
      return fuse.search(searchQuery).map(result => result.item);
    }

    // Non-search filtering: apply score mode, status, and type filters
    let result = allShows.filter(show => {
      // Previews shows appear in the Upcoming carousel, not the main grid
      if (show.status === 'previews' || show.status === 'upcoming') return false;
      if (scoreMode === 'audience') {
        // Only show shows with audience buzz data
        return show.audienceCombinedScore !== null;
      } else {
        // Show all open shows (TBD badge for <5 reviews) + scored closed shows
        if (show.status === 'open') return true;
        return show.criticScore && show.criticScore.reviewCount !== undefined && show.criticScore.reviewCount >= 5;
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
        const isMusical = show.type === 'musical';
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
              const aAud = (a.status === 'previews' || a.status === 'upcoming') ? -1 : (a.audienceCombinedScore ?? -1);
              const bAud = (b.status === 'previews' || b.status === 'upcoming') ? -1 : (b.audienceCombinedScore ?? -1);
              return bAud - aAud;
            }
            const aDesc = (a.status === 'previews' || a.status === 'upcoming') ? -1 : (a.criticScore?.score ?? -1);
            const bDesc = (b.status === 'previews' || b.status === 'upcoming') ? -1 : (b.criticScore?.score ?? -1);
            return bDesc - aDesc;
          }
          case 'score_asc': {
            if (scoreMode === 'audience') {
              const aAud = (a.status === 'previews' || a.status === 'upcoming') ? Infinity : (a.audienceCombinedScore ?? Infinity);
              const bAud = (b.status === 'previews' || b.status === 'upcoming') ? Infinity : (b.audienceCombinedScore ?? Infinity);
              return aAud - bAud;
            }
            const aAsc = (a.status === 'previews' || a.status === 'upcoming') ? Infinity : (a.criticScore?.score ?? Infinity);
            const bAsc = (b.status === 'previews' || b.status === 'upcoming') ? Infinity : (b.criticScore?.score ?? Infinity);
            return aAsc - bAsc;
          }
          case 'audience_buzz': {
            // Sort by audience buzz combined score (highest first)
            // NOTE: Numeric scores are used ONLY for sorting, never displayed to users
            const aScore = (a.status === 'previews' || a.status === 'upcoming') ? -1 : (a.audienceCombinedScore ?? -1);
            const bScore = (b.status === 'previews' || b.status === 'upcoming') ? -1 : (b.audienceCombinedScore ?? -1);
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
  }, [allShows, fuse, statusFilter, type, searchQuery, sort, scoreMode]);

  // Hide status chip when it would be redundant
  const shouldHideStatus = statusFilter !== 'all';

  return (
    <div className={`max-w-3xl mx-auto px-4 sm:px-6 ${skipHero ? 'pb-5 sm:pb-12' : 'py-5 sm:py-12'}`}>
      {/* Hero - Large heading visible on desktop, sr-only on mobile (Google still reads it) */}
      {!skipHero && (
        <div className="mb-4 sm:mb-8">
          <h1 className="sr-only sm:not-sr-only sm:text-5xl lg:text-6xl font-extrabold text-white mb-3 tracking-tight">
            Broadway<span className="text-gradient">Scorecard</span><span className="text-xs text-gray-400 font-normal align-super ml-0.5">™</span>
          </h1>
          <p className="text-gray-400 text-lg sm:text-xl">
            Every show. Every review. One score.
          </p>
          <p className="text-gray-500 text-sm sm:text-base mt-1">
            {totalShows.toLocaleString()} shows. {totalReviews.toLocaleString()} critic reviews. And counting.
          </p>
        </div>
      )}

      {/* Best Recent Musicals - Featured Shelf */}
      {!skipFirstMusicals && bestNewMusicals.length > 0 && (
        <section className="mb-4 sm:mb-6">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-base font-bold text-white">Best Recent Musicals</h2>
            <Link
              href="/browse/best-recent-musicals"
              prefetch={false}
              className="flex items-center gap-1 text-xs text-gray-400 hover:text-brand transition-colors"
            >
              See all <ChevronRightIcon />
            </Link>
          </div>
          <div className="flex gap-3 overflow-x-auto pb-3 -mx-4 px-4 sm:mx-0 sm:px-0 scrollbar-hide">
            {bestNewMusicals.map((show, index) => (
              <MiniShowCard key={show.id} show={show} priority={index < 4} />
            ))}
          </div>
        </section>
      )}

      {/* Search */}
      <div id="search" className="relative mb-4 sm:mb-6 scroll-mt-24" role="search">
        <label htmlFor="show-search" className="sr-only">Search Broadway shows</label>
        <div className="absolute inset-y-0 left-4 flex items-center pointer-events-none">
          <SearchIcon />
        </div>
        <input
          id="show-search"
          type="search"
          placeholder="Search shows, venues, directors..."
          value={searchInput}
          onChange={(e) => {
            const val = e.target.value;
            setSearchInput(val);         // sync update — keeps input responsive
            updateParams({ q: val });    // deferred via startTransition — filters catch up
          }}
          className="search-input pl-12 focus-visible:outline-none"
          autoComplete="off"
        />
      </div>

      {/* Type Pills & Score Mode Toggle Row */}
      <div className="flex items-center justify-between gap-2 sm:gap-4 mb-4 flex-wrap">
        {/* Type Filter Pills (Left) */}
        <div className="flex items-center gap-2">
          <ToggleBar
            variant="pill"
            options={[{ value: 'all' as const, label: 'All' }, { value: 'musical' as const, label: 'Musicals' }, { value: 'play' as const, label: 'Plays' }]}
            value={type}
            onChange={(t) => updateParams({ type: t })}
            ariaLabel="Filter by type"
          />
          {offBroadwayShows.length > 0 && (
            <>
              <div className="hidden sm:block w-px h-5 bg-white/10" />
              <button
                onClick={toggleOB}
                className={`hidden sm:flex items-center gap-1.5 px-3 py-2 rounded-full text-xs font-semibold border transition-all ${
                  includeOB
                    ? 'bg-purple-500/[0.12] border-purple-500/25 text-purple-300'
                    : 'bg-white/[0.04] border-white/[0.08] text-gray-500 hover:text-gray-300'
                }`}
                aria-pressed={includeOB}
                title={includeOB ? 'Back to Broadway' : 'Show Off-Broadway shows'}
              >
                <span className={`w-1.5 h-1.5 rounded-full ${
                  includeOB ? 'bg-purple-400 shadow-[0_0_6px_rgba(168,85,247,0.5)]' : 'bg-gray-600'
                }`} />
                Off-Bway ({offBroadwayShows.length})
              </button>
            </>
          )}
        </div>

        {/* Score Mode Picker (Right) */}
        <ScoreToggle
          value={scoreMode}
          onChange={(key) => {
            if (key === 'audience') {
              updateParams({ scoreMode: key, sort: 'score_desc' });
            } else {
              updateParams({ scoreMode: key });
            }
          }}
        />
      </div>

      {/* Status & Sort Filters */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1 sm:gap-3 mb-4 sm:mb-6 text-sm">
        <ToggleBar
          label="STATUS:"
          options={[
            { value: 'now_playing' as StatusParam, label: 'PLAYING' },
            { value: 'closing_soon' as StatusParam, label: 'CLOSING' },
            { value: 'all' as StatusParam, label: 'ALL' },
            { value: 'closed' as StatusParam, label: 'CLOSED' },
          ]}
          value={status}
          onChange={(s) => updateParams({ status: s })}
          ariaLabel="Filter by status"
        />

        <ToggleBar
          label="SORT:"
          options={[
            { value: 'recent' as SortParam, label: 'NEWEST' },
            { value: 'score_desc' as SortParam, label: 'CRITICS' },
            { value: 'audience_buzz' as SortParam, label: 'AUDIENCE' },
            { value: 'alpha' as SortParam, label: 'A-Z' },
          ]}
          value={sort}
          onChange={(s) => updateParams({ sort: s })}
          ariaLabel="Sort shows"
        />
      </div>

      {/* Show List */}
      <h2 className="sr-only">Broadway Shows</h2>
      <ShowCardList shows={filteredAndSortedShows} hideStatus={shouldHideStatus} scoreMode={scoreMode} />

      {filteredAndSortedShows.length === 0 && (
        <div className="card text-center py-16 px-6" role="status" aria-live="polite">
          <div className="w-16 h-16 rounded-full bg-surface-overlay mx-auto mb-4 flex items-center justify-center">
            <svg className="w-8 h-8 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
          </div>
          <h3 className="text-lg font-semibold text-white mb-2">No shows found</h3>
          <p className="text-gray-400 mb-6 max-w-sm mx-auto">
            {searchInput
              ? `No shows match "${searchInput}". Try adjusting your search or filters.`
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
        <Link href="/methodology" prefetch={false} className="text-brand hover:text-brand-hover transition-colors">
          How scores work →
        </Link>
      </div>

      {/* Score Legend */}
      {scoreMode === 'audience' && !scoreMode.startsWith('both') ? (
        <div className="flex flex-wrap items-center justify-center gap-4 mt-8 mb-4 text-xs text-gray-400">
          <div className="flex items-center gap-1.5 cursor-help" title="Audiences love it">
            <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: '#22c55e' }}></div>
            <span>A+/A Loving It</span>
          </div>
          <div className="flex items-center gap-1.5 cursor-help" title="Strong audience reception">
            <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: '#14b8a6' }}></div>
            <span>A-/B+ Liking It</span>
          </div>
          <div className="flex items-center gap-1.5 cursor-help" title="Mixed audience reception">
            <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: '#f59e0b' }}></div>
            <span>B/B- Shrugging</span>
          </div>
          <div className="flex items-center gap-1.5 cursor-help" title="Below-average reception">
            <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: '#ef4444' }}></div>
            <span>C+/C/C- Disliking It</span>
          </div>
          <div className="flex items-center gap-1.5 cursor-help" title="Very poor reception">
            <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: '#991b1b' }}></div>
            <span>D/F Loathing It</span>
          </div>
        </div>
      ) : (
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
      )}

      {/* Featured Rows */}
      <div className="mt-8 pt-8 border-t border-white/5">
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
          title="Best Off-Broadway"
          shows={bestOffBroadway}
          viewAllHref="/off-broadway"
        />
        <FeaturedRow
          title="Tony Winning Shows"
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

      {/* Email Capture */}
      <div id="subscribe" className="mt-8 max-w-md mx-auto">
        <FooterEmailCapture />
      </div>

    </div>
  );
}

// Main export with Suspense boundary for useSearchParams
export default function HomePageClient(props: HomePageClientProps) {
  return (
    <Suspense fallback={
      <div className={`max-w-3xl mx-auto px-4 sm:px-6 ${props.skipHero ? 'pb-8 sm:pb-12' : 'py-8 sm:py-12'}`}>
        {!props.skipHero && (
          <div className="mb-8 sm:mb-10">
            <div className="text-4xl sm:text-6xl font-extrabold text-white mb-3 tracking-tight" aria-hidden="true">
              Broadway<span className="text-gradient">Scorecard</span><span className="text-xs text-gray-400 font-normal align-super ml-0.5">™</span>
            </div>
            <p className="text-gray-400 text-lg sm:text-xl">
              Every show. Every review. One score.
            </p>
          </div>
        )}
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
      <HomePageInner {...props} />
    </Suspense>
  );
}
