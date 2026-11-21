-- BRO-7628: let a user log a show they saw without giving it stars.
-- An unrated "seen" entry is stored as rating = 0. Every reader already treats
-- rating <= 0 as "no rating" (parseRating, SeenView, StatsTab, feed, app's
-- useMyRatingsMap), so 0 is the existing "not rated" sentinel.
ALTER TABLE public.reviews DROP CONSTRAINT IF EXISTS reviews_rating_check;
ALTER TABLE public.reviews ADD CONSTRAINT reviews_rating_check
  CHECK (rating = 0 OR (rating >= 0.5 AND rating <= 5.0));
