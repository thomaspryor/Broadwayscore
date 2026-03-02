'use client';

import { useState, useEffect, useMemo } from 'react';
import Link from 'next/link';
import { featureFlags } from '@/config/feature-flags';
import StarRating from '@/components/user/StarRating';
import type { UserReview, WatchlistEntry, ShowLookup } from '@/types/user';

type Tab = 'diary' | 'watchlist';
type DiarySort = 'date-desc' | 'date-asc' | 'rating-desc';
type WatchlistSort = 'added-desc' | 'alphabetical' | 'closing-soon';

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

export default function MyShowsClient() {
  const [activeTab, setActiveTab] = useState<Tab>('diary');
  const [diarySort, setDiarySort] = useState<DiarySort>('date-desc');
  const [watchlistSort, setWatchlistSort] = useState<WatchlistSort>('added-desc');
  const [showMap, setShowMap] = useState<ShowMap>({});
  const [showMapLoaded, setShowMapLoaded] = useState(false);

  // Data — wired to Supabase hooks in Sprint 2
  const [reviews, setReviews] = useState<UserReview[]>([]);
  const [watchlist, setWatchlist] = useState<WatchlistEntry[]>([]);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [loading, setLoading] = useState(true);

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
        setShowMapLoaded(true); // Still render even if lookup fails
      });
  }, []);

  // Simulate loading complete (Sprint 2: replace with real auth check)
  useEffect(() => {
    setLoading(false);
  }, []);

  if (!featureFlags.userAccounts) {
    return (
      <div className="max-w-3xl mx-auto px-4 sm:px-6 pt-8">
        <p className="text-gray-400">This feature is not yet available.</p>
      </div>
    );
  }

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
      </div>

      {/* Tab bar */}
      <div className="flex border-b border-white/10 mb-6">
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
      </div>

      {/* Diary tab */}
      {activeTab === 'diary' && (
        <div>
          {reviews.length === 0 ? (
            <EmptyState
              icon="🎭"
              title="Your diary is empty"
              description="Start rating shows to build your personal theater diary!"
              ctaLabel="Browse Shows"
              ctaHref="/"
            />
          ) : (
            <>
              {/* Sort control */}
              <div className="flex justify-end mb-4">
                <select
                  value={diarySort}
                  onChange={e => setDiarySort(e.target.value as DiarySort)}
                  className="text-xs bg-white/5 border border-white/10 rounded px-2 py-1 text-gray-300"
                >
                  <option value="date-desc">Newest First</option>
                  <option value="date-asc">Oldest First</option>
                  <option value="rating-desc">Highest Rated</option>
                </select>
              </div>

              {/* Upcoming section */}
              {upcomingReviews.length > 0 && (
                <div className="mb-8">
                  <h3 className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-3">Upcoming</h3>
                  <div className="space-y-2">
                    {upcomingReviews.map(review => (
                      <DiaryCard key={review.id} review={review} show={showMap[review.show_id]} />
                    ))}
                  </div>
                </div>
              )}

              {/* Past shows section */}
              <div>
                {upcomingReviews.length > 0 && (
                  <h3 className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-3">Past Shows</h3>
                )}
                <div className="space-y-2">
                  {pastReviews.map(review => (
                    <DiaryCard key={review.id} review={review} show={showMap[review.show_id]} />
                  ))}
                </div>
              </div>
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
          ) : (
            <>
              {/* Sort control */}
              <div className="flex justify-end mb-4">
                <select
                  value={watchlistSort}
                  onChange={e => setWatchlistSort(e.target.value as WatchlistSort)}
                  className="text-xs bg-white/5 border border-white/10 rounded px-2 py-1 text-gray-300"
                >
                  <option value="added-desc">Recently Added</option>
                  <option value="alphabetical">A-Z</option>
                  <option value="closing-soon">Closing Soon</option>
                </select>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                {sortedWatchlist.map(entry => (
                  <WatchlistCard
                    key={entry.id}
                    entry={entry}
                    show={showMap[entry.show_id]}
                  />
                ))}
              </div>
            </>
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
  const href = category === 'west-end'
    ? `/west-end/show/${slug}`
    : category === 'off-broadway'
    ? `/off-broadway/show/${slug}`
    : `/show/${slug}`;

  return (
    <Link
      href={href}
      className="flex items-center gap-3 p-3 rounded-xl bg-white/[0.02] border border-white/[0.06] hover:border-white/10 hover:bg-white/[0.04] transition-colors"
    >
      {/* Poster thumbnail */}
      <div className="w-10 h-14 rounded-lg overflow-hidden bg-surface-overlay flex-shrink-0">
        {show?.posterUrl ? (
          <img src={show.posterUrl} alt="" className="w-full h-full object-cover" />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-gray-600 text-lg">🎭</div>
        )}
      </div>

      {/* Info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <h4 className="text-sm font-semibold text-white truncate">{title}</h4>
          {category !== 'broadway' && (
            <span className={`text-[9px] font-bold uppercase ${
              category === 'west-end' ? 'text-teal-400' : 'text-indigo-400'
            }`}>
              {category === 'west-end' ? 'WE' : 'OB'}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 mt-0.5">
          <StarRating rating={review.rating} onRatingChange={() => {}} size="sm" readOnly />
          {review.date_seen && (
            <span className="text-[11px] text-gray-500">
              {new Date(review.date_seen + 'T00:00:00').toLocaleDateString('en-US', {
                month: 'short',
                day: 'numeric',
                year: 'numeric',
              })}
            </span>
          )}
        </div>
        {review.review_text && (
          <p className="text-xs text-gray-500 mt-1 line-clamp-1">{review.review_text}</p>
        )}
      </div>
    </Link>
  );
}

function WatchlistCard({ entry, show }: { entry: WatchlistEntry; show?: ShowLookup }) {
  const title = show?.title || entry.show_id;
  const slug = show?.slug || entry.show_id;
  const category = show?.category || 'broadway';
  const href = category === 'west-end'
    ? `/west-end/show/${slug}`
    : category === 'off-broadway'
    ? `/off-broadway/show/${slug}`
    : `/show/${slug}`;

  // Check if closing soon (within 4 weeks)
  const isClosingSoon = show?.closingDate && (() => {
    const closing = new Date(show.closingDate!);
    const now = new Date();
    const fourWeeks = 28 * 24 * 60 * 60 * 1000;
    return closing.getTime() - now.getTime() < fourWeeks && closing > now;
  })();

  return (
    <Link
      href={href}
      className="flex flex-col rounded-xl bg-white/[0.02] border border-white/[0.06] hover:border-white/10 hover:bg-white/[0.04] transition-colors overflow-hidden"
    >
      {/* Poster */}
      <div className="aspect-[2/3] bg-surface-overlay relative">
        {show?.posterUrl ? (
          <img src={show.posterUrl} alt="" className="w-full h-full object-cover" />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-gray-600 text-3xl">🎭</div>
        )}
        {isClosingSoon && (
          <span className="absolute top-1.5 right-1.5 px-1.5 py-0.5 text-[9px] font-bold uppercase bg-amber-500/90 text-black rounded">
            Closing Soon
          </span>
        )}
      </div>
      {/* Title */}
      <div className="p-2.5">
        <h4 className="text-xs font-semibold text-white truncate">{title}</h4>
        <p className="text-[10px] text-gray-500 truncate">{show?.venue}</p>
      </div>
    </Link>
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
