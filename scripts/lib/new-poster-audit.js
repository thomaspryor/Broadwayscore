/**
 * Pure helpers for scripts/audit-new-show-posters.js (BRO-5331).
 * The fetch workflow leaves new or replaced thumbnails in the working tree;
 * those are the shows whose art has never been vision-audited.
 */

// `git status --porcelain` text -> unique show ids whose thumbnail changed.
function changedThumbnailShowIds(porcelain) {
  const ids = [];
  for (const line of String(porcelain || '').split('\n')) {
    const m = line.match(/public\/images\/shows\/([^/\s]+)\/thumbnail\.[a-z]+/i);
    if (m && !ids.includes(m[1])) ids.push(m[1]);
  }
  return ids;
}

// audit-images-llm.js prints one `IMAGE_AUDIT_RESULT {json}` line per --show run.
function parseAuditResult(stdout) {
  const m = String(stdout || '').match(/^IMAGE_AUDIT_RESULT (\{.*\})\s*$/m);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

// Only audit with a script that can run without rewriting image-verification.json.
function supportsNoWrite(auditSource) {
  return /--no-write/.test(String(auditSource || ''));
}

// A transient model/API failure is not a verdict worth reporting.
function isReportableVerdict(r) {
  return !!r && r.action === 'delete';
}

module.exports = { changedThumbnailShowIds, parseAuditResult, supportsNoWrite, isReportableVerdict };
