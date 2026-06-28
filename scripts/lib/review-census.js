'use strict';

/**
 * review-census.js — build the canonical "who reviewed this show" list by unioning
 * the West End aggregator roundups, which list every critic. This is the TARGET
 * for the completeness audit (audit-opening-night-coverage.js): the broad SERP
 * discovery is the ingestion ENGINE; the census tells us what "all" is so the
 * audit can be honest about gaps and never depend on a single slow aggregator.
 *
 * MULTI-SOURCE by design (operator: "can't rely on one slow aggregator"):
 *   - theatre.reviews   (best-structured; extractReviews)
 *   - London Box Office (extractReviewsFromLBO)
 *   - WestEndTheatre / The Stage roundups — add as their extractors stabilise.
 *
 * ARCHIVE-FIRST: reads data/aggregator-archive/{source}/{showId}.html if present
 * (cheap, no network); the workflow refreshes archives by running the existing
 * roundup scrapers. A show with NO archived roundup yields hadAnySource=false →
 * the audit must read this as `no-census-yet`, NEVER `complete` (the vacuous-truth
 * trap: empty census ∧ "all present" = falsely green exactly when coverage is
 * worst — Sinatra/Much Ado/Misanthrope, June 2026).
 *
 * Pure union + verdict helpers are exported for unit testing without archives.
 */
const fs = require('fs');
const path = require('path');
const { normalizeOutlet } = require('./review-normalization');

const ROOT = path.join(__dirname, '..', '..');
const ARCHIVE = path.join(ROOT, 'data', 'aggregator-archive');

// Each source: archive subdir + an extractor(html, showId) -> [{outlet, critic, stars, url}].
function sourceExtractors() {
  const { extractReviews } = require('../scrape-theatre-reviews');
  let extractLbo = null;
  try { ({ extractReviewsFromLBO: extractLbo } = require('../scrape-london-box-office-roundups')); } catch (_) {}
  const sources = [
    { name: 'theatre-reviews', dir: 'theatre-reviews', fn: extractReviews },
  ];
  if (extractLbo) sources.push({ name: 'lbo', dir: 'lbo-roundups', fn: extractLbo });
  return sources;
}

/**
 * Union per-source review arrays into a deduped census keyed by normalized outlet.
 * Keeps the entry with a URL; merges the source list. Pure — testable.
 * @param {Array<{source:string, reviews:Array}>} perSource
 * @returns {{entries:Array, count:number, sourcesPresent:string[], hadAnySource:boolean}}
 */
function unionCensus(perSource) {
  const byOutlet = new Map();
  const sourcesPresent = [];
  for (const { source, reviews } of perSource) {
    if (!Array.isArray(reviews) || reviews.length === 0) continue;
    sourcesPresent.push(source);
    for (const r of reviews) {
      const outletId = r.outletId || normalizeOutlet(r.outlet || '');
      if (!outletId) continue;
      const existing = byOutlet.get(outletId);
      const entry = {
        outletId,
        outlet: r.outlet || outletId,
        critic: r.critic && r.critic !== 'Unknown' ? r.critic : (existing && existing.critic) || 'Unknown',
        stars: r.stars != null ? r.stars : (existing && existing.stars) ?? null,
        url: r.url || (existing && existing.url) || '',
        sources: existing ? [...new Set([...existing.sources, source])] : [source],
      };
      byOutlet.set(outletId, entry);
    }
  }
  const entries = [...byOutlet.values()];
  return { entries, count: entries.length, sourcesPresent, hadAnySource: sourcesPresent.length > 0 };
}

/**
 * Build the census for a show from archived roundups (archive-first, no network).
 * @param {string} showId
 * @param {object} [opts] { archiveDir, sources } injectable for tests
 */
function buildCensusFromArchives(showId, opts = {}) {
  const archiveDir = opts.archiveDir || ARCHIVE;
  const sources = opts.sources || sourceExtractors();
  const perSource = [];
  for (const s of sources) {
    const p = path.join(archiveDir, s.dir, `${showId}.html`);
    if (!fs.existsSync(p)) continue;
    let reviews = [];
    try { reviews = s.fn(fs.readFileSync(p, 'utf8'), showId) || []; } catch (_) { reviews = []; }
    perSource.push({ source: s.name, reviews });
  }
  return unionCensus(perSource);
}

/**
 * Three-state completeness verdict. The audit owns "present-and-scored"; this
 * helper folds in the no-census-yet rule so empty/failed census is NEVER complete.
 *
 * @param {object} census  result of unionCensus / buildCensusFromArchives
 * @param {Set<string>} coveredScoredOutlets  outletIds present in reviews.json WITH assignedScore != null
 * @param {object} [opts] { suppressed: Set<string> — known-unfetchable censused outlets }
 * @returns {{verdict:'complete'|'incomplete'|'no-census-yet', missing:Array, suppressedMissing:Array}}
 */
function censusVerdict(census, coveredScoredOutlets, opts = {}) {
  if (!census || !census.hadAnySource || census.count === 0) {
    return { verdict: 'no-census-yet', missing: [], suppressedMissing: [] };
  }
  const suppressed = opts.suppressed || new Set();
  const missing = [];
  const suppressedMissing = [];
  // Market-suffix tolerance: a roundup may label an outlet "Time Out"
  // (normalizeOutlet → "timeout") while reviews.json carries the London variant
  // "timeout-london" (and vice versa). Treat the bare id and its "-london"
  // variant as the same outlet, else Time Out (et al.) would read missing on
  // EVERY WE show → false-incomplete + dispatch storm. Codex ship-check #3.
  const variants = (id) => {
    const out = new Set([id]);
    if (id.endsWith('-london')) out.add(id.slice(0, -'-london'.length));
    else out.add(`${id}-london`);
    return [...out];
  };
  const inSet = (set, id) => variants(id).some((v) => set.has(v));
  for (const e of census.entries) {
    if (inSet(coveredScoredOutlets, e.outletId)) continue;       // present AND scored — good
    if (inSet(suppressed, e.outletId)) { suppressedMissing.push(e); continue; } // known-unfetchable: stays visible, blocks complete
    missing.push(e);
  }
  // Suppressed-but-missing still means we don't have everything → never "complete".
  const verdict = (missing.length === 0 && suppressedMissing.length === 0) ? 'complete' : 'incomplete';
  return { verdict, missing, suppressedMissing };
}

module.exports = { buildCensusFromArchives, unionCensus, censusVerdict };
