/**
 * plan-refusal-escalation — what generate-remediation-plan.js does when its
 * LLM planner returns canCreatePlan:false (task #755, owner mandate
 * 2026-08-02: "when generate-remediation-plan refuses on whitelist scope,
 * auto-dispatch a workspace instead of emailing the owner homework").
 *
 * generate-remediation-plan.js runs inside auto-fix-feedback-bug.yml
 * (GitHub Actions) — there is no cmux and no bsc-next on that runner, so it
 * cannot itself spawn a session the way scripts/lib/digest-autofix.js does
 * from the Mac. The CI-side half of "auto-dispatch" is filing a
 * self-contained P1 card via notion-brain.js create; the Mac-side
 * P0/P1-auto-dispatch-at-creation path (CLAUDE.md §6: notion-tasks-sync.js
 * pull -> bsc-next.js --list -> bsc-next.js --id N) picks it up from there —
 * same division of labor as every other "file a card, the standing loop
 * dispatches it" flow in this repo. Pure planner here so the card content is
 * unit-testable without touching the Notion API (CLAUDE.md §15).
 */

'use strict';

function truncate(str, max) {
  const s = String(str || '');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * @param {object} opts
 * @param {object} opts.diagnosis - parsed DIAGNOSIS_JSON from the issue body
 * @param {string} opts.planReason - plan.reason from the LLM's canCreatePlan:false response
 * @param {number|string} opts.issueNumber
 * @param {string} [opts.issueUrl]
 * @returns {{title: string, priority: string, status: string, action: string, notes: string, parkReason: string}}
 */
function buildEscalationCard({ diagnosis = {}, planReason = '', issueNumber, issueUrl } = {}) {
  if (!issueNumber) throw new Error('buildEscalationCard requires issueNumber');

  const who = diagnosis.submitterName && diagnosis.submitterName !== 'Anonymous'
    ? diagnosis.submitterName : 'A reporter';
  const showRef = diagnosis.submitterShow ? ` about ${diagnosis.submitterShow}` : '';
  const titleShow = diagnosis.submitterShow ? truncate(diagnosis.submitterShow, 60) : 'unscoped feedback';
  const title = `Feedback #${issueNumber}: ${titleShow} — auto-fix + plan generator both refused`;

  const problemLines = [
    `${who} reported a bug${showRef} (GitHub issue #${issueNumber}${issueUrl ? `, ${issueUrl}` : ''}).`,
    `auto-fix-feedback-bug.js could not resolve it, and generate-remediation-plan.js's LLM planner also declined to scope a fix: "${truncate(planReason || 'no reason given', 400)}"`,
  ];
  if (diagnosis.summary) problemLines.push(`Diagnosis: ${truncate(diagnosis.summary, 400)}`);

  const notes = [
    '## Problem',
    problemLines.join('\n'),
    '',
    '## Suggested approach',
    `Read the full report on the GitHub issue, investigate the root cause directly (the planner's refusal usually means the fix needs broader repo context, a new script, or a judgment call it isn't scoped for), and land a real fix.`,
    '',
    '## Acceptance criteria',
    `\`gh issue view ${issueNumber} --repo thomaspryor/Broadwayscore\` shows the issue closed with a comment describing what was fixed.`,
    'VERIFY: owner-judgment (the fix itself varies per-issue and has no single re-runnable command; a fresh session judges "closed with a real fix" against the issue thread).',
  ].join('\n');

  // task #1310: escalation runs on a GitHub Actions runner with no cmux/
  // bsc-next — this is always a park, never a dispatch. The Mac-side
  // P0/P1-auto-dispatch-at-creation loop is what actually picks it up.
  const parkReason =
    `CI-side auto-escalation (no cmux/bsc-next on this runner) for feedback #${issueNumber}; ` +
    `the Mac-side P0/P1 auto-dispatch-at-creation loop picks it up on its next pull.`;

  return { title, priority: 'P1', status: 'Not started', action: 'Investigate', notes, parkReason };
}

module.exports = { buildEscalationCard };
