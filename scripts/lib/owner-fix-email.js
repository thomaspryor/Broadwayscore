// Who gets the "Fix Applied" owner email from execute-approved-fix.js.
//
// The owner email exists so Tom hears when a READER's bug report (numeric
// GitHub issue, or "504-systematic") got fixed. Cloud sessions also route
// their own private-data fixes through the same workflow with issue ids like
// "bro-4431-f" (CLOUD.md, BRO-4216); those sessions already report in chat
// and Linear, so emailing them too was noise (BRO-4452: five in two days).
// Whitelist the reader shape so any other future id prefix stays silent.

function isReaderFeedbackIssue(issueNumber) {
  return /^\d+(-systematic)?$/.test(String(issueNumber ?? '').trim());
}

function shouldEmailOwnerOnFix({ issueNumber, ownerEmail, appliedCount }) {
  if (!ownerEmail || !(appliedCount > 0)) return false;
  return isReaderFeedbackIssue(issueNumber);
}

module.exports = { isReaderFeedbackIssue, shouldEmailOwnerOnFix };
