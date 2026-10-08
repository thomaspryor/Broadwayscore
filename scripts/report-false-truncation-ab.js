#!/usr/bin/env node
'use strict';
/**
 * BRO-4804 section-13 A/B for the false-truncation rescore. llm-scoring/index.ts skips
 * its own A/B gate for --needs-rescore runs, so this measures it from the files.
 *
 *   --snapshot=PATH   write score, bucket, confidence and text status of every file flagged
 *                     rescoreReason=false-truncation-warning (run BEFORE the drain)
 *   --before=PATH     compare the current state of those files against a snapshot
 *
 * Same thresholds as llm-scoring/index.ts: any bucket share moving 5+ points, or signed
 * mean drift of 5+ points, fails. Exit 0 pass, 3 fail, 1 bad input.
 */
const fs = require('fs');
const path = require('path');
const glob = require('glob');
const { hasHelpFlag } = require('./lib/cli-help.js');

const USAGE = `report-false-truncation-ab.js — before/after A/B for the BRO-4804 false-truncation rescore.

Usage:
  node scripts/report-false-truncation-ab.js --snapshot=PATH
  node scripts/report-false-truncation-ab.js --before=PATH [--json=PATH]
  node scripts/report-false-truncation-ab.js --help, -h    print this usage and exit
`;

const BUCKETS = ['Rave', 'Positive', 'Mixed', 'Negative', 'Pan'];
const REASON = 'false-truncation-warning';
const SHIFT_LIMIT = 5;
const DRIFT_LIMIT = 5;

function summarize(file, d) {
  const llm = d.llmScore || {};
  const src = (d.llmMetadata && d.llmMetadata.textSource) || {};
  return {
    file,
    score: typeof d.assignedScore === 'number' ? d.assignedScore : null,
    bucket: llm.bucket || null,
    confidence: llm.confidence == null ? null : llm.confidence,
    textStatus: src.status || null,
    needsRescore: d.needsRescore === true,
    rescoreReason: d.rescoreReason || null,
    textFetchedAt: d.textFetchedAt || null,
    tier: d.contentTier || null,
    scoredAt: (d.llmMetadata && d.llmMetadata.scoredAt) || null,
  };
}

