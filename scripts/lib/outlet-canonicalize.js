/**
 * outlet-canonicalize.js — resolve canonical outletId from operator input + URL.
 *
 * Prevents class-C domain-outlet drift in manual-ingest paths by cross-checking
 * the operator-supplied outlet slug against the URL's registered outlet.
 *
 * Returns { outletId, displayName, source, warning } where:
 *   source  = 'url' | 'alias' | 'slug-fallback'
 *   warning = optional string to print to stderr
 *
 * Priority:
 *   1. URL domain → unique canonical (from outlet-registry.json).
 *      If the operator's input resolves to a DIFFERENT canonical, we prefer
 *      the URL and emit a warning — the URL is the ground truth.
 *   2. Alias lookup via review-normalization.normalizeOutlet().
 *   3. Slug fallback (same behavior as today) — for never-before-seen outlets.
 *
 * Throws when:
 *   - registry cannot be loaded
 *   - URL domain maps to multiple outlets (ambiguous) AND input is unregistered
 */

const path = require('path');
const { normalizeOutlet, getOutletDisplayName } = require('./review-normalization');

let _cachedRegistry = null;
let _cachedDomainMap = null;
let _cachedAmbiguous = null;

function loadRegistry() {
  if (_cachedRegistry) return _cachedRegistry;
  _cachedRegistry = require(path.join(__dirname, '..', '..', 'data', 'outlet-registry.json'));
  return _cachedRegistry;
}

function buildDomainMap() {
  if (_cachedDomainMap) return { domainToOutlet: _cachedDomainMap, ambiguous: _cachedAmbiguous };
  const registry = loadRegistry();
  const collect = {};
  for (const [id, o] of Object.entries(registry.outlets || {})) {
    const domains = [];
    if (o.domain) domains.push(String(o.domain).toLowerCase());
    if (Array.isArray(o.domainAliases)) {
      o.domainAliases.forEach((d) => domains.push(String(d).toLowerCase()));
    }
    for (const d of domains) {
      (collect[d] = collect[d] || new Set()).add(id);
    }
  }
  _cachedDomainMap = {};
  _cachedAmbiguous = new Set();
  for (const [d, ids] of Object.entries(collect)) {
    if (ids.size === 1) _cachedDomainMap[d] = [...ids][0];
    else _cachedAmbiguous.add(d);
  }
  return { domainToOutlet: _cachedDomainMap, ambiguous: _cachedAmbiguous };
}

