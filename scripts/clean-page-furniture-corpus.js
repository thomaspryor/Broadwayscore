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
const { cleanRecord, skipReason } = require('./lib/page-furniture-record');

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

const TIER_RANK = { complete: 5, truncated: 4, excerpt: 3, stub: 2, invalid: 1 };
function tierRank(t) { return TIER_RANK[t] || 0; }

function main() {
  const { classifyContentTier } = require('./lib/content-quality');
  const at = new Date().toISOString();
  const stats = { scanned: 0, changed: 0, written: 0, failed: 0, charsRemoved: 0, skipped: {}, byCategory: {}, byOutlet: {}, byWriter: {}, tierShift: {}, tierShiftRows: [], downgradeRows: [] };
  const samples = [];
  const changedRows = [];
  for (const showId of fs.readdirSync(DIR).sort()) {
    if (showId.startsWith('_') || showId.startsWith('.')) continue;
    const showDir = path.join(DIR, showId);
    let names;
    try { if (!fs.statSync(showDir).isDirectory()) continue; names = fs.readdirSync(showDir); } catch { continue; }
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
      try { tb = classifyContentTier(d).contentTier; ta = classifyContentTier(res.record).contentTier; } catch { /* tier unknown */ }
      if (tierRank(ta) < tierRank(tb)) {
        // Cutting the furniture left residual chrome as the last line (a
        // Vulture "Show" + headline widget) and the classifier now reads the
        // body as cut off. Leave the record as it is rather than downgrade it.
        stats.changed--;
        stats.charsRemoved -= d.fullText.length - res.record.fullText.length;
        for (const c of res.record.fullTextTrimmed.categories) bump(stats.byCategory, c, -1);
        bump(stats.byOutlet, d.outletId || '?', -1);
        bump(stats.byWriter, d.fetchMethod || d.sourceMethod || 'unknown', -1);
        bump(stats.skipped, 'tier-downgrade');
        stats.downgradeRows.push({ rel, from: tb, to: ta });
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

function applyRows(rows, stats) {
  const { safeWriteReview } = require('./lib/review-write-guard');
  const { withReviewTextsLock } = require('./lib/review-texts-lock');
  const { checkpointReviewTexts, retryPendingPushes, createWriteTracker } = require('./lib/review-texts-checkpoint');
  const pre = retryPendingPushes({ repoDir: DIR });
  if (pre.notLanded && pre.notLanded.length) throw new Error(`earlier checkpoint(s) not landed: ${pre.notLanded.map((n) => n.rel).join(', ')}`);
  let tracker = createWriteTracker();
  const flush = () => {
    if (!tracker.size) return;
    const res = checkpointReviewTexts({ repoDir: DIR, paths: [...tracker], message: `chore: remove page furniture from stored review texts (BRO-7171 Stage 5) - ${stats.written} so far` });
    console.log(`  [Checkpoint] ${res.pushed ? 'pushed' : 'nothing new to push'}; ${res.landed.length} landed, ${res.notLanded.length} not landed`);
    if (res.notLanded.length) throw new Error(`checkpoint did not land: ${res.notLanded.slice(0, 5).map((n) => n.rel).join(', ')}`);
    tracker = createWriteTracker();
  };
  for (const row of rows) {
    const ok = withReviewTextsLock(`page-furniture:${row.rel}`, () => {
      // Fresh read under the lock: another writer may have changed the text
      // since the scan. Clean what is on disk now, not the scanned copy.
      let fresh;
      try { fresh = JSON.parse(fs.readFileSync(row.file, 'utf8')); } catch { return false; }
      const res = cleanRecord(fresh, row.record.fullTextTrimmed.at);
      if (!res) return null;
      const { classifyContentTier } = require('./lib/content-quality');
      if (tierRank(classifyContentTier(res.record).contentTier) < tierRank(classifyContentTier(fresh).contentTier)) return null;
      const w = safeWriteReview(row.file, res.record, { force: true });
      const after = JSON.parse(fs.readFileSync(row.file, 'utf8'));
      if ((w && w.wrote === false) || after.fullText !== res.record.fullText) {
        console.log(`  ✗ ${row.rel}: write did not stick (${(w && (w.skipped || w.reason)) || 'text differs after write'})`);
        return false;
      }
      tracker.add(path.resolve(row.file));
      return true;
    });
    if (ok === true) stats.written++;
    else if (ok === false) stats.failed++;
    if (tracker.size >= BATCH) flush();
  }
  flush();
  console.log(`applied: ${stats.written} written, ${stats.failed} failed`);
}

if (require.main === module) process.exit(main());
