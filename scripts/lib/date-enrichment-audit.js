'use strict';
// Shared audit-trail writer for data/audit/date-enrichment-corrections.json
// (schema "date-enrichment-corrections v1"). Used by enrich-west-end-dates.js;
// enrich-off-broadway-dates.js keeps an equivalent inline copy (BRO-3651).
const fs = require('fs');
const path = require('path');

const MAX_RUNS = 50;

function appendAuditRun(auditPath, script, mode, entries, now = new Date()) {
  if (!entries || entries.length === 0) return false;
  let existing = { _meta: { schema: 'date-enrichment-corrections v1' }, runs: [] };
  if (fs.existsSync(auditPath)) {
    try {
      existing = JSON.parse(fs.readFileSync(auditPath, 'utf8'));
      if (!existing || !Array.isArray(existing.runs)) existing = { _meta: { schema: 'date-enrichment-corrections v1' }, runs: [] };
    } catch {
      // corrupt audit: start fresh.
    }
  }
  existing.runs.push({ runAt: now.toISOString(), script, mode, entries });
  if (existing.runs.length > MAX_RUNS) existing.runs = existing.runs.slice(-MAX_RUNS);
  fs.mkdirSync(path.dirname(auditPath), { recursive: true });
  fs.writeFileSync(auditPath, JSON.stringify(existing, null, 2));
  return true;
}

module.exports = { appendAuditRun, MAX_RUNS };
