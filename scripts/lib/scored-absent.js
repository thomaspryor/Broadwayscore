'use strict';
// BRO-7945 class guard. A review file that is scored, unflagged, includable by the
// canonical predicate and scoreable, yet whose outlet has NO row in reviews.json for
// its show, means rebuild-all-reviews.js dropped it at a gate explainExclusion does not
// know about (the "must match" divergence class). Every such file must carry a
// RECORDED drop reason (rebuild's per-show exclusion ledger); one without is a SILENT
// drop. Pure: no I/O, so the test requires this real function.

const DECIDED_FLAGS = ['wrongProduction', 'wrongShow', 'isRoundupArticle', 'duplicateOf', 'duplicateTextOf', 'notAReview', 'excluded'];
const INCLUDABLE_TIERS = new Set(['complete', 'truncated', 'excerpt']);

// BRO-7945: the rebuild skips a WHOLE show before reading any file (Broadway in previews, any market upcoming)
// and logs it with file '-', so no per-file ledger row exists. rebuild-all-reviews.js calls THIS function for
// that decision, so the guard reads the same skip and never calls it a silent drop.
function wholeShowSkipReason(show) {
  if (!show) return null;
  // isBroadwayCategory: a missing category is Broadway, the same default rebuild's showCategoryMap applies.
  if (show.status === 'previews' && require('./venue-classification').isBroadwayCategory(show)) return 'skippedPreviewsShows';
  if (show.status === 'upcoming') return 'skippedUpcomingShows';
  return null;
}

// Latest scoring/fetch stamp the record carries; mtime only when it carries none.
function recordedAt(data, mtimeMs) {
  const ts = ['rescoreCompletedAt', 'classifiedAt', 'textFetchedAt', 'firstSeenAt']
    .map((k) => Date.parse(data[k]))
    .concat(Date.parse(data.llmMetadata && data.llmMetadata.scoredAt)) // the scorer's own stamp (scorer.ts)
    .filter((n) => Number.isFinite(n));
  return ts.length ? Math.max(...ts) : (typeof mtimeMs === 'number' ? mtimeMs : null);
}

/**
 * @param {object} p
 * @param {string} p.showId
 * @param {object} p.show shows.json entry
 * @param {{file:string,data:object,mtimeMs?:number}[]} p.files
 * @param {Set<string>} p.presentOutlets outletIds with a reviews.json row for this show
 * @param {Map<string,string>} p.ledger file -> recorded rebuild drop reason
 * @param {(data,show,path)=>string|null} p.explain  canonical includability (null = includable)
 * @param {(data,show,path)=>boolean} p.scoreable
 * @param {(id:string)=>string} [p.normalize] outlet canonicalizer (rebuild files nydailynews under its registry id)
 * @param {number} [p.nowMs] @param {number} [p.graceHours] files newer than this are not judged yet
 * @returns {{showId,file,outletId,reason:string|null,status:'explained'|'silent'|'grace'}[]}
 */
function findScoredAbsent({ showId, show, files, presentOutlets, ledger, explain, scoreable, normalize = (x) => x, nowMs = Date.now(), graceHours = 48 }) {
  const rows = [];
  for (const { file, data, mtimeMs } of files) {
    if (!data || !data.llmScore) continue;
    if (DECIDED_FLAGS.some((k) => data[k])) continue;
    if (!INCLUDABLE_TIERS.has(data.contentTier)) continue;
    if (presentOutlets.has(data.outletId) || presentOutlets.has(normalize(data.outletId))) continue;
    let ok = false;
    try { ok = explain(data, show, file) === null && scoreable(data, show, file) === true; } catch { ok = false; }
    if (!ok) continue;
    const reason = (ledger && ledger.get(file)) || wholeShowSkipReason(show);
    const stamp = recordedAt(data, mtimeMs); // a fresh CI checkout gives every file a new mtime; the record's own stamps win
    const young = stamp !== null && nowMs - stamp < graceHours * 3600e3;
    rows.push({ showId, file, outletId: data.outletId || null, reason, status: reason ? 'explained' : young ? 'grace' : 'silent' });
  }
  return rows;
}

function summarizeScoredAbsent(rows) {
  const byReason = {};
  for (const r of rows) byReason[r.reason || '(unrecorded)'] = (byReason[r.reason || '(unrecorded)'] || 0) + 1;
  return {
    total: rows.length,
    silent: rows.filter((r) => r.status === 'silent').length,
    grace: rows.filter((r) => r.status === 'grace').length,
    explained: rows.filter((r) => r.status === 'explained').length,
    byReason,
  };
}

module.exports = { findScoredAbsent, summarizeScoredAbsent, wholeShowSkipReason, DECIDED_FLAGS, INCLUDABLE_TIERS };
