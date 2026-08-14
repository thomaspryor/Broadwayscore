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
const { AGGREGATOR_DOMAINS } = require('./aggregator-domains');
const { platformSuffixOf, multipartSuffixOf, stripCosmeticPrefixes } = require('./host-suffix-lists');

let _cachedRegistry = null;
let _cachedDomainMap = null;
let _cachedAmbiguous = null;

const { foldDiacritics } = require('./title-match');

function loadRegistry() {
  if (_cachedRegistry) return _cachedRegistry;
  _cachedRegistry = require(path.join(__dirname, '..', '..', 'data', 'outlet-registry.json'));
  return _cachedRegistry;
}

// Keys are FULL registered domain/domainAlias strings (dancemagazine.com,
// dancemagazine.co.uk) — never a TLD-stripped bare base. That's deliberate:
// silent-exclusion-detectors.js (task #1254) and review-normalization.js's
// buildDomainToOutletIndex (BRO-247, PR #573) both added a bare-base fallback
// key and collided whenever two distinct outlets shared a brand word across
// TLDs, printing a live warning on every build. Do not "generalize" this
// function to strip TLDs the same way — see the BRO-247 regression tests in
// tests/unit/outlet-canonicalize.test.mjs for the pairs that would break.
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
  const slug = aliasResolved || foldDiacritics(outletArg).toLowerCase().replace(/[^a-z0-9]+/g, '-');
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
 * AGGREGATOR HOSTS RETURN null (2026-08-09). An aggregator domain is never an
 * outlet — its pages are roundups that cite other outlets' reviews. Minting a
 * provisional slug from one produces a phantom outlet AND a review-text file
 * whose url is on an aggregator domain while its outletId is not an aggregator:
 * exactly the `aggregator_url_mismatch` zero-tolerance error in
 * validate-review-texts.js. theatre.reviews split to parts ["theatre","reviews"],
 * so the registrable label was the generic word "theatre" — five
 * `theatre--paul-lewis.json` roundup files reached the corpus that way and the
 * newest one held the trunk red (Test Suite, 27 failures 08-07 → 08-09).
 * Returning null routes these URLs down the caller's existing "no usable outlet"
 * branch, which skips the ingest instead of inventing one.
 *
 * @param {string} host - hostname (with or without leading www.)
 * @returns {string|null} provisional slug, or null if no usable label
 */
// Which suffix a host sits on (blog platform vs multi-part public suffix) comes
// from host-suffix-lists.js — the SHARED source of truth. It used to be a local
// literal list here, forked from an identical one in silent-exclusion-detectors.js;
// the two drifted (this side lacked co.id, that side lacked tumblr.com) and a host
// classified one way at registration and the other at detection is a silent
// exclusion. Do not reintroduce a local list — the colocated test fails if you do.
// host is a URL hostname (DNS domains are ASCII/punycode by construction) —
// no diacritic fold needed here, unlike the outletArg slug fallback above.
// host is a URL hostname (DNS domains are ASCII/punycode by construction) —
// no diacritic fold needed here, unlike the outletArg slug fallback above.
function provisionalOutletIdFromHost(host) {
  if (!host || typeof host !== 'string') return null;
  // stripCosmeticPrefixes, not a bare www. strip: an amp./m./mobile. mirror is
  // the same outlet as its bare domain, and minting from the raw host made
  // 'm.someblog.substack.com' register under the outletId 'm' (ship-check
  // 2026-08-11) while the other two host-identity functions said 'someblog'.
  const h = stripCosmeticPrefixes(host);
  // Aggregators are not outlets — see the header note. Required import: a
  // silently-empty set here would make this guard vacuous, so aggregator-domains.js
  // throws at load if its sets are empty.
  if (AGGREGATOR_DOMAINS.has(h)) return null;
  const parts = h.split('.').filter(Boolean);
  if (parts.length < 2) return null;
  let label;
  const platform = platformSuffixOf(h);
  if (platform && parts.length >= 3) {
    // <...>.<pub>.<platform> -> the label IMMEDIATELY BEFORE the platform
    // suffix, not parts[0]. On a platform host with a section subdomain the
    // two differ, and taking parts[0] made this function disagree with
    // normalizeHostSlug on the module's own worked example:
    // 'theater.jerryportwood.substack.com' minted outletId 'theater' while
    // the domain-move detector reasoned about 'jerryportwood' — the exact
    // registration/detection split this shared module exists to close
    // (ship-check 2026-08-12). 'theater'/'news' also collide as provisional
    // ids across unrelated publications.
    const withoutPlatform = h.slice(0, -(platform.length + 1)).split('.').filter(Boolean);
    label = withoutPlatform[withoutPlatform.length - 1];
  } else if (multipartSuffixOf(h) && parts.length >= 3) {
    // <label>.co.uk -> the label before the 2-part suffix
    label = parts[parts.length - 3];
  } else {
    label = parts[parts.length - 2];
  }
  const slug = label.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || null;
}

