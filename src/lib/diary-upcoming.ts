/**
 * Which watchlist entries are upcoming, to be rated, or already rated.
 *
 * One rule decides all three: a review represents a watchlist entry when it is
 * for the same show and dated on or after the entry's planned_date (or has no
 * date). That mirrors the server rule in supabase/migrations/20261001_plan_shares.sql.
 * A review from before the planned date is a previous viewing, so a planned
 * rewatch of a rated show still counts as upcoming and, once its day passes,
 * as to be rated (owner report 2026-10-19: Oh, Mary! rated Jan 8 and planned
 * for Nov 14 showed on To Watch but not in Diary Upcoming).
 */
export interface UpcomingWatchlistInput {
  show_id: string;
  planned_date?: string | null;
}

export interface UpcomingReviewInput {
  show_id: string;
  date_seen?: string | null;
}

export function isWatchlistEntryRated(
  entry: UpcomingWatchlistInput,
  reviews: UpcomingReviewInput[],
): boolean {
  return reviews.some(
    r =>
      r.show_id === entry.show_id &&
      (!r.date_seen || !entry.planned_date || r.date_seen >= entry.planned_date),
  );
}

/** Future planned entries (strictly after today) not yet represented by a review. */
export function selectUpcomingWatchlistEntries<W extends UpcomingWatchlistInput>(
  watchlist: W[],
  reviews: UpcomingReviewInput[],
  today: string,
): W[] {
  return watchlist
    .filter(w => w.planned_date && w.planned_date > today && !isWatchlistEntryRated(w, reviews))
    .sort((a, b) => (a.planned_date || '').localeCompare(b.planned_date || ''));
}

/** Entries planned for today or earlier with no representing review. */
export function selectToBeRatedWatchlistEntries<W extends UpcomingWatchlistInput>(
  watchlist: W[],
  reviews: UpcomingReviewInput[],
  today: string,
): W[] {
  return watchlist
    .filter(w => w.planned_date && w.planned_date <= today && !isWatchlistEntryRated(w, reviews))
    .sort((a, b) => (b.planned_date || '').localeCompare(a.planned_date || ''));
}
