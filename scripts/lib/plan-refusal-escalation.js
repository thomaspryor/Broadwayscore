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
 * self-contained P1 Linear issue (generate-remediation-plan.js files it via
 * linear-brain.js create; notion-brain.js create has exited 6 since BRO-377);
 * the Mac-side P0/P1 dispatch path (linear-next.js --id BRO-N) picks it up —
 * same division of labor as every other "file a card, the standing loop
 * dispatches it" flow in this repo. Pure planner here so the card content is
 * unit-testable without touching the board API (CLAUDE.md §15).
 */

'use strict';

const { redactEmails } = require('./pii-scan.js');

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
/**
 * @param {object} opts
 * @param {object} opts.diagnosis - parsed DIAGNOSIS_JSON from the issue body
 * @param {string} [opts.planReason] - plan.reason when the planner refused
 * @param {'refused'|'created'|'none'} [opts.planState] - what the plan step did (BRO-7600)
 * @param {number|string} opts.issueNumber
 * @param {string} [opts.issueUrl]
 */
function buildEscalationCard({ diagnosis = {}, planReason = '', planState = 'refused', issueNumber, issueUrl } = {}) {
  if (!issueNumber) throw new Error('buildEscalationCard requires issueNumber');

  // The repo is public and so are Actions logs: never put the reader's name,
  // email or message on the card (BRO-7600; BRO-4453 keeps them private).
  const showRef = diagnosis.submitterShow ? ` about ${diagnosis.submitterShow}` : '';
  const titleShow = diagnosis.submitterShow ? truncate(diagnosis.submitterShow, 60) : 'unscoped feedback';
  // One title shape for every path, so linear-brain's exact-title reuse covers re-runs.
  const title = `${feedbackTitlePrefix(issueNumber)} ${titleShow}`;

  const stateLine = {
    refused: `auto-fix could not resolve it, and the plan generator declined to scope a fix: "${truncate(planReason || 'no reason given', 400)}"`,
    created: `auto-fix could not resolve it. The plan generator wrote a pending plan (data/pending-fixes/ for this issue) and emailed the owner an approve/reject link. Nobody is guaranteed to click it.`,
    none: `auto-fix could not resolve it (skipped, validation failed, or errored) and no plan was written.`,
  }[planState] || '';
  const problemLines = [
    `A reader reported a bug${showRef} (GitHub issue #${issueNumber}${issueUrl ? `, ${issueUrl}` : ''}).`,
    stateLine,
  ];
  if (diagnosis.summary) problemLines.push(`Diagnosis: ${truncate(redactEmails(diagnosis.summary), 400)}`);

  const approach = planState === 'created'
    ? `Read the issue and its diagnosis, check it against live data, then fix it. If a pending plan for this issue exists and is right, apply it (execute-approved-fix.yml) or mark it superseded first; never edit the same data twice. Data fixes go through scripts/new-fix-plan.js (.claude/CLOUD.md "Fixing private data"). If the report is already fixed or not a bug, close the issue with a reason.`
    : `Read the issue and its diagnosis, check it against live data, investigate the root cause directly (the refusal usually means the fix needs broader repo context or a new script), and land a real fix. Data fixes go through scripts/new-fix-plan.js (.claude/CLOUD.md "Fixing private data"). If the report is already fixed or not a bug, close the issue with a reason.`;

  const notes = [
    '## Problem',
    problemLines.filter(Boolean).join('\n'),
    '',
    '## Suggested approach',
    approach,
    '',
    '## Acceptance criteria',
    `GitHub issue #${issueNumber} is closed with a comment describing what was fixed or why it was closed.`,
    '',
    `VERIFY: node scripts/check-review-item-resolved.js --issue-closed=${issueNumber}`,
  ].join('\n');

  return { title, priority: 'P1', status: 'Not started', action: 'Investigate', notes };
}

function feedbackTitlePrefix(issueNumber) {
  return `Feedback #${issueNumber}:`;
}

// Does this `linear-brain find` JSON output name an open card for the issue?
// find matches the term in title OR description and prints `null` when
// nothing matches, so require the title prefix ourselves.
function isOpenTwin(findOutput, issueNumber) {
  let parsed;
  try { parsed = JSON.parse(String(findOutput || '').trim().split('\n').filter((l) => l.startsWith('{') || l === 'null').pop() || 'null'); } catch { return false; }
  return !!(parsed && typeof parsed.title === 'string' && parsed.title.startsWith(feedbackTitlePrefix(issueNumber)));
}

/**
 * Files (or reuses) the dispatchable card for one needs-manual-review issue.
 * `run(args)` runs linear-brain.js with those args and returns stdout; it is
 * injected so tests never touch the board. Fail-soft: never throws, never
 * logs argv (the notes) because the Actions log is public.
 * @returns {{filed: boolean, reused?: boolean, title?: string, error?: string}}
 */
function fileFeedbackCard({ diagnosis, planReason, planState, issueNumber, issueUrl }, { run } = {}) {
  const card = buildEscalationCard({ diagnosis, planReason, planState, issueNumber, issueUrl });
  try {
    const found = run(['find', feedbackTitlePrefix(issueNumber)]);
    if (isOpenTwin(found, issueNumber)) return { filed: false, reused: true, title: card.title };
  } catch { /* fail open: a find error must not stop the card */ }
  try {
    run(['create', card.title, '--priority', '1', '--notes', `${card.notes}\n\n_Filed from CI. Suggested action: ${card.action}._`, '--dispatch', '--source', 'workflow:auto-fix-feedback-bug']);
  } catch (err) {
    return { filed: false, error: `linear-brain create exited ${err && err.status != null ? err.status : 'unknown'}` };
  }
  return { filed: true, title: card.title };
}

module.exports = { buildEscalationCard, feedbackTitlePrefix, isOpenTwin, fileFeedbackCard };
