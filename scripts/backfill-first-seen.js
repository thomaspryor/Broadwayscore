#!/usr/bin/env node
'use strict';

/**
 * backfill-first-seen.js — LOCAL, checkpointed backfill of the immutable
 * firstSeenAt clock (sprint-plan-t1-retrieval.md S2-T5).
 *
 * firstSeenAt is stamped at creation going forward (S2-T4), but pre-existing review
 * files lack it. This derives it from git history — the FIRST time the file was added
 * (`git log --diff-filter=A`, oldest entry) — which is the accurate "when did this
 * review first reach us" date. Never uses merge/now time (that would be late + wrong).
 *
 * Runs LOCALLY (git-history walk is slow) with checkpoint/resume (batch-script rule):
 * kill it any time and rerun — it skips files already recorded in the checkpoint and
 * commits the data repo in batches. In-window shows are processed first.
 *
 * Usage:
 *   node scripts/backfill-first-seen.js --dir=/abs/path/to/review-texts [--limit=N]
 *        [--shows=a,b,c] [--dry-run] [--batch=200] [--commit]
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function parseArgs() {
  const a = process.argv.slice(2);
  const get = (p, d) => { const m = a.find((x) => x.startsWith(p)); return m ? m.split('=')[1] : d; };
  return {
    dir: get('--dir=', path.join(__dirname, '..', 'data', 'review-texts')),
    limit: parseInt(get('--limit=', '0'), 10) || 0,
    shows: (get('--shows=', '') || '').split(',').filter(Boolean),
    dryRun: a.includes('--dry-run'),
    batch: parseInt(get('--batch=', '200'), 10),
    commit: a.includes('--commit'),
  };
}

// Earliest git-add ISO date for a file. Pure aside from git; returns null if unknown.
function firstAddDate(dir, relPath) {
  let out = '';
  try {
    out = execFileSync('git', ['-C', dir, 'log', '--diff-filter=A', '--format=%aI', '--', relPath],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (_) { return null; }
  const lines = out.split('\n').map((s) => s.trim()).filter(Boolean);
  return lines.length ? lines[lines.length - 1] : null; // oldest add = last line
}

// Choose the firstSeenAt to write: prefer an existing value (immutable), else the git
// first-add date. Pure — unit-testable without touching disk/git.
function chooseFirstSeen(existing, gitDate) {
  if (existing && existing.firstSeenAt) return existing.firstSeenAt; // never overwrite
  return gitDate || null;
}

function listShowDirs(dir) {
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('_') && !d.name.startsWith('.'))
    .map((d) => d.name);
}

function main() {
  const opts = parseArgs();
  if (!fs.existsSync(opts.dir)) { console.error(`review-texts dir not found: ${opts.dir}`); process.exit(1); }
  const ckptPath = path.join(opts.dir, '..', 'audit', 'first-seen-backfill-checkpoint.json');
  let ckpt = { done: [] };
  try { ckpt = JSON.parse(fs.readFileSync(ckptPath, 'utf8')); } catch (_) { ckpt = { done: [] }; }
  const done = new Set(ckpt.done);

  let showDirs = opts.shows.length ? opts.shows : listShowDirs(opts.dir);
  let stamped = 0, skipped = 0, missingDate = 0, processed = 0;
  let sinceCommit = 0;

  const commitBatch = () => {
    if (opts.dryRun || !opts.commit || sinceCommit === 0) return;
    try {
      execFileSync('git', ['-C', opts.dir, 'add', '-A'], { stdio: 'ignore' });
      execFileSync('git', ['-C', opts.dir, 'commit', '-m', `backfill: firstSeenAt (${stamped} stamped) [skip ci]`], { stdio: 'ignore' });
    } catch (_) { /* nothing staged / commit no-op */ }
    sinceCommit = 0;
  };

  outer:
  for (const show of showDirs) {
    const showDir = path.join(opts.dir, show);
    let files = [];
    try { files = fs.readdirSync(showDir).filter((f) => f.endsWith('.json')); } catch (_) { continue; }
    for (const f of files) {
      const rel = `${show}/${f}`;
      if (done.has(rel)) { skipped++; continue; }
      const abs = path.join(showDir, f);
      let data; try { data = JSON.parse(fs.readFileSync(abs, 'utf8')); } catch (_) { done.add(rel); continue; }
      if (data && data.firstSeenAt) { done.add(rel); skipped++; continue; }
      const gitDate = firstAddDate(opts.dir, rel);
      const chosen = chooseFirstSeen(data, gitDate);
      if (!chosen) { missingDate++; done.add(rel); continue; }
      if (!opts.dryRun) {
        data.firstSeenAt = chosen;
        fs.writeFileSync(abs, JSON.stringify(data, null, 2));
        sinceCommit++;
      }
      stamped++; processed++;
      done.add(rel);
      // Persist checkpoint frequently so a kill loses at most a few files.
      if (processed % 50 === 0) {
        fs.mkdirSync(path.dirname(ckptPath), { recursive: true });
        fs.writeFileSync(ckptPath, JSON.stringify({ done: [...done] }));
      }
      if (sinceCommit >= opts.batch) commitBatch();
      if (opts.limit && stamped >= opts.limit) break outer;
    }
  }
  fs.mkdirSync(path.dirname(ckptPath), { recursive: true });
  fs.writeFileSync(ckptPath, JSON.stringify({ done: [...done] }));
  commitBatch();
  console.log(`firstSeenAt backfill: stamped=${stamped} skipped=${skipped} no-git-date=${missingDate}${opts.dryRun ? ' (dry-run)' : ''} checkpoint=${ckptPath}`);
}

if (require.main === module) main();
module.exports = { firstAddDate, chooseFirstSeen };
