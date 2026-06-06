'use client';

import { useState, useEffect, useMemo, useRef, useCallback, useId } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { featureFlags } from '@/config/feature-flags';
import { useAuth } from '@/contexts/AuthContext';
import { useUserReviews } from '@/hooks/useUserReviews';
import { useWatchlist } from '@/hooks/useWatchlist';
import StarRating from '@/components/user/StarRating';

import { useToastSafe } from '@/components/ui/Toast';
import type { UserReview, WatchlistEntry, ShowLookup } from '@/types/user';
import dynamic from 'next/dynamic';
import { ShowSearchDropdown } from '@/components/show-cards';
const MezzanineImport = dynamic(() => import('./MezzanineImport'), { ssr: false });

const ListsTab = dynamic(() => import('./ListsTab').catch(() => {
  return { default: () => <div className="text-center py-12 text-red-400">Failed to load lists. Please refresh the page.</div> };
}), {
  loading: () => <div className="text-center py-12 text-gray-500">Loading lists...</div>,
});

type Tab = 'diary' | 'watchlist' | 'lists';
type DiarySort = 'date-desc' | 'date-asc' | 'rating-desc';
type WatchlistSort = 'added-desc' | 'alphabetical' | 'closing-soon';
type ViewMode = 'grid' | 'list';

interface ShowMap {
  [showId: string]: ShowLookup;
}

// Decode the compact show-lookup format
function decodeShow(raw: Record<string, unknown>): ShowLookup {
  return {
    id: raw.id as string,
    title: raw.t as string,
    slug: raw.s as string,
    venue: raw.v as string,
    type: raw.m ? 'musical' : 'play',
    status: (raw.st as string) || 'closed',
    category: (raw.c as string) || 'broadway',
    previewDate: null,
    openingDate: (raw.od as string) || null,
    closingDate: (raw.cd as string) || null,
    compositeScore: null,
    posterUrl: (raw.p as string) || null,
  };
}

function getShowHref(slug: string, _category: string) {
  // All shows use /show/[slug] — no separate routes for west-end or off-broadway
  return `/show/${slug}`;
}

