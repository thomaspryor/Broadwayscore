'use strict';
/**
 * BRO-7741: what ingest-urls does with a show the opening-night lane holds. Before this, a hand-dispatched URL for a
 * leased show was dropped with one warning line, and the only way to add a missed review on the night was a full lane
 * rollback. Now a hand dispatch is routed into the lane's manual inbox (opening-night-lane/manual-inbox.js), which the
 * running lane reads every pass.
 *
 * Kept outside scripts/lib/opening-night-lane/ on purpose: ingest-urls requires it, and nothing the lane itself runs
 * does, so it does not join the lane code hash (an edit here never disarms the lane).
 */

/**
 * Pure. lease: leaseSkipReason() for the show (a lease object, {unknown:true}, or null).
 * @returns {{action: 'ingest'|'inbox'|'refuse', why: string}}
 */
function ingestRouteDecision({ lease, caller = '', dryRun = false, noFetch = false, noRebuild = false } = {}) {
  if (!lease) return { action: 'ingest', why: 'no opening-night lease on this show' };
  // Unknown lease state (the sync failed): nobody can tell whether a lane is running to read the inbox.
  if (lease.unknown) return { action: 'refuse', why: 'the opening-night lease state could not be read, so the show is treated as held' };
  if (caller) return { action: 'refuse', why: `automated caller "${caller}" never writes to a leased show; the lane finds its own reviews` };
  if (dryRun || noFetch || noRebuild) return { action: 'refuse', why: 'dry_run / no_fetch / no_rebuild ask for a partial ingest the lane inbox cannot honour' };
  return { action: 'inbox', why: `held by the opening-night lane (${lease.holder || 'lane'}); the lane publishes inbox URLs on its next pass` };
}

/**
 * Append parsed ingest lines ({url, outletOverride, listedCritic}) to the inbox. Sync git (compare-and-swap push).
 * @returns {{ok, added?, duplicates?, invalid?, reason?, detail?}}
 */
function routeToInbox({ showId, entries, repoDir, addedBy = 'ingest-urls', now }) {
  const inbox = require('./opening-night-lane/manual-inbox');
  const lines = (entries || []).map((e) => ({ url: e.url, ...(e.outletOverride ? { outletId: e.outletOverride } : {}), ...(e.listedCritic ? { critic: e.listedCritic } : {}) }));
  return inbox.addSync({ repoDir, ...(now !== undefined ? { now } : {}) }, { show: showId, lines, addedBy });
}

/**
 * The show's active lease read live from the remote lease store (any holder, the caller's own included), never the
 * job's local copy. {unknown:true, holder} when the store cannot be read, else the lease or null.
 */
function liveLease(show, repoDir) {
  try {
    const { state } = require('./opening-night-lane/lease-store').readRemote({ repoDir });
    return require('./opening-night-lane/lease').activeLeaseFor(state, show);
  } catch (e) {
    return { holder: `unknown (lease store unreadable: ${String((e && e.message) || e).slice(0, 80)})`, unknown: true };
  }
}

/**
 * After an inbox write: if the lane has released the show meanwhile (it ended between the lease check and the write),
 * no lane reads these entries and the end-of-night drain may already have run. Mark them drained and tell the caller
 * to ingest them the regular way (after refreshing the local lease file). A duplicate ingest is harmless; a stranded
 * URL is a missing review, and the hourly inbox sweep re-sends a drained URL that never reached reviews.json.
 * @returns {{ingestNow: boolean, lease}}
 */
function settleAfterInboxWrite({ showId, ids, repoDir, readLease = liveLease, mark, syncLocal }) {
  const lease = readLease(showId, repoDir);
  if (lease) return { ingestNow: false, lease };
  // The job's local lease file (written at job start) still says held, and the landing step reverts a held show's
  // files: refresh it first. If that fails, leave the entries queued for the hourly sweep rather than ingest into a revert.
  const doSync = syncLocal || (() => require('./opening-night-lane/lease-store').syncLocalFile({ repoDir }, require('./opening-night-lane/lease-guard').leasesFile()));
  try { doSync(); } catch (e) {
    return { ingestNow: false, lease: { unknown: true, holder: `local lease refresh failed: ${String((e && e.message) || e).slice(0, 80)}` } };
  }
  const doMark = mark || ((updates) => require('./opening-night-lane/manual-inbox').markSync({ repoDir }, updates));
  if (ids && ids.length) doMark(ids.map((id) => ({ id, status: 'drained', reason: 'the lane ended while this was queued; ingested directly' })));
  return { ingestNow: true, lease: null };
}

/**
 * BRO-7891 item 2: what new-fix-plan says about a review-field-edit on a show an opening-night lane holds. Pure. The
 * regular plan only reaches the site after the lease ends (the rebuild skips a leased show), so a field the lane can
 * correct is refused with the lane's own command; any other field is a warning that it lands after the lane.
 * @param action {file:'<show>/<file>.json', field, newValue}
 * @param lease  the show's live lease (liveLease), {unknown:true}, or null
 * @param url    the review's URL when known
 * @returns {{level:'refuse'|'warn', message}|null}
 */
function laneHeldEditProblem(action, lease, { url } = {}) {
  if (!action || action.type !== 'review-field-edit' || !lease) return null;
  const show = String(action.file || '').split('/')[0];
  if (lease.unknown) return { level: 'warn', message: `could not read the opening-night lease store for ${show}; if a lane holds it tonight this edit reaches the site only after the lane ends` };
  const { LANE_CORRECTION_FIELDS } = require('./opening-night-lane/manual-inbox');
  if (LANE_CORRECTION_FIELDS.includes(action.field)) {
    const q = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;
    return { level: 'refuse', message: `the opening-night lane holds ${show} (${lease.holder || 'lane'}): this plan would reach the site only after the lane ends. `
      + `Correct it in the lane tonight: node scripts/opening-night-lane-inbox.js correct --show=${show} --url=${q(url || '<review URL>')} --field=${action.field} --value=${q(JSON.stringify(action.newValue))} `
      + '(or pass --after-lane to write the plan anyway)' };
  }
  return { level: 'warn', message: `the opening-night lane holds ${show}: ${action.field} cannot be corrected by the lane, so this edit reaches the site only after the lane ends` };
}

module.exports = { laneHeldEditProblem, ingestRouteDecision, routeToInbox, liveLease, settleAfterInboxWrite };
