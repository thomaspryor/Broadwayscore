'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const AUDIT = path.join(ROOT, 'scripts/audit-orphan-tests.js');
// BRO-6077: broader wording was advisory under BRO-5937; its existing probes
// now have guards. A date declaration alone does not skip a test.
const RECHECK_PROBE_COMMENT = /RECHECK-AFTER|acceptance[- ]probe/i;
const RECHECK_GUARD = /(?:^|[\s{,])skip\s*:\s*(?!false\b)\S|\.skip\s*\(|^\s*(?:\/\/|\*)?\s*RECHECK-GREEN-TODAY:\s*\S/m;

// A comment block belongs to the next entry in the exemption map.
function neverCiEntriesWithComments(source) {
  const start = source.indexOf('const EXEMPT_NEVER_CI = {');
  if (start < 0) return [];
  const end = source.indexOf('\n};', start);
  const out = [];
  let comment = [];
  for (const line of source.slice(start, end < 0 ? undefined : end).split('\n').slice(1)) {
    const t = line.trim();
    if (t.startsWith('//')) { comment.push(t.replace(/^\/\/\s?/, '')); continue; }
    const m = t.match(/^'([^']+)'\s*:/);
    if (m) { out.push({ file: m[1], comment: comment.join(' ') }); comment = []; }
  }
  return out;
}

function recheckProbeGuardViolations({ root = ROOT, source = fs.readFileSync(AUDIT, 'utf8'), matcher = RECHECK_PROBE_COMMENT } = {}) {
  const violations = [];
  for (const { file, comment } of neverCiEntriesWithComments(source)) {
    if (!matcher.test(comment)) continue;
    let body;
    try { body = fs.readFileSync(path.join(root, file), 'utf8'); } catch { continue; }
    if (!RECHECK_GUARD.test(body)) violations.push(file);
  }
  return violations;
}

module.exports = { neverCiEntriesWithComments, recheckProbeGuardViolations };
