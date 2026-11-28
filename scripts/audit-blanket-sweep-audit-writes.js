#!/usr/bin/env node
// BRO-2805: CLI for scripts/lib/audit-blanket-sweep-audit-writes.js — finds
// workflow jobs whose blanket `bash scripts/lib/stage-data-changes.sh` sweep
// would stage an unregistered data/audit/*.json written by an earlier step
// (the BRO-2795 failure shape). Exit 1 on any finding not in the shrink-only
// BASELINE; baselined findings are listed but do not fail.
//   node scripts/audit-blanket-sweep-audit-writes.js [--json]
'use strict';
const { auditAllWorkflows, BASELINE } = require('./lib/audit-blanket-sweep-audit-writes.js');

const findings = auditAllWorkflows();
const key = (f) => `${f.file}|${f.path}`;
const fresh = findings.filter((f) => !BASELINE.has(key(f)));
const seen = new Set(findings.map(key));
const stale = [...BASELINE].filter((k) => !seen.has(k));

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ findings, new: fresh, staleBaseline: stale }, null, 2));
} else {
  console.log(`${findings.length} unregistered data/audit write(s) ahead of a blanket stage-data-changes.sh sweep (${findings.length - fresh.length} baselined, ${fresh.length} new).`);
  for (const f of fresh) {
    console.log(`::error::${f.file} :: ${f.job} / "${f.step}" writes ${f.path} (via ${f.origin}) — the blanket sweep stages it and push-with-retry.sh's Git Data API fallback is vetoed for the whole commit (BRO-2795). Register it in core-data-merge-registry.js (apiFallbackSafe/apiFallbackMerge), stage explicit paths instead, or add "# blanket-sweep-audit-ok: ${f.path} <reason>" to the step.`);
  }
  for (const k of stale) console.log(`::error::stale BASELINE entry (finding is gone, delete it): ${k}`);
}
if (fresh.length || stale.length) process.exitCode = 1;
