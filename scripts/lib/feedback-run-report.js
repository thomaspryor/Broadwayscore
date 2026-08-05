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

/**
 * The planner's actions for one pending entry.
 *
 * WHY THIS IS A FUNCTION AND NOT AN INLINE PROPERTY READ (2026-08-05):
 * process-feedback.js pushes `{ item, submission, diagnosis, contentActions }`,
 * so the actions live on the ENTRY. The workflow YAML read
 * `item.contentActions` instead, which is always undefined — so from the day
 * content routing shipped (2026-08-04) it dispatched exactly nothing. Every
 * content request was labelled needs-review and parked, indistinguishable from
 * the pre-routing behaviour it was built to replace. GH #542 died that way, and
 * so did #546, a verbatim resubmission, even though the planner logged
 * "2 action(s) will be dispatched".
 *
 * The shape now lives in one tested place instead of being restated in YAML,
 * where no test could ever reach it. The `item` fallback keeps pending entries
 * written by the old code readable.
 */
function readContentActions(entry) {
  if (!entry) return [];
  if (Array.isArray(entry.contentActions)) return entry.contentActions;
  if (entry.item && Array.isArray(entry.item.contentActions)) return entry.item.contentActions;
  return [];
}

/** Actions that name a workflow, i.e. the ones that can actually be dispatched. */
function dispatchableActions(entry) {
  return readContentActions(entry).filter((a) => a && a.workflow);
}

module.exports = {
  submissionId,
  findReportItem,
  recordIssue,
  recordDispatch,
  readContentActions,
  dispatchableActions,
};
