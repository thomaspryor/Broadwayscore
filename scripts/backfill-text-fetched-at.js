#!/usr/bin/env node
/**
 * backfill-text-fetched-at.js (BRO-4490): stamp textFetchedAt on review files
 * scored on truncated text that have none, so isTruncatedScoreNowComplete can
 * work for them. Rules: scripts/lib/text-fetched-at-backfill.js.
 *
 * Dry run by default. --apply writes through review-write-guard.
 * --git-depth=N  commits per file to walk for the fullText change (default 15;
 *                0 skips git and uses only the record's own timestamps)
 *
 * A shallow review-texts clone (execute-approved-fix.yml checks out depth 1)
 * would date every file at the clone commit (BRO-5652). With git-depth > 0 the
 * script first fetches the full history (`git fetch --unshallow`) and stops
 * without writing if it cannot; creationReached also never trusts a shallow
 * boundary. Holding folders (_superseded-misattributed, _pending) are skipped.
 *
 * Usage:
 *   node scripts/backfill-text-fetched-at.js [--apply] [--git-depth=N] [--show=ID]
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { listShowDirs } = require('./lib/list-show-dirs');
const {
  needsTextFetchedAtBackfill, chooseTextFetchedAt, fullTextChangedAtFromVersions, creationReached, backfillFields,
} = require('./lib/text-fetched-at-backfill');

const USAGE = `backfill-text-fetched-at.js: stamp textFetchedAt on truncated-text-scored review files that lack it.

Usage:
  node scripts/backfill-text-fetched-at.js [--apply] [--git-depth=N] [--show=ID]
  node scripts/backfill-text-fetched-at.js --help, -h    print this usage and exit
`;

const REVIEW_DIR = path.join(__dirname, '..', 'data', 'review-texts');

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
}

function isShallow(repo) {
  try { return git(repo, ['rev-parse', '--is-shallow-repository']).trim() === 'true'; } catch { return false; }
}

// Full history or nothing: returns true when the repo is (now) complete.
function ensureFullHistory(repo) {
  if (!isShallow(repo)) return true;
  console.log('review-texts is a shallow clone; fetching full history (git fetch --unshallow)...');
  try {
    execFileSync('git', ['fetch', '--unshallow', '--quiet'], { cwd: repo, stdio: ['ignore', 'inherit', 'inherit'], timeout: 240000 });
  } catch (e) {
    console.error(`git fetch --unshallow failed: ${e.message}`);
  }
  return !isShallow(repo);
}

function gitFullTextChangedAt(repo, rel, currentText, depth, shallow) {
  if (depth <= 0) return null;
  let log;
  try { log = git(repo, ['log', `-n${depth}`, '--format=%H %cI', '--', rel]).trim(); } catch { return null; }
  if (!log) return null;
  const commits = log.split('\n').map((l) => { const [sha, at] = l.split(' '); return { sha, at }; });
  const versions = [];
  for (const c of commits) {
    let fullText;
    try { fullText = JSON.parse(git(repo, ['show', `${c.sha}:${rel}`])).fullText; } catch { fullText = undefined; }
    versions.push({ at: c.at, fullText });
    if (fullText !== currentText) break;
  }
  let addedCommitFound = false;
  if (!shallow && commits.length < depth && versions.length === commits.length) {
    try { addedCommitFound = !!git(repo, ['log', '--diff-filter=A', '-n1', '--format=%H', '--', rel]).trim(); } catch { /* no history */ }
  }
  const reachedCreation = creationReached({ commitCount: commits.length, depth, versionsRead: versions.length, addedCommitFound, shallow });
  return fullTextChangedAtFromVersions(currentText, versions, { reachedCreation });
}

function main() {
  const args = process.argv.slice(2);
  if (hasHelpFlag(args)) { console.log(USAGE); return; }
  const apply = args.includes('--apply');
  const depthArg = args.find((a) => a.startsWith('--git-depth='));
  const depth = depthArg ? parseInt(depthArg.split('=')[1], 10) : 15;
  const showArg = args.find((a) => a.startsWith('--show='));
  const repo = fs.realpathSync(REVIEW_DIR);
  if (depth > 0 && apply && !ensureFullHistory(repo)) {
    console.error('Refusing to --apply: review-texts history is shallow, so git dates would be clone dates. Rerun with full history or --git-depth=0.');
    process.exitCode = 1;
    return;
  }
  const shallow = depth > 0 && isShallow(repo);
  if (shallow) console.log('note: shallow history (dry run); git dates are not trusted, record timestamps are used instead');
  const dirs = showArg ? [showArg.split('=')[1]].filter((d) => !d.startsWith('_')) : listShowDirs(REVIEW_DIR, { skipHolding: true });
  const counts = { candidates: 0, written: 0, undetermined: 0 };
  const bySource = {};
  for (const dir of dirs) {
    const showDir = path.join(REVIEW_DIR, dir);
    if (!fs.existsSync(showDir)) continue;
    for (const file of fs.readdirSync(showDir)) {
      if (!file.endsWith('.json') || file.startsWith('_')) continue;
      const fp = path.join(showDir, file);
      let data;
      try { data = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { continue; }
      if (!needsTextFetchedAtBackfill(data)) continue;
      counts.candidates++;
      const fullTextChangedAt = gitFullTextChangedAt(repo, `${dir}/${file}`, data.fullText, depth, shallow);
      const choice = chooseTextFetchedAt(data, { fullTextChangedAt });
      if (!choice) { counts.undetermined++; console.log(`undetermined ${dir}/${file}`); continue; }
      bySource[choice.source] = (bySource[choice.source] || 0) + 1;
      console.log(`${apply ? 'write' : 'would write'} ${dir}/${file} textFetchedAt=${choice.value} (${choice.source})`);
      if (apply) {
        // The guard can refuse a write (locked, quarantined, sparse checkout);
        // count only writes that landed so the summary matches the corpus.
        const res = require('./lib/review-write-guard').safeWriteReview(fp, { ...data, ...backfillFields(choice) });
        if (res && res.wrote === false) {
          counts.refused = (counts.refused || 0) + 1;
          console.log(`refused ${dir}/${file} (${res.skipped})`);
        } else counts.written++;
      }
    }
  }
  console.log(`\n${JSON.stringify(counts)} by source ${JSON.stringify(bySource)}${apply ? '' : ' (dry run; --apply to write)'}`);
}

if (require.main === module) main();
