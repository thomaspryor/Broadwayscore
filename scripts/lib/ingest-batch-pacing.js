'use strict';

/**
 * ingest-batch-pacing.js — pure decisions for scripts/dispatch-ingest-batch.js (BRO-6485).
 *
 * Why: a census batch dispatched 323 ingest-urls.yml runs at 12s spacing. Each ingest
 * started its own LLM scoring run and a rebuild, so the shared Actions pool held 300+
 * queued runs for over an hour and every session's land run sat behind them. The batch
 * dispatcher now ingests with no_rebuild, scores all its shows in one list run at the end,
 * and waits while the repo's queue is deep.
 */

const DEFAULT_MAX_ACTIVE = 15;

/** Shows in the plan not yet in the checkpoint, in plan order. */
function pendingShows(plan, done) {
  const doneSet = done instanceof Set ? done : new Set(done || []);
  return Object.keys(plan || {}).filter((id) => !doneSet.has(id) && Array.isArray(plan[id]) && plan[id].length > 0);
}

/** Plan shows with no entries; the CLI reports them rather than dropping them silently. */
function emptyShows(plan) {
  return Object.keys(plan || {}).filter((id) => !Array.isArray(plan[id]) || plan[id].length === 0);
}

/**
 * The ingest-urls.yml `urls` input: one "url outlet" per line, duplicate urls dropped.
 * ingest-urls.js splits each line on whitespace, so a space inside either field would
 * shift the outlet; `knownOutlets` (canonical registry ids), when given, must hold the outlet.
 */
function formatUrlsInput(entries, knownOutlets) {
  const seen = new Set();
  const lines = [];
  for (const e of entries || []) {
    const ok = e && typeof e.url === 'string' && /^https?:\/\/\S+$/.test(e.url)
      && typeof e.outlet === 'string' && /^\S+$/.test(e.outlet);
    if (!ok) throw new Error(`ingest batch: bad entry ${JSON.stringify(e)} (needs an http(s) url and an outlet id, no spaces)`);
    if (knownOutlets && !knownOutlets.has(e.outlet)) throw new Error(`ingest batch: outlet "${e.outlet}" is not in the outlet registry (${e.url})`);
    if (seen.has(e.url)) continue;
    seen.add(e.url);
    lines.push(`${e.url} ${e.outlet}`);
  }
  return lines.join('\n');
}

/** Dispatch only while the repo's queued+pending count is under the cap. An unknown count waits. */
function queueHasRoom(activeCount, maxActive = DEFAULT_MAX_ACTIVE) {
  return Number.isFinite(activeCount) && activeCount < maxActive;
}

module.exports = { DEFAULT_MAX_ACTIVE, pendingShows, emptyShows, formatUrlsInput, queueHasRoom };
