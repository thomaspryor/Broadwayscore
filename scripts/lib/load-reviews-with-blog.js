/**
 * Shared loader for reviews.json + blog-reviews-for-scoring.json.
 *
 * Mirrors src/lib/data-core.ts, which concatenates pre-computed blog reviews
 * onto reviews.json as Tier 3 critic reviews before computing show-page scores.
 * Any build-time script that recomputes critic scores from reviews.json MUST
 * use this loader, or its scores will diverge from the show page (and from
 * each other).
 *
 * Root cause of pre-April 2026 drift: compute-gold-lists.js and
 * generate-mobile-show-details.js read reviews.json directly. For shows with
 * entries in blog-reviews-for-scoring.json, the gold list / mobile JSON showed
 * a different score than the live show page — e.g. Putnam County Spelling Bee
 * (OB) showed 89.0 on the gold list but 88.2 on the show page.
 *
 * Consumers:
 *   - scripts/compute-gold-lists.js
 *   - scripts/generate-mobile-show-details.js
 *   - scripts/generate-mobile-data.js
 *   - scripts/generate-homepage-archive.js
 *   - scripts/generate-social-post.js
 */

const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, '..', '..', 'data');

/**
 * Load reviews.json and append blog-reviews-for-scoring.json entries.
 * Returns a plain array of review objects (same shape reviews.json uses).
 */
function loadReviewsWithBlog() {
  let reviews = [];
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'reviews.json'), 'utf-8'));
    reviews = raw.reviews || [];
  } catch (err) {
    // Caller handles missing reviews.json
  }

  try {
    const blog = JSON.parse(fs.readFileSync(path.join(dataDir, 'blog-reviews-for-scoring.json'), 'utf-8'));
    if (blog.reviews && Array.isArray(blog.reviews)) {
      reviews = reviews.concat(blog.reviews);
    }
  } catch (err) {
    // blog-reviews-for-scoring.json is prebuild-generated; missing is fine
  }

  return reviews;
}

module.exports = { loadReviewsWithBlog };
