'use client';

import { useState, useEffect, useMemo, useRef, useCallback, useDeferredValue } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { featureFlags } from '@/config/feature-flags';
import { useAuth } from '@/contexts/AuthContext';
import { useUserReviews } from '@/hooks/useUserReviews';
import { useWatchlist } from '@/hooks/useWatchlist';
import StarRating from '@/components/user/StarRating';
import { FormatPill, StatusBadge } from '@/components/show-cards';
import { useToastSafe } from '@/components/ui/Toast';
import type { UserReview, WatchlistEntry, ShowLookup } from '@/types/user';
import type Fuse from 'fuse.js';
import MezzanineImport from './MezzanineImport';

type Tab = 'diary' | 'watchlist';
type DiarySort = 'date-desc' | 'date-asc' | 'rating-desc';
type WatchlistSort = 'added-desc' | 'alphabetical' | 'closing-soon';
type ViewMode = 'grid' | 'list';

const MEZZ_IMG_PREFIX = 'https://www.theaterdiary.com/parse/files/C7TsezAg3jnX9jHLsC9KFEteyKePkwLtB46dDpfh/';
function expandMezzImg(compact: string | undefined | null): string | null {
  if (!compact) return null;
  if (compact.startsWith('http')) return compact;
  return MEZZ_IMG_PREFIX + compact;
}

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
    posterUrl: (raw.p as string) || expandMezzImg(raw.img as string) || null,
    diaryOnly: !!raw.dy,
  };
}

function getShowHref(slug: string, _category: string, diaryOnly?: boolean): string | null {
  if (diaryOnly) return null; // Diary-only shows have no show page
  return `/show/${slug}`;
}

// Wrapper components for diary-only show link suppression
function ShowCardOverlay({ href, label }: { href: string | null; label: string }) {
  if (href) return <Link href={href} className="absolute inset-0 z-0" aria-label={`View ${label}`} />;
  return null;
}

function ShowCardPosterLink({ href, children, className }: { href: string | null; children: React.ReactNode; className?: string }) {
  if (href) return <Link href={href} className={className}>{children}</Link>;
  return <div className={className}>{children}</div>;
}

