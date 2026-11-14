/**
 * Rebuild-pause tombstone — opening-night manual-edit race guard.
 *
 * Incident: Schmigadoon 2026-04-21 opening morning. An edit to
 * broadway-scorecard-data/reviews.json (removing 2 wrong-production entries)
 * raced a rebuild-reviews run that was auto-committing reviews.json from
 * review-texts. Manual `gh run cancel` took ~60s to propagate, and the
 * rebuild's push could have overwritten the manual fix before the broadcast.
 *
 * This module is the read-side of a tombstone file that tells rebuild-all-
 * reviews.js (and any other rebuild entry point) to exit early without
 * touching reviews.json. `scripts/pause-rebuild.js` is the write-side CLI.
 *
 * Fail-open: any read/parse error → not paused (do not let a corrupt
 * tombstone accidentally disable rebuilds permanently).
 */

const fs = require('fs');
const path = require('path');

const REBUILD_PAUSE_PATH = path.join(__dirname, '..', '..', 'data', 'audit', 'rebuild-pause.json');

function readRebuildPause(pausePath = REBUILD_PAUSE_PATH) {
  try {
    if (!fs.existsSync(pausePath)) return null;
    const raw = fs.readFileSync(pausePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    if (!parsed.until) return null;
    const until = new Date(parsed.until);
    if (Number.isNaN(until.getTime())) return null;
    return {
      until,
      reason: typeof parsed.reason === 'string' ? parsed.reason : '',
      pausedBy: typeof parsed.pausedBy === 'string' ? parsed.pausedBy : '',
      pausedAt: typeof parsed.pausedAt === 'string' ? parsed.pausedAt : '',
    };
  } catch {
    return null;
  }
}

function isRebuildPaused(nowMs = Date.now(), pausePath = REBUILD_PAUSE_PATH) {
  const entry = readRebuildPause(pausePath);
  if (!entry) return false;
  return entry.until.getTime() > nowMs;
}

module.exports = {
  REBUILD_PAUSE_PATH,
  readRebuildPause,
  isRebuildPaused,
};
