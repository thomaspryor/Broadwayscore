'use client';

import { useState, useEffect, useMemo, useRef, useCallback, type ReactNode } from 'react';
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
import { supabaseRestDelete, supabaseRestInsert, supabaseRestSelect, supabaseRestUpdate } from '@/lib/supabase-rest';
import { trackUgc } from '@/lib/ugc-analytics';
import { prepareAppleSignIn } from '@/lib/apple-auth';
import { stubRowFromCandidate, type MezzanineCandidate } from '@/lib/mezzanine-search';
import SharedDatePicker from '@/components/user/DatePickerButton';
import AddToCalendarButtons from '@/components/user/AddToCalendarButtons';
import { buildPlannedShowEvent } from '@/lib/calendar-event';
import { selectSharedPlans, toSharedEntries, type PlanShowLike } from '@/lib/shared-plans/select';
import { ownerDiaryPayload, selectSharedDiary } from '@/lib/shared-diary/select';
import { getShowStubsByIds } from '@/lib/show-stubs';
import { Poster, PosterGridCard, SectionBand, UpcomingListRow, ViewModeToggle, bookabilityLabel, formatPillDate, type ViewMode } from '@/components/user/upcoming-cards';
import { localToday, formatShowDate } from '@/lib/date-utils';

import { useToastSafe } from '@/components/ui/Toast';
import type { UserReview, WatchlistEntry, ShowLookup } from '@/types/user';
import dynamic from 'next/dynamic';
import { ShowSearchDropdown } from '@/components/show-cards';
import MiniStars from '@/components/user/Stars';
const ImportShows = dynamic(() => import('./ImportShows'), { ssr: false });

const ListsTab = dynamic(() => import('./ListsTab').catch(() => {
  return { default: () => <div className="text-center py-12 text-red-400">Failed to load lists. Please refresh the page.</div> };
}), {
  loading: () => <div className="text-center py-12 text-gray-500">Loading lists...</div>,
});

const SharePlansModal = dynamic(() => import('@/components/user/SharePlansModal'), { ssr: false });
const ShareDiaryModal = dynamic(() => import('@/components/user/ShareDiaryModal'), { ssr: false });

function ShareIcon() {
  return (
    <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M4 12v7a2 2 0 002 2h12a2 2 0 002-2v-7M16 6l-4-4-4 4M12 2v14" />
    </svg>
  );
}

type Tab = 'diary' | 'watchlist' | 'lists';
type DiarySort = 'date-desc' | 'date-asc' | 'rating-desc';
type WatchlistSort = 'added-desc' | 'alphabetical' | 'closing-soon';
/** A welcome-sheet "seen it" pick with no stars and no date (BRO-4619). */
interface SeenUnratedRow { show_id: string; created_at: string }
/** A To Be Rated poster: a past-dated watchlist row, or a seen_unrated pick (no date). */
type ToBeRatedEntry = Pick<WatchlistEntry, 'id' | 'show_id' | 'planned_date'>;

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
    previewDate: (raw.pd as string) || null,
    openingDate: (raw.od as string) || null,
    closingDate: (raw.cd as string) || null,
    compositeScore: null,
    posterUrl: (raw.p as string) || null,
    diaryOnly: !!raw.dy,
    ticketsOnSale: !!raw.tx,
    theaterAddress: (raw.a as string) || undefined,
    runtimeMin: typeof raw.rt === 'number' ? raw.rt : undefined,
  };
}

