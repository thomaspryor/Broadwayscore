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
const { VALIDATOR_EXCLUSION_FLAGS } = require('./aggregator-url-latent');

// ── (b) missing contentTier ─────────────────────────────────────────────

const MIN_FULLTEXT_LENGTH = 200; // below this, "missing tier" is not the bug — there's nothing to tier

/**
 * True when a review-text file has everything a scored, includable review
 * needs EXCEPT a contentTier — the exact shape that silently drops out of
 * reviews.json (rebuild only re-derives contentTier when fullText changes;
 * a review whose fullText was already there before contentTier vanished
 * never re-triggers that path).
 *
 * @param {object} data - parsed review-text JSON
 * @returns {boolean}
 */
function isMissingContentTierGap(data) {
  if (!data || typeof data !== 'object') return false;
  if (data.contentTier) return false; // has a tier — not the gap
  if (typeof data.fullText !== 'string' || data.fullText.trim().length < MIN_FULLTEXT_LENGTH) return false;
  if (!data.criticName || data.criticName === 'Unknown') return false; // real byline required
  // Any known rejection/exclusion flag means this file is a deliberate
  // tombstone, not a silently-dropped live review.
  if (VALIDATOR_EXCLUSION_FLAGS.some((flag) => Boolean(data[flag]))) return false;
  return true;
}

/**
 * Scan a review-texts directory tree for isMissingContentTierGap() hits.
 * Read-only. Uses listShowDirs() so one dangling symlink doesn't crash the
 * scan (memory: feedback_stray_symlink_crashes_pipeline.md).
 *
 * @param {string} reviewTextsDir - path to data/review-texts
 * @returns {Array<{showId: string, file: string, criticName: string, outlet: string|null, wordCount: number}>}
 */
function scanMissingContentTier(reviewTextsDir) {
  const results = [];
  for (const showId of listShowDirs(reviewTextsDir)) {
    const showDir = path.join(reviewTextsDir, showId);
    let files;
    try {
      files = fs.readdirSync(showDir).filter((f) => f.endsWith('.json'));
    } catch {
      continue;
    }
    for (const file of files) {
      let data;
      try {
        data = JSON.parse(fs.readFileSync(path.join(showDir, file), 'utf8'));
      } catch {
        continue;
      }
      if (isMissingContentTierGap(data)) {
        results.push({
          showId,
          file,
          criticName: data.criticName,
          outlet: data.outlet || data.outletId || null,
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
// wrong; must strip both labels).
const TWO_LABEL_TLDS = /\.(co\.uk|com\.au|org\.uk|co\.nz|org\.au)$/i;

const MIN_SLUG_LENGTH = 4; // below this, a normalized slug matches too much to be "probable"

/**
 * Reduce a host to its bare outlet-identity slug: strip www., a hosting
 * platform's own domain, the TLD, and any non-alphanumeric characters.
 *   '1minutecritic.substack.com' → '1minutecritic'
 *   'www.theatre-weekly.co.uk'   → 'theatreweekly'
 *
 * @param {string} host
 * @returns {string}
 */
function normalizeHostSlug(host) {
  if (!host) return '';
  let h = String(host).toLowerCase().trim();
  h = h.replace(/^www\./, '');
  h = h.replace(PLATFORM_SUFFIXES, '');
  h = h.replace(TWO_LABEL_TLDS, '');
  h = h.replace(/\.[a-z]{2,}$/i, ''); // remaining single-label TLD (.com, .org, .net, ...)
  return h.replace(/[^a-z0-9]/g, '');
}

/** Normalize an outlet id/displayName/alias for slug comparison. */
function normalizeOutletName(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Find hosts in an "unknown aggregator outlets" census whose slug matches a
 * REGISTERED outlet's id/displayName/alias, but whose host is not already in
 * that outlet's domain/domainAliases — i.e. a probable domain move (or a new
 * mirror) the registry doesn't know about yet.
 *
 * Pure: takes already-loaded registry `outlets` (the `.outlets` map of
 * data/outlet-registry.json) and an array of census entries
 * (data/audit/unknown-aggregator-outlets.json's `.outlets`), does no I/O.
 *
 * @param {object} outlets - outletId -> {domain, domainAliases, aliases, displayName}
 * @param {Array<{host: string, occurrences?: number, sampleUrls?: string[]}>} unknownHosts
 * @returns {Array<{host: string, outletId: string, occurrences: number|null, sampleUrls: string[]}>}
 */
function findProbableDomainMoves(outlets, unknownHosts) {
  const results = [];
  if (!outlets || !Array.isArray(unknownHosts)) return results;
  for (const entry of unknownHosts) {
    const host = entry && entry.host;
    if (!host) continue;
    const slug = normalizeHostSlug(host);
    if (slug.length < MIN_SLUG_LENGTH) continue;
    for (const [outletId, outlet] of Object.entries(outlets)) {
      if (!outlet) continue;
      // A "move" implies an OLD host is already on file. An outlet with no
      // `domain` at all (many defunct/manually-registered entries have only
      // aliases, no domain) isn't a move candidate — it's a differently-shaped
      // gap (missing domain), and name-matching alone against every such
      // outlet is a false-positive machine: 44/218 real census hosts matched
      // an outlet purely by display-name coincidence (cleveland.com →
      // outletId 'cleveland', displayName 'Cleveland', no domain field) with
      // nothing to actually compare the host against.
      if (!outlet.domain) continue;
      const knownHosts = new Set(
        [outlet.domain, ...(outlet.domainAliases || [])].filter(Boolean).map((h) => String(h).toLowerCase()),
      );
      if (knownHosts.has(host.toLowerCase())) continue; // already registered — not a move

      const candidateNames = [outletId, outlet.displayName, ...(outlet.aliases || [])]
        .map(normalizeOutletName)
        .filter((n) => n.length >= MIN_SLUG_LENGTH);
      if (candidateNames.includes(slug)) {
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
  normalizeOutletName,
  findProbableDomainMoves,
  MIN_FULLTEXT_LENGTH,
  MIN_SLUG_LENGTH,
};
