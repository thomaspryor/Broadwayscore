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
const { normalizeOutlet, getOutletDisplayName, WIRE_SERVICE_OUTLETS, resolveOutletFromUrlIfPathInformed } = require('./review-normalization');
const { AGGREGATOR_DOMAINS } = require('./aggregator-domains');
const { platformSuffixOf, multipartSuffixOf, stripCosmeticPrefixes, isBareSuffix } = require('./host-suffix-lists');

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

// Registry lookup for a URL host, exact first, then each parent domain
// (newspaper.dailymail.com -> dailymail.com). Exact-only lookup was the
// Golden Boy / Daily Mail miss (issue #908, 2026-09-22): the e-edition
// subdomain matched nothing, so ingest-review-from-url.js minted a phantom
// provisional outlet "dailymail", the critic-registry guard then flagged
// Patrick Marmion as misattributed, and the review never scored.
// Walk-up stops before a blog-platform suffix (someone.medium.com is NOT the
// registered "medium" outlet) and never reaches a bare public suffix. An
// ambiguous hit at any level returns null — the nearest registered level is
// the only one that speaks for the host.
function lookupOutletForHost(host, { exactOnly = false } = {}) {
  if (!host || typeof host !== 'string') return null;
  const { domainToOutlet, ambiguous } = buildDomainMap();
  const h = host.toLowerCase().replace(/^www\./, '');
  const platform = platformSuffixOf(h);
  const parts = h.split('.').filter(Boolean);
  for (let i = 0; i <= parts.length - 2; i++) {
    const candidate = parts.slice(i).join('.');
    if (i > 0 && platform && candidate === platform) break;
    if (i > 0 && isBareSuffix(candidate)) break;
    if (ambiguous.has(candidate)) return null;
    if (domainToOutlet[candidate]) {
      const match = domainToOutlet[candidate];
      // A partner publication hosted on a publisher's subdomain
      // (jewishchronicle.timesofisrael.com) is NOT the publisher. Refuse the
      // parent match when a subdomain label spells out another registered
      // outlet's name — the caller then falls back to its no-match path.
      if (i > 0) {
        const names = compactOutletNames();
        for (const label of parts.slice(0, i)) {
          const owner = names.get(label.replace(/[^a-z0-9]/g, ''));
          if (owner && owner !== match) return null;
        }
      }
      return match;
    }
    if (exactOnly) return null;
  }
  return null;
}

// compact name ("jewishchronicle") -> outletId, from registered ids and display
// names. Only names >= 8 chars: short generic words ("preview", "online") are
// real subdomain labels and must not block a legitimate parent match.
let _cachedCompactNames = null;
function compactOutletNames() {
  if (_cachedCompactNames) return _cachedCompactNames;
  const seen = new Map();
  for (const [id, o] of Object.entries(loadRegistry().outlets || {})) {
    for (const raw of [id, o.displayName]) {
      if (!raw) continue;
      const c = String(raw).toLowerCase().replace(/^the[\s-]+/, '').replace(/[^a-z0-9]/g, '');
      if (c.length < 8) continue;
      seen.set(c, seen.has(c) && seen.get(c) !== id ? null : id);
    }
  }
  _cachedCompactNames = new Map([...seen].filter(([, id]) => id));
  return _cachedCompactNames;
}

