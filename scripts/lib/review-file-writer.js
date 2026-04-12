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
const { pickRerouteTarget } = require('./review-guards');

const DEFAULT_REVIEW_TEXTS_DIR = path.join(__dirname, '..', '..', 'data', 'review-texts');
const SHOWS_PATH = path.join(__dirname, '..', '..', 'data', 'shows.json');

// ─── Lazy-loaded sibling lookup for cross-market contamination prevention ───
// Loaded once on first use, cached for the process lifetime.
let _siblingCache = null;
function _getSiblingData() {
  if (_siblingCache) return _siblingCache;
  try {
    const shows = require(SHOWS_PATH).shows;
    // Group by normalized title
    const byTitle = {};
    for (const s of shows) {
      const t = (s.title || '').toLowerCase().trim().replace(/[!?.,'"]/g, '');
      if (!t) continue;
      (byTitle[t] = byTitle[t] || []).push(s);
    }
    // Build map: showId → {openingDate, siblings: [{id, openingDate}]}
    const map = new Map();
    for (const s of shows) {
      const t = (s.title || '').toLowerCase().trim().replace(/[!?.,'"]/g, '');
      const sibs = (byTitle[t] || []).filter(x => x.id !== s.id);
      if (sibs.length) {
        const yearMatch = s.id.match(/-(\d{4})$/);
        const showYear = yearMatch ? parseInt(yearMatch[1]) : null;
        const opening = s.openingDate ? new Date(s.openingDate) : null;
        map.set(s.id, {
          showYear,
          openingDate: opening && !isNaN(opening.getTime()) ? opening : null,
          siblings: sibs.map(x => {
            const ym = x.id.match(/-(\d{4})$/);
            const sibOpening = x.openingDate ? new Date(x.openingDate) : null;
            return {
              id: x.id,
              year: ym ? parseInt(ym[1]) : null,
              openingDate: sibOpening && !isNaN(sibOpening.getTime()) ? sibOpening : null,
            };
          }).filter(x => x.year || x.openingDate),
        });
      }
    }
    _siblingCache = map;
    return map;
  } catch {
    // shows.json not available (e.g. CI without core data) — disable guard
    _siblingCache = new Map();
    return _siblingCache;
  }
}

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
  const { dryRun = false, onMerge, reviewTextsDir = DEFAULT_REVIEW_TEXTS_DIR, _rerouteVisited } = options;
  const fields = input.fields || {};

  // --- Guard: normalize outlet ---
  let outletId = input.outletId || normalizeOutlet(input.outlet);
  if (!outletId) return { action: 'skipped', reason: 'no-outlet' };

  // URL-based outlet refinement. The URL is objective ground truth;
  // aggregator-supplied outlet labels can be wrong. Two cases:
  //   1. Same-domain, path-based split (e.g. timeout.com /newyork vs /london)
  //   2. Cross-domain misattribution (e.g. an aggregator credits a theguardian.com
  //      URL to "Observer" — the URL domain wins).
  // See: DTLI misattributed a Guardian review as Observer on cats-the-jellicle-ball-2026
  // (Apr 2026). That created a duplicate file and a cross-market validation failure.
  if (input.url) {
    const urlResolved = resolveOutletFromUrl(input.url);
    if (urlResolved && urlResolved.outletId !== outletId) {
      const registry = loadOutletRegistry();
      const urlOutlet = registry?.outlets?.[urlResolved.outletId];
      const nameOutlet = registry?.outlets?.[outletId];
      if (urlOutlet && nameOutlet && urlOutlet.domain === nameOutlet.domain) {
        // Case 1: same domain, path-based disambiguation — URL is authoritative
        outletId = urlResolved.outletId;
      } else if (urlOutlet) {
        // Case 2: cross-domain. URL points to a known outlet's domain, so the
        // aggregator-supplied name-derived outletId is a misattribution.
        // Prefer the URL, log the correction.
        console.warn(`  ⚠️  Outlet mismatch for ${showId}: URL=${urlResolved.outletId} (${input.url}) vs name=${outletId}. Preferring URL.`);
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

  // --- Guard A: Cross-market sibling reroute ---
  // If this review's publish date matches a sibling production's opening better
  // than the target show, reroute it. Prevents WE reviews from landing in BW
  // folders (and vice versa).
  // Two-tier detection: (1) full-date comparison when opening dates available
  // (catches shows separated by <2 years, like oh-mary BW 2024 / WE 2025),
  // (2) year-level fallback via pickRerouteTarget for older shows without dates.
  // _rerouteVisited prevents infinite recursion if two siblings point to each other.
  // Added 2026-04-12 after Oh Mary audit found 57 cross-market contamination cases.
  if (input.publishDate || (input.fields && input.fields.publishDate)) {
    const pubDateStr = input.publishDate || input.fields?.publishDate;
    const sibData = _getSiblingData().get(showId);
    if (sibData && sibData.siblings.length) {
      // Guard: only accept string dates (not epoch numbers that would parse as 1970)
      const pubStr = typeof pubDateStr === 'string' ? pubDateStr : null;
      const cleaned = (pubStr || '').replace(/(\d+)(?:st|nd|rd|th)\b/g, '$1');
      const reviewDate = cleaned ? new Date(cleaned) : null;
      const reviewValid = reviewDate && !isNaN(reviewDate.getTime()) && reviewDate.getFullYear() >= 1970;

      const visited = _rerouteVisited || new Set();
      visited.add(showId);

      // Tier 1: Full-date comparison (days-level precision)
      if (reviewValid && sibData.openingDate) {
        const DAY = 86400000;
        const distToCurrent = Math.abs(reviewDate - sibData.openingDate) / DAY;
        let bestSib = null;
        for (const sib of sibData.siblings) {
          if (!sib.openingDate || visited.has(sib.id)) continue;
          const distToSib = Math.abs(reviewDate - sib.openingDate) / DAY;
          // Sibling is much closer (>90 day gap AND sibling within 30 days)
          if (distToSib <= 30 && distToCurrent > 90) {
            if (!bestSib || distToSib < bestSib.dist) {
              bestSib = { id: sib.id, dist: distToSib, currentDist: distToCurrent };
            }
          }
        }
        if (bestSib) {
          console.warn(`  ⚠️  Cross-market reroute: ${showId} → ${bestSib.id} (review ${pubDateStr} is ${Math.round(bestSib.dist)}d from sibling vs ${Math.round(bestSib.currentDist)}d from current)`);
          return createOrMergeReviewFile(bestSib.id, input, { ...options, _rerouteVisited: visited });
        }
      }

      // Tier 2: Year-level fallback (for shows without opening dates)
      if (reviewValid && sibData.showYear) {
        const reviewYear = reviewDate.getFullYear();
        const reroute = pickRerouteTarget(sibData.showYear, sibData.siblings, reviewYear);
        if (reroute.action === 'reroute' && !visited.has(reroute.targetShowId)) {
          console.warn(`  ⚠️  Cross-market reroute (year): ${showId} → ${reroute.targetShowId} (review year ${reviewYear})`);
          return createOrMergeReviewFile(reroute.targetShowId, input, { ...options, _rerouteVisited: visited });
        }
      }
    }
  }

  // --- Guard E: BWW Review-Roundup page detection ---
  // If the URL IS a BWW Review-Roundup page itself (not a review discovered FROM
  // a roundup), auto-flag it. The CI audit (audit-review-contamination.js) catches
  // these after the fact, but this prevents them at write time.
  // Distinct from isRoundupUrl() which handles site-specific aggregator roundup pages.
  if (input.url && /\/article\/Review-Roundup-/i.test(input.url)) {
    // Allow through but mark as roundup so rebuild excludes from scoring
    fields.isRoundupArticle = true;
    fields.roundupArticleReason = 'auto: URL matches BWW Review-Roundup page pattern';
  }

  // --- Guard F: Empty unknown rejection ---
  // Don't create files for unknown critics with no URL and no text content.
  // These are pure scrape garbage that clutter the directory.
  const criticName = input.criticName || 'Unknown';
  if (criticName === 'Unknown' && !input.url && !fields.fullText && !fields.bwwExcerpt
      && !fields.dtliExcerpt && !fields.showScoreExcerpt && !fields.nycTheatreExcerpt
      && !fields.stagedoorExcerpt && !fields.lboRoundupExcerpt) {
    return { action: 'skipped', reason: 'empty-unknown: no URL, no text, unknown critic' };
  }
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
