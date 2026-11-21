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
 * self-contained P1 Linear issue (the workflow's 'File dispatchable card' step
 * runs scripts/file-feedback-card.js, BRO-7600; it files with --dispatch);
 * the Mac-side P0/P1 dispatch path (linear-next.js --id BRO-N) picks it up —
 * same division of labor as every other "file a card, the standing loop
 * dispatches it" flow in this repo. Pure planner here so the card content is
 * unit-testable without touching the board API (CLAUDE.md §15).
 *
 * Also files the same kind of card for review submissions that park as
 * needs-manual-review (BRO-7606, scripts/file-review-submission-card.js).
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
// nothing matches, so require the title prefix ourselves. `prefixFor` picks
// the card family (feedback by default; review submissions, BRO-7606).
function isOpenTwin(findOutput, issueNumber, prefixFor = feedbackTitlePrefix) {
  // find prints indented multi-line JSON (linear-brain.js JSON.stringify(.., null, 2)) or `null`.
  const text = String(findOutput || '').trim();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch {
    const start = text.indexOf('{');
    if (start >= 0) { try { parsed = JSON.parse(text.slice(start)); } catch { parsed = null; } }
  }
  return !!(parsed && typeof parsed.title === 'string' && parsed.title.startsWith(prefixFor(issueNumber)));
}

// Shared find-then-create for one GitHub issue's card. Fail-soft: never
// throws, never logs argv (the notes) because the Actions log is public.
// exactTitle: the card family has a fixed title, so look it up by exact title.
// A default find also matches descriptions, and another card quoting
// "Review submission #N:" could sort first and hide the real twin.
function fileCardOnce({ card, issueNumber, prefixFor, source, exactTitle = false }, run) {
  try {
    const found = run(exactTitle ? ['find', card.title, '--exact-title'] : ['find', prefixFor(issueNumber)]);
    if (isOpenTwin(found, issueNumber, prefixFor)) return { filed: false, reused: true, title: card.title };
  } catch { /* fail open: a find error must not stop the card */ }
  try {
    run(['create', card.title, '--priority', '1', '--notes', `${card.notes}\n\n_Filed from CI. Suggested action: ${card.action}._`, '--dispatch', '--source', source]);
  } catch (err) {
    return { filed: false, error: `linear-brain create exited ${err && err.status != null ? err.status : 'unknown'}` };
  }
  return { filed: true, title: card.title };
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
  return fileCardOnce({ card, issueNumber, prefixFor: feedbackTitlePrefix, source: 'workflow:auto-fix-feedback-bug' }, run);
}

// ---------------------------------------------------------------------------
// Review submissions (BRO-7606). process-review-submission.yml labels a reader's
// [Review Submission] issue needs-manual-review when validation cannot decide,
// the approved review never lands, or scraping fails; the sweep in rebuild-fast
// does the same for reviews never scored. Before this nothing filed a card and
// 13 submissions sat parked up to 8 weeks. Same one-card-per-issue contract as
// feedback above. The title is FIXED per issue (no show, no reason) so every
// filer (the workflow steps and the sweep backfill) computes the same title.

function reviewSubmissionTitlePrefix(issueNumber) {
  return `Review submission #${issueNumber}:`;
}

/**
 * @param {object} opts
 * @param {number|string} opts.issueNumber
 * @param {string} [opts.issueUrl]
 * @param {string} [opts.showId] - matched show id, when validation found one
 * @param {string} [opts.reviewUrl] - the submitted (public) review URL
 * @param {string} [opts.reason] - why it parked, from the workflow or sweep
 */
