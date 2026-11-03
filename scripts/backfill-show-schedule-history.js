#!/usr/bin/env node
/**
 * Backfill data/show-schedule-history.json from the git history of
 * data/show-schedules.json (BRO-6877). Walks every committed version oldest
 * first, merges each into the archive (later snapshots win for the weeks they
 * were live for), then keeps only weeks before the current file's
 * currentMonday. Idempotent: re-running merges the same snapshots again.
 *
 * Two sources:
 *   git (default): needs the history. Cloud clones are shallow and deepening
 *     this repo is very slow, so prefer --snapshots-dir there.
 *   --snapshots-dir=DIR: one file per version, named so a plain sort is
 *     chronological (e.g. "<commit ISO date>_<sha>.json", fetched from
 *     raw.githubusercontent.com for each commit the GitHub commits API lists
 *     for data/show-schedules.json).
 *
 * Usage: node scripts/backfill-show-schedule-history.js [--ref=origin/main | --snapshots-dir=DIR] [--dry-run]
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help.js');
const hist = require('./lib/show-schedule-history.js');

const args = process.argv.slice(2);
if (hasHelpFlag(args)) {
  console.log('Usage: node scripts/backfill-show-schedule-history.js [--ref=origin/main | --snapshots-dir=DIR] [--dry-run]');
  process.exit(0);
}
const ref = (args.find((a) => a.startsWith('--ref=')) || '--ref=HEAD').slice(6);
const dryRun = args.includes('--dry-run');
const snapDirArg = args.find((a) => a.startsWith('--snapshots-dir='));
const snapDir = snapDirArg ? path.resolve(snapDirArg.slice('--snapshots-dir='.length)) : null;
const ROOT = path.resolve(__dirname, '..');
const FILE = 'data/show-schedules.json';

const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });

/** Chronological list of loaders, one per committed version. */
function versions() {
  if (snapDir) {
    const files = fs.readdirSync(snapDir).filter((f) => f.endsWith('.json')).sort();
    console.log(`${files.length} versions of ${FILE} in ${snapDir}`);
    return files.map((f) => () => fs.readFileSync(path.join(snapDir, f), 'utf8'));
  }
  const shas = git('log', '--reverse', '--format=%H', ref, '--', FILE).trim().split('\n').filter(Boolean);
  if (git('rev-parse', '--is-shallow-repository').trim() === 'true') {
    console.warn('warning: shallow clone, the oldest weeks may be missing (use --snapshots-dir, see header)');
  }
  console.log(`${shas.length} versions of ${FILE} in ${ref}`);
  return shas.map((sha) => () => git('show', `${sha}:${FILE}`));
}

const history = hist.loadHistory();
let added = 0, updated = 0, skipped = 0;
for (const read of versions()) {
  let snap;
  try {
    snap = JSON.parse(read());
  } catch {
    skipped++; // deleted or unparseable at that commit
    continue;
  }
  const s = hist.mergeSnapshot(history, snap);
  added += s.added;
  updated += s.updated;
}

const current = JSON.parse(fs.readFileSync(path.join(ROOT, FILE), 'utf8'));
hist.pruneFrom(history, current.currentMonday);
history.lastUpdated = new Date().toISOString();

const weeks = Object.values(history.shows).reduce((n, s) => n + Object.keys(s.weeks).length, 0);
console.log(`merged: +${added} new show-weeks, ${updated} revised, ${skipped} unreadable versions`);
console.log(`archive: ${Object.keys(history.shows).length} shows, ${weeks} show-weeks, ${history.firstWeek} .. before ${history.throughMonday}`);
if (dryRun) {
  console.log('[dry run] not written');
} else {
  hist.writeHistory(history);
  console.log(`wrote ${path.relative(ROOT, hist.HISTORY_PATH)} (${(fs.statSync(hist.HISTORY_PATH).size / 1024).toFixed(0)} KB)`);
}