export default function MyShowsClient() {
  const searchParams = useSearchParams();
  const [activeTab, setActiveTabState] = useState<Tab>(searchParams.get('tab') === 'watchlist' ? 'watchlist' : 'diary');

  // Dev-only mock mode: ?mock=1 on localhost renders with fake data (for Playwright visual QA)
  // Must be state (not derived) to avoid SSR/client hydration mismatch
  const [isMockMode, setIsMockMode] = useState(false);
  useEffect(() => {
    if (window.location.hostname === 'localhost' && searchParams.get('mock') === '1') {
      setIsMockMode(true);
    }
  }, [searchParams]);

  // Update URL when tab changes so back button restores the correct tab
  const setActiveTab = (tab: Tab) => {
    setActiveTabState(tab);
    const mockParam = isMockMode ? '&mock=1' : '';
    const url = tab === 'watchlist' ? `/my-shows?tab=watchlist${mockParam}` : `/my-shows${mockParam ? `?${mockParam.slice(1)}` : ''}`;
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

  // Lazy-load diary show lookup when user has entries referencing unknown show IDs
  const diaryLookupLoaded = useRef(false);
  useEffect(() => {
    if (!showMapLoaded || diaryLookupLoaded.current) return;
    const allShowIds = new Set([
      ...reviews.map(r => r.show_id),
      ...watchlist.map(w => w.show_id),
    ]);
    const hasUnknown = Array.from(allShowIds).some(id => !showMap[id]);
    if (!hasUnknown) return;

    diaryLookupLoaded.current = true;
    fetch('/data/diary-lookup.json')
      .then(res => res.json())
      .then((data: Record<string, unknown>[]) => {
        setShowMap(prev => {
          const next = { ...prev };
          for (const raw of data) {
            const show = decodeShow(raw);
            if (!next[show.id]) next[show.id] = show;
          }
          return next;
        });
      })
      .catch(() => { /* diary-lookup.json may not exist yet */ });
  }, [showMapLoaded, reviews, watchlist, showMap]);

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
        return sorted.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
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
    <div className="max-w-3xl mx-auto px-4 sm:px-6 pt-6 sm:pt-8 pb-12">
      {/* Header */}
      <div className="flex items-center justify-between mb-2">
        <h1 className="text-2xl sm:text-3xl font-extrabold text-white">My Shows</h1>
        <AddShowSearch
          context={activeTab}
          onAddToWatchlist={async (showId: string) => {
            await addToWatchlist(showId);
            await getWatchlist();
            showToast?.(<>Added to <a href="/my-shows?tab=watchlist" className="underline hover:text-white/90">Watchlist</a></>, 'success');
          }}
          existingWatchlistIds={new Set(watchlist.map(w => w.show_id))}
          existingReviewIds={new Set(reviews.map(r => r.show_id))}
        />
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

      {/* Tab bar + inline sort/view controls */}
      <div role="tablist" className="flex items-center gap-1 border-b border-white/10 mb-6">
        <button
          type="button"
          role="tab"
          id="tab-diary"
          aria-selected={activeTab === 'diary'}
          aria-controls="panel-diary"
          onClick={() => setActiveTab('diary')}
          className={`flex-shrink-0 px-3 sm:px-4 py-2.5 text-sm font-semibold transition-colors border-b-2 -mb-[1px] ${
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
          className={`flex-shrink-0 px-3 sm:px-4 py-2.5 text-sm font-semibold transition-colors border-b-2 -mb-[1px] ${
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

        {/* Inline controls on the right */}
        <div className="ml-auto flex items-center gap-1.5 sm:gap-2 -mb-[1px] pb-1">
          {activeTab === 'diary' && (
            <select
              value={diarySort}
              onChange={e => setDiarySort(e.target.value as DiarySort)}
              aria-label="Sort diary"
              className="text-[11px] sm:text-xs bg-white/5 border border-white/10 rounded px-1.5 sm:px-2 py-1 text-gray-300 max-w-[110px] sm:max-w-none"
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
              className="text-[11px] sm:text-xs bg-white/5 border border-white/10 rounded px-1.5 sm:px-2 py-1 text-gray-300 max-w-[110px] sm:max-w-none"
            >
              <option value="added-desc">Recent</option>
              <option value="alphabetical">A-Z</option>
              <option value="closing-soon">Closing</option>
            </select>
          )}
          {/* Grid / List toggle — both tabs */}
          <div className="flex flex-shrink-0 rounded-lg overflow-hidden bg-white/[0.04] border border-white/10">
            <button
              type="button"
              onClick={() => activeTab === 'diary' ? setDiaryView('grid') : setWatchlistView('grid')}
              className={`flex items-center justify-center w-9 h-9 sm:w-8 sm:h-8 transition-colors ${(activeTab === 'diary' ? diaryView : watchlistView) === 'grid' ? 'bg-white/[0.15] text-white' : 'text-gray-500 hover:text-gray-300'}`}
              aria-label="Grid view"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zm10 0a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zm10 0a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z" />
              </svg>
            </button>
            <button
              type="button"
              onClick={() => activeTab === 'diary' ? setDiaryView('list') : setWatchlistView('list')}
              className={`flex items-center justify-center w-9 h-9 sm:w-8 sm:h-8 transition-colors ${(activeTab === 'diary' ? diaryView : watchlistView) === 'list' ? 'bg-white/[0.15] text-white' : 'text-gray-500 hover:text-gray-300'}`}
              aria-label="List view"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
              </svg>
            </button>
          </div>
        </div>
      </div>

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
                  <h3 className="text-xs font-bold text-amber-400/80 uppercase tracking-wider mb-1">To Be Rated</h3>
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
                  <h3 className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-3">Upcoming</h3>
                  <div className="space-y-2">
                    {upcomingWatchlistEntries.map(entry => {
                      const entryShow = showMap[entry.show_id];
                      const entryTitle = entryShow?.title || entry.show_id;
                      const entrySlug = entryShow?.slug || entry.show_id;
                      const entryCategory = entryShow?.category || 'broadway';
                      const entryHref = getShowHref(entrySlug, entryCategory, entryShow?.diaryOnly);
                      const daysUntil = entry.planned_date
                        ? Math.ceil((new Date(entry.planned_date + 'T00:00:00').getTime() - new Date().getTime()) / (1000 * 60 * 60 * 24))
                        : null;
                      const entryFormattedDate = entry.planned_date
                        ? new Date(entry.planned_date + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
                        : null;
                      return (
                        <div key={`wl-${entry.id}`} className="relative flex items-center gap-2 sm:gap-4 px-3 sm:px-5 py-2.5 sm:py-3 rounded-xl bg-white/[0.02] border border-white/[0.06] hover:border-white/10 hover:bg-white/[0.04] transition-colors">
                          <ShowCardOverlay href={entryHref} label={entryTitle} />
                          <div className="relative z-[1] flex-shrink-0 w-10 sm:w-16 aspect-[2/3] rounded-lg overflow-hidden bg-surface-overlay pointer-events-none">
                            {entryShow?.posterUrl ? (
                              <img src={entryShow.posterUrl} alt="" className="w-full h-full object-cover" />
                            ) : (
                              <div className="w-full h-full flex items-center justify-center text-gray-600 text-xl">🎭</div>
                            )}
                          </div>
                          <div className="relative z-[1] flex-1 min-w-0 pointer-events-none">
                            <h4 className="font-bold text-white text-sm sm:text-base truncate">{entryTitle}</h4>
                            {entryShow?.venue && <p className="text-[11px] sm:text-xs text-gray-500 truncate">{entryShow.venue}</p>}
                          </div>
                          <div className="relative z-[1] flex-shrink-0 text-right pointer-events-none">
                            {entryFormattedDate && <p className="text-[11px] sm:text-xs font-medium text-brand">{entryFormattedDate}</p>}
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
                      <DiaryCard key={review.id} review={review} show={showMap[review.show_id]} onDelete={async () => { await deleteReview(review.id); showToast?.('Rating deleted.', 'info'); }} />
                    ))}
                  </div>
                </div>
              )}

              {/* Past shows section */}
              {pastReviews.length > 0 && (
                <div>
                  {(upcomingReviews.length > 0 || upcomingWatchlistEntries.length > 0 || toBeRatedEntries.length > 0) && (
                    <h3 className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-3">Past Shows</h3>
                  )}
                  {diaryView === 'list' ? (
                    <div className="space-y-2">
                      {pastReviews.map(review => (
                        <DiaryCard key={review.id} review={review} show={showMap[review.show_id]} onDelete={async () => { await deleteReview(review.id); showToast?.('Rating deleted.', 'info'); }} />
                      ))}
                      <AddShowCard context="diary" variant="list" onOpen={() => {
                        const btn = document.querySelector<HTMLButtonElement>('[aria-label="Add a show to diary"], [aria-label="Rate a show"]');
                        btn?.click();
                      }} />
                    </div>
                  ) : (
                    <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
                      {pastReviews.map(review => (
                        <DiaryGridCard key={review.id} review={review} show={showMap[review.show_id]} onDelete={async () => { await deleteReview(review.id); showToast?.('Rating deleted.', 'info'); }} />
                      ))}
                      <AddShowCard context="diary" onOpen={() => {
                        // Find and trigger the AddShowSearch open
                        const btn = document.querySelector<HTMLButtonElement>('[aria-label="Add a show to diary"], [aria-label="Rate a show"]');
                        btn?.click();
                      }} />
                    </div>
                  )}
                </div>
              )}
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
          ) : watchlistView === 'grid' ? (
            <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
              {sortedWatchlist.map(entry => (
                <WatchlistCard
                  key={entry.id}
                  entry={entry}
                  show={showMap[entry.show_id]}
                  onDateChange={(date) => updatePlannedDate(entry.show_id, date)}
                  onRemove={async () => { await removeFromWatchlist(entry.show_id); showToast?.('Removed from Watchlist.', 'info'); }}
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
                  onDateChange={(date) => updatePlannedDate(entry.show_id, date)}
                  onRemove={async () => { await removeFromWatchlist(entry.show_id); showToast?.('Removed from Watchlist.', 'info'); }}
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
  const href = getShowHref(slug, category, show?.diaryOnly);

  return (
    <div className="group/diary relative flex items-center gap-2 sm:gap-4 px-3 sm:px-5 py-2.5 sm:py-3 rounded-xl bg-white/[0.02] border border-white/[0.06] hover:border-white/10 hover:bg-white/[0.04] transition-colors">
      {/* Link overlay for the whole card */}
      <ShowCardOverlay href={href} label={title} />

      {/* Poster */}
      <div className="relative z-[1] pointer-events-none flex-shrink-0 w-10 sm:w-16 aspect-[2/3] rounded-lg overflow-hidden bg-surface-overlay">
        {show?.posterUrl ? (
          <img src={show.posterUrl} alt="" className="w-full h-full object-cover" />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-gray-600 text-xl">🎭</div>
        )}
      </div>

      {/* Info */}
      <div className="relative z-[1] pointer-events-none flex-1 min-w-0">
        <h4 className="font-bold text-white text-sm sm:text-base group-hover/diary:text-brand transition-colors truncate">{title}</h4>
        <div className="flex flex-wrap items-center gap-1 sm:gap-1.5 mt-0.5 sm:mt-1">
          {show?.type && <FormatPill type={show.type} />}
          {show && <StatusBadge status={show.status} />}
          {category === 'off-broadway' && (
            <span className="px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-purple-300 bg-purple-500/15 border border-purple-500/20 rounded">Off-Bway</span>
          )}
          {category === 'west-end' && (
            <span className="px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-teal-300 bg-teal-500/15 border border-teal-500/20 rounded">West End</span>
          )}
        </div>
        {review.review_text && (
          <p className="text-xs text-gray-500 mt-1.5 line-clamp-1">{review.review_text}</p>
        )}
        {review.date_seen && (
          <p className="text-xs text-gray-500 mt-1">
            {new Date(review.date_seen + 'T00:00:00').toLocaleDateString('en-US', {
              month: 'short',
              day: 'numeric',
              year: 'numeric',
            })}
          </p>
        )}
      </div>

      {/* Rating + edit icon */}
      <div className="relative z-[1] pointer-events-none flex-shrink-0 flex flex-col items-center gap-0.5 w-12 sm:w-16 md:w-28 overflow-hidden">
        {/* Single star + number on mobile, full stars on desktop */}
        <span className="md:hidden flex items-center gap-1">
          <svg className="w-5 h-5 text-amber-400" fill="currentColor" viewBox="0 0 20 20"><path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" /></svg>
          <span className="text-base font-bold text-amber-400">{review.rating % 1 === 0 ? review.rating.toFixed(0) : review.rating.toFixed(1)}</span>
        </span>
        <span className="hidden md:inline-flex"><StarRating rating={review.rating} onRatingChange={() => {}} size="sm" readOnly hideLabel /></span>
        <span className="hidden md:block text-sm font-bold text-amber-400">{review.rating.toFixed(1)} stars</span>
        {/* Edit + delete icons — inline below rating, always visible on mobile, hover on desktop */}
        <div className="flex items-center gap-0.5 opacity-100 sm:opacity-0 sm:group-hover/diary:opacity-100 transition-opacity pointer-events-auto">
          {href && (
            <Link
              href={`${href}?edit=1`}
              className="p-1 rounded-full text-gray-600 hover:text-white transition-colors"
              aria-label="Edit rating"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
              </svg>
            </Link>
          )}
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
  const href = getShowHref(slug, category, show?.diaryOnly);

  return (
    <div className="group/grid flex flex-col rounded-xl bg-white/[0.02] border border-white/[0.06] hover:border-white/10 hover:bg-white/[0.04] transition-colors overflow-hidden">
      <ShowCardPosterLink href={href} className="relative">
        <div className="aspect-[2/3] bg-surface-overlay">
          {show?.posterUrl ? (
            <img src={show.posterUrl} alt="" className="w-full h-full object-cover" />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-gray-600 text-3xl">🎭</div>
          )}
        </div>
        {review.rating > 0 && (
          <div className="absolute inset-x-0 bottom-0 flex justify-center pb-1.5">
            <span className="flex items-center gap-0.5 px-2 py-1 rounded-md bg-black/70 backdrop-blur-sm">
              <MiniStars rating={review.rating} />
            </span>
          </div>
        )}
        {/* Delete button — top-right, always visible on mobile, hover on desktop */}
        {onDelete && (
          <button
            type="button"
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); confirmDelete ? onDelete() : setConfirmDelete(true); }}
            className={`absolute top-1 right-1 z-[2] p-1.5 rounded-full ${confirmDelete ? 'bg-red-500/80 text-white opacity-100' : 'bg-black/70 text-gray-400 hover:text-red-400 opacity-100 sm:opacity-0 sm:group-hover/grid:opacity-100'} transition-opacity`}
            aria-label="Delete rating"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
          </button>
        )}
      </ShowCardPosterLink>
      <div className="p-2">
        <ShowCardPosterLink href={href}>
          <h4 className="text-xs font-semibold text-white truncate">{title}</h4>
          {review.date_seen && (
            <p className="text-[10px] text-gray-500 truncate">
              {new Date(review.date_seen + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
            </p>
          )}
        </ShowCardPosterLink>
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
  const href = getShowHref(slug, category, show?.diaryOnly);

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
      <ShowCardPosterLink href={href} className="relative">
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
        {/* Uses <div> + onClick instead of <Link> to avoid nested <a> tags */}
        {/* On mobile: always visible small button at bottom; on desktop: full hover overlay */}
        {href && (
          <div
            role="button"
            tabIndex={0}
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); window.location.href = `${href}?rate=1`; }}
            onKeyDown={(e) => { if (e.key === 'Enter') { window.location.href = `${href}?rate=1`; } }}
            className="absolute inset-x-0 bottom-0 flex items-end justify-center pb-2 bg-gradient-to-t from-black/60 via-transparent to-transparent sm:inset-0 sm:opacity-0 sm:group-hover/wl:opacity-100 transition-opacity z-[1] cursor-pointer"
          >
            <span className="text-[10px] sm:text-xs font-semibold text-white/90 flex items-center gap-1">
              <svg className="w-3 h-3 sm:w-3.5 sm:h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
              </svg>
              Rate
            </span>
          </div>
        )}
        {/* Trash button to remove — top-right, always visible on mobile, hover on desktop */}
        <button
          type="button"
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); confirmRemove ? onRemove() : setConfirmRemove(true); }}
          className={`absolute top-1 right-1 z-[2] p-1.5 rounded-full ${confirmRemove ? 'bg-red-500/80 text-white opacity-100' : 'bg-black/70 text-gray-400 hover:text-red-400 opacity-100 sm:opacity-0 sm:group-hover/wl:opacity-100'} transition-opacity`}
          aria-label="Remove from watchlist"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
          </svg>
        </button>
      </ShowCardPosterLink>
      <div className="p-2">
        <ShowCardPosterLink href={href}>
          <h4 className="text-xs font-semibold text-white truncate">{title}</h4>
          <p className="text-[10px] text-gray-500 truncate">{show?.venue}</p>
        </ShowCardPosterLink>
        {/* Planned date — uses ref + showPicker for reliable mobile support */}
        <DatePickerButton
          value={entry.planned_date || ''}
          label={formattedDate || 'Add date'}
          onChange={(val) => onDateChange(val || null)}
        />
      </div>
    </div>
  );
}

