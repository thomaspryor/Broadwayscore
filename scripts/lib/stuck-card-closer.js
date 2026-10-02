/**
 * stuck-card-closer — decide which open cards can be closed because their
 * own check already passes on main (BRO-4523).
 *
 * WHY: the daily done-evidence audit (scripts/audit-done-evidence.js) labels
 * open P0/P1 cards STUCK when the card's own VERIFY command passes on main.
 * 53 cards carried that label on 2026-10-02, 22 of them In Review for up to
 * five weeks. Nothing acted on the label: workers report "in-review" and
 * stop, and the only other closer (the started-zombie sweep, BRO-4510) runs
 * on the Mac and only looks at cards whose dispatch job ended without a
 * report. A card that reported back, or was started from an interactive
 * session, was never revisited.
 *
 * WHY THESE RULES (a passing test alone is not proof the card's work landed;
 * a test that existed before the card was filed passes vacuously):
 *   - the command must be exactly `node --test <one test file>`, and no other
 *     audited card may share it, so the test is this card's own;
 *   - a commit on main whose message names the card must have touched that
 *     test file after the card was created, so the work demonstrably landed;
 *   - the card must be idle (24h In Review, 72h In Progress) so a live
 *     worker is never pre-empted;
 *   - a RECHECK-AFTER date still in the future means the author asked for
 *     the effect to be observed later, so the card is left alone.
 * The close itself goes through linear-brain.js's Done gate, which re-runs
 * the command on a fresh origin/main checkout: two independent verifications.
 *
 * Pure functions only. The CLI is scripts/close-stuck-verified-cards.js.
 */

'use strict';

const HOUR_MS = 60 * 60 * 1000;
const MAX_REPORT_AGE_MS = 6 * HOUR_MS;
const IDLE_MS_BY_STATE = { 'In Review': 24 * HOUR_MS, 'In Progress': 72 * HOUR_MS };
const CARD_TEST_RE = /^node --test (\S+\.test\.(?:mjs|cjs|js))$/;
const RECHECK_AFTER_RE = /RECHECK-AFTER:\s*(\d{4}-\d{2}-\d{2})/g;
const CLOSER_MARKER = 'AUTO-CLOSED by stuck-card-closer';

function cardTestPath(cmd) {
  const m = CARD_TEST_RE.exec(String(cmd || '').trim());
  return m ? m[1] : null;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// "BRO-71" must not match "BRO-710" or "XBRO-71".
function mentionsCard(message, identifier) {
  if (!message || !identifier) return false;
  return new RegExp(`(?<![A-Za-z0-9-])${escapeRe(identifier)}(?![0-9])`).test(message);
}

/**
 * Pick candidates from a done-evidence audit report.
 * Returns { error } when the report is too old to trust, else
 * { candidates: [{ id, state, cmd, testPath }], skipped: { reason: count } }.
 */
function planCandidates(report, nowMs) {
  const generatedMs = Date.parse(report && report.generatedAt);
  if (!Number.isFinite(generatedMs)) return { error: 'audit report has no generatedAt' };
  if (nowMs - generatedMs > MAX_REPORT_AGE_MS) {
    return { error: `audit report is ${Math.round((nowMs - generatedMs) / HOUR_MS)}h old (max ${MAX_REPORT_AGE_MS / HOUR_MS}h)` };
  }
  const results = Array.isArray(report.results) ? report.results : [];
  const cmdUse = new Map();
  for (const r of results) {
    if (r && r.cmd) cmdUse.set(r.cmd, (cmdUse.get(r.cmd) || 0) + 1);
  }
  const candidates = [];
  const skipped = {};
  const skip = (reason) => { skipped[reason] = (skipped[reason] || 0) + 1; };
  for (const r of results) {
    if (!r || r.verdict !== 'STUCK') continue;
    if (!IDLE_MS_BY_STATE[r.state]) { skip(`state-${r.state}`); continue; }
    if (!Array.isArray(r.channels) || !r.channels.includes('verify-command')) { skip('no-verify-command'); continue; }
    const testPath = cardTestPath(r.cmd);
    if (!testPath) { skip('command-not-a-single-test-file'); continue; }
    if (cmdUse.get(r.cmd) > 1) { skip('command-shared-with-another-card'); continue; }
    candidates.push({ id: r.id, state: r.state, cmd: r.cmd, testPath });
  }
  return { candidates, skipped };
}

function futureRecheckAfter(texts, nowMs) {
  for (const t of texts) {
    for (const m of String(t || '').matchAll(RECHECK_AFTER_RE)) {
      // The date is checkable from the start of that UTC day.
      if (Date.parse(`${m[1]}T00:00:00Z`) > nowMs) return m[1];
    }
  }
  return null;
}

/**
 * Decide one candidate against the live issue and the commits that touched
 * its test file since the card was created.
 *   issue:   { state: { name, type }, createdAt, updatedAt, description, comments: [{ body, createdAt }] }
 *   commits: [{ sha, message }]
 * Returns { close: true, sha } or { close: false, reason }.
 */
function decideClosure({ candidate, issue, commits, nowMs }) {
  if (!issue) return { close: false, reason: 'issue-not-found' };
  const stateName = issue.state && issue.state.name;
  if (stateName !== candidate.state) return { close: false, reason: 'state-changed-since-audit' };
  const comments = Array.isArray(issue.comments) ? issue.comments : [];
  if (comments.some((c) => String(c.body || '').includes(CLOSER_MARKER))) {
    return { close: false, reason: 'closer-already-tried' };
  }
  const lastActivity = Math.max(
    Date.parse(issue.updatedAt) || 0,
    ...comments.map((c) => Date.parse(c.createdAt) || 0),
  );
  if (nowMs - lastActivity < IDLE_MS_BY_STATE[candidate.state]) return { close: false, reason: 'recent-activity' };
  if (futureRecheckAfter([issue.description, ...comments.map((c) => c.body)], nowMs)) {
    return { close: false, reason: 'recheck-after-pending' };
  }
  const own = (commits || []).find((c) => mentionsCard(c.message, candidate.id));
  if (!own) return { close: false, reason: 'no-commit-naming-card-touched-test' };
  return { close: true, sha: own.sha };
}

function buildClosureComment({ candidate, sha, auditGeneratedAt }) {
  return [
    `${CLOSER_MARKER}.`,
    '',
    `This card's own check, \`${candidate.cmd}\`, passed on main in the done-evidence audit of ${auditGeneratedAt}.`,
    `Commit ${String(sha).slice(0, 12)} names this card and changed ${candidate.testPath} after the card was filed, so the work landed.`,
    'The Done gate re-ran the check on a fresh copy of main before this close.',
    'If the problem is still happening, reopen the card and say what you saw.',
  ].join('\n');
}

module.exports = {
  MAX_REPORT_AGE_MS,
  IDLE_MS_BY_STATE,
  CLOSER_MARKER,
  cardTestPath,
  mentionsCard,
  planCandidates,
  futureRecheckAfter,
  decideClosure,
  buildClosureComment,
};
