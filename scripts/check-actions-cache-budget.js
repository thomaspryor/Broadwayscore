#!/usr/bin/env node
// Reads live GitHub Actions cache occupancy and reports budget violations
// (BRO-3902). Decision logic: scripts/lib/actions-cache-budget.js.
// Non-blocking by design: exits 0 unless --strict. Needs `gh` + GH_TOKEN.
// Usage: node scripts/check-actions-cache-budget.js [--strict] [--json]
'use strict';

const { execFileSync } = require('node:child_process');
const { auditCacheEntries } = require('./lib/actions-cache-budget');
const { hasHelpFlag } = require('./lib/cli-help.js');

const USAGE = 'Usage: node scripts/check-actions-cache-budget.js [--strict] [--json]';

function main() {
  const args = process.argv.slice(2);
  if (hasHelpFlag(args)) {
    console.log(USAGE);
    return;
  }
  let entries;
  try {
    entries = JSON.parse(
      execFileSync('gh', ['cache', 'list', '--json', 'key,sizeInBytes,createdAt', '--limit', '1000'], {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      }),
    );
  } catch (e) {
    console.log(`- error: gh cache list failed: ${e.message.split('\n')[0]}`);
    process.exit(args.includes('--strict') ? 2 : 0);
  }
  const { totalBytes, violations } = auditCacheEntries(entries);
  if (args.includes('--json')) {
    console.log(JSON.stringify({ entries: entries.length, totalBytes, violations }, null, 2));
  } else {
    console.log(`Actions cache: ${entries.length} entries, ${(totalBytes / 1024 ** 3).toFixed(2)} GiB of 10 GiB`);
    for (const v of violations) console.log(`- ${v.kind}: ${v.message}`);
    if (!violations.length) console.log('OK: within budget');
  }
  if (violations.length && args.includes('--strict')) process.exit(1);
}

main();
