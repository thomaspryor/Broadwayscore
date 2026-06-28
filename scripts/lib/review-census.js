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
 *   - The Stage roundups (lib/thestage-extract — pure cheerio, no playwright)
 *   - WestEndTheatre    (archives are pre-extracted JSON already in census shape)
 *
 * ARCHIVE-FIRST: reads data/aggregator-archive/{source}/{showId}.{ext} if present
 * (cheap, no network) — ext is per-source (.html for HTML roundups, .json for the
 * pre-extracted WestEndTheatre archive); the workflow refreshes archives by running
 * the existing roundup scrapers. A show with NO archived roundup yields hadAnySource=false →
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

// Outlets a WE roundup may list but that we can NEVER full-text-collect from a CI
// runner (datacenter-IP blocks defeat cookies — see memory/feedback_wsj_newyorker_ci_ip_block).
// Without this, such an outlet sits in `missing` forever → the show is `incomplete`
// forever → a FULL gather re-fires every run. Passed as the default `suppressed`
// set so these stay VISIBLE (block `complete`) but do NOT drive re-dispatch.
// Recoverable paywalls (Times/FT/Telegraph — collectable via cookies/Browserbase)
// are deliberately NOT here; we want to keep trying them.
const CI_UNFETCHABLE_OUTLETS = new Set(['wsj', 'newyorker']);

// Parse a WestEndTheatre archive. Two shapes ship in the wild (~48 vs ~27 of 79):
//   { reviews:[{outlet,outletId,critic,stars,url,...}] }  — rich, already census shape
//   { ratings:[{outlet,stars,critic?,reviewUrl?}] }       — star-table only, no outletId/url
// We MUST read both: reading only `reviews` silently drops a third of WET archives
// to zero — the exact silent-gate trap the census exists to prevent. Kept here (not
// a scraper) because the WET scraper requires a rendered-page browser path we don't
// want in the audit; the archive is the stable contract. `ratings` rows are
// normalized into census shape (outletId via normalizeOutlet, reviewUrl→url).
function parseWetArchive(content /*, showId */) {
  const data = JSON.parse(content);
  if (Array.isArray(data)) return data.filter((r) => r && (r.outletId || r.outlet));
  const reviews = (data && data.reviews) || [];
  const rich = reviews.filter((r) => r && (r.outletId || r.outlet));
  if (rich.length) return rich;
  // Fall back to the star-table format.
  const ratings = (data && data.ratings) || [];
  return ratings
    .filter((r) => r && r.outlet)
    .map((r) => ({
      outlet: r.outlet,
      outletId: r.outletId || normalizeOutlet(r.outlet),
      critic: r.critic || 'Unknown',
      stars: r.stars != null ? r.stars : null,
      url: r.url || r.reviewUrl || '',
    }));
}

// Each source: archive subdir, file ext (default 'html'), and a reader
// fn(content, showId) -> [{outlet, critic, stars, url}]. Every source loaded here
// is playwright-FREE — the census runs inside the coverage audit, which must not
// spin up a browser. (The Stage scraper imports playwright, so we pull its pure
// extractor from lib/thestage-extract instead of requiring the scraper.)
function sourceExtractors() {
  const { extractReviews } = require('../scrape-theatre-reviews');
  const sources = [
    { name: 'theatre-reviews', dir: 'theatre-reviews', fn: extractReviews },
  ];
  let extractLbo = null;
  try { ({ extractReviewsFromLBO: extractLbo } = require('../scrape-london-box-office-roundups')); } catch (_) {}
  if (extractLbo) sources.push({ name: 'lbo', dir: 'lbo-roundups', fn: extractLbo });

  let extractStage = null;
  try { ({ extractReviews: extractStage } = require('./thestage-extract')); } catch (_) {}
  if (extractStage) sources.push({ name: 'thestage', dir: 'thestage-roundups', fn: extractStage });

  sources.push({ name: 'westendtheatre', dir: 'westendtheatre', ext: 'json', fn: parseWetArchive });
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
  // Track which archives EXISTED vs which yielded 0 reviews. A file present but
  // extracting 0 (DOM drift / parser break) is otherwise indistinguishable from
  // "no roundup archived" — both collapse to no-census-yet, so a silently-broken
  // extractor masks itself as "still collecting" forever. zeroExtract lets the
  // audit alert on its own blindness (feedback_monitor_must_cover_own_output).
  const archivesPresent = [];
  const zeroExtract = [];
  for (const s of sources) {
    const p = path.join(archiveDir, s.dir, `${showId}.${s.ext || 'html'}`);
    if (!fs.existsSync(p)) continue;
    archivesPresent.push(s.name);
    let reviews = [];
    try { reviews = s.fn(fs.readFileSync(p, 'utf8'), showId) || []; } catch (_) { reviews = []; }
    if (!Array.isArray(reviews) || reviews.length === 0) zeroExtract.push(s.name);
    perSource.push({ source: s.name, reviews });
  }
  return { ...unionCensus(perSource), archivesPresent, zeroExtract };
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

module.exports = { buildCensusFromArchives, unionCensus, censusVerdict, CI_UNFETCHABLE_OUTLETS };
