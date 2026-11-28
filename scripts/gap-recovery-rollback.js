#!/usr/bin/env node
'use strict';
/**
 * gap-recovery-rollback.js — undo gap-recovery accepts whose gain was page
 * chrome (BRO-7171 Stage 4). Before the novel-prose gate, a re-fetch of the
 * same review plus a newsletter box or footer passed the length bar and landed
 * as "recovered". The prose is unchanged, so the prior text is restored.
 *
 * Candidates: ledger 'recovered' rows that replaced existing text. The prior
 * record is the file at <landing commit>^ in the review-texts repo. The policy
 * (scripts/lib/gap-rollback.js) refuses anything with real new prose, a moved
 * url, or text changed since the accept.
 *
 *   node scripts/gap-recovery-rollback.js            # dry run: what would roll back
 *   node scripts/gap-recovery-rollback.js --apply    # write under the run lock, checkpoint, ledger rows
 *
 * Exit codes: 0 ok, 1 failed, 3 another recovery run holds the run lock.
 */
require('./lib/cli-help').exitOnHelp(module);

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const L = require('./lib/gap-recovery-ledger');
const { chromeRollbackDecision } = require('./lib/gap-rollback');

const APPLY = process.argv.includes('--apply');

function gitShow(dir, rev, key) {
  try {
    return JSON.parse(execFileSync('git', ['-C', dir, 'show', `${rev}:${key}`], { encoding: 'utf8', maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'ignore'] }));
  } catch { return null; }
}

function candidates() {
  const latest = new Map();
  for (const r of L.readRows(L.ledgerPathDefault())) {
    if (r.outcome === 'recovered' && r.bytesBefore > 0 && r.detail && r.detail.commit) latest.set(r.reviewKey, r);
  }
  return [...latest.values()];
}

function main() {
  const { resolveReviewTextsDir } = require('./lib/review-texts-dir');
  const dir = fs.realpathSync(process.env.REVIEW_TEXTS_DIR || resolveReviewTextsDir());
  const rows = candidates();
  const tally = {};
  const todo = [];
  for (const r of rows) {
    const prior = gitShow(dir, `${r.detail.commit}^`, r.reviewKey);
    let current = null;
    try { current = JSON.parse(fs.readFileSync(path.join(dir, r.reviewKey), 'utf8')); } catch { /* gone */ }
    const d = current ? chromeRollbackDecision({ current, prior }) : { ok: false, reason: 'file_missing' };
    const k = d.ok ? 'roll_back' : d.reason;
    tally[k] = (tally[k] || 0) + 1;
    if (d.ok) todo.push({ row: r, prior });
  }
  console.log(`accepts that replaced text: ${rows.length}; ${JSON.stringify(tally)}`);
  if (!APPLY) {
    for (const t of todo.slice(0, 10)) console.log(`  would roll back ${t.row.reviewKey}`);
    if (todo.length > 10) console.log(`  ... and ${todo.length - 10} more`);
    return 0;
  }

  const { acquireRunLock, RunLockBusyError } = require('./lib/recovery-run-lock');
  try { acquireRunLock('gap-recovery-rollback'); } catch (e) {
    if (e instanceof RunLockBusyError) { console.log(`gap-recovery-rollback: ${e.message}; not running.`); return 3; }
    throw e;
  }
  const { withReviewTextsLock } = require('./lib/review-texts-lock');
  const { readReviewForUpdate, persistReviewViaSafeWrite } = require('./lib/persist-review-snapshot');
  const { checkpointReviewTexts, createWriteTracker } = require('./lib/review-texts-checkpoint');
  const tracker = createWriteTracker();
  const ledger = [];
  const outcome = {};
  const bump = (k) => { outcome[k] = (outcome[k] || 0) + 1; };
  for (const { row, prior } of todo) {
    const filePath = path.join(dir, row.reviewKey);
    withReviewTextsLock(`gap-rollback:${row.reviewKey}`, () => {
      const data = readReviewForUpdate(filePath);
      const d = chromeRollbackDecision({ current: data, prior }); // re-decide under the lock
      if (!d.ok) { bump(`skipped_${d.reason}`); return; }
      Object.assign(data, d.patch);
      const w = persistReviewViaSafeWrite({ filePath, data, trailingNewline: true });
      const disk = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (!w.wrote || disk.fullText !== prior.fullText) { bump(`refused_${w.skipped || 'text_not_restored'}`); return; }
      tracker.add(path.resolve(filePath));
      bump('rolled_back');
      ledger.push({ reviewKey: row.reviewKey, gapClass: row.gapClass, strategy: row.strategy, outcome: 'rejected', reason: 'rolled_back_chrome_gain',
        url: row.url, bytesBefore: (row.bytesAfter || null), bytesAfter: prior.fullText.length, detail: { novelProseChars: d.novel, needed: d.need, acceptCommit: row.detail.commit } });
    });
  }
  if (tracker.size) {
    const res = checkpointReviewTexts({ repoDir: dir, paths: [...tracker], expected: tracker.expected,
      message: `fix: roll back ${tracker.size} gap-recovery accept(s) whose gain was page chrome (BRO-7171 Stage 4)`, meta: { source: 'gap-recovery-rollback' } });
    console.log(`  [checkpoint] ${res.pushed ? 'pushed' : 'nothing to push'}; ${res.landed.length} file(s) confirmed on origin/main`);
  }
  L.appendRows(ledger);
  console.log(`result: ${JSON.stringify(outcome)}`);
  return 0;
}

try { process.exitCode = main(); } catch (e) { console.error('FATAL:', e.stack || e.message); process.exitCode = 1; }
