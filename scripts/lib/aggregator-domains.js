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
  'show-score', 'showscore', 'westendtheatre', 'theatre-reviews',
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

module.exports = {
  AGGREGATOR_DOMAINS,
  AGGREGATOR_OUTLET_IDS,
  hostnameOf,
  isAggregatorUrlMismatch,
};
