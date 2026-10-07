'use client';

/**
 * Deferred-auth rating draft: a signed-out user types a rating/note, we save
 * it to localStorage and gate on sign-in, then resume it once they land back
 * on the page authenticated. Shared by ShowHeroRedesign and DiaryShowClient
 * so the resume flow (and the "forgot to include data.rating" class of bug)
 * only has one place to get wrong.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { savePendingAction, getPendingAction, clearPendingAction } from '@/lib/deferred-auth';
import type { PendingAction } from '@/types/user';

interface SaveDraftInput {
  rating?: number;
  reviewText?: string | null;
  dateSeen?: string | null;
  reviewId?: string;
}

interface UsePendingRatingDraftOptions {
  isAuthenticated: boolean;
  user: unknown;
  /** Called synchronously (same effect pass) when a rating draft is resumed. */
  onResumeRatingDraft: (pending: PendingAction) => void;
  /** Called for any pending action of a different type (e.g. 'watchlist'). */
  onOtherPendingAction?: (pending: PendingAction) => void;
}

export function usePendingRatingDraft(showId: string, options: UsePendingRatingDraftOptions) {
  const { isAuthenticated, user, onResumeRatingDraft, onOtherPendingAction } = options;
  const [pendingDraft, setPendingDraft] = useState<PendingAction | null>(null);
  const hasExecutedPending = useRef(false);

  // Consume pending action after deferred auth.
  useEffect(() => {
    if (!isAuthenticated || !user || hasExecutedPending.current) return;
    const pending = getPendingAction();
    if (!pending || pending.showId !== showId) return;
    hasExecutedPending.current = true;
    clearPendingAction();

    if (pending.type === 'rating') {
      setPendingDraft(pending);
      onResumeRatingDraft(pending);
    } else {
      onOtherPendingAction?.(pending);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated, user, showId]);

  const saveDraft = useCallback((data: SaveDraftInput) => {
    savePendingAction({
      type: 'rating',
      showId,
      ...(data.rating != null ? { rating: data.rating } : {}),
      ...(data.reviewText ? { reviewText: data.reviewText } : {}),
      ...(data.dateSeen ? { dateSeen: data.dateSeen } : {}),
      ...(data.reviewId ? { reviewId: data.reviewId } : {}),
      returnUrl: window.location.pathname,
      timestamp: Date.now(),
    });
  }, [showId]);

  return { pendingDraft, setPendingDraft, hasExecutedPending, saveDraft };
}
