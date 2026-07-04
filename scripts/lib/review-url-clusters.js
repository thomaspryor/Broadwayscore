/**
 * review-url-clusters.js
 *
 * Detects "byline-explosion" clusters: one review URL scraped many times and
 * filed under many DIFFERENT extracted critic names. Existing dup audits key on
 * (show | outlet | criticName), so N files sharing a URL but carrying N distinct
 * bylines look like N separate reviews and slip through — the pathology that
 * buried the correct WhatsOnStage review for the 2026 Regent's Park + Globe
 * "A Midsummer Night's Dream" productions (same-title collision, 2026-07-01).
 *
 * A cluster is high-signal because a single real review has ONE canonical URL:
 * if that URL appears under 5+ byline files, the extractor mangled the page and
 * the review is almost certainly mis-deduped and often suppressed (invalid tier
 * + circular duplicateOf), so it never scores.
 *
 * Pure + data-free so it unit-tests against fixtures (CLAUDE rule 15).
 */

/** Strip query/hash/trailing slash so scrape-variant URLs collapse. */
function canonicalReviewUrl(url) {
  if (!url || typeof url !== 'string') return '';
  return url.split('#')[0].split('?')[0].replace(/\/+$/, '').toLowerCase();
}

/**
 * @param {Array<{file?:string, url?:string, criticName?:string, contentTier?:string}>} reviews
 * @param {number} threshold  minimum files sharing one URL to flag (default 5)
 * @returns {Array<{url:string, count:number, bylines:string[], invalidCount:number, files:string[]}>}
 */
function findUrlClusters(reviews, threshold = 5) {
  const byUrl = new Map();
  for (const r of reviews || []) {
    const u = canonicalReviewUrl(r && r.url);
    if (!u) continue;
    if (!byUrl.has(u)) byUrl.set(u, []);
    byUrl.get(u).push(r);
  }
  const clusters = [];
  for (const [url, group] of byUrl) {
    if (group.length < threshold) continue;
    const bylines = [...new Set(group.map(r => (r.criticName || r.critic || 'unknown')))];
    clusters.push({
      url,
      count: group.length,
      bylines,
      invalidCount: group.filter(r => r.contentTier === 'invalid').length,
      files: group.map(r => r.file).filter(Boolean),
    });
  }
  return clusters.sort((a, b) => b.count - a.count);
}

module.exports = { canonicalReviewUrl, findUrlClusters };