// Fetch stub metadata directly from user_show_stubs (public SELECT, no auth
// needed) for ids a fresh diary-lookup.json fetch still doesn't know about —
// i.e. shows added via live Mezzanine search since the last nightly resolver
// run (card 174). Returns a partial ShowMap; a failed/empty fetch is not an
// error — those ids simply keep rendering degraded until the next resolver
// pass regenerates diary-lookup.json.
async function fetchShowStubs(ids: string[]): Promise<ShowMap> {
  // Batched and quoted (src/lib/show-stubs.ts): a big import no longer builds
  // one over-long URL, and a failed batch drops only its own ids.
  const stubs = await getShowStubsByIds(ids);
  const additions: ShowMap = {};
  stubs.forEach((r, id) => {
    additions[id] = {
      id,
      title: r.title,
      slug: id,
      venue: r.venue || '',
      type: 'play',
      status: 'closed',
      category: r.category ?? 'broadway',
      previewDate: null,
      openingDate: r.openingDate,
      closingDate: null,
      compositeScore: null,
      posterUrl: r.posterUrl,
      diaryOnly: true,
    };
  });
  return additions;
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

  const { user, profile, isAuthenticated, loading: authLoading, signIn } = useAuth();
  const { reviews: realReviews, getAllReviews, deleteReview, loading: reviewsLoading, error: reviewsError } = useUserReviews(user?.id || null);
  const { watchlist: realWatchlist, getWatchlist, addToWatchlist, updatePlannedDate, removeFromWatchlist, loading: watchlistLoading, error: watchlistError } = useWatchlist(user?.id || null);
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
    suggestedDateSeen?: string | null;
  } | null>(null);
  const openRatingEditor = useCallback((show: { id: string; title: string }, opts?: {
    reviewId?: string; initialRating?: number; initialReviewText?: string | null; initialDateSeen?: string | null; suggestedDateSeen?: string | null;
  }) => {
    setRatingTarget({ id: show.id, title: show.title, ...opts });
  }, []);

  // In mock mode, bypass loading/auth and inject fake data
  const [mockData, setMockData] = useState<{ reviews: UserReview[]; watchlist: WatchlistEntry[]; seenUnrated: SeenUnratedRow[]; showMap: ShowMap } | null>(null);
  useEffect(() => {
    if (!isMockMode) return;
    import('./__dev-mock-data').then(mod => {
      setMockData({ reviews: mod.mockReviews, watchlist: mod.mockWatchlist, seenUnrated: mod.mockSeenUnrated, showMap: mod.mockShowMap });
    });
  }, [isMockMode]);

  // "Seen, date not set" picks from the welcome sheet (BRO-4619). Listed under
  // To Be Rated as "Date not set"; a failed load (or the table not being
  // there yet) just shows nothing extra.
  const [realSeenUnrated, setRealSeenUnrated] = useState<SeenUnratedRow[]>([]);
  const userId = user?.id ?? null;
  useEffect(() => {
    if (isMockMode || !userId) { setRealSeenUnrated([]); return; }
    let cancelled = false;
    supabaseRestSelect<SeenUnratedRow>('seen_unrated', `select=show_id,created_at&user_id=eq.${encodeURIComponent(userId)}&order=created_at.desc`)
      .then(r => { if (!cancelled && !r.error) setRealSeenUnrated(r.data || []); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [isMockMode, userId]);

  const reviews = isMockMode && mockData ? mockData.reviews : realReviews;
  const watchlist = isMockMode && mockData ? mockData.watchlist : realWatchlist;
  const seenUnrated = isMockMode && mockData ? mockData.seenUnrated : realSeenUnrated;
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
      // Mirrors the real updatePlannedDate: always clears time_slot/curtain_time,
      // not just on a clear-to-null — a resolved showtime carries a DIFFERENT
      // date's schedule and must not survive a re-date (BRO-221 fix).
      watchlist: prev.watchlist.map(w => w.show_id === showId ? { ...w, planned_date: date, time_slot: null, curtain_time: null } : w),
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
    const showId = reviews.find(r => r.id === reviewId)?.show_id;
    try {
      await effectiveDeleteReview(reviewId);
      // A welcome "seen it" pick that was rated then deleted should not come
      // back under To Be Rated: deleting the rating is how it comes off.
      if (showId && !isMockMode && userId && seenUnrated.some(u => u.show_id === showId)) {
        void supabaseRestDelete('seen_unrated', `user_id=eq.${encodeURIComponent(userId)}&show_id=eq.${encodeURIComponent(showId)}`)
          .then(r => { if (!r.error) setRealSeenUnrated(prev => prev.filter(u => u.show_id !== showId)); })
          .catch(() => {});
      }
      invalidateRatingsCache(); // browse-card ★chips must not outlive the rating
      trackUgc('rating_deleted', { show_id: showId, source: 'my_shows' });
      showToast?.('Rating deleted.', 'info');
    } catch {
      showToast?.('Delete failed. Please try again.', 'error');
    }
  }, [effectiveDeleteReview, showToast, reviews, isMockMode, userId, seenUnrated]);
  const effectiveRemoveFromWatchlist = isMockMode ? mockRemoveFromWatchlist : removeFromWatchlist;
  // Same rethrow-and-toast shape: a failed remove used to reject unhandled
  // inside the row's onClick, leaving the row in place with no explanation.
  const handleRemoveFromWatchlist = useCallback(async (showId: string, successMessage: string) => {
    try {
      await effectiveRemoveFromWatchlist(showId);
      showToast?.(successMessage, 'info');
    } catch {
      showToast?.('Could not remove. Please try again.', 'error');
    }
  }, [effectiveRemoveFromWatchlist, showToast]);
  const effectiveUpdatePlannedDate = isMockMode ? mockUpdatePlannedDate : updatePlannedDate;

  // Just-added-from-search prompt: confirms the add and offers the planned
  // date IN PLACE — quick-add previously required finding the new entry on
  // the watchlist to date it (owner, 2026-07-19). Cleared on date/skip or
  // replaced by the next add.
  const [justAdded, setJustAdded] = useState<{ showId: string; title: string } | null>(null);

  // updatePlannedDate rethrows on failure (Phase 2) — surface it instead of
  // letting the onChange promise reject unhandled with zero feedback.
  const handlePlannedDateChange = useCallback(async (showId: string, date: string | null) => {
    try {
      await effectiveUpdatePlannedDate(showId, date);
      // The picker closes silently, so confirm the write (UX audit, BRO-3175).
      showToast?.(date ? 'Date saved.' : 'Date cleared.', 'success');
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
      if (!updated) throw new Error('This rating no longer exists. It may have been deleted elsewhere.');
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
    const referenced = new Set([...reviews.map(r => r.show_id), ...watchlist.map(w => w.show_id), ...seenUnrated.map(u => u.show_id)]);
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
  }, [isMockMode, showMapLoaded, reviews, watchlist, seenUnrated, showMap]);

  // Load user data when authenticated. getLists swallows failures internally
  // (returns []) and nothing retried — one transient error on first load left
  // the Lists tab count blank until a manual refresh (owner, 2026-07-20).
  // One delayed retry covers the session-restore race window.
  useEffect(() => {
    if (isMockMode) return;
    if (isAuthenticated && user) {
      getAllReviews();
      getWatchlist();
      getLists().then(r => {
        if (r.length === 0) setTimeout(() => { getLists(); }, 1500);
      });
    }
  }, [isMockMode, isAuthenticated, user, getAllReviews, getWatchlist, getLists]);

  // Stats
  const showsSeen = new Set(reviews.map(r => r.show_id)).size;

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
    const today = localToday();
    const reviewedShowIds = new Set(reviews.map(r => r.show_id));
    return watchlist
      .filter(w => w.planned_date && w.planned_date > today && !reviewedShowIds.has(w.show_id))
      .sort((a, b) => (a.planned_date || '').localeCompare(b.planned_date || ''));
  }, [watchlist, reviews]);

  // Watchlist entries where planned_date <= today AND no review exists ("To be rated")
  // plus welcome "seen it" picks with no date, after the dated ones.
  const toBeRatedEntries = useMemo((): ToBeRatedEntry[] => {
    const today = localToday();
    const reviewedShowIds = new Set(reviews.map(r => r.show_id));
    const dated: ToBeRatedEntry[] = watchlist
      .filter(w => w.planned_date && w.planned_date <= today && !reviewedShowIds.has(w.show_id))
      .sort((a, b) => (b.planned_date || '').localeCompare(a.planned_date || ''));
    const listed = new Set(dated.map(e => e.show_id));
    const undated: ToBeRatedEntry[] = seenUnrated
      .filter(u => !reviewedShowIds.has(u.show_id) && !listed.has(u.show_id))
      .map(u => ({ id: `seen-${u.show_id}`, show_id: u.show_id, planned_date: null }));
    return [...dated, ...undated];
  }, [watchlist, reviews, seenUnrated]);

  // Sorted watchlist
  const sortedWatchlist = useMemo(() => {
    const sorted = [...watchlist];
    switch (watchlistSort) {
      case 'added-desc':
        return sorted.sort((a, b) => {
          // Within each section (booked vs unbooked), sort by planned_date or
          // created_at. The date/no-date boundary MUST have its own consistent
          // rule: mixing comparators across it made the order non-transitive,
          // so a freshly-added show landed mid-list under "Recent"
          // (owner report, 2026-07-19). Sections are split after this sort,
          // so the boundary's direction is invisible — only its consistency
          // matters.
          const aHasDate = !!a.planned_date;
          const bHasDate = !!b.planned_date;
          if (aHasDate !== bHasDate) return aHasDate ? 1 : -1;
          if (aHasDate) return (a.planned_date || '').localeCompare(b.planned_date || '');
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

  // Split watchlist into UPCOMING (future planned_date — shown at the TOP so
  // adding a date doesn't read as the show "disappearing" into a below-the-fold
  // Booked section; owner, 2026-07-20), "not yet booked" (no date), and
  // past-dated entries (seen — surfaced as To Be Rated, mirroring the Diary).
  // Local timezone, NOT UTC: with UTC, from ~8pm ET a show planned for
  // TONIGHT flipped from Upcoming to To Be Rated before curtain
  // (code-review catch, 2026-07-20). Mirrors RatingEditor.localToday().
  const wlToday = localToday();
  const upcomingBookedWatchlist = useMemo(
    () => sortedWatchlist.filter(e => !!e.planned_date && e.planned_date >= wlToday),
    [sortedWatchlist, wlToday],
  );
  const unbookedWatchlist = useMemo(() => sortedWatchlist.filter(e => !e.planned_date), [sortedWatchlist]);
  const seenToRateWatchlist = useMemo(
    () => sortedWatchlist.filter(e => !!e.planned_date && e.planned_date < wlToday && !reviews.some(r => r.show_id === e.show_id)),
    [sortedWatchlist, wlToday, reviews],
  );
  // Rendered watchlist size — excludes stale rows (past-dated + already
  // rated: the show lives in the Diary; the leftover entry is a remnant of
  // an edit-path save that skips watchlist removal). Badge must match what
  // the tab renders (review finding, 2026-07-20).
  const visibleWatchlistCount = upcomingBookedWatchlist.length + unbookedWatchlist.length + seenToRateWatchlist.length;

  // Shared Plans (BRO-4481): the sheet's counts come from the same rule the
  // friend's page uses, so the numbers can't disagree.
  const [sharePlansOpen, setSharePlansOpen] = useState(false);
  // Not gated on a non-empty watchlist: an owner who empties it must still
  // reach Stop sharing / Reset for a link that is out there (ship-check).
  const canSharePlans = isMockMode || !!user;
  const sharePlansCounts = useMemo(() => {
    const entries = toSharedEntries(watchlist, reviews);
    const shows = new Map<string, PlanShowLike>();
    for (const e of entries) {
      const s = showMap[e.show_id];
      if (s) shows.set(e.show_id, { id: s.id, category: s.category, status: s.status });
    }
    return selectSharedPlans({ showBooked: true, showUnbooked: true, entries }, shows, Date.now()).counts;
  }, [watchlist, reviews, showMap]);

  // Shared Diary (BRO-4566): "N shows seen" by the friend page's own rule.
  // Not gated on a non-empty diary, for the same reason as plans.
  const [shareDiaryOpen, setShareDiaryOpen] = useState(false);
  const shareDiaryShowsSeen = useMemo(() => {
    const now = Date.now();
    const payload = ownerDiaryPayload(reviews, now);
    const shows = new Map<string, PlanShowLike>();
    for (const e of payload.entries) {
      const s = showMap[e.show_id];
      if (s) shows.set(e.show_id, { id: s.id, category: s.category, status: s.status });
    }
    return selectSharedDiary({ ...payload, showText: false }, shows, now).showsSeen;
  }, [reviews, showMap]);

  // The signed-out view below has its own Continue with Apple button, outside
  // the sign-in box that normally sets Apple up when it opens. Safari blocks
  // a popup opened after any waiting, so set Apple up here as well; without
  // this the tap failed with popup_blocked_by_browser, the bug BRO-4615 fixed
  // for the box only (BRO-4894).
  useEffect(() => {
    if (featureFlags.userAccounts && !isMockMode && !authLoading && !isAuthenticated) prepareAppleSignIn().catch(() => {});
  }, [isMockMode, authLoading, isAuthenticated]);

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
              <span>Rate every show you see, with half-stars, dates and private notes</span>
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
                signIn('google', 'my_shows');
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
                signIn('apple', 'my_shows');
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
    <div data-testid="my-shows-content" className="ph-mask max-w-3xl mx-auto px-4 sm:px-6 pt-4 sm:pt-8 pb-12">
      {/* Header — flex-wrap lets the opened Add-show search take a full row on
          mobile (basis-full) instead of squeezing beside the title. */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-2">
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
            onAddToWatchlist={async (showId: string, title?: string) => {
              await effectiveAddToWatchlist(showId);
              // The just-added prompt (rendered below) confirms the add AND
              // offers the date in place — quick-add used to require finding
              // the entry on the watchlist to date it (owner, 2026-07-19).
              // Set BEFORE the refresh: a rejected refetch used to throw past
              // the feedback line, so the add silently succeeded with none.
              // Title comes from the tapped search row — for live-lookup adds
              // showMap's setState hasn't committed yet, so reading it here
              // showed the raw show ID (code-review finding, 2026-07-19).
              setJustAdded({ showId, title: title || showMap[showId]?.title || showId });
              if (!isMockMode) await getWatchlist(true).catch(() => {});
            }}
            onRateDiaryOnly={(show) => openRatingEditor(show)}
            existingWatchlistIds={new Set(watchlist.map(w => w.show_id))}
            existingReviewIds={new Set(reviews.map(r => r.show_id))}
            onLiveShowAdded={(show) => setShowMap(prev => ({ ...prev, [show.id]: show }))}
          />
        )}
      </div>

      {/* Just-added prompt — in-place date capture for search quick-adds */}
      {justAdded && (
        <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5 rounded-xl bg-brand/[0.06] border border-brand/20" data-testid="just-added-prompt">
          <svg className="w-4 h-4 flex-shrink-0 text-brand" fill="currentColor" viewBox="0 0 24 24">
            <path d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
          </svg>
          <span className="text-sm text-white min-w-0 truncate">
            <span className="font-semibold">{justAdded.title}</span>
            <span className="text-gray-400"> added to your Watchlist</span>
          </span>
          <span className="flex items-center gap-2 ml-auto">
            <span className="text-xs text-gray-500 hidden sm:inline">Seeing it when?</span>
            <SharedDatePicker
              value=""
              onChange={(date) => {
                if (!date) return;
                const target = justAdded;
                setJustAdded(null);
                handlePlannedDateChange(target.showId, date);
              }}
              ariaLabel="Planned date"
              className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-lg text-gray-300 bg-white/[0.05] border border-white/10 hover:border-white/20 transition-colors"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
              </svg>
              <span>Add date</span>
            </SharedDatePicker>
            <button
              type="button"
              onClick={() => setJustAdded(null)}
              className="text-xs text-gray-500 hover:text-white transition-colors px-1.5 py-1.5"
            >
              Skip
            </button>
          </span>
        </div>
      )}

      {ratingTarget && (
        <RatingEditor
          key={ratingTarget.reviewId ?? ratingTarget.id}
          showTitle={ratingTarget.title}
          reviewId={ratingTarget.reviewId}
          initialRating={ratingTarget.initialRating ?? 0}
          initialReviewText={ratingTarget.initialReviewText}
          initialDateSeen={ratingTarget.initialDateSeen}
          suggestedDateSeen={ratingTarget.suggestedDateSeen}
          presentation="modal"
          onSave={handleInlineRatingSave}
          onSaved={() => setRatingTarget(null)}
          onCancel={() => setRatingTarget(null)}
          // Delete sits in the editor: grid cards show a pencil, not a trash
          // can (owner, 2026-10-03, BRO-4558).
          onDelete={ratingTarget.reviewId ? () => { handleDeleteReviewWithToast(ratingTarget.reviewId!); setRatingTarget(null); } : undefined}
          analytics={{ source: 'my_shows', showId: ratingTarget.id }}
        />
      )}

      {/* Stats bar removed — the To Be Rated / Upcoming sections carry their
          own headers, so the counts only pushed content down (owner, 2026-07-17). */}
      {/* Mock mode (localhost-only) renders the importer only on explicit
          opt-in (&importer=1) so Playwright can drive the preview modal via a
          file upload without shifting the mock-page visual baselines. */}
      {(user || (isMockMode && searchParams.get('importer') === '1')) && (
        <div className="mb-4 sm:mb-6">
          <ImportShows
            userId={user?.id ?? 'mock-user'}
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
          aria-label={visibleWatchlistCount > 0 ? `Watchlist, ${visibleWatchlistCount} shows` : 'Watchlist'}
          className={`flex-shrink-0 px-2 sm:px-4 py-2.5 text-sm font-semibold transition-colors border-b-2 -mb-[1px] outline-none ${
            activeTab === 'watchlist'
              ? 'text-white border-brand'
              : 'text-gray-500 border-transparent hover:text-gray-300'
          }`}
        >
          Watchlist
          {visibleWatchlistCount > 0 && (
            <span className="ml-1.5 px-1.5 py-0.5 text-xs bg-white/10 rounded-full" aria-hidden="true">
              {visibleWatchlistCount}
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
          {activeTab === 'diary' && canSharePlans && (
            <button
              type="button"
              onClick={() => setShareDiaryOpen(true)}
              className="toolbar-control"
              data-testid="share-diary-open"
            >
              <ShareIcon />
              Share
            </button>
          )}
          {activeTab === 'diary' && (
            <select
              value={diarySort}
              onChange={e => setDiarySort(e.target.value as DiarySort)}
              aria-label="Sort diary"
              className="toolbar-control"
            >
              <option value="date-desc">Newest</option>
              <option value="date-asc">Oldest</option>
              <option value="rating-desc">Top Rated</option>
            </select>
          )}
          {activeTab === 'watchlist' && canSharePlans && (
            <button
              type="button"
              onClick={() => setSharePlansOpen(true)}
              className="toolbar-control"
              data-testid="share-plans-open"
            >
              <ShareIcon />
              Share
            </button>
          )}
          {activeTab === 'watchlist' && (
            <select
              value={watchlistSort}
              onChange={e => setWatchlistSort(e.target.value as WatchlistSort)}
              aria-label="Sort watchlist"
              className="toolbar-control"
            >
              <option value="added-desc">Recent</option>
              <option value="alphabetical">A-Z</option>
              <option value="closing-soon">Closing</option>
            </select>
          )}
          {/* Grid / List toggle */}
          <ViewModeToggle
            value={activeTab === 'diary' ? diaryView : watchlistView}
            onChange={mode => pickView(activeTab === 'diary' ? 'diary' : 'watchlist', mode)}
          />
        </div>
        )}
      </div>

      {/* Mobile controls row — only visible on mobile, hidden on sm+.
          Selects are 16px on mobile: anything smaller makes iOS Safari zoom
          the whole page on focus and stay zoomed (owner report, 2026-07-17). */}
      {activeTab !== 'lists' && (
        <div className="flex sm:hidden items-center justify-end gap-2 py-1.5 mb-2">
          {activeTab === 'diary' && canSharePlans && (
            <button
              type="button"
              onClick={() => setShareDiaryOpen(true)}
              className="toolbar-control mr-auto"
              data-testid="share-diary-open-mobile"
            >
              <ShareIcon />
              Share
            </button>
          )}
          {activeTab === 'diary' && (
            <select
              value={diarySort}
              onChange={e => setDiarySort(e.target.value as DiarySort)}
              aria-label="Sort diary"
              className="toolbar-control"
            >
              <option value="date-desc">Newest</option>
              <option value="date-asc">Oldest</option>
              <option value="rating-desc">Top Rated</option>
            </select>
          )}
          {activeTab === 'watchlist' && canSharePlans && (
            <button
              type="button"
              onClick={() => setSharePlansOpen(true)}
              className="toolbar-control mr-auto"
              data-testid="share-plans-open-mobile"
            >
              <ShareIcon />
              Share
            </button>
          )}
          {activeTab === 'watchlist' && (
            <select
              value={watchlistSort}
              onChange={e => setWatchlistSort(e.target.value as WatchlistSort)}
              aria-label="Sort watchlist"
              className="toolbar-control"
            >
              <option value="added-desc">Recent</option>
              <option value="alphabetical">A-Z</option>
              <option value="closing-soon">Closing</option>
            </select>
          )}
          {/* Grid / List toggle — 44px like the other controls: the global
              mobile tap-target rule inflates its buttons to 44px anyway. */}
          <ViewModeToggle
            value={activeTab === 'diary' ? diaryView : watchlistView}
            onChange={mode => pickView(activeTab === 'diary' ? 'diary' : 'watchlist', mode)}
          />
        </div>
      )}

      {/* Diary tab */}
      {activeTab === 'diary' && (
        <div id="panel-diary" role="tabpanel" aria-labelledby="tab-diary">
          {reviews.length === 0 && upcomingWatchlistEntries.length === 0 && toBeRatedEntries.length === 0 ? (
            !isMockMode && (reviewsError || watchlistError) ? (
              <LoadError onRetry={() => { getAllReviews(); getWatchlist(true); }} />
            ) : <EmptyState
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
                <ToBeRatedSection
                  idPrefix="diary"
                  entries={toBeRatedEntries}
                  showMap={showMap}
                />
              )}

              {/* Upcoming section — watchlist entries with future dates + reviews with future date_seen */}
              {(upcomingWatchlistEntries.length > 0 || upcomingReviews.length > 0) && (
                <section className="mb-8">
                  <SectionBand title="Upcoming" count={upcomingWatchlistEntries.length + upcomingReviews.length} />
                  {diaryView === 'list' ? (
                    <div className="space-y-2">
                      {upcomingWatchlistEntries.map(entry => {
                        const entryShow = showMap[entry.show_id];
                        const entryTitle = entryShow?.title || entry.show_id;
                        const entrySlug = entryShow?.slug || entry.show_id;
                        const entryHref = getShowHref(entrySlug, entryShow?.diaryOnly);
                        return (
                          <UpcomingListRow
                            key={`wl-${entry.id}`}
                            href={entryHref}
                            posterUrl={entryShow?.posterUrl}
                            title={entryTitle}
                            venue={entryShow?.venue}
                            plannedDate={entry.planned_date}
                            actions={
                              <RowRemoveButton
                                onRemove={() => handleRemoveFromWatchlist(entry.show_id, 'Removed from watchlist.')}
                                label={`Remove ${entryTitle} from watchlist`}
                              />
                            }
                          />
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
                        return (
                          <PosterGridCard
                            key={`wl-grid-${entry.id}`}
                            href={entryHref}
                            posterUrl={entryShow?.posterUrl}
                            date={entry.planned_date ? formatPillDate(entry.planned_date) : null}
                            title={entryShow?.title || entry.show_id}
                          />
                        );
                      })}
                      {upcomingReviews.map(review => (
                        <DiaryGridCard key={review.id} review={review} show={showMap[review.show_id]} />
                      ))}
                    </div>
                  )}
                </section>
              )}

              {/* Past shows section — grouped by year (skipped when sorting by rating) */}
              {pastReviews.length > 0 && (() => {
                // When sorting by rating, show a flat list — year grouping doesn't apply
                if (diarySort === 'rating-desc') {
                  const hasOtherSections = upcomingReviews.length > 0 || upcomingWatchlistEntries.length > 0 || toBeRatedEntries.length > 0;
                  return (
                    <section>
                      {hasOtherSections && <SectionBand title="All Rated" count={pastReviews.length} />}
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
                            <DiaryGridCard key={review.id} review={review} show={showMap[review.show_id]} showYear />
                          ))}
                          <AddShowCard context="diary" onOpen={() => {
                            const btn = document.querySelector<HTMLButtonElement>('[aria-label="Add a show to diary"], [aria-label="Rate a show"]');
                            btn?.click();
                          }} />
                        </div>
                      )}
                    </section>
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

                // Year bands go straight under the sections above, as in the
                // app: no separate "Past Shows" band on top of them (BRO-4558).
                return (
                  <div className="space-y-6">
                    {sortedYears.map((year, yearIdx) => (
                      <section key={year}>
                        {showYearHeaders && (
                          <SectionBand
                            title={year}
                            count={reviewsByYear[year].length}
                            hint={year === 'No date' && (
                              <span className="normal-case font-normal tracking-normal text-gray-500"> (edit a show to add when you saw it)</span>
                            )}
                          />
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
                              <DiaryGridCard key={review.id} review={review} show={showMap[review.show_id]} />
                            ))}
                            {yearIdx === sortedYears.length - 1 && (
                              <AddShowCard context="diary" onOpen={() => {
                                const btn = document.querySelector<HTMLButtonElement>('[aria-label="Add a show to diary"], [aria-label="Rate a show"]');
                                btn?.click();
                              }} />
                            )}
                          </div>
                        )}
                      </section>
                    ))}
                  </div>
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
            !isMockMode && watchlistError ? (
              <LoadError onRetry={() => { getWatchlist(true); }} />
            ) : <EmptyState
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
                    onRemove={() => handleRemoveFromWatchlist(entry.show_id, 'Removed from Watchlist.')}
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
              {/* Upcoming — future planned dates at the TOP so a newly dated
                  show visibly moves up, not below the fold (owner, 2026-07-20) */}
              {upcomingBookedWatchlist.length > 0 && (
                <section>
                  <SectionBand title="Upcoming" count={upcomingBookedWatchlist.length} />
                  {watchlistView === 'grid' ? (
                    <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
                      {upcomingBookedWatchlist.map(entry => (
                        <WatchlistCard
                          key={entry.id}
                          entry={entry}
                          show={showMap[entry.show_id]}
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
                      {upcomingBookedWatchlist.map(entry => (
                        <WatchlistListItem
                          key={entry.id}
                          entry={entry}
                          show={showMap[entry.show_id]}
                          onDateChange={(date) => handlePlannedDateChange(entry.show_id, date)}
                          onRemove={() => handleRemoveFromWatchlist(entry.show_id, 'Removed from Watchlist.')}
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
                </section>
              )}

              {/* Not yet booked section */}
              {unbookedWatchlist.length > 0 && (
                <section data-testid="not-yet-booked">
                  {(upcomingBookedWatchlist.length > 0 || seenToRateWatchlist.length > 0) && (
                    <SectionBand title="Not yet booked" count={unbookedWatchlist.length} />
                  )}
                  {watchlistView === 'grid' ? (
                    <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
                      {unbookedWatchlist.map(entry => (
                        <WatchlistCard
                          key={entry.id}
                          entry={entry}
                          show={showMap[entry.show_id]}
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
                          onRemove={() => handleRemoveFromWatchlist(entry.show_id, 'Removed from Watchlist.')}
                          onRate={openRatingEditor}
                        />
                      ))}
                      <AddShowCard context="watchlist" variant="list" onOpen={() => {
                        const btn = document.querySelector<HTMLButtonElement>('[aria-label="Add to watchlist"]');
                        btn?.click();
                      }} />
                    </div>
                  )}
                </section>
              )}

              {/* Seen (past planned date, unrated) — mirror the Diary's To Be
                  Rated treatment instead of hiding them in a dated 'Booked'
                  pile (owner, 2026-07-20) */}
              {seenToRateWatchlist.length > 0 && (
                <div>
                  {upcomingBookedWatchlist.length === 0 && unbookedWatchlist.length === 0 && (
                    <div className="mb-4">
                      <AddShowCard context="watchlist" variant="list" onOpen={() => {
                        const btn = document.querySelector<HTMLButtonElement>('[aria-label="Add to watchlist"]');
                        btn?.click();
                      }} />
                    </div>
                  )}
                  <ToBeRatedSection
                    idPrefix="watchlist"
                    entries={seenToRateWatchlist}
                    showMap={showMap}
                  />
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Lists tab */}
      {activeTab === 'lists' && (
        <div id="panel-lists" role="tabpanel" aria-labelledby="tab-lists" className="pt-4 sm:pt-0">
          <ListsTab userId={user?.id || null} showMap={showMap} isMockMode={isMockMode} createTrigger={createListTrigger} />
        </div>
      )}

      {sharePlansOpen && (
        <SharePlansModal
          isOpen
          onClose={() => setSharePlansOpen(false)}
          userId={isMockMode ? 'mock' : (user?.id ?? '')}
          profileName={isMockMode ? 'Tom Mock' : (profile?.display_name ?? null)}
          counts={sharePlansCounts}
          mock={isMockMode}
          showToast={showToast}
        />
      )}
      {shareDiaryOpen && (
        <ShareDiaryModal
          isOpen
          onClose={() => setShareDiaryOpen(false)}
          userId={isMockMode ? 'mock' : (user?.id ?? '')}
          profileName={isMockMode ? 'Tom Mock' : (profile?.display_name ?? null)}
          showsSeen={shareDiaryShowsSeen}
          mock={isMockMode}
          showToast={showToast}
        />
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
      className="relative z-[2] inline-flex items-center justify-center flex-shrink-0 p-1.5 rounded-full text-score-skip/80 hover:text-score-skip transition-colors pointer-events-auto"
    >
      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
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
          // inline-flex centering is load-bearing: the mobile 44px tap-target
          // rule inflates this inline <a>, and without it the pencil glyph
          // pinned to the box's top — the "floating pencil" (owner, 2026-07-17).
          className="inline-flex items-center justify-center p-1 rounded-full text-gray-600 hover:text-white transition-colors"
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
          className="inline-flex items-center justify-center p-1 rounded-full text-gray-600 hover:text-white transition-colors"
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
          className="relative z-[1] inline-flex items-center justify-center p-1 rounded-full text-score-skip/80 hover:text-score-skip transition-colors"
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
        {/* Mobile: real five stars STACKED under the date, same pattern as the
            To-Be-Rated rows — right-aligned stars + icons crushed titles to
            ~8 chars at 390px. The lone-star+number compact form before that
            read as "numbers without the actual stars" (owner, 2026-07-19). */}
        <div className="md:hidden mt-1"><StarRating rating={review.rating} onRatingChange={() => {}} size="sm" readOnly hideLabel /></div>
        {review.review_text && (
          <p className="text-xs text-gray-500 mt-0.5 line-clamp-1 italic">{review.review_text}</p>
        )}
      </div>

      {/* Rating — same md stars as the To Be Rated rows above (a smaller size
          here read as "worse" stars; desktop edit/delete moved to the
          top-right corner so the stars don't have to shrink — owner,
          2026-07-13). Mobile keeps icons IN-FLOW on the right:
          the absolute corner collided with row content at 390px. */}
      <div className="relative z-[1] pointer-events-none flex-shrink-0 flex items-center gap-1.5">
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


/**
 * Past/upcoming rated show in the grid, the app's diary card (watched.tsx
 * renderDiaryGridCard): date pill on the poster, gold stars, then the name.
 * `showYear` puts the year in the pill when no year band says it (Top Rated
 * sort's flat grid).
 */
function DiaryGridCard({ review, show, showYear = false }: { review: UserReview; show?: ShowLookup; showYear?: boolean }) {
  const title = show?.title || review.show_id;
  const slug = show?.slug || review.show_id;
  const href = getShowHref(slug, show?.diaryOnly);

  return (
    <PosterGridCard
      href={href}
      posterUrl={show?.posterUrl}
      date={review.date_seen ? formatPillDate(review.date_seen.slice(0, 10), { year: showYear }) : null}
      title={title}
      ariaLabel={`View ${title}`}
      // No corner buttons: the show page edits or deletes the rating
      // (owner, 2026-10-03).
      meta={
        <div className="mt-1.5 flex justify-center gap-0.5 min-h-[18px]">
          {review.rating > 0 && <MiniStars rating={review.rating} size="md" filledOnly />}
        </div>
      }
    >
      {/* Written-note preview on hover (desktop) — grid view otherwise hides
          the note entirely (owner request, 2026-07-13) */}
      {review.review_text && (
        <div className="absolute inset-x-0 bottom-0 z-[1] hidden sm:block opacity-0 group-hover/grid:opacity-100 transition-opacity pointer-events-none">
          <div className="bg-gradient-to-t from-black/95 via-black/80 to-transparent px-2.5 pt-10 pb-2.5">
            <p className="text-xs text-gray-200 italic leading-snug line-clamp-4">{review.review_text}</p>
          </div>
        </div>
      )}
    </PosterGridCard>
  );
}

/**
 * Watchlist poster card. Booked (future-dated) shows get the app's Upcoming
 * card: the date pill with countdown ("Oct 9 · 3d") and no status badge, as
 * to-watch.tsx renderUpcomingItem. Unbooked shows keep the status badge.
 * Nothing under the name and no corner buttons (owner, 2026-10-03: the
 * date and delete buttons were too big). Tapping opens the show page, whose
 * plan card sets the date and showtime or removes it; list view still
 * edits the date and calendar export inline (showtime lives on the show page).
 */
function WatchlistCard({ entry, show, onRate }: {
  entry: WatchlistEntry;
  show?: ShowLookup;
  onRate: (show: { id: string; title: string }) => void;
}) {
  const title = show?.title || entry.show_id;
  const slug = show?.slug || entry.show_id;
  const href = getShowHref(slug, show?.diaryOnly);
  const isFutureDated = !!entry.planned_date && entry.planned_date >= localToday();
  // Rate stars require a PAST planned_date (the user has actually seen the
  // show) — not just "not future-dated". Entries with no date at all ("not
  // yet booked") also satisfy !isFutureDated, so that check alone offered a
  // star control for shows the user hasn't attended yet (dedupe of
  // #600/#615/#629/#716). Only reachable via the alphabetical flat-list view;
  // the booked/unbooked split routes past-dated entries to To Be Rated.
  const canRate = !!entry.planned_date && !isFutureDated;
  const rateHref = href ? `${href}?rate=1` : null;
  const handleRateStars = (stars: number) => {
    if (rateHref) window.location.href = `${rateHref}&stars=${stars}`;
    else onRate({ id: entry.show_id, title });
  };

  const isClosingSoon = show?.closingDate && (() => {
    const closing = new Date(show.closingDate!);
    const now = new Date();
    const fourWeeks = 28 * 24 * 60 * 60 * 1000;
    return closing.getTime() - now.getTime() < fourWeeks && closing > now;
  })();
  // Booked shows carry no status badge (app: "TIX ON SALE on the Upcoming
  // shelf is noise once you have tickets").
  const badge = isFutureDated
    ? null
    : isClosingSoon ? { text: 'Closing Soon', cls: 'bg-amber-500/90 text-black' } : bookabilityLabel(show);

  return (
    <div className="contents" data-watchlist-future-dated={isFutureDated}>
      <PosterGridCard
        href={href}
        posterUrl={show?.posterUrl}
        date={entry.planned_date ? formatPillDate(entry.planned_date, { countdown: isFutureDated }) : null}
        title={title}
        ariaLabel={`View ${title}`}
        badge={badge}
      >
        {/* Rate strip — five tappable empty stars anchored to the poster
            bottom, for past-dated entries in the A-Z view. Always visible on
            mobile (no hover); hover/focus-revealed on sm+. Tapping star N
            deep-links ?rate=1&stars=N (owner, 2026-07-19). It covers the date
            pill, which says nothing new for a show already seen. */}
        {canRate && (
          <div
            className="absolute inset-x-0 bottom-0 z-[3] flex justify-center bg-gradient-to-t from-black/85 to-transparent pt-4 pb-1.5 opacity-100 sm:opacity-0 sm:group-hover/grid:opacity-100 focus-within:opacity-100 transition-opacity"
            // Scoped to star clicks — an unconditional preventDefault made the
            // gradient band a navigation dead-zone (same guard as HoverRateStars).
            onClick={(e) => {
              if ((e.target as HTMLElement).closest('[role="radiogroup"]')) {
                e.preventDefault();
                e.stopPropagation();
              }
            }}
          >
            <span className="star-compact flex items-center" role="radiogroup" aria-label={`Rate ${title}`}>
              {[1, 2, 3, 4, 5].map(i => (
                <button
                  key={i}
                  type="button"
                  onClick={(e) => { e.preventDefault(); e.stopPropagation(); handleRateStars(i); }}
                  aria-label={`${i} star${i !== 1 ? 's' : ''}`}
                  className="p-0.5 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/80"
                >
                  {/* w-3.5 on mobile: five w-5 stars overflow the ~115px
                      3-column cards at 390px (clipped edges, caught in visual QA) */}
                  <svg className="w-3.5 h-3.5 sm:w-5 sm:h-5" viewBox="0 0 24 24" fill="none">
                    <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" fill="none" stroke="#FFD700" strokeWidth="1.5" strokeLinejoin="round" />
                  </svg>
                </button>
              ))}
            </span>
          </div>
        )}
      </PosterGridCard>
    </div>
  );
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
  const router = useRouter();
  const [confirmRemove, setConfirmRemove] = useState(false);
  useEffect(() => {
    if (!confirmRemove) return;
    const timer = setTimeout(() => setConfirmRemove(false), 4000);
    return () => clearTimeout(timer);
  }, [confirmRemove]);
  const title = show?.title || entry.show_id;
  const slug = show?.slug || entry.show_id;
  const href = getShowHref(slug, show?.diaryOnly);
  const isFutureDated = !!entry.planned_date && entry.planned_date >= localToday();
  // See WatchlistCard's canRate comment — !isFutureDated alone also matches
  // "no date at all" (not yet booked), which incorrectly showed rate stars.
  const canRate = !!entry.planned_date && !isFutureDated;

  const isClosingSoon = show?.closingDate && (() => {
    const closing = new Date(show.closingDate!);
    const now = new Date();
    const fourWeeks = 28 * 24 * 60 * 60 * 1000;
    return closing.getTime() - now.getTime() < fourWeeks && closing > now;
  })();
  const bookability = bookabilityLabel(show);

  const formattedDate = entry.planned_date
    ? new Date(entry.planned_date + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    : null;

  return (
    <div className="group/wl relative flex items-center gap-3 px-3 sm:px-5 py-2.5 sm:py-3 rounded-xl bg-white/[0.02] border border-white/[0.06] hover:border-white/10 hover:bg-white/[0.04] transition-colors" data-watchlist-future-dated={isFutureDated}>
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
        {!isClosingSoon && bookability && (
          <span className={`inline-block mt-1 px-1.5 py-0.5 text-[9px] font-bold uppercase rounded ${bookability.cls}`}>{bookability.text}</span>
        )}
        {show?.closingDate && (
          <p className="text-xs text-gray-500 mt-1">
            Closes {formatShowDate(show.closingDate)}
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
        {/* No showtime picker here: Matinee/Evening/Custom live on the show
            page only (owner, 2026-10-03: they pushed the list down). */}
        <AddToCalendarButtons event={buildPlannedShowEvent(show ?? { id: entry.show_id, title, slug }, entry)} />
        {/* Rate + Remove row — same tappable 5-star affordance as the grid
            strip and To-Be-Rated rows; the old '☆ Rate' text link was a
            second visual treatment for the identical action (flagged by the
            UX walkthrough panel, 2026-07-20). HIDDEN unless the entry has a
            PAST planned_date (Upcoming AND not-yet-booked entries hide it —
            rate stars on a show the user hasn't seen yet made no sense;
            owner, 2026-07-20; dedupe #600/#615/#629/#716). */}
        <div className="flex items-center gap-2">
          {canRate && (
          <span className="relative z-[1] star-compact">
            <StarRating
              rating={null}
              onRatingChange={(stars) => {
                if (href) router.push(`${href}?rate=1&stars=${stars}`);
                else onRate({ id: entry.show_id, title });
              }}
              size="sm"
              hideLabel
            />
          </span>
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
              className="relative z-[1] inline-flex items-center justify-center p-1 text-score-skip/80 hover:text-score-skip transition-colors"
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
  onAddToWatchlist: (showId: string, title?: string) => Promise<void>;
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
          await onAddToWatchlist(show.id, show.title);
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
    // basis-full: on mobile the open search takes a FULL row of its own instead
    // of a tiny 160px input squeezed beside the page title (owner report,
    // 2026-07-17); sm+ keeps the compact inline width.
    <div ref={containerRef} className="relative basis-full sm:basis-auto min-w-0">
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
/**
 * To Be Rated, the app's design (watched.tsx toBeRatedSection): a full-width
 * amber band, "TO BE RATED" + dot + count, and a poster grid. The pill shows
 * the date the user planned to go ("Date not set" for a welcome "seen it"
 * pick, which has none); a tap opens the show
 * page's rating editor, which carries that date over. A show they didn't
 * see comes off via the show page's watchlist button or list view's remove
 * (beta feedback 2026-08-02: otherwise a past-dated entry is stuck here
 * forever). Always a grid, as in the app.
 */
function ToBeRatedSection({ entries, showMap, idPrefix }: {
  entries: ToBeRatedEntry[];
  showMap: Record<string, ShowLookup>;
  idPrefix: string;
}) {
  return (
    <section
      aria-labelledby={`${idPrefix}-to-be-rated`}
      data-testid="to-be-rated"
      className="py-2 mb-8 band-bleed band-bleed-amber"
    >
      <div className="flex items-center gap-1.5 pb-2">
        <h3 id={`${idPrefix}-to-be-rated`} className="text-xs font-bold text-amber-500 uppercase tracking-wider">To Be Rated</h3>
        <span aria-hidden="true" className="w-1.5 h-1.5 rounded-full bg-amber-500" />
        <span className="text-xs font-semibold text-amber-500">{entries.length}</span>
      </div>
      <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
        {entries.map(entry => {
          const show = showMap[entry.show_id];
          const title = show?.title || entry.show_id;
          const href = getShowHref(show?.slug || entry.show_id, show?.diaryOnly);
          return (
            <PosterGridCard
              key={`rate-${entry.id}`}
              href={`${href}?rate=1`}
              posterUrl={show?.posterUrl}
              date={entry.planned_date ? formatPillDate(entry.planned_date) : 'Date not set'}
              title={title}
              ariaLabel={entry.planned_date ? `Rate ${title}` : `Rate ${title}, date not set`}
            />
          );
        })}
      </div>
    </section>
  );
}

/** (+) card to add shows — placed at end of grid views */
function AddShowCard({ context, variant = 'grid', onOpen }: { context: 'diary' | 'watchlist'; variant?: 'grid' | 'list'; onOpen: () => void }) {
  const openAndReveal = () => {
    onOpen();
    // The search input mounts in the page HEADER — from the bottom of a long
    // list the open is off-screen and reads as a dead button on mobile
    // (owner, 2026-07-20). Scroll it into view and focus it.
    requestAnimationFrame(() => {
      const input = document.querySelector<HTMLInputElement>('input[placeholder^="Search to"]');
      input?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      input?.focus({ preventScroll: true });
    });
  };
  if (variant === 'list') {
    return (
      <button
        type="button"
        onClick={openAndReveal}
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
      onClick={openAndReveal}
      // Poster-sized, top-aligned: the grid would otherwise stretch it to the
      // tallest card in the row (name, stars, date controls), owner 2026-10-03.
      className="self-start aspect-[2/3] flex flex-col items-center justify-center rounded-xl border-2 border-dashed border-white/10 hover:border-white/20 hover:bg-white/[0.03] transition-colors text-gray-500 hover:text-gray-300"
      aria-label={context === 'diary' ? 'Rate a new show' : 'Add a new show to watchlist'}
    >
      <svg className="w-8 h-8 mb-1" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
      </svg>
      <span className="text-xs font-medium">{context === 'diary' ? 'Rate' : 'Add'}</span>
    </button>
  );
}

// Shown instead of an empty state when the fetch failed, so an outage never reads
// as "Your diary is empty" and nudges people to re-import or re-rate (BRO-4525).
function LoadError({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="text-center py-16" role="alert">
      <div className="text-4xl mb-3">⚠️</div>
      <h3 className="text-lg font-bold text-white mb-1">We couldn&apos;t load your shows</h3>
      <p className="text-sm text-gray-400 mb-4">Your diary is safe. Check your connection and try again.</p>
      <button type="button" onClick={onRetry} className="btn-primary text-sm">Try again</button>
    </div>
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
