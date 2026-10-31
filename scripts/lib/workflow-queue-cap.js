'use strict';
/**
 * workflow-queue-cap.js (BRO-6532): cap how many runs of a bulk workflow may be
 * in flight before another dispatch of it is deferred.
 *
 * WHY: the account runs about 40 jobs at once and GitHub starts queued jobs
 * roughly first in, first out, with no priority for land.yml or test.yml. On
 * 2026-10-29 one day of per-show fan-out (359 ingest-urls runs, 333 per-show
 * llm-ensemble-score runs, historical gather backfills of 10 jobs each) left
 * 155-282 runs queued and a Land run waiting 2h37m for a runner.
 *
 * Rules:
 * - Only the workflows in CAPS are capped. Everything else (land, test,
 *   vercel-deploy, opening-night-*) always passes.
 * - `priority` callers (opening-night work) always pass.
 * - Over the cap the dispatch is DEFERRED, never queued and never waited for
 *   inside a runner: a runner that sleeps waiting for capacity is itself one of
 *   the 40 (the gather slot waiter already does this; do not add more).
 * - If the counts cannot be read the check passes (fail open, with a warning):
 *   a GitHub API hiccup must never stop real work.
 * - No concurrency groups: GitHub keeps one pending run per group and drops the
 *   older pending one, which silently lost per-show gather inputs (BRO-4859).
 *
 * Counting reuses rebuild-in-flight's repo-wide status pages: 3 API calls for
 * any workflow, exact per-workflow counts only when a page is full.
 * Kill switch: WORKFLOW_CAP_DISABLED=1 (workflows pass vars.WORKFLOW_CAP_DISABLED).
 */
const { countActiveRuns, isSaturated, PER_PAGE } = require('./rebuild-in-flight');
const { ghApi, DEFAULT_REPO } = require('./rest-dispatch');

// In-flight runs allowed per bulk workflow. gather-reviews fans out to up to 10
// matrix jobs per run, so 2 matches its own FIFO slot gate (wait-for-gather-slot.js).
const CAPS = Object.freeze({
  'llm-ensemble-score.yml': 6,
  'ingest-urls.yml': 4,
  'gather-reviews.yml': 2,
});

// `gh workflow run "<name>"` dispatches by display name (each file's `name:`);
// maps it back to the file. Shared by the coverage test and the session hook.
const WORKFLOW_DISPLAY_NAMES = Object.freeze({
  'LLM Ensemble Score Reviews': 'llm-ensemble-score.yml',
  'Gather Review Data': 'gather-reviews.yml',
  'Ingest Review URLs': 'ingest-urls.yml',
});

// rebuild-in-flight counts in_progress, queued and pending (concurrency-held).
const STATUSES = ['in_progress', 'queued', 'pending'];

const on = (v) => v === true || v === '1' || v === 'true';

/** Pure. Returns { ok, reason }. `active` null means the count was unavailable. */
function decideCap({ workflow, active, cap = CAPS[workflow], priority = false, disabled = false }) {
  if (disabled) return { ok: true, reason: 'cap disabled (WORKFLOW_CAP_DISABLED)' };
  if (!cap) return { ok: true, reason: `${workflow} is not a capped workflow` };
  if (priority) return { ok: true, reason: 'priority dispatch (opening night)' };
  if (active === null || active === undefined) return { ok: true, reason: 'in-flight count unavailable, allowing' };
  if (active >= cap) return { ok: false, reason: `${active} ${workflow} runs in flight (cap ${cap})` };
  return { ok: true, reason: `${active} of ${cap} ${workflow} runs in flight` };
}

/** In-flight runs of `workflow`, or null when GitHub cannot be read. */
function countInFlight({ workflow, repo = DEFAULT_REPO, api = ghApi }) {
  try {
    const payloads = STATUSES.map((s) => api([`repos/${repo}/actions/runs?status=${s}&per_page=${PER_PAGE}`]));
    if (!isSaturated(payloads)) return countActiveRuns(payloads, [workflow]);
    return STATUSES.reduce((n, s) => {
      const body = api([`repos/${repo}/actions/workflows/${workflow}/runs?status=${s}&per_page=1`]);
      return n + (Number(body && body.total_count) || 0);
    }, 0);
  } catch {
    return null;
  }
}

/** Read the count and decide. Returns { ok, reason, active, cap }. */
function checkCap({ workflow, priority = false, repo, api, env = process.env, log = console.log }) {
  const cap = CAPS[workflow];
  const disabled = on(env.WORKFLOW_CAP_DISABLED);
  // Skip the API calls when the answer cannot depend on them.
  const active = (cap && !disabled && !priority) ? countInFlight({ workflow, repo, api }) : undefined;
  if (active === null) log(`::warning::workflow-queue-cap: could not count ${workflow} runs; dispatching without the cap`);
  return { ...decideCap({ workflow, active, cap, priority, disabled }), active, cap };
}

module.exports = { CAPS, WORKFLOW_DISPLAY_NAMES, decideCap, countInFlight, checkCap };