/**
 * Is this candidate URL the SAME outlet's review we already hold for this show,
 * published on a different registered host?
 *
 * The false-gap this closes (The Pass, 2026-08-03 newsletter): one-minute-critic
 * moved to Substack, so the SERP census surfaced
 *   https://1minutecritic.substack.com/p/pass-la-mama-review-2026
 * while we already held the same review at
 *   https://1minutecritic.com/the-pass-la-mama-review-2026/
 * The census counted it as a missing review. That phantom gap is one of the two
 * that made the newsletter gate drop the show from the issue entirely.
 *
 * The rule is deliberately narrow, because a wrong dedupe HIDES a real review —
 * strictly worse than the phantom gap it removes. All four must hold:
 *   1. the candidate's host differs from the held URL's host (same host + same
 *      outlet is the ordinary exact/normalized-URL path, handled by the caller);
 *   2. BOTH hosts resolve to the same outletId through the registry's
 *      domain/domainAliases map — an outlet that declares both hosts;
 *   3. neither host is AMBIGUOUS (claimed by 2+ outlets). buildDomainMap keeps
 *      an explicit ambiguous set precisely so a contested host can never be
 *      silently attributed to one arbitrary outlet and used to hide a gap;
 *   4. the held URL is one the caller vouches for (it passes only covered files).
 *
 * Deliberately NOT used: path or slug similarity. The two real URLs above share
 * no path (`/the-pass-la-mama-review-2026/` vs `/p/pass-la-mama-review-2026`),
 * so a path-equality rule would not even fire on its own motivating case, and a
 * fuzzy-similarity rule would start suppressing genuine second reviews.
 *
 * Known and accepted limit: an outlet that publishes TWO different reviews of
 * one show across its two registered hosts dedupes to one. That is rare, and the
 * caller records every dedupe (see result.dedupedVariants in
 * audit-show-review-gap.js) so the filtering is visible rather than silent.
 *
 * Pure (registry maps injected) per CLAUDE.md §15.
 *
 * @param {object} params
 * @param {string} params.candidateUrl
 * @param {string[]} params.heldUrls          URLs of covered files already held for this show
 * @param {Record<string,string>} params.domainToOutlet  host -> outletId (unambiguous only)
 * @param {Set<string>} [params.ambiguous]    hosts claimed by 2+ outlets
 * @param {(u: string) => string|null} params.hostOf     host extractor (registrable-host aware)
 * @returns {{dup: boolean, matchedUrl: string|null, outletId: string|null, reason: string|null}}
 */
function sameOutletUrlVariant({ candidateUrl, heldUrls, domainToOutlet, ambiguous, hostOf }) {
  const miss = { dup: false, matchedUrl: null, outletId: null, reason: null };
  if (!candidateUrl || typeof hostOf !== 'function') return miss;
  const map = domainToOutlet || {};
  const amb = ambiguous || new Set();
  const candHost = hostOf(candidateUrl);
  if (!candHost || amb.has(candHost)) return miss;
  const candOutlet = map[candHost];
  if (!candOutlet) return miss;
  for (const held of (heldUrls || [])) {
    const heldHost = hostOf(held);
    if (!heldHost || heldHost === candHost) continue;
    if (amb.has(heldHost)) continue;
    if (map[heldHost] !== candOutlet) continue;
    return {
      dup: true,
      matchedUrl: held,
      outletId: candOutlet,
      reason: `same outlet "${candOutlet}" already held at ${heldHost}; ${candHost} is a registered alias of it`,
    };
  }
  return miss;
}

module.exports = {
  resolveCanonicalOutletId,
  getCvStyle,
  provisionalOutletIdFromHost,
  sameOutletUrlVariant,
  // exposed for tests
  _buildDomainMap: buildDomainMap,
  _parseDomain: parseDomain,
};
