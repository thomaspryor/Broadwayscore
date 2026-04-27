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
 *  • "Rate it again" with 1 rating → opens edit panel pre-filled (replaces existing).
 *  • "Log another viewing" with 2+ ratings → opens fresh panel (appends).
 *  • Date format: `Apr 10, 2026` always (matches existing /show convention).
 *  • Multi-viewing card shows latest highlighted + "All N ratings →" footer link.
 *  • No inline trash on the rating card — delete moves into the edit panel.
 *  • Closed shows: rating card renders if rated; tickets CTA + secondary row hidden;
 *    "Want to See" still functions ("wished I'd seen" semantics).
 *  • Watchlist + rating are independent — Want to See persists after rating.
 *  • <3 reviews → "Awaiting reviews" replaces score row + bar + Critics' Take.
 *
 * Deferred-auth flow mirrors ShowPageRatingConnected: pending action saved before
 * showSignIn(); resumed when user lands back on this page authenticated.
 */

import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
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
import ReviewPanel from '@/components/user/ReviewPanel';
import ShowImage from '@/components/ShowImage';
import ShowPageBookmark from '@/components/user/ShowPageBookmark';
import TicketButtonsAB from '@/components/TicketButtonsAB';
import { useAuth } from '@/contexts/AuthContext';
import { useUserReviews } from '@/hooks/useUserReviews';
import { useWatchlist } from '@/hooks/useWatchlist';
import { useUserLists } from '@/hooks/useUserLists';
import { useToastSafe } from '@/components/ui/Toast';
import { savePendingAction, getPendingAction, clearPendingAction } from '@/lib/deferred-auth';
import { supabaseRestInsert, supabaseRestUpdate } from '@/lib/supabase-rest';
import { featureFlags } from '@/config/feature-flags';
import { getOptimizedImageUrl } from '@/lib/images';
import { getCurrencySymbol } from '@/lib/market-utils';
import type { ComputedShow } from '@/lib/engine';

/** Inlined to avoid pulling @/lib/data-core (server-only JSON imports) into the
 *  client bundle. Matches the data-core slugify exactly. */
