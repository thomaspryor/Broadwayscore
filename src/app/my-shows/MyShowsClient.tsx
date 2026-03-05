'use client';

import { useState, useEffect, useMemo, useRef } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { featureFlags } from '@/config/feature-flags';
import { useAuth } from '@/contexts/AuthContext';
import { useUserReviews } from '@/hooks/useUserReviews';
import { useWatchlist } from '@/hooks/useWatchlist';
import StarRating from '@/components/user/StarRating';
import { FormatPill, StatusBadge } from '@/components/show-cards';
import type { UserReview, WatchlistEntry, ShowLookup } from '@/types/user';

type Tab = 'diary' | 'watchlist';
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
  const [activeTab, setActiveTabState] = useState<Tab>(searchParams.get('tab') === 'watchlist' ? 'watchlist' : 'diary');

  // Update URL when tab changes so back button restores the correct tab
  const setActiveTab = (tab: Tab) => {
    setActiveTabState(tab);
    const url = tab === 'watchlist' ? '/my-shows?tab=watchlist' : '/my-shows';
    window.history.replaceState(null, '', url);
  };
  const [diarySort, setDiarySort] = useState<DiarySort>('date-desc');
  const [watchlistSort, setWatchlistSort] = useState<WatchlistSort>('added-desc');
  const [watchlistView, setWatchlistView] = useState<ViewMode>('grid');
  const [diaryView, setDiaryView] = useState<ViewMode>('list');
  const [showMap, setShowMap] = useState<ShowMap>({});
  const [showMapLoaded, setShowMapLoaded] = useState(false);

  const { user, isAuthenticated, loading: authLoading, showSignIn } = useAuth();
  const { reviews, getAllReviews, loading: reviewsLoading } = useUserReviews(user?.id || null);
  const { watchlist, getWatchlist, updatePlannedDate, removeFromWatchlist, loading: watchlistLoading } = useWatchlist(user?.id || null);
  const loading = authLoading || reviewsLoading || watchlistLoading;

  // Load show lookup data
  useEffect(() => {
    fetch('/data/show-lookup.json')
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
        setShowMapLoaded(true);
      });
  }, []);

  // Load user data when authenticated
  useEffect(() => {
    if (isAuthenticated && user) {
      getAllReviews();
      getWatchlist();
    }
  }, [isAuthenticated, user, getAllReviews, getWatchlist]);

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

  if (!featureFlags.userAccounts) {
    return (
      <div className="max-w-3xl mx-auto px-4 sm:px-6 pt-8">
        <p className="text-gray-400">This feature is not yet available.</p>
      </div>
    );
  }

  if (!authLoading && !isAuthenticated) {
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
            onClick={() => showSignIn('rating')}
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
      <h1 className="text-2xl sm:text-3xl font-extrabold text-white mb-2">My Shows</h1>

      {/* Stats bar */}
      <div className="flex items-center gap-4 text-sm text-gray-400 mb-6">
        <span><strong className="text-white">{showsSeen}</strong> shows seen</span>
        {upcomingCount > 0 && (
          <span><strong className="text-white">{upcomingCount}</strong> upcoming</span>
        )}
        <span><strong className="text-white">{watchlist.length}</strong> on watchlist</span>
        {toBeRatedEntries.length > 0 && (
          <span><strong className="text-amber-400">{toBeRatedEntries.length}</strong> to rate</span>
        )}
      </div>

      {/* Tab bar + inline sort/view controls */}
      <div className="flex items-center border-b border-white/10 mb-6">
        <button
          type="button"
          onClick={() => setActiveTab('diary')}
          className={`px-4 py-2.5 text-sm font-semibold transition-colors border-b-2 -mb-[1px] ${
            activeTab === 'diary'
              ? 'text-white border-brand'
              : 'text-gray-500 border-transparent hover:text-gray-300'
          }`}
        >
          Diary
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('watchlist')}
          className={`px-4 py-2.5 text-sm font-semibold transition-colors border-b-2 -mb-[1px] ${
            activeTab === 'watchlist'
              ? 'text-white border-brand'
              : 'text-gray-500 border-transparent hover:text-gray-300'
          }`}
        >
          Watchlist
          {watchlist.length > 0 && (
            <span className="ml-1.5 px-1.5 py-0.5 text-[10px] bg-white/10 rounded-full">
              {watchlist.length}
            </span>
          )}
        </button>

        {/* Inline controls on the right */}
        <div className="ml-auto flex items-center gap-2 -mb-[1px] pb-1">
          {activeTab === 'diary' && (
            <select
              value={diarySort}
              onChange={e => setDiarySort(e.target.value as DiarySort)}
              className="text-xs bg-white/5 border border-white/10 rounded px-2 py-1 text-gray-300"
            >
              <option value="date-desc">Newest First</option>
              <option value="date-asc">Oldest First</option>
              <option value="rating-desc">Highest Rated</option>
            </select>
          )}
          {activeTab === 'watchlist' && (
            <select
              value={watchlistSort}
              onChange={e => setWatchlistSort(e.target.value as WatchlistSort)}
              className="text-xs bg-white/5 border border-white/10 rounded px-2 py-1 text-gray-300"
            >
              <option value="added-desc">Recently Added</option>
              <option value="alphabetical">A-Z</option>
              <option value="closing-soon">Closing Soon</option>
            </select>
          )}
          {/* Grid / List toggle — both tabs */}
          <div className="flex flex-shrink-0 border border-white/10 rounded-lg overflow-hidden">
            <button
              type="button"
              onClick={() => activeTab === 'diary' ? setDiaryView('grid') : setWatchlistView('grid')}
              className={`p-2 ${(activeTab === 'diary' ? diaryView : watchlistView) === 'grid' ? 'bg-white/10 text-white' : 'text-gray-500 hover:text-gray-300'}`}
              aria-label="Grid view"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zm10 0a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zm10 0a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z" />
              </svg>
            </button>
            <button
              type="button"
              onClick={() => activeTab === 'diary' ? setDiaryView('list') : setWatchlistView('list')}
              className={`p-2 ${(activeTab === 'diary' ? diaryView : watchlistView) === 'list' ? 'bg-white/10 text-white' : 'text-gray-500 hover:text-gray-300'}`}
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
        <div>
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
                      const entryHref = getShowHref(entrySlug, entryCategory);
                      const daysUntil = entry.planned_date
                        ? Math.ceil((new Date(entry.planned_date + 'T00:00:00').getTime() - new Date().getTime()) / (1000 * 60 * 60 * 24))
                        : null;
                      const entryFormattedDate = entry.planned_date
                        ? new Date(entry.planned_date + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
                        : null;
                      return (
                        <div key={`wl-${entry.id}`} className="relative flex items-center gap-3 sm:gap-4 px-4 sm:px-5 py-3 rounded-xl bg-white/[0.02] border border-white/[0.06] hover:border-white/10 hover:bg-white/[0.04] transition-colors">
                          <Link href={entryHref} className="absolute inset-0 z-0" aria-label={`View ${entryTitle}`} />
                          <div className="relative z-[1] flex-shrink-0 w-14 sm:w-16 aspect-[2/3] rounded-lg overflow-hidden bg-surface-overlay">
                            {entryShow?.posterUrl ? (
                              <img src={entryShow.posterUrl} alt="" className="w-full h-full object-cover" />
                            ) : (
                              <div className="w-full h-full flex items-center justify-center text-gray-600 text-xl">🎭</div>
                            )}
                          </div>
                          <div className="relative z-[1] flex-1 min-w-0">
                            <h4 className="font-bold text-white text-base truncate">{entryTitle}</h4>
                            {entryShow?.venue && <p className="text-xs text-gray-500 truncate">{entryShow.venue}</p>}
                          </div>
                          <div className="relative z-[1] flex-shrink-0 text-right">
                            {entryFormattedDate && <p className="text-xs font-medium text-brand">{entryFormattedDate}</p>}
                            {daysUntil !== null && daysUntil > 0 && (
                              <p className="text-[10px] text-gray-500 mt-0.5">
                                {daysUntil === 1 ? 'Tomorrow' : `In ${daysUntil} days`}
                              </p>
                            )}
                          </div>
                        </div>
                      );
                    })}
                    {upcomingReviews.map(review => (
                      <DiaryCard key={review.id} review={review} show={showMap[review.show_id]} />
                    ))}
                  </div>
                </div>
              )}

              {/* To Be Rated — watchlist entries with past planned_date, no review yet */}
              {toBeRatedEntries.length > 0 && (
                <div className="mb-8">
                  <h3 className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-3">To Be Rated</h3>
                  <p className="text-xs text-gray-500 mb-3">You saw these shows — how were they?</p>
                  <div className="space-y-2">
                    {toBeRatedEntries.map(entry => {
                      const entryShow = showMap[entry.show_id];
                      const entryTitle = entryShow?.title || entry.show_id;
                      const entrySlug = entryShow?.slug || entry.show_id;
                      const entryCategory = entryShow?.category || 'broadway';
                      const entryHref = getShowHref(entrySlug, entryCategory);
                      return (
                        <div key={`rate-${entry.id}`} className="relative flex items-center gap-3 sm:gap-4 px-4 sm:px-5 py-3 rounded-xl bg-amber-500/[0.03] border border-amber-500/10 hover:border-amber-500/20 hover:bg-amber-500/[0.06] transition-colors">
                          <Link href={entryHref} className="absolute inset-0 z-0" aria-label={`Rate ${entryTitle}`} />
                          <div className="relative z-[1] flex-shrink-0 w-14 sm:w-16 aspect-[2/3] rounded-lg overflow-hidden bg-surface-overlay">
                            {entryShow?.posterUrl ? (
                              <img src={entryShow.posterUrl} alt="" className="w-full h-full object-cover" />
                            ) : (
                              <div className="w-full h-full flex items-center justify-center text-gray-600 text-xl">🎭</div>
                            )}
                          </div>
                          <div className="relative z-[1] flex-1 min-w-0">
                            <h4 className="font-bold text-white text-base truncate">{entryTitle}</h4>
                            {entryShow?.venue && <p className="text-xs text-gray-500">{entryShow.venue}</p>}
                            {entry.planned_date && (
                              <p className="text-xs text-gray-500 mt-0.5">
                                Saw on {new Date(entry.planned_date + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                              </p>
                            )}
                          </div>
                          <div className="relative z-[1] flex-shrink-0">
                            <span className="text-xs font-semibold text-amber-400/80 flex items-center gap-1">
                              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
                              </svg>
                              Rate
                            </span>
                          </div>
                        </div>
                      );
                    })}
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
                        <DiaryCard key={review.id} review={review} show={showMap[review.show_id]} />
                      ))}
                    </div>
                  ) : (
                    <div className="grid grid-cols-4 gap-2">
                      {pastReviews.map(review => (
                        <DiaryGridCard key={review.id} review={review} show={showMap[review.show_id]} />
                      ))}
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
        <div>
          {watchlist.length === 0 ? (
            <EmptyState
              icon="📋"
              title="Your watchlist is empty"
              description="Add shows you want to see!"
              ctaLabel="Browse Shows"
              ctaHref="/"
            />
          ) : watchlistView === 'grid' ? (
            <div className="grid grid-cols-4 gap-2">
              {sortedWatchlist.map(entry => (
                <WatchlistCard
                  key={entry.id}
                  entry={entry}
                  show={showMap[entry.show_id]}
                  onDateChange={(date) => updatePlannedDate(entry.show_id, date)}
                  onRemove={() => removeFromWatchlist(entry.show_id)}
                />
              ))}
            </div>
          ) : (
            <div className="space-y-2">
              {sortedWatchlist.map(entry => (
                <WatchlistListItem
                  key={entry.id}
                  entry={entry}
                  show={showMap[entry.show_id]}
                  onDateChange={(date) => updatePlannedDate(entry.show_id, date)}
                  onRemove={() => removeFromWatchlist(entry.show_id)}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function DiaryCard({ review, show }: { review: UserReview; show?: ShowLookup }) {
  const title = show?.title || review.show_id;
  const slug = show?.slug || review.show_id;
  const category = show?.category || 'broadway';
  const href = getShowHref(slug, category);

  return (
    <div className="group/diary relative flex items-center gap-3 sm:gap-4 px-4 sm:px-5 py-3 rounded-xl bg-white/[0.02] border border-white/[0.06] hover:border-white/10 hover:bg-white/[0.04] transition-colors">
      {/* Link overlay for the whole card */}
      <Link href={href} className="absolute inset-0 z-0" aria-label={`View ${title}`} />

      {/* Poster */}
      <div className="relative z-[1] flex-shrink-0 w-14 sm:w-16 aspect-[2/3] rounded-lg overflow-hidden bg-surface-overlay">
        {show?.posterUrl ? (
          <img src={show.posterUrl} alt="" className="w-full h-full object-cover" />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-gray-600 text-xl">🎭</div>
        )}
      </div>

      {/* Info */}
      <div className="relative z-[1] flex-1 min-w-0">
        <h4 className="font-bold text-white text-base group-hover/diary:text-brand transition-colors truncate">{title}</h4>
        <div className="flex flex-wrap items-center gap-1.5 mt-1">
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
      <div className="relative z-[1] flex-shrink-0 flex flex-col items-center gap-0.5 w-16 md:w-28 overflow-hidden">
        {/* Single star + number on mobile, full stars on desktop */}
        <span className="md:hidden flex items-center gap-1">
          <svg className="w-5 h-5 text-amber-400" fill="currentColor" viewBox="0 0 20 20"><path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" /></svg>
          <span className="text-sm font-semibold text-amber-400">{review.rating % 1 === 0 ? review.rating.toFixed(0) : review.rating.toFixed(1)}</span>
        </span>
        <span className="hidden md:inline-flex"><StarRating rating={review.rating} onRatingChange={() => {}} size="sm" readOnly hideLabel /></span>
        <span className="hidden md:block text-xs font-semibold text-amber-400">{review.rating.toFixed(1)} stars</span>
        {/* Edit icon — inline below rating, visible on hover */}
        <Link
          href={href}
          className="p-1 rounded-full text-gray-600 hover:text-white opacity-0 group-hover/diary:opacity-100 transition-opacity"
          aria-label="Edit rating"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
          </svg>
        </Link>
      </div>
    </div>
  );
}

function DiaryGridCard({ review, show }: { review: UserReview; show?: ShowLookup }) {
  const title = show?.title || review.show_id;
  const slug = show?.slug || review.show_id;
  const category = show?.category || 'broadway';
  const href = getShowHref(slug, category);

  return (
    <div className="flex flex-col rounded-xl bg-white/[0.02] border border-white/[0.06] hover:border-white/10 hover:bg-white/[0.04] transition-colors overflow-hidden">
      <Link href={href} className="relative">
        <div className="aspect-[2/3] bg-surface-overlay">
          {show?.posterUrl ? (
            <img src={show.posterUrl} alt="" className="w-full h-full object-cover" />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-gray-600 text-3xl">🎭</div>
          )}
        </div>
        {review.rating > 0 && (
          <div className="absolute bottom-0 inset-x-0 flex justify-center pb-1.5 pt-4 bg-gradient-to-t from-black/70 to-transparent">
            <StarRating rating={review.rating} onRatingChange={() => {}} size="xs" readOnly hideLabel />
          </div>
        )}
      </Link>
      <div className="p-2">
        <Link href={href}>
          <h4 className="text-xs font-semibold text-white truncate">{title}</h4>
          {review.date_seen && (
            <p className="text-[10px] text-gray-500 truncate">
              {new Date(review.date_seen + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
            </p>
          )}
        </Link>
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
        {/* Uses <div> + onClick instead of <Link> to avoid nested <a> tags */}
        <div
          role="button"
          tabIndex={0}
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); window.location.href = `${href}?rate=1`; }}
          onKeyDown={(e) => { if (e.key === 'Enter') { window.location.href = `${href}?rate=1`; } }}
          className="absolute inset-0 flex items-end justify-center pb-2 bg-gradient-to-t from-black/60 via-transparent to-transparent opacity-0 group-hover/wl:opacity-100 transition-opacity z-[1] cursor-pointer"
        >
          <span className="text-xs font-semibold text-white/90 flex items-center gap-1">
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
            </svg>
            Rate
          </span>
        </div>
        {/* X button to remove — top-right on hover */}
        <button
          type="button"
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); onRemove(); }}
          className="absolute top-1 right-1 p-1 rounded-full bg-black/70 text-gray-400 hover:text-white opacity-0 group-hover/wl:opacity-100 transition-opacity"
          aria-label="Remove from watchlist"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </Link>
      <div className="p-2">
        <Link href={href}>
          <h4 className="text-xs font-semibold text-white truncate">{title}</h4>
          <p className="text-[10px] text-gray-500 truncate">{show?.venue}</p>
        </Link>
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
        className="w-full flex items-center justify-center gap-1.5 text-xs text-gray-400 hover:text-gray-300 transition-colors cursor-pointer min-h-[36px] px-2 rounded-lg bg-white/[0.03] border border-white/[0.06] hover:border-white/10"
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
    <div className="group/wl relative flex items-center gap-3 sm:gap-4 px-4 sm:px-5 py-3 rounded-xl bg-white/[0.02] border border-white/[0.06] hover:border-white/10 hover:bg-white/[0.04] transition-colors">
      <Link href={href} className="absolute inset-0 z-0" aria-label={`View ${title}`} />

      <div className="relative z-[1] flex-shrink-0 w-14 sm:w-16 aspect-[2/3] rounded-lg overflow-hidden bg-surface-overlay">
        {show?.posterUrl ? (
          <img src={show.posterUrl} alt="" className="w-full h-full object-cover" />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-gray-600 text-xl">🎭</div>
        )}
      </div>

      <div className="relative z-[1] flex-1 min-w-0">
        <h4 className="font-bold text-white text-base group-hover/wl:text-brand transition-colors truncate">{title}</h4>
        <p className="text-xs text-gray-500 truncate">{show?.venue}</p>
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

      <div className="relative z-[1] flex-shrink-0 flex flex-col items-center gap-1.5">
        <DatePickerButton
          value={entry.planned_date || ''}
          label={formattedDate || 'Add date'}
          onChange={(val) => onDateChange(val || null)}
        />
        {/* Rate link — ?rate=1 triggers auto-open of rating panel */}
        <Link
          href={`${href}?rate=1`}
          className="relative z-[1] text-xs text-gray-500 hover:text-amber-400 transition-colors flex items-center gap-1"
        >
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
          </svg>
          Rate
        </Link>
        <button
          type="button"
          onClick={onRemove}
          className="text-[10px] text-gray-600 hover:text-red-400 transition-colors"
          aria-label="Remove from watchlist"
        >
          Remove
        </button>
      </div>
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
        className="inline-block px-5 py-2.5 text-sm font-semibold text-black bg-[#FFD700] rounded-lg hover:bg-[#e6c200] transition-colors"
      >
        {ctaLabel}
      </Link>
    </div>
  );
}
