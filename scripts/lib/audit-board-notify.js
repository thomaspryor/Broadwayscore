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
 * not weather: assertBoardConfigured() fails the run BEFORE anything is
 * written (BRO-3430: never silently drop, and never after a save).
 *
 * The annotation alone is not a durable signal, so a failed card also posts
 * the finding to the Discord alerts webhook when one is configured.
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
/** Call at the top of a real (non-dry) run, before any data is written. */
function assertBoardConfigured(env = process.env) {
  if (!env.LINEAR_API_KEY) {
    throw missingKeyError('LINEAR_API_KEY not set: the audit could not file its findings, so it refuses to run (set the secret, or pass --dry-run)');
  }
}

async function postDiscord(text, env = process.env, fetchFn = globalThis.fetch) {
  const webhook = env.DISCORD_WEBHOOK_ALERTS;
  if (!webhook || typeof fetchFn !== 'function') return false;
  try {
    await fetchFn(webhook, {
      signal: AbortSignal.timeout(60000),
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: text.slice(0, 1900) }),
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {() => Promise<void>} notify  the script's own notifyLinear call
 * @param {string} label                which audit, for the annotation
 * @param {{summary?: string, log?: (line: string) => void, env?: object, fetchFn?: Function}} [opts]
 *        summary: the findings, posted to Discord if the card fails
 * @returns {Promise<{ok: boolean, error?: string, discord?: boolean}>}
 */
async function notifyBoardAfterSave(notify, label, opts = {}) {
  const log = opts.log || console.log;
  try {
    await notify();
    return { ok: true };
  } catch (e) {
    if (e && e.code === MISSING_KEY) throw e;
    const msg = String((e && e.message) || e).replace(/\s+/g, ' ').slice(0, 300);
    log(`::warning::${label}: could not file the task-board card (${msg}). Data updates were saved and still push; the next daily run re-detects the finding and retries.`);
    const discord = await postDiscord(
      `⚠️ ${label}: the task-board card could not be filed (${msg}). Findings:\n${opts.summary || '(see the run log)'}`,
      opts.env, opts.fetchFn,
    );
    return { ok: false, error: msg, discord };
  }
}

module.exports = { notifyBoardAfterSave, assertBoardConfigured, missingKeyError, MISSING_KEY };
