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
 * BRO-4064: the owner escalation of 2026-09-20 (BRO-3914) moved every
 * session's OWNER-FACING chat message to plain English — "You can close this
 * tab." / "Keep this tab open." / "Nothing is running here; keep this tab
 * only if…" — with the real `THIS SESSION:` verdict recorded SEPARATELY via
 * `wrapup-block --file` (~/.claude/hooks/lib/wrapup-block.js) rather than
 * printed in the chat text. Headless jobs follow the same instructions, so
 * `res.resultText` (the CLI's final printed message) stopped carrying a
 * `THIS SESSION:` line at all — this function fell through to the default
 * 'stopped-short' for 48 of 61 jobs in 3 days (2026-09-21..23), 3 confirmed
 * to have fully landed. Two changes fix it: (1) below, recognize the 3
 * plain-English closing templates directly, matching only their LEADING
 * phrase (real jobs append a clause, e.g. BRO-3925's actual line was "Keep
 * this tab open until that CI check confirms green.", not the bare
 * template); (2) headless-wrapup-block.js's classifyHeadlessJobResult()
 * prefers the recorded machine block (whose own last line is always
 * canonical `THIS SESSION:` syntax) over `resultText` when a fresh one
 * exists, falling back to this function's plain-English handling otherwise.
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
// BRO-6020: the cloud verdicts (SAFE TO ARCHIVE / KEEP OPEN / ACTION NEEDED
// FROM YOU, verify-edits.sh). Uppercase only, so prose like "Keep open ..." is
// not a verdict. ACTION NEEDED is the owner-only stop, like BLOCKED.
const CLOUD_ACTION_RE = /^\s*[^\w\s]{0,6}\s*ACTION NEEDED FROM YOU\s*[—–:-]*\s*(.*)$/;
const CLOUD_KEEP_OPEN_RE = /^\s*[^\w\s]{0,6}\s*KEEP OPEN\b/;
const CLOUD_CLEAN_RE = /^\s*[^\w\s]{0,6}\s*SAFE TO ARCHIVE\b/;

// BRO-4064: the 3 plain-English closing templates (CLAUDE.md's owner-facing
// verdict rules), matched on their LEADING phrase only — sessions routinely
// append a clause ("Keep this tab open until X confirms.", "...keep this tab
// only if you want to continue <topic>."). No BLOCKED-reason equivalent
// exists in the plain-English form: a pending owner decision maps to "Keep
// this tab open" per CLAUDE.md ("A pending DECISION NEEDED always means KEEP
// OPEN"), which this already classifies as stopped-short — the DECISION
// NEEDED detail itself lives in the chat prose, not in a machine-parseable
// suffix, so it isn't surfaced as a distinct `blocked` outcome here.
const PLAIN_CLOSE_RE = /^\s*[^\w\s]{0,6}\s*you can close this tab\b(?!\s+(?:after|once|when|until|if)\b)/i; // BRO-6314: conditional close is not a finish
const PLAIN_IDLE_RE = /^\s*[^\w\s]{0,6}\s*nothing is running here\b/i;
const PLAIN_KEEP_OPEN_RE = /^\s*[^\w\s]{0,6}\s*keep this tab open\b/i;

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

  const action = CLOUD_ACTION_RE.exec(line);
  if (action) {
    return { outcome: 'blocked', reason: action[1].trim() || 'no reason given' };
  }

  if (KEEP_OPEN_RE.test(line) || CLOUD_KEEP_OPEN_RE.test(line)) {
    return {
      outcome: 'stopped-short',
      reason: 'ended on THIS SESSION: KEEP OPEN (or legacy NOT SAFE TO EXIT) — a headless -p session is never resumed by a background notification',
    };
  }

  if (CLEAN_CLOSE_RE.test(line) || CLOUD_CLEAN_RE.test(line)) {
    return { outcome: 'clean' };
  }

  if (PLAIN_KEEP_OPEN_RE.test(line)) {
    return {
      outcome: 'stopped-short',
      reason: 'ended on plain-English "Keep this tab open" — a headless -p session is never resumed by a background notification',
    };
  }

  if (PLAIN_CLOSE_RE.test(line) || PLAIN_IDLE_RE.test(line)) {
    return { outcome: 'clean' };
  }

  // BRO-6314: sessions fold the closing sentences into one paragraph or put the
  // worktree sentence last ("Nothing is still running. ... You can close this
  // tab and remove the worktree.", "Nothing is running. ... You can remove the
  // worktree, since ..."). None starts the final line with a template, so
  // finished autofix jobs (Paused/In Review with a recheck) were scored
  // job-stopped-short -> card-fail. Conservative on purpose: clean needs a
  // close phrase and NOTHING in the paragraph that says work is pending.
  const tail = lastParagraph(resultText);
  if (PENDING_RE.test(tail)) {
    return {
      outcome: 'stopped-short',
      reason: 'final paragraph says work is pending (keep tab/worktree, decision needed, or a conditional close) — a headless -p session is never resumed by a background notification',
    };
  }
  if (CLOSE_PHRASE_RE.test(tail) || (REMOVE_WORKTREE_RE.test(tail) && NOTHING_RUNNING_RE.test(tail))) {
    return { outcome: 'clean' };
  }

  return { outcome: 'stopped-short', reason: 'no THIS SESSION: status line in final result' };
}

// Final-paragraph phrases (BRO-6314). Any pending signal anywhere in the
// paragraph beats a close phrase: false-clean is the dangerous direction.
const PENDING_RE = new RegExp([
  /\bkeep this tab open\b(?!\s+only if you want\b)/.source,
  /\bdecision needed\b/.source,
  /\baction needed from you\b/.source,
  /\bblocked:/.source,
  // negated close: "Do not assume you can close this tab"
  /\b(?:do not|don't|not)\b[^.;]*\byou can close this tab\b/.source,
  /\byou need to:\s*(?!nothing\b)\S/.source,
  // conditional close: "you can close this tab after/once/when/until/if ..."
  /\b(?:after|once|when|until|if)\b[^.]*\byou can close this tab\b/.source,
  /\byou can close this tab\s+(?:after|once|when|until|if)\b/.source,
].join('|'), 'i');
// BRO-6430: "Keep the worktree, it holds unfinished work." is the item-4b
// worktree sentence, not a keep-the-tab signal (unlanded work is caught
// separately by detectJobLanding -> stranded), so it is no longer PENDING.
// "Keep this tab (open) only if you want to ..." is the IDLE template.
const CLOSE_PHRASE_RE = /\b(?:you can close this tab|nothing is running here|keep this tab (?:open )?only if you want|this session is idle and can be closed)\b(?!\s*,?\s*but\b)/i;
const REMOVE_WORKTREE_RE = /\byou can remove the worktree\b/i;
const NOTHING_RUNNING_RE = /\bnothing is (?:still )?running\b/i;

function lastParagraph(text) {
  const paras = String(text || '').split(/\n\s*\n/).map(p => p.trim()).filter(p => p && !DECORATION_ONLY.test(p));
  return paras.length ? paras[paras.length - 1] : '';
}

module.exports = { classifyHeadlessResult, lastContentLine };
