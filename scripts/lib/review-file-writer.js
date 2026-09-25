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
 * - isBroadwayUrl() — reject Broadway/US reviews on WE/OWE shows (Guard H)
 * - safeWriteReview() — preserve scored/collected fields on overwrite
 * - classifyContentTier() — tag new files with content tier
 *
 * Used by: scrape-playbill-verdict, scrape-bww-reviews, scrape-dtli,
 * scrape-nyc-theatre-roundups, scrape-london-box-office-roundups,
 * scrape-westendtheatre-roundups, re-extract-aggregator-reviews.
 */

const fs = require('fs');
const path = require('path');
const {
  normalizeOutlet,
  normalizeCritic,
  generateReviewFilename,
  findExistingReviewFile,
  isFlaggedMergeTarget,
  isJunkOutlet,
  isSuspiciousOutletId,
  maybeUpgradeUrl,
  slugLooksLikeDifferentShow,
  getOutletDisplayName,
  resolveOutletFromUrl,
  loadOutletRegistry,
} = require('./review-normalization');
const { findSiblingUrlOwner } = require('./review-url-collision');
const { isShowDirHiddenBySparseCheckout } = require('./sparse-checkout-guard');
const { validateUrlDomain } = require('./url-discovery');
const { safeWriteReview, invalidateWrongProductionAutoClear } = require('./review-write-guard');
const { classifyContentTier } = require('./content-quality');
const { clearFailureFlags } = require('./clear-failure-flags');
const { pickRerouteTarget, shouldSkipRoundupAudit, isRoundupPageAsReview, isLikelyTourReview, getWrongProductionReasonForUnknownCritic, getWrongProductionReasonForBww, isWrongShowUnknownLocked } = require('./review-guards');
const { isStaleScoreInput, markRescoreNeeded } = require('./rescore-flagging');
const { isHumanClearedWrongProduction: _isHumanClearedWrongProduction, neutralizeStaleFlagsOnBodyReplacement } = require('./stale-flag-neutralization');
const { detectRoundupDigest, detectPullQuoteCompilation } = require('./roundup-digest');
const { isBroadwayUrl, isLondonMarket } = require('./venue-classification');
const { classifyMarketRouting, buildSiblingIndex } = require('./market-routing');
const { sanitizeCriticName } = require('./byline-normalization');
const { evaluateCreditedPersonAsCritic } = require('./creative-as-critic');

// One-shot latch for the Guard F2 inert warning (see its call site).
let _creditGuardInertWarned = false;
const { findCrossShowOwners, shouldBlockCrossShowCreate, recordUrlOwner } = require('./url-ownership');
const { decodeHtmlEntities, hasUndecodedHtmlEntities, hasJsonLdArtifact } = require('./text-cleaning');
const { emitStage } = require('./stage-latency');
const { shouldSkipAggregatorUrlWrite, shouldRefuseAggregatorOutletRefinement, hasPreservableAggregatorScore, isAggregatorReviewSource } = require('./aggregator-domains');
const { EXCERPT_FIELDS } = require('./excerpt-fields');
const { isUrlSwapRegression } = require('./url-downgrade-guard');

// ── firstSeenAt: the immutable retrieval clock (S2-T4) ───────────────────────
// firstSeenAt is stamped ONCE, at the moment a review file is first created, and
// is NEVER changed on a later merge — it is the SLA clock-start for T1 retrieval
// (how fast did a review's real content reach us?). This logic is centralized
// here so EVERY writer path — this shared writer AND gather-reviews' direct
// saveReview — stamps the field and emits the `review-first-seen` latency stage
// exactly once, at creation. Backfill of pre-existing files uses git-history
// first-add dates (backfill-first-seen.js), NOT merge time, so merges must never
// stamp it (a merge-time stamp would be late + wrong).
function stampFirstSeen(review, nowIso) {
  if (review && !review.firstSeenAt) review.firstSeenAt = nowIso || new Date().toISOString();
  return review;
}

// Emit the review-first-seen stage-latency event for a freshly-created file.
// Accepts the identifying fields directly so both writer paths compute the SAME
// reviewKey (outletId:critic:url). Never throws — telemetry must not break a write.
function emitReviewFirstSeen(showId, { outletId, criticName, url }) {
  try {
    emitStage({
      showId,
      reviewKey: `${outletId}:${normalizeCritic(criticName)}:${url || ''}`,
      stage: 'review-first-seen',
    });
  } catch (e) { process.stderr.write(`[stage-latency] first-seen emit failed: ${e.message}\n`); }
}

// Save-time mirror of validate-data's [html-entity] (CHECK 5) and
// [jsonld-artifact] (CHECK 4) detectors. Mutates the review object in place:
//   • decodes undecoded HTML entities in the four display fields
//     (criticName, outlet, pullQuote, excerpt) — they're salvageable values
//     that just arrived encoded;
//   • drops a pullQuote/excerpt that is JSON-LD markup — the scraper grabbed
//     structured data instead of a real quote, so the field is garbage.
// Shares the predicates with validate-data via text-cleaning.js (CLAUDE.md §15)
// so the gate and the guard can't drift. Returns the same object for chaining.
function sanitizeDisplayFields(review) {
  if (!review) return review;
  for (const f of ['criticName', 'outlet', 'pullQuote', 'excerpt']) {
    if (hasUndecodedHtmlEntities(review[f])) review[f] = decodeHtmlEntities(review[f]);
  }
  for (const f of ['pullQuote', 'excerpt']) {
    if (hasJsonLdArtifact(review[f])) {
      console.warn(`  ⚠️  Dropping JSON-LD ${f} for ${review.showId || ''}/${review.outletId || ''} (scraper captured structured data, not a quote)`);
      delete review[f];
    }
  }
  return review;
}

const DEFAULT_REVIEW_TEXTS_DIR = path.join(__dirname, '..', '..', 'data', 'review-texts');
const SHOWS_PATH = path.join(__dirname, '..', '..', 'data', 'shows.json');
const CRITIC_REGISTRY_PATH = path.join(__dirname, '..', '..', 'data', 'critic-registry.json');

// ─── Lazy-loaded critic registry for misattribution prevention ───
// Generated by audit-critic-outlets.js. Loaded once, cached for process lifetime.
let _criticRegistryCache = null;
function _getCriticRegistry() {
  if (_criticRegistryCache) return _criticRegistryCache;
  try {
    const raw = JSON.parse(fs.readFileSync(CRITIC_REGISTRY_PATH, 'utf8'));
    _criticRegistryCache = raw.critics || {};
    return _criticRegistryCache;
  } catch (e) {
    // Registry not available (e.g. CI without data) — disable guard
    console.warn(`  ⚠️  Critic registry not loaded (Guard G disabled): ${e.message}`);
    _criticRegistryCache = {};
    return _criticRegistryCache;
  }
}

// ─── Lazy-loaded sibling index for market-routing classifier ───
// Uses scripts/lib/market-routing.js buildSiblingIndex so gather-reviews.js and
// this writer share one decision function. Loaded once, cached for process lifetime.
let _siblingIndexCache = null;
function _getSiblingIndex() {
  if (_siblingIndexCache) return _siblingIndexCache;
  try {
    const shows = require(SHOWS_PATH).shows;
    _siblingIndexCache = buildSiblingIndex(shows);
  } catch {
    _siblingIndexCache = new Map();
  }
  return _siblingIndexCache;
}

// ─── Legacy sibling lookup (kept for any external callers; delegates to new index) ───
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

// ─── Lazy-loaded show category map for cross-market guard ───
let _showCategoryCache = null;
function _getShowCategory(showId) {
  if (!_showCategoryCache) {
    try {
      const shows = require(SHOWS_PATH).shows;
      _showCategoryCache = {};
      for (const s of shows) {
        if (s.id && s.category) _showCategoryCache[s.id] = s.category;
      }
    } catch {
      _showCategoryCache = {};
    }
  }
  // Fallback: infer from show ID if not in shows.json (e.g. new shows)
  if (_showCategoryCache[showId]) return _showCategoryCache[showId];
  if (showId.includes('-west-end-')) return 'west-end';
  if (showId.includes('-off-west-end-')) return 'off-west-end';
  return null;
}

// ─── Lazy-loaded show title map for the maybeUpgradeUrl cross-show guard ───
let _showTitleCache = null;
function _getShowTitle(showId) {
  if (!_showTitleCache) {
    try {
      const shows = require(SHOWS_PATH).shows;
      _showTitleCache = {};
      for (const s of shows) {
        if (s.id && s.title) _showTitleCache[s.id] = s.title;
      }
    } catch {
      _showTitleCache = {};
    }
  }
  return _showTitleCache[showId] || null;
}

// ─── Lazy-loaded full show object map for Guard J/K (wrongProduction URL-date checks) ───
let _showByIdCache = null;
function _getShowById(showId) {
  if (!_showByIdCache) {
    try {
      const shows = require(SHOWS_PATH).shows;
      _showByIdCache = {};
      for (const s of shows) {
        if (s.id) _showByIdCache[s.id] = s;
      }
    } catch {
      _showByIdCache = {};
    }
  }
  return _showByIdCache[showId] || null;
}

