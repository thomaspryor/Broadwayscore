/**
 * Show Score per-show review discovery for the gap-audit reconciliation.
 *
 * Show Score lists critic reviews (with direct outlet links) on each show's page —
 * including off-Broadway, where it lands later and with fewer reviews than Playbill
 * or BroadwayWorld, but it DOES carry them (operator note, 2026-06-06). Adding it as
 * a reconciliation source means the hourly gap audit eventually catches a review that
 * surfaced only on Show Score. Unlike DTLI (Broadway-only), Show Score covers OB.
 *
 * The per-show page exposes outlet review URLs in the static HTML (JSON-LD `url`
 * fields + anchors) — no JS render needed for the primary links. Returns RAW
 * external candidate URLs; the caller (audit-show-review-gap.js) applies its own
 * isReviewUrl + title-token filtering so ticketing / maps / form links never
 * become bogus "missing reviews".
 */

const SS_HOSTS = /(^|\.)show-score\.com$/i;

/**
 * Resolve a show's Show Score page URL. Prefers the curated map
 * (data/show-score-urls.json); otherwise constructs the section + slug URL.
 *
 * @param {object} show - shows.json record (needs id, title, category)
 * @param {object} [urlMap] - parsed data/show-score-urls.json `.shows` map
 * @returns {string|null}
 */
function showScoreUrlForShow(show, urlMap) {
  if (!show) return null;
  if (urlMap && typeof urlMap[show.id] === 'string' && urlMap[show.id]) {
    return urlMap[show.id];
  }
  if (!show.title) return null;
  const slug = String(show.title)
    .toLowerCase()
    .replace(/['’.]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!slug) return null;
  const cat = String(show.category || '').toLowerCase();
  const section = cat === 'off-broadway' ? 'off-broadway-shows' : 'broadway-shows';
  return `https://www.show-score.com/${section}/${slug}`;
}

/**
 * Extract candidate external review URLs from a Show Score page's HTML.
 * Pulls both JSON-LD `"url":"https://…"` values and anchor hrefs, drops
 * Show Score's own host. Filtering to actual reviews is the caller's job.
 *
 * @param {string} html
 * @returns {string[]} de-duplicated external URLs
 */
function extractShowScoreReviewUrls(html) {
  if (!html || typeof html !== 'string') return [];
  const urls = new Set();
  const add = (u) => {
    if (!u || !/^https?:\/\//i.test(u)) return;
    let host;
    try { host = new URL(u).hostname; } catch { return; }
    if (SS_HOSTS.test(host)) return; // skip Show Score's own links
    urls.add(u.split('#')[0]);
  };
  for (const m of html.matchAll(/"url"\s*:\s*"(https?:\/\/[^"]+)"/gi)) add(m[1]);
  for (const m of html.matchAll(/href=["'](https?:\/\/[^"']+)["']/gi)) add(m[1]);
  return [...urls];
}

module.exports = { showScoreUrlForShow, extractShowScoreReviewUrls };
