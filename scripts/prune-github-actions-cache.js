#!/usr/bin/env node
// Prunes old entries of a run-id-keyed GitHub Actions cache down to the
// newest N (BRO-4146). Decision logic lives in scripts/lib/actions-cache-prune.js
// (colocated unit test) — this file is only the gh CLI wiring, so it can be
// reused from any workflow/action that mints a new cache entry every run.
//
// Usage: node scripts/prune-github-actions-cache.js <key-prefix> [--keep=2] [--dry-run]
// Requires: `gh` CLI authenticated with a token carrying `actions: write`
// on this repo (GH_TOKEN/GITHUB_TOKEN env var).
'use strict';

const { execFileSync } = require('node:child_process');
const { selectCacheEntriesToPrune } = require('./lib/actions-cache-prune');

function main() {
  const args = process.argv.slice(2);
  const prefix = args.find((a) => !a.startsWith('--'));
  const keepArg = args.find((a) => a.startsWith('--keep='));
  const keepNewest = keepArg ? Number(keepArg.split('=')[1]) : 2;
  const dryRun = args.includes('--dry-run');

  if (!prefix) {
    console.error('Usage: node scripts/prune-github-actions-cache.js <key-prefix> [--keep=N] [--dry-run]');
    process.exit(1);
  }

  const raw = execFileSync('gh', ['cache', 'list', '--json', 'key,createdAt', '--limit', '100'], {
    encoding: 'utf8',
  });
  const entries = JSON.parse(raw).filter((e) => e.key.startsWith(prefix));
  const toDelete = selectCacheEntriesToPrune(entries, { keepNewest });

  let deleted = 0;
  for (const entry of toDelete) {
    if (dryRun) {
      console.log(`[dry-run] would delete ${entry.key} (createdAt=${entry.createdAt})`);
      continue;
    }
    try {
      execFileSync('gh', ['cache', 'delete', entry.key], { stdio: 'inherit' });
      deleted++;
    } catch (err) {
      console.log(`::warning::cache prune: failed to delete ${entry.key}: ${err.message}`);
    }
  }
  console.log(
    `cache prune: prefix="${prefix}" live=${entries.length} kept=${Math.min(entries.length, keepNewest)} deleted=${dryRun ? 0 : deleted}${dryRun ? ' (dry-run)' : ''}`,
  );
}

main();
