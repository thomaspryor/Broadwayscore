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
  isJunkOutlet,
  isSuspiciousOutletId,
  maybeUpgradeUrl,
  slugLooksLikeDifferentShow,
  getOutletDisplayName,
  resolveOutletFromUrl,
  loadOutletRegistry,
} = require('./review-normalization');
const { validateUrlDomain } = require('./url-discovery');
const { safeWriteReview } = require('./review-write-guard');
const { classifyContentTier } = require('./content-quality');
const { clearFailureFlags } = require('./clear-failure-flags');
const { pickRerouteTarget, shouldSkipRoundupAudit, isRoundupPageAsReview, isLikelyTourReview, getWrongProductionReasonForUnknownCritic, isWrongShowUnknownLocked } = require('./review-guards');
const { detectRoundupDigest } = require('./roundup-digest');
const { isBroadwayUrl, isLondonMarket } = require('./venue-classification');
const { classifyMarketRouting, buildSiblingIndex } = require('./market-routing');
const { sanitizeCriticName } = require('./byline-normalization');
const { findCrossShowOwners, shouldBlockCrossShowCreate, recordUrlOwner } = require('./url-ownership');
const { decodeHtmlEntities, hasUndecodedHtmlEntities, hasJsonLdArtifact } = require('./text-cleaning');
const { emitStage } = require('./stage-latency');
const { shouldSkipAggregatorUrlWrite, shouldRefuseAggregatorOutletRefinement, hasPreservableAggregatorScore, isAggregatorReviewSource } = require('./aggregator-domains');
const { EXCERPT_FIELDS } = require('./excerpt-fields');

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

// ─── Lazy-loaded full show object map for Guard J (unknown-critic wrongProduction) ───
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
        // fixing). Same for the manual-clear / override flags. Three signals
        // count as "human decision in place":
        //   • humanReviewedWrongProduction === false  (manual review verified RIGHT production)
        //   • wrongProductionManualClear === true      (manual clear)
        //   • wrongProduction === false                (explicitly cleared, not just absent)
        // Look up the existing file via the same path the merge step uses so
        // we don't add a redundant read.
        const showDirForCheck = path.join(reviewTextsDir, showId);
        const existingForCheck = findExistingReviewFile(
          showDirForCheck,
          outletId,
          (input.criticName && input.criticName !== 'Unknown') ? input.criticName : null,
          input.url
        );
        const existingData = existingForCheck && existingForCheck.data;
        const humanCleared = existingData && (
          existingData.humanReviewedWrongProduction === false ||
          existingData.wrongProductionManualClear === true ||
          existingData.wrongProductionOverride === true ||
          existingData.wrongProduction === false
        );
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
      // a verified-correct human decision.
      const showDirForWpCheck = path.join(reviewTextsDir, showId);
      const existingForWpCheck = findExistingReviewFile(showDirForWpCheck, outletId, null, input.url);
      const existingWpData = existingForWpCheck && existingForWpCheck.data;
      const humanClearedWp = existingWpData && (
        existingWpData.humanReviewedWrongProduction === false ||
        existingWpData.wrongProductionManualClear === true ||
        existingWpData.wrongProduction === false
      );
      if (humanClearedWp) {
        console.warn(`  ⏭️  Skipping unknown-critic wrongProduction stamp for ${showId}/${outletId}: human override in place`);
      } else {
        fields.wrongProduction = true;
        fields.wrongProductionReason = wpReason;
        console.warn(`  ⚠️  ${wpReason} (${showId}/${outletId})`);
      }
    }
  }

  const showDir = path.join(reviewTextsDir, showId);

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
      return _mergeIntoExisting(filepath, data, { showId, outletId, input, fields, criticName, dryRun, onMerge });
    } catch { /* unreadable — fall through to create */ }
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
    safeWriteReview(filepath, newReview, { merge: false });
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
  // Snapshot the body BEFORE the field merge so the reclassify step below can
  // tell "this merge just filled/replaced the text" apart from an unrelated
  // metadata merge.
  const fullTextBefore = existing.fullText || '';

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
    }
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
  if (!urlLocked && input.url && maybeUpgradeUrl(existing, input.url, input.source, { showTitle: _getShowTitle(showId), show: _getShowById(showId) })) {
    changed = true;
  }
  if (!urlLocked && input.url && !existing.url &&
      !slugLooksLikeDifferentShow(input.url, { showTitle: _getShowTitle(showId) })) {
    existing.url = input.url;
    changed = true;
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
  }

  if (!changed) {
    return { action: 'skipped', reason: 'no-changes', filepath };
  }

  if (!dryRun) {
    sanitizeDisplayFields(existing);
    safeWriteReview(filepath, existing, { merge: false });
  }

  return { action: 'updated', filepath };
}

module.exports = { createOrMergeReviewFile, stampFirstSeen, emitReviewFirstSeen };
