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

// Reasons that say the listed article is about a different production/show, not this night's review.
const WRONG_PRODUCTION_REASONS = new Set(['wrongProduction', 'wrongShow']);
// BRO-8240: the ensemble judged the exact listed page not a scoreable review (Pages on Stages paywalled its
// reviews 2026-11-17: the page serves a 142-word teaser). The rebuild keeps it off the site whenever the file
// was first seen, so a listing of that same URL can never go live and is not a night miss.
const REJECTED_LISTING_REASONS = new Set(['rejectionReason']);
// Only the ensemble's verdict on the page's CONTENT counts; garbage_text etc. say our fetch failed, not the page.
const REJECTED_LISTING_KINDS = new Set(['not_a_review']);
// Both sides go through normUrl first (BRO-6702): fileState urls are stored normalized, census urls are raw.
const urlKey = (u) => String(normUrl(u) || u || '').trim().toLowerCase().replace(/^https?:\/\/(www\.)?/, '').replace(/#.*$/, '').replace(/[?&](utm_[^=&]*|fbclid|gclid)=[^&]*/g, '').replace(/\?$/, '').replace(/\/+$/, '');

/**
 * A file's publish day as YYYY-MM-DD, or null. ISO stays as-is; a written date ("May 20th, 2026", Specimen's This
 * Week in New York file) goes through date-utils.normalizeDate, but only when it names a day of the month: a
 * month-only "Nov 2024" would read as the 1st and could fall inside a run it was never in.
 */
function publishDay(raw) {
  const s = String(raw || '').trim();
  const iso = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  if (iso) return iso[1];
  if (!/\b\d{1,2}(?:st|nd|rd|th)?\b/i.test(s.replace(/\b\d{4}\b/g, ''))) return null;
  const d = require('./date-utils').normalizeDate(s);
  return d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
}

/**
 * BRO-8308: is a review file dated inside a declared earlier run of the show (and before `night`)? Such a file is
 * that run's review, inherited onto the page, never one owed on this night. Strict window (no post-close
 * review-lag grace) so a quick remount's own pre-opening review stays owed; day-precise dates only (publishDay); a run with
 * inheritReviews:false is a different production and never excuses anything. The one predicate both the census
 * side (censusExclusions) and the file side (press-night-record sameNightCheck) use.
 */
function isPriorRunFile(f, night, priorRuns) {
  if (!f || !night || !Array.isArray(priorRuns) || !priorRuns.length) return false;
  const day = publishDay(f.publishDate);
  if (!day || day >= String(night)) return false;
  const { priorRunWindow } = require('./wrong-production-autoclear');
  const t = new Date(day).getTime();
  return priorRuns.some((run) => {
    if (!run || run.inheritReviews === false) return false;
    const w = priorRunWindow(run, { allowGrace: false });
    return !!w && t >= w.fromMs && t <= w.toMs;
  });
}

function normUrl(u) {
  if (!u) return null;
  try { return require('./review-normalization').normalizeUrl(String(u)) || null; } catch (_) { return null; }
}

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
      const prims = synd.getSyndicationPrimariesInDir(d.criticName, outletIdOfFile(d), names, require('./review-normalization').normalizeOutlet, { show });
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
      // Normalized (BRO-6702): it lands in the public record, and normalizeUrl strips paywall-access tokens.
      url: normUrl(d.url),
      includable: reason === null,
      reason: reason || null,
      syndicatedUnder,
      ...(reason === 'rejectionReason' && d.rejectionReason ? { rejectionKind: String(d.rejectionReason) } : {}),
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
 * @returns {Array<{outletId:string, reason:string, priorRunCandidate?:boolean}>}
 */
function censusExclusions(census, files, opts = {}) {
  const { windowStartMs = null, night = null, priorRuns = null } = opts;
  // BRO-6701: a listing whose exact URL the rebuild already judged another production's review (Medea: an
  // aggregator row for a 2013 staging) is not a review of the night, whenever the file was first seen.
  const wrongListing = new Map();
  for (const f of files) {
    if (f.url && !f.includable && (WRONG_PRODUCTION_REASONS.has(f.reason) || (REJECTED_LISTING_REASONS.has(f.reason) && REJECTED_LISTING_KINDS.has(f.rejectionKind)))) wrongListing.set(urlKey(f.url), f);
  }
  // BRO-8308 cousin (Specimen, 2026-10-30 encore): once priorRuns is declared, the earlier run's reviews are
  // includable and live, and an aggregator page still listing them made them read as owed tonight. A listing
  // whose every URL is one of our includable files dated inside a declared earlier run is not owed tonight.
  const priorRunUrls = new Set();
  for (const f of files) if (f.url && f.includable && isPriorRunFile(f, night, priorRuns)) priorRunUrls.add(urlKey(f.url));
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
    const urls = [...new Set([...(e.urls || []), ...(e.url ? [e.url] : [])])];
    const wl = urls.length && urls.every((u) => wrongListing.has(urlKey(u))) && !(byOutlet.get(e.outletId) || []).some((f) => f.includable) && wrongListing.get(urlKey(urls[0]));
    if (wl) {
      // BRO-6702: a wrongProduction listing may be the same production's earlier run (Specimen's May premiere
      // reviews listed on the Oct encore); flag it so the record says "declare priorRuns if so".
      if (REJECTED_LISTING_REASONS.has(wl.reason)) { out.push({ outletId: e.outletId, reason: `listing is a page the rebuild rejected as not a scoreable review (${wl.reason}, e.g. paywalled teaser)` }); continue; }
      out.push({ outletId: e.outletId, reason: `listing is another production's review (${wl.reason})`, ...(wl.reason === 'wrongProduction' ? { priorRunCandidate: true } : {}) });
      continue;
    }
    if (urls.length && priorRunUrls.size && urls.every((u) => priorRunUrls.has(urlKey(u)))) {
      out.push({ outletId: e.outletId, reason: 'listing is a review from a declared earlier run (priorRuns), not owed tonight' });
      continue;
    }
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

module.exports = { readReviewFileState, censusExclusions, isPriorRunFile, SYNDICATED_REASONS, outletIdOfFile };
