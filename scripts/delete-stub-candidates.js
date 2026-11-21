#!/usr/bin/env node
/**
 * Delete Unknown/empty-critic stub deletion-candidates from the private
 * review-texts repo via the GitHub contents API.
 *
 * Why gh api instead of a local commit: the local data/review-texts clone runs
 * behind origin and other sessions leave uncommitted files in it. A local
 * git rm + push would clobber that work. Deleting through the contents API
 * touches only the named files on origin/main and never rebases the clone.
 *
 * Reads the deletionCandidates list from a triage report (see
 * triage-unknown-critic-stubs.js). For each candidate it re-fetches the file's
 * CURRENT remote sha (so it deletes exactly what's there, and silently skips
 * anything already gone), then issues a DELETE.
 *
 * DRY RUN by default. Pass --execute to actually delete.
 *
 * Usage:
 *   node scripts/delete-stub-candidates.js --report data/audit/unknown-critic-stub-triage.json [--execute]
 *   node scripts/delete-stub-candidates.js --report <r> --reasons aggregatorUrlMismatch,contentless --execute
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function arg(name, def) {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  if (hit) return hit.split('=').slice(1).join('=');
  const idx = process.argv.indexOf(`--${name}`);
  if (idx !== -1 && process.argv[idx + 1] && !process.argv[idx + 1].startsWith('--')) return process.argv[idx + 1];
  return def;
}

const REPO = arg('repo', 'thomaspryor/broadway-review-texts');
const BRANCH = arg('branch', 'main');
const REPORT = path.resolve(arg('report', path.join(__dirname, '..', 'data', 'audit', 'unknown-critic-stub-triage.json')));
const EXECUTE = process.argv.includes('--execute');
const reasonsFilter = (arg('reasons', '') || '').split(',').map(s => s.trim()).filter(Boolean);

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function getSha(filePath) {
  try {
    const out = gh(['api', `repos/${REPO}/contents/${filePath}?ref=${BRANCH}`, '--jq', '.sha']);
    return out.trim();
  } catch (e) {
    const msg = (e.stderr || e.message || '').toString();
    if (msg.includes('404') || msg.includes('Not Found')) return null; // already gone
    throw e;
  }
}

function del(filePath, sha) {
  gh([
    'api', '-X', 'DELETE', `repos/${REPO}/contents/${filePath}`,
    '-f', `message=cleanup: remove contentless/aggregator-mismatch Unknown-critic stub ${filePath}`,
    '-f', `sha=${sha}`,
    '-f', `branch=${BRANCH}`,
  ]);
}

function main() {
  const report = JSON.parse(fs.readFileSync(REPORT, 'utf8'));
  let candidates = report.deletionCandidates || [];
  if (reasonsFilter.length) {
    candidates = candidates.filter(c => c.reasons.some(r => reasonsFilter.includes(r)));
  }
  console.log(`${EXECUTE ? 'DELETING' : 'DRY RUN'} — ${candidates.length} candidate(s) from ${REPO}@${BRANCH}`);
  if (reasonsFilter.length) console.log(`  reason filter: ${reasonsFilter.join(', ')}`);

  let deleted = 0, missing = 0, failed = 0;
  for (const [i, c] of candidates.entries()) {
    const fp = c.file.split(path.sep).join('/');
    const tag = `[${i + 1}/${candidates.length}] ${fp} (${c.reasons.join('+')})`;
    if (!EXECUTE) { console.log(`  would delete ${tag}`); continue; }
    try {
      const sha = getSha(fp);
      if (!sha) { console.log(`  skip (already gone) ${tag}`); missing++; continue; }
      del(fp, sha);
      console.log(`  deleted ${tag}`);
      deleted++;
    } catch (e) {
      console.error(`  FAILED ${tag}: ${(e.stderr || e.message).toString().split('\n')[0]}`);
      failed++;
    }
  }
  if (EXECUTE) console.log(`\nDone: ${deleted} deleted, ${missing} already-gone, ${failed} failed`);
  else console.log(`\nDry run complete. Re-run with --execute to delete.`);
  if (failed) process.exit(1);
}

main();
