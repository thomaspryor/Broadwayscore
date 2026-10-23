'use strict';

/**
 * press-night-review-state.js — what the review-text files say about a show's reviews (BRO-6070).
 *
 * The press-night record is judged from public data only, but "which listed outlets are real,
 * includable reviews" lives in the private review-texts files. This module reads them once, at
 * capture time, and returns public-safe rows (outlet, critic, first-seen time, includable or why not)
 * that the record stores as `fileState`. Includability is the rebuild's own predicate
 * (review-guards.explainExclusion), never re-derived here, so a wrongProduction / wrongShow /
 * isNonReview / roundup file, a rejected row and a syndicated copy of a live primary all read as
 * excluded exactly when the rebuild would drop them.
 *
 * Pure of network. Reads `<reviewTextsDir>/<showId>/*.json`.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const DEFAULT_DIR = path.join(ROOT, 'data', 'review-texts');

// explainExclusion reasons that mean "the same review is live under another outlet".
const SYNDICATED_REASONS = new Set(['knownSyndicationSecondary', 'syndicatedDuplicate', 'crossOutletDuplicate']);

function outletIdOfFile(d) {
  const { normalizeOutlet } = require('./review-normalization');
  return normalizeOutlet(String(d.outletId || d.outlet || '')) || String(d.outletId || d.outlet || '').toLowerCase() || null;
}

/**
 * @returns {{available:boolean, files:Array}}  available=false when the show has no review-texts dir
 *   (private data not checked out), which callers must read as "exclusions unknown", never "none".
 */
function readReviewFileState(showId, show, { dir = DEFAULT_DIR } = {}) {
  const showDir = path.join(dir, showId);
  let names;
  try { names = fs.readdirSync(showDir).filter((f) => f.endsWith('.json')); } catch (_) { return { available: false, files: [] }; }
  const { explainExclusion } = require('./review-guards');
  const synd = require('./syndication-pairs');
  const files = [];
  for (const f of names) {
    let d;
    try { d = JSON.parse(fs.readFileSync(path.join(showDir, f), 'utf8')); } catch (_) { continue; }
    let reason;
    try { reason = explainExclusion(d, show, path.join(showDir, f)); } catch (e) { reason = null; }
    let syndicatedUnder = null;
    if (reason && SYNDICATED_REASONS.has(reason)) {
      const prims = synd.getSyndicationPrimaries(d.criticName, outletIdOfFile(d));
      syndicatedUnder = prims.length ? prims[0] : null;
    }
    files.push({
      file: f,
      outletId: outletIdOfFile(d),
      outlet: d.outlet || d.outletId || null,
      critic: d.criticName || null,
      firstSeenAt: d.firstSeenAt || null,
      publishDate: d.publishDate || null,
      includable: reason === null,
      reason: reason || null,
      syndicatedUnder,
    });
  }
  return { available: true, files };
}

/**
 * Census entries whose every review file is excluded (or that are syndicated copies) are not
 * "missing": the rebuild correctly keeps them off the site. An outlet with at least one includable
 * file, or with no file at all (a listing we have not ingested), stays in the denominator.
 * @returns {Array<{outletId:string, reason:string}>}
 */
function censusExclusions(census, files) {
  if (!census || !Array.isArray(census.entries)) return [];
  const byOutlet = new Map();
  for (const f of files) {
    if (!f.outletId) continue;
    if (!byOutlet.has(f.outletId)) byOutlet.set(f.outletId, []);
    byOutlet.get(f.outletId).push(f);
  }
  const out = [];
  for (const e of census.entries) {
    const fs_ = byOutlet.get(e.outletId) || byOutlet.get(e.outletId.replace(/-london$/, '')) || [];
    if (!fs_.length || fs_.some((f) => f.includable)) continue;
    const synd = fs_.find((f) => f.syndicatedUnder || SYNDICATED_REASONS.has(f.reason));
    const reason = synd
      ? `syndicated copy${synd.syndicatedUnder ? ` of the ${synd.syndicatedUnder} review` : ''} (${synd.reason})`
      : [...new Set(fs_.map((f) => f.reason))].join('+');
    out.push({ outletId: e.outletId, reason });
  }
  return out;
}

module.exports = { readReviewFileState, censusExclusions, SYNDICATED_REASONS, outletIdOfFile };
