'use client';

import { useMemo, useCallback, useState, useRef, useEffect, startTransition, Suspense } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import type Fuse from 'fuse.js';
import { SCORE_TIERS, ToggleBar, ScoreToggle, ShowListCard, MiniShowCard } from '@/components/show-cards';
import MarketFilterBar from '@/components/MarketFilterBar';
import { GoldListCTA } from '@/components/gold-list/GoldListCTA';
import type { ScoreModeParam } from '@/components/show-cards';
import type { AwardWinnerSets } from '@/lib/data-awards';
import { FilterButton } from '@/components/filters/FilterButton';
import { FilterPanel } from '@/components/filters/FilterPanel';
import { ActiveFilterChips } from '@/components/filters/ActiveFilterChips';
import { TYPE_GROUP, buildStatusGroup, STATUS_OPTIONS_WITH_PREVIEWS, PANEL_PARAM_KEYS } from '@/components/filters/filter-ui-config';
import { usePanelFilters } from '@/lib/hooks/usePanelFilters';
import { hasEnoughReviews } from '@/config/score-buckets';

// Serialized show data passed from server component
export interface OffBroadwayShow {
  id: string;
  slug: string;
  title: string;
  venue: string;
  openingDate: string;
  closingDate?: string;
  status: string;
  type: string;
  isRevival?: boolean;
  season?: string;
  tags?: string[];
  reviewYearNote?: string;
  images?: { thumbnail?: string; poster?: string; hero?: string };
  criticScore?: { score?: number; reviewCount?: number; tier1Count?: number; tier2Count?: number };
  audienceCombinedScore: number | null;
  audienceGrade: { grade: string; label: string; color: string; textColor: string; tooltip: string } | null;
  creativeTeam?: Array<{ name: string; role: string }>;
  category?: string;
  subtitle?: string; // e.g. "Starts Jul 8" — shown below title on shelf cards
  subtitleColor?: string; // Tailwind text color class (default: emerald-400)
}

interface OffBroadwayPageClientProps {
  shows: OffBroadwayShow[];
  totalShows: number;
  totalReviews: number;
  /** Open-show counts for the market pills */
  marketOpenCounts: { broadway: number; offBroadway: number };
  awardWinnerSets?: AwardWinnerSets;
  /** Upcoming OB shows for the "Starting Soon" shelf (computed server-side). */
  startingSoonShows?: OffBroadwayShow[];
}

// URL parameter values
type StatusParam = 'now_playing' | 'previews' | 'closed' | 'all';
type SortParam = 'recent' | 'score_desc' | 'alpha' | 'audience_buzz';
type TypeParam = 'all' | 'musical' | 'play' | 'opera';
// Internal filter values
type StatusFilter = 'all' | 'open' | 'previews' | 'closed';

// Defaults
const DEFAULT_STATUS: StatusParam = 'now_playing';
const DEFAULT_SORT: SortParam = 'recent';
const DEFAULT_TYPE: TypeParam = 'all';
const DEFAULT_SCORE_MODE: ScoreModeParam = 'critics';

