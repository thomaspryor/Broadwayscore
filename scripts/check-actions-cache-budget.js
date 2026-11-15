#!/usr/bin/env node
// Reads live GitHub Actions cache occupancy and reports budget violations
// (BRO-3902). Decision logic: scripts/lib/actions-cache-budget.js.
// Non-blocking by design: exits 0 unless --strict. Needs `gh` + GH_TOKEN.
// Usage: node scripts/check-actions-cache-budget.js [--strict] [--json]
'use strict';

const { execFileSync } = require('node:child_process');
const { auditCacheEntries, selectEntriesToEvict } = require('./lib/actions-cache-budget');
const { hasHelpFlag } = require('./lib/cli-help.js');

const USAGE = 'Usage: node scripts/check-actions-cache-budget.js [--strict] [--json] [--heal] [--dry-run]';

function main() {
  const args = process.argv.slice(2);
  if (hasHelpFlag(args)) {
    console.log(USAGE);
    return;
  }
  let entries;
  try {
    entries = JSON.parse(
      execFileSync('gh', ['cache', 'list', '--json', 'id,key,ref,sizeInBytes,createdAt,lastAccessedAt', '--limit', '1000'], {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      }),
    );
  } catch (e) {
    console.log(`- error: gh cache list failed: ${e.message.split('\n')[0]}`);
    process.exit(args.includes('--strict') ? 2 : 0);
  }
  const { totalBytes: listedBytes, violations } = auditCacheEntries(entries);
  // The listing is capped at 1000 rows; the usage endpoint is what the probe reads.
  let totalBytes = listedBytes;
  try {
    const u = JSON.parse(execFileSync('gh', ['api', `repos/${process.env.GITHUB_REPOSITORY || 'thomaspryor/Broadwayscore'}/actions/cache/usage`], { encoding: 'utf8' }));
    if (Number.isFinite(Number(u.active_caches_size_in_bytes))) totalBytes = Number(u.active_caches_size_in_bytes);
  } catch { /* fall back to the listed total */ }
  // BRO-7506: --heal evicts rebuildable caches down to the target so GitHub never
  // LRU-wipes the SERP cache. Output lines avoid the leading "- " the workflow warns on.
  if (args.includes('--heal')) {
    const dry = args.includes('--dry-run');
    const evict = selectEntriesToEvict(entries, { totalBytes });
    for (const e of evict) {
      console.log(`heal: ${dry ? 'would evict' : 'evicting'} ${e.key} (${e.ref}, ${(e.sizeInBytes / 1024 ** 2).toFixed(0)} MiB)`);
      if (dry) continue;
      try {
        execFileSync('gh', ['cache', 'delete', String(e.id)], { encoding: 'utf8' });
      } catch (err) {
        console.log(`::warning::could not delete cache ${e.id}: ${err.message.split('\n')[0]}`);
      }
    }
  }
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