function readAll(ROOT) {
  const out = new Map();
  for (const f of glob.sync(path.join(ROOT, 'data', 'review-texts', '*', '*.json'))) {
    let d;
    try { d = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { continue; }
    out.set(path.relative(ROOT, f), d);
  }
  return out;
}

function share(rows) {
  const n = rows.length || 1;
  const c = Object.fromEntries(BUCKETS.map(b => [b, 0]));
  for (const r of rows) if (r.bucket in c) c[r.bucket]++;
  return Object.fromEntries(BUCKETS.map(b => [b, (100 * c[b]) / n]));
}

function compare(before, current) {
  const pairs = [];
  let missing = 0;
  for (const b of before) {
    const d = current.get(b.file);
    if (!d) { missing++; continue; }
    pairs.push({ b, a: summarize(b.file, d) });
  }
  const done = pairs.filter(p => !p.a.needsRescore && p.a.scoredAt && p.a.scoredAt !== p.b.scoredAt);
  const pendingRows = pairs.filter(p => !done.includes(p));
  const drifts = done.filter(p => p.b.score != null && p.a.score != null).map(p => p.a.score - p.b.score);
  const meanSigned = drifts.length ? drifts.reduce((s, x) => s + x, 0) / drifts.length : 0;
  const meanAbs = drifts.length ? drifts.reduce((s, x) => s + Math.abs(x), 0) / drifts.length : 0;
  const sb = share(done.map(p => p.b));
  const sa = share(done.map(p => p.a));
  const shifts = Object.fromEntries(BUCKETS.map(b => [b, sa[b] - sb[b]]));
  const maxShift = Math.max(...BUCKETS.map(b => Math.abs(shifts[b])));
  // llmScore.confidence is 'high' | 'medium' | 'low' in real files; plain numbers pass through.
  const CONF = { high: 3, medium: 2, low: 1 };
  const conf = (rows) => {
    const v = rows.map(r => (typeof r.confidence === 'number' ? r.confidence : CONF[r.confidence])).filter(x => typeof x === 'number');
    return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null;
  };
  const stillTruncated = (rows) => rows.filter(r => r.textStatus === 'truncated').length;
  const changedBucket = done.filter(p => p.b.bucket && p.a.bucket && p.b.bucket !== p.a.bucket).length;
  const big = done.filter(p => p.b.score != null && p.a.score != null && Math.abs(p.a.score - p.b.score) >= 10)
    .map(p => ({ file: p.b.file, before: p.b.score, after: p.a.score }));
  return {
    pendingRows, total: before.length, missing, rescored: done.length, pending: pairs.length - done.length,
    meanSigned, meanAbs, maxShift, shifts, changedBucket,
    confBefore: conf(done.map(p => p.b)), confAfter: conf(done.map(p => p.a)),
    truncatedBefore: stillTruncated(done.map(p => p.b)), truncatedAfter: stillTruncated(done.map(p => p.a)),
    bigMoves: big,
    // The rescore must also have cleared the "truncated" text status on at least half of the
    // files it touched, otherwise the fix did not take effect and stable scores prove nothing.
    fixTookEffect: done.length > 0 && stillTruncated(done.map(p => p.a)) < stillTruncated(done.map(p => p.b)) * 0.5,
    pass: done.length > 0 && maxShift < SHIFT_LIMIT && Math.abs(meanSigned) < DRIFT_LIMIT
      && stillTruncated(done.map(p => p.a)) < stillTruncated(done.map(p => p.b)) * 0.5,
  };
}

function main() {
  const args = process.argv.slice(2);
  if (hasHelpFlag(args)) { console.log(USAGE); process.exit(0); }
  const arg = (n) => { const a = args.find(x => x.startsWith(`--${n}=`)); return a ? a.split('=').slice(1).join('=') : null; };
  const ROOT = path.join(__dirname, '..');
  const snap = arg('snapshot');
  const beforePath = arg('before');
  const jsonOut = arg('json');
  if (!snap && !beforePath) { console.error(USAGE); process.exit(1); }
  const all = readAll(ROOT);

  if (snap) {
    const rows = [];
    for (const [f, d] of all) {
      if (d.needsRescore === true && String(d.rescoreReason || '').startsWith(REASON)) rows.push(summarize(f, d));
    }
    rows.sort((a, b) => a.file.localeCompare(b.file));
    fs.writeFileSync(snap, JSON.stringify(rows));
    const meanScore = rows.length ? rows.reduce((s, r) => s + (r.score || 0), 0) / rows.length : 0;
    console.log(`Snapshot: ${rows.length} files flagged ${REASON}, mean score ${meanScore.toFixed(1)}, truncated status ${rows.filter(r => r.textStatus === 'truncated').length}`);
    return;
  }

  const before = JSON.parse(fs.readFileSync(beforePath, 'utf8'));
  const r = compare(before, all);
  const f1 = (x) => (x == null ? 'n/a' : x.toFixed(1));
  console.log(`A/B: ${r.rescored} of ${r.total} rescored (${r.pending} pending, ${r.missing} missing)`);
  console.log(`Mean drift ${r.meanSigned >= 0 ? '+' : ''}${f1(r.meanSigned)} pts (mean absolute ${f1(r.meanAbs)}), limit ${DRIFT_LIMIT}`);
  console.log(`Largest bucket share move ${f1(r.maxShift)} pts, limit ${SHIFT_LIMIT}: ${BUCKETS.map(b => `${b} ${r.shifts[b] >= 0 ? '+' : ''}${f1(r.shifts[b])}`).join(', ')}`);
  if (r.pending > 0) {
    // Why a file is still pending: still flagged, flagged for a different reason, or never rescored.
    const why = {};
    for (const p of r.pendingRows) {
      const k = p.a.needsRescore ? `still flagged (${p.a.rescoreReason || 'no reason'})` : (p.a.scoredAt === p.b.scoredAt ? 'unflagged, scoredAt unchanged' : 'other');
      why[k] = (why[k] || 0) + 1;
    }
    console.log(`Pending breakdown: ${Object.entries(why).map(([k, n]) => `${k}: ${n}`).join('; ')}`);
    for (const p of r.pendingRows.slice(0, 12)) console.log(`  pending ${p.b.file} tier=${p.a.tier} status=${p.a.textStatus} flagged=${p.a.needsRescore} fetched=${p.a.textFetchedAt}`);
  }
  console.log(`Bucket changed on ${r.changedBucket}; moves of 10+ pts: ${r.bigMoves.length}`);
  console.log(`Mean confidence ${f1(r.confBefore)} -> ${f1(r.confAfter)}; text status truncated ${r.truncatedBefore} -> ${r.truncatedAfter}`);
  if (r.rescored > 0 && !r.fixTookEffect) console.log('FIX DID NOT TAKE EFFECT: text status is still truncated on most rescored files (is contentTier reaching the scorer?)');
  console.log(r.rescored === 0 ? 'VERDICT: NOT MEASURED (nothing rescored yet)' : r.pass ? 'VERDICT: PASS' : 'VERDICT: FAIL (stop, do not run the bulk wave)');
  if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify({ ...r, pendingRows: undefined }, null, 1));
  process.exit(r.rescored === 0 ? 1 : r.pass ? 0 : 3);
}

if (require.main === module) main();
module.exports = { compare, summarize, share };
