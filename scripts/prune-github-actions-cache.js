#!/usr/bin/env node
// Prunes old entries of a run-id-keyed GitHub Actions cache down to the
// newest N (BRO-4146). Decision logic lives in scripts/lib/actions-cache-prune.js
// (colocated unit test) — this file is only the gh CLI wiring, so it can be
// reused from any workflow/action that mints a new cache entry every run.
//
// Usage: node scripts/prune-github-actions-cache.js <key-prefix> --ref=<ref> [--keep=2] [--dry-run]
// Requires: `gh` CLI authenticated with a token carrying `actions: write`
// on this repo (GH_TOKEN/GITHUB_TOKEN env var).
//
// --ref is REQUIRED, not optional (ship-check correction, BRO-4146): GitHub
// Actions caches are scoped per-ref, and `gh cache list --key <prefix>` with
// no --ref searches ALL refs — a prefix as generic as "nextjs-cache-Linux-"
// collides with vercel-preview.yml's OWN stable-keyed (no run_id) cache on
// the `staging` ref. Without a --ref filter, a frequent cron job on `main`
// could silently delete staging's only cache entry the first time staging's
// entry happens to be older than `main`'s newest N. `gh cache delete` is
// called by numeric id (not by key name) for the same reason: an id is
// globally unique, so there is no ambiguity even if two refs happen to share
// an identical key.
'use strict';

const { execFileSync } = require('node:child_process');
const { selectCacheEntriesToPrune } = require('./lib/actions-cache-prune');
const { hasHelpFlag } = require('./lib/cli-help.js');

const USAGE = 'Usage: node scripts/prune-github-actions-cache.js <key-prefix> --ref=<ref> [--keep=N] [--dry-run]';

function main() {
  const args = process.argv.slice(2);
  // Checked BEFORE any side effect (task #498 pattern) — this script deletes
  // real GitHub Actions caches, so --help must never fall through to gh CLI.
  if (hasHelpFlag(args)) {
    console.log(USAGE);
    return;
  }
  const prefix = args.find((a) => !a.startsWith('--'));
  const keepArg = args.find((a) => a.startsWith('--keep='));
  const keepNewest = keepArg ? Number(keepArg.split('=')[1]) : 2;
  const refArg = args.find((a) => a.startsWith('--ref='));
  const ref = refArg ? refArg.slice('--ref='.length) : '';
  const dryRun = args.includes('--dry-run');

  if (!prefix || !ref) {
    console.error(USAGE);
    process.exit(1);
  }

  // Server-side prefix filter (`-k`/`--key`), not just a local .filter() over
  // an arbitrary page of repo-wide results — `gh cache list`'s default
  // --limit is 30, and even our explicit override was a fixed page size that
  // could silently exclude entries matching `prefix` if enough unrelated
  // caches sorted ahead of them (ship-check correction, BRO-4146). The local
  // filter stays as a safety net since `--key` docs say "prefix (or exact
  // match)", not a documented hard guarantee. `--ref` narrows server-side too
  // (see the header comment for why this is required, not a nicety).
  const raw = execFileSync(
    'gh',
    ['cache', 'list', '--key', prefix, '--ref', ref, '--json', 'id,key,createdAt,ref', '--limit', '1000'],
    { encoding: 'utf8' },
  );
  const entries = JSON.parse(raw).filter((e) => e.key.startsWith(prefix) && e.ref === ref);
  const toDelete = selectCacheEntriesToPrune(entries, { keepNewest });

  let deleted = 0;
  let deleteFailures = 0;
  for (const entry of toDelete) {
    if (dryRun) {
      console.log(`[dry-run] would delete ${entry.key} id=${entry.id} (createdAt=${entry.createdAt})`);
      continue;
    }
    try {
      execFileSync('gh', ['cache', 'delete', String(entry.id)], { stdio: 'inherit' });
      deleted++;
    } catch (err) {
      deleteFailures++;
      console.log(`::warning::cache prune: failed to delete ${entry.key} (id=${entry.id}): ${err.message}`);
    }
  }
  // `kept` reflects entries this run did NOT attempt to delete, not a
  // post-hoc verification that deletion succeeded — deleteFailures (surfaced
  // via the ::warning:: lines above, one per failure) is the actual signal
  // for "prune didn't fully land"; it is not folded into this summary line.
  console.log(
    `cache prune: prefix="${prefix}" live=${entries.length} kept=${Math.min(entries.length, keepNewest)} deleted=${dryRun ? 0 : deleted} failed=${dryRun ? 0 : deleteFailures}${dryRun ? ' (dry-run)' : ''}`,
  );
}

main();
