/**
 * Outlet look-alike guard (BRO-4419).
 *
 * A content-farm / scraper host whose name imitates a real outlet
 * (nysepost.com copies NY Post articles; guardianlv.com is "Guardian Liberty
 * Voice", not The Guardian) gets filed under the imitated outlet's id because
 * the outletId comes from an aggregator's LABEL, not from the URL host. The
 * write-path domain guard (validateUrlDomain) already refuses these for
 * outlets with a registered domain, so the residue is (a) files written before
 * that guard, (b) outlets with no registered domain, and (c) hosts nobody has
 * listed yet. This module gives all three one shared, pure decision function:
 *
 *   - LOOKALIKE_CONTENT_FARM_DOMAINS: confirmed imitators. Wired into
 *     domain-filters.js isBlockedReviewUrl(), so discovery, the write path
 *     and the rebuild all refuse them.
 *   - findLookalikeHost(outletId, url, registry): DETECTS a new one — the URL
 *     host is not owned by outletId's registry entry but its registrable label
 *     is within edit distance 2 of the label of a domain the outlet DOES own.
 *     Scoped to the row's own outletId on purpose: comparing against the whole
 *     registry flags gaytimes.com~nytimes.com and other unrelated real outlets.
 *
 * Pure: no I/O, no registry load (callers pass the registry).
 */

const LOOKALIKE_CONTENT_FARM_DOMAINS = new Set([
  'nysepost.com',   // scraped NY Post copy; king-charles-iii-2015 was filed as outletId nypost
  'guardianlv.com', // Guardian Liberty Voice; grey-gardens-2006 was filed as outletId guardian
]);

const MULTIPART_SLD = new Set(['co', 'com', 'org', 'net', 'ac', 'gov', 'me', 'ltd']);

function normalizeHost(host) {
  return String(host || '').replace(/^www\./, '').toLowerCase();
}

function extractHost(url) {
  try { return normalizeHost(new URL(url).hostname); } catch { return null; }
}

/** Registrable label: "nypost.com" -> "nypost", "guardian.co.uk" -> "guardian". */
function hostLabel(host) {
  const parts = normalizeHost(host).split('.').filter(Boolean);
  if (parts.length < 2) return parts[0] || '';
  const tld = parts[parts.length - 1];
  const sld = parts[parts.length - 2];
  if (parts.length >= 3 && tld.length === 2 && MULTIPART_SLD.has(sld)) return parts[parts.length - 3];
  return sld;
}

function editDistance(a, b) {
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

function hostMatches(host, domain) {
  const d = normalizeHost(domain);
  return host === d || host.endsWith('.' + d);
}

function isLookalikeContentFarmUrl(url) {
  const host = extractHost(url);
  if (!host) return false;
  for (const d of LOOKALIKE_CONTENT_FARM_DOMAINS) if (hostMatches(host, d)) return true;
  return false;
}

/**
 * @param {string} outletId - canonical registry key (caller normalizes aliases)
 * @param {string} url
 * @param {object} registry - loaded outlet-registry.json ({ outlets })
 * @returns {{ lookalike: boolean, host?: string, imitates?: string, reason?: string }}
 */
function findLookalikeHost(outletId, url, registry) {
  const host = extractHost(url);
  const outlet = registry && registry.outlets && registry.outlets[String(outletId || '').toLowerCase()];
  if (!host || !outlet) return { lookalike: false };
  const owned = [outlet.domain, ...(Array.isArray(outlet.domainAliases) ? outlet.domainAliases : [])].filter(Boolean);
  if (owned.length === 0 || owned.some((d) => hostMatches(host, d))) return { lookalike: false };
  const label = hostLabel(host);
  for (const d of owned) {
    const own = hostLabel(d);
    if (own.length < 5 || label === own) continue;
    if (Math.abs(label.length - own.length) <= 3 && editDistance(label, own) <= 2) {
      return {
        lookalike: true, host, imitates: normalizeHost(d),
        reason: `host "${host}" imitates "${normalizeHost(d)}" (outlet "${outletId}") but is not owned by it`,
      };
    }
  }
  return { lookalike: false };
}

module.exports = {
  LOOKALIKE_CONTENT_FARM_DOMAINS,
  isLookalikeContentFarmUrl,
  findLookalikeHost,
  hostLabel,
  editDistance,
};
