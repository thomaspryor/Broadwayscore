/**
 * Canonical aggregator domain + outlet-id sets, shared between the ingest path
 * (gather-reviews.js / poller) and the validator (validate-review-texts.js).
 *
 * THE CLASS THIS PREVENTS
 * serp-discovery (and other ingest paths) could write a review-text stub whose
 * `url` is on an aggregator domain (e.g. theatre.reviews) but whose `outletId`
 * is a real outlet (e.g. chichester-observer). That is contamination: the
 * aggregator URL is a roundup, not that outlet's review. validate-review-texts.js
 * flags it as an `aggregator_url_mismatch` ERROR and it held main red for 2 days
 * (one instance deleted 2026-06-15, commit 3d54cb4797). The fix is to refuse to
 * write the file in the first place — see isAggregatorUrlMismatch().
 *
 * Co-maintain these sets with AGGREGATOR_SCORE_SOURCES in review-normalization.js.
 *
 * NOTE (2026-06-21): the live West End aggregator is westendtheatre.COM, but this
 * set carries westendtheatre.co.uk to stay byte-identical with the historical
 * validate-review-texts.js sets (parity). Adding .com here would make the
 * validator flag existing WET star-stubs (real outletId + westendtheatre.com url
 * + stored stars) as aggregator_url_mismatch ERRORs and could turn main red — a
 * separate decision, deliberately out of scope for this guard.
 */

const { normalizeOutlet } = require('./review-normalization');

// Known aggregator domains (hostname with leading www. stripped, lowercased).
const AGGREGATOR_DOMAINS = new Set([
  'show-score.com', 'showscore.com',
  'westendtheatre.co.uk',
  'theatrereviews.wordpress.com', 'theatre.reviews',
  'didtheylikeit.com',
  'londonboxoffice.co.uk',
  'nyctheatre.com',
  'stagedoor.com',
]);

// Outlet IDs that ARE aggregators — a file with one of these outletIds pointing
// at the matching aggregator domain is legitimate, not contamination.
const AGGREGATOR_OUTLET_IDS = new Set([
  'show-score', 'showscore', 'westendtheatre',
  // 'theatre-reviews' is NOT a registry id — it never has been. The live outlet
  // is 'theatre-reviews-limited' (domain theatrereviews.com). Because the dead
  // spelling was the only one listed, isAggregatorUrlMismatch() classified a
  // GENUINE theatre.reviews aggregator record as contamination: the URL host is
  // in AGGREGATOR_DOMAINS but the outletId was not in this set, so the write
  // guard refused it and validate-review-texts.js would error on it (verified
  // 2026-08-09: isAggregatorUrlMismatch(TR url, 'theatre-reviews-limited') was
  // true). Adding an id here only ever makes those checks MORE permissive, so
  // this cannot turn main red. The dead spelling stays as a harmless alias.
  'theatre-reviews', 'theatre-reviews-limited',
  'dtli', 'london-box-office', 'lbo', 'nyc-theatre', 'stagedoor',
  'playbill-verdict', 'bww-roundup',
]);

/**
 * Normalize a hostname from a URL: strip leading www., lowercase.
 * Returns null if the URL is unparseable (caller should not treat as a mismatch).
 */
function hostnameOf(url) {
  if (!url || typeof url !== 'string') return null;
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
}

/**
 * True when `url`'s hostname is a known aggregator domain but `outletId` is a
 * real outlet (NOT itself an aggregator). This is exactly the condition
 * validate-review-texts.js flags as an aggregator_url_mismatch ERROR.
 *
 * Returns false for: non-aggregator URLs, aggregator URLs whose outletId is
 * itself an aggregator (legit), missing url/outletId, and unparseable URLs.
 */
function isAggregatorUrlMismatch(url, outletId) {
  if (!outletId) return false;
  const hostname = hostnameOf(url);
  if (!hostname) return false;
  // Normalize the outletId the same way the validator does (normalizeOutletId →
  // normalizeOutlet). Callers may pass a raw, capitalized, or aliased outletId
  // (e.g. "Show-Score") — without this, a legit aggregator outlet would look like
  // a real outlet and be mis-flagged as a mismatch. The ingest guard already
  // passes a normalized id, so this is idempotent there.
  const normId = normalizeOutlet(outletId) || outletId;
  return AGGREGATOR_DOMAINS.has(hostname) && !AGGREGATOR_OUTLET_IDS.has(normId);
}

// `source` values that mean a review was discovered via an aggregator roundup.
// These legitimately carry the aggregator's URL at ingest (they get the outlet's
// own URL later, or are stored as aggregatorStars star-stubs). Single source of
// truth shared by both URL guards in gather-reviews.js createReviewFile.
function isAggregatorReviewSource(source) {
  if (!source || typeof source !== 'string') return false;
  return (
    source.startsWith('westendtheatre') ||
    source.startsWith('theatre-reviews') ||
    source.startsWith('stagedoor') ||
    source.startsWith('thestage-roundup') ||
    source.startsWith('lbo') ||
    source === 'show-score' ||
    source === 'dtli'
  );
}

/**
 * Should createReviewFile REFUSE to write this review because it would create an
 * aggregator_url_mismatch contamination file?
 *
 * Block ONLY the contamination class: a non-aggregator-source path (serp-discovery,
 * generic/manual) attaching an aggregator-domain URL to a real outlet with NO score
 * to preserve. We must NOT block:
 *   - aggregator-source writes (they legitimately carry the aggregator URL), nor
 *   - any write carrying a real star/score (blocking would drop a legit aggregator
 *     star-stub — the regression caught in review 2026-06-21).
 *
 * @param {object} reviewData - {source, originalScore, aggregatorStars, url}
 * @param {string} normalizedOutletId
 */
