/**
 * Pure decision functions for BRO-140's deferred-effect recheck of the
 * session-system overhaul (cards #855/S2 gate fixes, #854/S1 task-store
 * archive). Each function operates on already-parsed transcript JSONL
 * entries (one object per line from ~/.claude/projects/<project>/*.jsonl)
 * so it can be exercised with small fixtures in tests, independent of any
 * real machine's session history.
 *
 * Gate-block events surface as a `type: "system", subtype: "stop_hook_summary"`
 * entry per turn, carrying one `hookErrors[]` string per hook that exited
 * non-zero that turn — NOT as `hook_blocking_error` attachments (those are
 * PostToolUse-only; exit-status-gate.sh/finish-line-gate.sh are Stop hooks).
 * The task-list reminder surfaces as an `attachment.type === "task_reminder"`
 * entry whose `content` array is the full injected task list.
 */

const GATE_HOOK_NAMES = ['exit-status-gate.sh', 'finish-line-gate.sh'];
const GATE_MARKERS = ['EXIT-STATUS GATE', 'FINISH-LINE GATE'];

/** Count exit-status-gate.sh / finish-line-gate.sh block events across one session's parsed transcript entries. */
function countGateBlocks(entries) {
  let count = 0;
  for (const d of entries) {
    if (!d || d.type !== 'system' || d.subtype !== 'stop_hook_summary') continue;
    const errs = Array.isArray(d.hookErrors) ? d.hookErrors : [];
    for (const e of errs) {
      if (typeof e === 'string' && GATE_MARKERS.some((m) => e.includes(m))) count++;
    }
  }
  return count;
}

/**
 * Detect crash indicators (uncaught exceptions / fail-open triggers) from
 * exit-status-gate.sh or finish-line-gate.sh specifically, as opposed to a
 * deliberate GATE-marker block. A crash is a hookErrors entry attributed to
 * one of the two gate hooks that does NOT contain a known gate marker.
 */
function detectGateHookCrashes(entries) {
  const crashes = [];
  for (const d of entries) {
    if (!d || d.type !== 'system' || d.subtype !== 'stop_hook_summary') continue;
    const errs = Array.isArray(d.hookErrors) ? d.hookErrors : [];
    for (const e of errs) {
      if (typeof e !== 'string') continue;
      const fromGateHook = GATE_HOOK_NAMES.some((h) => e.includes(`hooks/${h}`));
      if (!fromGateHook) continue;
      if (GATE_MARKERS.some((m) => e.includes(m))) continue;
      crashes.push(e);
    }
  }
  return crashes;
}

/** Approximate token size (chars/4) of each task_reminder attachment injected into a session's transcript. */
function measureTaskReminderTokenSizes(entries) {
  const sizes = [];
  for (const d of entries) {
    const att = d && d.attachment;
    if (!att || att.type !== 'task_reminder') continue;
    const serialized = JSON.stringify(att.content == null ? '' : att.content);
    sizes.push(Math.ceil(serialized.length / 4));
  }
  return sizes;
}

/** Roll up per-session block counts into a fleet-wide average, matching the audit's "blocks/session" metric. */
function averageBlocksPerSession(perSessionCounts) {
  if (perSessionCounts.length === 0) return 0;
  const total = perSessionCounts.reduce((a, b) => a + b, 0);
  return total / perSessionCounts.length;
}

module.exports = {
  GATE_HOOK_NAMES,
  GATE_MARKERS,
  countGateBlocks,
  detectGateHookCrashes,
  measureTaskReminderTokenSizes,
  averageBlocksPerSession,
};
