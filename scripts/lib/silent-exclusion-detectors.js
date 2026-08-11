/**
 * silent-exclusion-detectors.js — two more instances of the #1147 silent-exclusion
 * class: a pipeline stage refuses to include a review and records nothing an
 * operator would ever look at.
 *
 * Born 2026-08-09/10 from two live incidents in the same session, both fixed by
 * hand with no detector left behind for the next occurrence (card #1188):
 *
 *   MISSING contentTier   rosie-odonnell-common-knowledge-off-broadway-2026's
 *     nyt-theater--jonathan.json had fullText, a real byline, no rejection
 *     flags, llmScore 78 — and no contentTier (cleared while clearing
 *     wrongProduction, expecting rebuild to re-derive it). It stayed OUT of
 *     reviews.json through a full scoring + rebuild run. classifyContentTier
 *     gave 'complete' (744 words) once restored by hand.
 *
 *   OUTLET DOMAIN MOVE    one-minute-critic moved to 1minutecritic.substack.com;
 *     the registry knew only 1minutecritic.com, so every review on the new
 *     host hit domain-mismatch and was dropped (ingest printed
 *     'Skipped: domain-mismatch: ...' — a routine, easy-to-miss no-op line).
 *     Fixed by adding the host to domainAliases. Outlets migrating to
 *     Substack/WordPress/etc. is now common; nothing flags the next one.
 *
 * Both predicates are pure and read-only: they REPORT candidates for a human
 * to confirm, they never write. See scripts/lib/ingest-skip-classify.js for
 * the sibling module this one follows (same tracker, same shape: a pipeline
 * stage's silent refusal made visible).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { listShowDirs } = require('./list-show-dirs');
const { isIncludableForRebuild } = require('./review-guards');

// ── (b) missing contentTier ─────────────────────────────────────────────

const MIN_FULLTEXT_LENGTH = 200; // below this, "missing tier" is not the bug — there's nothing to tier

/**
 * True when a review-text file has everything a scored, includable review
 * needs EXCEPT a contentTier — the exact shape that let one real review sit
 * OUT of reviews.json through a full scoring + rebuild run (card #1188).
 * rebuild-all-reviews.js DOES run a reclassification safety net on every
 * pass (line ~2049), so this gap is not the common case any more — this
 * predicate exists for whatever narrow path let the real incident evade it
 * (not fully root-caused), and for any future write path that clears
 * contentTier without going through that safety net at all.
 *
 * @param {object} data - parsed review-text JSON
 * @param {object} [show] - the review's show record from shows.json (by id),
 *   or undefined/{} if unavailable. Forwarded to isIncludableForRebuild,
 *   whose show-context checks (isPrematureReviewForUnopenedShow) need the
 *   real record — passing `{}` for every call makes that check permanently
 *   inert (its `status` read is always '', which never matches
 *   'announced'/'upcoming'/'previews'), silently hiding a real exclusion
 *   reason for reviews of not-yet-open shows (found in the #1188 duplicate-
 *   dispatch review, 2026-08-10). Every other isIncludableForRebuild caller
 *   in this codebase looks up the real show by id for exactly this reason
 *   (scripts/check-review-count-drift.js, audit-show-review-gap.js, etc.).
 * @param {string} [filePath] - forwarded to isIncludableForRebuild for its
 *   filePath-dependent checks (e.g. rejectedAt vs textFetchedAt re-fetch
 *   detection); optional, matching isIncludableForRebuild's own signature.
 * @returns {boolean}
 */
function isMissingContentTierGap(data, show, filePath) {
  if (!data || typeof data !== 'object') return false;
  if (data.contentTier) return false; // has a tier — not the gap
  // manualContentTier is a human override that classifyContentTier() (content-quality.js)
  // resolves into contentTier on the next rebuild pass — a freshly manually-ingested
  // review carries manualContentTier without contentTier yet and is NOT a silent gap,
  // it just hasn't been rebuilt since ingest (ingest-manual-review.js sets
  // manualContentTier='complete' but never writes contentTier itself).
  if (data.manualContentTier) return false;
  if (typeof data.fullText !== 'string' || data.fullText.trim().length < MIN_FULLTEXT_LENGTH) return false;
  if (!data.criticName || data.criticName === 'Unknown') return false; // real byline required
  // Delegate exclusion-flag gating to the canonical predicate (memory:
  // feedback_includability_predicates_must_be_canonical.md) rather than a
  // hand-rolled flag list — isIncludableForRebuild's ~18 checks include
  // stale-flag overrides (wrongShowCleared, wrongProductionManualClear,
  // isLikelyStaleRoundupFlag) a flat Boolean(data[flag]) list would get
  // wrong in both directions: false-flagging a file whose rejection was
  // already cleared, and missing exclusion classes the flat list never
  // knew about (isNonReview, fabricatedEntry, rejectedAt, ...). `show` may
  // be undefined (orphan review-text dir with no shows.json entry) —
  // isIncludableForRebuild's show-context checks treat that the same as
  // `{}` (safe default, matches every other caller's convention).
  if (!isIncludableForRebuild(data, show, filePath)) return false;
  return true;
}

