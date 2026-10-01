// GitHub issue bodies and comments written by process-feedback.yml's "Create
// Bug Diagnosis Issues" step. thomaspryor/Broadwayscore is a PUBLIC repo, so
// nothing here may carry the reader's name, email or message (BRO-4453). They
// live in the private store (scripts/lib/feedback-submitter-store.js), keyed by
// the submissionId that DIAGNOSIS_JSON carries. Moved out of the workflow YAML
// so tests/unit/feedback-issue-body.test.mjs can prove that.

const { redactDiagnosis, submissionKey, scrubPublicText } = require('./feedback-submitter-store.js');

const PRIVATE_NOTE = '_Reader name, email and message are kept in the private data repo (feedback-submitters.json), keyed by the submission id below._';

// The DIAGNOSIS_JSON payload that goes into the issue. submitterShow stays: it
// is the show the reader picked, which the fixers route on.
function buildPublicDiagnosisPayload({ diagnosis, submission, resolvedShow, showIds }) {
  return redactDiagnosis({
    ...diagnosis,
    showId: (resolvedShow && resolvedShow.id) || showIds[0] || null,
    showSlug: (resolvedShow && resolvedShow.slug) || null,
    showIds,
    submissionId: submissionKey(submission),
    submitterShow: (submission && submission.show) || null,
  });
}

// `reader` is the store entry ({name, email, message}); used only to scrub.
function buildBugDiagnosisBody({ item, submission, diagnosis, payload, showIds, reader }) {
  return scrubPublicText([
    `## Bug Report: ${item.summary}`,
    `**Show:** ${(submission && submission.show) || 'N/A'} | **Priority:** ${item.priority}`,
    PRIVATE_NOTE,
    '',
    `## What's Happening`,
    diagnosis.whatsHappening,
    '',
    `## What I Found`,
    ...(diagnosis.findings || []).map((f) => `- ${f}`),
    '',
    `## Proposed Fix`,
    diagnosis.proposedFix,
    `**Confidence:** ${diagnosis.confidence} | **Type:** ${diagnosis.fixType}`,
    `**Files:** ${(diagnosis.relevantFiles || []).join(', ')}`,
    ...(showIds.length > 1 ? [`**Shows referenced:** ${showIds.join(', ')} (auto-fix will attempt all of them)`] : []),
    '',
    '---',
    `*Auto-diagnosed by feedback pipeline*`,
    '',
    `<!-- DIAGNOSIS_JSON`,
    JSON.stringify(redactDiagnosis(payload)),
    `DIAGNOSIS_JSON -->`,
  ].join('\n'), reader);
}

// Issue titles carry the LLM summary, so they get the same scrub.
function buildIssueTitle(prefix, summary, reader) {
  return scrubPublicText(`${prefix}${String(summary || 'no summary').substring(0, 60)}`, reader);
}

// Content requests and reports whose diagnosis failed.
function buildNeedsReviewBody({ item, submission, contentActions = [], dispatchableCount = 0, isContentRequest, reader }) {
  const willAutoDispatch = isContentRequest && dispatchableCount > 0;
  const id = submissionKey(submission);
  return scrubPublicText([
    willAutoDispatch
      ? `Content-addition request from user feedback — routed to ${dispatchableCount} workflow dispatch(es) below (task #722). No manual action needed unless a dispatch fails.`
      : isContentRequest
      ? `Content-addition request from user feedback — needs data work (add show/reviews), not a code fix.`
      : `Auto-diagnosis failed for this feedback submission — review manually.`,
    '',
    `**Show:** ${(submission && submission.show) || 'N/A'} | **Priority:** ${item.priority || 'unknown'}`,
    `**Summary:** ${item.summary || 'no summary'}`,
    PRIVATE_NOTE,
    ...(id ? [`**Submission id:** \`${id}\``] : []),
    ...(contentActions.length
      ? ['', '**Routing:**', ...contentActions.map((a) =>
          a.workflow
            ? `- \`${a.kind}\` → \`${a.workflow}\` (${JSON.stringify(a.inputs || {})})`
            : `- \`${a.kind}\` — unroutable: ${a.reason || 'no reason given'}`
        )]
      : []),
  ].join('\n'), reader);
}

function buildDuplicateComment({ submission, reason, date = new Date().toISOString().split('T')[0] }) {
  const id = submissionKey(submission);
  return [
    `Another reader reported this on ${date}${id ? ` (submission id \`${id}\`)` : ''}.`,
    '',
    `_Matched as a duplicate (${reason}); folded in here instead of opening a new issue. ${PRIVATE_NOTE.replace(/^_|_$/g, '')}_`,
  ].join('\n');
}

module.exports = {
  buildIssueTitle,
  buildPublicDiagnosisPayload,
  buildBugDiagnosisBody,
  buildNeedsReviewBody,
  buildDuplicateComment,
};
