'use client';

import { Suspense, useState, useEffect, useCallback, useRef } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import dynamic from 'next/dynamic';
import { useAuth } from '@/contexts/AuthContext';
import { useUserReviews } from '@/hooks/useUserReviews';
import { supabaseRestInsert, supabaseRestUpdate } from '@/lib/supabase-rest';
import { usePendingRatingDraft } from '@/hooks/usePendingRatingDraft';
import { useToastSafe } from '@/components/ui/Toast';
import RatingEditor, { type RatingEditorSaveData } from '@/components/user/RatingEditor';
import StarRating from '@/components/user/StarRating';
import ShowImage from '@/components/ShowImage';
import type { UserReview } from '@/types/user';
import { marketLabel, type DiaryShowDetail } from '@/lib/diary-show-types';

const ShowPageWatchlistButton = dynamic(() => import('@/components/user/ShowPageWatchlistButton'), { ssr: false });

// useSearchParams requires a Suspense boundary (mirrors ShowHeroRedesign).
export default function DiaryShowClient({ show }: { show: DiaryShowDetail }) {
  return (
    <Suspense fallback={null}>
      <Inner show={show} />
    </Suspense>
  );
}

function Inner({ show }: { show: DiaryShowDetail }) {
  const { user, isAuthenticated, loading: authLoading, showSignIn } = useAuth();
  const { reviews, getReviewsForShow } = useUserReviews(user?.id || null);
  const { showToast } = useToastSafe();
  const searchParams = useSearchParams();
  const [ratePanelOpen, setRatePanelOpen] = useState(false);
  const [editingReview, setEditingReview] = useState<UserReview | null>(null);
  // Validated ?stars=N from watchlist rate strips — seeds a NEW rating only.
  const [deepLinkStars, setDeepLinkStars] = useState<number | null>(null);
  // Distinct from useUserReviews' `loading` (which only flips true once the
  // fetch has actually started) — this tracks "has the initial sync settled
  // at least once" so ?edit=1 doesn't race into "new rating" mode against an
  // empty `reviews` array on the very first render.
  const [reviewsSynced, setReviewsSynced] = useState(false);
  const hasHandledQueryParam = useRef(false);

  useEffect(() => {
    if (!isAuthenticated || !user) return;
    getReviewsForShow(show.id).finally(() => setReviewsSynced(true));
  }, [isAuthenticated, user, show.id, getReviewsForShow]);

  const latestReview = reviews[0] || null;

  // Draft carried across sign-in (rating + typed note + date + target review
  // id) — without this, a signed-out user's typed rating/notes vanish the
  // moment they complete sign-in (ship-check finding, 2026-07-14).
  const { pendingDraft, setPendingDraft, hasExecutedPending, saveDraft } = usePendingRatingDraft(show.id, {
    isAuthenticated,
    user,
    onResumeRatingDraft: () => {
      setEditingReview(null);
      setRatePanelOpen(true);
    },
  });

  // ?rate=1 / ?edit=1 — deep-link targets from My Shows card CTAs. ?edit=1
  // waits for the user's reviews to finish loading so it doesn't race into
  // "new rating" mode before latestReview is populated.
  useEffect(() => {
    if (hasHandledQueryParam.current || authLoading || hasExecutedPending.current) return;
    const wantsRate = searchParams.get('rate') === '1';
    const wantsEdit = searchParams.get('edit') === '1';
    if (!wantsRate && !wantsEdit) return;
    if (!isAuthenticated) {
      hasHandledQueryParam.current = true;
      saveDraft({});
      showSignIn('rating');
      return;
    }
    if (wantsEdit && !reviewsSynced) return; // wait for latestReview to resolve
    hasHandledQueryParam.current = true;
    // ?stars=N from the watchlist rate strips — same validation as the show
    // hero (untrusted input: NaN / out-of-range dropped). Without this the
    // tapped star was silently ignored for diary-only shows (review, 2026-07-19).
    const starsRaw = searchParams.get('stars') ? parseFloat(searchParams.get('stars')!) : null;
    setDeepLinkStars(
      starsRaw !== null && Number.isFinite(starsRaw) && starsRaw >= 0.5 && starsRaw <= 5 ? starsRaw : null,
    );
    setEditingReview(wantsEdit ? latestReview : null);
    setPendingDraft(null);
    setRatePanelOpen(true);
  }, [searchParams, authLoading, isAuthenticated, reviewsSynced, show.id, latestReview, showSignIn, saveDraft, hasExecutedPending, setPendingDraft]);

  const handleSaveReview = useCallback(async (data: RatingEditorSaveData) => {
    if (!user) {
      if (authLoading) {
        throw new Error('Still restoring your session — tap Retry in a moment.');
      }
      saveDraft(data);
      showSignIn('rating');
      return 'auth-gated';
    }
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
      showToast?.('Rating updated.', 'success');
    } else {
      const { error } = await supabaseRestInsert('reviews', {
        user_id: user.id,
        show_id: show.id,
        rating: data.rating,
        review_text: data.reviewText || null,
        date_seen: data.dateSeen || null,
      });
      if (error) throw new Error(error.message);
      showToast?.(<>Added to <a href="/my-shows" className="underline hover:text-white/90">My Ratings &amp; Reviews</a></>, 'success');
    }
    await getReviewsForShow(show.id);
  }, [user, authLoading, show.id, getReviewsForShow, showSignIn, showToast, saveDraft]);

  const handleRateClick = () => {
    setEditingReview(null);
    setPendingDraft(null);
    setRatePanelOpen(true);
  };
  const handleEditClick = () => {
    setEditingReview(latestReview);
    setPendingDraft(null);
    setRatePanelOpen(true);
  };
  const handleRateSaved = () => {
    setRatePanelOpen(false);
    setEditingReview(null);
    setPendingDraft(null);
  };
  const handleCancelRate = () => {
    setRatePanelOpen(false);
    setEditingReview(null);
    setPendingDraft(null);
  };

  const marketDetail = [show.city, marketLabel(show.category)].filter(Boolean).join(' · ');

  return (
    <div className="max-w-2xl mx-auto px-4 sm:px-6 pt-6 sm:pt-8 pb-16">
      <Link href="/my-shows" className="text-sm text-gray-500 hover:text-white transition-colors inline-flex items-center gap-1 mb-4">
        ← My Shows
      </Link>

      <div className="flex gap-4 sm:gap-5 mb-6">
        <div className="flex-shrink-0 w-24 sm:w-32 aspect-[2/3] rounded-lg overflow-hidden bg-surface-overlay">
          <ShowImage
            sources={[show.posterUrl]}
            alt={show.title}
            fallback={<div className="w-full h-full flex items-center justify-center text-gray-600 text-3xl">🎭</div>}
            className="w-full h-full object-cover"
          />
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="text-xl sm:text-2xl font-extrabold text-white">{show.title}</h1>
          {show.venue && <p className="text-sm text-gray-400 mt-1">{show.venue}</p>}
          {marketDetail && <p className="text-sm text-gray-500 mt-0.5">{marketDetail}</p>}
          <p className="text-xs text-gray-600 mt-1">
            {show.openingDate
              ? `Opened ${new Date(show.openingDate + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`
              : 'Opening date unknown'}
          </p>
        </div>
      </div>

      {/* Honest empty state — no critic coverage, never a broken-looking page */}
      <div className="card px-4 py-3 mb-6 text-sm text-gray-400">
        We don&apos;t have critic reviews for this production — it&apos;s outside Broadway Scorecard&apos;s coverage area.
      </div>

      <div className="card px-4 py-4 mb-4">
        {latestReview ? (
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <StarRating rating={latestReview.rating} onRatingChange={() => {}} size="md" readOnly hideLabel />
                <span className="text-white font-bold">{latestReview.rating.toFixed(1)}</span>
              </div>
              {latestReview.date_seen && (
                <p className="text-xs text-amber-400 mt-1">
                  Saw {new Date(latestReview.date_seen + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                </p>
              )}
              {latestReview.review_text && <p className="text-xs text-gray-500 mt-1 italic truncate">{latestReview.review_text}</p>}
            </div>
            <button type="button" onClick={handleEditClick} className="text-xs text-gray-400 hover:text-white flex-shrink-0">Edit</button>
          </div>
        ) : (
          <button type="button" onClick={handleRateClick} className="btn-primary text-sm">
            Rate this show
          </button>
        )}
      </div>

      <ShowPageWatchlistButton
        showId={show.id}
        title={show.title}
        slug={show.slug}
        diaryOnly
        category={show.category}
        venue={show.venue}
      />

      {ratePanelOpen && (
        <RatingEditor
          key={editingReview?.id ?? pendingDraft?.reviewId ?? 'new-viewing'}
          showTitle={show.title}
          reviewId={editingReview?.id ?? pendingDraft?.reviewId}
          initialRating={editingReview?.rating ?? pendingDraft?.rating ?? deepLinkStars ?? 0}
          initialReviewText={editingReview?.review_text ?? pendingDraft?.reviewText ?? null}
          initialDateSeen={editingReview?.date_seen ?? pendingDraft?.dateSeen ?? null}
          presentation="modal"
          onSave={handleSaveReview}
          onSaved={handleRateSaved}
          onCancel={handleCancelRate}
        />
      )}
    </div>
  );
}
