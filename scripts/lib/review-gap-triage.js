'use strict';

const { foldDiacritics } = require('./title-match');

/**
 * Pure classification for scripts/triage-review-gap.js (BRO-3153).
 *
 * The opening-night monitor diffs its independent census against ONLY the
 * live prod JSON. When an outlet is absent from prod it declares
 * 'missed-discovery' and starts URL-resolution work (site search, Google
 * News RSS, sitemap.xml) — indistinguishable from ordinary deploy lag, which
 * is the far more common case. On 2026-09-09 (kimberly-akimbo-off-west-end-2026,
 * West End Best Friend) that misdiagnosis ran for ~12 passes (~3h) and two
 * false-alarm rebuild-fast re-dispatches before a pass finally checked the
 * pipeline directly and found the review had been discovered, scored, and
 * committed to the data repo hours earlier — it just hadn't deployed yet.
 *
 * classifyGap() encodes the fix: only when NONE of the three pipeline stages
 * (review-texts, reviews.json, live prod) has ever seen the outlet is a gap
 * actually a missed-discovery. Kept pure and dependency-free (no git, fs, or
 * network) so the precedence rules are unit-testable in isolation
 * (CLAUDE.md rule 15) — all the git/fs/network work lives in the CLI.
 */

const { isWithinPriorRun, isWithinTourLeg } = require('./wrong-production-autoclear');

/**
 * @param {object} signals
 * @param {boolean} signals.reviewTextsExists - a review-texts file for this
 *   show+outlet exists, locally OR on the data-repo's origin/main.
 * @param {string|null} signals.exclusionRule - explainExclusion()'s verdict
 *   for that file (e.g. 'wrongProduction'), or null if includable/unknown.
 * @param {boolean} signals.inReviewsJson - the outlet appears in reviews.json
 *   (local or the data-repo's origin/main) for this show.
 * @param {boolean} signals.inLiveProd - the outlet appears in the live prod
 *   per-show JSON's review list.
 * @returns {'live-on-prod'|'ingested-but-excluded'|'in-pipeline-awaiting-deploy'|'true-missed-discovery'}
 */
function classifyGap({ reviewTextsExists, exclusionRule, inReviewsJson, inLiveProd }) {
  if (inLiveProd) return 'live-on-prod';
  if (reviewTextsExists && exclusionRule) return 'ingested-but-excluded';
  if (reviewTextsExists || inReviewsJson) return 'in-pipeline-awaiting-deploy';
  return 'true-missed-discovery';
}

// Date-only comparison (UTC midnight) so a non-ISO string can't shift a day.
function _ts(v) {
  if (!v) return null;
  const m = String(v).match(/^\d{4}-\d{2}-\d{2}/);
  const t = Date.parse(m ? m[0] : v);
  return Number.isNaN(t) ? null : t;
}

// Shared with the promote step's skip stamp (replay-pending-bylines.js,
// fetch-guardian-reviews.js write this wording into promoteSkippedReason).
const OUT_OF_WINDOW_REASON_RE = /outside this production's window/i;

/**
 * BRO-4098: a review-texts file for the outlet that belongs to a DIFFERENT
 * production of the same title (2018 Northern Stage, Chicago 2016) is not
 * evidence the current production's review was ingested. Counting it made
 * triage answer 'ingested-but-excluded / do NOT start URL resolution' on
 * opening night while the real review was a genuine discovery miss.
 *
 * Deliberately conservative: when a date is unknown the file is treated as
 * CURRENT (the old, safe answer), never as another production. Signals use
 * dates and text only, never URL contents. Only previewsStartDate bounds the
 * run (reviews legitimately precede openingDate), and a date inside a declared
 * priorRuns window is current.
 *
 *   - explainExclusion says wrongProduction/wrongShow AND publishDate is
 *     before previewsStartDate (a dated in-window flag is likely a false
 *     positive worth un-flagging, so it stays ingested-but-excluded)
 *   - a _pending file dated before previewsStartDate, or one the promoter
 *     skipped as outside the production window
 *
 * Unreadable files (data == null) are never other-production.
 *
 * @param {{data: object|null, pending: boolean}} file
 * @param {object|null} showRecord
 * @param {string|null} exclusionRule - explainExclusion() verdict for the file
 */
