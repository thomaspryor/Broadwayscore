'use strict';

/**
 * Shows a gather-reviews.yml shard ran out of time for (BRO-4859).
 *
 * scripts/gather-reviews.js stops starting new shows once --time-budget-min is
 * spent, so the job exits cleanly inside its timeout. The shows it never reached
 * used to be logged ("deferring N show(s) to next run") and then dropped: run
 * 37788158212 deferred 24 of 48 dispatched shows and nothing picked them up.
 * Now the script keeps them in $GATHER_DEFERRED_FILE, each shard uploads that
 * file as a gather-deferred-* artifact, and the workflow's follow-up job merges
 * the lists and dispatches one new gather run for them. A run that deferred
 * every show it was given made no progress, so it is not re-dispatched (that
 * would loop); the follow-up job warns instead. Otherwise the list shrinks on
 * every hop and the chain ends.
 */

const fs = require('fs');

const SHOW_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Write the shows this shard has not gathered yet to `file` (one per line),
 * replacing what was there. gather-reviews.js writes the full list before its
 * loop and the shrinking remainder after each show, so a crash mid-loop still
 * leaves the unreached shows on disk for the if: always() upload. No-op
 * without a file.
 * @returns {boolean} true when the file now lists at least one show
 */
function recordDeferredShows(ids, file = process.env.GATHER_DEFERRED_FILE) {
  if (!file) return false;
  const list = (Array.isArray(ids) ? ids : []).map((s) => String(s).trim()).filter(Boolean);
  try {
    fs.writeFileSync(file, list.length ? list.join('\n') + '\n' : '');
  } catch (e) {
    // Best effort: a failed write must not stop the gather itself.
    console.warn(`⚠️  could not record deferred shows to ${file}: ${e.message}`);
    return false;
  }
  return list.length > 0;
}

/**
 * Merge deferred-show file contents into one ordered, de-duplicated id list.
 * Anything that is not a plain show id is dropped (it ends up in a -f shows=
 * argument).
 * @param {string[]} texts  contents of each shard's deferred file
 * @returns {string[]}
 */
function collectDeferredShows(texts) {
  const seen = new Set();
  for (const t of Array.isArray(texts) ? texts : []) {
    for (const raw of String(t || '').split(/[\n,]/)) {
      const id = raw.trim();
      if (SHOW_ID_RE.test(id)) seen.add(id);
    }
  }
  return [...seen];
}

/**
 * The show list to re-dispatch: the deferred ids, unless they cover every show
 * this run was given (no progress, so re-dispatching would loop).
 * @param {string[]} deferred  from collectDeferredShows
 * @param {string} runShows  this run's comma-separated `shows` input
 * @returns {{shows:string[], stalled:boolean}}
 */
function redispatchPlan(deferred, runShows) {
  const given = collectDeferredShows([runShows]);
  const d = Array.isArray(deferred) ? deferred : [];
  const stalled = d.length > 0 && given.length > 0 && given.every((id) => d.includes(id));
  return { shows: stalled ? [] : d, stalled };
}

module.exports = { recordDeferredShows, collectDeferredShows, redispatchPlan };
