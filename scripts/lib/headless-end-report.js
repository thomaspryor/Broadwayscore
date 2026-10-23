'use strict';

/**
 * headless-end-report: BRO-6092. A headless Linear worker that ends without its own
 * `linear-session.js report` (stopped-short, stranded, killed at the time limit, clean
 * exit with no report) used to leave the card with nothing after "Dispatched", or with
 * no comment at all when the job failed (linear-next.js returned before the receipt).
 * Ledger, 2026-10-16..23: 162 cards, 47 ended stopped-short, 15 stranded, 11 killed at
 * 7200000ms, 86 job-done against 31 Done. bsc-runner knows how each job ended; the
 * card did not. linear-next.js now posts this fallback report when the worker did not.
 *
 * Status is always `blocked`: it posts the comment and leaves state alone, so the card
 * stays re-dispatchable. The text avoids owner-hold wording on purpose, so
 * pausedHistorySkipReason / reclaim never read it as "waiting on the owner".
 */

const lsr = require('./linear-session-reporting.js');

const MARKER = 'Headless worker ended without its own session report';

function commentNodes(issue) {
  const c = issue && issue.comments;
  return Array.isArray(c) ? c : ((c && c.nodes) || []);
}

/** True when a worker-authored session report landed at/after the job started. */
function hasReportSince(issue, sinceMs) {
  return commentNodes(issue).some((c) => {
    if (!c || lsr.parseSessionReportStatus(c.body) == null) return false;
    if (String(c.body).includes(MARKER)) return false; // our own fallback is not the worker's
    const t = Date.parse(c.createdAt);
    return Number.isFinite(t) && t >= sinceMs;
  });
}

/** Class of ending, for the comment and for counting later. */
function classifyEnd(res) {
  if (!res) return 'unknown';
  if (!res.ok) return res.stage === 'timeout' ? 'killed-timeout' : `failed-${res.stage || 'unknown'}`;
  return res.headlessOutcome || 'unknown';
}

function buildEndSummary(res) {
  const cls = classifyEnd(res);
  const bits = [`${MARKER} (${cls}).`];
  if (res && res.endReason) bits.push(`Reason: ${String(res.endReason).replace(/\s+/g, ' ').slice(0, 300)}`);
  if (res && res.jobId) bits.push(`Job: ${res.jobId}`);
  if (res && res.logFile) bits.push(`Log: ${res.logFile}`);
  if (res && res.sessionId) bits.push(`Session: ${res.sessionId}`);
  if (res && res.keptWorktree && res.cwd) bits.push(`Worktree kept for resume: ${res.cwd}`);
  bits.push('Check the branch for unmerged work before redoing it.');
  return bits.join('\n');
}

/**
 * Post the fallback when the worker left no report since `sinceMs`. Best-effort:
 * never throws. Returns 'posted' | 'worker-reported' | 'error'.
 */
async function postEndReportIfMissing(issue, res, sinceMs, linearClient) {
  try {
    const fresh = (await linearClient.getIssue(issue.identifier)) || issue;
    if (hasReportSince(fresh, sinceMs)) return 'worker-reported';
    await linearClient.createComment(issue.id, lsr.buildOutcomeCommentBody({
      summary: buildEndSummary(res), status: 'blocked',
    }));
    return 'posted';
  } catch (e) {
    console.error(`[linear-next] WARN could not post end-of-job report on ${issue.identifier}: ${e.message}`);
    return 'error';
  }
}

module.exports = { MARKER, hasReportSince, classifyEnd, buildEndSummary, postEndReportIfMissing };
