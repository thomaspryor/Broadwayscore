/**
 * image-trigger-guard.js
 *
 * Decision functions for card #1456 (new shows going live with images:{} for
 * up to 3.5 days because image fetch was cron-only). No I/O here — callers do
 * the shows.json/reviews.json/disk reads (per CLAUDE.md §15 test-extraction
 * rule) and pass in plain data.
 *
 * buildImageDispatchInputs / findImagelessScoredShows / planSelfHealDispatch
 * are pure. executeSelfHealDispatch is the one exception and is deliberately
 * NOT an I/O function either: every effect it performs (dispatch, onAlert,
 * log) is injected by the caller, so the module still reads and writes
 * nothing itself. It lives here rather than in the caller because the two
 * properties worth guarding — "N shows produce at most ONE dispatch" and "a
 * FAILED dispatch starts no cooldown" — are only reachable by a test with a
 * stubbed dispatcher if the loop is gone from the caller entirely.
 *
 * hasImages should be computed by callers via hasRealImage() from
 * scripts/lib/show-images.js — the same disk-existence predicate
 * auto-fix-show-data.js's checkMissingImages() already uses — so this file
 * doesn't invent a third definition of "has an image".
 */

'use strict';

const DEFAULT_THRESHOLD_HOURS = 24;

/**
 * Normalizes a list of show ids into a SINGLE fetch-all-image-formats.yml
 * workflow_dispatch input, all ids joined comma-separated into one
 * show_id (fetch-show-images-auto.js's --show= filter splits on comma).
 *
 * BRO-2672: this used to return one dispatch PER show id. The job's
 * concurrency group (group: fetch-images, cancel-in-progress: false) only
 * keeps ONE run queued at a time — GitHub Actions silently CANCELS every
 * extra run fired into it rather than queueing them, so N per-show
 * dispatches fired in a burst meant at most 2 of N ever ran (one running,
 * one queued, the rest cancelled within seconds) while the dispatcher
 * logged "success" for all N because the workflow_dispatch API call itself
 * had been accepted. A single dispatch carrying every id can't be cancelled
 * by its OWN siblings — this eliminates fan-out self-cancellation, which was
 * the entire observed incident. It does NOT make the group contention-free:
 * a concurrent dispatch from a different caller (a second promotion run, the
 * twice-weekly cron, a manual dispatch) still shares the same single-slot
 * group and can still cancel this batch or be cancelled by it. The job
 * loops over the comma list internally.
 *
 * @param {Array<string>} showIds
 * @returns {Array<{workflow_id: string, inputs: {show_id: string, only_missing: string}}>}
 *   Zero or one entry — never one per id.
 */
function buildImageDispatchInputs(showIds) {
  const seen = new Set();
  for (const raw of showIds || []) {
    const id = typeof raw === 'string' ? raw.trim() : '';
    if (id) seen.add(id);
  }
  if (!seen.size) return [];
  return [{
    workflow_id: 'fetch-all-image-formats.yml',
    inputs: { show_id: [...seen].join(','), only_missing: 'true' },
  }];
}

/**
 * Flags shows that have reviews (are live/scored) but no image on disk,
 * past a grace threshold. Input shape is pre-normalized by the caller:
 *   { id, title, hasImages, reviewCount, sinceMs }
 * sinceMs should be the earliest known "this show went live" timestamp
 * (discoveredAt / openingDate / previewsStartDate, whichever the caller
 * resolves) in epoch ms; entries with no resolvable sinceMs are skipped
 * rather than guessed at.
 *
 * @param {Array<{id:string,title?:string,hasImages:boolean,reviewCount:number,sinceMs:?number}>} shows
 * @param {{nowMs: number, thresholdHours?: number}} opts
 * @returns {Array<object>} the flagged entries, unchanged
 */
function findImagelessScoredShows(shows, { nowMs, thresholdHours = DEFAULT_THRESHOLD_HOURS } = {}) {
  const thresholdMs = thresholdHours * 60 * 60 * 1000;
  return (shows || []).filter((s) => {
    if (!s || s.hasImages) return false;
    if (!(s.reviewCount > 0)) return false;
    if (s.sinceMs == null || Number.isNaN(s.sinceMs)) return false;
    return (nowMs - s.sinceMs) >= thresholdMs;
  });
}

