#!/usr/bin/env node
/**
 * clean-page-furniture-corpus.js — remove page furniture (share bars,
 * related-story runs, comment/ticket widgets, newsletter/paywall/donation
 * lines, copyright lines, repeated paragraphs) from STORED review texts
 * (BRO-7171 Stage 5). Rules: scripts/lib/page-furniture.js, which cleanText
 * now applies to every new fetch. Per record: scripts/lib/page-furniture-record.js
 * (skips locked, manual-entry and Theatre Record lift records; stamps
 * fullTextTrimmed with the prior text's sha256 so push restore never puts the
 * longer copy back).
 *
 * Furniture holds no verdict, so no rescore is queued. The dry run reports the
 * tier the classifier gives each changed record before and after, so the
 * scoring impact is known before anything is written.
 *
 * Usage:
 *   node scripts/clean-page-furniture-corpus.js                 dry run (default)
 *   node scripts/clean-page-furniture-corpus.js --apply         write via safeWriteReview under the
 *                                                               review-texts lock, commit+push every
 *                                                               --batch rows (default 300)
 *     --dir=<review-texts>   --files=show/a.json,show/b.json   --limit=N   --json=/tmp/out.json
 *     --samples=N            print N sample diffs (dry run)
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { listShowDirs } = require('./lib/list-show-dirs');
const { cleanRecord, skipReason, tierChangeRefusal } = require('./lib/page-furniture-record');

function arg(name, def) {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
}

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(2, 22).map((l) => l.replace(/^ \* ?/, '')).join('\n'));
  process.exit(0);
}

function defaultDir() {
  if (process.env.REVIEW_TEXTS_DIR) return process.env.REVIEW_TEXTS_DIR;
  const local = path.join(__dirname, '..', 'data', 'review-texts');
  return fs.existsSync(local) ? local : path.join(os.homedir(), 'broadway-review-texts');
}

const DIR = arg('dir', defaultDir());
const APPLY = process.argv.includes('--apply');
const BATCH = Math.max(1, parseInt(arg('batch', '300'), 10) || 300);
const LIMIT = parseInt(arg('limit', '0'), 10) || Infinity;
const SAMPLES = parseInt(arg('samples', '0'), 10) || 0;
const filesArg = arg('files', '');
const ONLY = filesArg ? new Set(filesArg.split(',').filter(Boolean)) : null;
const JSON_OUT = arg('json', null);

function bump(m, k, n = 1) { m[k] = (m[k] || 0) + n; if (!m[k]) delete m[k]; }


function main() {
  const { classifyContentTier } = require('./lib/content-quality');
  const at = new Date().toISOString();
  const stats = { scanned: 0, changed: 0, written: 0, failed: 0, charsRemoved: 0, skipped: {}, byCategory: {}, byOutlet: {}, byWriter: {}, tierShift: {}, tierShiftRows: [], refusedRows: [] };
  const samples = [];
  const changedRows = [];
  for (const showId of listShowDirs(DIR, { silent: true, skipHolding: true }).sort()) {
    const showDir = path.join(DIR, showId);
    let names;
    try { names = fs.readdirSync(showDir); } catch { continue; }
    for (const f of names.sort()) {
      if (!f.endsWith('.json') || f.startsWith('_') || f.startsWith('.')) continue;
      const rel = `${showId}/${f}`;
      if (ONLY && !ONLY.has(rel)) continue;
      let d;
      try { d = JSON.parse(fs.readFileSync(path.join(showDir, f), 'utf8')); } catch { continue; }
      if (typeof d.fullText !== 'string' || !d.fullText) continue;
      stats.scanned++;
      const skip = skipReason(d);
      const res = cleanRecord(d, at);
      if (!res) { if (skip && skip !== 'no-text') bump(stats.skipped, skip); continue; }
      stats.changed++;
      stats.charsRemoved += d.fullText.length - res.record.fullText.length;
      for (const c of res.record.fullTextTrimmed.categories) bump(stats.byCategory, c);
      bump(stats.byOutlet, d.outletId || '?');
      bump(stats.byWriter, d.fetchMethod || d.sourceMethod || 'unknown');
      let tb = null; let ta = null;
      let refusal = null;
      try { tb = classifyContentTier(d).contentTier; ta = classifyContentTier(res.record).contentTier; } catch { refusal = 'tier-unknown'; }
      // Unknown tier is a refusal, not a pass (apply re-classifies and would throw).
      refusal = refusal || tierChangeRefusal(tb, ta);
      if (refusal) {
        // Leave the record as it is (see tierChangeRefusal).
        stats.changed--;
        stats.charsRemoved -= d.fullText.length - res.record.fullText.length;
        for (const c of res.record.fullTextTrimmed.categories) bump(stats.byCategory, c, -1);
        bump(stats.byOutlet, d.outletId || '?', -1);
        bump(stats.byWriter, d.fetchMethod || d.sourceMethod || 'unknown', -1);
        bump(stats.skipped, refusal);
        stats.refusedRows.push({ rel, from: tb, to: ta, refusal });
        continue;
      }
      if (tb !== ta) {
        bump(stats.tierShift, `${tb}->${ta}`);
        stats.tierShiftRows.push({ rel, from: tb, to: ta, scored: typeof d.assignedScore === 'number', score: d.assignedScore });
      }
      if (samples.length < SAMPLES) samples.push({ rel, removed: res.removed.slice(0, 6).map((r) => `${r.category}: ${r.line.slice(0, 120)}`) });
      changedRows.push({ rel, file: path.join(showDir, f), record: res.record, priorText: d.fullText });
      if (changedRows.length >= LIMIT) break;
    }
    if (changedRows.length >= LIMIT) break;
  }

  const top = (m, n = 15) => Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${k} ${v}`).join(', ');
  console.log(`${APPLY ? 'APPLY' : 'DRY RUN'} ${DIR}: scanned ${stats.scanned} bodies, ${stats.changed} carry furniture (${stats.charsRemoved} chars)`);
  console.log(`  by category: ${top(stats.byCategory)}`);
  console.log(`  by outlet:   ${top(stats.byOutlet)}`);
  console.log(`  by writer:   ${top(stats.byWriter)}`);
  console.log(`  skipped:     ${JSON.stringify(stats.skipped)}`);
  console.log(`  tier shifts: ${JSON.stringify(stats.tierShift)}`);
  for (const s of samples) { console.log(`  · ${s.rel}`); for (const r of s.removed) console.log(`      - ${r}`); }

  if (APPLY) applyRows(changedRows, stats);
  if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify({ ...stats, changedFiles: changedRows.map((r) => r.rel) }, null, 2));
  return stats.failed ? 1 : 0;
}

// Default build: clean what is on disk now. Returns the record to write, or null.
function cleanFresh(fresh, row) {
  const res = cleanRecord(fresh, row.record.fullTextTrimmed.at);
  if (!res) return null;
  const { classifyContentTier } = require('./lib/content-quality');
  if (tierChangeRefusal(classifyContentTier(fresh).contentTier, classifyContentTier(res.record).contentTier)) return null;
  return res.record;
}

function applyRows(rows, stats, build = cleanFresh, label = 'remove page furniture from stored review texts') {
  const { safeWriteReview } = require('./lib/review-write-guard');
  const { withReviewTextsLock } = require('./lib/review-texts-lock');
  const { checkpointReviewTexts, retryPendingPushes, createWriteTracker, landingKey } = require("./lib/review-texts-checkpoint");
  const pre = retryPendingPushes({ repoDir: DIR });
  if (pre.notLanded && pre.notLanded.length) throw new Error(`earlier checkpoint(s) not landed: ${pre.notLanded.map((n) => n.rel).join(', ')}`);
  let tracker = createWriteTracker();
  const flush = () => {
    if (!tracker.size) return;
    const res = checkpointReviewTexts({ repoDir: DIR, paths: [...tracker], expected: tracker.expected, message: `chore: ${label} (BRO-7171 Stage 5) - ${stats.written} so far` });
    console.log(`  [Checkpoint] ${res.pushed ? 'pushed' : 'nothing new to push'}; ${res.landed.length} landed, ${res.notLanded.length} not landed`);
    if (res.notLanded.length) throw new Error(`checkpoint did not land: ${res.notLanded.slice(0, 5).map((n) => n.rel).join(', ')}`);
    tracker = createWriteTracker();
  };
  // try/finally: a throw mid-batch must still checkpoint what was already
  // written, or the data repo holds uncommitted edits a rebase can clobber.
  try {
    for (const row of rows) {
      const ok = withReviewTextsLock(`page-furniture:${row.rel}`, () => {
        // Fresh read under the lock: another writer may have changed the text
        // since the scan. Clean what is on disk now, not the scanned copy.
        try {
          const fresh = JSON.parse(fs.readFileSync(row.file, 'utf8'));
          const record = build(fresh, row);
          if (!record) return null;
          const w = safeWriteReview(row.file, record, { force: true });
          const after = JSON.parse(fs.readFileSync(row.file, 'utf8'));
          if (after.fullText === record.fullText) { tracker.add(path.resolve(row.file)); tracker.expected.set(path.resolve(row.file), landingKey(after)); }
          if ((w && w.wrote === false) || after.fullText !== record.fullText) {
            console.log(`  ✗ ${row.rel}: write did not stick (${(w && (w.skipped || w.reason)) || 'text differs after write'})`);
            return false;
          }
          return true;
        } catch (e) {
          console.log(`  ✗ ${row.rel}: ${e.message}`);
          return false;
        }
      });
      if (ok === true) stats.written++;
      else if (ok === false) stats.failed++;
      if (tracker.size >= BATCH) flush();
    }
  } finally {
    flush();
  }
  console.log(`applied: ${stats.written} written, ${stats.failed} failed`);
}

// --redo-commits=<sha,...>: rebuild every record those cleaner commits touched
// from the exact prior blob (<sha>^:<path>) under the current rules. The
// guarded restore path for a rule change after a clean (rebuildFromPrior).
function redoMain(commits) {
  const { execFileSync } = require('child_process');
  const { rebuildFromPrior } = require('./lib/page-furniture-record');
  const { classifyContentTier } = require('./lib/content-quality');
  const git = (...a) => execFileSync('git', ['-C', DIR, ...a], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const at = new Date().toISOString();
  const stats = { scanned: 0, written: 0, failed: 0, reasons: {} };
  const rows = [];
  const seen = new Set();
  for (const c of commits) {
    for (const rel of git('diff-tree', '--no-commit-id', '--name-only', '-r', c).split('\n').filter((l) => l.endsWith('.json'))) {
      if (seen.has(rel)) continue;
      seen.add(rel);
      stats.scanned++;
      let prior;
      try { prior = JSON.parse(git('show', `${c}^:${rel}`)); } catch { bump(stats.reasons, 'no-prior'); continue; }
      const file = path.join(DIR, rel);
      let current;
      try { current = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { bump(stats.reasons, 'gone'); continue; }
      const r = rebuildFromPrior(current, prior, at);
      if (r.record) {
        let ta = null; let tp = null;
        try { tp = classifyContentTier(prior).contentTier; ta = classifyContentTier(r.record).contentTier; } catch { /* below */ }
        const refusal = tp && ta ? tierChangeRefusal(tp, ta) : 'tier-unknown';
        if (refusal) { bump(stats.reasons, `refused-${refusal}`); continue; }
        rows.push({ rel, file, prior });
      }
      bump(stats.reasons, r.reason);
    }
  }
  console.log(`REDO ${APPLY ? 'APPLY' : 'DRY RUN'}: ${stats.scanned} records in ${commits.length} commits; ${JSON.stringify(stats.reasons)}`);
  if (APPLY) {
    applyRows(rows, stats, (fresh, row) => {
      const r = rebuildFromPrior(fresh, row.prior, at);
      return r.record;
    }, 'redo page furniture clean under fixed tail-anchor rules');
  }
  return stats.failed ? 1 : 0;
}

if (require.main === module) {
  const redo = arg('redo-commits', '');
  process.exit(redo ? redoMain(redo.split(',').filter(Boolean)) : main());
}
