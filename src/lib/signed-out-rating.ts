/**
 * The one signed-out rating save (BRO-6917, BRO-7690).
 *
 * A signed-out Save keeps the rating on this device first (local-ratings.ts),
 * takes the show off the device's want-to-see list (rated = seen), and logs
 * `rating_saved_local`. The caller then offers sign-in and returns
 * 'saved-local' to RatingEditor; LocalRatingsMigrator moves the rating into
 * the account at sign-in.
 *
 * The show page and the diary-show page both call this, so a signed-out
 * rating can never fall back to the old one-hour draft behind a sign-in modal
 * on one page while the other keeps it (BRO-7690: the diary page still did).
 */
import { isRated } from '@/lib/unrated';
import { saveLocalRating, type LocalRating, type LocalRatingInput } from '@/lib/local-ratings';
import { removeLocalShow } from '@/lib/local-watchlist';
import { trackUgc } from '@/lib/ugc-analytics';

/** The RatingEditor save fields a signed-out save keeps (no review id, no photos). */
export interface SignedOutRatingData {
  rating: number;
  reviewText?: string | null;
  dateSeen?: string | null;
  timeSlot?: LocalRating['timeSlot'] | null;
  curtainTime?: string | null;
  seat?: string | null;
}

/** Pure: editor data → the device entry (empty fields left out). */
export function toLocalRatingInput(showId: string, data: SignedOutRatingData): LocalRatingInput {
  return {
    showId,
    rating: data.rating,
    ...(data.reviewText ? { reviewText: data.reviewText } : {}),
    ...(data.dateSeen ? { dateSeen: data.dateSeen } : {}),
    ...(data.timeSlot ? { timeSlot: data.timeSlot } : {}),
    ...(data.curtainTime ? { curtainTime: data.curtainTime } : {}),
    ...(data.seat ? { seat: data.seat } : {}),
  };
}

/** Save a signed-out rating on this device. Returns the device's ratings after the save. */
export function saveSignedOutRating(showId: string, data: SignedOutRatingData, source: string): LocalRating[] {
  const next = saveLocalRating(toLocalRatingInput(showId, data));
  removeLocalShow(showId);
  trackUgc('rating_saved_local', {
    show_id: showId,
    source,
    rating: isRated(data.rating) ? data.rating : null,
    unrated: !isRated(data.rating),
    has_review_text: !!data.reviewText,
    local_count: next.length,
  });
  return next;
}
