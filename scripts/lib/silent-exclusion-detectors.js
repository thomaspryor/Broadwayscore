/**
 * silent-exclusion-detectors.js — two members of the #1147 silent-exclusion
 * class that had no detector at all (task #1188, found 2026-08-09).
 *
 * Both have the same shape as the rest of that tracker: a pipeline stage
 * declines to include a review and records nothing an operator would ever look
 * at. Neither is a scoring decision, so neither shows up in any score delta.
 *
 * ─── (a) AN OUTLET CHANGES ITS PUBLISHING DOMAIN ───────────────────────────
 *
 * one-minute-critic moved to 1minutecritic.substack.com. The registry knew only
 * 1minutecritic.com, so review-file-writer.js:448 answered every ingest attempt
 * on the new host with `domain-mismatch: URL domain 1minutecritic.substack.com
 * does not match outlet one-minute-critic (expected 1minutecritic.com)`. That
 * skip is classified EXPECTED-REJECTION by ingest-skip-classify.js — correct,
 * because a mismatched domain usually IS a misrouted outlet id — so it stayed
 * deliberately quiet while a real critic's reviews were dropped for weeks. It
 * was found by hand and fixed with a domainAliases entry. Outlets migrating to
 * Substack is now common, so "the next one" is a matter of when.
 *
 * The signal already exists and nothing reads it: data/audit/unknown-aggregator-
 * outlets.json (written by audit-show-review-gap.js) records every host seen on
 * an aggregator-cited review URL that maps to no registered outlet — 225 of them
 * as of 2026-08-10. If one of those hosts derives the SAME identity slug as an
 * outlet that IS registered under a DIFFERENT domain, that is a probable move.
 *
 * The host→identity derivation is NOT re-implemented here. It delegates to
 * outlet-canonicalize.js provisionalOutletIdFromHost(), which already owns the
 * blog-platform list (substack/wordpress/medium/... → the SUBDOMAIN is the
 * publication) and the multi-part public-suffix list (.co.uk → the label is
 * parts[-3], not "co"). Copying those lists here would fork a list that has
 * already caused two shipped bugs on its own (junk outlets literally named "co"
 * and "wordpress", 2026-06-21; the generic "theatre" label from theatre.reviews
 * that held the trunk red 08-07→08-09) — a second copy would reopen that class
 * independently of any fix to the original. It also gets the aggregator-host
 * veto for free: provisionalOutletIdFromHost returns null for aggregator
 * domains, which is why show-score.com and google.com never reach the matcher.
 *
 * DELIBERATELY NOT REPORTED: a host whose matched outlet has no `domain` at all.
 * That is the separate domainless-outlet class (scripts/lib/domainless-outlet-
 * guard.test.mjs) and it accounts for 40 of the 44 raw slug matches in the live
 * file. Folding them in here would bury the 4 real moves under a backlog that a
 * different guard already owns — the exact "unread signal" failure the
 * outlet-heartbeat baseline exists to prevent.
 *
 * ─── (b) A REVIEW WITH NO contentTier ──────────────────────────────────────
 *
 * Found by making the mistake: clearing an exclusion flag and deleting
 * contentTier (expecting rebuild to re-derive it) left a scored, unflagged
 * review absent from the corpus with no warning anywhere.
 *
 * Scope note, verified rather than assumed: rebuild-all-reviews.js:2046-2067
 * DOES re-derive the tier unconditionally for every file it processes (there is
 * no early `continue` between the loop head at :1974 and that block), and
 * isIncludableForRebuild() is indifferent to a missing tier — both checked
 * directly on the file from the incident. So a missing tier is not, by itself,
 * what rebuild excludes on.
 *
 * What it IS: proof that no writer ever classified the file. contentTier is
 * read as a raw field by 126 files across scripts/ and src/, and they are the
 * ones that quietly change behaviour when it is absent — collect-review-texts.js
 * :3084 (`review.contentTier === 'complete'` decides whether to re-fetch),
 * verify-review-recovery.js:158, audit-text-quality.js:57. A text-bearing,
 * real-byline, unflagged review that carries no tier is a file that fell out of
 * the classification path, and until this module nothing said so out loud.
 *
 * ─── SHAPE ─────────────────────────────────────────────────────────────────
 *
 * Structured after star-score-mismatch.js, the closest existing analogue: a
 * pure per-record evaluator, an fs scanner over the corpus, and a stable key
 * function for baselining — shared verbatim by the CLI
 * (scripts/audit-silent-exclusions.js) and the daily health check, so the two
 * can never drift apart. Inclusion semantics are DELEGATED to the canonical
 * predicate in review-guards.js per
 * memory/feedback_includability_predicates_must_be_canonical.md — this module
 * never re-implements the rule chain.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { listShowDirs } = require('./list-show-dirs');
const { isIncludableForRebuild } = require('./review-guards');
const { provisionalOutletIdFromHost } = require('./outlet-canonicalize');

/**
 * Floor for "this file carries meaningful review text".
 * 200 is not a new number: rebuild-all-reviews.js:2029/2031 already uses it as
 * the threshold below which recovered text is not worth promoting.
 */
