/**
 * Shared Review File Writer
 *
 * Single entry point for aggregator scrapers to create or merge review files.
 * Replaces 8 duplicate save functions with consistent guards and merge logic.
 *
 * Guards (always run):
 * - isJunkOutlet() — reject garbage outlet names
 * - validateUrlDomain() — reject URLs that don't match outlet's registered domain
 * - normalizeOutlet() — consistent outlet ID (skipped when input.outletId provided)
 * - safeWriteReview() — preserve scored/collected fields on overwrite
 * - classifyContentTier() — tag new files with content tier
 *
 * Used by: scrape-playbill-verdict, scrape-bww-reviews, scrape-bww-roundups,
 * scrape-dtli, scrape-nyc-theatre-roundups, scrape-london-box-office-roundups,
 * scrape-westendtheatre-roundups, re-extract-aggregator-reviews.
 */

const fs = require('fs');
const path = require('path');
const {
  normalizeOutlet,
  normalizeCritic,
  generateReviewFilename,
  findExistingReviewFile,
  isJunkOutlet,
  isSuspiciousOutletId,
  maybeUpgradeUrl,
  getOutletDisplayName,
  resolveOutletFromUrl,
  loadOutletRegistry,
} = require('./review-normalization');
const { validateUrlDomain } = require('./url-discovery');
const { safeWriteReview } = require('./review-write-guard');
const { classifyContentTier } = require('./content-quality');

const DEFAULT_REVIEW_TEXTS_DIR = path.join(__dirname, '..', '..', 'data', 'review-texts');

/**
 * Create or merge a review file with consistent guards.
 *
 * @param {string} showId
 * @param {object} input
 * @param {string} input.outlet - Raw outlet name (normalized internally)
 * @param {string} [input.outletId] - Pre-normalized outlet ID (skips normalizeOutlet if provided)
 * @param {string} [input.criticName='Unknown'] - Critic name
 * @param {string} [input.url] - Review URL
 * @param {string} input.source - Source identifier (e.g. 'bww-roundup', 'dtli')
 * @param {object} [input.fields={}] - Scraper-specific fields to set/merge
 * @param {object} [options]
 * @param {boolean} [options.dryRun=false] - Don't write files
 * @param {function} [options.onMerge] - (existing, input) => mutate existing; return false to abort write
 * @param {string} [options.reviewTextsDir] - Override default review-texts directory
 * @returns {{ action: 'new'|'updated'|'skipped', reason?: string, filepath?: string }}
 */