/**
 * Scan a review-texts directory tree for isMissingContentTierGap() hits.
 * Read-only. Uses listShowDirs() so one dangling symlink doesn't crash the
 * scan (memory: feedback_stray_symlink_crashes_pipeline.md).
 *
 * @param {string} reviewTextsDir - path to data/review-texts
 * @param {object} [showsById] - showId -> show record (data/shows.json,
 *   pre-indexed by caller), forwarded per-file to isIncludableForRebuild so
 *   its show-context checks (e.g. premature-review-for-unopened-show) can
 *   actually run. A showId with no entry passes `undefined` through — same
 *   safe-default behavior as every other isIncludableForRebuild caller.
 * @returns {Array<{showId: string, file: string, criticName: string, outletId: string|null, outlet: string|null, url: string|null, wordCount: number}>}
 */
function scanMissingContentTier(reviewTextsDir, showsById) {
  const results = [];
  for (const showId of listShowDirs(reviewTextsDir)) {
    // `_`-prefixed dirs (e.g. `_superseded-misattributed`, `_pending`) are
    // sentinel/staging directories, not real shows — same skip convention as
    // url-ownership.js, review-file-writer.js, audit-cross-outlet-
    // attributions.js. Reporting a hit as showId '_superseded-misattributed'
    // would point an operator at a nonexistent show.
    if (showId.startsWith('_')) continue;
    const showDir = path.join(reviewTextsDir, showId);
    let files;
    try {
      files = fs.readdirSync(showDir).filter((f) => f.endsWith('.json'));
    } catch {
      continue;
    }
    for (const file of files) {
      const filePath = path.join(showDir, file);
      let data;
      try {
        data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      } catch {
        continue;
      }
      const show = showsById ? showsById[showId] : undefined;
      if (isMissingContentTierGap(data, show, filePath)) {
        results.push({
          showId,
          file,
          criticName: data.criticName,
          // outletId (the canonical registry key) is what reviews.json's
          // entries carry — kept distinct from `outlet` (display name) so a
          // caller can match against reviews.json without guessing which one.
          outletId: data.outletId || null,
          outlet: data.outlet || data.outletId || null,
          // url disambiguates two review-text files sharing showId+outletId+
          // criticName (a republished article, or byline-enrichment landing
          // on two separate URLs) — a caller can match on url FIRST so one
          // file already live in reviews.json doesn't mask the other file's
          // genuine gap (ship-check finding).
          url: data.url || null,
          wordCount: data.fullText.trim().split(/\s+/).length,
        });
      }
    }
  }
  return results;
}

// ── (a) outlet domain moves ─────────────────────────────────────────────

// Hosting platforms whose TLD carries no outlet identity — the real identity
// lives in the subdomain (jerryportwood.substack.com, not "substack"). Strip
// these BEFORE the generic single-label TLD strip below, or the subdomain
// would be discarded instead of the platform suffix.
const PLATFORM_SUFFIXES = /\.(substack\.com|wordpress\.com|medium\.com|blogspot\.com|wixsite\.com|squarespace\.com|ghost\.io)$/i;