const MIN_FULLTEXT_CHARS = 200;

/**
 * Identity slugs shorter than this are too generic to match on. Guards against
 * a host like "arts.com" claiming any outlet with "arts" in an alias. The four
 * true positives in the live corpus (reviewsgate, dancemagazine, metro,
 * dailymail) and the motivating case (1minutecritic) all clear it.
 */
const MIN_IDENTITY_SLUG_LEN = 5;

/**
 * Bylines that are not a person. A file credited to one of these is a
 * collapsed/derived attribution, not a critic, so its missing tier is not
 * evidence that a real review fell out of classification.
 *
 * review-guards.js:661 checks a narrower set ('unknown'/'staff') for a
 * different purpose (strand routing); there is no canonical shared list to
 * delegate to, so this one is deliberately kept to obvious non-person tokens
 * rather than growing into a third competing definition.
 */
const PLACEHOLDER_CRITIC = /^(unknown|unnamed|unattributed|staff|n\/?a|none|anonymous|editor|editorial|admin|guest|contributor|review|reviews)$/i;

/** Lowercase, strip everything but [a-z0-9]. "one-minute-critic" -> "oneminutecritic". */
function identitySlug(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Lowercase, drop a leading www., trim. */
function normalizeHost(host) {
  return String(host || '').toLowerCase().trim().replace(/^www\./, '');
}

// ───────────────────────── (b) missing contentTier ─────────────────────────

/**
 * Does this review file violate the "every text-bearing includable review
 * carries a derived contentTier" invariant?
 *
 * Pure — no fs, no fetch. The scanner and the unit test share it.
 *
 * `show` and `filePath` are NOT optional decoration: explainExclusion() gates
 * real rules on them (isPrematureReviewForUnopenedShow at review-guards.js:71,
 * the KNOWN_SYNDICATION_PAIRS sibling scan at :156, the tour-excerpt check at
 * :195, and the duplicateOf sibling resolution at :81). Calling the canonical
 * predicate with only `data` silently changes its verdict in BOTH directions —
 * a never-opened show's premature review and a syndicated duplicate both stop
 * being excluded, so both get reported as invariant violations that aren't.
 * t1-silent-gap.js:108 already passes both; this does too. Callers that
 * genuinely have no show record pass undefined and get the degraded verdict,
 * which is why the scanner counts those separately rather than hiding them.
 *
 * Throws whatever the canonical predicate throws — see scanMissingContentTier,
 * which counts predicate failures instead of swallowing them. Swallowing was
 * the first version's bug: on a checkout without shows.json the tour check
 * throws ENOENT for every file, and a silent catch turned the whole detector
 * into a permanent all-clear — the exact class this module exists to kill.
 *
 * @param {object} review - parsed review-text JSON
 * @param {object} [opts]
 * @param {object} [opts.show] - the show record from shows.json
 * @param {string} [opts.filePath] - absolute path to the review file
 * @returns {{criticName:string, outletId:string, chars:number, hasScore:boolean}|null}
 */
function evaluateMissingContentTier(review, opts = {}) {
  if (!review || typeof review !== 'object') return null;

  // Already classified — nothing to report. Any non-empty tier counts, including
  // 'invalid'/'stub': the invariant is that SOME writer made the call, not that
  // the call was favourable.
  if (review.contentTier) return null;

  const text = typeof review.fullText === 'string' ? review.fullText.trim() : '';
  if (text.length < MIN_FULLTEXT_CHARS) return null;

  const criticName = String(review.criticName || '').trim();
  if (!criticName || PLACEHOLDER_CRITIC.test(criticName)) return null;

  // Canonical predicate — NOT a local re-implementation of the rule chain.
  // A file the corpus deliberately excludes (wrongProduction, duplicateOf,
  // nonReview, …) is SUPPOSED to be absent; its missing tier is not a silent
  // exclusion, and reporting it would drown the real signal. 54 of the 115
  // tier-less files in the live corpus are exactly this case.
  //
  // Called with the SAME context rebuild has (see the note above) — a bare
  // isIncludableForRebuild(review) quietly disables four of its rules.
  if (!isIncludableForRebuild(review, opts.show, opts.filePath)) return null;

  return {
    criticName,
    outletId: review.outletId || '',
    chars: text.length,
    hasScore: !!(review.llmScore || review.assignedScore != null),
  };
}

/** Stable baseline key. Includes the byline so a re-derived file re-alerts. */
function missingTierKey(finding) {
  return `${finding.showId}/${finding.file}#${finding.criticName}`;
}

/**
 * Walk a review-texts root for the (b) invariant violation.
 *
 * Returns `scanned` so callers can refuse to report a vacuous pass: a scan that
 * saw zero files is a broken checkout, not a clean corpus (task #1065). Returns
 * `predicateErrors` for the same reason one level down: if the canonical
 * predicate throws for every file (e.g. its tour-excerpt branch needs
 * shows.json and the checkout has none), the scan would otherwise report a
 * confident all-clear built on zero actual verdicts.
 *
 * @param {string} rootDir - path to data/review-texts
 * @param {object} [opts]
 * @param {string[]} [opts.shows] - restrict to these show dirs (default: all)
 * @param {Map<string,object>|object} [opts.showsById] - show records by id, so
 *        the canonical predicate gets the same `show` context rebuild has
 * @param {Set<string>|string[]} [opts.baselineKeys] - already-triaged keys
 * @returns {{scanned:number, findings:object[], baselinedCount:number,
 *            predicateErrors:number, firstPredicateError:string|null}}
 */
function scanMissingContentTier(rootDir, opts = {}) {
  const baseline = opts.baselineKeys
    ? (opts.baselineKeys instanceof Set ? opts.baselineKeys : new Set(opts.baselineKeys))
    : null;
  const showsById = opts.showsById instanceof Map
    ? opts.showsById
    : new Map(Object.entries(opts.showsById || {}));

  const shows = opts.shows || listShowDirs(rootDir);
  const findings = [];
  let scanned = 0;
  let baselinedCount = 0;
  let predicateErrors = 0;
  let firstPredicateError = null;

  for (const showId of shows) {
    const dir = path.join(rootDir, showId);
    let files;
    try { files = fs.readdirSync(dir); } catch { continue; }
    const show = showsById.get(showId);
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      const filePath = path.join(dir, f);
      let review;
      try { review = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { continue; }
      scanned++;
      let hit;
      try {
        hit = evaluateMissingContentTier(review, { show, filePath });
      } catch (err) {
        // Never swallow silently — that would make this detector the very
        // thing it detects. Counted and surfaced by the caller.
        predicateErrors++;
        if (!firstPredicateError) firstPredicateError = `${showId}/${f}: ${err.message}`;
        continue;
      }
      if (!hit) continue;
      const full = { showId, file: f, url: review.url || '', ...hit };
      if (baseline && baseline.has(missingTierKey(full))) { baselinedCount++; continue; }
      findings.push(full);
    }
  }

  findings.sort((a, b) => b.chars - a.chars);
  return { scanned, findings, baselinedCount, predicateErrors, firstPredicateError };
}

// ───────────────────────── (a) outlet domain moves ─────────────────────────

/**
 * Index a registry's outlets by every identity string they answer to, and
 * collect every host they are already known to publish on.
 *
 * @param {object} outlets - the `outlets` map from data/outlet-registry.json
 * @returns {{knownHosts:Set<string>, identityIndex:Map<string,string[]>}}
 */
function buildOutletIdentityIndex(outlets) {
  const knownHosts = new Set();
  const identityIndex = new Map();

  for (const [outletId, entry] of Object.entries(outlets || {})) {
    if (!entry || typeof entry !== 'object') continue;

    for (const d of [entry.domain, ...(Array.isArray(entry.domainAliases) ? entry.domainAliases : [])]) {
      const host = normalizeHost(d);
      if (host) knownHosts.add(host);
    }

    const names = [outletId, entry.displayName, ...(Array.isArray(entry.aliases) ? entry.aliases : [])];
    for (const name of names) {
      const slug = identitySlug(name);
      if (slug.length < MIN_IDENTITY_SLUG_LEN) continue;
      if (!identityIndex.has(slug)) identityIndex.set(slug, []);
      const bucket = identityIndex.get(slug);
      if (!bucket.includes(outletId)) bucket.push(outletId);
    }
  }

  return { knownHosts, identityIndex };
}

/** Stable baseline key. Host+outlet, so a NEW host for the same outlet re-alerts. */
function domainMoveKey(finding) {
  return `${finding.host}#${finding.outletId}`;
}

/**
 * Find unregistered hosts that are probably a registered outlet's new home.
 *
 * Pure — takes already-loaded data so the unit test can hand it fixtures and
 * the CLI/health-check can hand it the real files.
 *
 * @param {object} input
 * @param {object} input.outlets - `outlets` map from data/outlet-registry.json
 * @param {object[]} input.unknownHosts - `outlets` array from
 *        data/audit/unknown-aggregator-outlets.json ({host, provisionalOutletId,
 *        occurrences, sampleUrls, shows})
 * @param {Set<string>|string[]} [input.baselineKeys] - already-triaged keys
 * @returns {{findings:object[], baselinedCount:number, domainlessMatches:number, scanned:number}}
 */
function detectOutletDomainMoves({ outlets, unknownHosts, baselineKeys } = {}) {
  const { knownHosts, identityIndex } = buildOutletIdentityIndex(outlets);
  const baseline = baselineKeys
    ? (baselineKeys instanceof Set ? baselineKeys : new Set(baselineKeys))
    : null;

  const findings = [];
  let baselinedCount = 0;
  let domainlessMatches = 0;
  let genericAliasMatches = 0;
  let scanned = 0;

  for (const row of Array.isArray(unknownHosts) ? unknownHosts : []) {
    if (!row || !row.host) continue;
    scanned++;

    const host = normalizeHost(row.host);
    // Already a host this outlet (or any outlet) publishes on — not a move.
    if (knownHosts.has(host)) continue;

    // Prefer the value the producing audit already computed; fall back to the
    // canonical helper for hand-built or older files that predate the field.
    // Either way the derivation lives in outlet-canonicalize.js, not here.
    const provisional = row.provisionalOutletId || provisionalOutletIdFromHost(host);
    const slug = identitySlug(provisional);
    if (slug.length < MIN_IDENTITY_SLUG_LEN) continue;

    const matches = identityIndex.get(slug);
    if (!matches) continue;

    for (const outletId of matches) {
      const registeredDomain = normalizeHost(outlets[outletId].domain);
      if (!registeredDomain) {
        // Outlet has no domain at all — the domainless-outlet class, not a move.
        domainlessMatches++;
        continue;
      }

      // CORROBORATION: the candidate host and the outlet's CURRENT domain must
      // derive the same identity label. A slug that merely matches one of the
      // outlet's aliases is not enough, because 8 registered outlets answer to
      // a bare generic word that clears the length floor — `guardian`,
      // `herald`, `mirror`, `standard`, `observer`, `express`, `tribune`,
      // `metro`. Without this, guardian.ng (The Guardian Nigeria, a different
      // newspaper) reads as "theguardian.com moved to guardian.ng", and acting
      // on that alert would file Nigerian reviews under a T1 UK outlet — a
      // worse outcome than the missed detection this check exists to prevent.
      //
      // Comparing labels instead of aliases keeps the detector's actual claim
      // honest: "same publication name, different host" (reviewsgate.com →
      // .co.uk, dailymail.co.uk → .com, 1minutecritic.com → the Substack), not
      // "this host's name appears somewhere in that outlet's alias list".
      const registeredSlug = identitySlug(provisionalOutletIdFromHost(registeredDomain));
      if (registeredSlug !== slug) { genericAliasMatches++; continue; }
      const finding = {
        host: row.host,
        outletId,
        registeredDomain,
        matchedSlug: slug,
        occurrences: row.occurrences || 0,
        sampleUrl: (Array.isArray(row.sampleUrls) && row.sampleUrls[0]) || '',
        shows: Array.isArray(row.shows) ? row.shows.slice(0, 5) : [],
      };
      if (baseline && baseline.has(domainMoveKey(finding))) { baselinedCount++; continue; }
      findings.push(finding);
    }
  }

  findings.sort((a, b) => b.occurrences - a.occurrences || a.host.localeCompare(b.host));
  return { findings, baselinedCount, domainlessMatches, genericAliasMatches, scanned };
}

module.exports = {
  MIN_FULLTEXT_CHARS,
  MIN_IDENTITY_SLUG_LEN,
  PLACEHOLDER_CRITIC,
  identitySlug,
  normalizeHost,
  evaluateMissingContentTier,
  missingTierKey,
  scanMissingContentTier,
  buildOutletIdentityIndex,
  detectOutletDomainMoves,
  domainMoveKey,
};
