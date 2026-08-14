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
 * Normalizes a list of show ids into fetch-all-image-formats.yml
 * workflow_dispatch inputs. show_id only accepts one id per dispatch (no
 * comma-list support in fetch-show-images-auto.js's --show= filter), so
 * callers dispatch once per returned entry.
 *
 * @param {Array<string>} showIds
 * @returns {Array<{workflow_id: string, inputs: {show_id: string, only_missing: string}}>}
 */
function buildImageDispatchInputs(showIds) {
  const seen = new Set();
  const dispatches = [];
  for (const raw of showIds || []) {
    const id = typeof raw === 'string' ? raw.trim() : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    dispatches.push({
      workflow_id: 'fetch-all-image-formats.yml',
      inputs: { show_id: id, only_missing: 'true' },
    });
  }
  return dispatches;
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
