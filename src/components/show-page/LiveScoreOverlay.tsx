'use client';
// BRO-7803: runtime score overlay. The server HTML (static scores) is always the
// first paint and the fallback. For pages the build marked `eligible` (opening
// within days / a review in the last days) this fetches the live-scores pointer
// after mount and, when a newer, valid payload exists, swaps the score region
// in place. Any failure leaves the static page exactly as built. Never throws,
// never renders an error, never blanks a badge.
import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import StickyScoreHeader from '@/components/StickyScoreHeader';
import ReviewsList, { type ReviewListItem } from '@/components/ReviewsList';
import { ScoreBreakdownBar } from '@/components/show-cards';
import { CallResultStrip } from '@/components/show-page/CallTheScore';
import type { ScoreRegionView } from '@/lib/live-score/view';
// Pure, CommonJS, unit-tested (tests/unit/runtime-score-json.test.mjs).
import { chooseEntry, validatePayload } from '../../../scripts/lib/live-score/resolve';
import { applyHeroOverlay, stickyScore, reviewListProps } from '../../../scripts/lib/live-score/apply';

export interface LiveOverlay { view: ScoreRegionView; reviews: ReviewListItem[] }
const Ctx = createContext<LiveOverlay | null>(null);
export const useLiveOverlay = () => useContext(Ctx);

const BUCKET = 'live-scores';
const BUCKET_URL = `${process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''}/storage/v1/object/public/${BUCKET}`;
const TTL_BUCKET_MS = 20000;
const TIMEOUT_MS = 4000;

async function getJson(path: string, bust: boolean): Promise<unknown> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const q = bust ? `?t=${Math.floor(Date.now() / TTL_BUCKET_MS)}` : '';
    const res = await fetch(`${BUCKET_URL}/${path}${q}`, { signal: ctl.signal, credentials: 'omit' });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; } finally { clearTimeout(timer); }
}

function track(outcome: string, reason: string, showId: string) {
  try {
    const ph = (window as unknown as { posthog?: { capture: (e: string, p: object) => void } }).posthog;
    ph?.capture('live_score_overlay', { outcome, reason, showId });
  } catch { /* analytics must never affect the page */ }
}

export function LiveScoreProvider({ showId, staticRev, staticReviewCount, eligible, children }: {
  showId: string; staticRev: number; staticReviewCount: number; eligible: boolean; children: React.ReactNode;
}) {
  const [overlay, setOverlay] = useState<LiveOverlay | null>(null);
  useEffect(() => {
    if (!eligible || !process.env.NEXT_PUBLIC_SUPABASE_URL) return;
    let dead = false;
    (async () => {
      const [kill, pointer] = await Promise.all([getJson('kill.json', true), getJson('p.json', true)]);
      const pick = chooseEntry({ showId, staticRev, kill, pointer } as never) as { entry?: { v: string; rev: number }; reason?: string };
      if (!pick.entry) { track('skipped', pick.reason ?? 'none', showId); return; }
      const payload = await getJson(`s/${showId}.${pick.entry.v}.json`, false);
      const ok = validatePayload({ payload, entry: pick.entry, showId, staticRev, staticReviewCount } as never) as { ok?: boolean; view?: ScoreRegionView; reviews?: ReviewListItem[]; reason?: string };
      if (!ok.ok || !ok.view || !ok.reviews) { track('rejected', ok.reason ?? 'invalid', showId); return; }
      if (!dead) { setOverlay({ view: ok.view, reviews: ok.reviews }); track('applied', 'ok', showId); }
    })().catch(() => {});
    return () => { dead = true; };
  }, [showId, staticRev, staticReviewCount, eligible]);
  return <Ctx.Provider value={overlay}>{children}</Ctx.Provider>;
}

export function useLiveHeroProps<P extends object>(props: P): P {
  const overlay = useLiveOverlay();
  return useMemo(() => applyHeroOverlay(props as never, overlay as never) as P, [props, overlay]);
}

export function LiveStickyScoreHeader(props: React.ComponentProps<typeof StickyScoreHeader>) {
  const overlay = useLiveOverlay();
  return <StickyScoreHeader {...props} score={stickyScore(props.score, overlay as never)} />;
}

export function LiveReviewCount({ staticCount }: { staticCount: number }) {
  const overlay = useLiveOverlay();
  const n = overlay ? overlay.view.reviewCount : staticCount;
  return <>{n} {n === 1 ? 'review' : 'reviews'}</>;
}

export function LiveCallResultStrip({ show, critic }: { show: React.ComponentProps<typeof CallResultStrip>['show']; critic: number }) {
  const overlay = useLiveOverlay();
  const c = overlay ? (overlay.view.showTBD ? null : overlay.view.score) : critic;
  return c == null ? null : <CallResultStrip show={show} critic={c} />;
}

export function LiveBreakdownBar(props: React.ComponentProps<typeof ScoreBreakdownBar> & { staticTBD: boolean }) {
  const overlay = useLiveOverlay();
  const { staticTBD, reviews, ...rest } = props;
  const tbd = overlay ? overlay.view.showTBD : staticTBD;
  const rows = overlay ? overlay.reviews : reviews;
  if (tbd || rows.length === 0) return null;
  return <ScoreBreakdownBar reviews={rows} {...rest} />;
}

export function LiveReviewsList(props: React.ComponentProps<typeof ReviewsList>) {
  const overlay = useLiveOverlay();
  return <ReviewsList {...(reviewListProps(props as never, overlay as never) as typeof props)} />;
}

/** Rendered only when the build had no reviews (so no static section): the section appears when the overlay brings the first rows. */
export function LiveReviewsSectionIfAbsent({ category, showId, showTiers, staticHasReviews }: { category: string; showId: string; showTiers: boolean; staticHasReviews: boolean }) {
  const overlay = useLiveOverlay();
  // A static reviews section already renders the overlay rows through LiveReviewsList; a second one would duplicate the id and the list.
  if (staticHasReviews || !overlay || overlay.reviews.length === 0) return null;
  const score = overlay.view.showTBD ? null : overlay.view.score;
  return (
    <section id="critic-reviews" className="card p-5 sm:p-6 pb-4 sm:pb-5 mb-5 sm:mb-8 scroll-mt-20" aria-labelledby="critic-scorecard-heading">
      <header className="flex items-center justify-between gap-3 mb-4">
        <h2 id="critic-scorecard-heading" className="text-[11px] font-bold uppercase tracking-[0.12em] text-gray-400 leading-none m-0">Critic Scorecard</h2>
        <span className="text-[11px] font-medium tracking-[0.06em] text-fg-muted lowercase shrink-0">
          {overlay.view.reviewCount} {overlay.view.reviewCount === 1 ? 'review' : 'reviews'}
        </span>
      </header>
      {score != null && <CallResultStrip show={{ id: showId, category }} critic={score} />}
      <ReviewsList reviews={overlay.reviews} initialCount={5} category={category} showTiers={showTiers} />
    </section>
  );
}

/** Hides a static "no reviews yet" placeholder once the overlay brings real rows (LiveReviewsSectionIfAbsent renders instead). */
export function LiveHideWhenOverlay({ children }: { children: React.ReactNode }) {
  const overlay = useLiveOverlay();
  return overlay && overlay.reviews.length > 0 ? null : <>{children}</>;
}