function parseDomain(url) {
  if (!url || typeof url !== 'string') return null;
  const m = url.match(/^https?:\/\/(?:www\.)?([^/?#]+)/i);
  return m ? m[1].toLowerCase() : null;
}

function isRegisteredCanonical(id) {
  const registry = loadRegistry();
  return Boolean(registry.outlets && registry.outlets[id]);
}

/**
 * resolveCanonicalOutletId({ outletArg, url })
 * @param {{ outletArg: string, url?: string|null }} opts
 * @returns {{ outletId: string, displayName: string, source: 'url'|'alias'|'slug-fallback', warning: string|null }}
 */
function resolveCanonicalOutletId({ outletArg, url }) {
  if (!outletArg || typeof outletArg !== 'string') {
    throw new Error('resolveCanonicalOutletId: outletArg is required');
  }

  const aliasResolved = normalizeOutlet(outletArg);
  const aliasIsRegistered = isRegisteredCanonical(aliasResolved);

  let urlResolved = null;
  if (url) {
    const domain = parseDomain(url);
    if (domain) {
      const { domainToOutlet, ambiguous } = buildDomainMap();
      if (!ambiguous.has(domain) && domainToOutlet[domain]) {
        urlResolved = domainToOutlet[domain];
      }
    }
  }

  // Case A: URL resolves unambiguously. URL is ground truth.
  if (urlResolved) {
    if (aliasIsRegistered && aliasResolved !== urlResolved) {
      const warning =
        `outletId drift detected — operator input "${outletArg}" resolved to "${aliasResolved}" ` +
        `but URL domain maps to canonical "${urlResolved}". Using URL-derived canonical.`;
      return {
        outletId: urlResolved,
        displayName: getOutletDisplayName(urlResolved) || urlResolved,
        source: 'url',
        warning,
      };
    }
    // Alias matches URL or alias not registered — either way, URL-canonical is right.
    const warning =
      aliasIsRegistered
        ? null
        : `operator input "${outletArg}" not registered in outlet-registry.json; ` +
          `URL domain resolved to canonical "${urlResolved}".`;
    return {
      outletId: urlResolved,
      displayName: getOutletDisplayName(urlResolved) || urlResolved,
      source: 'url',
      warning,
    };
  }

  // Case B: URL absent / domain ambiguous. Use alias resolution.
  if (aliasIsRegistered) {
    return {
      outletId: aliasResolved,
      displayName: getOutletDisplayName(aliasResolved) || aliasResolved,
      source: 'alias',
      warning: null,
    };
  }

  // Case C: Slug fallback — unknown outlet, no URL help. Emit warning so
  // operator sees the drift before it propagates.
  const slug = aliasResolved || outletArg.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return {
    outletId: slug,
    displayName: outletArg,
    source: 'slug-fallback',
    warning:
      `outlet "${outletArg}" is not registered in outlet-registry.json and no URL was ` +
      `provided to cross-check. Writing slug "${slug}" — audit-review-contamination will ` +
      `flag this if the canonical outlet is later added to the registry.`,
  };
}

const VALID_CV_STYLES = new Set(['standard', 'long-biographical']);

/**
 * getCvStyle(outletId)
 * Returns the cvStyle for the given outlet, defaulting to 'standard'.
 * Calls normalizeOutlet first so aliases (e.g. 'nysun') resolve to their
 * canonical ID ('new-york-sun') before the registry lookup.
 */
function getCvStyle(outletId) {
  const canonical = normalizeOutlet(outletId || '');
  const registry = loadRegistry();
  const entry = registry.outlets && registry.outlets[canonical];
  const style = entry && entry.cvStyle;
  return VALID_CV_STYLES.has(style) ? style : 'standard';
}

/**
 * Derive a domain-safe provisional outletId for a host not yet in the registry,
 * so an aggregator-cited review from an unknown outlet can still be captured (the
 * ctvoice / New York Notebook class, girl-interrupted 2026-06-05) instead of
 * being skipped. Intended to be passed to ingest-review-from-url.js --provisional
 * (no fuzzy alias resolution, which would mis-map e.g. "new-york-notebook" to
 * "vulture" via a New York Magazine fuzzy match).
 *
 * Blog-platform publications live on a subdomain, so we take the subdomain label
 * (newyorknotebook.substack.com -> "newyorknotebook", pagesonstages.wordpress.com
 * -> "pagesonstages"). For everything else we take the registrable label — the
 * part BEFORE the public suffix — which for a multi-part ccTLD is parts[-3], not
 * parts[-2] (londontheatre.co.uk -> "londontheatre", NOT "co"; the naive
 * parts[-2] produced junk outlets literally named "co" and "wordpress",
 * girl-interrupted backfill 2026-06-21). Plain TLDs use parts[-2]
 * (ctvoice.com -> "ctvoice", 1minutecritic.com -> "1minutecritic").
 *
 * @param {string} host - hostname (with or without leading www.)
 * @returns {string|null} provisional slug, or null if no usable label
 */
// Blog/newsletter platforms where the publication identity is the SUBDOMAIN, not
// the platform domain. host "pub.wordpress.com" -> "pub".
const PROVISIONAL_BLOG_PLATFORMS = [
  'substack.com', 'wordpress.com', 'blogspot.com', 'medium.com',
  'tumblr.com', 'squarespace.com', 'wixsite.com', 'ghost.io',
];
// Multi-part public suffixes where the registrable label sits one level deeper
// (so .co.uk/.org.uk/.com.au/etc. don't collapse to "co"/"org"/"com").
const PROVISIONAL_MULTIPART_SUFFIXES = [
  'co.uk', 'org.uk', 'me.uk', 'ac.uk', 'gov.uk',
  'com.au', 'net.au', 'org.au', 'co.nz', 'co.za', 'com.br',
];
function provisionalOutletIdFromHost(host) {
  if (!host || typeof host !== 'string') return null;
  const h = host.replace(/^www\./, '').toLowerCase().trim();
  const parts = h.split('.').filter(Boolean);
  if (parts.length < 2) return null;
  let label;
  const platform = PROVISIONAL_BLOG_PLATFORMS.find((p) => h.endsWith('.' + p));
  if (platform && parts.length >= 3) {
    // pub.<platform> -> the publication subdomain
    label = parts[0];
  } else if (PROVISIONAL_MULTIPART_SUFFIXES.some((s) => h.endsWith('.' + s)) && parts.length >= 3) {
    // <label>.co.uk -> the label before the 2-part suffix
    label = parts[parts.length - 3];
  } else {
    label = parts[parts.length - 2];
  }
  const slug = label.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || null;
}

module.exports = {
  resolveCanonicalOutletId,
  getCvStyle,
  provisionalOutletIdFromHost,
  // exposed for tests
  _buildDomainMap: buildDomainMap,
  _parseDomain: parseDomain,
};