// Two-label TLDs that a single-label strip would mishandle (.co.uk → "co",
// wrong; must strip both labels). ship-check finding (ship-check round 2,
// ORIGINAL list only covered UK/AU/NZ): any OTHER real two-label ccTLD fell
// through to the generic single-label strip, which removes only the last
// label and leaves the second-to-last as "identity" — confirmed by direct
// execution: 'guardian.co.za' normalized to 'co', 'example.com.br' to 'com'.
// Both clear MIN_SLUG_LENGTH=3, so two unrelated outlets on an unlisted
// .com.xx-style ccTLD would collide on the generic slug 'com'/'co' and get
// falsely flagged as domain-moves of each other — the exact false-positive
// class this comparison was redesigned to eliminate (task #1228). Aligned
// with outlet-canonicalize.js's PROVISIONAL_MULTIPART_SUFFIXES list (same
// source of truth for "which ccTLDs are two-label"), plus co.id (already a
// live registry outlet, show-showdown / blogspot.co.id).
const TWO_LABEL_TLDS = /\.(co\.uk|com\.au|org\.uk|co\.nz|org\.au|me\.uk|ac\.uk|gov\.uk|net\.au|co\.za|com\.br|co\.id)$/i;

// Below this, a domain-slug match is too generic to be "probable". Lower
// than the old alias-based floor (was 4, with a separate 3-char carve-out
// for short outletIds like vox/cnn/gq) because domain-vs-domain comparison
// is inherently more precise than matching generic English words in
// aliases/displayName — the false-positive surface that required the
// higher floor (typo aliases, common descriptive words) no longer exists
// once both sides being compared are real registered domain text.
const MIN_SLUG_LENGTH = 3;

/**
 * Reduce a host to its bare outlet-identity slug: strip www., a hosting
 * platform's own domain / the TLD, then take the LAST remaining dot-segment
 * (any earlier segment is a subdomain/section prefix, not the identity).
 *   '1minutecritic.substack.com'          → '1minutecritic'
 *   'www.theatre-weekly.co.uk'            → 'theatreweekly'
 *   'theater.jerryportwood.substack.com'  → 'jerryportwood'  (not 'theater')
 *   'news.dancemagazine.co.uk'            → 'dancemagazine'  (not 'news')
 *
 * ship-check finding: applying the generic single-label-TLD strip
 * UNCONDITIONALLY after the platform/two-label strip already ran ate the
 * real identity label on any 3+-label host (e.g. the jerryportwood example
 * above came back 'theater'). Exactly one suffix strip now runs — platform,
 * else two-label TLD, else generic single-label TLD — and taking the last
 * remaining segment handles any leftover subdomain prefix correctly.
 *
 * @param {string} host
 * @returns {string}
 */
function normalizeHostSlug(host) {
  if (!host) return '';
  let h = String(host).toLowerCase().trim();
  h = h.replace(/^www\./, '');
  if (PLATFORM_SUFFIXES.test(h)) {
    h = h.replace(PLATFORM_SUFFIXES, '');
  } else if (TWO_LABEL_TLDS.test(h)) {
    h = h.replace(TWO_LABEL_TLDS, '');
  } else {
    h = h.replace(/\.[a-z]{2,}$/i, ''); // remaining single-label TLD (.com, .org, .net, ...)
  }
  const segments = h.split('.').filter(Boolean);
  const identity = segments.length ? segments[segments.length - 1] : h;
  return identity.replace(/[^a-z0-9]/g, '');
}

