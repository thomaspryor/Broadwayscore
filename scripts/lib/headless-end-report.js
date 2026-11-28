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
 * It is a plain machine comment, NOT a "**Session report (status)**": sweeps read that shape as
 * the worker having reported (zombie sweep 'already-reported', reclaim 'blocked-report' pin), which
 * would stop them recovering exactly these cards. State is left alone, so the card stays
 * re-dispatchable. No owner-hold wording either (pausedHistorySkipReason).
 */

const lsr = require('./linear-session-reporting.js');

const MARKER = lsr.HEADLESS_END_MARKER;

function commentNodes(issue) {
  const c = issue && issue.comments;
  return Array.isArray(c) ? c : ((c && c.nodes) || []);
}

/** True when a worker-authored session report landed at/after the job started. */
function hasReportSince(issue, sinceMs) {
  return commentNodes(issue).some((c) => {
    if (!c) return false;
    // A worker's own report, or a complete PR-EVIDENCE line (a clean Done via linear-brain update).
    if (lsr.parseSessionReportStatus(c.body) == null && !require('./linear-dispatch.js').isCompletePrEvidence(String(c.body || ''))) return false;
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
  // Free text from the worker or CLI: defuse the tokens other gates scan every comment for (verify-gate.js).
  if (res && res.endReason) bits.push(`Reason: ${String(res.endReason).replace(/\s+/g, ' ').replace(/VERIFY:/gi, 'verify -').replace(/DECISION NEEDED/gi, 'decision-needed').slice(0, 300)}`);
  if (res && res.jobId) bits.push(`Job: ${res.jobId}`); // keep on its own line: the dedupe check matches it
  if (res && res.logFile) bits.push(`Log: ${res.logFile}`);
  if (res && res.sessionId) bits.push(`Session: ${res.sessionId}`);
  if (res && res.keptWorktree && res.cwd) bits.push(`Worktree kept for resume: ${res.cwd}`);
  bits.push('Check the branch for unmerged work before redoing it.');
  return bits.join('\n');
}

/**
 * Post the fallback when the worker left no report since `sinceMs`. Best-effort:
 * never throws. Returns 'posted' | 'worker-reported' | 'skipped' | 'error'.
 */
async function postEndReportIfMissing(issue, res, sinceMs, linearClient) {
  // Nothing ran: the job never got a session to report on.
  if (res && (res.stage === 'worktree-error' || res.stage === 'runner-disabled')) return 'skipped';
  try {
    const fresh = (await linearClient.getIssue(issue.identifier)) || issue;
    if (hasReportSince(fresh, sinceMs)) return 'worker-reported';
    // The worker closed the card itself: a clean exit, nothing to flag.
    const stateType = fresh.state && fresh.state.type;
    const closed = stateType === 'completed' || stateType === 'canceled';
    // A done exit, or a kill/failure, on a card someone already closed: nothing to flag. (A short-stopped exit still is.)
    if (closed && (res && res.ok ? res.headlessOutcome === 'done' : true)) return 'worker-reported';
    // One note per job: a replay (or a second caller) must not stack duplicates.
    if (res && res.jobId && commentNodes(fresh).some((c) => c && String(c.body || '').startsWith(MARKER) && String(c.body).includes(`Job: ${res.jobId}\n`) )) return 'worker-reported';
    await linearClient.createComment(issue.id, buildEndSummary(res));
    return 'posted';
  } catch (e) {
    console.error(`[linear-next] WARN could not post end-of-job report on ${issue.identifier}: ${e.message}`);
    return 'error';
  }
}

module.exports = { MARKER, hasReportSince, classifyEnd, buildEndSummary, postEndReportIfMissing };
