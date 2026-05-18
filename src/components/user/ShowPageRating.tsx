'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import Link from 'next/link';
import StarRating from './StarRating';
import ReviewPanel from './ReviewPanel';
import { featureFlags } from '@/config/feature-flags';
import type { UserReview } from '@/types/user';

interface ShowPageRatingProps {
  showId: string;
  showTitle: string;
  previewDate?: string | null;
  closingDate?: string | null;
  /** Planned date from watchlist entry — pre-fills Date Seen for new ratings */
  watchlistDate?: string | null;
  reviews?: UserReview[];
  onSaveReview?: (data: { rating: number; reviewText: string | null; dateSeen: string | null; reviewId?: string }) => Promise<string | void>;
  onDeleteReview?: (reviewId: string) => Promise<void>;
  onAuthRequired?: (context: 'rating' | 'watchlist', pendingRating?: number) => void;
  isAuthenticated?: boolean;
  authLoading?: boolean;
  autoEditLatest?: boolean;
  autoRate?: boolean;
  autoRateStars?: number | null;
  onAutoRateConsumed?: () => void;
  onAutoEditConsumed?: () => void;
}

export default function ShowPageRating({
  showId,
  showTitle,
  closingDate,
  watchlistDate,
  reviews = [],
  onSaveReview,
  onDeleteReview,
  onAuthRequired,
  isAuthenticated = false,
  authLoading = false,
  autoEditLatest = false,
  autoRate = false,
  autoRateStars,
  onAutoRateConsumed,
  onAutoEditConsumed,
}: ShowPageRatingProps) {
  const [currentRating, setCurrentRating] = useState<number | null>(null);
  const [showPanel, setShowPanel] = useState(false);
  const [editingReview, setEditingReview] = useState<UserReview | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const confirmDeleteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSavedId = useRef<string | null>(null);

  useEffect(() => {
    lastSavedId.current = null;
  }, [showId]);

  const latestReview = reviews.length > 0
    ? reviews.reduce((a, b) => new Date(b.created_at) > new Date(a.created_at) ? b : a)
    : null;
  const viewCount = reviews.length;

  useEffect(() => {
    if (autoEditLatest && latestReview && !showPanel) {
      setEditingReview(latestReview);
      setCurrentRating(latestReview.rating);
      setShowPanel(true);
      onAutoEditConsumed?.();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoEditLatest, latestReview, showPanel]);

  useEffect(() => {
    if (autoRate && !showPanel) {
      if (!isAuthenticated && !authLoading && onAuthRequired) {
        onAuthRequired('rating', autoRateStars ?? undefined);
      } else {
        setShowPanel(true);
        setEditingReview(null);
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
      setCurrentRating(rating);
      onAuthRequired('rating', rating);
      return;
    }
    setCurrentRating(rating);
    setShowPanel(true);
    setEditingReview(null);
  }, [isAuthenticated, authLoading, onAuthRequired]);

  const handleSave = useCallback(async (data: { rating: number; reviewText: string | null; dateSeen: string | null }) => {
    if (!onSaveReview) return;
    setSaving(true);
    try {
      const idToPass = editingReview?.id || lastSavedId.current || undefined;
      const savedId = await onSaveReview({ ...data, reviewId: idToPass });
      if (savedId) lastSavedId.current = savedId;
    } catch (e) {
      console.error('[Rating] Save error:', e);
    } finally {
      setSaving(false);
      setShowPanel(false);
      setEditingReview(null);
      setCurrentRating(null);
    }
  }, [onSaveReview, editingReview]);

  const handleCancel = useCallback(() => {
    setShowPanel(false);
    setEditingReview(null);
    if (!latestReview) setCurrentRating(null);
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
      if (editingReview?.id === reviewId) {
        setShowPanel(false);
        setEditingReview(null);
        setCurrentRating(null);
      }
    } catch {
      // Toast handled by parent
    }
  }, [onDeleteReview, editingReview]);

  const triggerConfirmDelete = useCallback((reviewId: string) => {
    setConfirmDeleteId(reviewId);
    if (confirmDeleteTimerRef.current) clearTimeout(confirmDeleteTimerRef.current);
    confirmDeleteTimerRef.current = setTimeout(() => setConfirmDeleteId(null), 4000);
  }, []);

  if (!featureFlags.userAccounts) return null;

  return (
    <div className="mt-2 pt-2 -mb-2 border-t border-white/[0.06]">
      {/* Header */}
      <div className="flex items-center gap-2 mb-1">
        <h3 className="text-xs font-bold text-gray-500 uppercase tracking-wider">My Rating &amp; Review</h3>
        {viewCount > 1 && (
          <span className="text-[10px] font-medium text-gray-500 bg-white/[0.05] px-1.5 py-0.5 rounded">
            Seen {viewCount} times
          </span>
        )}
      </div>

      {/* Stars + edit state */}
      {latestReview && !showPanel ? (
        <div>
          <StarRating rating={latestReview.rating} onRatingChange={handleRatingChange} size="md" readOnly hideLabel />
          {/* Controls row: edit · delete · date · new viewing · all ratings */}
          <div className="group/latest flex items-center gap-1.5 mt-1">
            <div className="flex items-center gap-0.5 sm:opacity-0 sm:group-hover/latest:opacity-100 transition-opacity">
              <button
                type="button"
                onClick={() => handleEdit(latestReview)}
                className="p-0.5 text-gray-500 hover:text-white transition-colors"
                aria-label="Edit rating"
              >
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                </svg>
              </button>
              {confirmDeleteId === latestReview.id ? (
                <span className="flex items-center gap-1 text-[11px]">
                  <button type="button" onClick={() => handleDelete(latestReview.id)} className="text-red-400 hover:text-red-300 font-medium">Delete?</button>
                  <button type="button" onClick={() => setConfirmDeleteId(null)} className="text-gray-500 hover:text-white">Cancel</button>
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => triggerConfirmDelete(latestReview.id)}
                  className="p-0.5 text-gray-500 hover:text-red-400 transition-colors"
                  aria-label="Delete rating"
                >
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                  </svg>
                </button>
              )}
            </div>
            {latestReview.date_seen ? (
              <span className="text-[11px] text-gray-500">
                {new Date(latestReview.date_seen + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
              </span>
            ) : (
              <button
                type="button"
                onClick={() => handleEdit(latestReview)}
                className="text-[11px] text-gray-500 hover:text-brand transition-colors"
              >
                + Date
              </button>
            )}
            <span className="text-gray-600 text-[10px]">·</span>
            <button
              type="button"
              onClick={() => {
                setEditingReview(null);
                setCurrentRating(null);
                lastSavedId.current = null;
                setShowPanel(false);
                handleRatingChange(latestReview.rating);
              }}
              className="text-[11px] text-gray-500 hover:text-brand transition-colors whitespace-nowrap"
            >
              + New Viewing
            </button>
            <span className="text-gray-600 text-[10px]">·</span>
            <Link href="/my-shows" className="text-[11px] text-gray-500 hover:text-brand transition-colors whitespace-nowrap">
              All Ratings
            </Link>
          </div>
          {latestReview.review_text && (
            <p className="text-sm text-gray-400 mt-1.5 italic line-clamp-3">{latestReview.review_text}</p>
          )}
        </div>
      ) : (
        <StarRating
          rating={currentRating}
          onRatingChange={handleRatingChange}
          size="md"
          hideLabel
        />
      )}

      {/* Previous viewings */}
      {viewCount > 1 && !showPanel && (
        <div className="mt-2 space-y-1.5" data-testid="previous-viewings">
          {reviews.filter(r => r.id !== latestReview?.id).slice(0, 3).map(review => (
            <div key={review.id} className="group/viewing">
              <div className="flex items-center gap-1.5 text-sm text-gray-500">
                <StarRating rating={review.rating} onRatingChange={() => {}} size="md" readOnly hideLabel />
                <div className="flex items-center gap-0.5 sm:opacity-0 sm:group-hover/viewing:opacity-100 transition-opacity">
                  <button type="button" onClick={() => handleEdit(review)} className="p-1 text-gray-500 hover:text-white transition-colors" aria-label="Edit this viewing">
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
                    <button type="button" onClick={() => triggerConfirmDelete(review.id)} className="p-1 text-gray-500 hover:text-red-400 transition-colors" aria-label="Delete this viewing">
                      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                      </svg>
                    </button>
                  )}
                </div>
                <span className="text-xs text-gray-500">
                  {review.date_seen
                    ? new Date(review.date_seen + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
                    : '\u00A0'}
                </span>
              </div>
              {review.review_text && (
                <p className="text-xs text-gray-500 mt-0.5 italic line-clamp-2 ml-0.5">{review.review_text}</p>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Review panel */}
      {showPanel && currentRating !== null && (
        <ReviewPanel
          rating={currentRating}
          existingReviewText={editingReview?.review_text}
          existingDateSeen={editingReview?.date_seen ?? (editingReview ? undefined : watchlistDate)}
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
