/**
 * park-marker.js — the `## Parked <date>` Outcome header written by
 * bsc-prune's tab-close parking flow (parkCard, task #776) and parsed by the
 * daily stuck-work check (stuck-work.js) and any parked-card reader (#777).
 *
 * The marker is a machine-parsed cross-file contract: produced in one script,
 * parsed in others. Both sides MUST go through this lib — never inline the
 * string or the regex (feedback_must_match_comment_is_a_bug).
 *
 * Zero-dependency leaf for the same reason as recheck-stamp.js: stuck-work
 * runs inside the daily health digest, and a load-time failure in a heavier
 * dependency chain would silently degrade the digest.
 */

'use strict';

// Head-anchored on purpose (no /m flag): notion-brain `--outcome` PREPENDS,
// so a freshly parked card has the marker as the very first bytes of its
// Outcome. Any later outcome write (wrap-up, recheck, action-queue result)
// pushes the marker off the head and the match correctly fails → the card
// falls back to the ordinary stuck-work alarm (fail-safe). A .includes() or
// multiline match would let a stale marker from an earlier park/resume cycle
// exempt a genuinely re-stuck card from the alarm forever.
const PARK_MARKER_RE = /^## Parked (\d{4}-\d{2}-\d{2})\b/;

/**
 * Parse the parked date from the head of an Outcome field.
 * @returns {number|null} ms of midnight UTC on the parked day, or null
 */
function parseParkedDate(text) {
  const m = PARK_MARKER_RE.exec(String(text || ''));
  if (!m) return null;
  const t = Date.parse(`${m[1]}T00:00:00Z`);
  return Number.isFinite(t) ? t : null;
}

/**
 * The exact Outcome text parkCard writes — byte-identical to the inline
 * string it shipped with on 2026-08-02 (bsc-prune.js, task #776).
 * @param {{dateStr:string, workspaceRef:string, taskId:string|number}} p
 */
function formatParkOutcome({ dateStr, workspaceRef, taskId }) {
  return `## Parked ${dateStr}\nOwner closed its workspace (${workspaceRef}) without marking it done, so the dispatcher stopped re-opening it. Resume with \`node scripts/bsc-next.js --id ${taskId} --force\`.`;
}

module.exports = { PARK_MARKER_RE, parseParkedDate, formatParkOutcome };
