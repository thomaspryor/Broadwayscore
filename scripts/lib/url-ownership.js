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

const { isReviewTextFile } = require('./review-text-sidecars');
const fs = require('fs');
const { multiShowSplitGroup, isMultiShowSplitSibling } = require('./multi-show-split-group');
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
  // A duplicate pointer defers to the file it names; that file is the owner
  // (and blocks on its own when live). BRO-5373: a leftover
  // broadwayworld--unknown stub pointing at the review being moved made the
  // push gate drop the moved review, and the move's source delete went through,
  // so the review was lost.
  if (data.duplicateOf || data.duplicateTextOf) return false;
  return true;
}

// SAME-show liveness (BRO-5198). The combined/roundup clause above is about
// SHARING an article across shows; within its own show a combined copy is the
// live record of that url. The 2026-10-12 refresh turned the Addams/Lend Me a
// Tenor column's named copy into a split parent (isCombinedReview), the
// predicate above then called it dead, and the same-show branch of
// validate-added-review-ownership.js let the unknown-byline duplicate back in.
// A combined copy counts only when the canonical includability check agrees
// (a combined review that is also excluded must not license a deletion).
function _isLiveSameShowCopy(data, showId, filePath) {
  if (_isBlockingOwnerCopy(data)) return true;
  if (!data || data.isCombinedReview !== true || data.isRoundupArticle === true) return false;
  if (data.wrongShow === true || data.wrongProduction === true) return false;
  // The caller DELETES on true: without the show's metadata the production
  // guards are skipped, so fail closed.
  const show = _showMeta(showId);
  if (!show) return false;
  try {
    const { isIncludableForRebuild } = require('./review-guards');
    return isIncludableForRebuild(data, show, filePath);
  } catch {
    return false; // unknown -> not live -> the caller deletes nothing
  }
}

let _showsById = null;
function _showMeta(showId) {
  if (!_showsById) {
    _showsById = new Map();
    try {
      const shows = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'data', 'shows.json'), 'utf8'));
      for (const s of (shows.shows || shows)) if (s && s.id) _showsById.set(s.id, s);
    } catch { /* shows.json unavailable: guards treat a missing show as unknown */ }
  }
  return _showsById.get(showId) || null;
}

// Shows a split file names as the article's other sections (BRO-4431): a
// parent lists its children, a child names its parent.
function _splitShows(data) {
  if (!data || (data.multiShowSplitParent !== true && data.multiShowSplitChild !== true)) return null;
  const out = [];
  if (Array.isArray(data.multiShowSplitChildShowIds)) out.push(...data.multiShowSplitChildShowIds);
  if (data.multiShowSplitParentShowId) out.push(data.multiShowSplitParentShowId);
  if (Array.isArray(data.multiShowSplitSiblingShowIds)) out.push(...data.multiShowSplitSiblingShowIds);
  return out.length ? out : null;
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
      files = fs.readdirSync(dir).filter((f) => isReviewTextFile(f));
    } catch { continue; }
    for (const f of files) {
      let data;
      try {
        data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      } catch { continue; }
      if (!_isOwnableUrl(data.url)) continue;
      const key = _normalizeUrl(data.url);
      if (!key) continue;
      const entry = { showId, file: f, blocking: _isBlockingOwnerCopy(data), splitGroup: multiShowSplitGroup(data, showId), splitShows: _splitShows(data) };
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
// A retired show's folder cannot own a URL. BRO-5890:
// anne-washburns-anon-off-broadway-2026 was retired as a duplicate of the MCC
// ANON (retired-show-ids.json), its NYT and Vulture reviews stayed in its
// folder, and this guard then refused them under the real ANON. An unreadable
// registry counts nothing as retired (the old behaviour).
function _isRetiredShow(showId) {
  try {
    return require('./retired-show-ids').isRetiredId(showId);
  } catch {
    return false;
  }
}

function findCrossShowOwners(url, currentShowId, reviewTextsDir) {
  if (!_isOwnableUrl(url)) return [];
  const map = buildUrlOwnershipIndex(reviewTextsDir);
  const key = _normalizeUrl(url);
  if (!key) return [];
  return (map.get(key) || [])
    .filter((e) => e.showId !== currentShowId)
    .map((e) => (e.blocking && _isRetiredShow(e.showId) ? { ...e, blocking: false, retiredShow: true } : e));
}

/**
 * Pure decision: should a NEW file with this URL be blocked under this show?
 * @param {Array<{showId:string, file:string, blocking:boolean, splitGroup?:string|null}>} owners
 * @param {string|null} [candidateSplitGroup] multiShowSplitGroup() of the new file
 * @returns {{ block: boolean, owner?: {showId:string, file:string} }}
 */
function shouldBlockCrossShowCreate(owners, candidateSplitGroup = null, candidateShowId = null) {
  // A sibling section of the same split multi-show article (BRO-4431) is the
  // same review filed per show, not a competing owner; so is a split owner
  // that names the candidate show as one of the article's sections (the
  // section being re-created under that show).
  const live = (owners || []).find((e) => e.blocking
    && !isMultiShowSplitSibling(candidateSplitGroup, e.splitGroup)
    && !(candidateShowId && Array.isArray(e.splitShows) && e.splitShows.includes(candidateShowId)));
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
  const entry = { showId, file, blocking: record ? _isBlockingOwnerCopy(record) : true, splitGroup: record ? multiShowSplitGroup(record, showId) : null, splitShows: record ? _splitShows(record) : null };
  const arr = _index.map.get(key);
  if (arr) arr.push(entry); else _index.map.set(key, [entry]);
}

/**
 * Does any file (flagged or not) in this one show folder already carry `url`,
 * under the SAME normalization the ownership index uses? Read fresh from disk,
 * so files this process created or merged are seen. BRO-5298: the sibling-url
 * guard must not refuse a write whose url (or a ?srsltid= / www / trailing-slash
 * variant of it) is already here; review-url-collision's sameUrlKey keeps the
 * query string and would miss those. Fails open (false) on an unreadable dir.
 */
function showDirHoldsUrl(showDir, url) {
  if (!_isOwnableUrl(url)) return false;
  const key = _normalizeUrl(url);
  if (!key) return false;
  let files;
  try {
    files = fs.readdirSync(showDir).filter((f) => isReviewTextFile(f));
  } catch { return false; }
  for (const f of files) {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(showDir, f), 'utf8'));
      if (d && _isOwnableUrl(d.url) && _normalizeUrl(d.url) === key) return true;
    } catch { /* unreadable file cannot prove the url is here */ }
  }
  return false;
}

/** Test hook — drop the process cache. */
function _resetUrlOwnershipIndex() {
  _index = null;
  _showsById = null;
}

module.exports = {
  buildUrlOwnershipIndex,
  findCrossShowOwners,
  shouldBlockCrossShowCreate,
  recordUrlOwner,
  showDirHoldsUrl,
  _resetUrlOwnershipIndex,
  _isBlockingOwnerCopy,
  _isLiveSameShowCopy,
  _isOwnableUrl,
};