function shouldSkipAggregatorUrlWrite(reviewData, normalizedOutletId) {
  if (!reviewData) return false;
  if (isAggregatorReviewSource(reviewData.source)) return false;
  const hasScore = reviewData.originalScore != null || reviewData.aggregatorStars != null;
  if (hasScore) return false;
  return isAggregatorUrlMismatch(reviewData.url, normalizedOutletId);
}

/**
 * Decision for audit-review-contamination.js class C: is a review's `outletId` a
 * genuine domain mismatch vs the outlet its URL's domain maps to?
 *
 * `expected` is the outlet the URL's domain resolves to (domainToOutlet[domain]);
 * `internalOutlet` is the review's normalized outletId.
 *
 * Returns false (NOT a mismatch) when:
 *  - the domain doesn't resolve to a known outlet (expected falsy),
 *  - it resolves to the same outlet (expected === internalOutlet),
 *  - internalOutlet is a wire service (AP/Reuters/UPI syndicate across domains),
 *  - internalOutlet legitimately publishes on the domain owned by `expected`
 *    (DIRECTIONAL — the Observer publishes on theguardian.com → expected resolves
 *    to "guardian" but the review is legitimately filed under "observer"; the
 *    reverse, a guardian file on observer.com, stays flagged). 2026-06-25 FP on
 *    my-neighbour-totoro-west-end-2025/observer--susannah-clapp,
 *  - the domain resolves to an AGGREGATOR outlet — aggregator ROUNDUP URLs
 *    (westendtheatre.com, show-score.com, stagedoor.com, …) are shared across
 *    every real outlet the roundup covers, so a real-outlet star-stub carrying
 *    the roundup URL is expected, not a misattribution. (2026-06-22: this was the
 *    12 WET false-positives.) Genuine aggregator-URL contamination (real outlet,
 *    no score) is the aggregator_url_mismatch class, blocked at write time.
 *
 * @param {string|undefined} expected - outlet the URL domain maps to
 * @param {string|undefined} internalOutlet - normalized review outletId
 * @param {{wireOutlets?: Set<string>}} [opts]
 */
// Outlets that legitimately publish on ANOTHER outlet's domain. DIRECTIONAL:
// keyed by the domain-owner outlet (what the URL's domain resolves to, i.e.
// `expected`) → the set of outlets that may legitimately carry that domain.
// The Observer publishes on theguardian.com (→ expected 'guardian'), so an
// "observer" file with a theguardian.com URL is fine. The reverse is NOT exempt:
// a "guardian" file whose URL is on observer.com (→ expected 'observer') IS a
// genuine misattribution — `expected` comes from a UNIQUE domain reverse-lookup,
// so 'observer' can only mean an observer.com URL, never theguardian.com.
const SHARED_DOMAIN_OUTLETS = new Map([
  ['guardian', new Set(['observer'])], // theguardian.com hosts Observer reviews
]);

function isSharedDomainOutlet(expected, internalOutlet) {
  return SHARED_DOMAIN_OUTLETS.has(expected)
    && SHARED_DOMAIN_OUTLETS.get(expected).has(internalOutlet);
}

function isOutletDomainMismatch(expected, internalOutlet, opts = {}) {
  if (!expected) return false;
  if (expected === internalOutlet) return false;
  if (opts.wireOutlets && opts.wireOutlets.has(internalOutlet)) return false;
  if (isSharedDomainOutlet(expected, internalOutlet)) return false;
  if (AGGREGATOR_OUTLET_IDS.has(expected)) return false;
  return true;
}

/**
 * Should URL-based outlet refinement REFUSE to rewrite `currentOutletId` into
 * `urlOutletId`, because the URL resolves to an AGGREGATOR outlet?
 *
 * An aggregator's domain hosts ROUNDUP pages citing many outlets, so a URL on
 * that domain is never evidence the aggregator authored the review. Refining
 * would destroy the real outlet's attribution AND launder the contamination past
 * shouldSkipAggregatorUrlWrite(), which permits an aggregator URL precisely when
 * outletId IS the aggregator.
 *
 * Keyed on the resolved OUTLET, not on AGGREGATOR_DOMAINS: that domain set
 * carries westendtheatre.co.uk while the live aggregator (and all 395 corpus
 * files) use westendtheatre.com. Checking the outlet covers both spellings.
 *
 * Returns false when there is nothing to refuse: no resolution, a non-aggregator
 * target, or a current outlet that is ITSELF an aggregator (a genuine aggregator
 * record — refinement there is a no-op or a legitimate alias fix).
 *
 * @param {string|undefined} urlOutletId - outlet the URL resolved to
 * @param {string|undefined} currentOutletId - the review's current outletId
 */
function shouldRefuseAggregatorOutletRefinement(urlOutletId, currentOutletId) {
  if (!urlOutletId || !currentOutletId) return false;
  if (!AGGREGATOR_OUTLET_IDS.has(urlOutletId)) return false;
  const normCurrent = normalizeOutlet(currentOutletId) || currentOutletId;
  return !AGGREGATOR_OUTLET_IDS.has(normCurrent);
}

module.exports = {
  AGGREGATOR_DOMAINS,
  AGGREGATOR_OUTLET_IDS,
  shouldRefuseAggregatorOutletRefinement,
  isAggregatorReviewSource,
  shouldSkipAggregatorUrlWrite,
  isOutletDomainMismatch,
  isSharedDomainOutlet,
  SHARED_DOMAIN_OUTLETS,
  hostnameOf,
  isAggregatorUrlMismatch,
};
