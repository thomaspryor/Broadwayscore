/**
 * image-trigger-guard.js
 *
 * Pure decision functions for card #1456 (new shows going live with
 * images:{} for up to 3.5 days because image fetch was cron-only). No I/O
 * here — callers do the shows.json/reviews.json/disk reads (per CLAUDE.md
 * §15 test-extraction rule) and pass in plain data.
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

module.exports = { buildImageDispatchInputs, findImagelessScoredShows, DEFAULT_THRESHOLD_HOURS };
