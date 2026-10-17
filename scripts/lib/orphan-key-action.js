'use strict';

/**
 * drop-orphan-key: remove an orphan audience-buzz.json or commercial.json
 * key for execute-approved-fix.js (BRO-3248, BRO-4623). Audience keys can
 * also be moved onto a live ID; commercial keys can only be removed.
 *
 *   { type: 'drop-orphan-key', file: 'audience-buzz.json', showId, reason, renameTo? }
 *
 * Pure: takes the parsed file's `shows` map, the live and retired id sets,
 * mutates the map, returns {ok, msg} or {ok:false, reason}. Guardrails:
 *   - showId must NOT be a live shows.json id (this never deletes a real
 *     show's data) and must be a key in the file;
 *   - renameTo must be a live, non-retired id with no entry of its own, and a
 *     retired showId is never moved onto a live show (its data was judged not
 *     to belong anywhere);
 *   - reason is required (it is the plan's record of the judgment).
 * The push-core-data reconcile (scripts/lib/reconcile-audience-buzz.js) no
 * longer re-adds a non-live key, so the drop sticks.
 */

const { MIN_PLAUSIBLE_SHOWS } = require('./live-show-ids');

const FILES = new Set(['audience-buzz.json', 'commercial.json']);
const ID_RE = /^[a-z0-9][a-z0-9-]*$/;

function applyDropOrphanKey(map, action, { liveIds, liveSlugs, retiredIds = new Set() }) {
  const { file, showId, renameTo, reason } = action || {};
  if (!FILES.has(file)) return { ok: false, reason: `drop-orphan-key: unsupported file ${file}` };
  if (!showId || !ID_RE.test(showId)) return { ok: false, reason: 'drop-orphan-key: showId missing or malformed' };
  if (!reason || String(reason).trim().length < 10) return { ok: false, reason: `drop-orphan-key ${showId}: reason (>=10 chars) required` };
  // Same floor as live-show-ids.js: a stub or truncated shows.json would make a
  // real show's key look like an orphan.
  if (!liveIds || liveIds.size < MIN_PLAUSIBLE_SHOWS) return { ok: false, reason: `drop-orphan-key: shows.json has ${liveIds ? liveIds.size : 0} ids (< ${MIN_PLAUSIBLE_SHOWS}), refusing on a stub` };
  if (liveIds.has(showId)) return { ok: false, reason: `drop-orphan-key ${showId}: is a live shows.json id, refusing` };
  if (file === 'commercial.json') {
    // Commercial records use slugs, unlike audience records. Checking only
    // IDs would let a plan delete a real show such as hamilton (ID hamilton-2015).
    if (!liveSlugs || liveSlugs.size === 0) return { ok: false, reason: 'drop-orphan-key: live shows.json slugs required for commercial.json' };
    if (liveSlugs.has(showId)) return { ok: false, reason: `drop-orphan-key ${showId}: is a live shows.json slug, refusing` };
    if (renameTo !== undefined && renameTo !== null) return { ok: false, reason: 'drop-orphan-key: commercial.json supports deletion only' };
  }
  if (!map || !Object.prototype.hasOwnProperty.call(map, showId)) return { ok: false, reason: `drop-orphan-key ${showId}: no such key in ${file}` };
  if (renameTo !== undefined && renameTo !== null) {
    if (retiredIds.has(showId)) return { ok: false, reason: `drop-orphan-key ${showId}: retired id, its data is not moved onto ${renameTo}` };
    if (!liveIds.has(renameTo) || retiredIds.has(renameTo)) return { ok: false, reason: `drop-orphan-key ${showId}: renameTo ${renameTo} is not a live show` };
    if (Object.prototype.hasOwnProperty.call(map, renameTo)) return { ok: false, reason: `drop-orphan-key ${showId}: ${renameTo} already has an entry` };
    map[renameTo] = map[showId];
    delete map[showId];
    return { ok: true, msg: `${file}: moved ${showId} -> ${renameTo}` };
  }
  delete map[showId];
  return { ok: true, msg: `${file}: dropped orphan key ${showId}` };
}

module.exports = { applyDropOrphanKey, DROP_ORPHAN_KEY_FILES: FILES };
