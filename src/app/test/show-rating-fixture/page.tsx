'use client';

import { useState, useCallback, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import ShowPageRating from '@/components/user/ShowPageRating';
import type { UserReview } from '@/types/user';

/**
 * Interactive test fixture for ShowPageRating.
 * Renders the component with local-state callbacks — no Supabase, no auth.
 *
 * Query params:
 *   ?state=existing (default) — 2 reviews, watchlisted with date
 *   ?state=empty — no reviews, not watchlisted
 *   ?state=multi — 4 reviews (tests "Seen N times" and previous viewings)
 *
 * Only used by Playwright tests for functional QA.
 */

function makeReview(overrides: Partial<UserReview> & { id: string; rating: number }): UserReview {
  return {
    user_id: 'test-user',
    show_id: 'hamilton-2015',
    review_text: null,
    date_seen: null,
    visibility: 'private' as const,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

const STATES: Record<string, { reviews: UserReview[]; watchlisted: boolean; watchlistDate: string | null }> = {
  existing: {
    reviews: [
      makeReview({ id: 'r1', rating: 4.5, review_text: 'Incredible show!', date_seen: '2024-11-15', created_at: '2024-11-15T20:00:00Z', updated_at: '2024-11-15T20:00:00Z' }),
      makeReview({ id: 'r2', rating: 4.0, date_seen: '2024-08-03', created_at: '2024-08-03T20:00:00Z', updated_at: '2024-08-03T20:00:00Z' }),
    ],
    watchlisted: true,
    watchlistDate: '2025-03-15',
  },
  empty: {
    reviews: [],
    watchlisted: false,
    watchlistDate: null,
  },
  multi: {
    reviews: [
      makeReview({ id: 'r1', rating: 5.0, review_text: 'Best show ever!', date_seen: '2025-01-10', created_at: '2025-01-10T20:00:00Z', updated_at: '2025-01-10T20:00:00Z' }),
      makeReview({ id: 'r2', rating: 4.5, date_seen: '2024-09-20', created_at: '2024-09-20T20:00:00Z', updated_at: '2024-09-20T20:00:00Z' }),
      makeReview({ id: 'r3', rating: 4.0, review_text: 'Great cast', date_seen: '2024-06-15', created_at: '2024-06-15T20:00:00Z', updated_at: '2024-06-15T20:00:00Z' }),
      makeReview({ id: 'r4', rating: 3.5, date_seen: '2024-02-28', created_at: '2024-02-28T20:00:00Z', updated_at: '2024-02-28T20:00:00Z' }),
    ],
    watchlisted: true,
    watchlistDate: '2025-04-01',
  },
};

function ShowRatingFixtureInner() {
  const searchParams = useSearchParams();
  const stateKey = searchParams.get('state') || 'existing';
  const initial = STATES[stateKey] || STATES.existing;

  const [reviews, setReviews] = useState<UserReview[]>(initial.reviews);
  const [watchlisted, setWatchlisted] = useState(initial.watchlisted);
  const [watchlistDate, setWatchlistDate] = useState<string | null>(initial.watchlistDate);

  const handleSaveReview = useCallback(async (data: {
    rating: number;
    reviewText: string | null;
    dateSeen: string | null;
    reviewId?: string;
  }): Promise<string> => {
    const now = new Date().toISOString();
    if (data.reviewId) {
      // Update existing
      setReviews(prev => prev.map(r =>
        r.id === data.reviewId
          ? { ...r, rating: data.rating, review_text: data.reviewText, date_seen: data.dateSeen, updated_at: now }
          : r
      ));
      return data.reviewId;
    } else {
      // Insert new
      const newId = `r-${Date.now()}`;
      setReviews(prev => [{
        id: newId,
        user_id: 'test-user',
        show_id: 'hamilton-2015',
        rating: data.rating,
        review_text: data.reviewText,
        date_seen: data.dateSeen,
        visibility: 'private' as const,
        created_at: now,
        updated_at: now,
      }, ...prev]);
      return newId;
    }
  }, []);

  const handleDeleteReview = useCallback(async (reviewId: string) => {
    setReviews(prev => prev.filter(r => r.id !== reviewId));
  }, []);

  const handleToggleWatchlist = useCallback(async () => {
    setWatchlisted(prev => {
      if (prev) setWatchlistDate(null);
      return !prev;
    });
  }, []);

  const handleUpdateWatchlistDate = useCallback(async (date: string | null) => {
    setWatchlistDate(date);
  }, []);

  return (
    <div className="min-h-screen bg-surface text-white" data-testid="show-rating-fixture">
      <div className="max-w-2xl mx-auto px-4 py-8">
        <h1 className="text-xl font-bold mb-2">Hamilton</h1>
        <p className="text-sm text-gray-500 mb-4">Richard Rodgers Theatre</p>

        {/* The actual component under test */}
        <div className="card p-5">
          <ShowPageRating
            showId="hamilton-2015"
            showTitle="Hamilton"
            previewDate="2015-07-13"
            closingDate={null}
            reviews={reviews}
            isWatchlisted={watchlisted}
            watchlistDate={watchlistDate}
            onSaveReview={handleSaveReview}
            onDeleteReview={handleDeleteReview}
            onToggleWatchlist={handleToggleWatchlist}
            onUpdateWatchlistDate={handleUpdateWatchlistDate}
            isAuthenticated={true}
            authLoading={false}
          />
        </div>
      </div>
    </div>
  );
}

export default function ShowRatingFixturePage() {
  return (
    <Suspense fallback={null}>
      <ShowRatingFixtureInner />
    </Suspense>
  );
}
