'use strict';
/**
 * Audit of workflows whose failure alert is severity low (digest only), BRO-6674.
 * A low alert let a real failure sit 2 days (BRO-6666), so every such workflow
 * must either say why a silent 2-day failure is fine, in a comment:
 *
 *   # severity-low-ok: <reason, at least 20 chars>
 *
 * or carry an escalation step: a non-comment `run:` of
 * scripts/file-workflow-failure-card.js on a step with `continue-on-error: true`.
 */
const fs = require('fs');
const path = require('path');

const LOW_RE = /^\s*severity:\s*['"]?low['"]?\s*(#.*)?$/;
const OK_RE = /^\s*#\s*severity-low-ok:\s*(\S.*?)\s*$/;
const ESCALATE_RE = /^\s*(?:-\s*)?run:\s*.*\bfile-workflow-failure-card\.js\b/;
const MIN_REASON = 20;

const lines = (text) => String(text).split('\n');

/** Number of notify-failure style `severity: low` inputs (comments and string literals do not count). */
function countLowSeverity(text) {
  return lines(text).filter((l) => LOW_RE.test(l)).length;
}

/** First documented reason, or null when absent or too short to be a reason. */
function lowSeverityReason(text) {
  for (const l of lines(text)) {
    const m = OK_RE.exec(l);
    if (m && m[1].length >= MIN_REASON) return m[1];
  }
  return null;
}

/** True when a card-filing run line sits in a step that is continue-on-error: true. */
function hasEscalationStep(text) {
  const ls = lines(text);
  for (let i = 0; i < ls.length; i++) {
    if (!ESCALATE_RE.test(ls[i])) continue;
    let start = i;
    while (start > 0 && !/^\s*-\s+\w+:/.test(ls[start]) && !/^\s*-\s+name:/.test(ls[start])) start--;
    // The step opens at the nearest "- key:" line at or above the run line.
    let end = i;
    while (end + 1 < ls.length && !/^\s*-\s+\w+:/.test(ls[end + 1])) end++;
    if (ls.slice(start, end + 1).some((l) => /^\s*(?:-\s*)?continue-on-error:\s*true\s*$/.test(l))) return true;
  }
  return false;
}

/** @returns {{file:string, status:'documented'|'escalated'|'unresolved', reason?:string}[]} for every workflow with a low alert */
function auditWorkflows(dir) {
  const out = [];
  for (const f of fs.readdirSync(dir).filter((n) => /\.ya?ml$/.test(n)).sort()) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    if (!countLowSeverity(text)) continue;
    if (hasEscalationStep(text)) out.push({ file: f, status: 'escalated' });
    else {
      const reason = lowSeverityReason(text);
      out.push(reason ? { file: f, status: 'documented', reason } : { file: f, status: 'unresolved' });
    }
  }
  return out;
}

module.exports = { countLowSeverity, lowSeverityReason, hasEscalationStep, auditWorkflows, MIN_REASON };