export default function MyShowsClient() {
  const searchParams = useSearchParams();
  const [activeTab, setActiveTabState] = useState<Tab>(
    searchParams.get('tab') === 'watchlist' ? 'watchlist' :
    searchParams.get('tab') === 'lists' ? 'lists' : 'diary'
  );

  // Dev-only mock mode: ?mock=1 on localhost renders with fake data (for Playwright visual QA)
  // Must be state (not derived) to avoid SSR/client hydration mismatch
  const [isMockMode, setIsMockMode] = useState(false);
  const [createListTrigger, setCreateListTrigger] = useState(0);
  useEffect(() => {
    if (window.location.hostname === 'localhost' && searchParams.get('mock') === '1') {
      setIsMockMode(true);
    }
  }, [searchParams]);

  // Update URL when tab changes so back button restores the correct tab
  const setActiveTab = (tab: Tab) => {
    setActiveTabState(tab);
    const mockParam = isMockMode ? '&mock=1' : '';
    const url = tab === 'diary'
      ? `/my-shows${mockParam ? `?${mockParam.slice(1)}` : ''}`
      : `/my-shows?tab=${tab}${mockParam}`;
    window.history.replaceState(null, '', url);
  };
  const [diarySort, setDiarySort] = useState<DiarySort>('date-desc');
  const [watchlistSort, setWatchlistSort] = useState<WatchlistSort>('added-desc');
  const [watchlistView, setWatchlistView] = useState<ViewMode>('grid');
  const [diaryView, setDiaryView] = useState<ViewMode>('list');
  const [showMap, setShowMap] = useState<ShowMap>({});
  const [showMapLoaded, setShowMapLoaded] = useState(false);

  const { user, isAuthenticated, loading: authLoading, showSignIn } = useAuth();
  const { reviews: realReviews, getAllReviews, deleteReview, loading: reviewsLoading } = useUserReviews(user?.id || null);
  const { watchlist: realWatchlist, getWatchlist, addToWatchlist, updatePlannedDate, removeFromWatchlist, loading: watchlistLoading } = useWatchlist(user?.id || null);
  const { showToast } = useToastSafe();

  // In mock mode, bypass loading/auth and inject fake data
  const [mockData, setMockData] = useState<{ reviews: UserReview[]; watchlist: WatchlistEntry[]; showMap: ShowMap } | null>(null);
  useEffect(() => {
    if (!isMockMode) return;
    import('./__dev-mock-data').then(mod => {
      setMockData({ reviews: mod.mockReviews, watchlist: mod.mockWatchlist, showMap: mod.mockShowMap });
    });
  }, [isMockMode]);

  const reviews = isMockMode && mockData ? mockData.reviews : realReviews;
  const watchlist = isMockMode && mockData ? mockData.watchlist : realWatchlist;
  const loading = isMockMode ? !mockData : (authLoading || reviewsLoading || watchlistLoading);

  // Mock-mode mutation handlers — update local state so tests can verify delete/remove/date flows
  const mockDeleteReview = useCallback(async (reviewId: string) => {
    setMockData(prev => prev ? { ...prev, reviews: prev.reviews.filter(r => r.id !== reviewId) } : prev);
  }, []);
  const mockRemoveFromWatchlist = useCallback(async (showId: string) => {
    setMockData(prev => prev ? { ...prev, watchlist: prev.watchlist.filter(w => w.show_id !== showId) } : prev);
  }, []);
  const mockUpdatePlannedDate = useCallback(async (showId: string, date: string | null) => {
    setMockData(prev => prev ? {
      ...prev,
      watchlist: prev.watchlist.map(w => w.show_id === showId ? { ...w, planned_date: date } : w),
    } : prev);
  }, []);
  const mockAddToWatchlist = useCallback(async (showId: string) => {
    setMockData(prev => prev ? {
      ...prev,
      watchlist: [...prev.watchlist, { show_id: showId, user_id: 'mock', planned_date: null, created_at: new Date().toISOString() } as WatchlistEntry],
    } : prev);
  }, []);

  const effectiveDeleteReview = isMockMode ? mockDeleteReview : deleteReview;
  const effectiveRemoveFromWatchlist = isMockMode ? mockRemoveFromWatchlist : removeFromWatchlist;
  const effectiveUpdatePlannedDate = isMockMode ? mockUpdatePlannedDate : updatePlannedDate;
  const effectiveAddToWatchlist = isMockMode ? mockAddToWatchlist : addToWatchlist;

  // Load show lookup data (abort if mock mode activates mid-flight)
  useEffect(() => {
    if (isMockMode) return;
    const controller = new AbortController();
    fetch('/data/show-lookup.json', { signal: controller.signal })
      .then(res => res.json())
      .then((data: Record<string, unknown>[]) => {
        const map: ShowMap = {};
        for (const raw of data) {
          const show = decodeShow(raw);
          map[show.id] = show;
        }
        setShowMap(map);
        setShowMapLoaded(true);
      })
      .catch(() => {
        if (!controller.signal.aborted) setShowMapLoaded(true);
      });
    return () => controller.abort();
  }, [isMockMode]);

  // Inject mock showMap when loaded
  useEffect(() => {
    if (isMockMode && mockData) {
      setShowMap(mockData.showMap);
      setShowMapLoaded(true);
    }
  }, [isMockMode, mockData]);

  // Load user data when authenticated
  useEffect(() => {
    if (isMockMode) return;
    if (isAuthenticated && user) {
      getAllReviews();
      getWatchlist();
    }
  }, [isMockMode, isAuthenticated, user, getAllReviews, getWatchlist]);

  // Stats
  const showsSeen = new Set(reviews.map(r => r.show_id)).size;
  const upcomingCount = reviews.filter(r => {
    if (!r.date_seen) return false;
    return new Date(r.date_seen) > new Date();
  }).length;

  // Sorted diary entries
  const sortedReviews = useMemo(() => {
    const sorted = [...reviews];
    switch (diarySort) {
      case 'date-desc':
        return sorted.sort((a, b) => {
          const dateA = a.date_seen || a.created_at;
          const dateB = b.date_seen || b.created_at;
          return new Date(dateB).getTime() - new Date(dateA).getTime();
        });
      case 'date-asc':
        return sorted.sort((a, b) => {
          const dateA = a.date_seen || a.created_at;
          const dateB = b.date_seen || b.created_at;
          return new Date(dateA).getTime() - new Date(dateB).getTime();
        });
      case 'rating-desc':
        return sorted.sort((a, b) => b.rating - a.rating);
      default:
        return sorted;
    }
  }, [reviews, diarySort]);

  // Upcoming shows (future date_seen)
  const upcomingReviews = sortedReviews.filter(r => {
    if (!r.date_seen) return false;
    return new Date(r.date_seen + 'T23:59:59') >= new Date();
  });

  // Past shows
  const pastReviews = sortedReviews.filter(r => {
    if (!r.date_seen) return true; // No date = treat as past
    return new Date(r.date_seen + 'T23:59:59') < new Date();
  });

  // Watchlist entries with future planned_date (for diary "Upcoming" section)
  const upcomingWatchlistEntries = useMemo(() => {
    const today = new Date().toISOString().split('T')[0];
    const reviewedShowIds = new Set(reviews.map(r => r.show_id));
    return watchlist
      .filter(w => w.planned_date && w.planned_date > today && !reviewedShowIds.has(w.show_id))
      .sort((a, b) => (a.planned_date || '').localeCompare(b.planned_date || ''));
  }, [watchlist, reviews]);

  // Watchlist entries where planned_date <= today AND no review exists ("To be rated")
  const toBeRatedEntries = useMemo(() => {
    const today = new Date().toISOString().split('T')[0];
    const reviewedShowIds = new Set(reviews.map(r => r.show_id));
    return watchlist
      .filter(w => w.planned_date && w.planned_date <= today && !reviewedShowIds.has(w.show_id))
      .sort((a, b) => (b.planned_date || '').localeCompare(a.planned_date || ''));
  }, [watchlist, reviews]);

  // Sorted watchlist
  const sortedWatchlist = useMemo(() => {
    const sorted = [...watchlist];
    switch (watchlistSort) {
      case 'added-desc':
        return sorted.sort((a, b) => {
          // Within each section (booked vs unbooked), sort by planned_date or created_at
          const aHasDate = !!a.planned_date;
          const bHasDate = !!b.planned_date;
          if (aHasDate && bHasDate) return (a.planned_date || '').localeCompare(b.planned_date || '');
          return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
        });
      case 'alphabetical':
        return sorted.sort((a, b) => {
          const titleA = showMap[a.show_id]?.title || '';
          const titleB = showMap[b.show_id]?.title || '';
          return titleA.localeCompare(titleB);
        });
      case 'closing-soon':
        return sorted.sort((a, b) => {
          const closingA = showMap[a.show_id]?.closingDate || '9999-12-31';
          const closingB = showMap[b.show_id]?.closingDate || '9999-12-31';
          return closingA.localeCompare(closingB);
        });
      default:
        return sorted;
    }
  }, [watchlist, watchlistSort, showMap]);

  // Split watchlist into "not yet booked" vs "booked" (has planned_date)
  const unbookedWatchlist = useMemo(() => sortedWatchlist.filter(e => !e.planned_date), [sortedWatchlist]);
  const bookedWatchlist = useMemo(() => sortedWatchlist.filter(e => !!e.planned_date), [sortedWatchlist]);

  // While mock mode is initializing (useEffect hasn't fired yet), show loading
  const hasMockParam = searchParams.get('mock') === '1';

  if (!featureFlags.userAccounts && !isMockMode) {
    if (hasMockParam) {
      // Mock mode initializing — show loading skeleton briefly
      return (
        <div className="max-w-3xl mx-auto px-4 sm:px-6 pt-8">
          <div className="animate-pulse space-y-4">
            <div className="h-8 bg-white/5 rounded w-48" />
            <div className="h-4 bg-white/5 rounded w-64" />
          </div>
        </div>
      );
    }
    return (
      <div className="max-w-3xl mx-auto px-4 sm:px-6 pt-8">
        <p className="text-gray-400">This feature is not yet available.</p>
      </div>
    );
  }

  if (!isMockMode && !authLoading && !isAuthenticated) {
    return (
      <div className="max-w-3xl mx-auto px-4 sm:px-6 pt-6 sm:pt-8 pb-12">
        <h1 className="text-2xl sm:text-3xl font-extrabold text-white mb-2">My Shows</h1>
        <div className="text-center py-16">
          <div className="text-5xl mb-4">🎭</div>
          <h3 className="text-lg font-bold text-white mb-2">Track your Broadway journey</h3>
          <p className="text-sm text-gray-400 mb-6 max-w-xs mx-auto">
            Sign in to rate shows, keep a diary of what you&apos;ve seen, and build your watchlist.
          </p>
          <button
            type="button"
            onClick={() => showSignIn()}
            className="inline-block px-6 py-3 text-sm font-semibold text-black bg-[#FFD700] rounded-lg hover:bg-[#e6c200] transition-colors"
          >
            Sign In to Get Started
          </button>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="max-w-3xl mx-auto px-4 sm:px-6 pt-8">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-white/5 rounded w-48" />
          <div className="h-4 bg-white/5 rounded w-64" />
          <div className="grid grid-cols-2 gap-4 mt-6">
            {[1, 2, 3, 4].map(i => (
              <div key={i} className="h-32 bg-white/5 rounded-xl" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div data-testid="my-shows-content" className="max-w-3xl mx-auto px-4 sm:px-6 pt-6 sm:pt-8 pb-12">
      {/* Header */}
      <div className="flex items-center justify-between mb-2">
        <h1 className="text-2xl sm:text-3xl font-extrabold text-white">My Shows</h1>
        {activeTab === 'lists' ? (
          <button
            type="button"
            onClick={() => setCreateListTrigger(t => t + 1)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-gray-400 hover:text-white bg-white/[0.06] hover:bg-white/10 border border-white/10 transition-colors text-xs font-medium"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
            </svg>
            <span>New list</span>
          </button>
        ) : (
          <AddShowSearch
            context={activeTab}
            onAddToWatchlist={async (showId: string) => {
              await effectiveAddToWatchlist(showId);
              if (!isMockMode) await getWatchlist();
              showToast?.(<>Added to <a href="/my-shows?tab=watchlist" className="underline hover:text-white/90">Watchlist</a></>, 'success');
            }}
            existingWatchlistIds={new Set(watchlist.map(w => w.show_id))}
            existingReviewIds={new Set(reviews.map(r => r.show_id))}
          />
        )}
      </div>

      {/* Stats bar */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-gray-400 mb-2">
        <span><strong className="text-white">{showsSeen}</strong> shows seen</span>
        {upcomingCount > 0 && (
          <span><strong className="text-white">{upcomingCount}</strong> upcoming</span>
        )}
        <span><strong className="text-white">{watchlist.length}</strong> watchlist</span>
        {toBeRatedEntries.length > 0 && (
          <span><strong className="text-amber-400">{toBeRatedEntries.length}</strong> to rate</span>
        )}
      </div>
      {!isMockMode && user && (
        <div className="mb-6">
          <MezzanineImport
            userId={user.id}
            existingReviewShowIds={new Set(reviews.map(r => r.show_id))}
            existingWatchlistShowIds={new Set(watchlist.map(w => w.show_id))}
            onImportComplete={() => { getAllReviews(); getWatchlist(); }}
          />
        </div>
      )}

      {/* Tab bar + sort/view controls.
          On mobile: tabs only in the tablist row; controls on a second row below.
          On sm+: controls inline to the right of the tabs. */}
      <div role="tablist" className="flex items-center gap-1 border-b border-white/10 mb-0 sm:mb-6">
        <button
          type="button"
          role="tab"
          id="tab-diary"
          aria-selected={activeTab === 'diary'}
          aria-controls="panel-diary"
          onClick={() => setActiveTab('diary')}
          className={`flex-shrink-0 px-2 sm:px-4 py-2.5 text-sm font-semibold transition-colors border-b-2 -mb-[1px] outline-none ${
            activeTab === 'diary'
              ? 'text-white border-brand'
              : 'text-gray-500 border-transparent hover:text-gray-300'
          }`}
        >
          Diary
        </button>
        <button
          type="button"
          role="tab"
          id="tab-watchlist"
          aria-selected={activeTab === 'watchlist'}
          aria-controls="panel-watchlist"
          onClick={() => setActiveTab('watchlist')}
          aria-label={watchlist.length > 0 ? `Watchlist, ${watchlist.length} shows` : 'Watchlist'}
          className={`flex-shrink-0 px-2 sm:px-4 py-2.5 text-sm font-semibold transition-colors border-b-2 -mb-[1px] outline-none ${
            activeTab === 'watchlist'
              ? 'text-white border-brand'
              : 'text-gray-500 border-transparent hover:text-gray-300'
          }`}
        >
          Watchlist
          {watchlist.length > 0 && (
            <span className="ml-1.5 px-1.5 py-0.5 text-[10px] bg-white/10 rounded-full" aria-hidden="true">
              {watchlist.length}
            </span>
          )}
        </button>
        <button
          type="button"
          role="tab"
          id="tab-lists"
          aria-selected={activeTab === 'lists'}
          aria-controls="panel-lists"
          onClick={() => setActiveTab('lists')}
          className={`flex-shrink-0 px-2 sm:px-4 py-2.5 text-sm font-semibold transition-colors border-b-2 -mb-[1px] outline-none ${
            activeTab === 'lists'
              ? 'text-white border-brand'
              : 'text-gray-500 border-transparent hover:text-gray-300'
          }`}
        >
          Lists
        </button>

        {/* Desktop-only inline controls (hidden on mobile — shown in second row below) */}
        {activeTab !== 'lists' && (
        <div className="ml-auto hidden sm:flex items-center gap-1.5 sm:gap-2 -mb-[1px]">
          {activeTab === 'diary' && (
            <select
              value={diarySort}
              onChange={e => setDiarySort(e.target.value as DiarySort)}
              aria-label="Sort diary"
              className="text-xs bg-white/5 border border-white/10 rounded px-2 py-1 h-8 text-gray-300"
            >
              <option value="date-desc">Newest</option>
              <option value="date-asc">Oldest</option>
              <option value="rating-desc">Top Rated</option>
            </select>
          )}
          {activeTab === 'watchlist' && (
            <select
              value={watchlistSort}
              onChange={e => setWatchlistSort(e.target.value as WatchlistSort)}
              aria-label="Sort watchlist"
              className="text-xs bg-white/5 border border-white/10 rounded px-2 py-1 h-8 text-gray-300"
            >
              <option value="added-desc">Recent</option>
              <option value="alphabetical">A-Z</option>
              <option value="closing-soon">Closing</option>
            </select>
          )}
          {/* Grid / List toggle */}
          <div className="inline-flex flex-shrink-0 rounded overflow-hidden bg-white/[0.04] border border-white/10 h-8">
            <button
              type="button"
              onClick={() => activeTab === 'diary' ? setDiaryView('grid') : setWatchlistView('grid')}
              className={`inline-flex items-center justify-center w-8 outline-none transition-colors ${(activeTab === 'diary' ? diaryView : watchlistView) === 'grid' ? 'bg-white/[0.15] text-white' : 'text-gray-500 hover:text-gray-300'}`}
              aria-label="Grid view"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zm10 0a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zm10 0a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z" />
              </svg>
            </button>
            <button
              type="button"
              onClick={() => activeTab === 'diary' ? setDiaryView('list') : setWatchlistView('list')}
              className={`inline-flex items-center justify-center w-8 outline-none transition-colors ${(activeTab === 'diary' ? diaryView : watchlistView) === 'list' ? 'bg-white/[0.15] text-white' : 'text-gray-500 hover:text-gray-300'}`}
              aria-label="List view"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
              </svg>
            </button>
          </div>
        </div>
        )}
      </div>

      {/* Mobile controls row — only visible on mobile, hidden on sm+ */}
      {activeTab !== 'lists' && (
        <div className="flex sm:hidden items-center justify-end gap-1.5 py-2 mb-4">
          {activeTab === 'diary' && (
            <select
              value={diarySort}
              onChange={e => setDiarySort(e.target.value as DiarySort)}
              aria-label="Sort diary"
              className="text-[11px] bg-white/5 border border-white/10 rounded px-1.5 py-1 h-9 text-gray-300 max-w-[90px]"
            >
              <option value="date-desc">Newest</option>
              <option value="date-asc">Oldest</option>
              <option value="rating-desc">Top Rated</option>
            </select>
          )}
          {activeTab === 'watchlist' && (
            <select
              value={watchlistSort}
              onChange={e => setWatchlistSort(e.target.value as WatchlistSort)}
              aria-label="Sort watchlist"
              className="text-[11px] bg-white/5 border border-white/10 rounded px-1.5 py-1 h-9 text-gray-300 max-w-[90px]"
            >
              <option value="added-desc">Recent</option>
              <option value="alphabetical">A-Z</option>
              <option value="closing-soon">Closing</option>
            </select>
          )}
          {/* Grid / List toggle */}
          <div className="inline-flex flex-shrink-0 rounded overflow-hidden bg-white/[0.04] border border-white/10 h-9">
            <button
              type="button"
              onClick={() => activeTab === 'diary' ? setDiaryView('grid') : setWatchlistView('grid')}
              className={`inline-flex items-center justify-center w-9 outline-none transition-colors ${(activeTab === 'diary' ? diaryView : watchlistView) === 'grid' ? 'bg-white/[0.15] text-white' : 'text-gray-500 hover:text-gray-300'}`}
              aria-label="Grid view"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zm10 0a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zm10 0a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z" />
              </svg>
            </button>
            <button
              type="button"
              onClick={() => activeTab === 'diary' ? setDiaryView('list') : setWatchlistView('list')}
              className={`inline-flex items-center justify-center w-9 outline-none transition-colors ${(activeTab === 'diary' ? diaryView : watchlistView) === 'list' ? 'bg-white/[0.15] text-white' : 'text-gray-500 hover:text-gray-300'}`}
              aria-label="List view"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
              </svg>
            </button>
          </div>
        </div>
      )}

      {/* Diary tab */}
      {activeTab === 'diary' && (
        <div id="panel-diary" role="tabpanel" aria-labelledby="tab-diary">
          {reviews.length === 0 && upcomingWatchlistEntries.length === 0 && toBeRatedEntries.length === 0 ? (
            <EmptyState
              icon="🎭"
              title="Your diary is empty"
              description="Start rating shows to build your personal theater diary!"
              ctaLabel="Browse Shows"
              ctaHref="/"
            />
          ) : (
            <>
              {/* To Be Rated — at top so users notice it */}
              {toBeRatedEntries.length > 0 && (
                <div className="mb-8">
                  <div className="flex items-center justify-between mb-1">
                    <h3 className="text-xs font-bold text-amber-400/80 uppercase tracking-wider">To Be Rated</h3>
                    <span className="text-[11px] text-gray-500">{toBeRatedEntries.length} {toBeRatedEntries.length === 1 ? 'entry' : 'entries'}</span>
                  </div>
                  <p className="text-xs text-gray-500 mb-3">You saw these shows — how were they?</p>
                  <div className="space-y-2">
                    {toBeRatedEntries.map(entry => (
                      <ToBeRatedCard key={`rate-${entry.id}`} entry={entry} show={showMap[entry.show_id]} />
                    ))}
                  </div>
                </div>
              )}

              {/* Upcoming section — watchlist entries with future dates + reviews with future date_seen */}
              {(upcomingWatchlistEntries.length > 0 || upcomingReviews.length > 0) && (
                <div className="mb-8">
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="text-xs font-bold text-gray-500 uppercase tracking-wider">Upcoming</h3>
                    <span className="text-[11px] text-gray-500">{upcomingWatchlistEntries.length + upcomingReviews.length} {(upcomingWatchlistEntries.length + upcomingReviews.length) === 1 ? 'entry' : 'entries'}</span>
                  </div>
                  {diaryView === 'list' ? (
                    <div className="space-y-2">
                      {upcomingWatchlistEntries.map(entry => {
                        const entryShow = showMap[entry.show_id];
                        const entryTitle = entryShow?.title || entry.show_id;
                        const entrySlug = entryShow?.slug || entry.show_id;
                        const entryCategory = entryShow?.category || 'broadway';
                        const entryHref = getShowHref(entrySlug, entryCategory);
                        const daysUntil = entry.planned_date
                          ? Math.ceil((new Date(entry.planned_date + 'T00:00:00').getTime() - new Date().getTime()) / (1000 * 60 * 60 * 24))
                          : null;
                        const entryFormattedDate = entry.planned_date
                          ? new Date(entry.planned_date + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
                          : null;
                        return (
                          <div key={`wl-${entry.id}`} className="relative flex items-center gap-3 px-3 sm:px-5 py-2.5 sm:py-3 rounded-xl bg-white/[0.02] border border-white/[0.06] hover:border-white/10 hover:bg-white/[0.04] transition-colors">
                            <Link href={entryHref} className="absolute inset-0 z-0" aria-label={`View ${entryTitle}`} />
                            <div className="relative z-[1] flex-shrink-0 w-14 sm:w-16 aspect-square rounded-lg overflow-hidden bg-surface-overlay pointer-events-none">
                              {entryShow?.posterUrl ? (
                                <img src={entryShow.posterUrl} alt="" className="w-full h-full object-cover" />
                              ) : (
                                <div className="w-full h-full flex items-center justify-center text-gray-600 text-xl">🎭</div>
                              )}
                            </div>
                            <div className="relative z-[1] flex-1 min-w-0 pointer-events-none">
                              <h4 className="font-bold text-white text-base truncate">{entryTitle}</h4>
                              {entryShow?.venue && <p className="text-sm text-gray-500 truncate">{entryShow.venue}</p>}
                            </div>
                            <div className="relative z-[1] flex-shrink-0 text-right pointer-events-none">
                              {entryFormattedDate && <p className="text-sm font-medium text-amber-400">{entryFormattedDate}</p>}
                              {daysUntil !== null && daysUntil > 0 && (
                                <p className="text-[10px] text-gray-500 mt-0.5">
                                  {daysUntil === 1 ? 'Tomorrow' : `${daysUntil}d`}
                                </p>
                              )}
                            </div>
                          </div>
                        );
                      })}
                      {upcomingReviews.map(review => (
                        <DiaryCard key={review.id} review={review} show={showMap[review.show_id]} onDelete={async () => { await effectiveDeleteReview(review.id); showToast?.('Rating deleted.', 'info'); }} />
                      ))}
                    </div>
                  ) : (
                    <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
                      {upcomingWatchlistEntries.map(entry => {
                        const entryShow = showMap[entry.show_id];
                        const entrySlug = entryShow?.slug || entry.show_id;
                        const entryCategory = entryShow?.category || 'broadway';
                        const entryHref = getShowHref(entrySlug, entryCategory);
                        const entryFormattedDate = entry.planned_date
                          ? new Date(entry.planned_date + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
                          : null;
                        return (
                          <UpcomingGridCard
                            key={`wl-grid-${entry.id}`}
                            href={entryHref}
                            posterUrl={entryShow?.posterUrl ?? undefined}
                            date={entryFormattedDate}
                            onRemove={async () => { await effectiveRemoveFromWatchlist(entry.show_id); showToast?.('Removed from watchlist.', 'info'); }}
                          />
                        );
                      })}
                      {upcomingReviews.map(review => (
                        <DiaryGridCard key={review.id} review={review} show={showMap[review.show_id]} onDelete={async () => { await effectiveDeleteReview(review.id); showToast?.('Rating deleted.', 'info'); }} />
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Past shows section — grouped by year (skipped when sorting by rating) */}
              {pastReviews.length > 0 && (() => {
                // When sorting by rating, show a flat list — year grouping doesn't apply
                if (diarySort === 'rating-desc') {
                  const hasOtherSections = upcomingReviews.length > 0 || upcomingWatchlistEntries.length > 0 || toBeRatedEntries.length > 0;
                  return (
                    <div>
                      {hasOtherSections && (
                        <div className="flex items-center justify-between mb-3">
                          <h3 className="text-xs font-bold text-gray-500 uppercase tracking-wider">All Rated</h3>
                          <span className="text-[11px] text-gray-500">{pastReviews.length} {pastReviews.length === 1 ? 'entry' : 'entries'}</span>
                        </div>
                      )}
                      {diaryView === 'list' ? (
                        <div className="space-y-2">
                          {pastReviews.map(review => (
                            <DiaryCard key={review.id} review={review} show={showMap[review.show_id]} onDelete={async () => { await effectiveDeleteReview(review.id); showToast?.('Rating deleted.', 'info'); }} />
                          ))}
                          <AddShowCard context="diary" variant="list" onOpen={() => {
                            const btn = document.querySelector<HTMLButtonElement>('[aria-label="Add a show to diary"], [aria-label="Rate a show"]');
                            btn?.click();
                          }} />
                        </div>
                      ) : (
                        <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
                          {pastReviews.map(review => (
                            <DiaryGridCard key={review.id} review={review} show={showMap[review.show_id]} onDelete={async () => { await effectiveDeleteReview(review.id); showToast?.('Rating deleted.', 'info'); }} />
                          ))}
                          <AddShowCard context="diary" onOpen={() => {
                            const btn = document.querySelector<HTMLButtonElement>('[aria-label="Add a show to diary"], [aria-label="Rate a show"]');
                            btn?.click();
                          }} />
                        </div>
                      )}
                    </div>
                  );
                }

                // Group past reviews by year (from date_seen or created_at)
                const reviewsByYear: Record<string, UserReview[]> = {};
                for (const review of pastReviews) {
                  const dateStr = review.date_seen || review.created_at;
                  const year = dateStr ? new Date(dateStr.includes('T') ? dateStr : dateStr + 'T00:00:00').getFullYear().toString() : 'Unknown';
                  if (!reviewsByYear[year]) reviewsByYear[year] = [];
                  reviewsByYear[year].push(review);
                }
                // Sort years descending (newest first), with 'Unknown' at end
                const sortedYears = Object.keys(reviewsByYear).sort((a, b) => {
                  if (a === 'Unknown') return 1;
                  if (b === 'Unknown') return -1;
                  return diarySort === 'date-asc' ? a.localeCompare(b) : b.localeCompare(a);
                });
                const hasOtherSections = upcomingReviews.length > 0 || upcomingWatchlistEntries.length > 0 || toBeRatedEntries.length > 0;
                const showYearHeaders = diaryView === 'grid' || sortedYears.length > 1 || hasOtherSections;

                return (
                  <>
                    {hasOtherSections && (
                      <div className="flex items-center justify-between mb-3">
                        <h3 className="text-xs font-bold text-gray-500 uppercase tracking-wider">Past Shows</h3>
                        <span className="text-[11px] text-gray-500">{pastReviews.length} {pastReviews.length === 1 ? 'entry' : 'entries'}</span>
                      </div>
                    )}
                    <div className="space-y-6">
                    {sortedYears.map((year, yearIdx) => (
                      <div key={year}>
                        {showYearHeaders && (
                          <div className={`flex items-center justify-between mb-3${diaryView === 'list' && yearIdx > 0 ? ' pt-4 border-t border-white/[0.06]' : ''}`}>
                            <h3 className="text-xs font-bold text-gray-500 uppercase tracking-wider">{year}</h3>
                            <span className="text-[11px] text-gray-500">{reviewsByYear[year].length} {reviewsByYear[year].length === 1 ? 'entry' : 'entries'}</span>
                          </div>
                        )}
                        {diaryView === 'list' ? (
                          <div className="space-y-2">
                            {reviewsByYear[year].map(review => (
                              <DiaryCard key={review.id} review={review} show={showMap[review.show_id]} onDelete={async () => { await effectiveDeleteReview(review.id); showToast?.('Rating deleted.', 'info'); }} />
                            ))}
                            {yearIdx === sortedYears.length - 1 && (
                              <AddShowCard context="diary" variant="list" onOpen={() => {
                                const btn = document.querySelector<HTMLButtonElement>('[aria-label="Add a show to diary"], [aria-label="Rate a show"]');
                                btn?.click();
                              }} />
                            )}
                          </div>
                        ) : (
                          <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
                            {reviewsByYear[year].map(review => (
                              <DiaryGridCard key={review.id} review={review} show={showMap[review.show_id]} onDelete={async () => { await effectiveDeleteReview(review.id); showToast?.('Rating deleted.', 'info'); }} />
                            ))}
                            {yearIdx === sortedYears.length - 1 && (
                              <AddShowCard context="diary" onOpen={() => {
                                const btn = document.querySelector<HTMLButtonElement>('[aria-label="Add a show to diary"], [aria-label="Rate a show"]');
                                btn?.click();
                              }} />
                            )}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                  </>
                );
              })()}
            </>
          )}
        </div>
      )}

      {/* Watchlist tab */}
      {activeTab === 'watchlist' && (
        <div id="panel-watchlist" role="tabpanel" aria-labelledby="tab-watchlist">
          {watchlist.length === 0 ? (
            <EmptyState
              icon="📋"
              title="Your watchlist is empty"
              description="Add shows you want to see!"
              ctaLabel="Browse Shows"
              ctaHref="/"
            />
          ) : watchlistSort === 'alphabetical' ? (
            /* Flat alphabetical list — no booked/unbooked split */
            watchlistView === 'grid' ? (
              <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
                {sortedWatchlist.map(entry => (
                  <WatchlistCard
                    key={entry.id}
                    entry={entry}
                    show={showMap[entry.show_id]}
                    onDateChange={(date) => effectiveUpdatePlannedDate(entry.show_id, date)}
                    onRemove={async () => { await effectiveRemoveFromWatchlist(entry.show_id); showToast?.('Removed from Watchlist.', 'info'); }}
                  />
                ))}
                <AddShowCard context="watchlist" onOpen={() => {
                  const btn = document.querySelector<HTMLButtonElement>('[aria-label="Add to watchlist"]');
                  btn?.click();
                }} />
              </div>
            ) : (
              <div className="space-y-2">
                {sortedWatchlist.map(entry => (
                  <WatchlistListItem
                    key={entry.id}
                    entry={entry}
                    show={showMap[entry.show_id]}
                    onDateChange={(date) => effectiveUpdatePlannedDate(entry.show_id, date)}
                    onRemove={async () => { await effectiveRemoveFromWatchlist(entry.show_id); showToast?.('Removed from Watchlist.', 'info'); }}
                  />
                ))}
                <AddShowCard context="watchlist" variant="list" onOpen={() => {
                  const btn = document.querySelector<HTMLButtonElement>('[aria-label="Add to watchlist"]');
                  btn?.click();
                }} />
              </div>
            )
          ) : (
            <div className="space-y-6">
              {/* Not yet booked section */}
              {unbookedWatchlist.length > 0 && (
                <div>
                  {bookedWatchlist.length > 0 && (
                    <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">Not yet booked</h3>
                  )}
                  {watchlistView === 'grid' ? (
                    <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
                      {unbookedWatchlist.map(entry => (
                        <WatchlistCard
                          key={entry.id}
                          entry={entry}
                          show={showMap[entry.show_id]}
                          onDateChange={(date) => effectiveUpdatePlannedDate(entry.show_id, date)}
                          onRemove={async () => { await effectiveRemoveFromWatchlist(entry.show_id); showToast?.('Removed from Watchlist.', 'info'); }}
                        />
                      ))}
                      <AddShowCard context="watchlist" onOpen={() => {
                        const btn = document.querySelector<HTMLButtonElement>('[aria-label="Add to watchlist"]');
                        btn?.click();
                      }} />
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {unbookedWatchlist.map(entry => (
                        <WatchlistListItem
                          key={entry.id}
                          entry={entry}
                          show={showMap[entry.show_id]}
                          onDateChange={(date) => effectiveUpdatePlannedDate(entry.show_id, date)}
                          onRemove={async () => { await effectiveRemoveFromWatchlist(entry.show_id); showToast?.('Removed from Watchlist.', 'info'); }}
                        />
                      ))}
                      <AddShowCard context="watchlist" variant="list" onOpen={() => {
                        const btn = document.querySelector<HTMLButtonElement>('[aria-label="Add to watchlist"]');
                        btn?.click();
                      }} />
                    </div>
                  )}
                </div>
              )}

              {/* Booked section */}
              {bookedWatchlist.length > 0 && (
                <div>
                  <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">Booked</h3>
                  {watchlistView === 'grid' ? (
                    <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
                      {bookedWatchlist.map(entry => (
                        <WatchlistCard
                          key={entry.id}
                          entry={entry}
                          show={showMap[entry.show_id]}
                          onDateChange={(date) => effectiveUpdatePlannedDate(entry.show_id, date)}
                          onRemove={async () => { await effectiveRemoveFromWatchlist(entry.show_id); showToast?.('Removed from Watchlist.', 'info'); }}
                        />
                      ))}
                      {unbookedWatchlist.length === 0 && (
                        <AddShowCard context="watchlist" onOpen={() => {
                          const btn = document.querySelector<HTMLButtonElement>('[aria-label="Add to watchlist"]');
                          btn?.click();
                        }} />
                      )}
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {bookedWatchlist.map(entry => (
                        <WatchlistListItem
                          key={entry.id}
                          entry={entry}
                          show={showMap[entry.show_id]}
                          onDateChange={(date) => effectiveUpdatePlannedDate(entry.show_id, date)}
                          onRemove={async () => { await effectiveRemoveFromWatchlist(entry.show_id); showToast?.('Removed from Watchlist.', 'info'); }}
                        />
                      ))}
                      {unbookedWatchlist.length === 0 && (
                        <AddShowCard context="watchlist" variant="list" onOpen={() => {
                          const btn = document.querySelector<HTMLButtonElement>('[aria-label="Add to watchlist"]');
                          btn?.click();
                        }} />
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Lists tab */}
      {activeTab === 'lists' && (
        <div id="panel-lists" role="tabpanel" aria-labelledby="tab-lists">
          <ListsTab userId={user?.id || null} showMap={showMap} isMockMode={isMockMode} createTrigger={createListTrigger} />
        </div>
      )}
    </div>
  );
}

function DiaryCard({ review, show, onDelete }: { review: UserReview; show?: ShowLookup; onDelete?: () => void }) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  // Auto-dismiss delete confirmation after 4 seconds
  useEffect(() => {
    if (!confirmDelete) return;
    const timer = setTimeout(() => setConfirmDelete(false), 4000);
    return () => clearTimeout(timer);
  }, [confirmDelete]);
  const title = show?.title || review.show_id;
  const slug = show?.slug || review.show_id;
  const category = show?.category || 'broadway';
  const href = getShowHref(slug, category);

  return (
    <div className="group/diary relative flex items-center gap-3 px-3 sm:px-5 py-2.5 sm:py-3 rounded-xl bg-white/[0.02] border border-white/[0.06] hover:border-white/10 hover:bg-white/[0.04] transition-colors">
      {/* Link overlay for the whole card */}
      <Link href={href} className="absolute inset-0 z-0" aria-label={`View ${title}`} />

      {/* Poster — square thumbnail to match homepage cards */}
      <div className="relative z-[1] pointer-events-none flex-shrink-0 w-14 sm:w-16 aspect-square rounded-lg overflow-hidden bg-surface-overlay">
        {show?.posterUrl ? (
          <img src={show.posterUrl} alt="" className="w-full h-full object-cover" />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-gray-600 text-xl">🎭</div>
        )}
      </div>

      {/* Info — date above review text, consistent font sizes */}
      <div className="relative z-[1] pointer-events-none flex-1 min-w-0">
        <h4 className="font-bold text-white text-base group-hover/diary:text-brand transition-colors truncate">{title}</h4>
        {show?.venue && <p className="text-sm text-gray-500 truncate">{show.venue}</p>}
        {review.date_seen && (
          <p className="text-xs text-amber-400 mt-0.5">
            {new Date(review.date_seen + 'T00:00:00').toLocaleDateString('en-US', {
              month: 'short',
              day: 'numeric',
              year: 'numeric',
            })}
          </p>
        )}
        {review.review_text && (
          <p className="text-xs text-gray-500 mt-0.5 line-clamp-1 italic">{review.review_text}</p>
        )}
      </div>

      {/* Rating + actions — single row */}
      <div className="relative z-[1] pointer-events-none flex-shrink-0 flex items-center gap-1.5">
        {/* Single star + number on mobile, full stars on desktop */}
        <span className="md:hidden flex items-center gap-1">
          <svg className="w-5 h-5 text-amber-400" fill="currentColor" viewBox="0 0 20 20"><path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" /></svg>
          <span className="text-base font-bold text-amber-400">{review.rating % 1 === 0 ? review.rating.toFixed(0) : review.rating.toFixed(1)}</span>
        </span>
        <span className="hidden md:inline-flex"><StarRating rating={review.rating} onRatingChange={() => {}} size="sm" readOnly hideLabel /></span>
        {/* Edit + delete icons — inline next to rating */}
        <div className="flex items-center gap-0.5 opacity-100 sm:opacity-0 sm:group-hover/diary:opacity-100 transition-opacity pointer-events-auto">
          <Link
            href={`${href}?edit=1`}
            className="p-1 rounded-full text-gray-600 hover:text-white transition-colors"
            aria-label="Edit rating"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
            </svg>
          </Link>
          {onDelete && !confirmDelete && (
            <button
              type="button"
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); setConfirmDelete(true); }}
              className="relative z-[1] p-1 rounded-full text-gray-600 hover:text-red-400 transition-colors"
              aria-label="Delete rating"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
            </button>
          )}
          {confirmDelete && (
            <span className="relative z-[1] flex items-center gap-1 text-[10px]">
              <button type="button" onClick={(e) => { e.preventDefault(); e.stopPropagation(); onDelete?.(); }} className="text-red-400 hover:text-red-300 font-medium">Delete?</button>
              <button type="button" onClick={(e) => { e.preventDefault(); e.stopPropagation(); setConfirmDelete(false); }} className="text-gray-500 hover:text-white">No</button>
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function UpcomingGridCard({ href, posterUrl, date, onRemove }: { href: string; posterUrl?: string; date: string | null; onRemove: () => void }) {
  const [confirmRemove, setConfirmRemove] = useState(false);
  useEffect(() => {
    if (!confirmRemove) return;
    const timer = setTimeout(() => setConfirmRemove(false), 4000);
    return () => clearTimeout(timer);
  }, [confirmRemove]);

  return (
    <div className="group/grid flex flex-col rounded-xl bg-white/[0.02] border border-white/[0.06] hover:border-white/10 hover:bg-white/[0.04] transition-colors overflow-hidden">
      <Link href={href} className="relative">
        <div className="aspect-[2/3] bg-surface-overlay">
          {posterUrl ? (
            <img src={posterUrl} alt="" className="w-full h-full object-cover" />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-gray-600 text-3xl">🎭</div>
          )}
        </div>
        {/* Remove button — hidden on mobile, visible on hover on desktop */}
        <button
          type="button"
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); confirmRemove ? onRemove() : setConfirmRemove(true); }}
          className={`absolute top-2 right-2 z-[2] w-7 h-7 hidden sm:flex items-center justify-center rounded-full ${confirmRemove ? 'bg-red-500/80 text-white opacity-100' : 'bg-black/70 text-gray-400 hover:text-red-400 opacity-0 group-hover/grid:opacity-100'} transition-opacity`}
          aria-label="Remove from upcoming"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
          </svg>
        </button>
      </Link>
      {date && (
        <div className="px-2 py-1.5 text-center">
          <p className="text-[11px] font-medium text-amber-400 truncate">{date}</p>
        </div>
      )}
    </div>
  );
}

function DiaryGridCard({ review, show, onDelete }: { review: UserReview; show?: ShowLookup; onDelete?: () => void }) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => {
    if (!confirmDelete) return;
    const timer = setTimeout(() => setConfirmDelete(false), 4000);
    return () => clearTimeout(timer);
  }, [confirmDelete]);
  const title = show?.title || review.show_id;
  const slug = show?.slug || review.show_id;
  const category = show?.category || 'broadway';
  const href = getShowHref(slug, category);

  return (
    <div className="group/grid flex flex-col rounded-xl bg-white/[0.02] border border-white/[0.06] hover:border-white/10 hover:bg-white/[0.04] transition-colors overflow-hidden">
      <Link href={href} className="relative">
        <div className="aspect-[2/3] bg-surface-overlay">
          {show?.posterUrl ? (
            <img src={show.posterUrl} alt="" className="w-full h-full object-cover" />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-gray-600 text-3xl">🎭</div>
          )}
        </div>
        {/* Delete button — hidden on mobile, visible on hover on desktop */}
        {onDelete && (
          <button
            type="button"
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); confirmDelete ? onDelete() : setConfirmDelete(true); }}
            className={`absolute top-2 right-2 z-[2] w-7 h-7 hidden sm:flex items-center justify-center rounded-full ${confirmDelete ? 'bg-red-500/80 text-white opacity-100' : 'bg-black/70 text-gray-400 hover:text-red-400 opacity-0 group-hover/grid:opacity-100'} transition-opacity`}
            aria-label="Delete rating"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
          </button>
        )}
      </Link>
      {/* Stars below image — centered, filled only (Mezzanine-style) */}
      <div className="px-2 py-1.5">
        <div className="flex justify-center gap-0.5 min-h-[18px]">
          {review.rating > 0 && <MiniStars rating={review.rating} size="md" filledOnly />}
        </div>
      </div>
    </div>
  );
}

function WatchlistCard({ entry, show, onDateChange, onRemove }: {
  entry: WatchlistEntry;
  show?: ShowLookup;
  onDateChange: (date: string | null) => void;
  onRemove: () => void;
}) {
  const [confirmRemove, setConfirmRemove] = useState(false);
  useEffect(() => {
    if (!confirmRemove) return;
    const timer = setTimeout(() => setConfirmRemove(false), 4000);
    return () => clearTimeout(timer);
  }, [confirmRemove]);
  const title = show?.title || entry.show_id;
  const slug = show?.slug || entry.show_id;
  const category = show?.category || 'broadway';
  const href = getShowHref(slug, category);

  const isClosingSoon = show?.closingDate && (() => {
    const closing = new Date(show.closingDate!);
    const now = new Date();
    const fourWeeks = 28 * 24 * 60 * 60 * 1000;
    return closing.getTime() - now.getTime() < fourWeeks && closing > now;
  })();

  const formattedDate = entry.planned_date
    ? new Date(entry.planned_date + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    : null;

  return (
    <div className="group/wl flex flex-col rounded-xl bg-white/[0.02] border border-white/[0.06] hover:border-white/10 hover:bg-white/[0.04] transition-colors overflow-hidden">
      <Link href={href} className="relative">
        <div className="aspect-[2/3] bg-surface-overlay relative">
          {show?.posterUrl ? (
            <img src={show.posterUrl} alt="" className="w-full h-full object-cover" />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-gray-600 text-3xl">🎭</div>
          )}
          {isClosingSoon && (
            <span className="absolute bottom-1.5 left-1.5 px-1.5 py-0.5 text-[9px] font-bold uppercase bg-amber-500/90 text-black rounded">
              Closing Soon
            </span>
          )}
        </div>
        {/* Rate overlay — navigates to show page with ?rate=1 to auto-open rating */}
        {/* On mobile: "Rate" button at bottom; on desktop: 5 empty stars on hover */}
        <div
          role="button"
          tabIndex={0}
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); window.location.href = `${href}?rate=1`; }}
          onKeyDown={(e) => { if (e.key === 'Enter') { window.location.href = `${href}?rate=1`; } }}
          className="absolute inset-0 flex items-center justify-center bg-black/50 opacity-0 sm:group-hover/wl:opacity-100 transition-opacity z-[1] cursor-pointer"
        >
          <span className="hidden sm:flex items-center gap-0.5">
            {[1,2,3,4,5].map(i => (
              <svg key={i} className="w-5 h-5" viewBox="0 0 24 24" fill="none">
                <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" fill="none" stroke="#FFD700" strokeWidth="1.5" strokeLinejoin="round" />
              </svg>
            ))}
          </span>
        </div>
        {/* Mobile-only: small Rate button at bottom */}
        <div className="sm:hidden absolute inset-x-0 bottom-0 flex items-end justify-center pb-2 bg-gradient-to-t from-black/60 via-transparent to-transparent z-[1]">
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); window.location.href = `${href}?rate=1`; }}
            onKeyDown={(e) => { if (e.key === 'Enter') { window.location.href = `${href}?rate=1`; } }}
            className="text-[10px] font-semibold text-white/90 flex items-center gap-1 cursor-pointer"
          >
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
            </svg>
            Rate
          </span>
        </div>
        {/* Trash button to remove — hidden on mobile, visible on hover on desktop */}
        <button
          type="button"
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); confirmRemove ? onRemove() : setConfirmRemove(true); }}
          className={`absolute top-2 right-2 z-[2] w-7 h-7 hidden sm:flex items-center justify-center rounded-full ${confirmRemove ? 'bg-red-500/80 text-white opacity-100' : 'bg-black/70 text-gray-400 hover:text-red-400 opacity-0 group-hover/wl:opacity-100'} transition-opacity`}
          aria-label="Remove from watchlist"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
          </svg>
        </button>
      </Link>
      <div className="px-2 py-1.5">
        <DatePickerButton
          value={entry.planned_date || ''}
          label={formattedDate || 'Add date'}
          hasDate={!!formattedDate}
          onChange={(val) => onDateChange(val || null)}
        />
      </div>
    </div>
  );
}

/** Render mini star icons for grid cards (filled, half, empty — or filled-only) */
function MiniStars({ rating, size = 'sm', filledOnly = false }: { rating: number; size?: 'sm' | 'md' | 'lg'; filledOnly?: boolean }) {
  const uid = useId();
  const starClass = size === 'lg' ? 'w-5 h-5 sm:w-6 sm:h-6' : size === 'md' ? 'w-4.5 h-4.5 sm:w-5 sm:h-5' : 'w-3.5 h-3.5';
  const stars = [];
  for (let i = 1; i <= 5; i++) {
    if (i <= Math.floor(rating)) {
      stars.push(<svg key={i} className={`${starClass} text-amber-400`} fill="currentColor" viewBox="0 0 20 20"><path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" /></svg>);
    } else if (i === Math.ceil(rating) && rating % 1 !== 0) {
      stars.push(
        <svg key={i} className={starClass} viewBox="0 0 20 20">
          <defs><clipPath id={`${uid}-${i}`}><rect x="0" y="0" width="10" height="20" /></clipPath></defs>
          <path className="text-gray-600" fill="currentColor" d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
          <path className="text-amber-400" fill="currentColor" clipPath={`url(#${uid}-${i})`} d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
        </svg>
      );
    } else if (!filledOnly) {
      stars.push(<svg key={i} className={`${starClass} text-gray-600`} fill="currentColor" viewBox="0 0 20 20"><path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" /></svg>);
    }
  }
  return <>{stars}</>;
}

/** Reusable date picker button — works reliably on iOS Safari */
function DatePickerButton({ value, label, hasDate, onChange }: { value: string; label: string; hasDate?: boolean; onChange: (val: string) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <div className="relative mt-1">
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          try { inputRef.current?.showPicker(); } catch { inputRef.current?.focus(); }
        }}
        className={`w-full flex items-center justify-center gap-1 sm:gap-1.5 text-[11px] sm:text-xs transition-colors cursor-pointer min-h-[32px] sm:min-h-[36px] px-1.5 sm:px-2 rounded-lg ${
          hasDate
            ? 'text-amber-400 hover:text-amber-300'
            : 'text-gray-400 hover:text-gray-300 bg-white/[0.03] border border-white/[0.06] hover:border-white/10'
        }`}
      >
        {!hasDate && (
          <svg className="w-3.5 h-3.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
          </svg>
        )}
        <span className={`truncate ${hasDate ? 'font-medium' : ''}`}>{label}</span>
      </button>
      <input
        ref={inputRef}
        type="date"
        value={value}
        onChange={e => { e.stopPropagation(); onChange(e.target.value); }}
        className="absolute inset-0 opacity-0 pointer-events-none"
        tabIndex={-1}
      />
    </div>
  );
}

function WatchlistListItem({ entry, show, onDateChange, onRemove }: {
  entry: WatchlistEntry;
  show?: ShowLookup;
  onDateChange: (date: string | null) => void;
  onRemove: () => void;
}) {
  const [confirmRemove, setConfirmRemove] = useState(false);
  useEffect(() => {
    if (!confirmRemove) return;
    const timer = setTimeout(() => setConfirmRemove(false), 4000);
    return () => clearTimeout(timer);
  }, [confirmRemove]);
  const title = show?.title || entry.show_id;
  const slug = show?.slug || entry.show_id;
  const category = show?.category || 'broadway';
  const href = getShowHref(slug, category);

  const isClosingSoon = show?.closingDate && (() => {
    const closing = new Date(show.closingDate!);
    const now = new Date();
    const fourWeeks = 28 * 24 * 60 * 60 * 1000;
    return closing.getTime() - now.getTime() < fourWeeks && closing > now;
  })();

  const formattedDate = entry.planned_date
    ? new Date(entry.planned_date + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    : null;

  return (
    <div className="group/wl relative flex items-center gap-3 px-3 sm:px-5 py-2.5 sm:py-3 rounded-xl bg-white/[0.02] border border-white/[0.06] hover:border-white/10 hover:bg-white/[0.04] transition-colors">
      <Link href={href} className="absolute inset-0 z-0" aria-label={`View ${title}`} />

      <div className="relative z-[1] flex-shrink-0 w-14 sm:w-16 aspect-square rounded-lg overflow-hidden bg-surface-overlay">
        {show?.posterUrl ? (
          <img src={show.posterUrl} alt="" className="w-full h-full object-cover" />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-gray-600 text-xl">🎭</div>
        )}
      </div>

      <div className="relative z-[1] flex-1 min-w-0">
        <h4 className="font-bold text-white text-base group-hover/wl:text-brand transition-colors truncate">{title}</h4>
        {show?.venue && <p className="text-sm text-gray-500 truncate">{show.venue}</p>}
        {isClosingSoon && (
          <span className="inline-block mt-1 px-1.5 py-0.5 text-[9px] font-bold uppercase bg-amber-500/90 text-black rounded">Closing Soon</span>
        )}
        {show?.closingDate && (
          <p className="text-[10px] text-gray-500 mt-1">
            Closes {new Date(show.closingDate + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
          </p>
        )}
      </div>

      <div className="relative z-[1] flex-shrink-0 flex flex-col items-end gap-1">
        <DatePickerButton
          value={entry.planned_date || ''}
          label={formattedDate || 'Add date'}
          hasDate={!!formattedDate}
          onChange={(val) => onDateChange(val || null)}
        />
        {/* Rate + Remove row */}
        <div className="flex items-center gap-2">
          <Link
            href={`${href}?rate=1`}
            className="relative z-[1] text-[11px] sm:text-xs text-gray-500 hover:text-amber-400 transition-colors flex items-center gap-1"
          >
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
            </svg>
            Rate
          </Link>
          {confirmRemove ? (
            <span className="relative z-[1] flex items-center gap-1 text-[10px]">
              <button type="button" onClick={(e) => { e.preventDefault(); e.stopPropagation(); onRemove(); }} className="text-red-400 hover:text-red-300 font-medium">Remove?</button>
              <button type="button" onClick={(e) => { e.preventDefault(); e.stopPropagation(); setConfirmRemove(false); }} className="text-gray-500 hover:text-white">No</button>
            </span>
          ) : (
            <button
              type="button"
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); setConfirmRemove(true); }}
              className="relative z-[1] p-1 text-gray-600 hover:text-red-400 transition-colors"
              aria-label="Remove from watchlist"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

interface SearchShow {
  id: string;
  title: string;
  slug: string;
  status: string;
  venue?: string;
  city?: string;
  od?: string; // openingDate (YYYY-MM-DD)
  images?: { thumbnail?: string };
  category?: string;
}

function AddShowSearch({
  context,
  onAddToWatchlist,
  existingWatchlistIds,
  existingReviewIds,
}: {
  context: 'diary' | 'watchlist';
  onAddToWatchlist: (showId: string) => Promise<void>;
  existingWatchlistIds: Set<string>;
  existingReviewIds: Set<string>;
}) {
  const router = useRouter();
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const [addingId, setAddingId] = useState<string | null>(null);

  // Close on outside click
  useEffect(() => {
    if (!isOpen) return;
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [isOpen]);

  const handleSelect = async (show: { id: string; slug: string }) => {
    if (context === 'watchlist') {
      if (!existingWatchlistIds.has(show.id)) {
        setAddingId(show.id);
        try {
          await onAddToWatchlist(show.id);
        } finally {
          setAddingId(null);
        }
      }
    } else {
      router.push(`/show/${show.slug}?rate=1`);
    }
    setIsOpen(false);
  };

  if (!isOpen) {
    return (
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-gray-400 hover:text-white bg-white/[0.06] hover:bg-white/10 border border-white/10 transition-colors text-xs font-medium"
        aria-label={context === 'diary' ? 'Add a show to diary' : 'Add to watchlist'}
        title={context === 'diary' ? 'Rate a show' : 'Add to watchlist'}
      >
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
        </svg>
        <span>Add show</span>
      </button>
    );
  }

  return (
    <div ref={containerRef} className="relative">
      <ShowSearchDropdown
        placeholder={context === 'diary' ? 'Search to rate...' : 'Search to add...'}
        onSelect={handleSelect}
        onClose={() => setIsOpen(false)}
        align="right"
        isDisabled={(show) => addingId === show.id}
        renderAction={(show) => {
          if (context === 'diary') {
            return existingReviewIds.has(show.id)
              ? <span className="text-green-400">Rated</span>
              : <span>Rate</span>;
          }
          if (addingId === show.id) return <span className="animate-pulse">Adding...</span>;
          if (existingWatchlistIds.has(show.id)) return <span className="text-green-400">Added</span>;
          return <span>+ Add</span>;
        }}
      />
    </div>
  );
}

/** "To Be Rated" card with inline interactive stars */
function ToBeRatedCard({ entry, show }: { entry: WatchlistEntry; show?: ShowLookup }) {
  const router = useRouter();
  const title = show?.title || entry.show_id;
  const slug = show?.slug || entry.show_id;
  const category = show?.category || 'broadway';
  const href = getShowHref(slug, category);

  return (
    <div className="relative flex items-center gap-3 px-3 sm:px-5 py-3 rounded-xl bg-amber-500/[0.03] border border-amber-500/10 hover:border-amber-500/20 hover:bg-amber-500/[0.06] transition-colors">
      <Link href={href} className="absolute inset-0 z-0" aria-label={`Rate ${title}`} />
      <div className="relative z-[1] flex-shrink-0 w-14 sm:w-16 aspect-square rounded-lg overflow-hidden bg-surface-overlay pointer-events-none">
        {show?.posterUrl ? (
          <img src={show.posterUrl} alt="" className="w-full h-full object-cover" />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-gray-600 text-xl">🎭</div>
        )}
      </div>
      <div className="relative z-[1] flex-1 min-w-0 pointer-events-none">
        <h4 className="font-bold text-white text-base truncate">{title}</h4>
        {show?.venue && <p className="text-sm text-gray-500 truncate">{show.venue}</p>}
        {entry.planned_date && (
          <p className="text-xs text-amber-400 mt-0.5 whitespace-nowrap">
            Saw {new Date(entry.planned_date + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
          </p>
        )}
      </div>
      <div className="relative z-[2] flex-shrink-0 pointer-events-auto">
        {/* xs stars on mobile, md on desktop */}
        <span className="sm:hidden">
          <StarRating
            rating={null}
            onRatingChange={(rating) => {
              router.push(`${href}?rate=1&stars=${rating}`);
            }}
            size="xs"
          />
        </span>
        <span className="hidden sm:inline-flex">
          <StarRating
            rating={null}
            onRatingChange={(rating) => {
              router.push(`${href}?rate=1&stars=${rating}`);
            }}
            size="md"
          />
        </span>
      </div>
    </div>
  );
}

/** (+) card to add shows — placed at end of grid views */
function AddShowCard({ context, variant = 'grid', onOpen }: { context: 'diary' | 'watchlist'; variant?: 'grid' | 'list'; onOpen: () => void }) {
  if (variant === 'list') {
    return (
      <button
        type="button"
        onClick={onOpen}
        className="flex items-center justify-center gap-2 w-full px-4 py-3 rounded-xl border-2 border-dashed border-white/10 hover:border-white/20 hover:bg-white/[0.03] transition-colors text-gray-500 hover:text-gray-300"
        aria-label={context === 'diary' ? 'Rate a new show' : 'Add a new show to watchlist'}
      >
        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
        </svg>
        <span className="text-xs font-medium">{context === 'diary' ? 'Rate a show' : 'Add a show'}</span>
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex flex-col rounded-xl border-2 border-dashed border-white/10 hover:border-white/20 hover:bg-white/[0.03] transition-colors text-gray-500 hover:text-gray-300 overflow-hidden"
      aria-label={context === 'diary' ? 'Rate a new show' : 'Add a new show to watchlist'}
    >
      {/* Placeholder area matching image aspect ratio */}
      <div className="aspect-[2/3] flex flex-col items-center justify-center">
        <svg className="w-8 h-8 mb-1" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
        </svg>
        <span className="text-[10px] font-medium">{context === 'diary' ? 'Rate' : 'Add'}</span>
      </div>
      {/* Spacer matching content area below images on real cards */}
      <div className="px-2 py-1.5">&nbsp;</div>
    </button>
  );
}

function EmptyState({
  icon,
  title,
  description,
  ctaLabel,
  ctaHref,
}: {
  icon: string;
  title: string;
  description: string;
  ctaLabel: string;
  ctaHref: string;
}) {
  return (
    <div className="text-center py-16">
      <div className="text-4xl mb-3">{icon}</div>
      <h3 className="text-lg font-bold text-white mb-1">{title}</h3>
      <p className="text-sm text-gray-400 mb-4">{description}</p>
      <Link
        href={ctaHref}
        className="inline-block px-5 py-2.5 text-sm font-semibold text-black bg-[#FFD700] rounded-lg hover:bg-[#e6c200] transition-colors"
      >
        {ctaLabel}
      </Link>
    </div>
  );
}
