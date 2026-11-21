'use strict';

/** Turn the read-only drift audit's JSON into a row in the daily snapshot. */
function approvedFixDriftResults(run) {
  const name = 'Data: approved-fix drift';
  let report;
  try { report = JSON.parse(run?.output); } catch { /* warn below */ }
  if (run?.status !== 0 || !Number.isInteger(report?.unexplainedCount)
      || report.unexplainedCount < 0 || !(report.scannedWithApprovedFixes > 0)) {
    return [{ name, status: 'warn', message: 'Approved-fix drift audit did not produce a complete readable result',
      hint: 'Run node scripts/audit-approved-fix-drift.js --json with the review-texts checkout available.' }];
  }
  return [{ name, status: report.unexplainedCount > 0 ? 'warn' : 'pass',
    message: `${report.unexplainedCount} unexplained approved-fix drift(s) across ${report.scannedWithApprovedFixes} files with approvals`,
    ...(report.unexplainedCount > 0 ? { hint: 'node scripts/audit-approved-fix-drift.js --strict lists the erased approvals; restore them with a pending-fix plan and fix the writer.' } : {}),
  }];
}

module.exports = { approvedFixDriftResults };
