'use client';

import { useState, useEffect, useMemo, useRef, useCallback, useId, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { featureFlags } from '@/config/feature-flags';
import { useAuth } from '@/contexts/AuthContext';
import { useUserReviews } from '@/hooks/useUserReviews';
import { useWatchlist } from '@/hooks/useWatchlist';
import { useUserLists } from '@/hooks/useUserLists';
import { invalidateRatingsCache } from '@/hooks/useMyRating';
import StarRating from '@/components/user/StarRating';
import RatingEditor, { type RatingEditorSaveData } from '@/components/user/RatingEditor';
import { supabaseRestInsert, supabaseRestUpdate } from '@/lib/supabase-rest';
import { stubRowFromCandidate, type MezzanineCandidate } from '@/lib/mezzanine-search';
import SharedDatePicker from '@/components/user/DatePickerButton';

import { useToastSafe } from '@/components/ui/Toast';
import type { UserReview, WatchlistEntry, ShowLookup } from '@/types/user';
import dynamic from 'next/dynamic';
import { ShowSearchDropdown } from '@/components/show-cards';
const ImportShows = dynamic(() => import('./ImportShows'), { ssr: false });

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
    diaryOnly: !!raw.dy,
  };
}

// Fetch stub metadata directly from user_show_stubs (public SELECT, no auth
// needed) for ids a fresh diary-lookup.json fetch still doesn't know about —
// i.e. shows added via live Mezzanine search since the last nightly resolver
// run (card 174). Returns a partial ShowMap; a failed/empty fetch is not an
// error — those ids simply keep rendering degraded until the next resolver
// pass regenerates diary-lookup.json.
async function fetchShowStubs(ids: string[]): Promise<ShowMap> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key || ids.length === 0) return {};
  try {
    const res = await fetch(
      `${url}/rest/v1/user_show_stubs?id=in.(${ids.map(id => encodeURIComponent(id)).join(',')})&select=id,title,venue,category,opening_date,poster_url`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` } },
    );
    if (!res.ok) return {};
    const rows: { id: string; title: string; venue: string | null; category: string; opening_date: string | null; poster_url: string | null }[] = await res.json();
    const additions: ShowMap = {};
    for (const r of rows) {
      additions[r.id] = {
        id: r.id,
        title: r.title,
        slug: r.id,
        venue: r.venue || '',
        type: 'play',
        status: 'closed',
        category: r.category,
        previewDate: null,
        openingDate: r.opening_date,
        closingDate: null,
        compositeScore: null,
        posterUrl: r.poster_url,
        diaryOnly: true,
      };
    }
    return additions;
  } catch {
    return {};
  }
}

// Diary-only shows (regional/international/historical, Mezzanine-sourced)
// have no critic score and don't live in shows.json, so they get the
// lightweight /diary-show/[id] page (id === slug for these) instead of the
// full /show/[slug] page — owner directive 2026-07-14: cards must link
// somewhere real, never render as dead links or de-linked divs.
function getShowHref(slug: string, diaryOnly?: boolean): string {
  return diaryOnly ? `/diary-show/${slug}` : `/show/${slug}`;
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
  // Grid is the default everywhere (owner, 2026-07-14 — diary was 'list').
  // The choice persists in localStorage because this page fully remounts on
  // every show-page round-trip; state-only prefs silently reset (owner report).
  // Read lazily after mount to avoid an SSG hydration mismatch.
  const [watchlistView, setWatchlistView] = useState<ViewMode>('grid');
  const [diaryView, setDiaryView] = useState<ViewMode>('grid');
  useEffect(() => {
    try {
      const d = localStorage.getItem('bsc_diary_view');
      const w = localStorage.getItem('bsc_watchlist_view');
      if (d === 'list' || d === 'grid') setDiaryView(d);
      if (w === 'list' || w === 'grid') setWatchlistView(w);
    } catch { /* storage unavailable */ }
  }, []);
  const pickView = useCallback((tab: 'diary' | 'watchlist', mode: ViewMode) => {
    if (tab === 'diary') setDiaryView(mode); else setWatchlistView(mode);
    try { localStorage.setItem(tab === 'diary' ? 'bsc_diary_view' : 'bsc_watchlist_view', mode); } catch { /* ignore */ }
  }, []);
  const [showMap, setShowMap] = useState<ShowMap>({});
  const [showMapLoaded, setShowMapLoaded] = useState(false);

  const { user, isAuthenticated, loading: authLoading, signIn } = useAuth();
  const { reviews: realReviews, getAllReviews, deleteReview, loading: reviewsLoading } = useUserReviews(user?.id || null);
  const { watchlist: realWatchlist, getWatchlist, addToWatchlist, updatePlannedDate, removeFromWatchlist, loading: watchlistLoading } = useWatchlist(user?.id || null);
  // Count-only lists instance for the tab badge (ListsTab owns its own full
  // CRUD instance; hook instances don't share state, so this fetches the list
  // rows once per page view — cheap, and the badge works without visiting the tab).
  const { lists: realLists, getLists } = useUserLists(user?.id || null);
  const { showToast } = useToastSafe();

  // Inline rating modal — diary-only shows (regional/international/historical
  // catalog, no critic score) have no /show/[slug] page to deep-link ?rate=1
  // into, so rating them happens entirely within My Shows (owner, 2026-07-14).
  const [ratingTarget, setRatingTarget] = useState<{
    id: string;
    title: string;
    reviewId?: string;
    initialRating?: number;
    initialReviewText?: string | null;
    initialDateSeen?: string | null;
  } | null>(null);
  const openRatingEditor = useCallback((show: { id: string; title: string }, opts?: {
    reviewId?: string; initialRating?: number; initialReviewText?: string | null; initialDateSeen?: string | null;
  }) => {
    setRatingTarget({ id: show.id, title: show.title, ...opts });
  }, []);

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
  const listsCount = isMockMode ? 3 : realLists.length;
  const loading = isMockMode ? !mockData : (authLoading || reviewsLoading || watchlistLoading);
  // Latches after the first successful load so refetches never blank the page.
  const [hasLoadedOnce, setHasLoadedOnce] = useState(false);
  useEffect(() => {
    if (!loading) setHasLoadedOnce(true);
  }, [loading]);

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

  // Shared delete handler — deleteReview rethrows on failure (Phase 2), so a
  // bare `await` in an onClick would be an unhandled rejection with no feedback.
  const handleDeleteReviewWithToast = useCallback(async (reviewId: string) => {
    try {
      await effectiveDeleteReview(reviewId);
      invalidateRatingsCache(); // browse-card ★chips must not outlive the rating
      showToast?.('Rating deleted.', 'info');
    } catch {
      showToast?.('Delete failed — please try again.', 'error');
    }
  }, [effectiveDeleteReview, showToast]);
  const effectiveRemoveFromWatchlist = isMockMode ? mockRemoveFromWatchlist : removeFromWatchlist;
  const effectiveUpdatePlannedDate = isMockMode ? mockUpdatePlannedDate : updatePlannedDate;

  // updatePlannedDate rethrows on failure (Phase 2) — surface it instead of
  // letting the onChange promise reject unhandled with zero feedback.
  const handlePlannedDateChange = useCallback(async (showId: string, date: string | null) => {
    try {
      await effectiveUpdatePlannedDate(showId, date);
    } catch {
      showToast?.('Failed to save date.', 'error');
    }
  }, [effectiveUpdatePlannedDate, showToast]);
  const effectiveAddToWatchlist = isMockMode ? mockAddToWatchlist : addToWatchlist;

  // Save handler for the inline rating modal (diary-only shows). Simpler than
  // ShowHeroRedesign's handleSaveReview — no auth-gating needed since /my-shows
  // already requires sign-in to reach this component at all.
  const handleInlineRatingSave = useCallback(async (data: RatingEditorSaveData) => {
    if (isMockMode) { setRatingTarget(null); return; }
    if (!user || !ratingTarget) return;
    if (data.reviewId) {
      const filters = `id=eq.${data.reviewId}&user_id=eq.${user.id}`;
      const { data: updated, error } = await supabaseRestUpdate<{ id: string }>('reviews', filters, {
        rating: data.rating,
        review_text: data.reviewText || null,
        date_seen: data.dateSeen || null,
        updated_at: new Date().toISOString(),
      });
      if (error) throw new Error(error.message);
      if (!updated) throw new Error('This rating no longer exists — it may have been deleted elsewhere.');
    } else {
      const { error } = await supabaseRestInsert('reviews', {
        user_id: user.id,
        show_id: ratingTarget.id,
        rating: data.rating,
        review_text: data.reviewText || null,
        date_seen: data.dateSeen || null,
      });
      if (error) throw new Error(error.message);
      // Rating a show means you've seen it — drop any watchlist entry (parity
      // with ShowHeroRedesign.handleSaveReview). Best-effort: rating already saved.
      try { await effectiveRemoveFromWatchlist(ratingTarget.id); } catch { /* non-fatal */ }
    }
    await getAllReviews();
    invalidateRatingsCache();
  }, [isMockMode, user, ratingTarget, effectiveRemoveFromWatchlist, getAllReviews]);

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

  // Diary-only shows (off-Broadway/regional productions imported via
  // Mezzanine/Show Score) live in diary-lookup.json, not show-lookup.json —
  // without this merge their diary rows render raw show IDs. The file is
  // ~5MB so it's fetched once, lazily, and only when a user's entry actually
  // references a show the main lookup doesn't know; only referenced ids are
  // merged into the map.
  const diaryLookupTriedRef = useRef(false);
  useEffect(() => {
    if (isMockMode || !showMapLoaded || diaryLookupTriedRef.current) return;
    const referenced = new Set([...reviews.map(r => r.show_id), ...watchlist.map(w => w.show_id)]);
    const missing = Array.from(referenced).filter(id => !showMap[id]);
    if (missing.length === 0) return;
    diaryLookupTriedRef.current = true;
    const missingSet = new Set(missing);

    (async () => {
      let diaryLookupFailed = false;
      const additions: ShowMap = {};
      try {
        const res = await fetch('/data/diary-lookup.json');
        const data: Record<string, unknown>[] = await res.json();
        for (const raw of data) {
          const show = decodeShow(raw);
          if (missingSet.has(show.id)) additions[show.id] = show;
        }
        if (Object.keys(additions).length > 0) setShowMap(prev => ({ ...additions, ...prev }));
      } catch {
        diaryLookupFailed = true;
      }

      // Live-lookup stubs (card 174): a show added THIS session via the
      // "search the wider catalog" affordance won't be in diary-lookup.json
      // until tomorrow's nightly resolver run — fetch it straight from
      // user_show_stubs (public SELECT, no auth needed) so a fresh page
      // load (e.g. a different tab) still renders it correctly. Runs
      // regardless of whether the diary-lookup.json fetch above succeeded —
      // a stub id predates that file's next regen by design, so this must
      // not be gated on that fetch (ship-check finding: it originally was,
      // silently disabling the stub fallback whenever diary-lookup.json
      // failed to load).
      const stillMissing = Array.from(missingSet).filter(id => !additions[id]);
      const stubAdditions = stillMissing.length > 0 ? await fetchShowStubs(stillMissing) : {};
      if (Object.keys(stubAdditions).length > 0) setShowMap(prev => ({ ...stubAdditions, ...prev }));

      // Transient diary-lookup.json failure: allow the next effect run to
      // retry rather than stranding raw-ID rows until a full reload
      // (ship-check P1). A stub-fetch failure doesn't reset the ref — it's
      // best-effort and retries naturally next time missing IDs change.
      if (diaryLookupFailed) diaryLookupTriedRef.current = false;
    })();
  }, [isMockMode, showMapLoaded, reviews, watchlist, showMap]);

  // Load user data when authenticated
  useEffect(() => {
    if (isMockMode) return;
    if (isAuthenticated && user) {
      getAllReviews();
      getWatchlist();
      getLists();
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
        <div className="text-center py-12 max-w-sm mx-auto">
          <div className="text-5xl mb-4">🎭</div>
          <h3 className="text-lg font-bold text-white mb-1">Track your Broadway journey</h3>
          <p className="text-sm text-gray-400 mb-6">Free account · sign in with one tap</p>
          <div className="text-left space-y-2.5 mb-7 mx-auto max-w-xs">
            <div className="flex items-start gap-2.5 text-sm text-gray-300">
              <span className="text-[#FFD700]" aria-hidden="true">★</span>
              <span>Rate every show you see — half-stars, dates, private notes</span>
            </div>
            <div className="flex items-start gap-2.5 text-sm text-gray-300">
              <svg className="w-4 h-4 mt-0.5 flex-shrink-0 text-brand" fill="currentColor" viewBox="0 0 24 24"><path d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" /></svg>
              <span>Keep a watchlist of what&apos;s next</span>
            </div>
            <div className="flex items-start gap-2.5 text-sm text-gray-300">
              <svg className="w-4 h-4 mt-0.5 flex-shrink-0 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" d="M4 6h16M4 10h16M4 14h16M4 18h10" /></svg>
              <span>Build &amp; share ranked lists with friends</span>
            </div>
          </div>
          {/* Direct provider buttons — same actions as SignInModal, one less click */}
          <div className="space-y-3">
            <button
              type="button"
              onClick={(e) => {
                // Guard double-taps (two OAuth popups) but re-enable in case the
                // user cancels the provider popup and wants to retry.
                const btn = e.currentTarget as HTMLButtonElement;
                btn.disabled = true;
                setTimeout(() => { btn.disabled = false; }, 4000);
                signIn('google');
              }}
              className="w-full flex items-center justify-center gap-3 px-4 py-3 bg-white text-gray-800 font-semibold text-sm rounded-lg hover:bg-gray-100 transition-colors"
            >
              <svg className="w-5 h-5" viewBox="0 0 24 24">
                <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" />
                <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
                <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
                <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
              </svg>
              Continue with Google
            </button>
            <button
              type="button"
              onClick={(e) => {
                // Guard double-taps (two OAuth popups) but re-enable in case the
                // user cancels the provider popup and wants to retry.
                const btn = e.currentTarget as HTMLButtonElement;
                btn.disabled = true;
                setTimeout(() => { btn.disabled = false; }, 4000);
                signIn('apple');
              }}
              className="w-full flex items-center justify-center gap-3 px-4 py-3 bg-black text-white font-semibold text-sm rounded-lg border border-white/20 hover:bg-surface-raised transition-colors"
            >
              <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
                <path d="M17.05 20.28c-.98.95-2.05.88-3.08.4-1.09-.5-2.08-.48-3.24 0-1.44.62-2.2.44-3.06-.4C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.54 4.09zM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z" />
              </svg>
              Continue with Apple
            </button>
          </div>
          <p className="mt-5 text-xs text-gray-600">By signing in, you agree to our Terms of Service and Privacy Policy.</p>
        </div>
      </div>
    );
  }

  if (loading && !hasLoadedOnce) {
    // Skeleton for the INITIAL load only. Refetches (e.g. onImportComplete →
    // getAllReviews/getWatchlist) briefly set loading=true again; early-
    // returning here unmounts the whole page tree — including the import
    // modal, which lost its "Import Complete" state the moment the import
    // finished (2026-07-14). Refreshes render the stale list until data lands.
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
            className="btn-primary gap-1.5 text-xs"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
            </svg>
            <span>New list</span>
          </button>
        ) : (
          <AddShowSearch
            context={activeTab}
            userId={isMockMode ? null : (user?.id ?? null)}
            onAddToWatchlist={async (showId: string) => {
              await effectiveAddToWatchlist(showId);
              if (!isMockMode) await getWatchlist(true);
              showToast?.(<>Added to <a href="/my-shows?tab=watchlist" className="underline hover:text-white/90">Watchlist</a></>, 'success');
            }}
            onRateDiaryOnly={(show) => openRatingEditor(show)}
            existingWatchlistIds={new Set(watchlist.map(w => w.show_id))}
            existingReviewIds={new Set(reviews.map(r => r.show_id))}
            onLiveShowAdded={(show) => setShowMap(prev => ({ ...prev, [show.id]: show }))}
          />
        )}
      </div>

      {ratingTarget && (
        <RatingEditor
          showTitle={ratingTarget.title}
          reviewId={ratingTarget.reviewId}
          initialRating={ratingTarget.initialRating ?? 0}
          initialReviewText={ratingTarget.initialReviewText}
          initialDateSeen={ratingTarget.initialDateSeen}
          presentation="modal"
          onSave={handleInlineRatingSave}
          onSaved={() => setRatingTarget(null)}
          onCancel={() => setRatingTarget(null)}
        />
      )}

      {/* Stats bar — tab badges carry the seen/watchlist/lists counts now, so
          only the two signals WITHOUT a badge live here (owner: the duplicate
          counts were redundant, 2026-07-12). */}
      {(toBeRatedEntries.length > 0 || upcomingCount > 0) && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-gray-400 mb-2">
          {toBeRatedEntries.length > 0 && (
            <span><strong className="text-amber-400">{toBeRatedEntries.length}</strong> to rate</span>
          )}
          {upcomingCount > 0 && (
            <span><strong className="text-white">{upcomingCount}</strong> upcoming</span>
          )}
        </div>
      )}
      {!isMockMode && user && (
        <div className="mb-6">
          <ImportShows
            userId={user.id}
            existingReviewShowIds={new Set(reviews.map(r => r.show_id))}
            existingWatchlistShowIds={new Set(watchlist.map(w => w.show_id))}
            onImportComplete={() => { getAllReviews(); getWatchlist(true); }}
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
          aria-label={showsSeen > 0 ? `Diary, ${showsSeen} shows` : 'Diary'}
        >
          Diary
          {showsSeen > 0 && (
            <span className="ml-1.5 px-1.5 py-0.5 text-xs bg-white/10 rounded-full" aria-hidden="true">
              {showsSeen}
            </span>
          )}
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
            <span className="ml-1.5 px-1.5 py-0.5 text-xs bg-white/10 rounded-full" aria-hidden="true">
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
          aria-label={listsCount > 0 ? `Lists, ${listsCount} lists` : 'Lists'}
        >
          Lists
          {listsCount > 0 && (
            <span className="ml-1.5 px-1.5 py-0.5 text-xs bg-white/10 rounded-full" aria-hidden="true">
              {listsCount}
            </span>
          )}
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
              onClick={() => pickView(activeTab === 'diary' ? 'diary' : 'watchlist', 'grid')}
              className={`inline-flex items-center justify-center w-8 outline-none transition-colors ${(activeTab === 'diary' ? diaryView : watchlistView) === 'grid' ? 'bg-white/[0.15] text-white' : 'text-gray-500 hover:text-gray-300'}`}
              aria-label="Grid view"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zm10 0a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zm10 0a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z" />
              </svg>
            </button>
            <button
              type="button"
              onClick={() => pickView(activeTab === 'diary' ? 'diary' : 'watchlist', 'list')}
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
              className="text-xs bg-white/5 border border-white/10 rounded px-1.5 py-1 h-9 text-gray-300 max-w-[90px]"
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
              className="text-xs bg-white/5 border border-white/10 rounded px-1.5 py-1 h-9 text-gray-300 max-w-[90px]"
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
              onClick={() => pickView(activeTab === 'diary' ? 'diary' : 'watchlist', 'grid')}
              className={`inline-flex items-center justify-center w-9 outline-none transition-colors ${(activeTab === 'diary' ? diaryView : watchlistView) === 'grid' ? 'bg-white/[0.15] text-white' : 'text-gray-500 hover:text-gray-300'}`}
              aria-label="Grid view"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zm10 0a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zm10 0a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z" />
              </svg>
            </button>
            <button
              type="button"
              onClick={() => pickView(activeTab === 'diary' ? 'diary' : 'watchlist', 'list')}
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
                    <span className="text-xs text-gray-500">{toBeRatedEntries.length} {toBeRatedEntries.length === 1 ? 'entry' : 'entries'}</span>
                  </div>
                  <p className="text-xs text-gray-500 mb-3">You saw these shows — how were they?</p>
                  <div className="space-y-2">
                    {toBeRatedEntries.map(entry => (
                      <ToBeRatedCard
                        key={`rate-${entry.id}`}
                        entry={entry}
                        show={showMap[entry.show_id]}
                        onRemove={async () => { await effectiveRemoveFromWatchlist(entry.show_id); showToast?.('Removed — no rating needed.', 'info'); }}
                        onRate={openRatingEditor}
                      />
                    ))}
                  </div>
                </div>
              )}

              {/* Upcoming section — watchlist entries with future dates + reviews with future date_seen */}
              {(upcomingWatchlistEntries.length > 0 || upcomingReviews.length > 0) && (
                <div className="mb-8">
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="text-xs font-bold text-gray-500 uppercase tracking-wider">Upcoming</h3>
                    <span className="text-xs text-gray-500">{upcomingWatchlistEntries.length + upcomingReviews.length} {(upcomingWatchlistEntries.length + upcomingReviews.length) === 1 ? 'entry' : 'entries'}</span>
                  </div>
                  {diaryView === 'list' ? (
                    <div className="space-y-2">
                      {upcomingWatchlistEntries.map(entry => {
                        const entryShow = showMap[entry.show_id];
                        const entryTitle = entryShow?.title || entry.show_id;
                        const entrySlug = entryShow?.slug || entry.show_id;
                        const entryHref = getShowHref(entrySlug, entryShow?.diaryOnly);
                        const daysUntil = entry.planned_date
                          ? Math.ceil((new Date(entry.planned_date + 'T00:00:00').getTime() - new Date().getTime()) / (1000 * 60 * 60 * 24))
                          : null;
                        const entryFormattedDate = entry.planned_date
                          ? new Date(entry.planned_date + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
                          : null;
                        return (
                          <div key={`wl-${entry.id}`} className="relative flex items-center gap-3 px-3 sm:px-5 py-2.5 sm:py-3 rounded-xl bg-white/[0.02] border border-white/[0.06] hover:border-white/10 hover:bg-white/[0.04] transition-colors">
                            {entryHref && <Link href={entryHref} className="absolute inset-0 z-0" aria-label={`View ${entryTitle}`} />}
                            <div className="relative z-[1] flex-shrink-0 w-14 sm:w-16 aspect-square rounded-lg overflow-hidden bg-surface-overlay pointer-events-none">
                              <Poster url={entryShow?.posterUrl} iconClass="text-xl" />
                            </div>
                            <div className="relative z-[1] flex-1 min-w-0 pointer-events-none">
                              <h4 className="font-bold text-white text-base truncate">{entryTitle}</h4>
                              {entryShow?.venue && <p className="text-sm text-gray-500 truncate">{entryShow.venue}</p>}
                            </div>
                            <div className="relative z-[1] flex-shrink-0 text-right pointer-events-none">
                              {entryFormattedDate && <p className="text-sm font-medium text-amber-400">{entryFormattedDate}</p>}
                              {daysUntil !== null && daysUntil > 0 && (
                                <p className="text-xs text-gray-500 mt-0.5">
                                  {daysUntil === 1 ? 'Tomorrow' : `${daysUntil}d`}
                                </p>
                              )}
                            </div>
                            <RowRemoveButton
                              onRemove={async () => { await effectiveRemoveFromWatchlist(entry.show_id); showToast?.('Removed from watchlist.', 'info'); }}
                              label={`Remove ${entryTitle} from watchlist`}
                            />
                          </div>
                        );
                      })}
                      {upcomingReviews.map(review => (
                        <DiaryCard key={review.id} review={review} show={showMap[review.show_id]} onDelete={() => handleDeleteReviewWithToast(review.id)} onRate={openRatingEditor} />
                      ))}
                    </div>
                  ) : (
                    <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
                      {upcomingWatchlistEntries.map(entry => {
                        const entryShow = showMap[entry.show_id];
                        const entrySlug = entryShow?.slug || entry.show_id;
                        const entryHref = getShowHref(entrySlug, entryShow?.diaryOnly);
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
                        <DiaryGridCard key={review.id} review={review} show={showMap[review.show_id]} onDelete={() => handleDeleteReviewWithToast(review.id)} onRate={openRatingEditor} />
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
                          <span className="text-xs text-gray-500">{pastReviews.length} {pastReviews.length === 1 ? 'entry' : 'entries'}</span>
                        </div>
                      )}
                      {diaryView === 'list' ? (
                        <div className="space-y-2">
                          {pastReviews.map(review => (
                            <DiaryCard key={review.id} review={review} show={showMap[review.show_id]} onDelete={() => handleDeleteReviewWithToast(review.id)} onRate={openRatingEditor} />
                          ))}
                          <AddShowCard context="diary" variant="list" onOpen={() => {
                            const btn = document.querySelector<HTMLButtonElement>('[aria-label="Add a show to diary"], [aria-label="Rate a show"]');
                            btn?.click();
                          }} />
                        </div>
                      ) : (
                        <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
                          {pastReviews.map(review => (
                            <DiaryGridCard key={review.id} review={review} show={showMap[review.show_id]} onDelete={() => handleDeleteReviewWithToast(review.id)} onRate={openRatingEditor} />
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
                  // Group by date_seen ONLY. The old created_at fallback filed
                  // undated imports under the year they were IMPORTED, silently
                  // mixing them into real viewing history (owner report,
                  // 2026-07-14: undated Show Score reviews showed as 2026).
                  const dateStr = review.date_seen;
                  const year = dateStr ? new Date(dateStr.includes('T') ? dateStr : dateStr + 'T00:00:00').getFullYear().toString() : 'No date';
                  if (!reviewsByYear[year]) reviewsByYear[year] = [];
                  reviewsByYear[year].push(review);
                }
                // Sort years descending (newest first), with 'No date' at end
                const sortedYears = Object.keys(reviewsByYear).sort((a, b) => {
                  if (a === 'No date') return 1;
                  if (b === 'No date') return -1;
                  return diarySort === 'date-asc' ? a.localeCompare(b) : b.localeCompare(a);
                });
                const hasOtherSections = upcomingReviews.length > 0 || upcomingWatchlistEntries.length > 0 || toBeRatedEntries.length > 0;
                const showYearHeaders = diaryView === 'grid' || sortedYears.length > 1 || hasOtherSections;

                return (
                  <>
                    {hasOtherSections && (
                      <div className="flex items-center justify-between mb-3">
                        <h3 className="text-xs font-bold text-gray-500 uppercase tracking-wider">Past Shows</h3>
                        <span className="text-xs text-gray-500">{pastReviews.length} {pastReviews.length === 1 ? 'entry' : 'entries'}</span>
                      </div>
                    )}
                    <div className="space-y-6">
                    {sortedYears.map((year, yearIdx) => (
                      <div key={year}>
                        {showYearHeaders && (
                          <div className={`flex items-center justify-between mb-3${diaryView === 'list' && yearIdx > 0 ? ' pt-4 border-t border-white/[0.06]' : ''}`}>
                            <h3 className="text-xs font-bold text-gray-500 uppercase tracking-wider">
                              {year}
                              {year === 'No date' && (
                                <span className="normal-case font-normal tracking-normal text-gray-600"> — edit a show to add when you saw it</span>
                              )}
                            </h3>
                            <span className="text-xs text-gray-500">{reviewsByYear[year].length} {reviewsByYear[year].length === 1 ? 'entry' : 'entries'}</span>
                          </div>
                        )}
                        {diaryView === 'list' ? (
                          <div className="space-y-2">
                            {reviewsByYear[year].map(review => (
                              <DiaryCard key={review.id} review={review} show={showMap[review.show_id]} onDelete={() => handleDeleteReviewWithToast(review.id)} onRate={openRatingEditor} />
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
                              <DiaryGridCard key={review.id} review={review} show={showMap[review.show_id]} onDelete={() => handleDeleteReviewWithToast(review.id)} onRate={openRatingEditor} />
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
                    onDateChange={(date) => handlePlannedDateChange(entry.show_id, date)}
                    onRemove={async () => { await effectiveRemoveFromWatchlist(entry.show_id); showToast?.('Removed from Watchlist.', 'info'); }}
                    onRate={openRatingEditor}
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
                    onDateChange={(date) => handlePlannedDateChange(entry.show_id, date)}
                    onRemove={async () => { await effectiveRemoveFromWatchlist(entry.show_id); showToast?.('Removed from Watchlist.', 'info'); }}
                    onRate={openRatingEditor}
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
                          onDateChange={(date) => handlePlannedDateChange(entry.show_id, date)}
                          onRemove={async () => { await effectiveRemoveFromWatchlist(entry.show_id); showToast?.('Removed from Watchlist.', 'info'); }}
                          onRate={openRatingEditor}
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
                          onDateChange={(date) => handlePlannedDateChange(entry.show_id, date)}
                          onRemove={async () => { await effectiveRemoveFromWatchlist(entry.show_id); showToast?.('Removed from Watchlist.', 'info'); }}
                          onRate={openRatingEditor}
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
                          onDateChange={(date) => handlePlannedDateChange(entry.show_id, date)}
                          onRemove={async () => { await effectiveRemoveFromWatchlist(entry.show_id); showToast?.('Removed from Watchlist.', 'info'); }}
                          onRate={openRatingEditor}
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
                          onDateChange={(date) => handlePlannedDateChange(entry.show_id, date)}
                          onRemove={async () => { await effectiveRemoveFromWatchlist(entry.show_id); showToast?.('Removed from Watchlist.', 'info'); }}
                          onRate={openRatingEditor}
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

/**
 * Trailing ✕ for list rows (watchlist/to-be-rated) with the same two-tap
 * confirm pattern as the grid cards — "sold my tickets / didn't go" needs a
 * removal path that doesn't require opening the show page (owner, 2026-07-13).
 */
function RowRemoveButton({ onRemove, label }: { onRemove: () => void; label: string }) {
  const [confirm, setConfirm] = useState(false);
  useEffect(() => {
    if (!confirm) return;
    const timer = setTimeout(() => setConfirm(false), 4000);
    return () => clearTimeout(timer);
  }, [confirm]);

  if (confirm) {
    return (
      <span className="relative z-[2] flex items-center gap-1 text-xs flex-shrink-0 pointer-events-auto">
        <button type="button" onClick={(e) => { e.preventDefault(); e.stopPropagation(); onRemove(); }} className="text-red-400 hover:text-red-300 font-medium">Remove?</button>
        <button type="button" onClick={(e) => { e.preventDefault(); e.stopPropagation(); setConfirm(false); }} className="text-gray-500 hover:text-white">No</button>
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); setConfirm(true); }}
      aria-label={label}
      className="relative z-[2] flex-shrink-0 p-1.5 rounded-full text-gray-600 hover:text-red-400 transition-colors pointer-events-auto"
    >
      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
      </svg>
    </button>
  );
}

function DiaryCard({ review, show, onDelete, onRate }: { review: UserReview; show?: ShowLookup; onDelete?: () => void; onRate?: (show: { id: string; title: string }, opts: { reviewId: string; initialRating: number; initialReviewText: string | null; initialDateSeen: string | null }) => void }) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  // Auto-dismiss delete confirmation after 4 seconds
  useEffect(() => {
    if (!confirmDelete) return;
    const timer = setTimeout(() => setConfirmDelete(false), 4000);
    return () => clearTimeout(timer);
  }, [confirmDelete]);
  const title = show?.title || review.show_id;
  const slug = show?.slug || review.show_id;
  const href = getShowHref(slug, show?.diaryOnly);

  // Rendered twice (mobile in-flow / desktop corner) — only one breakpoint
  // container is visible at a time, so the shared confirm state is safe.
  const actionIcons = (
    <>
      {href ? (
        <Link
          href={`${href}?edit=1`}
          className="p-1 rounded-full text-gray-600 hover:text-white transition-colors"
          aria-label="Edit rating"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
          </svg>
        </Link>
      ) : onRate ? (
        <button
          type="button"
          onClick={() => onRate({ id: review.show_id, title }, { reviewId: review.id, initialRating: review.rating, initialReviewText: review.review_text, initialDateSeen: review.date_seen })}
          className="p-1 rounded-full text-gray-600 hover:text-white transition-colors"
          aria-label="Edit rating"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
          </svg>
        </button>
      ) : null}
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
        <span className="relative z-[1] flex items-center gap-1 text-xs">
          <button type="button" onClick={(e) => { e.preventDefault(); e.stopPropagation(); onDelete?.(); }} className="text-red-400 hover:text-red-300 font-medium">Delete?</button>
          <button type="button" onClick={(e) => { e.preventDefault(); e.stopPropagation(); setConfirmDelete(false); }} className="text-gray-500 hover:text-white">No</button>
        </span>
      )}
    </>
  );

  return (
    <div className="group/diary relative flex items-center gap-3 px-3 sm:px-5 py-2.5 sm:py-3 rounded-xl bg-white/[0.02] border border-white/[0.06] hover:border-white/10 hover:bg-white/[0.04] transition-colors">
      {/* Link overlay for the whole card — getShowHref always returns a URL
          (diary-only shows link to /diary-show/[id]); the `href &&` guard is
          defensive only. */}
      {href && <Link href={href} className="absolute inset-0 z-0" aria-label={`View ${title}`} />}

      {/* Poster — square thumbnail to match homepage cards */}
      <div className="relative z-[1] pointer-events-none flex-shrink-0 w-14 sm:w-16 aspect-square rounded-lg overflow-hidden bg-surface-overlay">
        <Poster url={show?.posterUrl} iconClass="text-xl" />
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

      {/* Rating — same md stars as the To Be Rated rows above (a smaller size
          here read as "worse" stars; desktop edit/delete moved to the
          top-right corner so the stars don't have to shrink — owner,
          2026-07-13). Mobile keeps icons IN-FLOW next to the compact rating:
          the absolute corner collided with the star+number at 390px. */}
      <div className="relative z-[1] pointer-events-none flex-shrink-0 flex items-center gap-1.5">
        {/* Single star + number on mobile, full stars on desktop */}
        <span className="md:hidden flex items-center gap-1">
          <svg className="w-5 h-5 text-amber-400" fill="currentColor" viewBox="0 0 20 20"><path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" /></svg>
          <span className="text-base font-bold text-amber-400">{review.rating % 1 === 0 ? review.rating.toFixed(0) : review.rating.toFixed(1)}</span>
        </span>
        <span className="hidden md:inline-flex"><StarRating rating={review.rating} onRatingChange={() => {}} size="md" readOnly hideLabel /></span>
        <div className="flex md:hidden items-center gap-0.5 pointer-events-auto">{actionIcons}</div>
      </div>
      {/* Desktop edit + delete — top-right corner, revealed on hover */}
      <div className="absolute top-1.5 right-1.5 z-[2] hidden md:flex items-center gap-0.5 opacity-0 group-hover/diary:opacity-100 focus-within:opacity-100 transition-opacity pointer-events-auto">
        {actionIcons}
      </div>
    </div>
  );
}

function UpcomingGridCard({ href, posterUrl, date, onRemove }: { href: string | null; posterUrl?: string; date: string | null; onRemove: () => void }) {
  const [confirmRemove, setConfirmRemove] = useState(false);
  useEffect(() => {
    if (!confirmRemove) return;
    const timer = setTimeout(() => setConfirmRemove(false), 4000);
    return () => clearTimeout(timer);
  }, [confirmRemove]);

  return (
    <div className="group/grid flex flex-col rounded-xl bg-white/[0.02] border border-white/[0.06] hover:border-white/10 hover:bg-white/[0.04] transition-colors overflow-hidden">
      <CardLinkOrDiv href={href} className="relative">
        <div className="aspect-[2/3] bg-surface-overlay">
          <Poster url={posterUrl} iconClass="text-3xl" />
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
      </CardLinkOrDiv>
      {date && (
        <div className="px-2 py-1.5 text-center">
          <p className="text-xs font-medium text-amber-400 truncate">{date}</p>
        </div>
      )}
    </div>
  );
}


/** Wraps card content in a Link when href is set, plain div otherwise. In
 *  practice getShowHref() always returns a URL now (diary-only shows link to
 *  /diary-show/[id]) — this is defensive for a future caller that passes null. */
function CardLinkOrDiv({ href, className, children }: { href: string | null; className?: string; children: ReactNode }) {
  if (href) {
    return <Link href={href} className={className}>{children}</Link>;
  }
  return <div className={className}>{children}</div>;
}

/** Poster image that degrades to the 🎭 placeholder when the URL is missing
 *  OR fails to load — a stored poster path that 404s otherwise renders as a
 *  broken-image icon in the diary grid (owner report, 2026-07-14). */
function Poster({ url, iconClass = 'text-3xl' }: { url: string | null | undefined; iconClass?: string }) {
  const [broken, setBroken] = useState(false);
  if (!url || broken) {
    return <div className={`w-full h-full flex items-center justify-center text-gray-600 ${iconClass}`}>🎭</div>;
  }
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={url} alt="" className="w-full h-full object-cover" onError={() => setBroken(true)} />;
}

function DiaryGridCard({ review, show, onDelete, onRate }: { review: UserReview; show?: ShowLookup; onDelete?: () => void; onRate?: (show: { id: string; title: string }, opts: { reviewId: string; initialRating: number; initialReviewText: string | null; initialDateSeen: string | null }) => void }) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => {
    if (!confirmDelete) return;
    const timer = setTimeout(() => setConfirmDelete(false), 4000);
    return () => clearTimeout(timer);
  }, [confirmDelete]);
  const title = show?.title || review.show_id;
  const slug = show?.slug || review.show_id;
  const href = getShowHref(slug, show?.diaryOnly);

  return (
    <div className="group/grid flex flex-col rounded-xl bg-white/[0.02] border border-white/[0.06] hover:border-white/10 hover:bg-white/[0.04] transition-colors overflow-hidden">
      <CardLinkOrDiv href={href} className="relative">
        <div className="aspect-[2/3] bg-surface-overlay">
          <Poster url={show?.posterUrl} iconClass="text-3xl" />
        </div>
        {/* Written-note preview on hover (desktop) — grid view otherwise hides
            the note entirely (owner request, 2026-07-13) */}
        {review.review_text && (
          <div className="absolute inset-x-0 bottom-0 z-[1] hidden sm:block opacity-0 group-hover/grid:opacity-100 transition-opacity pointer-events-none">
            <div className="bg-gradient-to-t from-black/95 via-black/80 to-transparent px-2.5 pt-10 pb-2.5">
              <p className="text-xs text-gray-200 italic leading-snug line-clamp-4">{review.review_text}</p>
            </div>
          </div>
        )}
        {/* Fallback edit affordance for the (now unreachable in practice)
            case where getShowHref() can't resolve a diary-only show's page —
            href is null, and this inline modal is the only way to edit. */}
        {!href && onRate && (
          <button
            type="button"
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); onRate({ id: review.show_id, title }, { reviewId: review.id, initialRating: review.rating, initialReviewText: review.review_text, initialDateSeen: review.date_seen }); }}
            className="absolute top-2 left-2 z-[2] w-7 h-7 hidden sm:flex items-center justify-center rounded-full bg-black/70 text-gray-400 hover:text-white opacity-0 group-hover/grid:opacity-100 transition-opacity"
            aria-label="Edit rating"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
            </svg>
          </button>
        )}
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
      </CardLinkOrDiv>
      {/* Stars below image — centered, filled only (Mezzanine-style), with the
          date seen directly beneath (owner placement call, 2026-07-13) */}
      <div className="px-2 py-1.5">
        <div className="flex justify-center gap-0.5 min-h-[18px]">
          {review.rating > 0 && <MiniStars rating={review.rating} size="md" filledOnly />}
        </div>
        {review.date_seen && (
          <p className="mt-0.5 text-xs text-amber-400/80 text-center truncate">
            {new Date(review.date_seen + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
          </p>
        )}
      </div>
    </div>
  );
}

function WatchlistCard({ entry, show, onDateChange, onRemove, onRate }: {
  entry: WatchlistEntry;
  show?: ShowLookup;
  onDateChange: (date: string | null) => void;
  onRemove: () => void;
  onRate: (show: { id: string; title: string }) => void;
}) {
  const [confirmRemove, setConfirmRemove] = useState(false);
  useEffect(() => {
    if (!confirmRemove) return;
    const timer = setTimeout(() => setConfirmRemove(false), 4000);
    return () => clearTimeout(timer);
  }, [confirmRemove]);
  const title = show?.title || entry.show_id;
  const slug = show?.slug || entry.show_id;
  const href = getShowHref(slug, show?.diaryOnly);
  const rateHref = href ? `${href}?rate=1` : null;
  const handleRateClick = () => {
    if (rateHref) window.location.href = rateHref;
    else onRate({ id: entry.show_id, title });
  };

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
      <CardLinkOrDiv href={href} className="relative">
        <div className="aspect-[2/3] bg-surface-overlay relative">
          <Poster url={show?.posterUrl} iconClass="text-3xl" />
          {isClosingSoon && (
            <span className="absolute bottom-1.5 left-1.5 px-1.5 py-0.5 text-[9px] font-bold uppercase bg-amber-500/90 text-black rounded">
              Closing Soon
            </span>
          )}
        </div>
        {/* Rate overlay — navigates to show page with ?rate=1 (or opens the
            inline rating modal for diary-only shows with no /show page) */}
        {/* On mobile: "Rate" button at bottom; on desktop: 5 empty stars on hover */}
        <div
          role="button"
          tabIndex={0}
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); handleRateClick(); }}
          onKeyDown={(e) => { if (e.key === 'Enter') handleRateClick(); }}
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
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); handleRateClick(); }}
            onKeyDown={(e) => { if (e.key === 'Enter') handleRateClick(); }}
            className="text-xs font-semibold text-white/90 flex items-center gap-1 cursor-pointer"
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
      </CardLinkOrDiv>
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

/** My Shows presentation of the shared date-picker mechanics (SharedDatePicker). */
function DatePickerButton({ value, label, hasDate, onChange }: { value: string; label: string; hasDate?: boolean; onChange: (val: string) => void }) {
  return (
    <SharedDatePicker
      value={value}
      onChange={onChange}
      ariaLabel="Planned date"
      wrapClassName="relative mt-1"
      className={`w-full flex items-center justify-center gap-1 sm:gap-1.5 text-xs sm:text-xs transition-colors cursor-pointer min-h-[32px] sm:min-h-[36px] px-1.5 sm:px-2 rounded-lg ${
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
    </SharedDatePicker>
  );
}

function WatchlistListItem({ entry, show, onDateChange, onRemove, onRate }: {
  entry: WatchlistEntry;
  show?: ShowLookup;
  onDateChange: (date: string | null) => void;
  onRemove: () => void;
  onRate: (show: { id: string; title: string }) => void;
}) {
  const [confirmRemove, setConfirmRemove] = useState(false);
  useEffect(() => {
    if (!confirmRemove) return;
    const timer = setTimeout(() => setConfirmRemove(false), 4000);
    return () => clearTimeout(timer);
  }, [confirmRemove]);
  const title = show?.title || entry.show_id;
  const slug = show?.slug || entry.show_id;
  const href = getShowHref(slug, show?.diaryOnly);

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
      {href && <Link href={href} className="absolute inset-0 z-0" aria-label={`View ${title}`} />}

      <div className="relative z-[1] flex-shrink-0 w-14 sm:w-16 aspect-square rounded-lg overflow-hidden bg-surface-overlay">
        <Poster url={show?.posterUrl} iconClass="text-xl" />
      </div>

      <div className="relative z-[1] flex-1 min-w-0">
        <h4 className="font-bold text-white text-base group-hover/wl:text-brand transition-colors truncate">{title}</h4>
        {show?.venue && <p className="text-sm text-gray-500 truncate">{show.venue}</p>}
        {isClosingSoon && (
          <span className="inline-block mt-1 px-1.5 py-0.5 text-[9px] font-bold uppercase bg-amber-500/90 text-black rounded">Closing Soon</span>
        )}
        {show?.closingDate && (
          <p className="text-xs text-gray-500 mt-1">
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
          {href ? (
            <Link
              href={`${href}?rate=1`}
              className="relative z-[1] text-xs sm:text-xs text-gray-500 hover:text-amber-400 transition-colors flex items-center gap-1"
            >
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
              </svg>
              Rate
            </Link>
          ) : (
            <button
              type="button"
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); onRate({ id: entry.show_id, title }); }}
              className="relative z-[1] text-xs sm:text-xs text-gray-500 hover:text-amber-400 transition-colors flex items-center gap-1"
            >
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
              </svg>
              Rate
            </button>
          )}
          {confirmRemove ? (
            <span className="relative z-[1] flex items-center gap-1 text-xs">
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
  /** True for diary-only (unscored) catalog entries — no /show page. */
  dy?: boolean;
}

function AddShowSearch({
  context,
  userId,
  onAddToWatchlist,
  onRateDiaryOnly,
  existingWatchlistIds,
  existingReviewIds,
  onLiveShowAdded,
}: {
  context: 'diary' | 'watchlist';
  /** Gates the live Mezzanine catalog search — signed out / mock mode never
   *  offers it (the edge function is JWT-gated anyway). */
  userId: string | null;
  onAddToWatchlist: (showId: string) => Promise<void>;
  /** Diary-only shows have no /show page to deep-link ?rate=1 into — open the
   *  inline rating modal instead. */
  onRateDiaryOnly: (show: { id: string; title: string }) => void;
  existingWatchlistIds: Set<string>;
  existingReviewIds: Set<string>;
  /** A live-search selection writes a user_show_stubs row and needs its
   *  metadata in showMap immediately (before the nightly resolver promotes
   *  it) so the card the user just added renders correctly right away. */
  onLiveShowAdded: (show: ShowLookup) => void;
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

  const handleSelect = async (show: { id: string; slug: string; title: string; dy?: boolean }) => {
    if (context === 'watchlist') {
      if (!existingWatchlistIds.has(show.id)) {
        setAddingId(show.id);
        try {
          await onAddToWatchlist(show.id);
        } finally {
          setAddingId(null);
        }
      }
    } else if (show.dy) {
      onRateDiaryOnly(show);
    } else {
      router.push(`/show/${show.slug}?rate=1`);
    }
    setIsOpen(false);
  };

  // A show in neither catalog: write the stub row (best-effort — the
  // nightly resolver re-derives everything from Mezzanine on promotion, so
  // a failed insert here just means the card renders from local state only
  // until the user retries), inject it into showMap so the card the user
  // just picked renders immediately, then proceed exactly like a normal
  // diary-only selection.
  const handleLiveSelect = async (candidate: MezzanineCandidate) => {
    if (!userId) return;
    supabaseRestInsert('user_show_stubs', stubRowFromCandidate(candidate, userId)).catch(() => {});
    onLiveShowAdded({
      id: candidate.id,
      title: candidate.title,
      slug: candidate.id,
      venue: candidate.venue || '',
      type: 'play',
      status: 'closed',
      category: candidate.category,
      previewDate: null,
      openingDate: candidate.openingDate,
      closingDate: null,
      compositeScore: null,
      posterUrl: candidate.posterUrl,
      diaryOnly: true,
    });
    await handleSelect({ id: candidate.id, slug: candidate.id, title: candidate.title, dy: true });
  };

  if (!isOpen) {
    return (
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        className="btn-primary gap-1.5 text-xs"
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
        includeDiary
        enableLiveLookup={!!userId}
        onLiveSelect={handleLiveSelect}
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
function ToBeRatedCard({ entry, show, onRemove, onRate }: { entry: WatchlistEntry; show?: ShowLookup; onRemove: () => void; onRate: (show: { id: string; title: string }, opts: { initialRating: number }) => void }) {
  const router = useRouter();
  const title = show?.title || entry.show_id;
  const slug = show?.slug || entry.show_id;
  const href = getShowHref(slug, show?.diaryOnly);
  const handleStarRate = (rating: number) => {
    if (href) router.push(`${href}?rate=1&stars=${rating}`);
    else onRate({ id: entry.show_id, title }, { initialRating: rating });
  };

  return (
    <div className="relative flex items-center gap-3 px-3 sm:px-5 py-3 rounded-xl bg-amber-500/[0.03] border border-amber-500/10 hover:border-amber-500/20 hover:bg-amber-500/[0.06] transition-colors">
      {href && <Link href={href} className="absolute inset-0 z-0" aria-label={`Rate ${title}`} />}
      <div className="relative z-[1] flex-shrink-0 w-14 sm:w-16 aspect-square rounded-lg overflow-hidden bg-surface-overlay pointer-events-none">
        <Poster url={show?.posterUrl} iconClass="text-xl" />
      </div>
      {/* Mobile: stars stack UNDER the title so it stays legible (a side-by-side
          row crushed titles to one character at 390px — 2026-07-12 design pass).
          sm+: title and stars side by side as before. */}
      <div className="flex-1 min-w-0 flex flex-col sm:flex-row sm:items-center gap-1.5 sm:gap-3">
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
          {/* sm stars on mobile (stacked row has room), md on desktop */}
          <span className="sm:hidden">
            <StarRating
              rating={null}
              onRatingChange={handleStarRate}
              size="sm"
            />
          </span>
          <span className="hidden sm:inline-flex">
            <StarRating
              rating={null}
              onRatingChange={handleStarRate}
              size="md"
            />
          </span>
        </div>
      </div>
      {/* Didn't go / sold tickets — remove without opening the show page */}
      <RowRemoveButton onRemove={onRemove} label={`Remove ${title} — didn't see it`} />
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
        <span className="text-xs font-medium">{context === 'diary' ? 'Rate' : 'Add'}</span>
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
        className="btn-primary text-sm"
      >
        {ctaLabel}
      </Link>
    </div>
  );
}
