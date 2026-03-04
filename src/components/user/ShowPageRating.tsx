'use client';

import { useState, useCallback, useRef } from 'react';
import Link from 'next/link';
import StarRating from './StarRating';
import ReviewPanel from './ReviewPanel';
import WatchlistButton from './WatchlistButton';
import { featureFlags } from '@/config/feature-flags';
import type { UserReview } from '@/types/user';

interface ShowPageRatingProps {
  showId: string;
  showTitle: string;
  previewDate?: string | null;
  closingDate?: string | null;
  // Data callbacks — wired to Supabase hooks in Sprint 2
  reviews?: UserReview[];
  isWatchlisted?: boolean;
  onSaveReview?: (data: { rating: number; reviewText: string | null; dateSeen: string | null; reviewId?: string }) => Promise<string | void>;
  onDeleteReview?: (reviewId: string) => Promise<void>;
  onToggleWatchlist?: () => Promise<void>;
  onAuthRequired?: (context: 'rating' | 'watchlist', pendingRating?: number) => void;
  isAuthenticated?: boolean;
}

export default function ShowPageRating({
  showId,
  showTitle,
  previewDate,
  closingDate,
  reviews = [],
  isWatchlisted = false,
  onSaveReview,
  onDeleteReview,
  onToggleWatchlist,
  onAuthRequired,
  isAuthenticated = false,
}: ShowPageRatingProps) {
  const [currentRating, setCurrentRating] = useState<number | null>(null);
  const [showPanel, setShowPanel] = useState(false);
  const [editingReview, setEditingReview] = useState<UserReview | null>(null);
  const [saving, setSaving] = useState(false);
  const [watchlistLoading, setWatchlistLoading] = useState(false);
  const lastSavedId = useRef<string | null>(null);

  // Derive state from reviews
  const latestReview = reviews.length > 0
    ? reviews.reduce((a, b) => new Date(b.created_at) > new Date(a.created_at) ? b : a)
    : null;
  const displayRating = editingReview?.rating ?? latestReview?.rating ?? currentRating;
  const viewCount = reviews.length;

  const handleRatingChange = useCallback((rating: number) => {
    if (!isAuthenticated && onAuthRequired) {
      // Store the rating intent for deferred auth
      setCurrentRating(rating);
      onAuthRequired('rating', rating);
      return;
    }
    setCurrentRating(rating);
    setShowPanel(true);
    setEditingReview(null);
  }, [isAuthenticated, onAuthRequired]);

  const handleSave = useCallback(async (data: { rating: number; reviewText: string | null; dateSeen: string | null }) => {
    if (!onSaveReview) return;
    const isFirstSave = !editingReview && !latestReview && !lastSavedId.current;
    setSaving(true);
    try {
      // Pass reviewId: editing existing, or re-saving just-created review
      const idToPass = editingReview?.id || lastSavedId.current || undefined;
      const savedId = await onSaveReview({
        ...data,
        reviewId: idToPass,
      });
      if (savedId) lastSavedId.current = savedId;
      if (isFirstSave) {
        // Keep panel open after first save so user can add notes/date
      } else {
        setShowPanel(false);
        setEditingReview(null);
        setCurrentRating(null);
        lastSavedId.current = null;
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[Rating] Save error:', e);
    } finally {
      setSaving(false);
    }
  }, [onSaveReview, editingReview, latestReview]);

  const handleCancel = useCallback(() => {
    setShowPanel(false);
    setEditingReview(null);
    if (!latestReview) {
      setCurrentRating(null);
    }
  }, [latestReview]);

  const handleEdit = useCallback((review: UserReview) => {
    setEditingReview(review);
    setCurrentRating(review.rating);
    setShowPanel(true);
  }, []);

  const handleToggleWatchlist = useCallback(async () => {
    if (!isAuthenticated && onAuthRequired) {
      onAuthRequired('watchlist');
      return;
    }
    if (!onToggleWatchlist) return;
    setWatchlistLoading(true);
    try {
      await onToggleWatchlist();
    } finally {
      setWatchlistLoading(false);
    }
  }, [isAuthenticated, onAuthRequired, onToggleWatchlist]);

  if (!featureFlags.userAccounts) return null;

  return (
    <div className="mt-5 pt-5 border-t border-white/[0.06]">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1">
          {/* Section label */}
          <div className="flex items-center gap-2 mb-2">
            <h3 className="text-xs font-bold text-gray-500 uppercase tracking-wider">Your Rating</h3>
            {viewCount > 1 && (
              <span className="text-[10px] font-medium text-gray-500 bg-white/[0.05] px-1.5 py-0.5 rounded">
                Seen {viewCount} times
              </span>
            )}
          </div>

          {/* Stars + edit state */}
          {latestReview && !showPanel ? (
            // Show existing rating with edit button
            <div className="flex items-center gap-2">
              <StarRating rating={latestReview.rating} onRatingChange={handleRatingChange} size="md" readOnly />
              <button
                type="button"
                onClick={() => handleEdit(latestReview)}
                className="p-1 text-gray-500 hover:text-white transition-colors"
                aria-label="Edit rating"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                </svg>
              </button>
              {/* New viewing button */}
              <button
                type="button"
                onClick={() => {
                  setEditingReview(null);
                  setCurrentRating(null);
                  lastSavedId.current = null;
                  setShowPanel(false);
                  // Reset to allow new rating
                  handleRatingChange(latestReview.rating);
                }}
                className="text-xs text-gray-500 hover:text-brand transition-colors"
              >
                + New Viewing
              </button>
            </div>
          ) : (
            // Interactive stars
            <StarRating
              rating={currentRating}
              onRatingChange={handleRatingChange}
              size="md"
            />
          )}

          {/* Previous viewings list (collapsed) */}
          {viewCount > 1 && !showPanel && (
            <div className="mt-2 space-y-1">
              {reviews.slice(0, 3).map(review => (
                <button
                  key={review.id}
                  type="button"
                  onClick={() => handleEdit(review)}
                  className="flex items-center gap-2 text-xs text-gray-500 hover:text-white transition-colors"
                >
                  <StarRating rating={review.rating} onRatingChange={() => {}} size="sm" readOnly />
                  {review.date_seen && (
                    <span>{new Date(review.date_seen + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</span>
                  )}
                </button>
              ))}
            </div>
          )}

          {/* Link to My Shows diary */}
          {latestReview && !showPanel && (
            <Link href="/my-shows" className="inline-block mt-2 text-xs text-gray-500 hover:text-brand transition-colors">
              See all Ratings
            </Link>
          )}
        </div>

        {/* Watchlist button */}
        <div className="flex-shrink-0 pt-5 flex flex-col items-center">
          <WatchlistButton
            isWatchlisted={isWatchlisted}
            onToggle={handleToggleWatchlist}
            loading={watchlistLoading}
          />
          {isWatchlisted && (
            <Link href="/my-shows?tab=watchlist" className="mt-1.5 text-xs text-gray-500 hover:text-brand transition-colors">
              See Watchlist
            </Link>
          )}
        </div>
      </div>

      {/* Expandable review panel */}
      {showPanel && currentRating !== null && (
        <ReviewPanel
          rating={currentRating}
          existingReviewText={editingReview?.review_text}
          existingDateSeen={editingReview?.date_seen}
          showTitle={showTitle}
          earliestDate={previewDate}
          latestDate={closingDate}
          onSave={handleSave}
          onCancel={handleCancel}
          saving={saving}
        />
      )}
    </div>
  );
}