/**
 * Shared existing-file lookup for the wrongProduction human-clear check
 * (isHumanClearedWrongProduction, imported from stale-flag-neutralization.js)
 * — one read, reused by every URL-date guard instead of each guard hand-
 * rolling its own findExistingReviewFile call. `criticNameOrNull` is passed
 * through as-is (callers decide their own Unknown/Staff-to-null translation).
 * Guards J and K both pass `criticName !== 'Unknown' ? criticName : null` —
 * the SAME expression as the real merge-target lookup below (~line 936) — so
 * the clearance they read belongs to the file the write actually lands on.
 * Do NOT "simplify" either back to a bare `null`: that regresses BRO-3502's
 * criticName-identity fix (regression test: review-file-writer-bww-reviews-
 * guard.test.mjs, "criticName-identity fix"). Guard A passes raw
 * `input.criticName` instead only because it runs before `criticName` is
 * sanitized (line 738); the two differ solely for URL-shaped bylines.
 * @returns {object|null} the existing file's parsed data, or null if none
 */
function _lookupExistingWrongProductionData(reviewTextsDir, showId, outletId, criticNameOrNull, url) {
  const showDir = path.join(reviewTextsDir, showId);
  const existing = findExistingReviewFile(showDir, outletId, criticNameOrNull, url);
  return existing && existing.data;
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
  // Set below when a write is kept under its TRUE outlet on an aggregator URL,
  // either because it carries a preservable score OR because the write is
  // aggregator-SOURCED (task #1335) — see refiningOntoAggregator /
  // aggregatorSourceExempt below. Read again by the domain-validation guard
  // further down: that guard's job is to catch a MISTAKEN outlet/URL pairing,
  // but this pairing is a deliberate, already-vetted exception, not a mistake —
  // the outlet's own domain will never match an aggregator's domain by definition.
  let aggregatorScoreStub = false;

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
    // NEVER refine ONTO an aggregator outlet (2026-08-09). An aggregator's domain
    // hosts ROUNDUP pages citing many outlets, so "the URL is on this domain" is
    // never evidence that the aggregator wrote this particular review. Refining
    // here would rewrite a real outlet's id to the aggregator's, which both
    // destroys the attribution AND launders the contamination past the
    // aggregator-URL write guard below: that guard permits an aggregator URL when
    // outletId IS the aggregator, so a Guardian review on a westendtheatre.com
    // roundup URL would be silently rewritten to `westendtheatre` and written as
    // the aggregator's own review.
    //
    // Keyed on the resolved OUTLET being an aggregator, not on AGGREGATOR_DOMAINS,
    // deliberately: the domain set carries westendtheatre.co.uk while every one of
    // the 395 corpus files uses westendtheatre.com (see the TLD note in
    // aggregator-domains.js). Checking the outlet catches both spellings and any
    // future aggregator domain that reaches the registry before that set.
    //
    // Genuine aggregator writes are unaffected: all four laundering display names
    // ("Did They Like It", "WestEndTheatre.com", "Theatre Reviews Limited",
    // "London Box Office") already normalize to their own outletId, so
    // urlResolved.outletId === outletId and this block never runs for them.
    const urlResolvesToAggregator = urlResolved
      && shouldRefuseAggregatorOutletRefinement(urlResolved.outletId, outletId);
    // An aggregator-SOURCE write (source='westendtheatre', 'dtli', etc.) legitimately
    // carries the roundup's own URL even when citing a real outlet's article — that's
    // the exact shape shouldSkipAggregatorUrlWrite() (below) already exempts by
    // checking isAggregatorReviewSource(source) FIRST, before ever looking at score.
    // This refusal previously had no equivalent exemption, so a genuine
    // aggregator-source citation with no extractable score (no aggregatorStars/
    // originalScore) was refused here before it ever reached that source-aware
    // guard (task #1335, found during #1325's /ship-check).
    const refiningOntoAggregator = urlResolvesToAggregator && !isAggregatorReviewSource(input.source);
    if (refiningOntoAggregator) {
      // Refuse the WRITE, not just the refinement (code review on 2c679ad4bb1).
      // Keeping the name-derived outlet leaves a real outletId on an aggregator
      // URL — which IS the zero-tolerance aggregator_url_mismatch UNLESS the file
      // carries a score sourced from the roundup, the SAME carve-out
      // shouldSkipAggregatorUrlWrite() already applies a few guards below and
      // hasAggregatorUrlMismatch() (aggregator-url-latent.js, task #1194, closed
      // 2026-08-12) applies at validation time. A scored write here is a
      // legitimate star-stub — the aggregator URL is the only URL that ever
      // existed for it — so it is allowed to land under its TRUE (name-derived)
      // outlet; outletId is deliberately left untouched, not reassigned to
      // urlResolved.outletId, so the file is never filed under the aggregator.
      //
      // An UNSCORED write stays refused: validateUrlDomain only rejects when the
      // outlet has a registered `domain`, and 361 of the 1043 registry outlets
      // have none, so letting an unscored, undomained real outlet through here
      // would still convert a mis-attributed roundup citation into a corpus file
      // with nothing worth preserving — the corpus already holds 7 files of this
      // shape on stagedoor.com from before this guard existed.
      if (!hasPreservableAggregatorScore(fields)) {
        console.warn(`  ⛔ Refusing aggregator-URL write for ${showId}: outlet "${outletId}" on roundup domain ${input.url} (URL resolves to aggregator "${urlResolved.outletId}") — not this outlet's review`);
        return { action: 'skipped', reason: 'aggregator-url-refinement-refused' };
      }
      aggregatorScoreStub = true;
      console.warn(`  ⚠️  Keeping true outlet "${outletId}" on aggregator URL ${input.url} (URL resolves to aggregator "${urlResolved.outletId}") — scored star-stub, not refining/refusing`);
    }
    if (urlResolvesToAggregator && !aggregatorScoreStub) {
      // Reached only when refiningOntoAggregator was false because the write is
      // aggregator-SOURCED (task #1335, found during #1325's /ship-check) — the
      // score-stub case already logged its own message above, inside the
      // refiningOntoAggregator branch. Keep the name-derived outletId as-is and
      // skip the general refinement logic below entirely — the Case 2
      // cross-domain branch would otherwise immediately reassign outletId to the
      // aggregator, exactly the laundering this whole block exists to prevent.
      // Also set aggregatorScoreStub so the domain-validation guard further down
      // tolerates the same EXPECTED domain mismatch it already tolerates for
      // scored star-stubs (an aggregator-sourced write on a domain-registered
      // outlet, e.g. guardian, would otherwise be re-refused there as
      // domain-mismatch immediately after being exempted here).
      aggregatorScoreStub = true;
      console.warn(`  ⚠️  Keeping true outlet "${outletId}" on aggregator URL ${input.url} (URL resolves to aggregator "${urlResolved.outletId}") — aggregator-source write, not refining/refusing`);
    }
    // refiningOntoAggregator/aggregatorScoreStub (score exemption) and the
    // isAggregatorReviewSource exemption just above both mean outletId must NOT
    // become the aggregator's — skip the general refinement logic below entirely
    // whenever the URL resolved onto an aggregator at all, or the cross-domain
    // "Case 2" branch would immediately undo that decision.
    if (!urlResolvesToAggregator && urlResolved && urlResolved.outletId !== outletId) {
      const registry = loadOutletRegistry();
      const urlOutlet = registry?.outlets?.[urlResolved.outletId];
      const nameOutlet = registry?.outlets?.[outletId];
      if (urlOutlet && nameOutlet && urlOutlet.domain === nameOutlet.domain) {
        // Case 1: same domain. URL is authoritative ONLY when the URL's PATH
        // informed the resolution (timeout.com/london vs /newyork). When two
        // outlets merely share a bare domain (telegraph / sunday-telegraph,
        // express-uk / sunday-express), the URL carries no edition signal —
        // overriding here would force every explicitly-labeled "Sunday
        // Telegraph" review to the daily edition (card 38b637c5 review).
        // Detect path-awareness generically: if resolving the bare origin
        // yields the same outlet as the full URL, the path added nothing and
        // the supplied name stands.
        let pathInformed = false;
        try {
          const originResolved = resolveOutletFromUrl(new URL(input.url).origin + '/');
          pathInformed = !originResolved || originResolved.outletId !== urlResolved.outletId;
        } catch { /* unparseable — keep name */ }
        if (pathInformed) {
          outletId = urlResolved.outletId;
        }
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

  // --- Guard: named non-review URL pattern (BRO-4101) ---
  // non-review-url-patterns.js's NAMED_NON_REVIEW_URL_PATTERNS (ticketing/
  // venue/event-listing host+path pairs, e.g. londontheatre.co.uk/show/NNNN)
  // was already consulted by the S5 coverage probe's classifyNonReviewUrl()
  // and audit-show-review-gap.js's discovery-time isReviewUrl() — but NOT by
  // this shared write chokepoint, so SERP discovery could still ingest and
  // score one of these pages as a "review". Confirmed live: the-last-ship-
  // west-end-2026's londontheatre.co.uk/show/47207-the-last-ship (a ticketing
  // page — synopsis + "Book tickets" copy + anonymous audience comments, no
  // critic byline) was ingested via serp-discovery, LLM-scored 82, and shipped
  // to prod before a human caught it. Checked before the aggregator-URL guard
  // below since a named non-review host is never a review regardless of what
  // outlet name/domain it happens to share.
  //
  // Scoped to isUnvettedSerpSource(input.source) — the SAME scope as
  // review-guards.js's namedNonReviewUrl rebuild-time rule, for the SAME
  // reason (ship-check adversarial review, ×2 independent reviewers): this
  // guard runs before the merge-vs-create fork below, so an UNSCOPED version
  // would silently refuse forever any future re-merge/refresh write to a
  // file like burn-this-2019/new-york-city-theatre--nicola-quinn.json — a
  // real, scored, contentTier:complete review (source: show-score-playwright)
  // whose citation URL happens to sit on a host-wide named pattern
  // (newyorkcitytheatre.com). Every OTHER source this function serves
  // (aggregator scrapers, submit-review-form) already carries its own
  // vetting elsewhere in this file (or, for submissions, in
  // validate-review-submission.js's LLM gate) — this guard's job is
  // specifically to close the gap SERP discovery had.
  if (input.url && require('./unvetted-serp-sources').isUnvettedSerpSource(input.source)) {
    const namedReason = require('./non-review-url-patterns').namedNonReviewReason(input.url);
    if (namedReason) {
      console.warn(`  ⛔ Skipping named non-review URL: ${input.url} (${namedReason})`);
      return { action: 'skipped', reason: `named-non-review-url: ${namedReason}` };
    }
  }

  // --- Guard: aggregator URL on a real outlet (2026-08-09) ---
  // An aggregator-domain URL (theatre.reviews, show-score.com, stagedoor.com, …)
  // is a ROUNDUP page citing other outlets — not `outletId`'s own review. A file
  // written that way is the zero-tolerance `aggregator_url_mismatch` error in
  // validate-review-texts.js, and it reddens the trunk the moment an auto-clear
  // promotes it into the validated population (see lib/aggregator-url-latent.js).
  //
  // This guard already existed — but only inside gather-reviews.js createReviewFile,
  // one writer out of the ~20 that reach review-texts through this function. The
  // gap-audit ingest path (audit-show-review-gap.js → ingest-review-from-url.js →
  // here) had none, so it wrote five theatre.reviews roundups as "theatre" outlet
  // reviews and the newest held main red. Hoisting the SAME predicate to the shared
  // chokepoint is what makes the fix cover every caller rather than the two we
  // happened to read. shouldSkipAggregatorUrlWrite is deliberately narrow: it lets
  // any write carrying a real star/score through (star-stubs), and (as of task
  // #1337, see below) an aggregator-SOURCE write ONLY when it also carries a
  // score or extracted text — not on the source label alone.
  //
  // Verified against the full 42,252-file corpus before landing: it matches exactly
  // the 5 contaminated files and zero legitimate ones.
  //
  // Task #1337: the source-only exemption inside shouldSkipAggregatorUrlWrite now
  // also requires extracted text (or a score) before trusting an aggregator-source
  // label — an aggregator-source write with neither was passing this guard, only to
  // be flagged post-hoc as aggregator_url_mismatch by validate-review-texts.js. This
  // caller must therefore pass the text-signal fields through, not just source/url/
  // score, or the new gate always sees "no text" and the fix is a no-op here.
  {
    const aggregatorTextSignal = { fullText: input.fullText || fields.fullText, excerpt: input.excerpt || fields.excerpt, text: input.text || fields.text };
    for (const f of EXCERPT_FIELDS) aggregatorTextSignal[f] = input[f] || fields[f];
    if (shouldSkipAggregatorUrlWrite(
      { source: input.source, url: input.url, originalScore: fields.originalScore, aggregatorStars: fields.aggregatorStars, ...aggregatorTextSignal },
      outletId,
    )) {
      console.warn(`  ⚠️  Skipping aggregator-URL write: outletId "${outletId}" with aggregator URL ${input.url} (roundup page, not this outlet's review)`);
      return { action: 'skipped', reason: 'aggregator-url-mismatch' };
    }
  }

  // --- Guard: tour/regional review contamination (task #1150, 2026-08-09) ---
  // Regional BWW city subdirectories and local-paper tour-stop write-ups are not
  // reviews of THIS production — they're a different regional/touring mounting
  // getting filed under the original show's directory. This guard already
  // existed, but only inside gather-reviews.js's own createReviewFile — every
  // other writer reaching review-texts through this shared function had no
  // equivalent check. Hoisted after fixing two pre-existing false-positive bugs
  // in isLikelyTourReview itself (regional-category shows and BWW topic
  // verticals bwwopera/bwwdance/bwwtv were being misclassified as tour
  // contamination — see review-guards.js). Verified against the full
  // 42,251-file corpus after the fix: 201 matches, 1 plausible true positive
  // (a Dallas tour-stop review under a Broadway show entry), zero remaining
  // false positives.
  if (isLikelyTourReview(input.url, showId)) {
    console.warn(`  ⚠️  Skipping tour/regional review: ${input.url} for ${showId}`);
    return { action: 'skipped', reason: 'tour-review' };
  }

  // --- Guard: unregistered outlet + empty stub (2026-05-25) ---
  // Reject writes where outletId isn't in outlet-registry AND the file carries
  // no review signal (no fullText, no excerpt). This kills the contamination
  // pattern where discovery scripts slugify an unrecognized domain (reddit,
  // metopera.org, lincolncenterfestival.org) or a title text fragment into
  // outletId and write an empty stub. Registered-but-stub files (e.g. NYSR
  // pending URL resolution) still pass because their outletId resolves.
  // Real new outlets must be added to outlet-registry.json first — that's
  // the system of record for what counts as a valid outlet.
  {
    const registry = loadOutletRegistry();
    const aliasMap = registry ? new Map() : null;
    if (registry && registry.outlets) {
      for (const [oid, odata] of Object.entries(registry.outlets)) {
        if (oid.startsWith('_')) continue;
        aliasMap.set(oid.toLowerCase(), true);
        for (const a of (odata.aliases || [])) aliasMap.set(String(a).toLowerCase(), true);
      }
      if (registry._aliasIndex) {
        for (const k of Object.keys(registry._aliasIndex)) {
          if (k !== '_note') aliasMap.set(k.toLowerCase(), true);
        }
      }
    }
    const outletKnown = aliasMap ? aliasMap.has(String(outletId).toLowerCase()) : true;
    // Keep in sync with Guard F (empty-stub detection) at lines ~345-347 —
    // aggregator scrapers can populate per-source excerpt variants instead of
    // the generic fullText/excerpt/text fields. Treat any of them as "has text"
    // so the guard doesn't drop legit aggregator-extracted reviews.
    //
    // Sourced from the canonical EXCERPT_FIELDS list (excerpt-fields.js), not a
    // second hand-rolled subset: this used to hardcode only 6 of the 10 canonical
    // fields (missing westEndTheatreExcerpt/theatreReviewsExcerpt/theStageExcerpt/
    // playbillVerdictExcerpt), so a write with ONLY one of those 4 could pass the
    // aggregator-URL guard above (which does use the full list) only to be
    // rejected here as an "empty stub" — a silent, field-name-dependent trap
    // (Codex adversarial finding, #1337 ship-check).
    const hasText = !!(
      input.fullText || fields.fullText ||
      input.excerpt || fields.excerpt ||
      input.text || fields.text ||
      EXCERPT_FIELDS.some((f) => input[f] || fields[f])
    );
    if (!outletKnown && !hasText) {
      console.warn(`  ⚠️  Skipping empty stub for unregistered outlet "${outletId}" (showId=${showId}, url=${input.url || 'null'})`);
      return { action: 'skipped', reason: 'unregistered-outlet-empty-stub' };
    }
  }

  // --- Guard: domain validation ---
  const domainCheck = validateUrlDomain(input.url, outletId);
  if (!domainCheck.valid) {
    // aggregatorScoreStub means outletId is deliberately kept as the TRUE outlet
    // on an aggregator-domain URL — either a scored star-stub (see
    // refiningOntoAggregator above, task #1325) or an aggregator-SOURCED write
    // (see aggregatorSourceExempt above, task #1335) — a mismatch here is
    // EXPECTED (the outlet's real domain, e.g. theguardian.com, will never
    // match the aggregator's, e.g. westendtheatre.com), not a defect. Without
    // this, the domain guard would silently re-refuse the exact write the
    // relaxation above was just made to allow through, for every outlet that
    // HAS a registered domain — i.e. most of the target population.
    if (!aggregatorScoreStub) {
      return { action: 'skipped', reason: `domain-mismatch: ${domainCheck.reason}` };
    }
    fields.domainUnvalidated = true;
    fields.domainUnvalidatedReason = `aggregator-url stub (expected mismatch): ${domainCheck.reason}`;
    console.warn(`  ⚠️  Tolerating expected domain mismatch for aggregator-url stub: ${showId}/${outletId} — ${domainCheck.reason}`);
  }
  // Domainless registry outlet (task #782, cousin of #766's read-path fix): the guard
  // above passed with nothing actually checked. Stamp + log so this stays visible for
  // outlet-registry backfill instead of vanishing into a silent valid:true, same as any
  // real WE ghost outlet (guardian-uk/telegraph-uk class) would otherwise do on write.
  if (domainCheck.unvalidated) {
    fields.domainUnvalidated = true;
    fields.domainUnvalidatedReason = domainCheck.reason;
    console.warn(`  ⚠️  Unvalidated domain for ${showId}/${outletId}: ${domainCheck.reason}`);
  }

  // --- Guard A: Cross-market sibling reroute (+ Guard H URL rejection) ---
  // Delegated to scripts/lib/market-routing.js so gather-reviews.js and this
  // writer share one decision function. Thresholds preserved: sibling ≤30d,
  // current >90d (full-date Tier 1); pickRerouteTarget (Tier 2 by year).
  // Visited set prevents recursion cycles. See card 34c637c5-416f-81cf.
  {
    const pubDateStr = input.publishDate || input.fields?.publishDate;
    const showCategory = _getShowCategory(showId);
    const visited = _rerouteVisited || new Set();
    const decision = classifyMarketRouting({
      showId,
      url: input.url,
      outletId,
      publishDate: pubDateStr,
      category: showCategory,
      allowCrossMarket: fields.allowCrossMarket === true,
      visited,
      siblingIndex: _getSiblingIndex(),
    });
    if (decision.action === 'reject') {
      console.warn(`  ⛔ Cross-market guard: rejecting ${outletId}/${input.criticName || 'Unknown'} for ${showId} — ${decision.reason}`);
      return { action: 'skipped', reason: decision.reason };
    }
    if (decision.action === 'reroute') {
      console.warn(`  ⚠️  Cross-market reroute: ${showId} → ${decision.targetShowId} (${decision.reason})`);
      return createOrMergeReviewFile(decision.targetShowId, input, { ...options, _rerouteVisited: visited });
    }
    // Accept-with-flag: classifier wants the file written but with a flag stamped
    // on the payload (e.g. ambiguous same-title-different-production cases where
    // we can't confidently reroute but the production likely doesn't match the
    // current show). Follow-up to a169936e48 — wires the dead code path through.
    if (decision.action === 'accept' && decision.flag) {
      if (decision.flag === 'wrongProduction') {
        // Guard: don't stamp wrongProduction if a human has already made a
        // manual decision on this file. The downstream merge in
        // _mergeIntoExisting() uses `!existing[key]` to gate writes — and
        // `!false === true`, so stamping here would CLOBBER a human's
        // explicit `wrongProduction: false` (the inverse of the bug we're
        // fixing). See _isHumanClearedWrongProduction's doc for the 4 signals.
        const existingData = _lookupExistingWrongProductionData(
          reviewTextsDir, showId, outletId,
          (input.criticName && input.criticName !== 'Unknown') ? input.criticName : null,
          input.url
        );
        const humanCleared = _isHumanClearedWrongProduction(existingData);
        if (humanCleared) {
          console.warn(`  ⏭️  Skipping wrongProduction stamp for ${showId}/${outletId}: human override in place`);
        } else {
          fields.wrongProduction = true;
          fields.wrongProductionReason = decision.reason || 'ambiguous-production';
          if (decision.signalsByCandidate) {
            fields.ambiguousProductionSignals = decision.signalsByCandidate;
          }
          console.warn(`  ⚠️  Ambiguous production for ${showId}/${outletId}: stamping wrongProduction (${fields.wrongProductionReason})`);
        }
      } else {
        console.warn(`  ⚠️  Unknown decision.flag from classifyMarketRouting: "${decision.flag}" (showId=${showId}, outletId=${outletId}) — proceeding without flag`);
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

  // --- Guard E1: BWW /reviews/{slug} critics-aggregation page detection ---
  // BWW's /reviews/{slug} page is a critics-average widget quoting OTHER
  // outlets, not an individual BWW review (distinct from /article/... which
  // IS a BWW-authored review). Ingested as a 13th T1 review on
  // the-whoopi-monologues-off-broadway-2026 (2026-07-14): score came from the
  // average widget, criticName from a quoted outlet's JSON-LD Person markup.
  // Gated on outletId (via isRoundupPageAsReview), not URL alone, so a review
  // legitimately SOURCED from this page under a different outlet still writes —
  // same policy the rebuild-time gate already applies to WOS/Stage/LBO/WET.
  // Skip when Guard E already flagged — since isRoundupUrl gained the
  // /article/Review-Roundup- pattern (df046f73aaa), isRoundupPageAsReview
  // also matches those URLs and was overwriting E's more specific reason
  // (broke the Guard E unit test on main, 2026-07-19).
  if (!fields.isRoundupArticle && isRoundupPageAsReview({ url: input.url, outletId })) {
    fields.isRoundupArticle = true;
    fields.roundupArticleReason = 'auto: URL matches BWW /reviews/ critics-aggregation page pattern';
  }

  // --- Guard E2: LBO Review-Round-Up page detection ---
  // London Box Office publishes aggregator roundups at /news/post/Review-Round-Up%3A-...
  // (and `review-round-up-...`) URLs. The actual roundup pages alternate hyphenation;
  // the older `review-roundup` (1-hyphen) form was already caught by isRoundupUrl.
  // NOTE: The `source: lbo-roundup` field is a discovery-path tag — many files with
  // that tag are full Stuart King individual reviews at `/news/post/{show-slug}-review`
  // URLs. Don't auto-flag on source — only on URL pattern.
  if (input.url && /\/news\/post\/(?:review-round[-_ ]?up|Review-Round-?Up)/i.test(input.url)) {
    fields.isRoundupArticle = true;
    fields.roundupArticleReason = 'auto: URL matches LBO Review-Round-Up page pattern';
  }

  // --- Guard E3: review-roundup DIGEST detection (content/byline, outlet-agnostic) ---
  // Catches roundup compilations stored under an individual outlet id — chiefly
  // WestEndTheatre.com roundup landing pages mis-attributed to telegraph/timeout/
  // standard with the WET staff byline (63 found 2026-06-30). Guard E/E2 only
  // covered BWW/LBO URL patterns. Detection is content-based (digest phrasing /
  // publication-name-as-critic / known WET roundup author) so it won't fire on a
  // real critic's excerpt relayed via an aggregator. Skip if already flagged.
  if (!fields.isRoundupArticle) {
    const digest = detectRoundupDigest({
      fullText: input.fullText || fields.fullText,
      criticName: input.criticName || fields.criticName,
      url: input.url,
      outletId,
    });
    if (digest) {
      fields.isRoundupArticle = true;
      fields.roundupArticleReason = `auto: ${digest.reason}`;
    }
  }

  // --- Guard E4: "critical consensus" pull-quote compilation (outlet-agnostic) ---
  // Catches compilation pages stored under an individual critic's OWN byline
  // that quote several OTHER outlets' reviews verbatim with no "Roundup"
  // wording anywhere — e.g. New York Theater's (newyorktheater.me) "critical
  // consensus" posts, bylined to the site's own writer (task #1888). Unlike
  // Guard E3 above, not gated to one aggregator host: detection is purely
  // content-based (3+ distinct outlet attributions — comma-shape "{Name},
  // {Outlet}.", prose "{Outlet}'s {Critic}", or "{Critic} of {Outlet}", each
  // requiring a quoted excerpt in the trailing span — or a consensus-intro
  // phrase corroborated by 2+; BRO-2520 added the possessive/"of"-prose
  // shapes after Gold Derby's "sampling of the critical reaction"
  // compilation slipped past the original comma-only shape), so it won't
  // fire on a real critic's review that quotes one rival in passing. Skip if
  // already flagged.
  if (!fields.isRoundupArticle) {
    const compilation = detectPullQuoteCompilation({
      fullText: input.fullText || fields.fullText,
      outletId,
      criticName: input.criticName || fields.criticName,
    });
    if (compilation) {
      fields.isRoundupArticle = true;
      fields.roundupArticleReason = `auto: ${compilation.reason}`;
    }
  }

  // --- Guard F: Empty unknown rejection ---
  // Don't create files for unknown critics with no URL and no text content.
  // These are pure scrape garbage that clutter the directory.
  // Sanitize first: a URL-shaped byline (scraper grabbed the link href, not the
  // text — e.g. "https://observer.com/author/rex-reed") is coerced to a clean
  // personal name or 'Unknown' BEFORE filename/dedup/guards run, so a URL can
  // never be persisted as criticName. Save-time mirror of validate-data's
  // [headline-critic]/[url-critic] gate. See byline-normalization.js.
  const criticName = sanitizeCriticName(input.criticName) || 'Unknown';
  if (criticName === 'Unknown' && !input.url && !fields.fullText && !fields.bwwExcerpt
      && !fields.dtliExcerpt && !fields.showScoreExcerpt && !fields.nycTheatreExcerpt
      && !fields.stagedoorExcerpt && !fields.lboRoundupExcerpt) {
    return { action: 'skipped', reason: 'empty-unknown: no URL, no text, unknown critic' };
  }
  // --- Guard F2: credited-person-as-critic rejection ---
  // A byline that is a CREATIVE TEAM member of this same show is not a review;
  // it is a mis-parsed roundup row. how-to-dance-in-ohio-2023 produced exactly
  // this file three times ("Sammi Cannold", the show's Director, with an article
  // headline as outletId and null url/publishDate/fullText). validate-data.js
  // already ERRORS on it, so each occurrence reddened main and was deleted by
  // hand — twice — while the source archive kept the row and the next extraction
  // re-wrote it. Detection after ingest cannot break that loop; refusing the
  // WRITE can. Same predicate object as the validator (CLAUDE.md §15), so the
  // two can never drift apart.
  //
  // Scoped to the CREATIVE match only, deliberately. The validator treats a CAST
  // match as a WARNING, not an error, because performer-bylined pieces are a real
  // (if rare) genre and a stricter save-time rule than the validation rule would
  // silently discard data no gate ever objected to.
  //
  // Operator-supplied rows are exempt: a human who typed this in has already made
  // the judgement, and BRO-2916's lesson is that manual entries must never be
  // dropped by an automated dedup/rejection pass. The SOURCE is the load-bearing
  // half of this test — scripts/ingest-manual-review.js sets only
  // `source: 'manual-entry'` and its score is optional, so keying the exemption
  // on humanReviewScore alone would exit(1) on an unscored operator ingest of a
  // genuine dual-role author. A review round caught that; the test that "proved"
  // the exemption had supplied a score and so could never have seen it.
  // (the guard itself runs further down, in the NEW-file region beside Guard I —
  // see "Guard F2" there. It must not reject MERGES into files that already
  // exist: audit-show-review-gap.js re-ingests an empty-bodied flagged review
  // under that file's own criticName specifically so the writer merges and the
  // file self-heals, and rejecting there would burn all three recovery attempts
  // in flagged-recovery.js without ever filling the body.)

  const criticSlug = normalizeCritic(criticName);

  // --- Guard G: Critic-registry misattribution detection ---
  // If a non-freelancer critic has a known primaryOutlet and the incoming
  // outletId isn't in their knownOutlets, this is likely a misattribution
  // from an aggregator or SERP. Flag the file rather than skipping, so we
  // don't lose data — the flag causes rebuild to exclude it from scoring.
  // Note: _misattributionDetected is set here but the flag is only written to
  // NEW files (below). On merge, we skip setting it to avoid re-flagging files
  // where suspectedMisattribution was manually cleared to false (the merge
  // logic treats false as falsy and would overwrite it).
  let _misattributionDetected = false;
  let _misattributionReason = '';
  if (criticSlug !== 'unknown' && outletId) {
    const registry = _getCriticRegistry();
    const entry = registry[criticSlug];
    const knownOutlets = entry?.knownOutlets || [];
    if (entry && !entry.isFreelancer && knownOutlets.length > 0 && !knownOutlets.includes(outletId)) {
      _misattributionDetected = true;
      _misattributionReason = `critic "${entry.displayName}" has primaryOutlet="${entry.primaryOutlet}" (${entry.totalReviews} reviews); found at "${outletId}" which is not in knownOutlets`;
      console.warn(`  ⚠️  Misattribution guard: ${entry.displayName} at ${outletId} (primary: ${entry.primaryOutlet}) for ${showId}`);
    }
  }

  // Guard H (URL/outlet rejection) merged into Guard A above via classifyMarketRouting.

  // --- Guard J: unknown-critic wrongProduction via URL date (task #1150, 2026-08-09) ---
  // When a review has no named critic, extract the publish date from the URL
  // path and flag wrongProduction if it falls outside the show's window — the
  // same URL-date fallback other guards apply, but scoped (inside the helper
  // itself) to Unknown/Staff bylines only, since named critics legitimately
  // carry pre-transfer/out-of-town coverage a bare date can't distinguish from
  // a different production. This guard already existed only in gather-reviews.js
  // (called right before its own write); every other writer reaching
  // review-texts through this function had no equivalent. Flag-not-skip, same
  // as Guard A's wrongProduction stamp below — the file is still written, just
  // excluded from scoring until reviewed. Runs before the create-vs-merge
  // fork below (mirrors gather's placement); on a merge, the default field
  // merge only fills wrongProduction if the existing file doesn't already
  // have it, so an existing human/CV verdict is never clobbered.
  // Corpus-scanned against the full 42,251-file review-texts corpus (task
  // #1150): 2 unknown-critic files match this predicate, 1 "legit" (a 2013
  // file, low-stakes) — matches gather's own existing behavior on identical
  // inputs today, so hoisting introduces no new false-positive class. Called
  // unconditionally — the helper self-gates on criticName internally, so no
  // outer Unknown check is needed here.
  if (!fields.wrongProduction) {
    const wpReason = getWrongProductionReasonForUnknownCritic(
      { url: input.url, criticName },
      _getShowById(showId),
    );
    if (wpReason) {
      // Same human-clear guard as the classifyMarketRouting flag stamp above —
      // `!existing.wrongProduction` in the merge loop is `true` for an explicit
      // `wrongProduction: false`, so stamping here unconditionally would clobber
      // a verified-correct human decision. Uses the SAME criticName resolution
      // as the real merge-target lookup below (`criticName !== 'Unknown' ? ... : null`)
      // — passing a bare `null` here would risk checking a different file's
      // clearance than the one the merge step actually writes to, for the rare
      // case this guard fires on a non-Unknown/Staff byline it wasn't gated on.
      const existingWpData = _lookupExistingWrongProductionData(
        reviewTextsDir, showId, outletId, criticName !== 'Unknown' ? criticName : null, input.url
      );
      const humanClearedWp = _isHumanClearedWrongProduction(existingWpData);
      if (humanClearedWp) {
        console.warn(`  ⏭️  Skipping unknown-critic wrongProduction stamp for ${showId}/${outletId}: human override in place`);
      } else {
        fields.wrongProduction = true;
        fields.wrongProductionReason = wpReason;
        console.warn(`  ⚠️  ${wpReason} (${showId}/${outletId})`);
      }
    }
  }

  // --- Guard K: BWW cross-production wrongProduction via URL date (BRO-3502) ---
  // Extends BRO-916 (originally only wired into gather-reviews.js's own
  // createReviewFile) to this shared write chokepoint. Two BWW-sourced review
  // shapes reach createOrMergeReviewFile today with zero URL-date protection
  // beyond Guard J's Unknown/Staff-only check above:
  //   • source: 'bww-roundup'  — scrape-bww-reviews.js's own roundup-page
  //     extraction (extractBwwRoundupData, saveReview()), a SEPARATE producer
  //     of 'bww-roundup' entries from gather-reviews.js's extractBWWRoundupReviews
  //     (which already gets the BRO-916 guard, but only at its own inline
  //     write call — never at this chokepoint).
  //   • source: 'bww-reviews'  — scrape-bww-reviews.js's dedicated /reviews/
  //     {slug} page extraction (extractBwwReviewsPageData), which never had
  //     any BWW-specific date guard at all.
  // Both are BWW-assembled PAGES (roundup anchor/JSON-LD parsing, or the
  // per-show /reviews/ page's div.one-feed blocks) — the same page-assembly
  // contamination risk BRO-916's incident (Alexander Cohen / "The Fear of
  // 13") documented, independent of whether the byline is BWW's own or a
  // real named critic. getWrongProductionReasonForBww (review-guards.js)
  // self-gates on review.source, so it is safe to call unconditionally here.
  // Mirrors gather-reviews.js:3895-3904's field-write pattern exactly: sets
  // ONLY wrongProductionNote (never wrongProductionReason), so a later
  // priorRuns declaration can still auto-clear it via wrong-production-
  // autoclear.js's DATE_GUARD_PREFIXES match on the "Auto-flagged:" prefix.
  //
  // Corpus-scanned against the full data/review-texts corpus (BRO-3502,
  // 2026-09-15): of 7,063 existing bww-roundup/bww-reviews files, 4 hit this
  // predicate (3,803 after excluding files already wrongProduction:true).
  // Spot-checked all 4: 2 were confirmed LIVE contamination this guard's
  // predicate correctly identifies but — being write-time-only — cannot
  // retroactively fix on its own: a Guardian/Lyn Gardner "Jesus Christ
  // Superstar" review dated 84 days after the 2012 Broadway production
  // closed (a different, later production/tour, scored as if it were this
  // one) and a "Life of Pi" review dated 573 days after the 2023 Broadway
  // closing (the touring production, same contamination shape) — both
  // remediated by a one-off stamp in the same BRO-3502 pass, matching this
  // guard's exact field-write pattern. The other 2 hits are already excluded
  // from scoring by unrelated content-quality flags (contentTier: invalid /
  // nonReviewType: preview, contentVerification.wrongArticle: true) before
  // this guard ever runs, so
  // stamping wrongProduction on them is additive, not newly harmful — same
  // "hoist introduces no new false-positive class" bar Guard J's own comment
  // above documents for task #1150 (42,251-file scan, 2 hits, 1 legit).
  //
  // Known limitation shared with Guard J above (not new to this guard): this
  // check runs on `input.url` — the INCOMING candidate URL — before the
  // create-vs-merge fork below decides whether that candidate is even
  // accepted (maybeUpgradeUrl, in _mergeIntoExisting) or rejected in favor of
  // an existing file's already-correct URL. A rejected candidate can still
  // leave its wrongProduction stamp behind on the existing (correct) file.
  // Pre-existing architectural shape of this chokepoint, not something
  // BRO-3502 restructures (Codex adversarial review flagged this; fixing it
  // needs reordering guards around the merge decision for both Guard J and K
  // together, out of this fix's scope).
  if (!fields.wrongProduction) {
    const bwwReason = getWrongProductionReasonForBww(
      { url: input.url, source: input.source },
      _getShowById(showId),
    );
    if (bwwReason) {
      // Same criticName resolution as the real merge-target lookup below
      // (the `findExistingReviewFile` call that feeds _mergeIntoExisting,
      // `criticName !== 'Unknown' ? criticName : null`) — unlike
      // Guard J above, Guard K commonly fires with a REAL named critic (a
      // roundup/reviews page entry with a genuine byline), so a bare `null`
      // here could find a different existing file than the one this write
      // will actually merge into (e.g. a second critic at the same outlet),
      // missing that file's human-clear breadcrumb (Codex adversarial review,
      // BRO-3502 ship-check).
      const existingBwwData = _lookupExistingWrongProductionData(
        reviewTextsDir, showId, outletId, criticName !== 'Unknown' ? criticName : null, input.url
      );
      const humanClearedBww = _isHumanClearedWrongProduction(existingBwwData);
      if (humanClearedBww) {
        console.warn(`  ⏭️  Skipping BWW cross-production stamp for ${showId}/${outletId}: human override in place`);
      } else {
        fields.wrongProduction = true;
        fields.wrongProductionNote = `${bwwReason} (BWW cross-production)`;
        console.warn(`  ⚠️  ${bwwReason} (BWW cross-production) (${showId}/${outletId})`);
      }
    }
  }

  const showDir = path.join(reviewTextsDir, showId);

  // --- Guard: show directory hidden by a sparse checkout ---
  // Nothing on disk to merge into does not mean nothing exists: in a sparse
  // clone the show's real files are on origin, and a create here would
  // replace them wholesale on the next commit (2026-09-25, the-children-2017
  // WSJ review; see sparse-checkout-guard.js). Refuse instead of guessing.
  if (isShowDirHiddenBySparseCheckout(reviewTextsDir, showId)) {
    console.warn(`  ⛔ Refusing write: ${showId}/ is tracked but outside this sparse checkout — add it to the sparse set and re-run`);
    return { action: 'skipped', reason: 'show-dir-outside-sparse-checkout', guardRefused: true };
  }

  // --- Try to find existing file ---
  // Use the (possibly URL-refined) outletId for the filename, not the raw input.outletId
  const filename = generateReviewFilename(outletId, criticName);
  const filepath = path.join(showDir, filename);

  // Cross-scraper dedup: find by outlet+critic regardless of filename format.
  // Use the refined outletId (not input.outlet) so URL-based disambiguation is respected —
  // e.g. after refinement, outletId='timeout-london' not 'timeout' for timeout.com/london URLs.
  const existing = findExistingReviewFile(showDir, outletId, criticName !== 'Unknown' ? criticName : null, input.url);

  if (existing && existing.data) {
    return _mergeIntoExisting(existing.path, existing.data, { showId, outletId, input, fields, criticName, dryRun, onMerge });
  }

  // Belt-and-suspenders: exact filename fallback
  if (fs.existsSync(filepath)) {
    try {
      const data = JSON.parse(fs.readFileSync(filepath, 'utf8'));
      // BRO-3182 (Codex ship-check finding): an UNRESOLVED incoming critic
      // ('Unknown'/null) reaching this exact "outlet--unknown.json" path
      // proves nothing about identity — many different unknown-byline pieces
      // could collide there — so refuse when the target is flagged. A REAL
      // named critic reaching this path is a DIFFERENT situation: the
      // filename was constructed FROM that name (generateReviewFilename), so
      // matching it here already IS a confirmed identity match, exactly as
      // strong as findExistingReviewFile's own pass-1 same-critic match.
      // Refusing those too (an earlier version of this fix did) broke real
      // self-heal/override flows this exact fallback exists to serve:
      // maybeUpgradeUrl's #1695 stale-wrongProduction-on-genuine-stub clear,
      // and ingest-manual-review.js's operator-override escape hatch for a
      // duplicateOf-flagged file (test: review-file-writer-preserves-flags-
      // on-url-change.test.mjs) — both regressed until this was narrowed to
      // the unresolved-critic case only.
      const incomingCriticUnresolved = !criticName || criticName.toLowerCase() === 'unknown';
      if (incomingCriticUnresolved && isFlaggedMergeTarget(data)) {
        console.warn(`  ⛔ Refusing write: ${filename} is a flagged/rejected record (wrongProduction/duplicateOf/rejectionReason) and the incoming critic is unresolved — a human/override flow must clear it first`);
        return { action: 'skipped', reason: 'flagged-filename-collision', guardRefused: true, filepath };
      }
      return _mergeIntoExisting(filepath, data, { showId, outletId, input, fields, criticName, dryRun, onMerge });
    } catch { /* unreadable — fall through to create */ }
  }

  // --- Guard: non-review page submitted through the review form (NEW files only) ---
  // validate-review-submission.js's LLM gate let through ticket resellers
  // (tickpick, eventticketscenter, stuborder), venue "what's on" pages,
  // listing pages, a DVD review and press releases; each became a review
  // file a human later had to flag (≈60 of 1,887 submission-created files on
  // 2026-09-25). Deliberately narrow: the CURATED named patterns plus ticket
  // resellers only. classifyReviewUrl's broader non-review-host /
  // non-review-path rules would have refused real scored reviews (wbur.org
  // /news/ reviews, blogcritics.org, theaterscene.org). NEW files only, like
  // Guard F2 below, so a merge into an existing vetted file is never blocked
  // (the burn-this-2019 lesson noted at the named-non-review-url guard above).
  // Human escape hatch: fields.allowNonReviewUrl.
  if (input.source === 'submit-review-form' && input.url && fields.allowNonReviewUrl !== true) {
    const nrp = require('./non-review-url-patterns');
    // ugc-platform is excluded: a vocal.media "critique" submitted for
    // the-bathroom-attendant-off-broadway-2026 is a real named critic's
    // review (Robert M. Massimi), scored 64.
    const named = nrp.namedNonReviewReason(input.url);
    const submissionReason = (named && named !== 'ugc-platform' ? named : null)
      || (nrp.classifyReviewUrl(input.url).reason === 'ticketing-reseller' ? 'ticketing-reseller' : null);
    if (submissionReason) {
      console.warn(`  ⛔ Refusing submitted non-review page: ${input.url} (${submissionReason})`);
      return { action: 'skipped', reason: `submitted-non-review-url: ${submissionReason}`, guardRefused: true };
    }
  }

  // --- Guard F2: credited-person-as-critic rejection (BRO-2915) ---
  // A byline that is a CREATIVE TEAM member of this same show is not a review;
  // it is a mis-parsed roundup row. how-to-dance-in-ohio-2023 produced exactly
  // this file three times ("Sammi Cannold", the show's Director, with an article
  // headline as outletId and null url/publishDate/fullText). validate-data.js
  // already ERRORS on it, so each occurrence reddened main and was deleted by
  // hand — twice — while the source archive kept the row and the next extraction
  // re-wrote it. Detection after ingest cannot break that loop; refusing the
  // CREATE can. Same predicate object as the validator (CLAUDE.md §15), so the
  // two can never drift apart.
  //
  // NEW files only, like Guard I below: the resurrection is a re-CREATE after a
  // delete, so blocking creates is sufficient, and blocking merges would stop
  // the two existing matching files from ever self-healing.
  //
  // Scoped to the CREATIVE match only, deliberately. The validator treats a CAST
  // match as a WARNING, not an error, and a save-time rule stricter than the
  // validation rule would silently discard data no gate ever objected to.
  //
  // Operator-supplied rows are exempt. The SOURCE is the load-bearing half:
  // ingest-manual-review.js sets only `source: 'manual-entry'` and its score is
  // optional, so keying on humanReviewScore alone would exit(1) on an unscored
  // operator ingest of a genuine dual-role author. (`fields.manualEntry` has no
  // producer today and is kept only as forward compatibility.)
  const _operatorSupplied = input.source === 'manual-entry'
    || fields.humanReviewScore != null
    || fields.manualEntry === true;
  if (!_operatorSupplied) {
    const creditVerdict = evaluateCreditedPersonAsCritic(_getShowById(showId), criticName);
    // _getShowById swallows every load/parse error and caches {} for the life of
    // the process, so a missing or briefly-unreadable shows.json turns this guard
    // into a silent no-op that looks exactly like a clean pass. Fail OPEN is the
    // right call (refusing every write because the catalogue is unreadable would
    // be far worse), but it must not be SILENT. Warned once per process.
    if (creditVerdict.reason === 'no-show-record' && !_creditGuardInertWarned) {
      _creditGuardInertWarned = true;
      console.warn(`  ⚠️  Credited-person guard inert: no show record for ${showId} (not in shows.json, or shows.json is missing/unreadable) — this write is not being checked against creative credits`);
    }
    if (creditVerdict.kind === 'creative') {
      // Loud, like the misattribution guard above. A silent skip is how a
      // wrongly-scraped creativeTeam credit would veto a real review forever
      // with nobody ever seeing why.
      console.warn(`  ⚠️  Credited-person guard: "${criticName}" is a creative team member of ${showId} — refusing the write`);
      return {
        action: 'skipped',
        reason: `credited-person-as-critic: "${criticName}" is a creative team member of ${showId}`,
      };
    }
  }

  // --- Guard I: cross-show URL ownership (Notion 39a637c5-416f-8167) ---
  // A URL already held LIVE (unflagged, non-roundup) by another show belongs
  // to that show. Same-title siblings otherwise churn forever: discovery
  // title-matches the OPEN sibling (closed shows are filtered out of the
  // candidate set), a new file is created here, the cross-show audit re-flags
  // it, and the next poll re-creates it (tender-off-west-end-2026 vs
  // tender-by-dave-harris-off-west-end-2026, 2026-07-10/11). Re-homes stay
  // possible: when every cross-show copy is itself flagged wrongShow/
  // wrongProduction, creation proceeds. Manual escape hatch:
  // fields.allowCrossShowUrl. NEW files only — merges into this show's own
  // existing file were handled above.
  if (input.url && fields.allowCrossShowUrl !== true) {
    const owners = findCrossShowOwners(input.url, showId, reviewTextsDir);
    const verdict = shouldBlockCrossShowCreate(owners);
    // Reroute exemption: if Guard A just rerouted this write AWAY from the
    // owning show (owner is in the visited chain), the market-routing decision
    // explicitly supersedes the owner's copy — blocking here would discard the
    // review entirely (rerouted write skipped, nothing written anywhere; both
    // ship-check reviewers flagged this interaction). The origin's stale copy
    // is the cross-show audit's to reconcile.
    if (verdict.block && _rerouteVisited && _rerouteVisited.has(verdict.owner.showId)) {
      console.warn(`  ⚠️  Cross-show URL ownership: owner ${verdict.owner.showId} is in this write's reroute chain — allowing create under ${showId} (routing supersedes ownership)`);
    } else if (verdict.block) {
      console.warn(`  ⛔ Cross-show URL ownership: ${input.url} is live at ${verdict.owner.showId}/${verdict.owner.file} — refusing new file under ${showId}`);
      return { action: 'skipped', reason: `cross-show-url-owned:${verdict.owner.showId}` };
    }
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
  // BRO-3908 (Codex adversarial ship-check finding): `fields` is caller-owned
  // and can echo back a stale wrongProductionAutoCleared breadcrumb (e.g. an
  // import/replay payload) alongside the wrongProduction:true classifyMarketRouting/
  // Guard J/Guard K can set on it (see the merge-path comment below) — this
  // brand-new-file create path spreads `fields` directly into `newReview` and
  // never goes through _mergeIntoExisting's deferred invalidate, so it never
  // got the fix either. A NEW file can carry the exact self-contradictory
  // shape just as easily as a merged one.
  if (newReview.wrongProduction === true) {
    invalidateWrongProductionAutoClear(newReview);
  }

  // Apply misattribution flag to new files only (not merges — see Guard G note)
  if (_misattributionDetected) {
    newReview.suspectedMisattribution = true;
    newReview.misattributionReason = _misattributionReason;
  }

  // Classify content tier
  const tierResult = classifyContentTier(newReview);
  if (tierResult && tierResult.contentTier) {
    newReview.contentTier = tierResult.contentTier;
  }

  // Immutable creation clock — stamped here so it lands in the written JSON.
  stampFirstSeen(newReview);

  if (!dryRun) {
    if (!fs.existsSync(showDir)) {
      fs.mkdirSync(showDir, { recursive: true });
    }
    sanitizeDisplayFields(newReview);
    const writeResult = safeWriteReview(filepath, newReview, { merge: false });
    // BRO-3182 (Codex ship-check finding): same false-success bug as the
    // merge path below — safeWriteReview can quarantine/refuse a brand-new
    // file too (date-implausible, cross-market contamination), and this
    // create branch reported action:'new' unconditionally regardless.
    if (!writeResult || writeResult.wrote === false) {
      return {
        action: 'skipped',
        reason: (writeResult && writeResult.skipped) || 'write-guard-refused',
        // Authoritative refusal signal (Codex ship-check finding): a caller
        // should check THIS, not maintain its own copy of every possible
        // `reason` string — the set of guard reasons can grow independently.
        guardRefused: true,
        filepath,
        quarantinedPath: writeResult && writeResult.quarantinedPath,
      };
    }
    // Keep the process-wide ownership index current so a later create in this
    // same run (another show, same URL) hits Guard I without an fs rescan.
    // Pass the record so blocking state reflects any wrongProduction flag
    // Guard A stamped above — a flagged create must not poison the cache as a
    // live owner and block the legitimate destination show mid-run.
    if (newReview.url) recordUrlOwner(newReview.url, showId, filename, reviewTextsDir, newReview);
    // review-first-seen fires exactly once, on creation (never on merge).
    emitReviewFirstSeen(showId, { outletId, criticName, url: newReview.url });
  }

  return { action: 'new', filepath };
}

/**
 * Merge incoming data into an existing review file.
 * @private
 */
function _mergeIntoExisting(filepath, existing, ctx) {
  const { showId, input, fields, criticName, dryRun, onMerge } = ctx;
  let changed = false;
  // Full snapshot BEFORE any merge mutation runs (BRO-4130). Handed to
  // maybeUpgradeUrl below as opts.preMergeSnapshot so applyUrlChangeInvariant
  // judges staleness against the true on-disk state, not a copy taken after
  // the field-merge loop already blended this write's own incoming fields
  // into `existing` — see maybeUpgradeUrl's opts.preMergeSnapshot doc.
  const preMergeSnapshot = { ...existing };
  // Snapshot the body BEFORE the field merge so the reclassify step below can
  // tell "this merge just filled/replaced the text" apart from an unrelated
  // metadata merge.
  const fullTextBefore = existing.fullText || '';

  // Snapshot the score BEFORE the field merge too (BRO-4128 ship-check/Codex
  // finding): the merge loop below can plant fields.originalScore/
  // aggregatorStars onto `existing` when the file was previously unscored,
  // and that happens BEFORE maybeUpgradeUrl runs below. Without this
  // snapshot, maybeUpgradeUrl's score-loss guard would see its own incoming
  // score and refuse to also apply the incoming url — stranding a
  // freshly-discovered score on the file's OLD, still-bad url.
  const scoreBeforeMerge = {
    originalScore: existing.originalScore,
    aggregatorStars: existing.aggregatorStars,
  };

  // Clear a stored JSON-LD pullQuote/excerpt BEFORE the field merge. The merge
  // below only copies an incoming field when `!existing[key]`; a JSON-LD blob is
  // truthy, so it would block a clean incoming quote from landing — and then
  // sanitizeDisplayFields() would drop the blob at write, leaving the field
  // empty even though a good replacement was available. Clearing it here lets
  // the real incoming value win.
  for (const f of ['pullQuote', 'excerpt']) {
    if (hasJsonLdArtifact(existing[f])) { delete existing[f]; changed = true; }
  }

  // Fields that are FINAL once set by a human — never overwrite regardless of
  // whether the stored value is truthy or falsy. The !existing[key] guard below
  // already protects truthy values, but humanReviewedWrongProduction:false (human
  // explicitly verified it IS the right production) is falsy and must not be clobbered.
  // Exception: manual-entry source (ingest-manual-review.js) is intentional human
  // override and must be able to update or correct these fields.
  const HUMAN_PROTECTED = new Set([
    'humanReviewedWrongProduction',
    'humanReviewScore',
    'humanReviewedScore',
  ]);
  const isManualEntry = input.source === 'manual-entry';

  // Manual-entry protection-field force-override (ST-1, 2026-07): the generic
  // merge loop below only writes a field when the EXISTING value is falsy —
  // correct for scraper writes (never clobber a value someone already set), but
  // wrong for an intentional human correction. A manual ingest onto an existing
  // wrongProduction:true file left the stale flag in place because
  // `!existing.wrongProduction` is false, so the merge skipped it — the review
  // kept blocking rebuild despite the operator's override (live-broken on Grace
  // Pervades). buildManualReviewFields() lists every field it guarantees in
  // fields.protectedFields; for manual-entry merges those fields always win,
  // regardless of the existing value.
  if (isManualEntry && Array.isArray(fields.protectedFields)) {
    for (const key of fields.protectedFields) {
      if (!(key in fields)) continue;
      const val = fields[key];
      if (val === undefined) continue;
      if (JSON.stringify(existing[key]) !== JSON.stringify(val)) {
        existing[key] = val;
        changed = true;
      }
    }
  }

  // Default field merge: set scraper-specific fields if existing value is falsy.
  // Exception: skip isRoundupArticle if it was manually cleared — !false would otherwise
  // re-flag the file even though a human explicitly cleared it.
  //
  // BRO-3895: this loop is the ONLY place fields.wrongProduction (stamped by
  // classifyMarketRouting's accept-with-flag branch, Guard J, and Guard K
  // above — none of which call invalidateWrongProductionAutoClear themselves,
  // unlike every other wrongProduction writer per that function's docstring)
  // actually lands on `existing`. Without an invalidate call, a re-flag onto a
  // file still carrying a stale wrongProductionAutoCleared breadcrumb from an
  // earlier clear produces wrongProduction:true sitting beside its own
  // retraction breadcrumb — the exact self-contradictory-clear shape
  // audit-self-contradictory-clear-drained.test.mjs gates on (caught live on
  // much-ado-about-nothing-globe-off-west-end-2026/broadwayworld--aliya-al-
  // hassan.json). Tracked via a flag and invalidated ONCE after the loop,
  // not inline: `fields` is `input.fields` (a caller-owned object, mutated
  // in place by the guards above) — inline invalidation deletes
  // existing.wrongProductionAutoCleared mid-loop, and a LATER key in that
  // same object (e.g. a replay/import payload that also echoes back
  // wrongProductionAutoCleared) would immediately re-add it via this same
  // `!existing[key]` branch before the loop finishes (ship-check/Codex
  // adversarial finding).
  let wrongProductionNewlyFlagged = false;
  for (const [key, val] of Object.entries(fields)) {
    if (key === 'isRoundupArticle' && shouldSkipRoundupAudit(existing)) continue;
    if (HUMAN_PROTECTED.has(key)) {
      // Scrapers: skip once set (even if stored value is falsy — e.g. humanReviewedWrongProduction:false).
      // Manual entry: always update (intentional human correction should win).
      if (!isManualEntry && existing[key] != null) continue;
      if (val != null && existing[key] !== val) {
        existing[key] = val;
        changed = true;
      }
      continue;
    }
    if (val != null && !existing[key]) {
      existing[key] = val;
      changed = true;
      if (key === 'wrongProduction' && val === true) wrongProductionNewlyFlagged = true;
    }
  }
  if (wrongProductionNewlyFlagged) {
    invalidateWrongProductionAutoClear(existing);
  }

  // wrongShow-unknown URL lock (task #1150, 2026-08-09; DoaS Apr 9-10 #13). When
  // an existing wrongShow=true file's critic AND the incoming critic both
  // normalize to unknown/unnamed, outlet+"unknown" is too weak an identity
  // match to justify reassigning the URL — an Unknown-byline discovery loop
  // (RSS, SERP) can otherwise repeatedly overwrite a flagged file's URL with
  // another wrong one. This guard already existed only in gather-reviews.js's
  // own merge logic; every other writer reaching review-texts through this
  // function had no equivalent. Named-critic URL upgrades are unaffected —
  // only the both-unknown case is locked, and only the URL field (other
  // fields still merge normally below). Corpus-scanned (task #1150): 260
  // existing wrongShow=true + unknown-critic files in the corpus — informational
  // only, since this guard only affects a FUTURE merge attempt onto one of
  // those files, not any existing state retroactively.
  const urlLocked = existing.wrongShow === true && isWrongShowUnknownLocked(existing, { criticName });
  if (urlLocked) {
    console.warn(`  ⊘ wrongShow lock: refusing to reassign URL on ${filepath} (both critics unknown)`);
  }

  // URL upgrade — pass the show title so the cross-show guard can reject a
  // candidate URL that belongs to a different show (combined-roundup
  // contamination), and the full show record so the regression guard (#1416)
  // can reject a candidate dated outside the current run (a prior production).
  if (!urlLocked && input.url && maybeUpgradeUrl(existing, input.url, input.source, {
    showTitle: _getShowTitle(showId),
    show: _getShowById(showId),
    // BRO-3092: sibling URL-collision guard. findExistingReviewFile's pass-0
    // URL dedup skips wrongProduction/duplicateOf files, so a flagged sibling
    // that already owns input.url routes the write here by outlet+critic
    // instead — the swap would duplicate the URL and wipe this file.
    showDir: path.dirname(filepath),
    selfFilename: path.basename(filepath),
    // BRO-4128: pre-merge score snapshot — see maybeUpgradeUrl's docstring.
    preMergeScore: scoreBeforeMerge,
    // BRO-4130: full pre-merge snapshot, used as applyUrlChangeInvariant's
    // "before" — see maybeUpgradeUrl's opts.preMergeSnapshot docstring.
    preMergeSnapshot,
  })) {
    changed = true;
  }
  if (!urlLocked && input.url && !existing.url &&
      !slugLooksLikeDifferentShow(input.url, { showTitle: _getShowTitle(showId) })) {
    // Same regression guard as the upgrade path above (#1416 ship-check
    // finding): an empty-url record accepted maybeUpgradeUrl's refusal
    // silently, then fell through to this first-set branch, which only ever
    // checked the cross-show slug guard — a wrong-production candidate on a
    // brand-new file bypassed the date-window check entirely.
    const _show = _getShowById(showId);
    const _swapVerdict = _show
      ? isUrlSwapRegression({ newUrl: input.url, show: _show, outletId: existing.outletId })
      : { regression: false };
    // BRO-3092 ship-check (Codex): this first-set branch is a bypass of the
    // maybeUpgradeUrl guard above, exactly as it was of the #1416 date-window
    // guard. An empty-url record accepts the refusal silently and then falls
    // through here, which only checked the cross-show slug + date guards — so a
    // URL a sibling already owns lands on a brand-new/empty-url file and the
    // duplicate is created anyway, with the operator having seen a "refused
    // colliding swap" warning.
    const _collisionOwner = findSiblingUrlOwner({
      showDir: path.dirname(filepath),
      url: input.url,
      selfOutletId: existing.outletId,
      selfCriticName: existing.criticName,
      selfFilename: path.basename(filepath),
    });
    if (_swapVerdict.regression) {
      console.warn(`  ⊘ url-downgrade guard: refusing first-set url on ${filepath}: ${_swapVerdict.reason}`);
    } else if (_collisionOwner) {
      console.warn(`  ⊘ url-collision guard: refusing first-set url on ${filepath}: ${input.url} is already owned by ${_collisionOwner.filename}`);
    } else {
      existing.url = input.url;
      changed = true;
    }
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

  // Update sources array. Compare before/after — the old `_prevSourcesLen`
  // sentinel was read but never written, so any file that already had a
  // sources array reported changed on EVERY merge and was rewritten with
  // identical content (idempotency bug, found via convert-show-score parity
  // testing, card 38b637c5).
  if (input.source) {
    const before = JSON.stringify(existing.sources || null);
    const sources = new Set(existing.sources || [existing.source || '']);
    sources.add(input.source);
    const next = Array.from(sources).filter(Boolean);
    if (JSON.stringify(next) !== before) {
      existing.sources = next;
      changed = true;
    }
  }
  delete existing._prevSourcesLen;

  // Reclassify content tier when THIS merge changed the body. The default
  // field merge fills fullText into a previously-empty file (self-heal
  // refetch, url-ingest onto a stub) but left the OLD body's verdict in
  // place: contentTier 'stub' + incompleteReason 'scraper_garbage' from a
  // garbage first fetch survived a clean refetch, so the healed review
  // stayed excluded from rebuild forever (Sukkot / Theater Pizzazz
  // 2026-07-25 — the missing half of the #362 self-heal chain). Manual tier
  // locks (manualContentTier) always win; stale incompleteness metadata is
  // dropped only when the fresh body actually classifies as usable.
  if (existing.fullText && existing.fullText !== fullTextBefore && !existing.manualContentTier) {
    // BRO-1431: neutralize stale exclusion state BEFORE reclassifying content
    // tier below — classifyContentTier()'s T5/invalid check
    // (isEffectivelyWrongProductionOrShow) reads wrongProduction/
    // wrongProductionAutoCleared directly, so clearing the flag AFTER
    // classification would classify against the stale flag and stay
    // 'invalid' for one extra merge. See stale-flag-neutralization.js for
    // the full reasoning and the guardrails against over-clearing.
    const neutralized = neutralizeStaleFlagsOnBodyReplacement(existing, fullTextBefore);
    if (neutralized.length > 0) changed = true;

    const tierResult = classifyContentTier(existing);
    const newTier = tierResult && tierResult.contentTier;
    if (newTier && newTier !== existing.contentTier) {
      existing.contentTier = newTier;
      changed = true;
    }
    // Stale failure metadata (incompleteReason 'scraper_garbage', fetch
    // counters, garbage_text rejections) describes the OLD body. Clear it via
    // the canonical helper, NOT a hand-rolled delete — clearFailureFlags owns
    // the per-reason semantics (paywall/wrong_content/no_url each have their
    // own release condition), so a truncated paywall refetch keeps its retry
    // context while a genuinely-healed body sheds the garbage verdict.
    if (clearFailureFlags(existing).length > 0) changed = true;

    // Card #1902: this fullText change may have just made a prior
    // excerpt-based score stale. isStaleScoreInput() is the single gate
    // shared with rebuild-all-reviews.js's wrongProduction auto-clear sites
    // — it already requires a prior assignedScore (so a never-scored file
    // is untouched) and isScoreable() (so a non-includable file can never
    // become a stuck flag, the 278-file guard from card #1902's audit).
    if (isStaleScoreInput(existing, undefined, filepath)) {
      markRescoreNeeded(existing, 'fullText added after excerpt-based score');
      changed = true;
    }
  }

  if (!changed) {
    return { action: 'skipped', reason: 'no-changes', filepath };
  }

  if (!dryRun) {
    sanitizeDisplayFields(existing);
    const writeResult = safeWriteReview(filepath, existing, { merge: false });
    // BRO-3182: safeWriteReview can refuse/redirect a write entirely (e.g.
    // date-implausible or cross-market-contamination quarantine to
    // _pending/) and return `wrote: false` — nothing on disk changed. This
    // return value went unchecked, so a guard-dropped write still reported
    // 'updated' here, and the caller printed "Updated" and exited 0 with no
    // actual diff on disk. Surface the refusal instead of masking it.
    if (!writeResult || writeResult.wrote === false) {
      return {
        action: 'skipped',
        reason: (writeResult && writeResult.skipped) || 'write-guard-refused',
        guardRefused: true,
        filepath,
        quarantinedPath: writeResult && writeResult.quarantinedPath,
      };
    }
  }

  return { action: 'updated', filepath };
}

// Skip reasons from createOrMergeReviewFile that mean the requested write
// was actively REFUSED or REDIRECTED — by safeWriteReview's own guards
// (date-implausible/cross-market quarantine to _pending/) or by
// createOrMergeReviewFile itself refusing to touch a flagged/rejected file
// with no confirmed identity match (BRO-3182) — distinct from a benign
// no-op ('no-changes', 'onMerge-aborted') where nothing new was ever
// attempted. A caller reporting success to an operator (a script printing
// "Updated"/"Created", an automated ingest) must treat these as failures.
const WRITE_GUARD_REFUSED_REASONS = new Set([
  'write-guard-refused',
  'date_implausible',
  'cross_market_contamination',
  'flagged-filename-collision',
  'show-dir-outside-sparse-checkout',
]);

module.exports = { createOrMergeReviewFile, stampFirstSeen, emitReviewFirstSeen, WRITE_GUARD_REFUSED_REASONS };
