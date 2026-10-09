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

import React, { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { trackUgc } from '@/lib/ugc-analytics';
import { isLiveTour } from '@/lib/tour-listing';
import {
  ScoreBadge,
  ScoreBreakdownBar,
  FormatPill,
  ProductionPill,
  StatusBadge,
  CategoryBadge,
  getScoreTier,
} from '@/components/show-cards';
import MiniStars from '@/components/user/Stars';
import WatchlistPlanCard, { PlanRow, DateTile } from '@/components/user/WatchlistPlanCard';
import { buildPlannedShowEvent } from '@/lib/calendar-event';
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
import { useLocalWatchlist } from '@/hooks/useLocalWatchlist';
import { removeLocalShow } from '@/lib/local-watchlist';
import { getWatchlistCtaLabel } from '@/lib/watchlist-cta-label';
import { usePendingRatingDraft } from '@/hooks/usePendingRatingDraft';
import { invalidateRatingsCache } from '@/hooks/useMyRating';
import { supabaseRestInsert, supabaseRestUpdate } from '@/lib/supabase-rest';
import { featureFlags } from '@/config/feature-flags';
import { getOptimizedImageUrl } from '@/lib/images';
import { getCurrencySymbol } from '@/lib/market-utils';
import { isOperaShow } from '@/lib/show-market';
import { getBroadwayDuration } from '@/lib/date-utils';
import { getShowDateLineSegments, getHeroDurationSuffix, formatShowDate as formatDate } from '@/lib/show-date-line';
import type { ComputedShowWithReviews, ComputedReview } from '@/lib/engine';

// The same slugify @/lib/data-core re-exports, imported from its pure home so
// this client bundle never pulls data-core's server-only JSON imports (and
// can never drift from the theater page's own slug — S7-T3 added the
// diacritic fold in one place for both).
import { slugify } from '../../../scripts/lib/url-slug';
import type { AudienceGrade } from '@/components/show-cards';
import type { TicketLinkData } from '@/lib/ticket-utils';
import { getTicketCtaNote } from '@/lib/ticket-cta-note';
import type { UserReview, PendingAction } from '@/types/user';
import type { ShowRanks } from '@/lib/data-show-ranks';
import HeroRankLine from '@/components/show-page/HeroRankLine';
import LimitedRunBadge from '@/components/show-page/LimitedRunBadge';
import ShowPageAddToListButton from '@/components/user/ShowPageAddToListButton';

// ─── Props ───────────────────────────────────────────────────────────────

interface ShowHeroRedesignProps {
  // Narrowed to only the field ScoreBreakdownBar reads (reviewScore) — the full
  // ComputedReview objects (criticName/outlet/url/quote/summary/...) tripled the
  // size of this show's own review array in the RSC payload once counted across
  // this boundary + ShowPageBelowFoldLoader + ReviewsList. Card #962.
  show: ComputedShowWithReviews<Pick<ComputedReview, 'reviewScore'>>;
  consensusText: string | null;
  audienceGrade: AudienceGrade | null;
  audienceCount: number;
  hasAudience: boolean;
  hasEnoughCriticReviews: boolean;
  sortedTicketLinks: TicketLinkData[];
  lotteryRush: { lottery?: { price?: number | null } | null; rush?: { price?: number | null } | null } | null;
  isWestEnd: boolean;
  isOffBroadway: boolean;
  /** Slug of the off-Broadway venue page for this show's venue; null when the venue string
   *  didn't resolve to a page (render plain text rather than a dead link). */
  offBroadwayVenueSlug?: string | null;
  /** Reviews still needed for a CriticScore; 0 when the gate isn't review count. */
  reviewsRemaining?: number;
  /** Which Critics' Take fallback to show when there's no consensus (see getCriticsTakeDisplayMode). */
  criticsTakeMode?: 'consensus' | 'coming-soon' | 'synopsis' | 'none';
  /** Precomputed cross-show ranks for the hero rank line. Null = feature-gated off
   *  OR no rankable data. */
  ranks: ShowRanks | null;
  /** "2024–2025" for a national tour whose own dates are unknown; the date line
   *  shows "reviewed <years>" instead. Computed server-side because this
   *  component's reviews are narrowed to reviewScore (no publishDate). */
  tourReviewYears?: string | null;
  /** "Most reviews from N years ago" caveat (getReviewAgeNote), null when it
   *  doesn't apply. Computed server-side for the same reason as tourReviewYears,
   *  and shared with the legacy hero so both show it for the same shows. */
  reviewAgeNote?: string | null;
  /** Server-rendered ShowTrustLines (tour parent, tryout transfer, tour stops),
   *  shared with the legacy header so the redesign keeps those links. */
  trustLines?: React.ReactNode;
}

// The hero is server-rendered: it carries the page's <h1>, score and verdict.
// Don't add useSearchParams here: on a static export it bails the whole
// subtree out to client-side rendering, so the prerendered HTML (what search
// engines and link previews read) shipped with no title or score (BRO-4597).
// Deep-link params are read after mount instead (readDeepLink below).

export default function ShowHeroRedesign(props: ShowHeroRedesignProps) {
  return <Inner {...props} />;
}

type DeepLink = { rate: boolean; stars: number | null; edit: boolean };

function readDeepLink(search: string): DeepLink {
  const params = new URLSearchParams(search);
  const raw = params.get('stars') ? parseFloat(params.get('stars')!) : null;
  // Untrusted input: ?stars=abc → NaN, ?stars=99 → out of range. Drop invalid values.
  const stars = raw !== null && Number.isFinite(raw) && raw >= 0.5 && raw <= 5 ? raw : null;
  return { rate: params.get('rate') === '1', stars, edit: params.get('edit') === '1' };
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
  offBroadwayVenueSlug,
  reviewsRemaining = 0,
  criticsTakeMode = 'none',
  ranks,
  tourReviewYears,
  reviewAgeNote,
  trustLines,
}: ShowHeroRedesignProps) {
  const { user, isAuthenticated, loading: authLoading, showSignIn } = useAuth();
  const { reviews, getReviewsForShow, deleteReview } = useUserReviews(user?.id || null);
  const { isWatchlisted, addToWatchlist, removeFromWatchlist, getWatchlist, updatePlannedDate, updatePerformance, watchlist } = useWatchlist(user?.id || null);
  const { lists, getLists } = useUserLists(user?.id || null);
  const { showToast } = useToastSafe();

  const [ratePanelOpen, setRatePanelOpen] = useState(false);
  const [editingReview, setEditingReview] = useState<UserReview | null>(null);
  const rateBtnRef = useRef<HTMLButtonElement>(null);
  // Return focus to the rate button when the editor closes — the inline
  // (desktop) editor is not a Modal, so nothing else restores focus and it
  // falls to <body>, stranding keyboard/screen-reader users (audit P2).
  const refocusRateBtn = () => requestAnimationFrame(() => rateBtnRef.current?.focus());

  // ?rate=1 / ?stars=N / ?edit=1 deep-link helpers (kept compatible with /my-shows entry points).
  // Read once after mount so the prerendered HTML stays server-rendered.
  const [deepLink, setDeepLink] = useState<DeepLink>({ rate: false, stars: null, edit: false });
  useEffect(() => { setDeepLink(readDeepLink(window.location.search)); }, []);
  const autoRate = deepLink.rate;
  const autoRateStars = deepLink.stars;
  const autoEditLatest = deepLink.edit;

  // ─── Derived state ─────────────────────────────────────────────────────

  const showReviews = reviews.filter(r => r.show_id === show.id);
  const sortedReviews = [...showReviews].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  );
  const latestReview = sortedReviews[0] ?? null;
  const ratingCount = showReviews.length;
  const hasRating = ratingCount > 0;
  const isMulti = ratingCount > 1;
  const { isSavedLocally, toggleLocal } = useLocalWatchlist();
  // Signed out, "Want to See" saves on this device (BRO-4616).
  const onWatchlist = isAuthenticated ? isWatchlisted(show.id) : isSavedLocally(show.id);
  const watchlistEntry = watchlist.find(w => w.show_id === show.id);
  const watchlistDate = watchlistEntry?.planned_date || null;
  const plannedShowEvent = watchlistEntry ? buildPlannedShowEvent(show, watchlistEntry) : null;

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

  // Mobile score cards. Two side by side leave ~50px for the text next to the
  // badge on a phone, so "Recommended" ran past the card border (BRO-4525).
  // Below sm the pair stacks badge over text; one card or sm+ stays a row.
  const dualScoreCards = !!(hasAudience && audienceGrade);
  const scoreCardLayout = dualScoreCards
    ? 'flex-col items-center text-center gap-2 sm:flex-row sm:text-left sm:gap-3'
    : 'items-center gap-3';
  const scoreCardTextClass = dualScoreCards ? 'min-w-0 w-full sm:w-auto sm:flex-1' : 'min-w-0 flex-1';

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
    // The pending-action effect above runs first (the deep link is read after
    // mount, so this runs a commit later) and sets this ref when it consumed a
    // draft for this show — without this guard, a stale ratePanelOpen=false read here would let us clobber
    // the just-restored draft (typed note included) with a bare stars hint.
    if (hasExecutedPending.current) return;
    if (!isAuthenticated && !authLoading) {
      saveDraft(autoRateStars != null ? { rating: autoRateStars } : {});
      showSignIn('rating', 'show_rate_link');
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
    if (authLoading) return;
    // Signed out: save on this device now, offer sign-in after (BRO-4616).
    if (!isAuthenticated) {
      toggleLocal(show.id, 'show_want_to_see');
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
  }, [isAuthenticated, authLoading, onWatchlist, show.id, addToWatchlist, removeFromWatchlist, toggleLocal, showToast]);

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
        throw new Error('Still restoring your session. Tap Retry in a moment.');
      }
      // Gate at Save — persist the full draft, then sign in. The editor stays
      // open behind the sign-in modal ('auth-gated'), so cancelling sign-in
      // loses nothing; completing it lets the pending-action effect resume.
      saveDraft(data);
      showSignIn('rating', 'show_rating_save');
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
      if (!updated) throw new Error('This rating no longer exists. It may have been deleted elsewhere.');
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
      // Watchlist = shows you WANT to see. Rating a show means you've seen it,
      // so drop any watchlist entry (owner rule 2026-07-12 — replaces the old
      // "watchlist and rating are independent" decision). Non-fatal: the rating
      // itself already saved.
      // Unconditional: isWatchlisted reads this instance's async-loaded state and
      // can be stale on fast deep-link saves; deleting a non-existent row is a
      // harmless no-op ('rated' keeps it out of the watchlist_remove count).
      removeLocalShow(show.id);
      try { await removeFromWatchlist(show.id, 'rated'); } catch { /* rating saved; watchlist cleanup is best-effort */ }
    }
    await getReviewsForShow(show.id);
    invalidateRatingsCache();
  }, [user, authLoading, show.id, getReviewsForShow, showToast, showSignIn, removeFromWatchlist, saveDraft]);

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
      trackUgc('rating_deleted', { show_id: show.id, source: 'show_page' });
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
    // Off-Broadway links only when the venue resolved to a page (freeform venue strings).
    // Regional and tour venues have no /theater page ("North American Tour" is not a house).
    : isOffBroadway
      ? (offBroadwayVenueSlug ? `/off-broadway/theater/${offBroadwayVenueSlug}` : null)
      : show.category === 'regional' || show.category === 'tour'
        ? null
        : `/theater/${slugify(show.venue)}`;

  // Market + format in the poster alt text (image search / a11y), as the legacy header had.
  const posterMarketLabel = isOperaShow(show) ? 'Met Opera'
    : isWestEnd ? 'West End'
    : isOffBroadway ? 'Off-Broadway'
    : show.category === 'regional' ? 'Regional'
    : show.category === 'tour' ? 'National Tour'
    : 'Broadway';

  // Lottery/Rush pill linking to the Discount Tickets card. `display` picks the
  // breakpoint behavior: hidden below lg next to the Get Tickets CTA, always
  // shown when it's the only ticket element.
  const lotteryPill = (display: string) => {
    if (!(featureFlags.discountTickets && lotteryRush)) return null;
    const symbol = getCurrencySymbol(show.category, show.venue);
    const label = lotteryRush.lottery
      ? lotteryRush.lottery.price ? `${symbol}${lotteryRush.lottery.price} Lottery` : 'Lottery'
      : lotteryRush.rush
        ? lotteryRush.rush.price ? `${symbol}${lotteryRush.rush.price} Rush` : 'Rush'
        : 'Discount';
    return (
      <a
        href="#discount-tickets"
        className={`${display} items-center gap-1.5 h-10 px-5 rounded-lg bg-surface-overlay hover:bg-white/10 text-gray-500 hover:text-gray-300 text-sm font-medium leading-none transition-colors border border-white/5 whitespace-nowrap flex-shrink-0`}
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 5v2m0 4v2m0 4v2M5 5a2 2 0 00-2 2v3a2 2 0 110 4v3a2 2 0 002 2h14a2 2 0 002-2v-3a2 2 0 110-4V7a2 2 0 00-2-2H5z" />
        </svg>
        {label}
      </a>
    );
  };

  // Hide rating section + watchlist controls if the userAccounts flag is turned off.
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
                alt={`${show.title} ${posterMarketLabel} ${show.type} poster`}
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
            {show.limitedRun && <LimitedRunBadge />}
            <CategoryBadge category={show.category} isOpera={isOperaShow(show)} />
            <StatusBadge status={show.status} />
          </div>
          <h1 className="text-2xl lg:text-4xl font-extrabold tracking-tight leading-tight text-white">
            {show.title}
            {/* A tour shares its Broadway parent's title and poster; say which one
                this is, inside the H1 so the heading reads "<show> National Tour". */}
            {show.category === 'tour' && (
              <span className="block mt-1 text-sm lg:text-base font-semibold tracking-normal text-sky-300" data-testid="tour-subtitle">National Tour</span>
            )}
          </h1>
          <div className="text-sm text-gray-400 space-y-0.5 pt-0.5" data-testid="show-meta-line">
            <p>
              {venueLink ? (
                <Link href={venueLink} className="text-gray-300 underline underline-offset-2 decoration-white/10 hover:text-brand transition-colors">
                  {show.venue}
                </Link>
              ) : (
                <span className="text-gray-300">{show.venue}</span>
              )}
              {/* nowrap keeps "2h 45m" from splitting across lines at 390px
                  (same pattern as the legacy show-meta-line). */}
              {show.runtime ? <span className="whitespace-nowrap"> · {show.runtime}</span> : null}
            </p>
            <DateLine show={show} tourReviewYears={tourReviewYears ?? null} />
          </div>
          {trustLines ? <div className="pt-1" data-testid="hero-trust-lines">{trustLines}</div> : null}

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
                  {reviewAgeNote && (
                    <p className="text-xs text-gray-500 mt-1 leading-snug" data-testid="hero-review-age-note">
                      {reviewAgeNote}
                    </p>
                  )}
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
        <AwaitingCard show={show} reviewCount={reviewCount} reviewsRemaining={reviewsRemaining} />
      ) : (
        <div className={`lg:hidden grid gap-2.5 ${dualScoreCards ? 'grid-cols-2' : 'grid-cols-1'}`}>
          <a href="#critic-reviews" className={`card p-3 sm:p-4 flex ${scoreCardLayout} hover:bg-surface-overlay transition-colors`}>
            <ScoreBadge score={score} reviewCount={reviewCount} category={show.category} size="lg" showCrown />
            <div className={scoreCardTextClass}>
              {tier && (
                <p className="text-xs sm:text-sm font-bold leading-tight break-normal" style={{ color: tier.color }}>
                  {tier.label}
                </p>
              )}
              <p className="text-xs text-gray-500 mt-0.5 leading-snug">
                {reviewCount} critic {reviewCount === 1 ? 'review' : 'reviews'}
              </p>
            </div>
          </a>
          {dualScoreCards && (
            <a href="#audience" className={`card p-3 sm:p-4 flex ${scoreCardLayout} hover:bg-surface-overlay transition-colors`}>
              <div
                className="w-16 h-16 sm:w-20 sm:h-20 rounded-xl flex items-center justify-center flex-shrink-0 text-3xl font-extrabold"
                style={{ background: audienceGrade.color, color: audienceGrade.textColor }}
              >
                {audienceGrade.grade}
              </div>
              <div className={scoreCardTextClass}>
                <p className="text-xs sm:text-sm font-bold leading-tight break-normal" style={{ color: audienceGrade.color }}>
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

      {/* Mobile-only review-age caveat for long-running shows (desktop renders
          it inline in the score block above). */}
      {hasEnoughCriticReviews && reviewAgeNote && (
        <p className="lg:hidden -mt-1 text-xs text-gray-500 leading-snug" data-testid="hero-review-age-note-mobile">
          {reviewAgeNote}
        </p>
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
      {/* No consensus yet: say so once enough reviews exist, or show the synopsis
          for an unopened show (never unrelated copy in the verdict slot, BRO-927). */}
      {!(hasEnoughCriticReviews && consensusText) && criticsTakeMode === 'coming-soon' && (
        <p className="mt-3 text-gray-500 text-sm leading-relaxed italic">Critics&apos; Take coming soon.</p>
      )}
      {!(hasEnoughCriticReviews && consensusText) && criticsTakeMode === 'synopsis' && (
        <p className="mt-3 text-gray-400 text-sm leading-relaxed">{show.synopsis}</p>
      )}

      {/* Action cluster — user buttons + tickets share ONE space-y-2 group so
          every gap in the button stack is identical (the old split put 16px
          above Get Tickets but 8px below it — owner report, 2026-07-17). */}
      <div className="space-y-2">
      {/* Action buttons row — same geometry as the ticket buttons below
          (h-10 / rounded-lg / horizontal icon+label); a taller rounder shape
          here read as mismatched (owner report, 2026-07-17). */}
      {userFeaturesEnabled && (
        <div className={`grid gap-2 ${isAuthenticated ? 'grid-cols-[1fr_1fr_auto]' : 'grid-cols-2'}`}>
          <button
            type="button"
            onClick={handleWantToSee}
            className={`flex items-center justify-center gap-1.5 h-10 px-2 rounded-lg border transition-all whitespace-nowrap ${
              onWatchlist
                ? 'bg-brand/10 border-brand text-brand'
                : 'bg-white/10 border-white/15 text-white hover:bg-white/15 hover:border-white/25'
            }`}
          >
            <svg className="w-4 h-4 shrink-0" fill={onWatchlist ? 'currentColor' : 'none'} viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
            </svg>
            <span className="text-xs sm:text-sm font-semibold">{getWatchlistCtaLabel({ onWatchlist, hasRating, isClosed })}</span>
          </button>
          <button
            type="button"
            ref={rateBtnRef}
            onClick={handleRateIt}
            className="flex items-center justify-center gap-1.5 h-10 px-2 rounded-lg border bg-white/10 border-white/15 text-white hover:bg-white/15 hover:border-white/25 transition-all whitespace-nowrap"
          >
            <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.196-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" />
            </svg>
            <span className="text-xs sm:text-sm font-semibold">
              {!hasRating ? 'Rate it' : 'Log another viewing'}
            </span>
          </button>
          {/* Custom lists, signed-in only: for signed-out visitors it was a third
              control that led straight to a sign-in wall (owner, 2026-10-06).
              Icon-only below sm so the two primary buttons keep their width. */}
          {isAuthenticated && <ShowPageAddToListButton showId={show.id} variant="hero" />}
        </div>
      )}

      {/* Your plans — date + showtime for a watchlisted show, edited in a
          sheet. Replaced the caption's date link and 10px Matinee / Evening /
          Custom chips (owner, 2026-10-03: "tiny and unprofessional"). */}
      {userFeaturesEnabled && onWatchlist && watchlistEntry && (
        <WatchlistPlanCard
          showId={show.id}
          showTitle={show.title}
          entry={watchlistEntry}
          event={plannedShowEvent}
          onDateChange={(val) => updatePlannedDate(show.id, val).catch(() => showToast?.('Failed to save date.', 'error'))}
          onShowtimeChange={(fields) => updatePerformance(show.id, fields).catch(() => showToast?.('Failed to save showtime.', 'error'))}
          onRemove={handleWantToSee}
        />
      )}

      {/* Membership caption — one line gathering ALL list membership: the
          Watchlist link first (the "On your list" button is a TOGGLE and must
          not navigate), then custom lists. Owner design pick, 2026-07-19. */}
      {userFeaturesEnabled && (onWatchlist || firstListContainingShow) && (
        <p className="text-xs text-gray-500 flex items-center gap-1.5">
          <svg className="w-3 h-3 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 10h16M4 14h16M4 18h10" />
          </svg>
          <span className="truncate">
            {onWatchlist && !isAuthenticated && 'Saved on this device'}
            {onWatchlist && isAuthenticated && (
              <>
                On your{' '}
                <Link
                  href="/my-shows?tab=watchlist"
                  className="text-brand/90 hover:text-brand transition-colors border-b border-dotted border-brand/30"
                >
                  Watchlist
                </Link>
              </>
            )}
            {onWatchlist && firstListContainingShow && ' · '}
            {firstListContainingShow && (
              <>
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
              </>
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
          analytics={{ source: 'show_page', showId: show.id }}
        />
      )}

      {/* Tickets — primary CTA + lottery/rush pill (desktop only).
          Mobile hides the Lottery/Rush pill via `hidden lg:inline-flex` —
          on mobile it pushed content too far down. Desktop keeps it next
          to the Get Tickets CTA where there's horizontal room. Full info
          for both viewports lives in the Discount Tickets card below. */}
      {/* BRO-166: also mount when the only thing we have is an officialUrl —
          TicketButtonsAB itself now renders that as the primary CTA, but
          only if it gets the chance to run at all. */}
      {!isClosed && (sortedTicketLinks.length > 0 || Boolean(show.officialUrl)) && (
        <TicketButtonsAB
          showName={show.title}
          showId={show.id}
          showSlug={show.slug}
          showStatus={show.status}
          showCategory={show.category}
          showVenue={show.venue}
          showScore={score}
          ticketLinks={sortedTicketLinks}
          officialUrl={show.officialUrl}
          pageType="show"
          splitVariant
          primaryButtonClassName="w-full lg:w-auto lg:self-start inline-flex items-center justify-center gap-1.5 h-10 px-5 rounded-lg bg-gradient-brand text-white font-bold text-sm leading-none hover:shadow-glow-sm hover:scale-[1.01] active:scale-[0.99] transition-all whitespace-nowrap"
          secondaryAfter={lotteryPill('hidden lg:inline-flex')}
        />
      )}

      {/* A lottery/rush show with no ticket links and no official site never
          mounts TicketButtonsAB, so its pill has no home above. Render it
          standalone (all breakpoints: there is no Get Tickets button here to
          crowd) so the hero still points at the Discount Tickets card. */}
      {!isClosed && !(sortedTicketLinks.length > 0 || Boolean(show.officialUrl)) && lotteryPill('inline-flex self-start')}

      {/* Closed/not-yet-on-sale shows: replace the vanished CTA with an explicit
          note instead of leaving a silent gap where the ticket button used to be —
          users hunting for a "Get Tickets" button rage-clicked the empty space
          (CLAUDE.md card #228, task #90). See getTicketCtaNote for why 'closed'
          checks status alone. */}
      {getTicketCtaNote(show.status, show.ticketLinks, sortedTicketLinks) === 'closed' && (
        <p className="text-xs text-gray-500">This show has closed. Tickets are no longer available.</p>
      )}
      {getTicketCtaNote(show.status, show.ticketLinks, sortedTicketLinks) === 'announced-not-on-sale' && (
        <p className="text-xs text-gray-500">Tickets aren&apos;t on sale yet. Check back closer to opening.</p>
      )}
      </div>{/* /action cluster */}
    </div>
  );
}

// ─── Sub-components ──────────────────────────────────────────────────────

function DateLine({ show, tourReviewYears }: { show: ComputedShowWithReviews<Pick<ComputedReview, 'reviewScore'>>; tourReviewYears: string | null }) {
  // One hierarchy step below the venue line (text-sm gray-300) so the two
  // stacked rows read as place → metadata instead of two identical gray lines.
  const dateClass = 'text-xs text-gray-500';

  // Segments (start/closing/duration text) come from the shared
  // show-date-line module — the single source of truth also consumed by the
  // legacy hero (src/app/show/[slug]/page.tsx). Do not fork this logic back
  // into inline branches (task #951).
  const durationSuffix = getHeroDurationSuffix(show);
  const durationText = durationSuffix ? getBroadwayDuration(show.openingDate, durationSuffix) : null;
  const segments: Array<{ text: string; emphasize?: boolean }> = getShowDateLineSegments(show, durationText);
  // Matches the legacy header: a tour with no dates of its own says when it was reviewed.
  if (tourReviewYears) segments.push({ text: `reviewed ${tourReviewYears}` });
  if (segments.length === 0) return null;

  return (
    <p className={dateClass}>
      {segments.map((seg, i) => (
        <React.Fragment key={i}>
          {i > 0 ? ' · ' : ''}
          {seg.emphasize ? <span className="text-amber-400">{seg.text}</span> : seg.text}
        </React.Fragment>
      ))}
    </p>
  );
}

function AwaitingCard({ show, reviewCount, reviewsRemaining }: { show: ComputedShowWithReviews<Pick<ComputedReview, 'reviewScore'>>; reviewCount: number; reviewsRemaining: number }) {
  // A national tour is reviewed city by city as it plays, so its empty state
  // says reviews are coming in rather than that something is missing (BRO-4931).
  const isTour = show.category === 'tour';
  const progress = (
    <>
      {show.status === 'previews' ? 'Show in previews' : show.status === 'upcoming' ? (isTour ? 'Tour starts soon' : 'Show opens soon') : isTour ? 'Critics in each city review the tour as it plays' : 'Not enough reviews yet'}
      {reviewCount > 0 ? ` · ${reviewCount} ${reviewCount === 1 ? 'review' : 'reviews'} collected` : null}
      {reviewsRemaining > 0 ? ` · ${reviewsRemaining} more for a CriticScore` : null}
    </>
  );
  return (
    <div className="card p-4 text-center bg-surface-overlay border-white/5">
      <p className="text-sm font-semibold text-gray-300 mb-0.5" data-testid="awaiting-reviews">{isLiveTour(show) ? 'Reviews coming in' : 'Awaiting reviews'}</p>
      {reviewCount > 0 ? (
        <a href="#critic-reviews" className="text-xs text-gray-500 hover:text-brand transition-colors">{progress}</a>
      ) : (
        <p className="text-xs text-gray-500">{progress}</p>
      )}
    </div>
  );
}

function YourRatingInline({
  reviews,
  onEditReview,
}: {
  reviews: UserReview[];
  onEditReview: (review: UserReview) => void;
}) {
  const isMulti = reviews.length > 1;
  // Same row as WatchlistPlanCard (date tile, title, chevron) so a watched
  // show and a planned show read as one design. The whole row opens the
  // editor, which also holds Delete (owner, 2026-10-03).
  return (
    <div className="space-y-2" data-testid="your-rating">
      {reviews.map((review, i) => (
        <PlanRow
          key={review.id}
          onClick={() => onEditReview(review)}
          tile={review.date_seen ? <DateTile date={review.date_seen} /> : <StarTile />}
          title={
            <>
              {isMulti && <span className="text-gray-400 font-medium">{i === 0 ? 'Latest · ' : 'Earlier · '}</span>}
              {review.date_seen ? `You saw it ${formatDate(review.date_seen)}` : 'Your rating'}
            </>
          }
        >
          <span className="flex items-center gap-2 mt-1">
            {/* MiniStars draws plain SVGs: StarRating's read-only mode still renders
                buttons, and a button inside this row's button is invalid HTML. */}
            <MiniStars rating={review.rating} />
            <span className="text-sm font-bold text-amber-400 tabular-nums">{review.rating.toFixed(1)}<span className="sr-only"> out of 5</span></span>
          </span>
          {review.review_text && (
            <span className="block mt-1">
              <span className="ph-mask text-sm text-gray-400 italic leading-snug line-clamp-2">
                {`\u201C${review.review_text}\u201D`}
              </span>
            </span>
          )}
          <span className="sr-only">Edit</span>
        </PlanRow>
      ))}
    </div>
  );
}

function StarTile() {
  return (
    <span className="flex-shrink-0 w-12 h-12 rounded-lg bg-amber-400/15 text-amber-300 flex items-center justify-center" aria-hidden="true">
      <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
        <path d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.196-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" />
      </svg>
    </span>
  );
}
