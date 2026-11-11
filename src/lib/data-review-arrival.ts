// Server-side wiring for the opening-night "reviews still arriving" status (BRO-7376).
// Pure decisions live in review-arrival.ts; this only gathers the real inputs.
import reviewsData from '../../data/reviews.json';
import outletRegistry from '../../data/outlet-registry.json';
import { getAllShows } from '@/lib/data-core';
import { standingOutletIds } from '../../scripts/lib/standing-outlets';
import {
  buildReviewArrival, expectedForShow, type HistoryShow, type OutletRef, type ReviewArrival,
} from '@/lib/review-arrival';

type Row = { showId: string; outletId?: string; publishDate?: string | null; wrongProduction?: boolean; wrongShow?: boolean; isRoundupArticle?: boolean };

let cache: { byShow: Map<string, Row[]>; history: HistoryShow[]; regular: OutletRef[] } | null = null;

function load() {
  if (cache) return cache;
  const byShow = new Map<string, Row[]>();
  for (const r of (reviewsData as { reviews: Row[] }).reviews) {
    if (r.wrongProduction || r.wrongShow || r.isRoundupArticle) continue;
    const a = byShow.get(r.showId);
    if (a) a.push(r); else byShow.set(r.showId, [r]);
  }
  const history: HistoryShow[] = getAllShows()
    .filter((s) => s.category === 'broadway' && s.openingDate)
    .map((s) => ({ id: s.id, category: s.category, openingDate: s.openingDate, reviewDates: (byShow.get(s.id) || []).map((r) => r.publishDate) }));
  const outlets = outletRegistry.outlets as Record<string, { displayName?: string }>;
  const regular = (standingOutletIds(outlets, 'broadway') as string[]).map((id) => ({ id, name: outlets[id]?.displayName || id }));
  cache = { byShow, history, regular };
  return cache;
}

/**
 * The status for one show page, or null when it should not show. `now` is the
 * server clock; REVIEW_ARRIVAL_NOW overrides it for local design captures only.
 */
export function getReviewArrival(
  show: { id: string; category?: string | null; openingDate?: string | null },
  reviewCount: number,
  scoreShowing: boolean,
): ReviewArrival | null {
  if (show.category !== 'broadway' || !show.openingDate) return null;
  const { byShow, history, regular } = load();
  const override = process.env.REVIEW_ARRIVAL_NOW;
  const now = override ? new Date(override) : new Date();
  const rows = byShow.get(show.id) || [];
  return buildReviewArrival({
    now, openingDate: show.openingDate, category: show.category, reviewCount, scoreShowing,
    expected: expectedForShow(show, history),
    regular, haveOutletIds: rows.map((r) => String(r.outletId || '')),
  });
}
