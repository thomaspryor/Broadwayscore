#!/usr/bin/env node
'use strict';
/**
 * unstage-api-fallback-disqualifiers.js (BRO-6866)
 *
 * collect-review-texts staged `data/audit/ data/collection-state/` in one
 * sweep. Four regenerable diagnostics under data/audit/ (stage-latency.jsonl,
 * url-collision-report.json, validation-baseline.json,
 * validation/collection-report-*.json) are not Git-Data-API-fallback safe, so
 * one of them in the diff disqualified the fallback for the whole commit. On a
 * contended branch the plain push then ran out its deadline and the audit
 * ledgers in the same commit (gemini usage, provider telemetry) were lost.
 *
 * Run after the sweep's `git add`. Unstages every data/audit/ path the
 * fallback disqualifier rejects, so the data commit stays fallback-eligible,
 * and prints the unstaged paths (one per line) on stdout. Those files stay in
 * the working tree: stage-latency goes out through the commit-stage-latency
 * action. The rest (url-collision-report when the auto-fix did not stage it,
 * validation-baseline, collection reports) are regenerable diagnostics and are
 * not committed; the collection report is kept as a workflow artifact.
 *
 * Only data/audit/ is touched. A disqualifier elsewhere stays staged (it is
 * reported on stderr), because dropping core data silently would be worse
 * than a slow push.
 *
 * Usage: node scripts/lib/unstage-api-fallback-disqualifiers.js
 */
const { execFileSync } = require('child_process');
const { disqualifyingPath } = require('./api-fallback-disqualifier-core.js');

const AUDIT_PREFIX = 'data/audit/';

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

/** PURE-ish: which of `paths` are audit paths the fallback rejects. */
function auditDisqualifiedPaths(paths, registry) {
  return paths.filter((p) => p.startsWith(AUDIT_PREFIX) && disqualifyingPath([p], registry));
}

function main() {
  const registry = require('./reconcile-merged-json.js');
  const staged = git(['diff', '--cached', '--name-only', '-z', '--no-renames']).split('\0').filter(Boolean);
  const drop = auditDisqualifiedPaths(staged, registry);
  for (const p of drop) git(['reset', '-q', '--', p]);
  for (const p of drop) console.log(p);
  const rest = disqualifyingPath(staged.filter((p) => !drop.includes(p)), registry);
  if (rest) console.error(`unstage-api-fallback-disqualifiers: still disqualifying (not under ${AUDIT_PREFIX}): ${rest}`);
}

module.exports = { auditDisqualifiedPaths };

if (require.main === module) main();
