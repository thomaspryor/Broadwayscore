'use client';

/**
 * ShowHeroRedesign — Broadway Radar–inspired show-page hero block (mobile-first).
 *
 * Replaces the prior `featureFlags.showPageRedesign` block in src/app/show/[slug]/page.tsx.
 * Renders: poster + title header, dual score boxes (critic + audience), distribution bar,
 * Critics' Take, your-rating card (rated state), Want-to-See / Rate-it buttons,
 * inline rate panel (web), primary tickets CTA + secondary tickets row, on-list caption.
 *
 * Decisions (see memory/feedback_show_page_redesign_v2_decisions.md):
 *  • Score-card tap targets — both anchor to existing #critic-reviews / #audience.
 *  • Primary button: "Rate it" (first time) / "Log another viewing" (any rated
 *    count) → always opens a FRESH panel and APPENDS a new viewing. Correcting an
 *    existing rating is the Edit pencil, so multi-viewing is always reachable and
 *    the button never overwrites a prior viewing.
 *  • Date format: `Apr 10, 2026` always (matches existing /show convention).
 *  • Multi-viewing card shows latest highlighted + "All N ratings →" footer link.
 *  • No inline trash on the rating card — delete moves into the edit panel.
 *  • Closed shows: rating card renders if rated; tickets CTA + secondary row hidden;
 *    "Want to See" still functions ("wished I'd seen" semantics).
 *  • Rating a show REMOVES it from the watchlist (watchlist = unseen wants;
 *    owner rule 2026-07-12). The poster bookmark and Want to See both toggle
 *    the same watchlist.
 *  • <3 reviews → "Awaiting reviews" replaces score row + bar + Critics' Take.
 *
 * Deferred-auth flow: pending action (rating draft) saved before showSignIn();
 * resumed when the user lands back on this page authenticated.
 */

