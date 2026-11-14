#!/usr/bin/env node
'use strict';
/**
 * rebuild-inclusion-diff.js — run the review rebuild at a base commit and at
 * the working tree (or --head=<sha>) on the same real review texts, and list
 * every show whose included count or per-file exclusion reason differs.
 *
 * scoring-delta.js replays the shared predicates but cannot execute the
 * rebuild's own per-show loop (dedup maps, shields, cycle tiebreaks), so a
 * change there needs a direct before/after run (BRO-5901, BRO-5907).
 *
 * Each show runs in diagnostic mode (`--show=ID`, exits before any aggregate
 * write). A commit's run uses that commit's scripts/ and this checkout's
 * data/, src/ and node_modules (only scripts/ is compared: a change to
 * src/config or data files is not). Diagnostic mode still normalizes the
 * show's own review-text files the way every rebuild does, so run it where
 * that is acceptable: CI through cloud-run-script (discarded), or a local
 * checkout you would rebuild anyway. The exclusion audit and stage-latency
 * logs go to a temp dir, never to data/.
 *
 * Usage:
 *   node scripts/rebuild-inclusion-diff.js --base=<40-char sha> [--head=<40-char sha>] [--show=ID ...] [--concurrency=N] [--limit=N] [--budget-min=N]
 *
 * From a cloud session (review texts live in a private repo):
 *   node scripts/cloud-run-script.js --review-texts --timeout=55 scripts/rebuild-inclusion-diff.js --base=<sha> --head=<sha>
 *
 * Prints file names and exclusion reasons only, never review text. Rows print
 * as each show finishes, so a run killed at a time limit keeps what it found.
 * Exit code: 0 when it ran (differences are reported, not failed), 1 on a
 * setup error.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, execFile } = require('child_process');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { listShowDirs } = require('./lib/list-show-dirs.js');

const ROOT = path.resolve(__dirname, '..');
const TEXTS = path.join(ROOT, 'data', 'review-texts');
const USAGE = 'usage: node scripts/rebuild-inclusion-diff.js --base=<sha> [--head=<sha>] [--show=ID ...] [--concurrency=N] [--limit=N] [--budget-min=N]';

if (hasHelpFlag(process.argv)) {
  console.log(USAGE);
  process.exit(0);
}

const arg = (name) => {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};
const BASE = arg('base');
const HEAD = arg('head');
const CONCURRENCY = Math.max(1, Number(arg('concurrency')) || os.cpus().length);
const LIMIT = Number(arg('limit')) || Infinity;
// Stop starting new shows after this long so the summary still prints inside
// cloud-run-script's 55-minute limit; unvisited shows are counted, never guessed.
const BUDGET_MS = (Number(arg('budget-min')) || 45) * 60 * 1000;
// No log is not proof of inclusion: whole-show skips or a future silent
// exclusion can also omit a per-file line. Exact/prefix dedup losers now
// log skippedDuplicate (BRO-2453); compare included counts as well.
const NO_LOG = 'no-exclusion-logged';
const ONLY = process.argv.filter(a => a.startsWith('--show=')).map(a => a.slice(7));

// Full shas only: a shallow CI checkout can fetch a commit by full sha, never by prefix.
const SHA = /^[0-9a-f]{40}$/;
if (!BASE || !SHA.test(BASE) || (HEAD && !SHA.test(HEAD))) {
  console.error(`rebuild-inclusion-diff: --base (and --head, when given) must be full 40-character shas\n${USAGE}`);
  process.exit(1);
}
if (!fs.existsSync(TEXTS)) {
  console.error(`rebuild-inclusion-diff: ${TEXTS} not found (run setup-local-data.sh, or use cloud-run-script.js --review-texts)`);
  process.exit(1);
}

const tempDirs = [];
const cleanup = () => { for (const d of tempDirs) fs.rmSync(d, { recursive: true, force: true }); };

// A root holding that commit's scripts/ and links to everything else here.
// --preserve-symlinks keeps the rebuild's __dirname inside it, so its
// ../data and ../../src resolve to this checkout.
function commitRoot(sha) {
  try { execFileSync('git', ['cat-file', '-e', `${sha}^{commit}`], { cwd: ROOT, stdio: 'ignore' }); }
  catch { execFileSync('git', ['fetch', '-q', '--depth=1', 'origin', sha], { cwd: ROOT, stdio: 'inherit' }); }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rebuild-commit-'));
  tempDirs.push(dir);
  const tar = execFileSync('git', ['archive', sha, 'scripts'], { cwd: ROOT, maxBuffer: 1 << 30 });
  execFileSync('tar', ['-x', '-C', dir], { input: tar });
  for (const entry of fs.readdirSync(ROOT)) {
    if (entry === 'scripts' || entry === '.git') continue;
    fs.symlinkSync(path.join(ROOT, entry), path.join(dir, entry));
  }
  return dir;
}

function runShow(treeRoot, showId, logDir) {
  return new Promise((resolve) => {
    execFile('node', ['--preserve-symlinks', '--preserve-symlinks-main', path.join(treeRoot, 'scripts', 'rebuild-all-reviews.js'), `--show=${showId}`, '--ignore-pause'], {
      cwd: treeRoot, maxBuffer: 1 << 28, timeout: 10 * 60 * 1000,
      env: {
        ...process.env,
        REBUILD_EXCLUSION_AUDIT_DIR: path.join(logDir, 'show-exclusions'),
        EXCLUSION_LOGGER_AUDIT_DIR: path.join(logDir, 'exclusions'),
        STAGE_LATENCY_LOG: path.join(logDir, 'stage-latency.jsonl'),
      },
    }, (err, stdout) => {
      const m = /(\d+) review\(s\) would be included/.exec(stdout || '');
      const reasons = {};
      for (const line of (stdout || '').split('\n')) {
        const i = line.indexOf('[EXCLUSION] {');
        if (i < 0) continue;
        try { const e = JSON.parse(line.slice(i + 12)); if (e.file) reasons[e.file] = e.reason; } catch { /* partial line */ }
      }
      resolve(m ? { included: Number(m[1]), reasons } : { error: (err && err.message || 'no summary line').split('\n')[0] });
    });
  });
}

