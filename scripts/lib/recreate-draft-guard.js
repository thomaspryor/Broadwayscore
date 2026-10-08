/**
 * Pure safety checks for `send-opening-night-broadcast.js --recreate-draft`.
 *
 * --recreate-draft deletes the show's existing Resend draft and creates a fresh
 * one (used when the data behind a draft changed after it was made). Until
 * BRO-4875 it never checked whether that "draft" had already been SENT: a
 * failed DELETE logged "continuing anyway", the tracker records were cleared
 * and a second draft for the same show went to the owner, one click away from
 * a double email to the whole audience.
 *
 * Two gates, both fail closed:
 *   1. collectRecreateDraftIds: every tracker record that names the shows (the
 *      market:a+b broadcastKey, each per-show mirror, any older combo key).
 *      Any record already classified as sent refuses the recreate.
 *   2. recreateDraftBlockReason: a live Resend GET of every draftId found.
 *      Only 'draft' and 'cancelled' are safe. A 404 is NOT safe: Resend also
 *      404s a broadcast it reaped after a successful send (broadcast-state.js
 *      TERMINAL_FAILURE_STATUSES comment, the-balusters-2026).
 */

const { classifyBroadcastState } = require('./missed-broadcasts');

const SAFE_LIVE_STATUSES = new Set(['draft', 'cancelled']);

/** Show ids named by a `market:a+b` broadcast key, or null for any other key shape. */
function showsInBroadcastKey(key) {
  if (!key || key.startsWith('preview:') || key.startsWith('overdue-alert:')) return null;
  const m = /^[a-z-]+:([^:]+)$/.exec(key);
  return m ? m[1].split('+') : null;
}

/** True when tracker key `key` is a draft record covering `showId`. */
function recordCoversShow(key, showId) {
  if (key === showId) return true;
  const shows = showsInBroadcastKey(key);
  return Boolean(shows && shows.includes(showId));
}

/**
 * @param {object} sentShows   opening-night-sent.json `.shows`
 * @param {string} broadcastKey the key this run would record under
 * @param {string[]} showIds
 * @returns {{ keys: string[], draftIds: string[], blockReason: string|null }}
 *   keys: every tracker key the recreate should clear once the drafts are gone.
 */
function collectRecreateDraftIds(sentShows, broadcastKey, showIds) {
  const shows = sentShows || {};
  const keys = [];
  const draftIds = new Set();
  for (const [key, rec] of Object.entries(shows)) {
    if (!rec) continue;
    if (key !== broadcastKey && !showIds.some(id => recordCoversShow(key, id))) continue;
    if (classifyBroadcastState(rec) === 'sent') {
      return { keys: [], draftIds: [], blockReason: `tracker record "${key}" says this broadcast was already sent` };
    }
    // An old multi-show draft also carries shows this run would leave out:
    // deleting it would drop their email with nothing to replace it.
    const covered = [...(showsInBroadcastKey(key) || []), ...(showsInBroadcastKey(rec.broadcastKey) || [])];
    const missing = covered.filter(id => !showIds.includes(id));
    if (missing.length) {
      return { keys: [], draftIds: [], blockReason: `old draft "${key}" also covers ${[...new Set(missing)].join(', ')}; include every show from that draft` };
    }
    keys.push(key);
    if (rec.draftId) draftIds.add(rec.draftId);
  }
  return { keys, draftIds: [...draftIds], blockReason: null };
}

/**
 * @param {object} apiResponse result of reconcile-broadcast-state.js getBroadcastWithRetry
 *   ({ok:true,data:{status}} on 200, {ok:true,data:{status:'deleted'}} on 404, {ok:false,...} otherwise)
 * @returns {string|null} null when the old broadcast is provably unsent
 */
function recreateDraftBlockReason(apiResponse) {
  if (!apiResponse || !apiResponse.ok) {
    return `could not read the old broadcast from Resend (${(apiResponse && (apiResponse.error || apiResponse.statusCode)) || 'no response'})`;
  }
  const status = String((apiResponse.data && apiResponse.data.status) || '').toLowerCase();
  if (SAFE_LIVE_STATUSES.has(status)) return null;
  if (status === 'deleted') {
    return 'Resend no longer has the old broadcast (404); a sent broadcast is also removed this way, so it cannot be proven unsent';
  }
  return `old broadcast status is "${status || 'unknown'}", not draft`;
}

module.exports = { collectRecreateDraftIds, recreateDraftBlockReason, recordCoversShow };
