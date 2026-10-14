/**
 * Shared half-star rating sanitizer — THE write-path guard for user ratings.
 *
 * Promoted from RatingEditor so every flow that writes a rating (star editor,
 * show imports) snaps and clamps the same way. The reviews table has no CHECK
 * on precision, so this is the single place that enforces half-star steps.
 * The show-score-proxy edge function carries its own copy of this formula
 * (supabase/functions/show-score-proxy/parser.mjs scoreToRating) because Deno
 * can't import from src/ — if you change one, change both.
 */
export function sanitizeRating(r: number): number {
  if (!Number.isFinite(r)) return 0;
  return Math.min(5, Math.max(0, Math.round(r * 2) / 2));
}
