/**
 * Whether a show page should say outright that no critic reviews are coming.
 *
 * Owner decision 2026-10-14: one-off events (a single-night cabaret, a
 * festival of short pieces) kept showing "Awaiting reviews · 5 more for a
 * CriticScore" and "Archived critic reviews ... are being collected" forever.
 * Those promise a score that will never arrive, which a first-time visitor
 * reads as misleading.
 *
 * Deliberately narrow, so a show that can still be reviewed keeps the old
 * wording:
 *  - type 'special' (events, dance, concerts) or 'opera' (one-night galas);
 *    plays and musicals always get reviewed eventually or are
 *    archived-collection cases;
 *  - not Broadway: a Broadway special (e.g. La Bohème 2002) was reviewed and
 *    its archive may still be collected;
 *  - closed at least NO_REVIEWS_AFTER_DAYS ago: late reviews still land in
 *    the first weeks after a run ends;
 *  - zero reviews on file.
 * Call it once on the server (page.tsx) and pass the result down: the page is
 * ISR-cached for a day, so a client-side `new Date()` could disagree with the
 * server HTML around the cutoff and flip the copy on hydration.
 */
export const NO_REVIEWS_AFTER_DAYS = 30;

export interface ReviewExpectationShow {
  type?: string | null;
  status?: string | null;
  category?: string | null;
  closingDate?: string | null;
}

export function noCriticReviewsExpected(
  show: ReviewExpectationShow,
  reviewCount: number,
  now: Date = new Date(),
): boolean {
  if (reviewCount > 0) return false;
  if (show.type !== 'special' && show.type !== 'opera') return false;
  if (show.status !== 'closed') return false;
  if (!show.category || show.category === 'broadway') return false;
  if (!show.closingDate) return false;
  // Date part only, so a value carrying a time still parses.
  const closed = Date.parse(`${String(show.closingDate).slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(closed)) return false;
  return now.getTime() - closed >= NO_REVIEWS_AFTER_DAYS * 24 * 60 * 60 * 1000;
}