function buildReviewSubmissionCard({ issueNumber, issueUrl, showId = '', reviewUrl = '', reason = '' } = {}) {
  if (!issueNumber) throw new Error('buildReviewSubmissionCard requires issueNumber');
  // Public repo and logs: only the public review URL and show id go on the
  // card, never the submitter's name, email or note (BRO-4453).
  const title = `${reviewSubmissionTitlePrefix(issueNumber)} needs a manual check`;
  const problem = [
    `A reader submitted a review (GitHub issue #${issueNumber}${issueUrl ? `, ${issueUrl}` : ''}) and process-review-submission.yml could not add it on its own, so it is labelled needs-manual-review.`,
    `Why: ${truncate(redactEmails(reason || 'not recorded; read the bot comments on the issue'), 400)}`,
    reviewUrl ? `Review URL: ${truncate(reviewUrl, 300)}` : '',
    showId ? `Matched show: ${showId}` : 'Matched show: none',
  ].filter(Boolean).join('\n');
  const approach = [
    'Read the issue and its bot comments. Typical causes and fixes:',
    '- Show not in data/shows.json: add it (run scripts/validate-show-venue.js first, CLAUDE.md section 3).',
    '- Outlet not in data/outlet-registry.json: register it.',
    '- URL slug gives no show title, or validation erred: identify the show from the article text.',
    'Then ingest the review (ingest-urls / re-dispatch process-review-submission.yml with issue_number and notify=false) and confirm it is live; scripts/sweep-awaiting-score-submissions.js closes the issue once it is. If the submission is not a valid review, close the issue with a reason.',
  ].join('\n');
  const notes = [
    '## Problem', problem, '',
    '## Suggested approach', approach, '',
    '## Acceptance criteria',
    `GitHub issue #${issueNumber} is closed: the review is live on the site, or the issue says why it was rejected.`,
    '',
    `VERIFY: node scripts/check-review-item-resolved.js --issue-closed=${issueNumber}`,
  ].join('\n');
  return { title, priority: 'P1', status: 'Not started', action: 'Investigate', notes };
}

// GitHub label put on a [Review Submission] issue once its card exists, so the
// rebuild-fast sweep skips it without a board call, and a card the owner
// cancelled is not re-filed while the issue stays open.
const CARD_FILED_LABEL = 'linear-card';

// Which open GitHub issues (gh issue list --json number,title,labels) still
// need a review-submission card: parked as needs-manual-review (or
// scraping-failed) and not yet marked CARD_FILED_LABEL.
// settleMs: skip issues touched within this window, so the sweep never races the
// per-issue workflow step that is filing the same card right now (needs updatedAt).
function reviewSubmissionsNeedingCard(issues, { now = Date.now(), settleMs = 0 } = {}) {
  return (issues || []).filter((issue) => {
    if (!String(issue && issue.title).startsWith('[Review Submission]')) return false;
    if (settleMs > 0 && issue.updatedAt && now - Date.parse(issue.updatedAt) < settleMs) return false;
    const names = ((issue && issue.labels) || []).map((l) => (typeof l === 'string' ? l : l && l.name));
    if (names.includes(CARD_FILED_LABEL)) return false;
    return names.includes('needs-manual-review') || names.includes('scraping-failed');
  });
}

function fileReviewSubmissionCard({ issueNumber, issueUrl, showId, reviewUrl, reason }, { run } = {}) {
  const card = buildReviewSubmissionCard({ issueNumber, issueUrl, showId, reviewUrl, reason });
  return fileCardOnce({ card, issueNumber, prefixFor: reviewSubmissionTitlePrefix, source: 'workflow:process-review-submission', exactTitle: true }, run);
}

/**
 * Closes the open card for a review submission once its GitHub issue is closed
 * (the sweep found the review live). Nothing did this before, so every
 * false-parked or later-landed submission (e.g. #1178) left a P1 card open on
 * the board. Moves it to Done through linear-brain, whose Done gate runs the
 * card's own `VERIFY: ... --issue-closed=N` line. Fail-soft: never throws,
 * never logs argv. `run(args)` runs linear-brain.js (injected for tests).
 * @returns {{closed: boolean, identifier?: string, reason?: string}}
 */
function closeReviewSubmissionCard({ issueNumber, note }, { run } = {}) {
  const title = `${reviewSubmissionTitlePrefix(issueNumber)} needs a manual check`;
  let identifier;
  try {
    const out = String(run(['find', title, '--exact-title']) || '').trim();
    const start = out.indexOf('{');
    const parsed = start >= 0 ? JSON.parse(out.slice(start)) : null;
    if (!parsed || parsed.title !== title || !/^BRO-\d+$/.test(String(parsed.identifier))) return { closed: false, reason: 'no open card' };
    identifier = parsed.identifier;
  } catch { return { closed: false, reason: 'find failed' }; }
  try {
    run(['update', identifier, '--state', 'Done', '--comment', note || `GitHub issue #${issueNumber} was closed because the review is live on the site.`]);
  } catch (err) {
    return { closed: false, identifier, reason: `update exited ${err && err.status != null ? err.status : 'unknown'}` };
  }
  return { closed: true, identifier };
}

module.exports = {
  closeReviewSubmissionCard,
  buildEscalationCard, feedbackTitlePrefix, isOpenTwin, fileFeedbackCard,
  buildReviewSubmissionCard, reviewSubmissionTitlePrefix, fileReviewSubmissionCard,
  reviewSubmissionsNeedingCard, CARD_FILED_LABEL,
};
