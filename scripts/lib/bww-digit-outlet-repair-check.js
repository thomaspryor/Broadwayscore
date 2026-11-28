// BRO-4371: pass/fail rule for scripts/repair-bww-digit-outlets.js, pure so a test can require it.
// Returns a problem string, or null when the report is acceptable.
function evaluateRepairReport(report, { write, expect }) {
  if (!report || !report.archivesScanned) return 'no BWW archives scanned (archive checkout empty?)';
  if (!write) return null;
  const refused = (report.repairs || []).filter(r => r.status !== 'repaired');
  if (refused.length) return `${refused.length} repair(s) not applied (${refused.map(r => r.reason || r.status).join(', ')})`;
  // manualReview also lists unrelated archives (unreadable bodies, missing dirs); only refusals matter here.
  const guardRefused = (report.manualReview || []).filter(m => m.reason === 'write-guard-refused-repair');
  if (guardRefused.length) return `${guardRefused.length} repair(s) refused by the write guard`;
  if (report.writtenFiles !== expect) return `wrote ${report.writtenFiles} file(s), expected ${expect}`;
  return null;
}
module.exports = { evaluateRepairReport };
