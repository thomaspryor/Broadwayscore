/**
 * Time Out London URL shapes (BRO-4399).
 *
 * Time Out London files reviews under more than one section:
 *   /london/theatre/<show>-review          (evergreen review)
 *   /london/news/<show>-review-<blurb>-MMDDYY   (opening-night review, e.g. The
 *       Standard of Living, 29 Sep 2026 — invisible to discovery for ~2h)
 *   /london/news/review-<show>-at-<venue>-MMDDYY
 * and keeps an evergreen LISTING page per show at /london/<section>/<show>
 * (no "review" in the slug). A listing is not a review: the pipeline once held
 * only that page (contentTier invalid) while the real /news/ review went unseen.
 *
 * Pure. classifyTimeOutLondonUrl is the one place that decides which is which.
 */

const REVIEW_SLUG_RE = /(^|-)review(-|$)/;

/**
 * @param {string} url
 * @returns {'review'|'listing'|'news-other'|'other'|null}
 *   null = not a timeout.com/london URL at all.
 *   'review'     = slug carries the whole word "review" (any section, incl. /news/).
 *   'listing'    = /london/<section>/<slug> with no "review" in slug (show page).
 *   'news-other' = /london/news/ item without "review" (announcement, feature).
 *   'other'      = a /london/ path that is neither (section root, deeper paths).
 */
function classifyTimeOutLondonUrl(url) {
  if (!url || typeof url !== 'string') return null;
  let parsed;
  try { parsed = new URL(url); } catch { return null; }
  const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
  if (host !== 'timeout.com') return null;
  const parts = parsed.pathname.toLowerCase().split('/').filter(Boolean);
  if (parts[0] !== 'london') return null;
  if (parts.length !== 3) return 'other';
  const [, section, slug] = parts;
  if (REVIEW_SLUG_RE.test(slug)) return 'review';
  if (section === 'news') return 'news-other';
  return 'listing';
}

/** True for a Time Out London URL that is a per-show listing page, never a review. */
function isTimeOutLondonListing(url) {
  return classifyTimeOutLondonUrl(url) === 'listing';
}

module.exports = { classifyTimeOutLondonUrl, isTimeOutLondonListing };
