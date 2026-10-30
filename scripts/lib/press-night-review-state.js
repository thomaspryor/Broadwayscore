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
  const raw = String(d.outletId || d.outlet || '').trim();
  if (!raw) return null; // normalizeOutlet('') returns 'unknown', which would read as a real outlet
  const { normalizeOutlet } = require('./review-normalization');
  return normalizeOutlet(raw) || raw.toLowerCase();
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
      // BRO-6652: when the text was scored (a paywalled review can be listed long before its text arrives).
      scoredAt: (d.llmMetadata && d.llmMetadata.scoredAt) || null,
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
 * Only files that belong to the night can exclude an outlet (BRO-6079): a June wrongProduction article
 * or a ticket page seen last week says nothing about the night's review. With `opts.windowStartMs` a
 * file counts only if first seen at/after it, or published on/after `opts.night` (YYYY-MM-DD); a file
 * with neither date is not provably the night's and is ignored. Without opts every file counts (legacy).
 * @returns {Array<{outletId:string, reason:string}>}
 */
function censusExclusions(census, files, opts = {}) {
  const { windowStartMs = null, night = null } = opts;
  if (windowStartMs != null) {
    files = files.filter((f) => {
      const seen = f.firstSeenAt ? Date.parse(f.firstSeenAt) : NaN;
      if (Number.isFinite(seen) && seen >= windowStartMs) return true;
      // ISO only: a text date like "October 12, 2019" sorts after "2026-.." as a string and would pass.
      const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(f.publishDate || ''));
      return !!(night && m && m[1] >= night);
    });
  }
  if (!census || !Array.isArray(census.entries)) return [];
  const byOutlet = new Map();
  for (const f of files) {
    if (!f.outletId) continue;
    if (!byOutlet.has(f.outletId)) byOutlet.set(f.outletId, []);
    byOutlet.get(f.outletId).push(f);
  }
  const out = [];
  for (const e of census.entries) {
    const fs_ = byOutlet.get(e.outletId) || byOutlet.get(e.outletId.replace(/-london$/, '')) || byOutlet.get(`${e.outletId}-london`) || [];
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
