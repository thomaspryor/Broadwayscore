/**
 * Enrich a feedback run report with the outcomes only the workflow step knows.
 *
 * scripts/process-feedback.js writes the report BEFORE anything is dispatched —
 * it can say what it planned, never what landed. process-feedback.yml's
 * issue-creation step is where issue numbers and per-dispatch success/failure
 * become known, and scripts/notify-feedback-outcomes.js turns the merged result
 * into the owner's email.
 *
 * This lives in a module rather than inline in the workflow YAML because the
 * matching below is the part that can silently lie: if a submission fails to
 * match its report entry, the owner is emailed "no action taken" for work that
 * actually succeeded — a quieter version of the exact GH #543 failure this
 * whole report exists to end. Inline YAML cannot be unit tested; this can.
 *
 * Colocated test: tests/unit/feedback-run-report.test.mjs
 */

/**
 * Mirrors submissionId() in scripts/process-feedback.js — keep them identical.
 * The Formspree submissions API returns `_date` (an ISO timestamp), NOT
 * `_id`/`id`/`createdAt`; the fallbacks are future-proofing. These two
 * functions diverging once before caused 15+ duplicate emails to one submitter
 * (2026-06-10), which is why the note is repeated in both places.
 */
function submissionId(sub) {
  return (sub && (sub._id || sub.id || sub.createdAt || sub._date)) || null;
}

/**
 * Find the report entry for a submission, by ID then by exact message text.
 *
 * The message fallback exists because an unmatched entry is worse than useless:
 * the email would report the submission as unhandled while the dispatch it is
 * missing already ran. Returns null when genuinely absent (e.g. a pending
 * diagnosis drained from a PREVIOUS run, whose report is long gone) — callers
 * treat null as "nothing to enrich", never as an error.
 */
function findReportItem(report, submission) {
  if (!report || !Array.isArray(report.items) || !submission) return null;
  const id = submissionId(submission);
  if (id) {
    const byId = report.items.find((i) => i && i.submissionId === id);
    if (byId) return byId;
  }
  if (submission.message) {
    return report.items.find((i) => i && i.message && i.message === submission.message) || null;
  }
  return null;
}

/** Attach the GitHub issue number created for a submission. */
function recordIssue(report, submission, issueNumber) {
  const entry = findReportItem(report, submission);
  if (!entry) return false;
  entry.issueNumber = issueNumber;
  return true;
}

/**
 * Append one dispatch attempt and whether it landed.
 *
 * Failures are recorded, not swallowed: "I tried to run gather-reviews and
 * GitHub rejected it" must reach the owner as loudly as a parked request. The
 * email ranks DISPATCH FAILED above everything else for that reason.
 */
function recordDispatch(report, submission, action, ok, error) {
  const entry = findReportItem(report, submission);
  if (!entry) return false;
  if (!Array.isArray(entry.dispatches)) entry.dispatches = [];
  entry.dispatches.push({
    workflow: (action && action.workflow) || null,
    kind: (action && action.kind) || null,
    inputs: (action && action.inputs) || {},
    ok: Boolean(ok),
    error: error || null,
  });
  return true;
}

module.exports = { submissionId, findReportItem, recordIssue, recordDispatch };
