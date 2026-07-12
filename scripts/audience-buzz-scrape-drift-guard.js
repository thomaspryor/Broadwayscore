#!/usr/bin/env node
/**
 * CI drift guard for the Reddit sentiment scrape (CLAUDE.md rule 13). Compares
 * the post-scrape data/audience-buzz.json against the pre-scrape backup and
 * fails (under --strict) on CATASTROPHE-floor aggregate drift, so a broken
 * classifier/anchor that mass-drops or mass-shifts scores can't be committed +
 * deployed silently. The workflow's "Restore backup on failure" step then
 * reverts the whole run.
 *
 * Runs AFTER "Recalculate all combined scores", BEFORE "Commit and push".
 *
 * Usage:
 *   node scripts/audience-buzz-scrape-drift-guard.js \
 *     --before=data/audience-buzz.backup.json --after=data/audience-buzz.json --strict
 *   [--audit-out=data/audit/reddit-scrape-drift.json] [--json-only]
 *
 * Exit codes:
 *   0 — healthy, or breach WITHOUT --strict (still emits ::warning::)
 *   1 — cannot run (missing/unreadable files)
 *   2 — catastrophe breach AND --strict
 */

const fs = require('fs');
const path = require('path');
const { computeScrapeDrift } = require('./lib/audience-buzz-drift');

const args = process.argv.slice(2);
const getArg = (name) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : null;
};
const strict = args.includes('--strict');
const jsonOnly = args.includes('--json-only');
const beforePath = getArg('before') || 'data/audience-buzz.backup.json';
const afterPath = getArg('after') || 'data/audience-buzz.json';
const auditOut = getArg('audit-out');

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(path.resolve(p), 'utf-8'));
  } catch (e) {
    console.error(`ERROR: cannot read ${p}: ${e.message}`);
    return null;
  }
}

function main() {
  const before = readJson(beforePath);
  const after = readJson(afterPath);
  if (!before || !after) process.exit(1);

  const result = computeScrapeDrift(before, after);
  const { metrics, breaches, catastrophe } = result;

  if (auditOut) {
    try {
      fs.mkdirSync(path.dirname(path.resolve(auditOut)), { recursive: true });
      fs.writeFileSync(path.resolve(auditOut), JSON.stringify({ ...result }, null, 2));
    } catch (e) {
      console.error(`WARN: could not write audit file ${auditOut}: ${e.message}`);
    }
  }

  if (jsonOnly) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } else {
    console.log('[reddit-scrape-drift]');
    console.log(`  show entries: ${metrics.totalBefore} -> dropped ${metrics.removed} (${(metrics.removedRate * 100).toFixed(1)}%)`);
    console.log(`  active-Reddit shows: ${metrics.redditActiveBefore} -> lost ${metrics.redditLost} (${(metrics.redditLossRate * 100).toFixed(1)}%)`);
    console.log(`  scored shows nulled: ${metrics.combinedNulled}/${metrics.scoredBefore} (${(metrics.combinedNulledRate * 100).toFixed(1)}%)`);
    console.log(`  mean combinedScore drift: ${metrics.meanCombinedDrift}pts over ${metrics.driftN} shows; ${metrics.bucketFlips} designation flips`);
    if (metrics.topDrifts.length) {
      console.log('  top movers:');
      for (const d of metrics.topDrifts.slice(0, 8)) {
        console.log(`    ${d.id}: ${d.before} -> ${d.after} (${d.delta > 0 ? '+' : ''}${d.delta})`);
      }
    }
  }

  if (catastrophe) {
    for (const b of breaches) console.log(`::warning::reddit-scrape-drift catastrophe: ${b}`);
    if (strict) {
      console.error('CATASTROPHE drift under --strict — aborting the scrape run (backup will be restored).');
      process.exit(2);
    }
  } else {
    console.log('  verdict: OK (drift within catastrophe floor)');
  }
  process.exit(0);
}

main();