/**
 * Decide what one self-heal cycle of audit-imageless-scored-shows.js should do.
 *
 * BRO-2672 batched dispatch-new-show-images.js but left this second caller
 * dispatching one workflow_dispatch per show inside its loop. Every dispatch
 * lands in fetch-all-image-formats.yml's single-slot concurrency group
 * (`group: fetch-images`, `cancel-in-progress: false`), which keeps ONE run
 * queued and silently CANCELS the rest — so a cap of 5 produced bursts of five
 * runs seconds apart of which at most one survived. Worse, the caller recorded
 * lastDispatchedAt for every one of them, so the cooldown then suppressed the
 * retry: the ledger showed five self-heal attempts for images that were never
 * fetched. Observed 2026-09-07 at 08:44 and 16:48 UTC, five dispatches each,
 * zero successes.
 *
 * Returning `dispatchInputs` through buildImageDispatchInputs() is what makes
 * the fan-out structurally impossible rather than a rule to remember: that
 * function collapses any number of ids into at most ONE dispatch entry.
 *
 * Pure — no I/O, no clock, no network. `prevById` is a Map of id -> ledger row.
 */
function planSelfHealDispatch({ orderedFlagged, prevById, nowMs, cooldownHours, maxDispatchesPerRun }) {
  const prev = prevById instanceof Map ? prevById : new Map(Object.entries(prevById || {}));
  const due = [];
  const deferred = [];
  const entries = [];
  for (const f of orderedFlagged || []) {
    const row = prev.get(f.id) || {
      firstFlaggedAt: new Date(nowMs).toISOString(),
      dispatchAttempts: 0,
      lastDispatchedAt: null,
    };
    const cooldownOk = !row.lastDispatchedAt
      || (nowMs - Date.parse(row.lastDispatchedAt)) >= cooldownHours * 3600 * 1000;
    if (cooldownOk) {
      if (due.length < maxDispatchesPerRun) due.push(f);
      else deferred.push(f);
    }
    entries.push({ ...row, id: f.id, title: f.title });
  }
  return {
    due,
    deferred,
    entries,
    dispatchInputs: buildImageDispatchInputs(due.map((f) => f.id)),
  };
}

/**
 * Execute a plan from planSelfHealDispatch(): fire the batch (at most one
 * workflow_dispatch), and advance attempt/cooldown state ONLY for shows a
 * successful dispatch actually carried.
 *
 * Lives here rather than in the caller so the "N shows, ONE dispatch" property
 * and the "a failed dispatch must not start a cooldown" property are both
 * reachable by a test with a stubbed dispatcher. A pre-ship review of the first
 * version of this fix pointed out that planner-only tests stay green if the
 * caller reverts to its own per-show loop — the loop has to be gone from the
 * caller entirely for the guard to mean anything.
 *
 * @param {object}   plan       from planSelfHealDispatch()
 * @param {Function} dispatch   async (showIdOrCsv) => {ok, error?}
 * @param {number}   nowMs
 * @param {Function} [onAlert]  async ({show, error, batchIds}) => void, called
 *                              once PER DUE SHOW when the dispatch fails, so
 *                              alert dedup keys stay per-show and a later batch
 *                              of different shows is not silenced behind an
 *                              earlier one's cooldown (review finding).
 * @param {Function} [log]
 * @returns {Promise<{dispatchCalls: number, ok: boolean|null, dispatched: string[]}>}
 */
async function executeSelfHealDispatch({ plan, dispatch, nowMs, onAlert, log = () => {} }) {
  const entryById = new Map(plan.entries.map((e) => [e.id, e]));
  let dispatchCalls = 0;
  let ok = null;
  const dispatched = [];

  for (const input of plan.dispatchInputs) {
    const batchIds = input.inputs.show_id;
    dispatchCalls += 1;
    const result = await dispatch(batchIds);
    ok = Boolean(result && result.ok);
    if (ok) {
      // Advance state from the ids the dispatch ACTUALLY carried (the batch
      // string), not from plan.due. buildImageDispatchInputs() drops empty /
      // non-string ids, so the two sets can diverge — and a show marked
      // dispatched here that was never in the payload gets a 12h cooldown for
      // work that never happened, which is precisely the ledger corruption
      // this whole fix exists to stop (see planSelfHealDispatch's BRO-2672
      // note). Deriving from batchIds makes the two impossible to diverge.
      for (const id of String(batchIds).split(',')) {
        const entry = entryById.get(id);
        if (!entry) continue;
        entry.dispatchAttempts = (entry.dispatchAttempts || 0) + 1;
        entry.lastDispatchedAt = new Date(nowMs).toISOString();
        dispatched.push(id);
        log(`✓ self-heal dispatched for ${id} (attempt ${entry.dispatchAttempts})`);
      }
    } else {
      const error = (result && result.error) || 'unknown';
      log(`✗ self-heal dispatch failed for ${plan.due.length} show(s): ${error}`);
      if (onAlert) {
        for (const show of plan.due) {
          // eslint-disable-next-line no-await-in-loop
          await onAlert({ show, error, batchIds });
        }
      }
    }
  }

  return { dispatchCalls, ok, dispatched };
}

module.exports = {
  buildImageDispatchInputs,
  planSelfHealDispatch,
  executeSelfHealDispatch,
  findImagelessScoredShows,
  DEFAULT_THRESHOLD_HOURS,
};
