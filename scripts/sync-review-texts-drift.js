#!/usr/bin/env node
/**
 * sync-review-texts-drift.js — pre-rebuild half of the stale-checkout race
 * guard (BRO-3161 / BRO-3162), shared by every workflow that runs
 * scripts/rebuild-all-reviews.js via .github/actions/sync-review-texts-drift.
 *
 * The race: a job clones data/review-texts at start, spends minutes scraping
 * or installing deps, then rebuilds reviews.json from that clone. A
 * review-texts push that landed in between is invisible to the rebuild, which
 * exits 0 and silently drops the concurrently-added review.
 *
 * What this does, right before the rebuild:
 *   1. fetch review-texts' upstream tip (explicit +main:refs/remotes/origin/main
 *      refspec so the ref really updates on a shallow clone);
 *   2. if the tip moved since checkout, write the drifted show ids to
 *      --shows-file (consumed by scripts/check-rebuild-staleness.js after the
 *      rebuild) and check out the drifted, still-existing files from the tip;
 *   3. NEVER overwrite a file this job touched itself (untracked, modified in
 *      the working tree/index, or committed locally since checkout) — those
 *      hold the job's own scraped output, which push-review-texts publishes.
 *      Unlike rebuild-reviews.yml's inline guard there is no re-clone retry
 *      for the same reason.
 *
 * FAIL-OPEN: any git error logs a ::warning:: and exits 0 with an empty
 * shows file, so this step can never block a rebuild that ran fine before it.
 *
 * Usage: node scripts/sync-review-texts-drift.js
 *          [--dir=data/review-texts] [--checkout-sha=<sha>]
 *          [--shows-file=/tmp/stale-checkout-shows.txt]
 *   --checkout-sha defaults to the SHA .github/actions/checkout-review-texts
 *   recorded in $RUNNER_TEMP/review-texts-checkout-sha.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { shouldRetryForStaleCheckout } = require('./lib/rebuild-staleness-guard');

const DEFAULT_SHOWS_FILE = '/tmp/stale-checkout-shows.txt';

function checkoutShaFile(env = process.env) {
  return path.join(env.RUNNER_TEMP || '/tmp', 'review-texts-checkout-sha');
}

// A hung fetch must never stall the rebuild (opening-night-poller's fast
// path has a 5-minute budget): every git call is bounded, and a timeout
// throws into main()'s fail-open path.
const GIT_TIMEOUT_MS = 120 * 1000;

function git(dir, args) {
  return execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 256 * 1024 * 1024,
    timeout: GIT_TIMEOUT_MS,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
}

function nulList(out) {
  return out.split('\0').filter(Boolean);
}

/** Show id = first path segment; ignores top-level files. */
function showIdsFromPaths(paths) {
  const ids = new Set();
  for (const p of paths) {
    const i = p.indexOf('/');
    if (i > 0) ids.add(p.slice(0, i));
  }
  return [...ids].sort();
}

/** Drifted files minus every file the job touched itself. Pure. */
function selectFilesToSync(driftedExisting, jobTouched) {
  const touched = new Set(jobTouched);
  return driftedExisting.filter((f) => !touched.has(f));
}

/**
 * Runs the sync. Returns { drifted, showIds, synced, skippedLocal }.
 * Throws on git errors — the CLI wrapper turns that into fail-open.
 */
function syncDrift({ dir, checkoutSha, fetch = true }) {
  if (fetch) {
    git(dir, ['fetch', 'origin', '+main:refs/remotes/origin/main', '--depth=1', '--quiet']);
  }
  const tipSha = git(dir, ['rev-parse', 'refs/remotes/origin/main']).trim();
  if (!shouldRetryForStaleCheckout(checkoutSha, tipSha)) {
    return { drifted: false, checkoutSha, tipSha, showIds: [], synced: [], skippedLocal: [] };
  }
  const changed = nulList(git(dir, ['diff', '-z', '--name-only', checkoutSha, tipSha]));
  const changedExisting = nulList(
    git(dir, ['diff', '-z', '--name-only', '--diff-filter=d', checkoutSha, tipSha]),
  );
  const jobTouched = [
    ...nulList(git(dir, ['diff', '-z', '--name-only', checkoutSha, 'HEAD'])),
    ...nulList(git(dir, ['diff', '-z', '--name-only', 'HEAD'])),
    ...nulList(git(dir, ['ls-files', '-z', '--others', '--exclude-standard'])),
  ];
  const synced = selectFilesToSync(changedExisting, jobTouched);
  const skippedLocal = changedExisting.filter((f) => !synced.includes(f));
  // Batch to stay well under ARG_MAX on a large drift.
  for (let i = 0; i < synced.length; i += 200) {
    git(dir, ['checkout', tipSha, '--', ...synced.slice(i, i + 200)]);
  }
  return { drifted: true, checkoutSha, tipSha, showIds: showIdsFromPaths(changed), synced, skippedLocal };
}

function argValue(argv, name) {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
}

function main(argv = process.argv.slice(2), env = process.env) {
  const dir = argValue(argv, 'dir') || 'data/review-texts';
  const showsFile = argValue(argv, 'shows-file') || DEFAULT_SHOWS_FILE;
  // Always (re)write the shows file first: a stale list from an earlier step
  // in the same job must never reach check-rebuild-staleness.js.
  fs.writeFileSync(showsFile, '');
  let checkoutSha = argValue(argv, 'checkout-sha');
  if (!checkoutSha) {
    try {
      checkoutSha = fs.readFileSync(checkoutShaFile(env), 'utf8').trim();
    } catch {
      checkoutSha = '';
    }
  }
  if (!checkoutSha) {
    console.log('::warning::[sync-review-texts-drift] no checkout-time review-texts SHA recorded — skipping drift sync (fail-open).');
    return 0;
  }
  try {
    const r = syncDrift({ dir, checkoutSha });
    if (!r.drifted) {
      console.log(`[sync-review-texts-drift] review-texts unchanged since checkout (${checkoutSha.slice(0, 10)}).`);
      return 0;
    }
    fs.writeFileSync(showsFile, r.showIds.length ? r.showIds.join('\n') + '\n' : '');
    console.log(
      `⚠️  [sync-review-texts-drift] review-texts advanced during this job ` +
      `(${r.checkoutSha.slice(0, 10)} -> ${r.tipSha.slice(0, 10)}): ${r.showIds.length} show(s) drifted, ` +
      `${r.synced.length} file(s) synced from the tip, ${r.skippedLocal.length} kept because this job wrote them.`,
    );
    return 0;
  } catch (e) {
    const msg = String((e.stderr && e.stderr.toString()) || e.message).split('\n')[0];
    console.log(`::warning::[sync-review-texts-drift] drift sync failed (${msg}) — rebuilding from the checkout as before (fail-open).`);
    try { fs.writeFileSync(showsFile, ''); } catch { /* best-effort */ }
    return 0;
  }
}

if (require.main === module) {
  process.exit(main());
}

module.exports = { syncDrift, selectFilesToSync, showIdsFromPaths, checkoutShaFile, main };
