/**
 * React list key for a single critic review card (ReviewsList.tsx).
 *
 * outletId+publishDate alone collides whenever an outlet runs multiple
 * critics on the same show on the same day (e.g. NY Stage Review, which
 * publishes several bylined reviews per opening) — React then warns about
 * duplicate keys and can misattribute per-card state (expand/collapse,
 * hover) across the colliding cards, which reads to users as an
 * unresponsive click (task #64, proof-2026 nysr collision on 2026-04-16).
 * Appending url + criticName closes the collision: measured against all
 * 20,239 reviews in data/reviews.json, outletId+publishDate alone collides
 * 324 times; adding url drops that to 4 (null-url reviews); adding
 * criticName on top brings it to 0.
 */
function getReviewKey(review) {
  return `${review.outletId}-${review.publishDate}-${review.url ?? ''}-${review.criticName ?? ''}`;
}

module.exports = { getReviewKey };