function createOrMergeReviewFile(showId, input, options = {}) {
  const { dryRun = false, onMerge, reviewTextsDir = DEFAULT_REVIEW_TEXTS_DIR } = options;
  const fields = input.fields || {};

  // --- Guard: normalize outlet ---
  let outletId = input.outletId || normalizeOutlet(input.outlet);
  if (!outletId) return { action: 'skipped', reason: 'no-outlet' };

  // URL-based outlet refinement for shared-domain outlets.
  // Some outlets share a domain but serve different markets via URL path
  // (e.g. timeout.com: /newyork → timeout, /london → timeout-london).
  // The URL path is more authoritative than the outlet display name scraped from HTML,
  // which may be ambiguous (e.g. "Time Out" resolves to "timeout" regardless of market).
  if (input.url) {
    const urlResolved = resolveOutletFromUrl(input.url);
    if (urlResolved && urlResolved.outletId !== outletId) {
      const registry = loadOutletRegistry();
      const urlOutlet = registry?.outlets?.[urlResolved.outletId];
      const nameOutlet = registry?.outlets?.[outletId];
      if (urlOutlet && nameOutlet && urlOutlet.domain === nameOutlet.domain) {
        // Same domain, different path-based outlet — URL is authoritative
        outletId = urlResolved.outletId;
      }
    }
  }

  // --- Guard: junk outlet ---
  if (isJunkOutlet(outletId) || isJunkOutlet(input.outlet)) {
    return { action: 'skipped', reason: 'junk-outlet' };
  }

  // --- Guard: sentence-fragment outlet IDs ---
  if (isSuspiciousOutletId(outletId)) {
    console.warn(`  ⚠️  Skipping suspicious outlet ID: "${outletId}" (likely sentence fragment from roundup parsing)`);
    return { action: 'skipped', reason: 'suspicious-outlet-id' };
  }

  // --- Guard: domain validation ---
  const domainCheck = validateUrlDomain(input.url, outletId);
  if (!domainCheck.valid) {
    return { action: 'skipped', reason: `domain-mismatch: ${domainCheck.reason}` };
  }

  const criticName = input.criticName || 'Unknown';
  const criticSlug = normalizeCritic(criticName);
  const showDir = path.join(reviewTextsDir, showId);

  // --- Try to find existing file ---
  // Use the (possibly URL-refined) outletId for the filename, not the raw input.outletId
  const filename = generateReviewFilename(outletId, criticName);
  const filepath = path.join(showDir, filename);

  // Cross-scraper dedup: find by outlet+critic regardless of filename format.
  // Use the refined outletId (not input.outlet) so URL-based disambiguation is respected —
  // e.g. after refinement, outletId='timeout-london' not 'timeout' for timeout.com/london URLs.
  const existing = findExistingReviewFile(showDir, outletId, criticName !== 'Unknown' ? criticName : null);

  if (existing && existing.data) {
    return _mergeIntoExisting(existing.path, existing.data, { showId, outletId, input, fields, criticName, dryRun, onMerge });
  }

  // Belt-and-suspenders: exact filename fallback
  if (fs.existsSync(filepath)) {
    try {
      const data = JSON.parse(fs.readFileSync(filepath, 'utf8'));
      return _mergeIntoExisting(filepath, data, { showId, outletId, input, fields, criticName, dryRun, onMerge });
    } catch { /* unreadable — fall through to create */ }
  }

  // --- Create new file ---
  const outletDisplay = getOutletDisplayName(outletId) || input.outlet || outletId;
  const newReview = {
    showId,
    outletId,
    outlet: outletDisplay,
    criticName,
    url: input.url || null,
    source: input.source,
    sources: [input.source],
    ...fields,
  };

  // Classify content tier
  const tierResult = classifyContentTier(newReview);
  if (tierResult && tierResult.contentTier) {
    newReview.contentTier = tierResult.contentTier;
  }

  if (!dryRun) {
    if (!fs.existsSync(showDir)) {
      fs.mkdirSync(showDir, { recursive: true });
    }
    safeWriteReview(filepath, newReview, { merge: false });
  }

  return { action: 'new', filepath };
}

/**
 * Merge incoming data into an existing review file.
 * @private
 */
function _mergeIntoExisting(filepath, existing, ctx) {
  const { input, fields, dryRun, onMerge } = ctx;
  let changed = false;

  // Default field merge: set scraper-specific fields if existing value is falsy
  for (const [key, val] of Object.entries(fields)) {
    if (val != null && !existing[key]) {
      existing[key] = val;
      changed = true;
    }
  }

  // URL upgrade
  if (input.url && maybeUpgradeUrl(existing, input.url, input.source)) {
    changed = true;
  }
  if (input.url && !existing.url) {
    existing.url = input.url;
    changed = true;
  }

  // Custom merge callback — scraper can mutate existing, return false to abort
  if (onMerge) {
    const result = onMerge(existing, input);
    if (result === false) {
      return { action: 'skipped', reason: 'onMerge-aborted', filepath };
    }
    // If onMerge ran, assume it made changes
    changed = true;
  }

  // Update sources array
  if (input.source) {
    const sources = new Set(existing.sources || [existing.source || '']);
    sources.add(input.source);
    existing.sources = Array.from(sources).filter(Boolean);
    if (existing.sources.length > (existing._prevSourcesLen || 0)) {
      changed = true;
    }
  }
  delete existing._prevSourcesLen;

  if (!changed) {
    return { action: 'skipped', reason: 'no-changes', filepath };
  }

  if (!dryRun) {
    safeWriteReview(filepath, existing, { merge: false });
  }

  return { action: 'updated', filepath };
}

module.exports = { createOrMergeReviewFile };
