/**
 * prune-closeable — pure closeability predicate for bsc-prune (card #709).
 *
 * bsc-prune's pruneDone() (scripts/lib/cmux-workspaces.js) has always
 * skipped every ✅-marked workspace with a live claude process — correct for
 * owner-driven tabs (2026-07-21 incident: sweep closed tabs the owner was
 * actively reviewing), but it also means an auto-dispatched (🤖) session
 * that finishes and sits idle at the prompt is NEVER closed autonomously —
 * only a session that fully exits does. Owner mandate 2026-07-31: relax the
 * live-claude skip specifically for 🤖 auto-dispatched ✅ workspaces that are
 * idle at the prompt (not mid-turn). Non-🤖 (owner-driven) ✅ tabs keep the
 * full protection regardless of idle/running state.
 *
 * "Idle at the prompt" vs "mid-turn" reuses cmux-workspaces.js's existing
 * two-state distinction rather than parsing title spinner glyphs:
 *   hasRunningClaude  — tag status === 'Running'          (mid-turn/busy)
 *   hasLiveClaude     — any claude_code process row at all (includes idle-
 *                        at-prompt, where the tag status column is empty)
 * So "idle at the prompt" = hasLiveClaude(tsv) && !hasRunningClaude(tsv).
 * Callers pass that as `isRunning` here; this module has no cmux I/O itself.
 */

const AUTO_GLYPH = '🤖';

// A leading ✅ rename (workspace-mark-done.js: `✅ ${workspaceTitle}`) never
// strips the original title's own 🤖 — it just prepends the checkmark — so
// a plain substring test finds the marker anywhere in the title.
function hasAutoDispatchMarker(title) {
  return String(title || '').includes(AUTO_GLYPH);
}

// hasLiveClaude: whether any claude_code process exists for this workspace
// (false = fully dead — same "closeable regardless of marker" rule prune
// already had). isAutoDispatched: caller-computed hasAutoDispatchMarker(title)
// result — taken as a bool rather than re-deriving from title here, since
// pruneDone already needs that same fact itself (to decide whether it's
// worth spending a cmux call finding out isRunning) and re-parsing the same
// string twice for the same fact invites the two checks drifting apart.
// isRunning: whether the live claude is mid-turn (true) vs idle-at-prompt
// (false) — irrelevant when hasLiveClaude is false, so callers may pass
// anything (or omit it) in that case.
function isCloseable({ hasLiveClaude, isAutoDispatched, isRunning }) {
  if (!hasLiveClaude) return true;
  if (!isAutoDispatched) return false;
  return !isRunning;
}

module.exports = { AUTO_GLYPH, hasAutoDispatchMarker, isCloseable };
