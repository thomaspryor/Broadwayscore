'use client';

import { useMemo, useCallback, useState, useRef, useEffect, startTransition, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import type Fuse from 'fuse.js';
import { SCORE_TIERS, ToggleBar, ScoreToggle, ShowListCard, MiniShowCard } from '@/components/show-cards';
import type { ScoreModeParam } from '@/components/show-cards';
import { hasEnoughReviews } from '@/config/score-buckets';

// Serialized show data passed from server component
export interface WestEndShow {
  id: string;
  slug: string;
  title: string;
  venue: string;
  openingDate: string;
  closingDate?: string;
  previewsStartDate?: string;
  status: string;
  type: string;
  isRevival?: boolean;
  reviewYearNote?: string;
  images?: { thumbnail?: string; poster?: string; hero?: string };
  criticScore?: { score?: number; reviewCount?: number; tier1Count?: number; tier2Count?: number };
  isOffWestEnd?: boolean;
  tags?: string[];
  ageRecommendation?: string;
  audienceCombinedScore: number | null;
  audienceGrade: { grade: string; label: string; color: string; textColor: string; tooltip: string } | null;
  creativeTeam?: Array<{ name: string; role: string }>;
  category?: string;
  subtitle?: string;
  subtitleColor?: string;
}

interface WestEndPageClientProps {
  shows: WestEndShow[];
  totalShows: number;
  totalReviews: number;
  scoredShows: number;
}

// URL parameter values
type StatusParam = 'now_playing' | 'previews' | 'closed' | 'all';
type SortParam = 'recent' | 'score_desc' | 'alpha' | 'audience_buzz';
type TypeParam = 'all' | 'musical' | 'play';
// Internal filter values
type StatusFilter = 'all' | 'open' | 'previews' | 'closed';

// Defaults
const DEFAULT_STATUS: StatusParam = 'now_playing';
const DEFAULT_SORT: SortParam = 'recent';
const DEFAULT_TYPE: TypeParam = 'all';
const DEFAULT_SCORE_MODE: ScoreModeParam = 'critics';

const shortDate = (d: string) => new Date(d + 'T12:00:00').toLocaleDateString('en-GB', { month: 'short', day: 'numeric' });

function weHasEnoughReviews(show: WestEndShow): boolean {
  const rc = show.criticScore?.reviewCount ?? 0;
  const t1t2 = (show.criticScore?.tier1Count ?? 0) + (show.criticScore?.tier2Count ?? 0);
  return hasEnoughReviews(rc, show.category || 'west-end', t1t2);
}

// Map URL params to internal values
const statusParamToFilter: Record<StatusParam, StatusFilter> = {
  now_playing: 'open',
  previews: 'previews',
  closed: 'closed',
  all: 'all',
};

function SearchIcon() {
  return (
    <svg className="w-5 h-5 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
    </svg>
  );
}

function ShowCardList({ shows, hideStatus, scoreMode }: { shows: WestEndShow[]; hideStatus: boolean; scoreMode: ScoreModeParam }) {
  return (
    <div className="space-y-3" role="list" aria-label="West End shows">
      {shows.map((show, index) => (
        <ShowListCard key={show.id} show={show} index={index} hideStatus={hideStatus} scoreMode={scoreMode} />
      ))}
    </div>
  );
}

// Featured row with horizontal scroll
function FeaturedRow({ title, shows }: { title: string; shows: WestEndShow[] }) {
  if (shows.length <= 3) return null;

  return (
    <section className="mb-6">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-base font-bold text-white">{title}</h2>
      </div>
      <div className="flex gap-3 overflow-x-auto pb-3 -mx-4 px-4 sm:mx-0 sm:px-0 scrollbar-hide">
        {shows.map((show) => (
          <MiniShowCard key={show.id} show={show} />
        ))}
      </div>
    </section>
  );
}

// Inner component that uses searchParams
function WestEndPageInner({ shows, totalShows, totalReviews, scoredShows }: WestEndPageClientProps) {
  const initialSearchParams = useSearchParams();

  const [filters, setFilters] = useState(() => ({
    status: (['now_playing', 'previews', 'closed', 'all'].includes(initialSearchParams.get('status') as string)
      ? initialSearchParams.get('status') as StatusParam : DEFAULT_STATUS),
    sort: (['recent', 'score_desc', 'alpha', 'audience_buzz'].includes(initialSearchParams.get('sort') as string)
      ? initialSearchParams.get('sort') as SortParam : DEFAULT_SORT),
    type: (['all', 'musical', 'play'].includes(initialSearchParams.get('type') as string)
      ? initialSearchParams.get('type') as TypeParam : DEFAULT_TYPE),
    scoreMode: (['critics', 'audience'].includes(initialSearchParams.get('scoreMode') as string)
      ? initialSearchParams.get('scoreMode') as ScoreModeParam : DEFAULT_SCORE_MODE),
    q: initialSearchParams.get('q') || '',
    venue: (initialSearchParams.get('venue') === 'west-end-only' ? 'west-end-only' : 'all') as 'all' | 'west-end-only',
  }));

  // Separate synchronous state for search input — startTransition drops keystrokes on controlled inputs
  const [searchInput, setSearchInput] = useState(() => initialSearchParams.get('q') || '');

  const status = filters.status;
  const sort = filters.sort;
  const type = filters.type;
  const scoreMode = filters.scoreMode;
  const searchQuery = filters.q;
  const venueFilter = filters.venue;
  const statusFilter = statusParamToFilter[status];

  const updateParams = useCallback((updates: Record<string, string | null>) => {
    startTransition(() => setFilters(prev => {
      const next = { ...prev };
      for (const [key, value] of Object.entries(updates)) {
        if (value === null) {
          (next as Record<string, string>)[key] =
            key === 'status' ? DEFAULT_STATUS :
            key === 'sort' ? DEFAULT_SORT :
            key === 'type' ? DEFAULT_TYPE :
            key === 'scoreMode' ? DEFAULT_SCORE_MODE :
            key === 'venue' ? 'all' : '';
        } else {
          (next as Record<string, string>)[key] = value;
        }
      }

      const urlParams = new URLSearchParams();
      if (next.status !== DEFAULT_STATUS) urlParams.set('status', next.status);
      if (next.sort !== DEFAULT_SORT) urlParams.set('sort', next.sort);
      if (next.type !== DEFAULT_TYPE) urlParams.set('type', next.type);
      if (next.scoreMode !== DEFAULT_SCORE_MODE) urlParams.set('scoreMode', next.scoreMode);
      if (next.q) urlParams.set('q', next.q);
      if (next.venue === 'west-end-only') urlParams.set('venue', next.venue);

      const paramString = urlParams.toString();
      window.history.replaceState({}, '', paramString ? `/west-end?${paramString}` : '/west-end');

      return next;
    }));
  }, []);

  const clearAllFilters = useCallback(() => {
    setSearchInput('');
    setFilters({
      status: DEFAULT_STATUS,
      sort: DEFAULT_SORT,
      type: DEFAULT_TYPE,
      scoreMode: DEFAULT_SCORE_MODE,
      q: '',
      venue: 'all',
    });
    window.history.replaceState({}, '', '/west-end');
  }, []);

  // Fuse.js — lazy-loaded on first search keystroke to reduce initial bundle
  const fuseRef = useRef<Fuse<WestEndShow> | null>(null);
  const fuseDataRef = useRef(shows);
  fuseDataRef.current = shows;

  const getFuse = useCallback(async () => {
    if (fuseRef.current) return fuseRef.current;
    const FuseModule = (await import('fuse.js/basic')).default;
    fuseRef.current = new FuseModule(fuseDataRef.current, {
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
          return (obj as WestEndShow).creativeTeam?.map(m => m.name).join(', ') || '';
        }
        return FuseModule.config.getFn(obj, path);
      },
    });
    return fuseRef.current;
  }, []);

  // Async search results from lazy-loaded Fuse
  const [fuseResults, setFuseResults] = useState<WestEndShow[] | null>(null);
  useEffect(() => {
    if (!searchQuery) { setFuseResults(null); return; }
    let cancelled = false;
    getFuse().then(fuse => {
      if (!cancelled) {
        setFuseResults(fuse.search(searchQuery).map(r => r.item));
      }
    }).catch(() => { /* Fuse load failed — fallback to unfiltered results */ });
    return () => { cancelled = true; };
  }, [searchQuery, getFuse]);

  // Featured rows
  const topMusicals = useMemo(() => {
    return shows
      .filter(show => show.type === 'musical' && show.status === 'open' && show.criticScore?.score && weHasEnoughReviews(show))
      .sort((a, b) => (b.criticScore?.score || 0) - (a.criticScore?.score || 0));
  }, [shows]);

  const topPlays = useMemo(() => {
    return shows
      .filter(show => show.type === 'play' && show.status === 'open' && show.criticScore?.score && weHasEnoughReviews(show))
      .sort((a, b) => (b.criticScore?.score || 0) - (a.criticScore?.score || 0));
  }, [shows]);

  const closingSoonShows = useMemo(() => {
    const now = new Date();
    return shows
      .filter(show => {
        if (show.status !== 'open' || !show.closingDate) return false;
        const closing = new Date(show.closingDate);
        const diffDays = Math.ceil((closing.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
        return diffDays > 0 && diffDays <= 90 && weHasEnoughReviews(show);
      })
      .sort((a, b) => new Date(a.closingDate!).getTime() - new Date(b.closingDate!).getTime())
      .map(s => ({ ...s, subtitle: `Closes ${shortDate(s.closingDate!)}`, subtitleColor: 'text-amber-400' }));
  }, [shows]);

  const bestOffWestEnd = useMemo(() => {
    return shows
      .filter(show => show.isOffWestEnd && show.status === 'open' && show.criticScore?.score && weHasEnoughReviews(show))
      .sort((a, b) => (b.criticScore?.score || 0) - (a.criticScore?.score || 0));
  }, [shows]);

  const olivierWinners = useMemo(() => {
    return shows
      .filter(show => show.status === 'open' && show.tags?.includes('olivier-winner') && show.criticScore?.score && weHasEnoughReviews(show))
      .sort((a, b) => (b.criticScore?.score || 0) - (a.criticScore?.score || 0));
  }, [shows]);

  const inPreviewsShows = useMemo(() => {
    return shows
      .filter(show => show.status === 'previews')
      .sort((a, b) => new Date(a.openingDate || '2099-01-01').getTime() - new Date(b.openingDate || '2099-01-01').getTime())
      .map(s => ({ ...s, subtitle: s.openingDate ? `Opens ${shortDate(s.openingDate)}` : undefined, subtitleColor: 'text-gray-400' }));
  }, [shows]);

  const startingSoonShows = useMemo(() => {
    return shows
      .filter(show => show.status === 'upcoming' && (show.previewsStartDate || show.openingDate))
      .sort((a, b) => new Date(a.previewsStartDate || a.openingDate).getTime() - new Date(b.previewsStartDate || b.openingDate).getTime())
      .map(s => {
        const startDate = s.previewsStartDate || s.openingDate;
        return { ...s, subtitle: startDate ? `Starts ${shortDate(startDate)}` : undefined, subtitleColor: 'text-gray-400' };
      });
  }, [shows]);

  const kidsShows = useMemo(() => {
    return shows
      .filter(show => {
        if (show.status !== 'open') return false;
        const tags = show.tags?.map(t => t.toLowerCase()) || [];
        const ageRec = show.ageRecommendation?.toLowerCase() || '';
        // Exclude ages 10+ (not truly kid-friendly)
        if (ageRec.match(/ages\s*(1[0-9]|[2-9]\d)\+?/)) return false;
        return tags.includes('family') || ageRec.includes('ages 5') || ageRec.includes('ages 6') || ageRec.includes('ages 7') || ageRec.includes('ages 8') || ageRec.includes('all ages');
      })
      .sort((a, b) => (b.criticScore?.score || 0) - (a.criticScore?.score || 0));
  }, [shows]);

  const dateNightShows = useMemo(() => {
    return shows
      .filter(show => {
        if (show.status !== 'open') return false;
        const tags = show.tags?.map(t => t.toLowerCase()) || [];
        return tags.includes('romantic');
      })
      .sort((a, b) => (b.criticScore?.score || 0) - (a.criticScore?.score || 0));
  }, [shows]);

  const jukeboxMusicals = useMemo(() => {
    return shows
      .filter(show => (show.status === 'open' || show.status === 'upcoming' || show.status === 'previews') && show.tags?.includes('jukebox'))
      .sort((a, b) => (b.criticScore?.score || 0) - (a.criticScore?.score || 0));
  }, [shows]);

  const filteredAndSortedShows = useMemo(() => {
    // fuseResults is null while Fuse.js loads — fall through to normal filtering (avoids empty flash)
    if (searchQuery && fuseResults !== null) {
      let searchResults = fuseResults;
      if (venueFilter === 'west-end-only') {
        searchResults = searchResults.filter(show => !show.isOffWestEnd);
      }
      return searchResults;
    }

    let result = shows.filter(show => {
      if (scoreMode === 'audience') {
        return show.audienceCombinedScore !== null && show.status !== 'previews';
      } else {
        // Only show shows with enough reviews for a score, plus previews/upcoming in "all" view
        if (show.status === 'previews' || show.status === 'upcoming') {
          // Previews/upcoming only visible when explicitly filtering for them or "all"
          return statusFilter === 'previews' || statusFilter === 'all';
        }
        // Open and closed shows: require minimum reviews for a score
        return show.criticScore && weHasEnoughReviews(show);
      }
    });

    // Status filter
    if (statusFilter !== 'all') {
      result = result.filter(show => show.status === statusFilter);
    }

    // Type filter
    if (type !== 'all') {
      result = result.filter(show => type === 'musical' ? show.type === 'musical' : show.type !== 'musical');
    }

    // Venue filter (Off-West End)
    if (venueFilter === 'west-end-only') {
      result = result.filter(show => !show.isOffWestEnd);
    }

    // Sort
    result.sort((a, b) => {
      switch (sort) {
        case 'score_desc': {
          if (scoreMode === 'audience') {
            const aAud = (a.status === 'previews') ? -1 : (a.audienceCombinedScore ?? -1);
            const bAud = (b.status === 'previews') ? -1 : (b.audienceCombinedScore ?? -1);
            return bAud - aAud;
          }
          const aHasEnough = weHasEnoughReviews(a);
          const bHasEnough = weHasEnoughReviews(b);
          const aScore = (a.status === 'previews' || !aHasEnough) ? -1 : (a.criticScore?.score ?? -1);
          const bScore = (b.status === 'previews' || !bHasEnough) ? -1 : (b.criticScore?.score ?? -1);
          return bScore - aScore;
        }
        case 'audience_buzz': {
          const aScore = (a.status === 'previews') ? -1 : (a.audienceCombinedScore ?? -1);
          const bScore = (b.status === 'previews') ? -1 : (b.audienceCombinedScore ?? -1);
          return bScore - aScore;
        }
        case 'alpha':
          return a.title.toLowerCase().localeCompare(b.title.toLowerCase());
        case 'recent':
        default:
          if (!a.openingDate && !b.openingDate) return 0;
          if (!a.openingDate) return 1;
          if (!b.openingDate) return -1;
          return new Date(b.openingDate).getTime() - new Date(a.openingDate).getTime();
      }
    });

    return result;
  }, [shows, fuseResults, statusFilter, type, searchQuery, sort, scoreMode, venueFilter]);

  const shouldHideStatus = statusFilter !== 'all';

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-5 sm:py-12">
      {/* Hero */}
      <div className="mb-4 sm:mb-8">
        <h1 className="hidden sm:block text-5xl lg:text-6xl font-extrabold text-white mb-3 tracking-tight">
          West End<span className="bg-gradient-to-r from-pink-400 to-pink-500 bg-clip-text text-transparent">Scorecard</span><span className="ml-2 align-middle inline-block text-[10px] sm:text-xs font-bold uppercase tracking-wider text-pink-400 border border-pink-400/30 bg-pink-400/10 rounded px-1.5 py-0.5 relative -top-3 sm:-top-4">Beta</span>
        </h1>
        <p className="text-gray-400 text-lg sm:text-xl">
          Every show. Every review. One score.
        </p>
        <p className="text-gray-500 text-sm sm:text-base mt-1">
          {scoredShows} scored shows. {totalReviews.toLocaleString()} critic reviews. And counting.
        </p>
      </div>

      {/* Top Musicals - Featured Shelf */}
      {topMusicals.length > 0 && (
        <section className="mb-4 sm:mb-6">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-base font-bold text-white">Top Musicals</h2>
          </div>
          <div className="flex gap-3 overflow-x-auto pb-3 -mx-4 px-4 sm:mx-0 sm:px-0 scrollbar-hide">
            {topMusicals.map((show, index) => (
              <MiniShowCard key={show.id} show={show} priority={index < 2} />
            ))}
          </div>
        </section>
      )}

      {/* Search */}
      <div id="search" className="relative mb-4 sm:mb-6 scroll-mt-24" role="search">
        <label htmlFor="we-show-search" className="sr-only">Search West End shows</label>
        <div className="absolute inset-y-0 left-4 flex items-center pointer-events-none">
          <SearchIcon />
        </div>
        <input
          id="we-show-search"
          type="search"
          placeholder="Search shows, venues, directors..."
          value={searchInput}
          onChange={(e) => {
            const val = e.target.value;
            setSearchInput(val);
            updateParams({ q: val });
          }}
          className="search-input pl-12 focus-visible:outline-none"
          autoComplete="off"
        />
      </div>

      {/* Type Pills & Score Mode Toggle Row */}
      <div className="flex items-center justify-between gap-2 sm:gap-4 mb-4 flex-wrap">
        <ToggleBar
          variant="pill"
          options={[{ value: 'all' as const, label: 'All' }, { value: 'musical' as const, label: 'Musicals' }, { value: 'play' as const, label: 'Plays' }]}
          value={type}
          onChange={(t) => updateParams({ type: t })}
          ariaLabel="Filter by type"
        />

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

      {/* Venue Filter */}
      {shows.some(s => s.isOffWestEnd) && (
        <div className="flex items-center gap-2 mb-3 text-sm">
          <ToggleBar
            label="VENUE:"
            options={[
              { value: 'all' as const, label: 'ALL LONDON' },
              { value: 'west-end-only' as const, label: 'WEST END ONLY' },
            ]}
            value={venueFilter}
            onChange={(v) => updateParams({ venue: v === 'all' ? null : v })}
            ariaLabel="Filter by venue type"
          />
        </div>
      )}

      {/* Status & Sort Filters */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1 sm:gap-3 mb-4 sm:mb-6 text-sm">
        <ToggleBar
          label="STATUS:"
          options={[
            { value: 'now_playing' as StatusParam, label: 'PLAYING' },
            { value: 'previews' as StatusParam, label: 'PREVIEWS' },
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
      <h2 className="sr-only">West End Shows</h2>
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
      {scoreMode === 'audience' ? (
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
        <FeaturedRow title="Top Plays" shows={topPlays} />
        <FeaturedRow title="Best Off-West End" shows={bestOffWestEnd} />
        <FeaturedRow title="Olivier Award Winning Shows" shows={olivierWinners} />
        <FeaturedRow title="In Previews" shows={inPreviewsShows} />
        <FeaturedRow title="Shows Starting Soon" shows={startingSoonShows} />
        <FeaturedRow title="Great for Kids" shows={kidsShows} />
        <FeaturedRow title="Perfect for Date Night" shows={dateNightShows} />
        <FeaturedRow title="Jukebox Musicals" shows={jukeboxMusicals} />
        <FeaturedRow title="Closing Soon" shows={closingSoonShows} />
      </div>

      {/* Off-West End cross-promo link */}
      <div className="mt-8 pt-4 border-t border-white/5 text-center">
        <Link href="/off-west-end" className="text-sm text-violet-400 hover:text-violet-300 transition-colors">
          View all Off-West End shows →
        </Link>
      </div>
    </div>
  );
}

// Main export with Suspense boundary for useSearchParams
export default function WestEndPageClient(props: WestEndPageClientProps) {
  return (
    <Suspense fallback={
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
        <div className="mb-8 sm:mb-10">
          <div className="text-4xl sm:text-6xl font-extrabold text-white mb-3 tracking-tight" aria-hidden="true">
            West End<span className="bg-gradient-to-r from-pink-400 to-pink-500 bg-clip-text text-transparent">Scorecard</span><span className="ml-2 align-middle inline-block text-[10px] sm:text-xs font-bold uppercase tracking-wider text-pink-400 border border-pink-400/30 bg-pink-400/10 rounded px-1.5 py-0.5 relative -top-3 sm:-top-4">Beta</span>
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
      <WestEndPageInner {...props} />
    </Suspense>
  );
}