function obHasEnoughReviews(show: OffBroadwayShow): boolean {
  const rc = show.criticScore?.reviewCount ?? 0;
  const t1t2 = (show.criticScore?.tier1Count ?? 0) + (show.criticScore?.tier2Count ?? 0);
  return hasEnoughReviews(rc, 'off-broadway', t1t2);
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

function ShowCardList({ shows, hideStatus, scoreMode }: { shows: OffBroadwayShow[]; hideStatus: boolean; scoreMode: ScoreModeParam }) {
  return (
    <div className="space-y-3" role="list" aria-label="Off-Broadway shows">
      {shows.map((show, index) => (
        <ShowListCard key={show.id} show={show} index={index} hideStatus={hideStatus} scoreMode={scoreMode} />
      ))}
    </div>
  );
}

// Featured row with horizontal scroll
function FeaturedRow({ title, shows }: { title: string; shows: OffBroadwayShow[] }) {
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
function OffBroadwayPageInner({ shows, totalShows, totalReviews, marketOpenCounts, awardWinnerSets, startingSoonShows = [] }: OffBroadwayPageClientProps) {
  const initialSearchParams = useSearchParams();
  const router = useRouter();

  const [filters, setFilters] = useState(() => ({
    status: (['now_playing', 'previews', 'closed', 'all'].includes(initialSearchParams.get('status') as string)
      ? initialSearchParams.get('status') as StatusParam : DEFAULT_STATUS),
    sort: (['recent', 'score_desc', 'alpha', 'audience_buzz'].includes(initialSearchParams.get('sort') as string)
      ? initialSearchParams.get('sort') as SortParam : DEFAULT_SORT),
    type: (['all', 'musical', 'play', 'opera'].includes(initialSearchParams.get('type') as string)
      ? initialSearchParams.get('type') as TypeParam : DEFAULT_TYPE),
    scoreMode: (['critics', 'audience'].includes(initialSearchParams.get('scoreMode') as string)
      ? initialSearchParams.get('scoreMode') as ScoreModeParam : DEFAULT_SCORE_MODE),
    q: initialSearchParams.get('q') || '',
  }));

  // Separate synchronous state for search input — startTransition drops keystrokes on controlled inputs
  const [searchInput, setSearchInput] = useState(() => initialSearchParams.get('q') || '');

  const status = filters.status;
  const sort = filters.sort;
  const type = filters.type;
  const scoreMode = filters.scoreMode;
  const searchQuery = filters.q;
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
            key === 'scoreMode' ? DEFAULT_SCORE_MODE : '';
        } else {
          (next as Record<string, string>)[key] = value;
        }
      }

      // Preserve unknown params (panel filters) so they survive inline-filter changes
      const urlParams = new URLSearchParams(window.location.search);
      const setOrDelete = (key: string, value: string, isDefault: boolean) => {
        if (isDefault) urlParams.delete(key);
        else urlParams.set(key, value);
      };
      setOrDelete('status', next.status, next.status === DEFAULT_STATUS);
      setOrDelete('sort', next.sort, next.sort === DEFAULT_SORT);
      setOrDelete('type', next.type, next.type === DEFAULT_TYPE);
      setOrDelete('scoreMode', next.scoreMode, next.scoreMode === DEFAULT_SCORE_MODE);
      setOrDelete('q', next.q, !next.q);

      const paramString = urlParams.toString();
      window.history.replaceState({}, '', paramString ? `/off-broadway?${paramString}` : '/off-broadway');

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
    });
    window.history.replaceState({}, '', '/off-broadway');
  }, []);

  // Fuse.js — lazy-loaded on first search keystroke to reduce initial bundle
  const fuseRef = useRef<Fuse<OffBroadwayShow> | null>(null);
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
          return (obj as OffBroadwayShow).creativeTeam?.map(m => m.name).join(', ') || '';
        }
        return FuseModule.config.getFn(obj, path);
      },
    });
    return fuseRef.current;
  }, []);

  // Async search results from lazy-loaded Fuse
  const [fuseResults, setFuseResults] = useState<OffBroadwayShow[] | null>(null);
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
  const topRecentShows = useMemo(() => {
    const twelveMonthsAgo = new Date();
    twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 12);
    return shows
      .filter(show => {
        if (!show.criticScore?.score || !obHasEnoughReviews(show)) return false;
        if (show.status === 'previews' || show.status === 'upcoming') return false;
        const opened = new Date(show.openingDate);
        return opened >= twelveMonthsAgo;
      })
      .sort((a, b) => (b.criticScore?.score || 0) - (a.criticScore?.score || 0));
  }, [shows]);

  const topPlays = useMemo(() => {
    return shows
      .filter(show => show.type === 'play' && show.status === 'open' && show.criticScore?.score && obHasEnoughReviews(show))
      .sort((a, b) => (b.criticScore?.score || 0) - (a.criticScore?.score || 0));
  }, [shows]);

  const closingSoonShows = useMemo(() => {
    const now = new Date();
    return shows
      .filter(show => {
        if (show.status !== 'open' || !show.closingDate) return false;
        const closing = new Date(show.closingDate);
        const diffDays = Math.ceil((closing.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
        return diffDays > 0 && diffDays <= 90 && obHasEnoughReviews(show);
      })
      .sort((a, b) => new Date(a.closingDate!).getTime() - new Date(b.closingDate!).getTime());
  }, [shows]);

  const filteredAndSortedShows = useMemo(() => {
    // fuseResults is null while Fuse.js loads — fall through to normal filtering (avoids empty flash)
    if (searchQuery && fuseResults !== null) {
      return fuseResults;
    }

    let result = shows.filter(show => {
      if (scoreMode === 'audience') {
        return show.audienceCombinedScore !== null && show.status !== 'previews';
      } else {
        // Only show shows with enough reviews for a score, plus previews/upcoming in filtered views
        if (show.status === 'previews' || show.status === 'upcoming') {
          return statusFilter === 'previews' || statusFilter === 'all';
        }
        // Open and closed shows: require minimum reviews for a score
        return show.criticScore && obHasEnoughReviews(show);
      }
    });

    // Status filter
    if (statusFilter !== 'all') {
      result = result.filter(show => show.status === statusFilter);
    }

    // Type filter
    if (type !== 'all') {
      result = result.filter(show => show.type === type);
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
          const aHasEnough = obHasEnoughReviews(a);
          const bHasEnough = obHasEnoughReviews(b);
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
  }, [shows, fuseResults, statusFilter, type, searchQuery, sort, scoreMode]);

  const panelSingleGroups = useMemo(
    () => [TYPE_GROUP, buildStatusGroup(STATUS_OPTIONS_WITH_PREVIEWS)],
    [],
  );
  const panelSingleValueOverrides = useMemo(
    () => ({ type, status }),
    [type, status],
  );
  const setPanelSingleValue = useCallback(
    (paramKey: string, value: string) => {
      const group = panelSingleGroups.find((g) => g.paramKey === paramKey);
      if (group && value === group.defaultValue) {
        updateParams({ [paramKey]: null });
      } else {
        updateParams({ [paramKey]: value });
      }
    },
    [panelSingleGroups, updateParams],
  );
  const panel = usePanelFilters({
    shows: filteredAndSortedShows,
    awardWinnerSets,
    scoreMode,
    singleGroups: panelSingleGroups,
    singleValueOverrides: panelSingleValueOverrides,
    onSetSingleValueOverride: setPanelSingleValue,
  });
  const [isPanelOpen, setIsPanelOpen] = useState(false);

  // Single-writer clearAll (avoids URL race between window.history.replaceState
  // in startTransition + router.replace). See HomePageClient note.
  const handlePanelClearAll = useCallback(() => {
    setFilters((prev) => ({
      ...prev,
      type: DEFAULT_TYPE,
      status: DEFAULT_STATUS,
    }));
    const live = new URLSearchParams(window.location.search);
    Array.from(PANEL_PARAM_KEYS).forEach((k) => live.delete(k));
    const qs = live.toString();
    router.replace(qs ? `/off-broadway?${qs}` : '/off-broadway', { scroll: false });
  }, [router]);

  const shouldHideStatus = statusFilter !== 'all';

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-5 sm:py-12">
      {/* Hero */}
      <div className="mb-4 sm:mb-8">
        <h1 className="hidden sm:block text-5xl lg:text-6xl font-extrabold text-white mb-3 tracking-tight">
          Off-Broadway<span className="text-gradient">Scorecard</span><span className="ml-2 align-middle inline-block text-[10px] sm:text-xs font-bold uppercase tracking-wider text-brand border border-brand/30 bg-brand/10 rounded px-1.5 py-0.5 relative -top-3 sm:-top-4">Beta</span>
        </h1>
        <p className="text-gray-400 text-lg sm:text-xl">
          Every show. Every review. One score.
        </p>
        <p className="text-gray-500 text-sm sm:text-base mt-1">
          {totalShows} shows. {totalReviews.toLocaleString()} critic reviews. And counting.
        </p>
      </div>

      {/* Gold List discovery CTA */}
      <GoldListCTA listType="critical-gold-off-broadway" />

      {/* Top Recent Shows - Featured Shelf */}
      {topRecentShows.length > 3 && (
        <section className="mb-4 sm:mb-6">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-base font-bold text-white">Top Recent Shows</h2>
          </div>
          <div className="flex gap-3 overflow-x-auto pb-3 -mx-4 px-4 sm:mx-0 sm:px-0 scrollbar-hide">
            {topRecentShows.map((show, index) => (
              <MiniShowCard key={show.id} show={show} priority={index < 2} />
            ))}
          </div>
        </section>
      )}

      {/* Search */}
      <div id="search" className="relative mb-2 scroll-mt-24" role="search">
        <label htmlFor="ob-show-search" className="sr-only">Search Off-Broadway shows</label>
        <div className="absolute inset-y-0 left-4 flex items-center pointer-events-none">
          <SearchIcon />
        </div>
        <input
          id="ob-show-search"
          type="search"
          placeholder="Search shows, venues, directors..."
          value={searchInput}
          onChange={(e) => {
            const val = e.target.value;
            setSearchInput(val);
            updateParams({ q: val });
          }}
          className="search-input pl-12 pr-14 focus-visible:outline-none"
          autoComplete="off"
        />
        <div className="absolute inset-y-0 right-2 flex items-center">
          <FilterButton
            activeCount={panel.activeCount}
            isOpen={isPanelOpen}
            onClick={() => setIsPanelOpen((v) => !v)}
            controlsId="advanced-filter-panel"
          />
        </div>
      </div>

      <div className="mb-2 sm:mb-4">
        <ActiveFilterChips
          chips={panel.chips}
          onRemove={panel.removeChip}
          onClearAll={handlePanelClearAll}
        />
      </div>

      <FilterPanel
        isOpen={isPanelOpen}
        onClose={() => setIsPanelOpen(false)}
        selectedByGroup={panel.selectedByGroup}
        onToggle={panel.toggleOption}
        singleGroups={panelSingleGroups}
        singleValueByGroup={panel.singleValueByGroup}
        onSetSingleValue={panel.setSingleValue}
        dateRanges={panel.dateRanges}
        onDateRangesChange={panel.setDateRanges}
        onClearAll={handlePanelClearAll}
        resultCount={panel.filteredShows.length}
      />

      {/* Market + Type Filter Row */}
      <div className="flex items-center gap-2 sm:gap-4 mb-4">
        <MarketFilterBar
          pair="nyc"
          activeMarket="off-broadway"
          primaryCount={marketOpenCounts.broadway}
          secondaryCount={marketOpenCounts.offBroadway}
          typeValue={type}
          onTypeChange={(t) => updateParams({ type: t })}
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
          className="flex-shrink-0"
        />
      </div>

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
      <h2 className="sr-only">Off-Broadway Shows</h2>
      <ShowCardList shows={panel.filteredShows} hideStatus={shouldHideStatus} scoreMode={scoreMode} />

      {panel.filteredShows.length === 0 && (
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
        <span>{panel.filteredShows.length} shows</span>
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
        <FeaturedRow title="Closing Soon" shows={closingSoonShows} />
        <FeaturedRow title="Starting Soon" shows={startingSoonShows} />
      </div>
    </div>
  );
}

// Main export with Suspense boundary for useSearchParams
export default function OffBroadwayPageClient(props: OffBroadwayPageClientProps) {
  return (
    <Suspense fallback={
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
        <div className="mb-8 sm:mb-10">
          <div className="text-4xl sm:text-6xl font-extrabold text-white mb-3 tracking-tight" aria-hidden="true">
            Off-Broadway<span className="text-gradient">Scorecard</span><span className="ml-2 align-middle inline-block text-[10px] sm:text-xs font-bold uppercase tracking-wider text-brand border border-brand/30 bg-brand/10 rounded px-1.5 py-0.5 relative -top-3 sm:-top-4">Beta</span>
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
      <OffBroadwayPageInner {...props} />
    </Suspense>
  );
}
