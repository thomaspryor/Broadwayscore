#!/usr/bin/env node
'use strict';
/**
 * check-never-audited-backlog.js (BRO-6794): read-only acceptance probe for the
 * back-catalogue drain. The hourly gap audit records, per run, how many due shows
 * it had never audited (staleness.neverAuditedDueAtStart in
 * data/audit/show-review-gap.json). Exit 0 when that count is <= --max, 1 when above,
 * 2 on bad arguments or unreadable data.
 *   node scripts/check-never-audited-backlog.js --max=100
 */
const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help.js');

function checkBacklog(gap, max) {
  const n = gap && gap.staleness && gap.staleness.neverAuditedDueAtStart;
  if (!Number.isFinite(n)) throw new Error('staleness.neverAuditedDueAtStart missing from gap audit');
  return { count: n, ok: n <= max, at: gap.staleness.at || null };
}

function main(args = process.argv.slice(2), root = path.join(__dirname, '..')) {
  if (hasHelpFlag(args)) { console.log('Usage: node scripts/check-never-audited-backlog.js --max=N'); return 0; }
  const m = /^--max=(\d+)$/.exec(args.join(' '));
  if (!m) { console.error('Expected --max=N'); return 2; }
  try {
    const gap = JSON.parse(fs.readFileSync(path.join(root, 'data/audit/show-review-gap.json'), 'utf8'));
    const r = checkBacklog(gap, Number(m[1]));
    console.log(`${r.ok ? 'PASS' : 'FAIL'} never-audited due shows ${r.count} (limit ${m[1]}, run ${r.at})`);
    return r.ok ? 0 : 1;
  } catch (e) { console.error(e.message); return 2; }
}

if (require.main === module) process.exitCode = main();
module.exports = { checkBacklog, main };