function isOtherProductionFile(file, showRecord, exclusionRule) {
  const data = file && file.data;
  if (!data) return false;
  const start = _ts(showRecord && showRecord.previewsStartDate);
  const pub = _ts(data.publishDate);
  const predates = start != null && pub != null && pub < start;
  if (predates && (isWithinPriorRun(data.publishDate, showRecord.priorRuns) || isWithinTourLeg(data.publishDate, showRecord.tourLegs))) return false;
  // A human verdict that the content is right outranks any date heuristic.
  if (data.wrongProductionManualClear === true || data.wrongProductionOverride === true
    || data.humanReviewedWrongProduction === false || data.humanReviewScore != null) return false;
  if (exclusionRule === 'wrongProduction' || exclusionRule === 'wrongShow') return predates;
  if (file.pending) {
    if (predates) return true;
    // The stamp is a stale diagnostic: a corrected in-window date beats it.
    const inWindow = start != null && pub != null && pub >= start;
    if (!inWindow && OUT_OF_WINDOW_REASON_RE.test(String(data.promoteSkippedReason || ''))) return true;
  }
  return false;
}

/**
 * BRO-4899: a same-outlet file published BEFORE the production's first preview
 * (a cast interview, a pre-opening feature) is not that outlet's review, and
 * must not make triage say "Do NOT start URL-resolution work" while the real
 * review is still undiscovered. Reviews cannot predate previews, so this holds
 * whether or not a guard has excluded the file. Prior runs / tour legs and
 * human-reviewed files are exempt (same carve-outs as isOtherProductionFile).
 */
function isPreRunFile(file, showRecord) {
  const data = file && file.data;
  if (!data || !showRecord) return false;
  // previewsStartDate only (same as isOtherProductionFile): without it we can't tell a
  // preview-period review from a pre-run feature. Outlet-level reviews.json/prod
  // presence still wins in classifyGap, so an ingested+counted file is never hidden.
  const start = _ts(showRecord.previewsStartDate);
  const pub = _ts(data.publishDate);
  if (start == null || pub == null || pub >= start) return false;
  if (isWithinPriorRun(data.publishDate, showRecord.priorRuns) || isWithinTourLeg(data.publishDate, showRecord.tourLegs)) return false;
  if (data.wrongProductionManualClear === true || data.wrongProductionOverride === true
    || data.humanReviewedWrongProduction === false || data.humanReviewScore != null) return false;
  return true;
}

/**
 * BRO-4475: with a known review URL, a same-outlet record that carries a
 * DIFFERENT url is a look-alike (BWW forum thread) and must not count. Records
 * with NO url (unreadable, _pending strand) cannot be disproven, so they stay
 * candidates (the old outlet-only behaviour). URLs compare query-stripped so a
 * stray tracking param can't turn an ingested review into a "missed" one.
 * Returns the records to keep, or null when no url was given.
 */
function filterByUrl(records, url, getUrl, normalize) {
  if (!url) return null;
  const loose = (u) => normalize(u).split('?')[0];
  const target = loose(url);
  return records.filter((r) => {
    const u = getUrl(r);
    return !u || loose(u) === target;
  });
}

/** Only this state justifies starting URL-resolution work (site search, RSS, sitemap). */
function justifiesUrlResolution(state) {
  return state === 'true-missed-discovery';
}

/**
 * BRO-3359: the outlet an operator types ("The QR") and the outletId a review
 * was ingested under ("theqr", a provisional outlet with no hyphen) can be
 * different slugs of the same name. Matching on one slugification made every
 * lookup layer miss at once and reported a live review as true-missed-discovery.
 * Returns the set of ids any layer may legitimately have used: the canonical
 * normalizeOutlet() id, the display name with every non-alphanumeric stripped
 * ("theqr"), and the hyphenated slug ("the-qr").
 */
function outletIdCandidates(outletName, canonicalId) {
  const name = foldDiacritics(String(outletName || ''));
  const ids = new Set();
  if (canonicalId) ids.add(String(canonicalId).toLowerCase());
  const compact = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (compact) ids.add(compact);
  const hyphen = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (hyphen) ids.add(hyphen);
  return [...ids];
}

module.exports = { outletIdCandidates, classifyGap, justifiesUrlResolution, isOtherProductionFile, isPreRunFile, filterByUrl };
