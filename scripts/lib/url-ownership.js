/**
 * Cross-show URL ownership (Notion 39a637c5-416f-8167).
 *
 * A review URL that already lives — unflagged — under another show's directory
 * is OWNED by that show. Creating a second file for the same URL under a
 * same-title sibling is the tender-off-west-end-2026 churn (2026-07-10/11):
 * after 9 Dave Harris Soho reviews were manually moved to
 * tender-by-dave-harris-off-west-end-2026, six writers (LBO roundup,
 * LouReviews poll, Show Score refresh, outlet-listing poller, weekly refresh)
 * re-created them under the open Bush-Theatre "Tender" by title match, the
 * cross-show audit re-flagged them, and the loop repeated. All six writers
 * create files through review-file-writer.js createOrMergeReviewFile(), which
 * had no cross-show URL check — the only one existing lives in
 * gather-reviews.js (getGlobalUrlIndex + shouldTakeUrlOwnership) and is
 * unreachable from the writer path; detectCrossShowUrlMismatch's title-slug
 * index drops titles shorter than 8 chars ('tender' is 6), so it never fires.
 *
 * Decision semantics (see shouldBlockCrossShowCreate):
 *   - BLOCK when any other show holds this URL in a live (unflagged) file —
 *     the URL belongs there; discovery matched the wrong same-title sibling.
 *   - ALLOW when every cross-show copy is itself flagged wrongShow /
 *     wrongProduction — that's the legitimate re-home case (the URL was
 *     misfiled where it currently sits).
 *   - ALLOW when the owning copy is a combined/roundup article
 *     (isCombinedReview / isRoundupArticle) — one article can legitimately
 *     cover multiple shows.
 *
 * The index is built lazily once per process (writers are batch scripts) and
 * updated incrementally via recordUrlOwner() as this process creates files,
 * so a multi-show run can't race itself.
 */

const fs = require('fs');
const path = require('path');

let _index = null; // { dir, map: Map<normUrl, Array<{showId, file, blocking}>> }

function _normalizeUrl(url) {
  // Lazy require: review-normalization is heavy and widely cross-required.
  const { normalizeUrl } = require('./review-normalization');
  return normalizeUrl(url);
}

// Only real http(s) article URLs participate in ownership. The corpus holds
// 139+ unflagged files with non-http "urls" (critic-profile hrefs like
// /people/ben-brantley/ a scraper grabbed instead of the article, shared
// across up to 7 shows) — indexing those would make Guard I skip entire
// reviews over junk that used to just land as a fixable bad-url stub.
function _isOwnableUrl(url) {
  return typeof url === 'string' && /^https?:\/\//i.test(url) && !url.includes('undefined');
}

// A copy of the URL under another show BLOCKS creation only when it is live
// there: not flagged as wrong-show/wrong-production, and not a multi-show
// (combined/roundup) article.
function _isBlockingOwnerCopy(data) {
  if (!data || typeof data !== 'object') return false;
  if (data.wrongShow === true || data.wrongProduction === true) return false;
  if (data.isCombinedReview === true || data.isRoundupArticle === true) return false;
  return true;
}

function buildUrlOwnershipIndex(reviewTextsDir, { force = false } = {}) {
  if (_index && _index.dir === reviewTextsDir && !force) return _index.map;
  const map = new Map();
  let showDirs = [];
  try {
    showDirs = fs.readdirSync(reviewTextsDir).filter((d) => !d.startsWith('_') && !d.startsWith('.'));
  } catch {
    _index = { dir: reviewTextsDir, map };
    return map;
  }
  for (const showId of showDirs) {
    const dir = path.join(reviewTextsDir, showId);
    let stat;
    try { stat = fs.statSync(dir); } catch { continue; }
    if (!stat.isDirectory()) continue;
    let files;
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'failed-fetches.json');
    } catch { continue; }
    for (const f of files) {
      let data;
      try {
        data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      } catch { continue; }
      if (!_isOwnableUrl(data.url)) continue;
      const key = _normalizeUrl(data.url);
      if (!key) continue;
      const entry = { showId, file: f, blocking: _isBlockingOwnerCopy(data) };
      const arr = map.get(key);
      if (arr) arr.push(entry); else map.set(key, [entry]);
    }
  }
  _index = { dir: reviewTextsDir, map };
  return map;
}

/**
 * Cross-show owners of `url` — entries under shows OTHER than currentShowId.
 * Empty array when the URL is unclaimed or only claimed by currentShowId.
 */
function findCrossShowOwners(url, currentShowId, reviewTextsDir) {
  if (!_isOwnableUrl(url)) return [];
  const map = buildUrlOwnershipIndex(reviewTextsDir);
  const key = _normalizeUrl(url);
  if (!key) return [];
  return (map.get(key) || []).filter((e) => e.showId !== currentShowId);
}

/**
 * Pure decision: should a NEW file with this URL be blocked under this show?
 * @param {Array<{showId:string, file:string, blocking:boolean}>} owners
 * @returns {{ block: boolean, owner?: {showId:string, file:string} }}
 */
function shouldBlockCrossShowCreate(owners) {
  const live = (owners || []).find((e) => e.blocking);
  return live ? { block: true, owner: { showId: live.showId, file: live.file } } : { block: false };
}

/**
 * Incremental index update — call after this process creates a file, so a
 * later create in the same run sees the new owner without an fs rescan.
 * Pass the written record so blocking state matches _isBlockingOwnerCopy —
 * a create that Guard A already stamped wrongProduction (or that is a
 * roundup/combined article) is NOT a live owner and must not block the
 * legitimate destination show later in the same run.
 */
function recordUrlOwner(url, showId, file, reviewTextsDir, record = null) {
  if (!_isOwnableUrl(url) || !_index || _index.dir !== reviewTextsDir) return;
  const key = _normalizeUrl(url);
  if (!key) return;
  const entry = { showId, file, blocking: record ? _isBlockingOwnerCopy(record) : true };
  const arr = _index.map.get(key);
  if (arr) arr.push(entry); else _index.map.set(key, [entry]);
}

/** Test hook — drop the process cache. */
function _resetUrlOwnershipIndex() {
  _index = null;
}

module.exports = {
  buildUrlOwnershipIndex,
  findCrossShowOwners,
  shouldBlockCrossShowCreate,
  recordUrlOwner,
  _resetUrlOwnershipIndex,
  _isBlockingOwnerCopy,
};