function parseDomain(url) {
  if (!url || typeof url !== 'string') return null;
  const m = url.match(/^https?:\/\/(?:www\.)?([^/?#]+)/i);
  // Drop userinfo and port: "dailymail.com:443" must look up "dailymail.com".
  return m ? m[1].toLowerCase().replace(/^[^@]*@/, '').replace(/:\d+$/, '').replace(/^www\./, '') : null;
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
    // Path-informed edition splits (timeout.com/london vs /newyork) are a
    // STRONGER signal than the bare-domain map below can ever give — that map
    // only sees a hostname and marks a shared host fully "ambiguous" (BRO-4153:
    // a timeout.com URL with operator input "timeout" was trusting the alias
    // and silently discarding the /london path). Check this first; it returns
    // null for undeclared collisions like telegraph.co.uk (same outlet either
    // way — see resolveOutletFromUrlIfPathInformed) so those keep falling
    // through to the ambiguous-domain-map behavior below, unchanged.
    const pathResolved = resolveOutletFromUrlIfPathInformed(url);
    if (pathResolved) {
      urlResolved = pathResolved.outletId;
    } else {
      const domain = parseDomain(url);
      if (domain) {
        urlResolved = lookupOutletForHost(domain);
        // A parent-domain match is weaker evidence than an exact one: a partner
        // subdomain (jewishchronicle.timesofisrael.com) can host a DIFFERENT
        // registered outlet. It fills in an unregistered operator input, but
        // never overrides a registered one.
        if (urlResolved && aliasIsRegistered && aliasResolved !== urlResolved
            && !lookupOutletForHost(domain, { exactOnly: true })) {
          urlResolved = null;
        }
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

  // Case B: URL absent / domain ambiguous / domain not itself a registered
  // outlet. Use alias resolution — but if the URL's host IS known and does
  // NOT match the alias-resolved outlet's own registered domain, don't trust
  // a fuzzy name match onto a registered outlet's identity (task #1926: the
  // real paranormal-activity-2026 incident — operator input "newyorknotebook"
  // fuzzy-matches registered outlet "vulture" via its "newyork"/"nymag"
  // aliases, but the review's actual host, newyorknotebook.substack.com,
  // matches none of vulture's registered domains — a genuine outlet trying
  // to borrow a T1's tier weight). Fall back to a host-derived provisional
  // outlet instead of trusting the fuzzy match blind.
  if (aliasIsRegistered) {
    // Wire services syndicate on arbitrary partner domains by design (AP
    // reviews live on huffpost.com, sfgate.com, abcnews.go.com, …) — same
    // exemption isCrossOutletUrl() and outlet-domain-validation.js's own
    // gate already apply. Without this, a legitimate AP submission with a
    // URL on a non-apnews.com partner site would get demoted to a bogus
    // host-derived provisional outlet BEFORE ever reaching the domain-
    // validation gate that would have exempted it (adversarial review
    // finding on this same fix, task #1926).
    if (url && !WIRE_SERVICE_OUTLETS.has(aliasResolved)) {
      const domain = parseDomain(url);
      if (domain) {
        const { hostMatchesOutletDomain } = require('./outlet-domain-validation');
        const registry = loadRegistry();
        if (hostMatchesOutletDomain(url, aliasResolved, registry) === false) {
          const provisionalId = provisionalOutletIdFromHost(domain);
          if (provisionalId) {
            return {
              outletId: provisionalId,
              displayName: provisionalId
                .split('-')
                .filter(Boolean)
                .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
                .join(' '),
              source: 'slug-fallback',
              warning:
                `operator input "${outletArg}" resolved to registered outlet "${aliasResolved}" ` +
                `but URL host "${domain}" doesn't match that outlet's registered domain — refusing ` +
                `to borrow its identity. Using host-derived provisional "${provisionalId}" instead.`,
            };
          }
          // No usable provisional label (e.g. an aggregator host) — fall
          // through to the alias-trusting return below. review-file-writer.js's
          // own validateUrlDomain guard still hard-rejects a registered-domain
          // mismatch downstream, so this isn't a silent gap.
        }
      }
    }
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

// BRO-2776: 'long-biographical' is the ONE canonical value. review-guards.js's
// S3-T6 comment used to document 'biographical-lead', which this Set rejected,
// so getCvStyle() fell back to 'standard' silently and shouldDeferCvWrongShow()
// stayed disarmed with no error anywhere.
//
// The first fix here added 'biographical-lead' as an accepted alias. Review
// (2026-09-05) rejected that: it buys backward compatibility with nothing —
// zero of 1127 outlets carry a cvStyle key at all — at the price of two
// permanent spellings in shared code. The comment was corrected at its source
// instead, and a wrong value is now caught at WRITE time by
// scripts/audit-outlet-registry.js rather than whispered at read time.

// Warn at most once per (outlet, value) so a bulk rebuild over 19k reviews does
// not print the same line thousands of times, while a genuinely new typo is
// still surfaced on its first occurrence. This is the read-time backstop; the
// write-time gate in audit-outlet-registry.js is the primary defence.
const warnedCvStyles = new Set();

/**
 * getCvStyle(outletId)
 * Returns the cvStyle for the given outlet, defaulting to 'standard'.
 * Calls normalizeOutlet first so aliases (e.g. 'nysun') resolve to their
 * canonical ID ('new-york-sun') before the registry lookup.
 *
 * An unrecognised cvStyle is LOUD (BRO-2776). It still falls back to 'standard'
 * so a bad registry value cannot break a rebuild, but it no longer does so
 * silently — a silent fallback is what let this guard sit dead.
 */
function getCvStyle(outletId) {
  const canonical = normalizeOutlet(outletId || '');
  const registry = loadRegistry();
  const entry = registry.outlets && registry.outlets[canonical];
  return resolveCvStyle(entry && entry.cvStyle, canonical);
}

/**
 * resolveCvStyle(rawStyle, canonicalOutletId)
 * The registry-free decision behind getCvStyle, extracted so it is testable
 * without reading data/outlet-registry.json at all — keeps this pure
 * function's tests independent of the registry's current contents.
 *
 * NOT pure: it reads and mutates the module-level warn-once memo and calls
 * console.warn. Its RETURN value is a pure function of rawStyle; only the
 * warning is stateful. Use _resetCvStyleWarnings() to clear that state in tests.
 *
 * @param {string|undefined|null} rawStyle  the registry's cvStyle value, if any
 * @param {string} canonicalOutletId        used only for the warning message
 * @returns {'standard'|'long-biographical'}
 */
function resolveCvStyle(rawStyle, canonicalOutletId = '') {
  if (rawStyle === undefined || rawStyle === null) return 'standard';
  if (VALID_CV_STYLES.has(rawStyle)) return rawStyle;
  const key = `${canonicalOutletId}::${rawStyle}`;
  if (!warnedCvStyles.has(key)) {
    warnedCvStyles.add(key);
    console.warn(
      `[outlet-canonicalize] outlet "${canonicalOutletId}" has unrecognised ` +
        `cvStyle "${rawStyle}" — falling back to "standard", so any ` +
        `cvStyle-gated guard (e.g. shouldDeferCvWrongShow) will NOT fire for ` +
        `it. Valid values: ${[...VALID_CV_STYLES].join(', ')}.`
    );
  }
  return 'standard';
}

/**
 * findInvalidCvStyles(registry)
 * Every outlet whose cvStyle is present but outside VALID_CV_STYLES.
 * Extracted (CLAUDE.md rule 15) so audit-outlet-registry.js's write-time gate
 * is unit-testable without data/outlet-registry.json, which is gitignored and
 * therefore absent from every worktree.
 *
 * An ABSENT cvStyle is not a finding — that is all 1127 outlets today.
 *
 * @param {{outlets?: Object}} registry
 * @returns {Array<{outletId: string, cvStyle: *}>}
 */
function isValidCvStyle(style) {
  return VALID_CV_STYLES.has(style);
}

/**
 * countArmedCvStyles(registry)
 * How many outlets actually carry 'long-biographical'.
 *
 * This is the check that would have caught the real BRO-2776 incident.
 * cvStyle WAS populated once (cbf7e97c5c, 2026-05-16) and a clean 3-way merge
 * (4014d52077) silently dropped every key, turning the whole S3 defer-gate into
 * a no-op on production main. See cloud-memory/feedback_silent_merge_loss_on_
 * reformat.md. A validity check cannot see that failure: vanished keys are
 * "absent", which is never invalid. Only a POSITIVE assertion catches it.
 *
 * @param {{outlets?: Object}} registry
 * @returns {number}
 */
function countArmedCvStyles(registry) {
  let n = 0;
  for (const entry of Object.values((registry && registry.outlets) || {})) {
    if (entry && entry.cvStyle === 'long-biographical') n++;
  }
  return n;
}

function findInvalidCvStyles(registry) {
  const out = [];
  for (const [outletId, entry] of Object.entries((registry && registry.outlets) || {})) {
    if (!entry || entry.cvStyle === undefined || entry.cvStyle === null) continue;
    if (!VALID_CV_STYLES.has(entry.cvStyle)) out.push({ outletId, cvStyle: entry.cvStyle });
  }
  return out;
}

// Exposed for tests only: the warn-once memo is module state, so a test that
// asserts the warning fires must be able to clear it between cases.
function _resetCvStyleWarnings() {
  warnedCvStyles.clear();
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
  resolveCvStyle,
  findInvalidCvStyles,
  countArmedCvStyles,
  // The ONE canonical cvStyle vocabulary, exported so audit-outlet-registry.js
  // validates against it rather than keeping a second copy that could drift —
  // drifted vocabulary is exactly what BRO-2776 was. Frozen: exporting the live
  // Set would let any requiring module call .add('biographical-lead') and
  // silently re-open the drift this closes (code-review 2026-09-05).
  CV_STYLES: Object.freeze([...VALID_CV_STYLES]),
  isValidCvStyle,
  provisionalOutletIdFromHost,
  lookupOutletForHost,
  sameOutletUrlVariant,
  // exposed for tests
  _buildDomainMap: buildDomainMap,
  _parseDomain: parseDomain,
  _resetCvStyleWarnings,
};
