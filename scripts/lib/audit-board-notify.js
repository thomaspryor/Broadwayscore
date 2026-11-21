'use strict';
/**
 * Filing a task-board card must never cost an audit its data (BRO-7920).
 *
 * audit-closing-dates.js and audit-we-closing-dates.js save shows.json, then
 * file a Linear card for anything ambiguous. When that call threw (a Linear
 * 429 outlived the child's 60s timeout on 2026-11-19), the step exited 1 and
 * the workflow's "Push core data" step (if: success()) skipped, so that day's
 * closing-date extensions were never pushed.
 *
 * A transient failure now degrades to a ::warning:: annotation: the data push
 * goes ahead, and the finding is not lost because the next daily run detects
 * it again and retries the card. A missing LINEAR_API_KEY is configuration,
 * not weather, so it still fails the run loudly (BRO-3430: never silently drop).
 */

const MISSING_KEY = 'LINEAR_KEY_MISSING';

function missingKeyError(message) {
  const e = new Error(message);
  e.code = MISSING_KEY;
  return e;
}

/**
 * @param {() => Promise<void>} notify  the script's own notifyLinear call
 * @param {string} label                which audit, for the annotation
 * @param {(line: string) => void} [log]
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
async function notifyBoardAfterSave(notify, label, log = console.log) {
  try {
    await notify();
    return { ok: true };
  } catch (e) {
    if (e && e.code === MISSING_KEY) throw e;
    const msg = String((e && e.message) || e).replace(/\s+/g, ' ').slice(0, 300);
    log(`::warning::${label}: could not file the task-board card (${msg}). Data updates were saved and still push; the next daily run re-detects the finding and retries.`);
    return { ok: false, error: msg };
  }
}

module.exports = { notifyBoardAfterSave, missingKeyError, MISSING_KEY };
