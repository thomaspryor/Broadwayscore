/**
 * Infer a registry `domain` value for an outlet from URLs seen on its review
 * files. Shared by the two places that auto-register outlets into
 * data/outlet-registry.json (scripts/rebuild-all-reviews.js's post-build
 * auto-register pass, and scripts/audit-outlet-registry.js --update) so
 * neither one writes `domain: null` when a real domain is derivable —
 * that vacuous default is what let the SERP host guard in
 * scripts/lib/url-discovery.js pass any host for a "domainless" outlet
 * (task #766).
 *
 * Caveat: this is a majority-vote heuristic over whatever URLs already exist
 * for the outlet, filtered through the same blocked-host list the SERP guard
 * uses. It's a strictly better default than null for a BRAND NEW outlet with
 * a clean history (which is what it's used for above). It is NOT a reliable
 * way to backfill an already-registered, long-domainless outlet whose archive
 * has accumulated years of wrong-host misattribution — a real-data check
 * during the #766 re-triage found it would pick skiddle.com (a ticketing
 * site, since blocked) or louderthanwar.com (an unrelated music webzine) for
 * click-liverpool depending on which junk host had more hits, and
 * islingtontribune.co.uk (a different real publication) over tribune's actual
 * domain tribunemag.co.uk. Those 12 legacy outlets were backfilled by hand
 * with external verification instead; don't re-run --update over the existing
 * registry expecting it to safely fill them in.
 */

const { isBlockedReviewUrl } = require('./domain-filters');

/**
 * @param {string[]} urls - review URLs seen for one outletId (any order, may include blocked/junk hosts)
 * @returns {string|null} the most common non-blocked hostname, or null if none qualify
 */
function inferOutletDomainHint(urls) {
  const counts = {};
  for (const url of urls || []) {
    if (!url) continue;
    if (isBlockedReviewUrl(url)) continue;
    let hostname;
    try {
      hostname = new URL(url).hostname.replace(/^www\./, '');
    } catch {
      continue;
    }
    if (!hostname) continue;
    counts[hostname] = (counts[hostname] || 0) + 1;
  }
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  return sorted.length > 0 ? sorted[0][0] : null;
}

module.exports = { inferOutletDomainHint };