/**
 * Find hosts in an "unknown aggregator outlets" census whose slug matches a
 * REGISTERED outlet's OWN DOMAIN slug (not its display name or aliases), but
 * whose host is not already in that outlet's domain/domainAliases — i.e. a
 * probable domain move (or a new mirror) the registry doesn't know about yet.
 *
 * Pure: takes already-loaded registry `outlets` (the `.outlets` map of
 * data/outlet-registry.json) and an array of census entries
 * (data/audit/unknown-aggregator-outlets.json's `.outlets`), does no I/O.
 *
 * Bug found live in production the day this shipped (task #1228): matching
 * against outlet.displayName/aliases instead of the outlet's OWN domain
 * flagged 'guardian.ng' (The Guardian Nigeria — a real, distinct outlet) as
 * a probable move of 'The Guardian' (UK, domain theguardian.com), because
 * 'guardian' is both the UK outlet's outletId AND an alias, but is not
 * actually part of its domain text. Comparing host-slug against
 * domain-slug (both put through the SAME normalizeHostSlug()) fixes this:
 * 'theguardian.com' normalizes to 'theguardian', which 'guardian.ng'
 * ('guardian') does not match — while '1minutecritic.substack.com' still
 * correctly matches outlet domain '1minutecritic.com' ('1minutecritic').
 * This also means MIN_OUTLET_ID_LENGTH's short-outlet carve-out (vox, cnn,
 * gq, lbc) is no longer needed as a special case: their own domains
 * (vox.com, cnn.com, ...) already normalize to the same short slug.
 *
 * Known non-blocking follow-ups (ship-check, not fixed here — advisory
 * detector already validated against the real corpus):
 *   - PLATFORM_SUFFIXES/TWO_LABEL_TLDS partially duplicate
 *     outlet-canonicalize.js's PROVISIONAL_BLOG_PLATFORMS/
 *     PROVISIONAL_MULTIPART_SUFFIXES (missing tumblr.com, .gov.uk, etc.) —
 *     worth unifying if either list needs to grow again.
 *   - A future alternative worth evaluating: review-file-writer.js already
 *     computes an exact domain-mismatch CONFLICT signal at ingest time
 *     (classified by ingest-skip-classify.js); a persisted census of THOSE
 *     could replace this fuzzy domain-slug-matching approach with an exact
 *     one.
 *   - On an ambiguous slug collision between two registered outlets' own
 *     domains (rare — two different outlets whose domains normalize
 *     identically), this returns only the first match (Object.entries
 *     iteration order), unhandled.
 *
 * A host that is ALREADY some OTHER outlet's own registered domain (or
 * domainAlias) is never a move candidate at all, no matter what it
 * slug-matches — it is already correctly identified. Found live (task
 * #1254): 'dancemagazine.co.uk' is Dance Informa Magazine UK's own domain
 * (real, distinct outlet from Dance Magazine US), but it still slug-matched
 * dance-magazine.com ('dancemagazine' === 'dancemagazine') and got flagged
 * as a probable move — the same-brand-word-across-TLDs class the #1228
 * domain-vs-domain redesign could not separate on slug text alone. The old
 * per-outlet `knownHosts.has(host)` check only skipped comparison against
 * THE OUTLET BEING COMPARED, not the whole host — so registering the host
 * as ITS OWN outlet's domain never suppressed a slug match against a
 * DIFFERENT outlet later in the same Object.entries() iteration. Checking
 * exact host membership against the registry's FULL known-host set once,
 * before any slug comparison, closes that gap without touching the
 * legitimate slug-match path (a genuinely unregistered host is absent from
 * this set entirely).
 *
 * @param {object} outlets - outletId -> {domain, domainAliases}
 * @param {Array<{host: string, occurrences?: number, sampleUrls?: string[]}>} unknownHosts
 * @returns {Array<{host: string, outletId: string, occurrences: number|null, sampleUrls: string[]}>}
 */
function findProbableDomainMoves(outlets, unknownHosts) {
  const results = [];
  if (!outlets || !Array.isArray(unknownHosts)) return results;

  const allKnownHosts = new Set();
  for (const outlet of Object.values(outlets)) {
    if (!outlet) continue;
    for (const h of [outlet.domain, ...(outlet.domainAliases || [])]) {
      if (h) allKnownHosts.add(String(h).toLowerCase());
    }
  }

  for (const entry of unknownHosts) {
    const host = entry && entry.host;
    if (!host) continue;
    if (allKnownHosts.has(host.toLowerCase())) continue; // already registered SOMEWHERE — not a move
    const slug = normalizeHostSlug(host);
    if (slug.length < MIN_SLUG_LENGTH) continue;
    for (const [outletId, outlet] of Object.entries(outlets)) {
      if (!outlet) continue;
      // A "move" implies an OLD host is already on file. An outlet with no
      // `domain` at all (many defunct/manually-registered entries have only
      // aliases, no domain) isn't a move candidate — it's a differently-shaped
      // gap (missing domain), and there is nothing to compare the census
      // host against.
      if (!outlet.domain) continue;

      const domainSlug = normalizeHostSlug(outlet.domain);
      if (domainSlug.length >= MIN_SLUG_LENGTH && domainSlug === slug) {
        results.push({
          host,
          outletId,
          occurrences: entry.occurrences ?? null,
          sampleUrls: entry.sampleUrls || [],
        });
        break; // one match per host is enough to flag it
      }
    }
  }
  return results;
}

module.exports = {
  isMissingContentTierGap,
  scanMissingContentTier,
  normalizeHostSlug,
  findProbableDomainMoves,
  MIN_FULLTEXT_LENGTH,
  MIN_SLUG_LENGTH,
};
