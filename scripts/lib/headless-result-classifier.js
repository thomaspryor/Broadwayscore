'use strict';

/**
 * headless-result-classifier — BRO-3442 (BRO-3424 follow-up): bsc-runner.js
 * journals `job-done` for ANY exit-0 headless job, regardless of what the
 * session's own final turn actually said. Two real shapes both got counted
 * as success:
 *   1. `THIS SESSION: CLOSE ME — BLOCKED: <reason>` — the session hit
 *      something only the owner can resolve and said so honestly, per
 *      ~/.claude/hooks/exit-status-gate.sh's Gate H (2026-09-15). Still
 *      recorded as job-done.
 *   2. No `THIS SESSION:` verdict at all, or `THIS SESSION: KEEP OPEN`
 *      (legacy `NOT SAFE TO EXIT`) — a `claude -p` session is NEVER resumed
 *      by a background notification, so ending a turn this way silently
 *      abandons the work while still reporting job-done (BRO-3388: 2
 *      commits stranded, counted as success).
 *
 * This module is the pure classifier bsc-runner.js calls on `res.resultText`
 * to tell the two apart from a clean `THIS SESSION: CLOSE ME|IDLE` (no
 * BLOCKED reason). It deliberately mirrors exit-status-gate.sh's own Gate H
 * regexes (last non-blank/non-decoration line of the text, `THIS SESSION:
 * (CLOSE ME|IDLE) ... BLOCKED:` / `THIS SESSION: KEEP OPEN` / legacy `NOT
 * SAFE TO EXIT`) so the ledger's verdict and the Stop hook's verdict can
 * never quietly diverge on the same text. It does NOT attempt Gate A's fuller
 * code-fence/blockquote stripping — a headless job's own final result text is
 * not adversarial input the way a quoted example inside a long turn can be,
 * and the added complexity isn't worth it for this call site.
 *
 * Landing (did the work actually reach origin/main) is a SEPARATE, git-I/O
 * concern handled by headless-unlanded-detection.js's detectJobLanding() —
 * this module only classifies the TEXT.
 */

// Decoration-only lines (ASCII rules like ────── framing a SESSION STATUS
// block) don't count as content, same as exit-status-gate.sh's own
// `not re.fullmatch(r'[\W_]+', l.strip())` filter.
const DECORATION_ONLY = /^[\W_]+$/;

function lastContentLine(text) {
  const lines = String(text || '').split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed && !DECORATION_ONLY.test(trimmed)) return line;
  }
  return '';
}

// Same optional emoji/glyph prefix + dash-variant allowance as
// exit-status-gate.sh's STATUS_LINE/HEADLESS_BLOCKED_LINE regexes.
const BLOCKED_RE = /^\s*[^\w\s]{0,6}\s*THIS SESSION\s*:\s*(?:CLOSE ME|IDLE)\s*[—–:-]*\s*BLOCKED:\s*(.*)$/i;
const KEEP_OPEN_RE = /^\s*[^\w\s]{0,6}\s*(?:THIS SESSION\s*:\s*KEEP OPEN|NOT SAFE TO EXIT)\b/i;
const CLEAN_CLOSE_RE = /^\s*[^\w\s]{0,6}\s*THIS SESSION\s*:\s*(?:CLOSE ME|IDLE)\b/i;

/**
 * @param {string} resultText the job's raw final result text (runClaudeCli's
 *   `res.resultText`)
 * @returns {{outcome: 'clean'|'blocked'|'stopped-short', reason?: string}}
 *   `reason` is present for 'blocked' (the text after `BLOCKED:`, falling
 *   back to a placeholder if the session left it empty) and for
 *   'stopped-short' (why this counts as stopped short).
 */
function classifyHeadlessResult(resultText) {
  const line = lastContentLine(resultText);
  if (!line) {
    return { outcome: 'stopped-short', reason: 'no THIS SESSION: status line in final result' };
  }

  const blocked = BLOCKED_RE.exec(line);
  if (blocked) {
    return { outcome: 'blocked', reason: blocked[1].trim() || 'no reason given' };
  }

  if (KEEP_OPEN_RE.test(line)) {
    return {
      outcome: 'stopped-short',
      reason: 'ended on THIS SESSION: KEEP OPEN (or legacy NOT SAFE TO EXIT) — a headless -p session is never resumed by a background notification',
    };
  }

  if (CLEAN_CLOSE_RE.test(line)) {
    return { outcome: 'clean' };
  }

  return { outcome: 'stopped-short', reason: 'no THIS SESSION: status line in final result' };
}

module.exports = { classifyHeadlessResult, lastContentLine };
