'use strict';
// BRO-6650 (plan v2 S5-T2): flag a change to the opening-night lane code inside the 48h before a Broadway press night.
// A change to any file in rehearsal.js laneCodeFiles() changes the lane code hash, which disarms the lane until
// lane-rehearsal-recorded.yml re-passes under the new hash (about 20 min after the land). Pure decision; the CLI
// (scripts/lane-code-freeze-check.js) gathers the git and shows.json inputs. Advisory for now (CLAUDE.md rule 19).

const FREEZE_BEFORE_MS = 48 * 3600000;
const FREEZE_AFTER_MS = 6 * 3600000; // the lane runs the night itself: embargo +6h covers the shadow and live window
const MIN_REASON = 15;
// Line-anchored with no leading whitespace or quote marker, so a quoted revert body does not count; the reason needs words.
const BYPASS_RE = /^LANE-FREEZE-BYPASS:[ \t]*(.{15,}?)[ \t]*$/im;
// Scope (card BRO-6650: "Broadway press night"): category broadway only. Off-Broadway is left out on purpose: counting every
// market 'broadway' show puts 93% of hours of a normal month inside some window (ship-check measurement), which would make a
// future blocking check a permanent freeze. Widen this list, not the code, if the owner wants Off-Broadway or West End covered.
const FREEZE_CATEGORIES = ['broadway'];
// Deleted or renamed-away paths that no remaining file requires escape the HEAD hash list: these are the hashed
// roots that are walked or listed rather than required (rehearsal.js folder walk, LANE_EXTRA_FILES, scorer graph).
const ROOT_DELETE_RE = /^(scripts\/lib\/opening-night-lane\/|scripts\/llm-scoring\/|scripts\/opening-night-lane(-rehearse)?\.js$|\.github\/workflows\/opening-night-lane-live\.yml$|scripts\/lib\/models\.js$)/;

/** First LANE-FREEZE-BYPASS reason (>= 15 chars) in the commit messages, else null. */
function findOverride(commitMessages = []) {
  for (const m of commitMessages) {
    const hit = BYPASS_RE.exec(String(m || ''));
    if (hit && /[A-Za-z]{3}/.test(hit[1])) return hit[1];
  }
  return null;
}

/**
 * Broadway press nights (FREEZE_CATEGORIES) whose freeze
 * window contains nowMs. A show with an unusable embargo is skipped and listed in `skipped`, never fatal.
 */
function nightsInWindow(shows, nowMs, embargoAtFn) {
  const nights = [];
  const skipped = [];
  for (const s of shows) {
    if (!s || !FREEZE_CATEGORIES.includes(s.category) || !s.openingDate) continue;
    let at = null;
    try { at = Date.parse(embargoAtFn(s)); } catch { at = NaN; }
    if (!Number.isFinite(at)) { skipped.push(s.id); continue; }
    if (nowMs >= at - FREEZE_BEFORE_MS && nowMs <= at + FREEZE_AFTER_MS) nights.push({ show: s.id, openingDate: s.openingDate, embargoAt: new Date(at).toISOString(), hoursToEmbargo: Math.round(((at - nowMs) / 3600000) * 10) / 10 });
  }
  return { nights, skipped };
}

/**
 * @param {object} a changedFiles (repo-relative, new paths), deletedFiles (paths removed or renamed away), laneFiles
 *   (repo-relative laneCodeFiles() at HEAD), shows (array, or null when shows.json could not be read), nowMs,
 *   commitMessages[], disabled (kill switch), embargoAtFn(show) -> ISO
 * @returns {{status:'clear'|'flagged'|'overridden'|'unknown'|'disabled', reason, files[], nights[], skipped[], override?}}
 */
function evaluateFreeze({ changedFiles = [], deletedFiles = [], laneFiles = [], shows = null, nowMs = Date.now(), commitMessages = [], disabled = false, embargoAtFn }) {
  if (disabled) return { status: 'disabled', reason: 'LANE_FREEZE_DISABLED is set', files: [], nights: [], skipped: [] };
  if (!Number.isFinite(nowMs)) return { status: 'unknown', reason: 'invalid current time', files: [], nights: [], skipped: [] };
  const lane = new Set(laneFiles);
  const files = [...new Set([...changedFiles.filter((f) => lane.has(f)), ...deletedFiles.filter((f) => lane.has(f) || ROOT_DELETE_RE.test(f))])].sort();
  if (!files.length) return { status: 'clear', reason: 'no lane code file changed', files, nights: [], skipped: [] };
  if (!Array.isArray(shows)) return { status: 'unknown', reason: 'shows.json unavailable, so the press-night calendar could not be checked', files, nights: [], skipped: [] };
  const { nights, skipped } = nightsInWindow(shows, nowMs, embargoAtFn);
  if (!nights.length && skipped.length) return { status: 'unknown', reason: `embargo unusable for ${skipped.join(', ')}, so the window could not be fully checked`, files, nights, skipped };
  if (!nights.length) return { status: 'clear', reason: 'no Broadway press night within 48h before to 6h after the embargo', files, nights, skipped };
  const override = findOverride(commitMessages);
  if (override) return { status: 'overridden', reason: 'LANE-FREEZE-BYPASS given', files, nights, skipped, override };
  return { status: 'flagged', reason: 'lane code changed inside the pre-press-night freeze', files, nights, skipped };
}

module.exports = { evaluateFreeze, findOverride, nightsInWindow, FREEZE_BEFORE_MS, FREEZE_AFTER_MS, MIN_REASON, FREEZE_CATEGORIES, BYPASS_RE, ROOT_DELETE_RE };
