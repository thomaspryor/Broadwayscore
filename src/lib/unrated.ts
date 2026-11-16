/**
 * "Seen, not rated" (BRO-7628). A user can log a show they saw without stars;
 * that row is stored with rating = 0 (the DB CHECK allows 0 or 0.5-5). Every
 * reader must treat rating <= 0 as "no rating": never draw "0.0", never count
 * it in averages, never call the show "rated".
 */
export const UNRATED_RATING = 0;
export const NOT_RATED_LABEL = 'Not rated';

export function isRated(rating: number | null | undefined): rating is number {
  return typeof rating === 'number' && Number.isFinite(rating) && rating > 0;
}

/** "4.5", or "Not rated" for a seen-but-unrated entry. */
export function formatUserRating(rating: number | null | undefined): string {
  return isRated(rating) ? rating.toFixed(1) : NOT_RATED_LABEL;
}

interface ReviewRow { id: string; show_id: string; rating: number; date_seen: string | null; created_at?: string }

/**
 * To Be Rated shelf entries for shows logged without stars: one per show whose
 * past diary rows are ALL unrated, keyed to the latest such row (rows arrive
 * newest first). Future-dated rows are not "seen" yet and stay out.
 */
export function selectUnratedLoggedEntries(
  reviews: ReviewRow[],
  today: string,
): { id: string; show_id: string; planned_date: string | null; edit: true }[] {
  const rated = new Set(reviews.filter(r => isRated(r.rating)).map(r => r.show_id));
  const out: { id: string; show_id: string; planned_date: string | null; edit: true }[] = [];
  const seen = new Set<string>();
  for (const r of reviews) {
    if (rated.has(r.show_id) || seen.has(r.show_id) || isRated(r.rating)) continue;
    if (r.date_seen && r.date_seen > today) continue;
    seen.add(r.show_id);
    out.push({ id: `unrated-${r.id}`, show_id: r.show_id, planned_date: r.date_seen, edit: true });
  }
  return out;
}
