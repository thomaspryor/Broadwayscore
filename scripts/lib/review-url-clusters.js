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

/** Outlet key for grouping — a URL is a review's identity WITHIN an outlet.
 * Prefer an explicit outlet field, else the `<outlet>--<critic>.json` prefix.
 * Grouping by outlet stops false clusters on aggregator roundup URLs that are
 * legitimately shared across outlets (Telegraph/FT/Guardian star-stubs pointing
 * at one WET/Show-Score roundup) — see feedback_aggregator_roundup_urls_shared_across_outlets. */
function outletOf(r) {
  if (r && r.outlet) return String(r.outlet).toLowerCase();
  const f = r && r.file;
  if (typeof f === 'string' && f.includes('--')) return f.split('--')[0].toLowerCase();
  return '';
}

/**
 * @param {Array<{file?:string, url?:string, outlet?:string, criticName?:string, contentTier?:string, duplicateOf?:string}>} reviews
 * @param {number} threshold  minimum files sharing one (outlet,url) to flag (default 5)
 * @returns {Array<{url:string, outlet:string, count:number, primaryCount:number, bylines:string[], invalidCount:number, files:string[]}>}
 *
 * DETECTOR CONTRACT: flags on the RAW file count (a cluster is real regardless of
 * how it was later collapsed). `primaryCount` (files with no `duplicateOf`) is
 * reported alongside so the audit CALLER can distinguish a collapsed/resolved
 * cluster (exactly 1 primary) from a harmful one — remediation logic stays out of
 * the detector (design review, 2026-07-05).
 */
function findUrlClusters(reviews, threshold = 5) {
  const byKey = new Map();
  for (const r of reviews || []) {
    const u = canonicalReviewUrl(r && r.url);
    if (!u) continue;
    const key = `${outletOf(r)}\n${u}`;
    if (!byKey.has(key)) byKey.set(key, { url: u, outlet: outletOf(r), group: [] });
    byKey.get(key).group.push(r);
  }
  const clusters = [];
  for (const { url, outlet, group } of byKey.values()) {
    if (group.length < threshold) continue;
    const bylines = [...new Set(group.map(r => (r.criticName || r.critic || 'unknown')))];
    clusters.push({
      url,
      outlet,
      count: group.length,
      primaryCount: group.filter(r => !r.duplicateOf).length,
      bylines,
      invalidCount: group.filter(r => r.contentTier === 'invalid').length,
      files: group.map(r => r.file).filter(Boolean),
    });
  }
  return clusters.sort((a, b) => b.count - a.count);
}

module.exports = { canonicalReviewUrl, findUrlClusters, outletOf };
