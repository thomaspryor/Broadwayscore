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
const fs = require('fs');
const path = require('path');
const { foldDiacritics } = require('./title-match');

function canonicalReviewUrl(url) {
  if (!url || typeof url !== 'string') return '';
  return url.split('#')[0].split('?')[0].replace(/\/+$/, '').toLowerCase();
}

/** Outlet key for grouping — a URL is a review's identity WITHIN an outlet.
 * Prefer the `<outletId>--<critic>.json` filename prefix (the CANONICAL outlet id
 * used at write time) over the free-text `r.outlet` DISPLAY field, then normalize
 * to lowercase-alphanumeric. The display field is inconsistent — the same outlet
 * appears as "WhatsOnStage" and "What's On Stage", which would split one byline
 * cluster into two groups and leave a member uncollapsed (the theo-bosanquet leak,
 * 2026-07-05). Grouping by outlet stops false clusters on aggregator roundup URLs
 * legitimately shared across outlets (Telegraph/FT/Guardian star-stubs on one
 * WET/Show-Score roundup) — see feedback_aggregator_roundup_urls_shared_across_outlets. */
function outletOf(r) {
  const f = r && r.file;
  let raw = (typeof f === 'string' && f.includes('--')) ? f.split('--')[0] : ((r && r.outlet) || '');
  return foldDiacritics(String(raw)).toLowerCase().replace(/[^a-z0-9]/g, '');
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

/**
 * Walk duplicateOf pointers to the terminal (non-duplicate) file. Bounded so a
 * pre-existing cycle among siblings can't loop forever.
 *
 * rebuild-all-reviews.js's duplicateOf resolution only walks ONE hop back — a
 * file whose duplicateOf target is ITSELF a duplicate is not excluded there,
 * so it leaks into reviews.json as a second scored copy of the same content
 * (BRO-1391). Pointing a fresh promotion at whatever sibling readdir happens
 * to return first — rather than that sibling's own terminal canonical —
 * would build exactly that chain.
 */
function resolveTerminalCanonical(showDir, filename) {
  const seen = new Set();
  let current = filename;
  for (let hops = 0; hops < 10; hops++) {
    if (seen.has(current)) return current; // pre-existing cycle among siblings — stop, don't chase forever
    seen.add(current);
    let data;
    try {
      data = JSON.parse(fs.readFileSync(path.join(showDir, current), 'utf8'));
    } catch {
      return current; // unreadable — return what we have rather than throw
    }
    if (!data.duplicateOf || !data.duplicateOf.endsWith('.json') || !fs.existsSync(path.join(showDir, data.duplicateOf))) {
      return current;
    }
    current = data.duplicateOf;
  }
  return current;
}

/**
 * Is `url` already promoted for this show+outlet under a DIFFERENT filename?
 * Rotating-byline outlets (Times UK, WhatsOnStage — a "more from our critics"
 * recirc widget) return a different extracted critic name for the SAME url on
 * different fetches, so a naive "does the target filename already exist"
 * collision check misses this entirely and each fetch mints a new
 * {outlet}--{critic}.json primary (BRO-1391 byline-explosion root cause).
 * Scans the show's review-texts dir for a sibling `{outletId}--*.json` whose
 * own url canonicalizes to the same value, and resolves through any
 * duplicateOf chain to the terminal canonical.
 *
 * @param {string} reviewTextsRoot - absolute (or cwd-relative) path to the review-texts root
 * @returns {string|null} the terminal canonical filename, or null if `url` isn't promoted yet under this outlet
 */
function findExistingFileForUrl(reviewTextsRoot, showId, outletId, url) {
  const showDir = path.join(reviewTextsRoot, showId);
  if (!fs.existsSync(showDir)) return null;
  const target = canonicalReviewUrl(url);
  if (!target) return null;
  const prefix = `${outletId}--`;
  for (const f of fs.readdirSync(showDir)) {
    if (!f.endsWith('.json') || !f.startsWith(prefix)) continue;
    try {
      const existing = JSON.parse(fs.readFileSync(path.join(showDir, f), 'utf8'));
      if (canonicalReviewUrl(existing.url) === target) return resolveTerminalCanonical(showDir, f);
    } catch { /* unreadable/corrupt sibling — skip */ }
  }
  return null;
}

module.exports = { canonicalReviewUrl, findUrlClusters, outletOf, resolveTerminalCanonical, findExistingFileForUrl };
