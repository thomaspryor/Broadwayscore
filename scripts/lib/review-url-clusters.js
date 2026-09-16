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
 * `excludeFilename` skips the caller's OWN in-progress file (BRO-3550 ship-check):
 * without it, a caller whose file already lives in the same show dir being
 * scanned (collect-review-texts.js's rename path — unlike the _pending drain,
 * where the file being promoted still lives elsewhere) can match ITSELF on the
 * very first readdir hit and return early, silently skipping every OTHER
 * sibling that might share the url. Excluding it lets the scan continue past
 * a trivial self-match to find a genuine duplicate elsewhere in the directory.
 *
 * @param {string} reviewTextsRoot - absolute (or cwd-relative) path to the review-texts root
 * @param {string} [excludeFilename] - basename to skip while scanning (the caller's own file)
 * @returns {string|null} the terminal canonical filename, or null if `url` isn't promoted yet under this outlet
 */
function findExistingFileForUrl(reviewTextsRoot, showId, outletId, url, excludeFilename = null) {
  const showDir = path.join(reviewTextsRoot, showId);
  if (!fs.existsSync(showDir)) return null;
  const target = canonicalReviewUrl(url);
  if (!target) return null;
  const prefix = `${outletId}--`;
  for (const f of fs.readdirSync(showDir)) {
    if (f === excludeFilename) continue;
    if (!f.endsWith('.json') || !f.startsWith(prefix)) continue;
    try {
      const existing = JSON.parse(fs.readFileSync(path.join(showDir, f), 'utf8'));
      if (canonicalReviewUrl(existing.url) === target) return resolveTerminalCanonical(showDir, f);
    } catch { /* unreadable/corrupt sibling — skip */ }
  }
  return null;
}

/**
 * Decide what a critic-name-override rename should do about a url already
 * promoted under a DIFFERENT filename (findExistingFileForUrl's result).
 * Ship-check (BRO-3550, Codex adversarial review) flagged that unconditionally
 * marking duplicate on any same-url sibling can bury a substantive recovered
 * review under an empty/near-empty byline-extraction stub, and can silently
 * override a prior deliberate `_duplicateOfCleared` clear (two critics
 * genuinely sharing one Guardian/BWW url). `shouldMarkDuplicate` is injected
 * — same DI pattern as this file's `resolveTerminalCanonical` callers and
 * review-write-guard.js's `wouldFormDuplicateCycle` — so this stays
 * dependency-free of review-write-guard.js; pass its
 * `shouldMarkUrlCollisionDuplicate` (the same body-length/quality/
 * _duplicateOfCleared decision `safeWriteReview`'s own URL-collision path
 * already uses) at the call site.
 *
 * @param {object} params
 * @param {string} params.currentFile - basename of the file being renamed
 * @param {string} params.newFilename - the freshly-computed rename target
 * @param {string|null} params.existingSameUrl - findExistingFileForUrl's result
 * @param {object} params.newData - the in-memory data about to be written
 * @param {object|null} params.colliderData - existingSameUrl's parsed data, or null if unreadable
 * @param {(newData:object, colliderData:object|null) => boolean} params.shouldMarkDuplicate
 * @returns {{duplicateOf:string, duplicateReason:string}|null}
 */
function decideSameUrlDifferentFileGuard({ currentFile, newFilename, existingSameUrl, newData, colliderData, shouldMarkDuplicate }) {
  if (!existingSameUrl || existingSameUrl === currentFile || existingSameUrl === newFilename) return null;
  if (!shouldMarkDuplicate(newData, colliderData)) return null;
  return { duplicateOf: existingSameUrl, duplicateReason: 'same-url-different-byline-extraction' };
}

module.exports = { canonicalReviewUrl, findUrlClusters, outletOf, resolveTerminalCanonical, findExistingFileForUrl, decideSameUrlDifferentFileGuard };
