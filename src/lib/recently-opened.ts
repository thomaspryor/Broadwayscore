// Canonical predicate for "recently opened Off-Broadway show that is still
// awaiting its CriticScore." Used in two places that MUST stay in lockstep:
//   1. The "Recently Opened · Awaiting Reviews" shelf on /off-broadway
//      (src/app/off-broadway/page.tsx)
//   2. The `recently-opened-off-broadway` browse page filter
//      (src/config/browse-pages.ts)
// Keeping the definition here (rather than duplicating the inline logic) means
// a threshold change updates both surfaces at once — see the includability-
// predicate rule in CLAUDE.md.
import { hasEnoughReviews } from '@/config/score-buckets';

// How long after opening a show stays in the "recently opened" window. Off-
// Broadway reviews can take up to ~2 weeks to land (sometimes longer for small
// houses), so this is generous enough to cover the real trickle-in period
// without surfacing shows that opened months ago and will never be reviewed.
export const RECENTLY_OPENED_AWAITING_DAYS = 30;

// Minimal structural shape shared by ComputedShow and the raw show records, so
// this helper can run against either without importing heavy data types.
interface AwaitingShowShape {
  status?: string;
  category?: string;
  openingDate?: string;
  criticScore?: { reviewCount?: number; tier1Count?: number; tier2Count?: number } | null;
}

/** Whole days between a show's opening date and `now` (null if unparseable). */
export function daysSinceOpening(openingDate?: string, now: Date = new Date()): number | null {
  if (!openingDate) return null;
  // Parse at local noon off the date portion so DST / timezone never flips the
  // day count (mirrors the date handling in off-broadway/page.tsx).
  const opened = new Date(`${openingDate.slice(0, 10)}T12:00:00`);
  if (Number.isNaN(opened.getTime())) return null;
  return Math.floor((now.getTime() - opened.getTime()) / 86_400_000);
}

/**
 * True when a show is open, opened within the recency window, and does not yet
 * have enough reviews to display a CriticScore. This is exactly the set of
 * shows that otherwise fall into the coverage gap: dropped from "Upcoming" once
 * they open, and hidden from the main list / "Best" pages by the review gate.
 */
// NOTE ON SCOPE: this predicate is Off-Broadway-only today. It defaults the
// category to 'off-broadway' and omits the `isCuratedHistorical` argument that
// the score badges pass — both are safe here (curated-historical only lowers
// the *Broadway* threshold) but would need revisiting before reusing this for
// Broadway/West End. `status === 'open'` is deliberate: previews/upcoming shows
// are already covered by the "Starting Soon" / Upcoming surfaces, and this is
// specifically the post-opening, pre-score gap.
export function isRecentlyOpenedAwaitingReviews(
  show: AwaitingShowShape,
  now: Date = new Date(),
): boolean {
  if (show.status !== 'open') return false;
  const reviewCount = show.criticScore?.reviewCount ?? 0;
  const t1t2 = (show.criticScore?.tier1Count ?? 0) + (show.criticScore?.tier2Count ?? 0);
  // Already has (or has cleared the bar for) a score → not awaiting.
  if (hasEnoughReviews(reviewCount, show.category ?? 'off-broadway', t1t2)) return false;
  // Fail closed on a missing/unparseable opening date: without one we can't
  // place the show in the recency window, and a dateless "open" record is
  // usually an incomplete stub we shouldn't surface with an empty "Opened —".
  const days = daysSinceOpening(show.openingDate, now);
  return days !== null && days >= 0 && days <= RECENTLY_OPENED_AWAITING_DAYS;
}