function slugify(str: string): string {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
import type { AudienceGrade } from '@/components/show-cards';
import type { TicketLinkData } from '@/lib/ticket-utils';
import type { UserReview } from '@/types/user';

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
}: ShowHeroRedesignProps) {
  const { user, isAuthenticated, loading: authLoading, showSignIn } = useAuth();
  const { reviews, getReviewsForShow, deleteReview } = useUserReviews(user?.id || null);
  const { isWatchlisted, addToWatchlist, removeFromWatchlist, getWatchlist, watchlist } = useWatchlist(user?.id || null);
  const { lists, getLists } = useUserLists(user?.id || null);
  const { showToast } = useToastSafe();
  const searchParams = useSearchParams();

  const [ratePanelOpen, setRatePanelOpen] = useState(false);
  const [editingReview, setEditingReview] = useState<UserReview | null>(null);
  const [pendingRatingFromAuth, setPendingRatingFromAuth] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const hasExecutedPending = useRef(false);

  // ?rate=1 / ?stars=N / ?edit=1 deep-link helpers (kept compatible with /my-shows entry points)
  const [autoRate] = useState(() => searchParams.get('rate') === '1');
  const autoRateStars = searchParams.get('stars') ? parseFloat(searchParams.get('stars')!) : null;
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

  // Consume pending action after deferred auth
  useEffect(() => {
    if (!isAuthenticated || !user || hasExecutedPending.current) return;
    const pending = getPendingAction();
    if (!pending || pending.showId !== show.id) return;
    hasExecutedPending.current = true;
    clearPendingAction();

    if (pending.type === 'rating') {
      setEditingReview(null);
      setPendingRatingFromAuth(pending.rating ?? null);
      setRatePanelOpen(true);
    } else if (pending.type === 'watchlist') {
      addToWatchlist(show.id)
        .then(() => showToast?.(<>Added to <a href="/my-shows?tab=watchlist" className="underline hover:text-white/90">Watchlist</a></>, 'success'))
        .catch(() => showToast?.('Failed to add to watchlist.', 'error'));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated, user, show.id]);

  // ?rate=1 — auto-open rate panel (deferred-auth target for inline-stars CTAs)
  useEffect(() => {
    if (!autoRate || ratePanelOpen) return;
    if (!isAuthenticated && !authLoading) {
      savePendingAction({
        type: 'rating',
        showId: show.id,
        ...(autoRateStars != null ? { rating: autoRateStars } : {}),
        returnUrl: window.location.pathname,
        timestamp: Date.now(),
      });
      showSignIn('rating');
    } else {
      // Open with latest review pre-filled (edit) if rated, else fresh panel with stars hint
      setEditingReview(latestReview);
      setPendingRatingFromAuth(latestReview ? null : autoRateStars);
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
    if (!isAuthenticated && !authLoading) {
      savePendingAction({
        type: 'rating',
        showId: show.id,
        returnUrl: window.location.pathname,
        timestamp: Date.now(),
      });
      showSignIn('rating');
      return;
    }
    if (isMulti) {
      // 2+ existing ratings → "Log another viewing": fresh panel, appends new entry.
      setEditingReview(null);
    } else if (hasRating) {
      // Exactly 1 rating → "Rate it again": opens with latest pre-filled, replaces.
      setEditingReview(latestReview);
    } else {
      // First rating → fresh panel.
      setEditingReview(null);
    }
    setPendingRatingFromAuth(null);
    setRatePanelOpen(true);
  }, [isAuthenticated, authLoading, show.id, hasRating, isMulti, latestReview, showSignIn]);

  const handleEditLatest = useCallback(() => {
    if (!latestReview) return;
    setEditingReview(latestReview);
    setRatePanelOpen(true);
  }, [latestReview]);

  const handleSaveReview = useCallback(async (data: { rating: number; reviewText: string | null; dateSeen: string | null }) => {
    if (!user) {
      showToast?.('Please sign in to save ratings.', 'error');
      return;
    }
    setSaving(true);
    try {
      if (editingReview) {
        const filters = `id=eq.${editingReview.id}&user_id=eq.${user.id}`;
        const { error } = await supabaseRestUpdate('reviews', filters, {
          rating: data.rating,
          review_text: data.reviewText || null,
          date_seen: data.dateSeen || null,
          updated_at: new Date().toISOString(),
        });
        if (error) throw new Error(error.message);
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
        showToast?.(<>Added to <a href="/my-shows" className="underline hover:text-white/90">My Ratings &amp; Reviews</a></>, 'success');
      }
      await getReviewsForShow(show.id);
    } catch (e) {
      const detail = e instanceof Error ? e.message : 'Unknown error';
      showToast?.(`Save failed: ${detail}`, 'error');
    } finally {
      setSaving(false);
      setRatePanelOpen(false);
      setEditingReview(null);
      setPendingRatingFromAuth(null);
    }
  }, [user, editingReview, show.id, getReviewsForShow, showToast]);

  const handleCancelRate = useCallback(() => {
    setRatePanelOpen(false);
    setEditingReview(null);
    setPendingRatingFromAuth(null);
  }, []);

  const handleDeleteRating = useCallback(async () => {
    if (!editingReview) return;
    try {
      await deleteReview(editingReview.id);
      showToast?.('Rating deleted.', 'info');
      await getReviewsForShow(show.id);
    } catch (e) {
      const detail = e instanceof Error ? e.message : 'Unknown error';
      showToast?.(`Delete failed: ${detail}`, 'error');
    } finally {
      setRatePanelOpen(false);
      setEditingReview(null);
    }
  }, [editingReview, deleteReview, getReviewsForShow, show.id, showToast]);

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
          <div className="relative aspect-[2/3] rounded-xl overflow-visible shadow-2xl border border-white/10 bg-surface-raised">
            {userFeaturesEnabled && <ShowPageBookmark showId={show.id} size="compact" />}
            <div className="absolute inset-0 rounded-xl overflow-hidden">
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
            <CategoryBadge category={show.category} />
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
                <p className="text-sm font-bold leading-tight" style={{ color: tier.color }}>
                  {tier.label}
                </p>
              )}
              <p className="text-[11px] text-gray-500 mt-0.5 leading-snug">
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
                <p className="text-sm font-bold leading-tight" style={{ color: audienceGrade.color }}>
                  {audienceGrade.label}
                </p>
                {audienceCount > 0 && (
                  <p className="text-[11px] text-gray-500 mt-0.5 leading-snug">
                    {audienceCount.toLocaleString('en-US')} audience reviews
                  </p>
                )}
              </div>
            </a>
          )}
        </div>
      )}

      {/* Distribution bar — both modes; spans full width under the header. */}
      {hasEnoughCriticReviews && criticReviewsForBar.length > 0 && (
        <ScoreBreakdownBar reviews={criticReviewsForBar} category={show.category} />
      )}

      {/* Critics' Take — inlined; CriticsTakeCard component lives only on the v1
          redesign branch and isn't merged to main. Styling matches the existing
          consensus block on the desktop side of this same page. */}
      {hasEnoughCriticReviews && consensusText && (
        <div className="card p-4">
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">
            Critics&apos; Take
          </p>
          <p className="text-gray-300 text-sm leading-relaxed">{consensusText}</p>
        </div>
      )}

      {/* Your rating card (rated state, render only when not actively editing inline) */}
      {userFeaturesEnabled && hasRating && latestReview && !ratePanelOpen && (
        <YourRatingInline
          latestReview={latestReview}
          isMulti={isMulti}
          totalRatings={ratingCount}
          userAvg={userAvg}
          onEdit={handleEditLatest}
        />
      )}

      {/* Action buttons row — Want to See / Rate it (icon stacked vertical) */}
      {userFeaturesEnabled && (
        <div className="grid grid-cols-2 gap-2.5">
          <button
            type="button"
            onClick={handleWantToSee}
            className={`flex flex-col items-center gap-1.5 py-3 px-2 rounded-card border transition-all ${
              onWatchlist
                ? 'bg-surface-raised border-brand text-brand'
                : 'bg-surface-raised border-white/10 text-gray-300 hover:text-white hover:border-white/20'
            }`}
          >
            <svg className="w-5 h-5" fill={onWatchlist ? 'currentColor' : 'none'} viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
            </svg>
            <span className="text-xs font-semibold">{onWatchlist ? 'On your list' : 'Want to See'}</span>
          </button>
          <button
            type="button"
            onClick={handleRateIt}
            className="flex flex-col items-center gap-1.5 py-3 px-2 rounded-card border bg-surface-raised border-white/10 text-gray-300 hover:text-white hover:border-white/20 transition-all"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.196-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" />
            </svg>
            <span className="text-xs font-semibold">
              {!hasRating ? 'Rate it' : isMulti ? 'Log another viewing' : 'Rate it again'}
            </span>
          </button>
        </div>
      )}

      {/* On-list caption — minor indicator (decision: show page stays simple, list mgmt in /my-shows) */}
      {userFeaturesEnabled && firstListContainingShow && (
        <p className="text-[11px] text-gray-500 flex items-center gap-1.5 -mt-2">
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

      {/* Inline rate panel (web behavior) — delete-rating button rendered as a separate
          row when editing an existing review (ReviewPanel itself has no delete slot) */}
      {userFeaturesEnabled && ratePanelOpen && (
        <div className="space-y-2">
          <ReviewPanel
            rating={editingReview?.rating ?? pendingRatingFromAuth ?? 5}
            existingReviewText={editingReview?.review_text}
            existingDateSeen={editingReview?.date_seen ?? (editingReview ? undefined : watchlistDate)}
            showTitle={show.title}
            latestDate={show.closingDate}
            onSave={handleSaveReview}
            onCancel={handleCancelRate}
            saving={saving}
          />
          {editingReview && (
            <div className="flex justify-end">
              <button
                type="button"
                onClick={handleDeleteRating}
                className="text-[11px] text-gray-500 hover:text-score-skip transition-colors px-2 py-1"
              >
                Delete this rating
              </button>
            </div>
          )}
        </div>
      )}

      {/* Tickets — split-variant: primary CTA + secondary pills row.
          Lottery/Rush pill rides the same scroll row via secondaryAfter so the
          three secondary pills always sit on a single line (scrolls if too wide).
          Primary CTA is full-width on mobile (standard CTA pattern), inline auto
          width at lg+ (desktop has horizontal room — full-width feels too wide). */}
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
          primaryButtonClassName="w-full lg:w-auto lg:self-start inline-flex items-center justify-center gap-1.5 py-2.5 lg:py-1.5 px-5 lg:px-3 rounded-lg bg-gradient-brand text-white font-bold text-sm lg:text-xs leading-none hover:shadow-glow-sm hover:scale-[1.01] active:scale-[0.99] transition-all whitespace-nowrap"
          secondaryAfter={
            featureFlags.discountTickets && lotteryRush ? (
              <a
                href="#discount-tickets"
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-surface-overlay hover:bg-white/10 text-gray-500 hover:text-gray-300 text-xs leading-none font-medium transition-colors border border-white/5 whitespace-nowrap flex-shrink-0"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
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
  if (show.status === 'closed' && show.openingDate && show.closingDate) {
    return (
      <p>
        {formatDate(show.openingDate)} → {formatDate(show.closingDate)}
      </p>
    );
  }
  if (show.status === 'previews' || show.status === 'upcoming') {
    if (show.openingDate) {
      return <p>Opens {formatDate(show.openingDate)}</p>;
    }
    return null;
  }
  // open
  return (
    <p>
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
  latestReview,
  isMulti,
  totalRatings,
  userAvg,
  onEdit,
}: {
  latestReview: UserReview;
  isMulti: boolean;
  totalRatings: number;
  userAvg: number;
  onEdit: () => void;
}) {
  return (
    <div className="card p-4 space-y-1.5">
      <div className="flex items-center gap-3 min-w-0">
        <div className="flex-shrink-0">
          <StarRating rating={latestReview.rating} onRatingChange={() => {}} size="sm" readOnly hideLabel />
        </div>
        <div className="flex items-baseline gap-1.5 min-w-0 flex-1 text-xs">
          <span className="font-bold text-gray-200 whitespace-nowrap">
            {isMulti ? 'Latest viewing' : 'Your rating'}
          </span>
          {latestReview.date_seen && (
            <span className="text-gray-500 whitespace-nowrap">· {formatDate(latestReview.date_seen)}</span>
          )}
        </div>
        <button
          type="button"
          onClick={onEdit}
          className="flex-shrink-0 w-7 h-7 rounded-full bg-surface-overlay border border-white/10 text-gray-300 hover:text-white hover:border-white/20 transition-colors flex items-center justify-center"
          aria-label="Edit rating"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
          </svg>
        </button>
      </div>
      {latestReview.review_text && (
        <p className="text-sm text-gray-400 italic leading-snug line-clamp-3">
          {`“${latestReview.review_text}”`}
        </p>
      )}
      {isMulti && (
        <div className="pt-2 mt-1 border-t border-white/5 text-[11px] text-gray-500 flex items-center justify-between">
          <Link href="/my-shows" className="text-gray-400 hover:text-brand transition-colors">
            All {totalRatings} ratings →
          </Link>
          <span>avg {formatStars(userAvg)}</span>
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