async function pool(items, n, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  }));
}

(async () => {
  const shows = (ONLY.length ? ONLY : listShowDirs(TEXTS))
    .sort().slice(0, LIMIT);
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rebuild-diff-logs-'));
  tempDirs.push(logDir);
  const baseRoot = commitRoot(BASE);
  const headRoot = HEAD ? commitRoot(HEAD) : ROOT;
  console.log(`[rebuild-inclusion-diff] base ${BASE} vs ${HEAD || 'working tree'}, ${shows.length} show(s), concurrency ${CONCURRENCY}`);

  const t0 = Date.now();
  let done = 0, errors = 0, changedShows = 0, includedDelta = 0;
  const skipped = [];
  const reasonFlips = {};
  await pool(shows, CONCURRENCY, async (showId) => {
    if (Date.now() - t0 > BUDGET_MS) { skipped.push(showId); return; }
    // Sequential per show: the base run's file normalization happens before the head run reads.
    const before = await runShow(baseRoot, showId, logDir);
    const after = await runShow(headRoot, showId, logDir);
    if (++done % 100 === 0) console.log(`[rebuild-inclusion-diff] ${done}/${shows.length} done (${Math.round((Date.now() - t0) / 1000)}s)`);
    if (before.error || after.error) {
      errors++;
      console.log(`ERROR ${showId}: base=${before.error || 'ok'} head=${after.error || 'ok'}`);
      return;
    }
    const files = new Set([...Object.keys(before.reasons), ...Object.keys(after.reasons)]);
    const fileDiffs = [...files].sort()
      .filter(f => before.reasons[f] !== after.reasons[f])
      .map(f => [f, `${before.reasons[f] || NO_LOG} -> ${after.reasons[f] || NO_LOG}`]);
    if (before.included === after.included && !fileDiffs.length) return;
    changedShows++;
    includedDelta += after.included - before.included;
    console.log([`CHANGED ${showId}: included ${before.included} -> ${after.included}`, ...fileDiffs.map(([f, d]) => `  ${f}: ${d}`)].join('\n'));
    for (const [, d] of fileDiffs) reasonFlips[d] = (reasonFlips[d] || 0) + 1;
  });

  if (skipped.length) console.log(`\nNOT VISITED (time budget): ${skipped.length} show(s), first ${skipped.sort()[0]}, last ${skipped[skipped.length - 1]}; rerun with --show=ID for these`);
  console.log(`\n[rebuild-inclusion-diff] shows: ${done}/${shows.length}, changed: ${changedShows}, errors: ${errors}, net included: ${includedDelta >= 0 ? '+' : ''}${includedDelta}`);
  for (const [k, n] of Object.entries(reasonFlips).sort((a, b) => b[1] - a[1])) console.log(`  ${n}  ${k}`);
  cleanup();
})().catch((e) => { cleanup(); console.error(e); process.exit(1); });
