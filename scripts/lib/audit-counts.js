'use strict';
/**
 * BRO-6038: shared `--counts=PATH` writer for audits run in shadow mode by
 * data-health-check.yml's shadow-audits job. The file is counts only (no file
 * names, ids, URLs or review text; it lands in the public repo) and always
 * carries `findings`: the number health-check.js's shadowAuditResults compares
 * with the registry max in scripts/lib/shadow-audits.js, or null with
 * `undetermined: true` when the audit could not judge (never a silent pass).
 */
const fs = require('fs');
const path = require('path');

function countsPathFromArgv(argv) {
  const hit = (argv || []).find((a) => String(a).startsWith('--counts='));
  const p = hit ? hit.slice('--counts='.length) : '';
  return p || null;
}

function writeAuditCounts(file, script, counts) {
  const findings = counts && Number.isFinite(counts.findings) ? counts.findings : null;
  const body = { generatedAt: new Date().toISOString(), script, ...counts, findings };
  if (findings === null) body.undetermined = true;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(body, null, 2) + '\n');
  return body;
}

module.exports = { countsPathFromArgv, writeAuditCounts };
