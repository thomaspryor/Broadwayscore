#!/usr/bin/env node
'use strict';
/**
 * rebuild-inclusion-diff.js — run the review rebuild at a base commit and at
 * the working tree (or --head=<sha>) on the same real review texts, and list every show whose
 * included count or per-file exclusion reason differs.
 *
 * scoring-delta.js replays the shared predicates but cannot execute the
 * rebuild's own per-show loop (dedup maps, shields, cycle tiebreaks), so a
 * change there needs a direct before/after run (BRO-5901, BRO-5907).
 *
 * Each show runs in diagnostic mode (`--show=ID`) from a private root whose
 * data/review-texts holds a copy of just that show (every other data/ entry,
 * src and node_modules are links to this checkout). The rebuild finds its
 * data from its own location, so this works for commits older than its
 * REBUILD_REVIEW_TEXTS_DIR override, neither run can normalize files the
 * other reads, and the real review texts are never written.
 *
 * Usage:
 *   node scripts/rebuild-inclusion-diff.js --base=<sha> [--head=<sha>] [--show=ID ...] [--concurrency=N] [--limit=N] [--budget-min=N]
 *
 * From a cloud session (review texts live in a private repo):
 *   node scripts/cloud-run-script.js --review-texts --timeout=55 scripts/rebuild-inclusion-diff.js --base=<sha>
 *
 * Prints file names and exclusion reasons only, never review text.
 * Exit code: 0 when it ran (differences are reported, not failed), 1 on a
 * setup error.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, execFile } = require('child_process');
const { hasHelpFlag } = require('./lib/cli-help.js');

const ROOT = path.resolve(__dirname, '..');
const TEXTS = process.env.REVIEW_TEXTS_DIR || path.join(ROOT, 'data', 'review-texts');

if (hasHelpFlag(process.argv)) {
  console.log('usage: node scripts/rebuild-inclusion-diff.js --base=<sha> [--head=<sha>] [--show=ID ...] [--concurrency=N] [--limit=N] [--budget-min=N]');
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
// Stop starting new shows after this long so the report still prints inside
// cloud-run-script's 55-minute limit; unvisited shows are counted, never guessed.
const BUDGET_MS = (Number(arg('budget-min')) || 45) * 60 * 1000;
// A file with no [EXCLUSION] line was either included or dropped silently
// (exact outlet|critic dedup losers are never logged); the show's included
// count tells the two apart.
const NO_LOG = 'no-exclusion-logged';
const ONLY = process.argv.filter(a => a.startsWith('--show=')).map(a => a.slice(7));

if (!BASE || !/^[0-9a-f]{7,40}$/.test(BASE) || (HEAD && !/^[0-9a-f]{7,40}$/.test(HEAD))) {
  console.error('rebuild-inclusion-diff: --base=<commit sha> is required (and --head, when given, must be a sha)');
  process.exit(1);
}
if (!fs.existsSync(TEXTS)) {
  console.error(`rebuild-inclusion-diff: ${TEXTS} not found (run setup-local-data.sh, or use cloud-run-script.js --review-texts)`);
  process.exit(1);
}

// A commit's scripts/ directory, extracted once.
function extractScripts(sha) {
  try { execFileSync('git', ['cat-file', '-e', `${sha}^{commit}`], { cwd: ROOT, stdio: 'ignore' }); }
  catch { execFileSync('git', ['fetch', '-q', '--depth=1', 'origin', sha], { cwd: ROOT, stdio: 'inherit' }); }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rebuild-commit-'));
  const tar = execFileSync('git', ['archive', sha, 'scripts'], { cwd: ROOT, maxBuffer: 1 << 30 });
  execFileSync('tar', ['-x', '-C', dir], { input: tar });
  return path.join(dir, 'scripts');
}

function runShow(scriptsDir, showId) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'rebuild-show-'));
  for (const entry of fs.readdirSync(ROOT)) {
    if (entry === 'scripts' || entry === 'data' || entry === '.git') continue;
    fs.symlinkSync(path.join(ROOT, entry), path.join(work, entry));
  }
  fs.symlinkSync(scriptsDir, path.join(work, 'scripts'));
  fs.mkdirSync(path.join(work, 'data'));
  for (const entry of fs.readdirSync(path.join(ROOT, 'data'))) {
    if (entry === 'review-texts') continue;
    fs.symlinkSync(path.join(ROOT, 'data', entry), path.join(work, 'data', entry));
  }
  const texts = path.join(work, 'data', 'review-texts');
  fs.cpSync(path.join(TEXTS, showId), path.join(texts, showId), { recursive: true });
  return new Promise((resolve) => {
    // --preserve-symlinks keeps __dirname inside `work`, so ../data is the private copy.
    execFile('node', ['--preserve-symlinks', '--preserve-symlinks-main', path.join(work, 'scripts', 'rebuild-all-reviews.js'), `--show=${showId}`, '--ignore-pause'], {
      cwd: work, maxBuffer: 1 << 28, timeout: 10 * 60 * 1000,
      env: { ...process.env, REBUILD_REVIEW_TEXTS_DIR: texts, REBUILD_EXCLUSION_AUDIT_DIR: path.join(work, 'exclusion-audit') },
    }, (err, stdout) => {
      fs.rmSync(work, { recursive: true, force: true });
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
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

(async () => {
  const shows = (ONLY.length ? ONLY : fs.readdirSync(TEXTS).filter(d => fs.statSync(path.join(TEXTS, d)).isDirectory() && !d.startsWith('.')))
    .sort().slice(0, LIMIT);
  const baseScripts = extractScripts(BASE);
  const headScripts = HEAD ? extractScripts(HEAD) : path.join(ROOT, 'scripts');
  console.log(`[rebuild-inclusion-diff] base ${BASE} vs ${HEAD || 'working tree'}, ${shows.length} show(s), concurrency ${CONCURRENCY}`);

  const t0 = Date.now();
  const rows = await pool(shows, CONCURRENCY, async (showId, i) => {
    if (Date.now() - t0 > BUDGET_MS) return { showId, skipped: true };
    const [before, after] = [await runShow(baseScripts, showId), await runShow(headScripts, showId)];
    if ((i + 1) % 100 === 0) console.log(`[rebuild-inclusion-diff] ${i + 1}/${shows.length} (${Math.round((Date.now() - t0) / 1000)}s)`);
    return { showId, before, after };
  });
  fs.rmSync(path.dirname(baseScripts), { recursive: true, force: true });
  if (HEAD) fs.rmSync(path.dirname(headScripts), { recursive: true, force: true });

  const skipped = rows.filter(r => r.skipped).map(r => r.showId);
  let errors = 0, changedShows = 0, includedDelta = 0;
  const reasonFlips = {};
  for (const { showId, before, after } of rows.filter(r => !r.skipped)) {
    if (before.error || after.error) {
      errors++;
      console.log(`ERROR ${showId}: base=${before.error || 'ok'} head=${after.error || 'ok'}`);
      continue;
    }
    const files = new Set([...Object.keys(before.reasons), ...Object.keys(after.reasons)]);
    const fileDiffs = [...files].sort()
      .filter(f => before.reasons[f] !== after.reasons[f])
      .map(f => `${f}: ${before.reasons[f] || NO_LOG} -> ${after.reasons[f] || NO_LOG}`);
    if (before.included === after.included && !fileDiffs.length) continue;
    changedShows++;
    includedDelta += after.included - before.included;
    console.log(`CHANGED ${showId}: included ${before.included} -> ${after.included}`);
    for (const d of fileDiffs) {
      console.log(`  ${d}`);
      const key = d.slice(d.indexOf(': ') + 2);
      reasonFlips[key] = (reasonFlips[key] || 0) + 1;
    }
  }
  if (skipped.length) console.log(`\nNOT VISITED (time budget): ${skipped.length} show(s), first ${skipped[0]}, last ${skipped[skipped.length - 1]}; rerun with --show=ID for these`);
  console.log(`\n[rebuild-inclusion-diff] shows: ${rows.length - skipped.length}/${rows.length}, changed: ${changedShows}, errors: ${errors}, net included: ${includedDelta >= 0 ? '+' : ''}${includedDelta}`);
  for (const [k, n] of Object.entries(reasonFlips).sort((a, b) => b[1] - a[1])) console.log(`  ${n}  ${k}`);
})().catch((e) => { console.error(e); process.exit(1); });