/** Render mini star icons for grid cards (filled, half, empty) */
let miniStarsCounter = 0;
function MiniStars({ rating }: { rating: number }) {
  const idRef = useRef(`ms-${++miniStarsCounter}`);
  const uid = idRef.current;
  const stars = [];
  for (let i = 1; i <= 5; i++) {
    if (i <= Math.floor(rating)) {
      stars.push(<svg key={i} className="w-3.5 h-3.5 text-amber-400" fill="currentColor" viewBox="0 0 20 20"><path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" /></svg>);
    } else if (i === Math.ceil(rating) && rating % 1 !== 0) {
      stars.push(
        <svg key={i} className="w-3.5 h-3.5" viewBox="0 0 20 20">
          <defs><clipPath id={`${uid}-${i}`}><rect x="0" y="0" width="10" height="20" /></clipPath></defs>
          <path className="text-gray-600" fill="currentColor" d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
          <path className="text-amber-400" fill="currentColor" clipPath={`url(#${uid}-${i})`} d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
        </svg>
      );
    } else {
      stars.push(<svg key={i} className="w-3.5 h-3.5 text-gray-600" fill="currentColor" viewBox="0 0 20 20"><path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" /></svg>);
    }
  }
  return <>{stars}</>;
}

/** Reusable date picker button — works reliably on iOS Safari */
function DatePickerButton({ value, label, onChange }: { value: string; label: string; onChange: (val: string) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <div className="relative mt-1.5">
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          try { inputRef.current?.showPicker(); } catch { inputRef.current?.focus(); }
        }}
        className="w-full flex items-center justify-center gap-1 sm:gap-1.5 text-[11px] sm:text-xs text-gray-400 hover:text-gray-300 transition-colors cursor-pointer min-h-[32px] sm:min-h-[36px] px-1.5 sm:px-2 rounded-lg bg-white/[0.03] border border-white/[0.06] hover:border-white/10"
      >
        <svg className="w-3.5 h-3.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
        </svg>
        <span className="truncate">{label}</span>
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
  const href = getShowHref(slug, category, show?.diaryOnly);

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
    <div className="group/wl relative flex items-center gap-2 sm:gap-4 px-3 sm:px-5 py-2.5 sm:py-3 rounded-xl bg-white/[0.02] border border-white/[0.06] hover:border-white/10 hover:bg-white/[0.04] transition-colors">
      <ShowCardOverlay href={href} label={title} />

      <div className="relative z-[1] flex-shrink-0 w-10 sm:w-16 aspect-[2/3] rounded-lg overflow-hidden bg-surface-overlay">
        {show?.posterUrl ? (
          <img src={show.posterUrl} alt="" className="w-full h-full object-cover" />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-gray-600 text-lg sm:text-xl">🎭</div>
        )}
      </div>

      <div className="relative z-[1] flex-1 min-w-0">
        <h4 className="font-bold text-white text-sm sm:text-base group-hover/wl:text-brand transition-colors truncate">{title}</h4>
        <p className="text-[11px] sm:text-xs text-gray-500 truncate">{show?.venue}</p>
        <div className="flex flex-wrap items-center gap-1.5 mt-1">
          {show?.type && <FormatPill type={show.type} />}
          {show && <StatusBadge status={show.status} />}
          {isClosingSoon && (
            <span className="px-1.5 py-0.5 text-[9px] font-bold uppercase bg-amber-500/90 text-black rounded">Closing Soon</span>
          )}
        </div>
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

/** Group productions by region for the picker */
function groupProductions(prods: DiaryProduction[]) {
  const groups: { label: string; items: DiaryProduction[] }[] = [];
  const regionMap: Record<string, DiaryProduction[]> = {};

  for (const p of prods) {
    let region: string;
    if (p.cat === 'broadway') region = 'Broadway';
    else if (p.cat === 'west-end') region = 'West End';
    else if (p.cat === 'off-broadway') region = 'Off-Broadway';
    else if (p.co === 'US') region = 'US Regional';
    else if (p.co === 'GB') region = 'UK Regional';
    else if (p.co === 'AU') region = 'Australia';
    else if (p.co === 'CA') region = 'Canada';
    else if (p.co === 'DE') region = 'Germany';
    else if (p.co === 'JP') region = 'Japan';
    else if (p.co) region = p.co;
    else region = 'Other';
    if (!regionMap[region]) regionMap[region] = [];
    regionMap[region].push(p);
  }

  const priority = ['Broadway', 'West End', 'Off-Broadway', 'US Regional', 'UK Regional'];
  const sorted = Object.entries(regionMap).sort((a, b) => {
    const ai = priority.indexOf(a[0]);
    const bi = priority.indexOf(b[0]);
    if (ai !== -1 && bi !== -1) return ai - bi;
    if (ai !== -1) return -1;
    if (bi !== -1) return 1;
    return b[1].length - a[1].length;
  });

  for (const [label, items] of sorted) {
    groups.push({ label, items });
  }
  return groups;
}

/** Format production label: "City · Venue (Year)" */
function prodLabel(p: DiaryProduction): string {
  const parts: string[] = [];
  if (p.ci) parts.push(p.ci);
  if (p.v && p.v !== p.ci) parts.push(p.v);
  const main = parts.join(' · ') || (p.co ? p.co : p.cat || 'Unknown location');
  return p.y ? `${main} (${p.y})` : main;
}

function ProductionPicker({
  show,
  filter,
  onFilterChange,
  onSelect,
  onBack,
  context,
  existingReviewIds,
  existingWatchlistIds,
  addingId,
}: {
  show: SearchShow;
  filter: string;
  onFilterChange: (v: string) => void;
  onSelect: (prod: DiaryProduction) => void;
  onBack: () => void;
  context: 'diary' | 'watchlist';
  existingReviewIds: Set<string>;
  existingWatchlistIds: Set<string>;
  addingId: string | null;
}) {
  const prods = show.prods || [];
  const showFilter = prods.length > 10;
  const [showAll, setShowAll] = useState(false);
  const PAGE_SIZE = 50;

  const filtered = filter
    ? prods.filter(p => {
        const q = filter.toLowerCase();
        return (p.ci?.toLowerCase().includes(q)) ||
               (p.v?.toLowerCase().includes(q)) ||
               (p.y?.includes(q)) ||
               (p.co?.toLowerCase().includes(q));
      })
    : prods;

  // Paginate: show first PAGE_SIZE items unless filter is active or user clicked "Show all"
  const paginated = (!filter && !showAll && filtered.length > PAGE_SIZE)
    ? filtered.slice(0, PAGE_SIZE)
    : filtered;
  const hasMore = !filter && !showAll && filtered.length > PAGE_SIZE;

  const groups = groupProductions(paginated);

  return (
    <div className="absolute top-full right-0 mt-1.5 w-[calc(100vw-2rem)] sm:w-80 bg-surface-raised border border-white/10 rounded-lg shadow-xl overflow-hidden z-[80] max-h-80 flex flex-col">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-white/10 bg-white/[0.02]">
        <button
          type="button"
          onClick={onBack}
          className="p-0.5 text-gray-400 hover:text-white transition-colors"
          aria-label="Back to search"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-white truncate">{show.title}</div>
          <div className="text-[11px] text-gray-400">{prods.length} productions — pick one</div>
        </div>
      </div>

      {showFilter && (
        <div className="px-3 py-1.5 border-b border-white/5">
          <input
            type="text"
            value={filter}
            onChange={e => onFilterChange(e.target.value)}
            placeholder="Filter by city, venue, year..."
            className="w-full px-2 py-1 text-xs bg-white/5 border border-white/10 rounded text-white placeholder-gray-500 focus:outline-none focus:border-brand/50"
            autoFocus
            aria-label="Filter productions by city, venue, or year"
          />
        </div>
      )}

      <div className="overflow-y-auto flex-1">
        {groups.length > 0 ? groups.map(group => (
          <div key={group.label}>
            {groups.length > 1 && (
              <div className="px-3 py-1 text-[10px] font-semibold text-gray-500 uppercase tracking-wider bg-white/[0.02] sticky top-0">
                {group.label} ({group.items.length})
              </div>
            )}
            {group.items.map(prod => {
              const isAdding = addingId === prod.id;
              const alreadyReviewed = existingReviewIds.has(prod.id);
              const alreadyWatchlisted = existingWatchlistIds.has(prod.id);
              return (
                <button
                  key={prod.id}
                  onClick={() => onSelect(prod)}
                  disabled={isAdding}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-white/5 transition-colors disabled:opacity-50"
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-xs text-white truncate">{prodLabel(prod)}</div>
                  </div>
                  {prod.st === 'open' && (
                    <span className="flex-shrink-0 text-[9px] px-1 py-0.5 rounded bg-green-500/20 text-green-400 font-medium">Now Playing</span>
                  )}
                  <div className="flex-shrink-0 text-[10px] text-gray-500">
                    {context === 'diary' ? (
                      alreadyReviewed ? <span className="text-green-400">Rated</span> : <span>Rate</span>
                    ) : (
                      isAdding ? (
                        <span className="animate-pulse">Adding...</span>
                      ) : alreadyWatchlisted ? (
                        <span className="text-green-400">Added</span>
                      ) : (
                        <span>+ Add</span>
                      )
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        )) : (
          <div className="px-3 py-4 text-center text-xs text-gray-500">
            No productions match &ldquo;{filter}&rdquo;
          </div>
        )}
        {hasMore && (
          <button
            type="button"
            onClick={() => setShowAll(true)}
            className="w-full px-3 py-2 text-xs text-brand hover:text-white bg-white/[0.02] hover:bg-white/5 border-t border-white/5 transition-colors"
          >
            Show all {filtered.length} productions
          </button>
        )}
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
  images?: { thumbnail?: string };
  category?: string;
  dy?: boolean;
  img?: string;
  gid?: string;
  n?: number;
  prods?: DiaryProduction[];
}

interface DiaryProduction {
  id: string;
  v: string;
  ci: string;
  co?: string;
  y?: string;
  st?: string;
  cat?: string;
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
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);
  const [results, setResults] = useState<SearchShow[]>([]);
  const [shows, setShows] = useState<SearchShow[]>([]);
  const fuseRef = useRef<Fuse<SearchShow> | null>(null);
  const [dataReady, setDataReady] = useState(false);
  const fetchedRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [addingId, setAddingId] = useState<string | null>(null);
  const [selectedShow, setSelectedShow] = useState<SearchShow | null>(null);
  const [prodFilter, setProdFilter] = useState('');

  const ensureData = useCallback(async () => {
    if (fetchedRef.current) return;
    fetchedRef.current = true;
    try {
      const [res, diaryRes, { default: FuseClass }] = await Promise.all([
        fetch('/data/search-shows.json'),
        fetch('/data/diary-search.json').catch(() => null),
        import('fuse.js/basic') as Promise<{ default: typeof Fuse }>,
      ]);
      const data: SearchShow[] = await res.json();
      // Merge diary shows — now show-grouped (single-prod entries have id/slug, multi-prod have gid/prods)
      if (diaryRes?.ok) {
        try {
          const diaryData: SearchShow[] = await diaryRes.json();
          const existingTitles = new Set(data.map(s => s.title.toLowerCase()));
          for (const s of diaryData) {
            // Skip single-prod diary entries that duplicate existing search entries
            if (!s.prods && existingTitles.has(s.title.toLowerCase())) continue;
            // Multi-prod groups supersede individual entries with the same title
            // (e.g., one "Wicked" with 737 prods replaces separate Broadway/WE entries)
            if (s.prods && s.prods.length > 1) {
              const titleLower = s.title.toLowerCase();
              for (let i = data.length - 1; i >= 0; i--) {
                if (data[i].title.toLowerCase() === titleLower) data.splice(i, 1);
              }
            }
            data.push(s);
          }
        } catch { /* ignore */ }
      }
      fuseRef.current = new FuseClass(data, {
        keys: [{ name: 'title', weight: 0.8 }, { name: 'venue', weight: 0.2 }],
        threshold: 0.35,
        ignoreLocation: true,
        minMatchCharLength: 2,
      });
      setShows(data);
      setDataReady(true);
    } catch {
      fetchedRef.current = false;
    }
  }, []);

  // Compute results from deferred query
  const filteredResults = useMemo(() => {
    if (deferredQuery.length < 2 || !fuseRef.current) return [];
    const fuseResults = fuseRef.current.search(deferredQuery, { limit: 10 }).map(r => r.item);
    const q = deferredQuery.toLowerCase();
    const fuseKeys = new Set(fuseResults.map(r => r.gid || r.id));
    const substring = shows.filter(s =>
      s.title.toLowerCase().includes(q) && !fuseKeys.has(s.gid || s.id)
    );
    const combined = [...fuseResults, ...substring];
    // Sort open/previews shows first, then closed
    const statusOrder = (s: SearchShow) => s.status === 'open' || s.status === 'previews' ? 0 : 1;
    combined.sort((a, b) => statusOrder(a) - statusOrder(b));
    return combined.slice(0, 8);
  }, [deferredQuery, dataReady, shows]);

  useEffect(() => { setResults(filteredResults); }, [filteredResults]);

  // Close on outside click
  useEffect(() => {
    if (!isOpen) return;
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
        setQuery('');
        setSelectedShow(null);
        setProdFilter('');
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [isOpen]);

  // Focus input when opening
  useEffect(() => {
    if (isOpen) { ensureData(); setTimeout(() => inputRef.current?.focus(), 50); }
  }, [isOpen, ensureData]);

  const handleSelect = async (show: SearchShow) => {
    // Multi-production show → open production picker
    if (show.prods && show.prods.length > 1) {
      setSelectedShow(show);
      setProdFilter('');
      return;
    }

    // Single production inside a group — use the production's id
    if (show.prods && show.prods.length === 1) {
      await handleProductionSelect(show.prods[0].id, show.prods[0].id, true);
      return;
    }

    await handleProductionSelect(show.id, show.slug, show.dy);
  };

  const handleProductionSelect = async (id: string, slug: string, dy?: boolean) => {
    if (context === 'watchlist') {
      if (existingWatchlistIds.has(id)) {
        if (!dy) router.push(`/show/${slug}`);
      } else {
        setAddingId(id);
        try {
          await onAddToWatchlist(id);
        } finally {
          setAddingId(null);
        }
      }
    } else {
      // Diary context
      if (dy) {
        // Diary-only show — no show page exists, save to watchlist as fallback
        if (!existingWatchlistIds.has(id) && !existingReviewIds.has(id)) {
          setAddingId(id);
          try {
            await onAddToWatchlist(id);
          } finally {
            setAddingId(null);
          }
        }
      } else {
        router.push(`/show/${slug}?rate=1`);
      }
    }
    setSelectedShow(null);
    setIsOpen(false);
    setQuery('');
  };

  if (!isOpen) {
    return (
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        className="p-1.5 rounded-lg text-gray-400 hover:text-white hover:bg-white/10 transition-colors"
        aria-label={context === 'diary' ? 'Add a show to diary' : 'Add to watchlist'}
        title={context === 'diary' ? 'Rate a show' : 'Add to watchlist'}
      >
        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
        </svg>
      </button>
    );
  }

  return (
    <div ref={containerRef} className="relative">
      <div className="flex items-center gap-1.5">
        <div className="relative">
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Escape') {
                if (selectedShow) { setSelectedShow(null); }
                else { setIsOpen(false); setQuery(''); }
              }
              if (e.key === 'Enter' && !selectedShow && results.length > 0) { handleSelect(results[0]); }
            }}
            placeholder={context === 'diary' ? 'Search to rate...' : 'Search to add...'}
            className="w-40 sm:w-52 px-3 py-1.5 pl-8 text-xs bg-white/5 border border-white/10 rounded-lg text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-brand/50 focus:border-brand/50"
          />
          <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
        </div>
        <button
          type="button"
          onClick={() => { setIsOpen(false); setQuery(''); setSelectedShow(null); }}
          className="p-1 text-gray-500 hover:text-white"
          aria-label="Close search"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Dropdown: search results OR production picker */}
      {selectedShow ? (
        <ProductionPicker
          show={selectedShow}
          filter={prodFilter}
          onFilterChange={setProdFilter}
          onSelect={(prod) => handleProductionSelect(prod.id, prod.id, true)}
          onBack={() => setSelectedShow(null)}
          context={context}
          existingReviewIds={existingReviewIds}
          existingWatchlistIds={existingWatchlistIds}
          addingId={addingId}
        />
      ) : query.length >= 2 ? (
        <div className="absolute top-full right-0 mt-1.5 w-[calc(100vw-2rem)] sm:w-80 bg-surface-raised border border-white/10 rounded-lg shadow-xl overflow-hidden z-[80] max-h-72 overflow-y-auto">
          {results.length > 0 ? results.map(show => {
            const key = show.gid || show.id;
            const alreadyReviewed = show.id ? existingReviewIds.has(show.id) : false;
            const alreadyWatchlisted = show.id ? existingWatchlistIds.has(show.id) : false;
            const isAdding = addingId === show.id;
            const isMulti = show.prods && show.prods.length > 1;
            return (
              <button
                key={key}
                onClick={() => handleSelect(show)}
                disabled={isAdding}
                className="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-white/5 transition-colors disabled:opacity-50"
              >
                {(show.images?.thumbnail || show.img) ? (
                  <img src={show.images?.thumbnail || expandMezzImg(show.img) || ''} alt="" className="w-9 h-9 rounded object-cover flex-shrink-0" />
                ) : (
                  <div className="w-9 h-9 rounded bg-white/10 flex-shrink-0" />
                )}
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-white truncate">{show.title}</div>
                  <div className="text-[10px] text-gray-500 flex items-center gap-1.5">
                    {isMulti ? (
                      <span className="text-gray-400">{show.n} productions worldwide</span>
                    ) : (
                      <>
                        <span className={`px-1 py-0.5 rounded font-medium ${
                          show.status === 'open' ? 'bg-green-500/20 text-green-400' :
                          show.status === 'previews' ? 'bg-yellow-500/20 text-yellow-400' :
                          'bg-gray-500/20 text-gray-400'
                        }`}>
                          {show.status === 'open' ? 'Now Playing' : show.status === 'previews' ? 'Previews' : 'Closed'}
                        </span>
                        {show.venue && <span className="truncate">{show.venue}</span>}
                      </>
                    )}
                  </div>
                </div>
                <div className="flex-shrink-0 text-xs text-gray-500">
                  {isMulti ? (
                    <span className="text-brand font-medium px-1.5 py-0.5 rounded bg-brand/10">{show.n} &rarr;</span>
                  ) : context === 'diary' ? (
                    alreadyReviewed ? <span className="text-green-400">Rated</span> : <span>Rate</span>
                  ) : (
                    isAdding ? (
                      <span className="animate-pulse">Adding...</span>
                    ) : alreadyWatchlisted ? (
                      <span className="text-green-400">Added</span>
                    ) : (
                      <span>+ Add</span>
                    )
                  )}
                </div>
              </button>
            );
          }) : (
            <div className="px-3 py-4 text-center text-xs text-gray-500">
              No shows found for &ldquo;{query}&rdquo;
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

/** "To Be Rated" card with inline interactive stars */
function ToBeRatedCard({ entry, show }: { entry: WatchlistEntry; show?: ShowLookup }) {
  const router = useRouter();
  const title = show?.title || entry.show_id;
  const slug = show?.slug || entry.show_id;
  const category = show?.category || 'broadway';
  const href = getShowHref(slug, category, show?.diaryOnly);

  return (
    <div className="relative flex items-center gap-2 sm:gap-4 px-3 sm:px-5 py-3 rounded-xl bg-amber-500/[0.03] border border-amber-500/10 hover:border-amber-500/20 hover:bg-amber-500/[0.06] transition-colors">
      <ShowCardOverlay href={href} label={title} />
      <div className="relative z-[1] flex-shrink-0 w-10 sm:w-16 aspect-[2/3] rounded-lg overflow-hidden bg-surface-overlay pointer-events-none">
        {show?.posterUrl ? (
          <img src={show.posterUrl} alt="" className="w-full h-full object-cover" />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-gray-600 text-lg sm:text-xl">🎭</div>
        )}
      </div>
      <div className="relative z-[1] flex-1 min-w-0 pointer-events-none">
        <h4 className="font-bold text-white text-sm sm:text-base truncate">{title}</h4>
        {show?.venue && <p className="text-[11px] sm:text-xs text-gray-500 truncate">{show.venue}</p>}
        {entry.planned_date && (
          <p className="text-[11px] sm:text-xs text-gray-500 mt-0.5 whitespace-nowrap">
            Saw {new Date(entry.planned_date + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
          </p>
        )}
      </div>
      <div className="relative z-[2] flex-shrink-0 pointer-events-auto">
        {/* xs stars on mobile, sm on desktop — prevents overflow */}
        <span className="sm:hidden">
          <StarRating
            rating={null}
            onRatingChange={(rating) => {
              if (href) router.push(`${href}?rate=1&stars=${rating}`);
            }}
            size="xs"
          />
        </span>
        <span className="hidden sm:inline-flex">
          <StarRating
            rating={null}
            onRatingChange={(rating) => {
              if (href) router.push(`${href}?rate=1&stars=${rating}`);
            }}
            size="sm"
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
        aria-label={context === 'diary' ? 'Add a show to diary' : 'Add to watchlist'}
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
      className="flex flex-col items-center justify-center rounded-xl border-2 border-dashed border-white/10 hover:border-white/20 hover:bg-white/[0.03] transition-colors aspect-[2/3] text-gray-500 hover:text-gray-300"
      aria-label={context === 'diary' ? 'Add a show to diary' : 'Add to watchlist'}
    >
      <svg className="w-8 h-8 mb-1" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
      </svg>
      <span className="text-[10px] font-medium">{context === 'diary' ? 'Rate' : 'Add'}</span>
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