import React, { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { track } from '@vercel/analytics';
import {
  ScoreBadge,
  ScoreBreakdownBar,
  FormatPill,
  ProductionPill,
  StatusBadge,
  CategoryBadge,
  getScoreTier,
} from '@/components/show-cards';
import StarRating from '@/components/user/StarRating';
import RatingEditor from '@/components/user/RatingEditor';
import ShowImage from '@/components/ShowImage';
import ShowPageBookmark from '@/components/user/ShowPageBookmark';
import HoverRateStars from '@/components/user/HoverRateStars';
import TicketButtonsAB from '@/components/TicketButtonsAB';
import { useAuth } from '@/contexts/AuthContext';
import { useUserReviews } from '@/hooks/useUserReviews';
import { useWatchlist } from '@/hooks/useWatchlist';
import { useUserLists } from '@/hooks/useUserLists';
import { useToastSafe } from '@/components/ui/Toast';
import { savePendingAction } from '@/lib/deferred-auth';
import { usePendingRatingDraft } from '@/hooks/usePendingRatingDraft';
import { invalidateRatingsCache } from '@/hooks/useMyRating';
import { supabaseRestInsert, supabaseRestUpdate } from '@/lib/supabase-rest';
import { featureFlags } from '@/config/feature-flags';
import { getOptimizedImageUrl } from '@/lib/images';
import { getCurrencySymbol } from '@/lib/market-utils';
import { isOperaShow } from '@/lib/show-market';
import type { ComputedShow } from '@/lib/engine';

/** Inlined to avoid pulling @/lib/data-core (server-only JSON imports) into the
 *  client bundle. Matches the data-core slugify exactly. */
function slugify(str: string): string {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
import type { AudienceGrade } from '@/components/show-cards';
import type { TicketLinkData } from '@/lib/ticket-utils';
import type { UserReview, PendingAction } from '@/types/user';
import type { ShowRanks } from '@/lib/data-show-ranks';
import HeroRankLine from '@/components/show-page/HeroRankLine';

// ─── Props ───────────────────────────────────────────────────────────────

interface ShowHeroRedesignProps {
  show: ComputedShow;
  consensusText: string | null;
  audienceGrade: AudienceGrade | null;
  audienceCount: number;
  hasAudience: boolean;
  hasEnoughCriticReviews: boolean;
  sortedTicketLinks: TicketLinkData[];
  lotteryRush: { lottery?: { price?: number | null } | null; rush?: { price?: number | null } | null } | null;
  isWestEnd: boolean;
  isOffBroadway: boolean;
  /** Precomputed cross-show ranks for the hero rank line. Null = feature-gated off
   *  OR no rankable data. */
  ranks: ShowRanks | null;
}

// ─── Suspense wrapper (useSearchParams requires it for static prerender) ──

export default function ShowHeroRedesign(props: ShowHeroRedesignProps) {
  return (
    <Suspense fallback={null}>
      <Inner {...props} />
    </Suspense>
  );
}

// ─── Inner ───────────────────────────────────────────────────────────────

function Inner({
  show,
  consensusText,
  audienceGrade,
  audienceCount,
  hasAudience,
  hasEnoughCriticReviews,
  sortedTicketLinks,
  lotteryRush,
  isWestEnd,
  isOffBroadway,
  ranks,
}: ShowHeroRedesignProps) {
  const { user, isAuthenticated, loading: authLoading, showSignIn } = useAuth();
  const { reviews, getReviewsForShow, deleteReview } = useUserReviews(user?.id || null);
  const { isWatchlisted, addToWatchlist, removeFromWatchlist, getWatchlist, watchlist } = useWatchlist(user?.id || null);
  const { lists, getLists } = useUserLists(user?.id || null);
  const { showToast } = useToastSafe();
  const searchParams = useSearchParams();

  const [ratePanelOpen, setRatePanelOpen] = useState(false);
  const [editingReview, setEditingReview] = useState<UserReview | null>(null);
  const rateBtnRef = useRef<HTMLButtonElement>(null);
  // Return focus to the rate button when the editor closes — the inline
  // (desktop) editor is not a Modal, so nothing else restores focus and it
  // falls to <body>, stranding keyboard/screen-reader users (audit P2).
  const refocusRateBtn = () => requestAnimationFrame(() => rateBtnRef.current?.focus());

  // ?rate=1 / ?stars=N / ?edit=1 deep-link helpers (kept compatible with /my-shows entry points)
  const [autoRate] = useState(() => searchParams.get('rate') === '1');
  const autoRateStarsRaw = searchParams.get('stars') ? parseFloat(searchParams.get('stars')!) : null;
  // Untrusted input: ?stars=abc → NaN, ?stars=99 → out of range. Drop invalid values.
  const autoRateStars = autoRateStarsRaw !== null && Number.isFinite(autoRateStarsRaw) && autoRateStarsRaw >= 0.5 && autoRateStarsRaw <= 5
    ? autoRateStarsRaw
    : null;
  const [autoEditLatest] = useState(() => searchParams.get('edit') === '1');

  // ─── Derived state ─────────────────────────────────────────────────────

  const showReviews = reviews.filter(r => r.show_id === show.id);
  const sortedReviews = [...showReviews].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  );
  const latestReview = sortedReviews[0] ?? null;
  const ratingCount = showReviews.length;
  const hasRating = ratingCount > 0;
  const isMulti = ratingCount > 1;
  const onWatchlist = isWatchlisted(show.id);
  const watchlistDate = watchlist.find(w => w.show_id === show.id)?.planned_date || null;

  // Lists containing this show — caption only, no button on show page.
  const listsWithShow = lists.filter(l =>
    (l.all_show_ids ?? l.preview_show_ids ?? []).includes(show.id)
  );
  const firstListContainingShow = listsWithShow[0];

  const score = show.criticScore?.score ?? null;
  const reviewCount = show.criticScore?.reviewCount ?? 0;
  const criticReviewsForBar = show.criticScore?.reviews ?? [];
  const tier = score !== null ? getScoreTier(score, show.category) : null;
  const isClosed = show.status === 'closed';
  const isPreviews = show.status === 'previews' || show.status === 'upcoming';

  // Average rating across user's viewings (multi-viewing card foot)
  const userAvg = ratingCount > 0
    ? showReviews.reduce((sum, r) => sum + r.rating, 0) / ratingCount
    : 0;

  // ─── Effects ───────────────────────────────────────────────────────────

  // Load on auth
  useEffect(() => {
    if (isAuthenticated && user) {
      getReviewsForShow(show.id);
      getWatchlist();
      getLists();
    }
  }, [isAuthenticated, user, show.id, getReviewsForShow, getWatchlist, getLists]);

  // Draft carried across sign-in (rating + typed note + date + target review id).
  const { pendingDraft, setPendingDraft, hasExecutedPending, saveDraft } = usePendingRatingDraft(show.id, {
    isAuthenticated,
    user,
    // Resume the draft the user was mid-editing before we gated on sign-in.
    onResumeRatingDraft: () => {
      setEditingReview(null);
      setRatePanelOpen(true);
    },
    onOtherPendingAction: (pending) => {
      if (pending.type === 'watchlist') {
        addToWatchlist(show.id)
          .then(() => showToast?.(<>Added to <a href="/my-shows?tab=watchlist" className="underline hover:text-white/90">Watchlist</a></>, 'success'))
          .catch(() => showToast?.('Failed to add to watchlist.', 'error'));
      }
    },
  });

  // ?rate=1 — auto-open rate panel (deferred-auth target for inline-stars CTAs)
  useEffect(() => {
    if (!autoRate || ratePanelOpen) return;
    // The pending-action effect above runs first in the same commit and sets
    // this ref synchronously when it consumed a draft for this show — without
    // this guard, the stale ratePanelOpen=false read here would let us clobber
    // the just-restored draft (typed note included) with a bare stars hint.
    if (hasExecutedPending.current) return;
    if (!isAuthenticated && !authLoading) {
      saveDraft(autoRateStars != null ? { rating: autoRateStars } : {});
      showSignIn('rating');
    } else {
      // Always a FRESH panel (append), seeded with the ?stars= hint — consistent
      // with the rate button. Editing an existing rating is ?edit=1 / the pencil.
      setEditingReview(null);
      setPendingDraft(
        autoRateStars == null
          ? null
          : { type: 'rating', showId: show.id, rating: autoRateStars, returnUrl: '', timestamp: 0 },
      );
      setRatePanelOpen(true);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRate, isAuthenticated, authLoading]);

  // ?edit=1 — auto-open edit on latest review (diary edit pencil entry point)
  useEffect(() => {
    if (autoEditLatest && latestReview && !ratePanelOpen) {
      setEditingReview(latestReview);
      setRatePanelOpen(true);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoEditLatest, latestReview]);

  // ─── Handlers ──────────────────────────────────────────────────────────

  const handleWantToSee = useCallback(async () => {
    if (!isAuthenticated && !authLoading) {
      savePendingAction({
        type: 'watchlist',
        showId: show.id,
        returnUrl: window.location.pathname,
        timestamp: Date.now(),
      });
      showSignIn('watchlist');
      return;
    }
    try {
      if (onWatchlist) {
        await removeFromWatchlist(show.id);
        showToast?.(<>Removed from <a href="/my-shows?tab=watchlist" className="underline hover:text-white/90">Watchlist</a></>, 'info');
      } else {
        await addToWatchlist(show.id);
        showToast?.(<>Added to <a href="/my-shows?tab=watchlist" className="underline hover:text-white/90">Watchlist</a></>, 'success');
      }
    } catch {
      showToast?.('Failed to update watchlist.', 'error');
    }
  }, [isAuthenticated, authLoading, onWatchlist, show.id, addToWatchlist, removeFromWatchlist, showSignIn, showToast]);

  const handleRateIt = useCallback(() => {
    // Open the editor for everyone. Unauthenticated users invest first; we gate
    // on sign-in at Save (handleSaveReview) and preserve their draft across auth.
    // The primary button ALWAYS logs a NEW viewing (fresh panel, appends) — for
    // any rating count. Correcting an existing rating is the pencil (Edit), not
    // this button, so a second viewing is always reachable and never overwrites.
    setEditingReview(null);
    setPendingDraft(null);
    setRatePanelOpen(true);
  }, [setPendingDraft]);

  // Poster hover-stars pick — same fresh-panel semantics as handleRateIt, but
  // seeded with the clicked star count (mirrors the ?rate=1&stars=N deep-link
  // branch; a same-page deep-link wouldn't re-fire since params are read once).
  const handlePosterStarsPick = useCallback((stars: number) => {
    setEditingReview(null);
    setPendingDraft({ type: 'rating', showId: show.id, rating: stars, returnUrl: '', timestamp: 0 });
    setRatePanelOpen(true);
    refocusRateBtn();
  }, [setPendingDraft, show.id]);


  // NOTE: RatingEditor owns the saving spinner and, critically, keeps the panel
  // open with the typed note intact when this rejects. So on the authed path we
  // THROW on failure (no swallow, no close-in-finally) and let a resolved promise
  // signal success — the editor then calls onSaved to close.
  const handleSaveReview = useCallback(async (data: { rating: number; reviewText: string | null; dateSeen: string | null; reviewId?: string }): Promise<void | 'auth-gated'> => {
    if (!user) {
      if (authLoading) {
        // Session still restoring for an already-signed-in user — don't bounce
        // them to sign-in; surface a retryable error in the editor instead.
        throw new Error('Still restoring your session — tap Retry in a moment.');
      }
      // Gate at Save — persist the full draft, then sign in. The editor stays
      // open behind the sign-in modal ('auth-gated'), so cancelling sign-in
      // loses nothing; completing it lets the pending-action effect resume.
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
      // PostgREST returns 200 + [] when the filter matched nothing (e.g. the
      // review was deleted in another tab) — that's a failed save, not success.
      if (!updated) throw new Error('This rating no longer exists — it may have been deleted elsewhere.');
      track('rating_submitted', { show_id: show.id, rating: data.rating, has_review_text: !!data.reviewText, is_edit: true });
      showToast?.(<>Updated in <a href="/my-shows" className="underline hover:text-white/90">My Ratings &amp; Reviews</a></>, 'success');
    } else {
      const { error } = await supabaseRestInsert('reviews', {
        user_id: user.id,
        show_id: show.id,
        rating: data.rating,
        review_text: data.reviewText || null,
        date_seen: data.dateSeen || null,
      });
      if (error) throw new Error(error.message);
      track('rating_submitted', { show_id: show.id, rating: data.rating, has_review_text: !!data.reviewText, is_edit: false });
      showToast?.(<>Added to <a href="/my-shows" className="underline hover:text-white/90">My Ratings &amp; Reviews</a></>, 'success');
      // Watchlist = shows you WANT to see. Rating a show means you've seen it,
      // so drop any watchlist entry (owner rule 2026-07-12 — replaces the old
      // "watchlist and rating are independent" decision). Non-fatal: the rating
      // itself already saved.
      // Unconditional: isWatchlisted reads this instance's async-loaded state and
      // can be stale on fast deep-link saves; deleting a non-existent row is a
      // harmless no-op (slight watchlist_remove analytics noise accepted).
      try { await removeFromWatchlist(show.id); } catch { /* rating saved; watchlist cleanup is best-effort */ }
    }
    await getReviewsForShow(show.id);
    invalidateRatingsCache();
  }, [user, authLoading, show.id, getReviewsForShow, showToast, showSignIn, isWatchlisted, removeFromWatchlist, saveDraft]);

  const handleRateSaved = useCallback(() => {
    setRatePanelOpen(false);
    setEditingReview(null);
    setPendingDraft(null);
    refocusRateBtn();
  }, [setPendingDraft]);

  const handleCancelRate = useCallback(() => {
    setRatePanelOpen(false);
    setEditingReview(null);
    setPendingDraft(null);
    refocusRateBtn();
  }, [setPendingDraft]);

  const handleDeleteRating = useCallback(async () => {
    if (!editingReview) return;
    try {
      await deleteReview(editingReview.id);
      showToast?.('Rating deleted.', 'info');
      await getReviewsForShow(show.id);
      invalidateRatingsCache();
    } catch (e) {
      const detail = e instanceof Error ? e.message : 'Unknown error';
      showToast?.(`Delete failed: ${detail}`, 'error');
    } finally {
      setRatePanelOpen(false);
      setEditingReview(null);
      setPendingDraft(null);
    }
  }, [editingReview, deleteReview, getReviewsForShow, show.id, showToast, setPendingDraft]);

  // ─── Render ────────────────────────────────────────────────────────────

  const venueLink = isWestEnd
    ? `/west-end/theater/${slugify(show.venue)}`
    : isOffBroadway
      ? null
      : `/theater/${slugify(show.venue)}`;

  // Hide rating section + watchlist controls if userAccounts flag off (keeps demo-only gate).
  const userFeaturesEnabled = featureFlags.userAccounts;

  return (
    <div className="card p-4 sm:p-5 space-y-4 lg:space-y-3" data-testid="show-hero-redesign">
      {/* Header: poster left + title block right. Poster scales up at desktop. */}
      <div className="flex gap-4 lg:gap-6">
        <div className="flex-shrink-0 w-28 sm:w-36 lg:w-44">
          <div className="group relative aspect-[2/3] rounded-xl overflow-visible shadow-2xl border border-white/10 bg-surface-raised">
            {userFeaturesEnabled && <ShowPageBookmark showId={show.id} size="compact" />}
            <div className="absolute inset-0 rounded-xl overflow-hidden">
              {userFeaturesEnabled && (
                <HoverRateStars showId={show.id} showHref={`/show/${show.slug}`} starSize="sm" onPick={handlePosterStarsPick} />
              )}
              <ShowImage
                sources={[
                  show.images?.poster ? getOptimizedImageUrl(show.images.poster, 'poster') : null,
                  show.images?.thumbnail ? getOptimizedImageUrl(show.images.thumbnail, 'poster') : null,
                  show.images?.hero ? getOptimizedImageUrl(show.images.hero, 'poster') : null,
                ]}
                alt={`${show.title} poster`}
                width={176}
                height={264}
                decoding="async"
                priority
                sizes="144px"
                className="w-full h-full object-cover"
                fallback={
                  <div className="w-full h-full flex items-center justify-center bg-surface-overlay">
                    <span className="text-4xl text-gray-500">🎭</span>
                  </div>
                }
              />
            </div>
          </div>
        </div>
        <div className="flex-1 min-w-0 space-y-1.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <FormatPill type={show.type} />
            {show.isRevival && <ProductionPill isRevival />}
            <CategoryBadge category={show.category} isOpera={isOperaShow(show)} />
            <StatusBadge status={show.status} />
          </div>
          <h1 className="text-2xl lg:text-4xl font-extrabold tracking-tight leading-tight text-white">
            {show.title}
          </h1>
          <div className="text-sm text-gray-400 space-y-0.5 pt-0.5">
            <p>
              {venueLink ? (
                <Link href={venueLink} className="text-gray-300 underline underline-offset-2 decoration-white/10 hover:text-brand transition-colors">
                  {show.venue}
                </Link>
              ) : (
                <span className="text-gray-300">{show.venue}</span>
              )}
              {show.runtime ? <span> · {show.runtime}</span> : null}
            </p>
            <DateLine show={show} />
          </div>

          {/* Desktop-only inline score block — lives INSIDE the right column,
              alongside title/meta. Mobile renders dual cards in a separate
              full-width row below the header. */}
          {hasEnoughCriticReviews && (
            <div className="hidden lg:flex items-center flex-wrap gap-4 pt-3">
              <a href="#critic-reviews" className="flex items-center gap-4 hover:opacity-90 transition-opacity">
                <ScoreBadge score={score} reviewCount={reviewCount} category={show.category} size="lg" showCrown />
                <div>
                  {tier && (
                    <p className="text-2xl font-extrabold leading-tight tracking-tight" style={{ color: tier.color }}>
                      {tier.label}
                    </p>
                  )}
                  <p className="text-sm text-gray-500 mt-1">
                    Based on {reviewCount} Critic {reviewCount === 1 ? 'Review' : 'Reviews'}
                  </p>
                  <HeroRankLine ranks={ranks} market={show.category} />
                </div>
              </a>
              {hasAudience && audienceGrade && (
                <a
                  href="#audience"
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold hover:brightness-125 transition-all"
                  style={{ background: `${audienceGrade.color}1f`, color: audienceGrade.color }}
                >
                  <span className="opacity-60">Audience:</span>
                  <span>{audienceGrade.grade} · {audienceGrade.label}</span>
                </a>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Mobile/sm score row — dual cards. Hidden on desktop (score block lives
          inline in the title column on lg+). Awaiting card replaces both when
          there aren't enough critic reviews. */}
      {!hasEnoughCriticReviews ? (
        <AwaitingCard show={show} reviewCount={reviewCount} />
      ) : (
        <div className={`lg:hidden grid gap-2.5 ${hasAudience && audienceGrade ? 'grid-cols-2' : 'grid-cols-1'}`}>
          <a href="#critic-reviews" className="card p-3 sm:p-4 flex items-center gap-3 hover:bg-surface-overlay transition-colors">
            <ScoreBadge score={score} reviewCount={reviewCount} category={show.category} size="lg" showCrown />
            <div className="min-w-0 flex-1">
              {tier && (
                <p className="text-sm font-bold leading-tight break-words" style={{ color: tier.color }}>
                  {tier.label}
                </p>
              )}
              <p className="text-xs text-gray-500 mt-0.5 leading-snug">
                {reviewCount} critic {reviewCount === 1 ? 'review' : 'reviews'}
              </p>
            </div>
          </a>
          {hasAudience && audienceGrade && (
            <a href="#audience" className="card p-3 sm:p-4 flex items-center gap-3 hover:bg-surface-overlay transition-colors">
              <div
                className="w-16 h-16 sm:w-20 sm:h-20 rounded-xl flex items-center justify-center flex-shrink-0 text-3xl font-extrabold"
                style={{ background: audienceGrade.color, color: audienceGrade.textColor }}
              >
                {audienceGrade.grade}
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-bold leading-tight break-words" style={{ color: audienceGrade.color }}>
                  {audienceGrade.label}
                </p>
                {audienceCount > 0 && (
                  <p className="text-xs text-gray-500 mt-0.5 leading-snug">
                    {audienceCount.toLocaleString('en-US')} audience reviews
                  </p>
                )}
              </div>
            </a>
          )}
        </div>
      )}

      {/* Mobile-only rank line — sits below the dual score cards and above the
          distribution bar. Desktop's rank line lives inline under "Based on N
          Critic Reviews" in the score block above. */}
      {hasEnoughCriticReviews && (
        <HeroRankLine ranks={ranks} market={show.category} className="lg:hidden -mt-1" />
      )}

      {/* Distribution bar — both modes; spans full width under the header. */}
      {hasEnoughCriticReviews && criticReviewsForBar.length > 0 && (
        <ScoreBreakdownBar reviews={criticReviewsForBar} category={show.category} />
      )}

      {/* Critics' Take — inline directly below the breakdown bar with NO
          card chrome. Per user feedback the rounded-card border made the
          area feel busy; the breakdown bar + take read better as one
          continuous block. */}
      {hasEnoughCriticReviews && consensusText && (
        <div className="mt-3">
          <p className="text-xs font-bold uppercase tracking-[0.12em] text-gray-500 mb-1.5">
            Critics&apos; Take
          </p>
          <p className="text-gray-300 text-sm leading-relaxed">{consensusText}</p>
        </div>
      )}

      {/* Action buttons row — Want to See / Rate it (icon stacked vertical) */}
      {userFeaturesEnabled && (
        <div className="grid grid-cols-2 gap-2.5">
          <button
            type="button"
            onClick={handleWantToSee}
            className={`flex flex-col sm:flex-row items-center justify-center gap-1.5 sm:gap-2 py-3 sm:py-2.5 px-2 rounded-card border transition-all ${
              onWatchlist
                ? 'bg-brand/10 border-brand text-brand'
                : 'bg-white/10 border-white/15 text-white hover:bg-white/15 hover:border-white/25'
            }`}
          >
            <svg className="w-5 h-5" fill={onWatchlist ? 'currentColor' : 'none'} viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
            </svg>
            <span className="text-xs sm:text-sm font-semibold">{onWatchlist ? 'On your list' : 'Want to See'}</span>
          </button>
          <button
            type="button"
            ref={rateBtnRef}
            onClick={handleRateIt}
            className="flex flex-col sm:flex-row items-center justify-center gap-1.5 sm:gap-2 py-3 sm:py-2.5 px-2 rounded-card border bg-white/10 border-white/15 text-white hover:bg-white/15 hover:border-white/25 transition-all"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.196-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" />
            </svg>
            <span className="text-xs sm:text-sm font-semibold">
              {!hasRating ? 'Rate it' : 'Log another viewing'}
            </span>
          </button>
        </div>
      )}

      {/* On-list caption — minor indicator (decision: show page stays simple, list mgmt in /my-shows) */}
      {userFeaturesEnabled && firstListContainingShow && (
        <p className="text-xs text-gray-500 flex items-center gap-1.5 -mt-2">
          <svg className="w-3 h-3 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 10h16M4 14h16M4 18h10" />
          </svg>
          <span className="truncate">
            Also on{' '}
            {listsWithShow.length === 1 ? (
              <Link
                href={`/my-shows?tab=lists&list=${firstListContainingShow.id}`}
                className="text-gray-400 hover:text-brand transition-colors border-b border-dotted border-white/10"
              >
                {firstListContainingShow.name}
              </Link>
            ) : (
              <Link
                href="/my-shows?tab=lists"
                className="text-gray-400 hover:text-brand transition-colors border-b border-dotted border-white/10"
              >
                {listsWithShow.length} of your lists
              </Link>
            )}
          </span>
        </p>
      )}

      {/* Your rating card — BELOW the action buttons, where the editor opens,
          so a fresh save doesn't "jump" above the button that created it
          (owner feedback 2026-07-13). Hidden while actively editing inline. */}
      {userFeaturesEnabled && hasRating && latestReview && !ratePanelOpen && (
        <YourRatingInline
          reviews={sortedReviews}
          userAvg={userAvg}
          onEditReview={(r) => { setEditingReview(r); setRatePanelOpen(true); }}
        />
      )}

      {/* Rating editor — bottom-sheet on mobile, inline card on desktop. Adjustable
          stars live inside; a failed save keeps the panel open with the note intact.
          suggestedDateSeen: watchlist planned-date prefills Date Seen for any
          non-edit save; a restored draft's own dateSeen (initialDateSeen) takes
          precedence inside the editor, so pendingDraft doesn't null it out. */}
      {userFeaturesEnabled && ratePanelOpen && (
        <RatingEditor
          key={editingReview?.id ?? pendingDraft?.reviewId ?? 'new-viewing'}
          showTitle={show.title}
          reviewId={editingReview?.id ?? pendingDraft?.reviewId}
          initialRating={editingReview?.rating ?? pendingDraft?.rating ?? 0}
          initialReviewText={editingReview?.review_text ?? pendingDraft?.reviewText ?? null}
          initialDateSeen={editingReview?.date_seen ?? pendingDraft?.dateSeen ?? null}
          suggestedDateSeen={editingReview ? null : watchlistDate}
          mode={editingReview || pendingDraft?.reviewId ? 'edit' : hasRating ? 'append' : 'new'}
          onSave={handleSaveReview}
          onSaved={handleRateSaved}
          onCancel={handleCancelRate}
          onDelete={editingReview ? handleDeleteRating : undefined}
        />
      )}

      {/* Tickets — primary CTA + lottery/rush pill (desktop only).
          Mobile hides the Lottery/Rush pill via `hidden lg:inline-flex` —
          on mobile it pushed content too far down. Desktop keeps it next
          to the Get Tickets CTA where there's horizontal room. Full info
          for both viewports lives in the Discount Tickets card below. */}
      {!isClosed && sortedTicketLinks.length > 0 && (
        <TicketButtonsAB
          showName={show.title}
          showId={show.id}
          showSlug={show.slug}
          showStatus={show.status}
          showCategory={show.category}
          showScore={score}
          ticketLinks={sortedTicketLinks}
          officialUrl={show.officialUrl}
          pageType="show"
          splitVariant
          primaryButtonClassName="w-full lg:w-auto lg:self-start inline-flex items-center justify-center gap-1.5 h-10 px-5 rounded-lg bg-gradient-brand text-white font-bold text-sm leading-none hover:shadow-glow-sm hover:scale-[1.01] active:scale-[0.99] transition-all whitespace-nowrap"
          secondaryAfter={
            featureFlags.discountTickets && lotteryRush ? (
              <a
                href="#discount-tickets"
                className="hidden lg:inline-flex items-center gap-1.5 h-10 px-5 rounded-lg bg-surface-overlay hover:bg-white/10 text-gray-500 hover:text-gray-300 text-sm font-medium leading-none transition-colors border border-white/5 whitespace-nowrap flex-shrink-0"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 5v2m0 4v2m0 4v2M5 5a2 2 0 00-2 2v3a2 2 0 110 4v3a2 2 0 002 2h14a2 2 0 002-2v-3a2 2 0 110-4V7a2 2 0 00-2-2H5z" />
                </svg>
                {lotteryRush.lottery
                  ? lotteryRush.lottery.price
                    ? `${getCurrencySymbol(show.category)}${lotteryRush.lottery.price} Lottery`
                    : 'Lottery'
                  : lotteryRush.rush
                    ? lotteryRush.rush.price
                      ? `${getCurrencySymbol(show.category)}${lotteryRush.rush.price} Rush`
                      : 'Rush'
                    : 'Discount'}
              </a>
            ) : null
          }
        />
      )}
    </div>
  );
}

// ─── Sub-components ──────────────────────────────────────────────────────

function DateLine({ show }: { show: ComputedShow }) {
  // One hierarchy step below the venue line (text-sm gray-300) so the two
  // stacked rows read as place → metadata instead of two identical gray lines.
  const dateClass = 'text-xs text-gray-500';
  if (show.status === 'closed' && show.openingDate && show.closingDate) {
    return (
      <p className={dateClass}>
        {formatDate(show.openingDate)} → {formatDate(show.closingDate)}
      </p>
    );
  }
  if (show.status === 'previews' || show.status === 'upcoming') {
    if (show.openingDate) {
      return <p className={dateClass}>Opens {formatDate(show.openingDate)}</p>;
    }
    return null;
  }
  // open
  return (
    <p className={dateClass}>
      {show.openingDate && <>Opened {formatDate(show.openingDate)}</>}
      {show.closingDate && <> · Closes {formatDate(show.closingDate)}</>}
    </p>
  );
}

function AwaitingCard({ show, reviewCount }: { show: ComputedShow; reviewCount: number }) {
  return (
    <div className="card p-4 text-center bg-surface-overlay border-white/5">
      <p className="text-sm font-semibold text-gray-300 mb-0.5">Awaiting reviews</p>
      <p className="text-xs text-gray-500">
        {show.status === 'previews' ? 'Show in previews' : show.status === 'upcoming' ? 'Show opens soon' : 'Not enough reviews yet'}
        {reviewCount > 0 ? ` · ${reviewCount} ${reviewCount === 1 ? 'review' : 'reviews'} collected` : null}
      </p>
    </div>
  );
}

function YourRatingInline({
  reviews,
  userAvg,
  onEditReview,
}: {
  reviews: UserReview[];
  userAvg: number;
  onEditReview: (review: UserReview) => void;
}) {
  const isMulti = reviews.length > 1;
  return (
    <div className="card p-4 space-y-2.5">
      {reviews.map((review, i) => (
        <div key={review.id} className={i > 0 ? 'pt-2.5 border-t border-white/5 space-y-1' : 'space-y-1'}>
          <div className="flex items-center gap-3 min-w-0">
            <div className="flex-shrink-0">
              <StarRating rating={review.rating} onRatingChange={() => {}} size="sm" readOnly hideLabel />
            </div>
            <div className="flex items-baseline gap-1.5 min-w-0 flex-1 text-xs">
              <span className="font-bold text-gray-200 whitespace-nowrap">
                {!isMulti ? 'Your rating' : i === 0 ? 'Latest viewing' : 'Earlier viewing'}
              </span>
              {review.date_seen && (
                <span className="text-gray-500 whitespace-nowrap">· {formatDate(review.date_seen)}</span>
              )}
            </div>
            <button
              type="button"
              onClick={() => onEditReview(review)}
              className="flex-shrink-0 w-7 h-7 rounded-full bg-surface-overlay border border-white/10 text-gray-300 hover:text-white hover:border-white/20 transition-colors flex items-center justify-center"
              aria-label={i === 0 ? 'Edit rating' : 'Edit this viewing'}
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
              </svg>
            </button>
          </div>
          {review.review_text && (
            <p className="text-sm text-gray-400 italic leading-snug line-clamp-4">
              {`\u201C${review.review_text}\u201D`}
            </p>
          )}
        </div>
      ))}
      {isMulti && (
        <div className="pt-2 border-t border-white/5 text-xs text-gray-500 text-right">
          avg {formatStars(userAvg)}
        </div>
      )}
    </div>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────

/** Format ISO date as "Apr 10, 2026" — matches existing /show convention. */
function formatDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso + (iso.length === 10 ? 'T00:00:00' : ''));
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/** Render avg rating as Unicode stars, e.g. 4.5 → "★★★★½". */
function formatStars(avg: number): string {
  const full = Math.floor(avg);
  const half = avg - full >= 0.5;
  return '★'.repeat(full) + (half ? '½' : '');
}
