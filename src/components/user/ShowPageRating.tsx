'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
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
  watchlistDate?: string | null;
  onSaveReview?: (data: { rating: number; reviewText: string | null; dateSeen: string | null; reviewId?: string }) => Promise<string | void>;
  onDeleteReview?: (reviewId: string) => Promise<void>;
  onToggleWatchlist?: () => Promise<void>;
  onUpdateWatchlistDate?: (date: string | null) => Promise<void>;
  onAuthRequired?: (context: 'rating' | 'watchlist', pendingRating?: number) => void;
  isAuthenticated?: boolean;
  authLoading?: boolean;
  autoEditLatest?: boolean;
  /** Auto-open rating panel (from watchlist "Rate" link) */
  autoRate?: boolean;
  /** Pre-selected star rating when auto-opening (from To Be Rated inline stars) */
  autoRateStars?: number | null;
  onAutoRateConsumed?: () => void;
}

export default function ShowPageRating({
  showId,
  showTitle,
  previewDate,
  closingDate,
  reviews = [],
  isWatchlisted = false,
  watchlistDate,
  onSaveReview,
  onDeleteReview,
  onToggleWatchlist,
  onUpdateWatchlistDate,
  onAuthRequired,
  isAuthenticated = false,
  authLoading = false,
  autoEditLatest = false,
  autoRate = false,
  autoRateStars,
  onAutoRateConsumed,
}: ShowPageRatingProps) {
  const [currentRating, setCurrentRating] = useState<number | null>(null);
  const [showPanel, setShowPanel] = useState(false);
  const [editingReview, setEditingReview] = useState<UserReview | null>(null);
  const [saving, setSaving] = useState(false);
  const [watchlistLoading, setWatchlistLoading] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const lastSavedId = useRef<string | null>(null);

  // Reset lastSavedId when showId changes (prevents stale ID on navigation)
  useEffect(() => {
    lastSavedId.current = null;
  }, [showId]);

  // Derive state from reviews
  const latestReview = reviews.length > 0
    ? reviews.reduce((a, b) => new Date(b.created_at) > new Date(a.created_at) ? b : a)
    : null;
  const displayRating = editingReview?.rating ?? latestReview?.rating ?? currentRating;
  const viewCount = reviews.length;

  // Auto-open panel after deferred auth saves a rating
  useEffect(() => {
    if (autoEditLatest && latestReview && !showPanel) {
      setEditingReview(latestReview);
      setCurrentRating(latestReview.rating);
      setShowPanel(true);
    }
  }, [autoEditLatest, latestReview, showPanel]);

  // Auto-open rating panel from ?rate=1 (watchlist "Rate" link)
  useEffect(() => {
    if (autoRate && !showPanel) {
      if (!isAuthenticated && !authLoading && onAuthRequired) {
        onAuthRequired('rating', autoRateStars ?? undefined);
      } else {
        setShowPanel(true);
        setEditingReview(null);
        // If they already have a rating, edit it; otherwise start fresh
        if (latestReview) {
          setEditingReview(latestReview);
          setCurrentRating(latestReview.rating);
        } else if (autoRateStars) {
          setCurrentRating(autoRateStars);
        }
      }
      onAutoRateConsumed?.();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRate]);

  const handleRatingChange = useCallback((rating: number) => {
    if (!isAuthenticated && !authLoading && onAuthRequired) {
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
      // Close panel after save. Only keep open on first save if user hasn't added notes/date yet.
      const userFilledDetails = !!(data.reviewText || data.dateSeen);
      if (isFirstSave && !userFilledDetails) {
        // Keep panel open so user can add notes/date
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

  const handleDelete = useCallback(async (reviewId: string) => {
    if (!onDeleteReview) return;
    try {
      await onDeleteReview(reviewId);
      setConfirmDeleteId(null);
      // If we deleted the current editing review, close panel
      if (editingReview?.id === reviewId) {
        setShowPanel(false);
        setEditingReview(null);
        setCurrentRating(null);
      }
    } catch {
      // Toast handled by parent
    }
  }, [onDeleteReview, editingReview]);

  const handleToggleWatchlist = useCallback(async () => {
    if (!isAuthenticated && !authLoading && onAuthRequired) {
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
              <StarRating rating={latestReview.rating} onRatingChange={handleRatingChange} size="lg" readOnly />
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
              {confirmDeleteId === latestReview.id ? (
                <span className="flex items-center gap-1.5 text-xs">
                  <button type="button" onClick={() => handleDelete(latestReview.id)} className="text-red-400 hover:text-red-300 font-medium">Delete?</button>
                  <button type="button" onClick={() => setConfirmDeleteId(null)} className="text-gray-500 hover:text-white">Cancel</button>
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmDeleteId(latestReview.id)}
                  className="p-1 text-gray-500 hover:text-red-400 transition-colors"
                  aria-label="Delete rating"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                  </svg>
                </button>
              )}
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
              size="lg"
            />
          )}

          {/* Previous viewings list (collapsed) */}
          {viewCount > 1 && !showPanel && (
            <div className="mt-2 space-y-1">
              {reviews.slice(0, 3).map(review => (
                <div key={review.id} className="group/viewing flex items-center gap-2 text-xs text-gray-500">
                  <StarRating rating={review.rating} onRatingChange={() => {}} size="sm" readOnly hideLabel />
                  {review.date_seen && (
                    <span>{new Date(review.date_seen + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</span>
                  )}
                  <button
                    type="button"
                    onClick={() => handleEdit(review)}
                    className="p-0.5 text-gray-600 hover:text-white transition-colors"
                    aria-label="Edit this viewing"
                  >
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                    </svg>
                  </button>
                  {confirmDeleteId === review.id ? (
                    <span className="flex items-center gap-1 text-[10px]">
                      <button type="button" onClick={() => handleDelete(review.id)} className="text-red-400 hover:text-red-300 font-medium">Delete?</button>
                      <button type="button" onClick={() => setConfirmDeleteId(null)} className="text-gray-500 hover:text-white">No</button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setConfirmDeleteId(review.id)}
                      className="p-0.5 text-gray-600 hover:text-red-400 transition-colors"
                      aria-label="Delete this viewing"
                    >
                      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                      </svg>
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Link to My Shows diary */}
          {latestReview && !showPanel && (
            <Link href="/my-shows" className="inline-block mt-2 text-xs text-gray-500 hover:text-brand transition-colors">
              See all my Ratings
            </Link>
          )}
        </div>

        {/* Watchlist button + inline date */}
        <div className="flex-shrink-0 pt-5 flex flex-col items-center">
          <WatchlistButton
            isWatchlisted={isWatchlisted}
            onToggle={handleToggleWatchlist}
            loading={watchlistLoading}
          />
          {isWatchlisted && (
            <>
              {/* Inline date picker */}
              <label className="mt-1.5 flex items-center gap-1 text-[11px] text-gray-500 hover:text-gray-300 transition-colors cursor-pointer relative">
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                </svg>
                <span>
                  {watchlistDate
                    ? new Date(watchlistDate + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
                    : 'Add date'}
                </span>
                <input
                  type="date"
                  value={watchlistDate || ''}
                  onChange={e => onUpdateWatchlistDate?.(e.target.value || null)}
                  className="absolute inset-0 opacity-[0.01] cursor-pointer w-full h-full"
                />
              </label>
              <Link href="/my-shows?tab=watchlist" className="mt-1 text-[11px] text-gray-500 hover:text-brand transition-colors">
                See Watchlist
              </Link>
            </>
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
          latestDate={closingDate}
          onSave={handleSave}
          onCancel={handleCancel}
          saving={saving}
        />
      )}
    </div>
  );
}
