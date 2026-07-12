/**
 * Outlet identity for aggregator-archive cache rows (WET, TR, SD, TS, LBO).
 *
 * Cache rows store outletIds computed at scrape time. Rows cached during the
 * domain-collision era carry stale URL-derived mappings (e.g. sunday-telegraph
 * for telegraph.co.uk URLs — card 39b637c5-416f-81bb), and every re-ingest
 * faithfully reproduces the stale ID.
 *
 * Re-resolving EVERY row's URL is not safe: WET star-rating rows carry the
 * roundup page itself as `url` (would mis-home Guardian/Times rows to
 * westendtheatre), and old caches have label/URL row misalignment (Observer
 * columns with theguardian.com URLs). So the URL only overrides the
 * cached/label-derived ID when:
 *   - the fallback ID is not a registered outlet (junk scrape-era slug), or
 *   - the fallback outlet itself claims the URL's domain — proof the cached ID
 *     was URL-derived under the old collision resolver and may be stale.
 * The aggregator's own outlet ID never wins via URL: that URL is the roundup
 * page, not the review.
 */
const {
  normalizeOutlet,
  resolveOutletFromUrl,
  getOutletFromRegistry,
} = require('./review-normalization');

function resolveArchiveRowOutletId({ url, outletLabel, cachedOutletId, sourceOutletId }) {
  const fallback = cachedOutletId || normalizeOutlet(outletLabel || '');
  if (!url) return fallback;

  let resolved = null;
  try { resolved = resolveOutletFromUrl(url); } catch { /* malformed URL */ }
  if (!resolved || resolved.outletId === fallback) return fallback;
  if (sourceOutletId && resolved.outletId === sourceOutletId) return fallback;

  const fallbackEntry = getOutletFromRegistry(fallback);
  if (!fallbackEntry) return resolved.outletId;

  let host;
  try { host = new URL(url).hostname.replace(/^www\./, '').toLowerCase(); } catch { return fallback; }
  const claimedDomains = [fallbackEntry.domain, ...(fallbackEntry.domainAliases || [])]
    .filter(Boolean)
    .map((d) => String(d).replace(/^www\./, '').toLowerCase());
  const fallbackClaimsHost = claimedDomains.some((d) => host === d || host.endsWith(`.${d}`));
  return fallbackClaimsHost ? resolved.outletId : fallback;
}

module.exports = { resolveArchiveRowOutletId };
