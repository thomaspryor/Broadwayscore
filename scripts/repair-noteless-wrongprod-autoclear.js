#!/usr/bin/env node
/**
 * Repair review-text files whose wrongProduction flag was wrongly auto-cleared
 * by the noteless-default bug in mergeReviews (review-normalization.js).
 *
 * The bug: `isUrlBasedWrongProd = !merged.wrongProductionNote || ...startsWith('Same URL')`
 * treated a MISSING note as "URL-based, safe to clear". Every flagger that writes
 * `wrongProductionReason` without a `wrongProductionNote` (collect-review-texts'
 * ingest-anticipatory-gate, collector/CV LLM promotions) is date- or content-based,
 * so those flags were cleared on the next aggregator re-merge — the exact class the
 * surrounding comment promises to preserve. Fixed 2026-08-06 alongside this script.
 *
 * Repair method — no guessing: for each candidate we reconstruct the file's state
 * immediately BEFORE the clear (the parent blob of the commit that introduced
 * `"wrongProductionAutoCleared": true`) and re-run the FIXED predicate against it.
 * Only files the fixed code would have refused to clear get their flag restored.
 * Files that were legitimately cleared (a real 'Same URL' note, no contradicting
 * content verification) are left exactly as they are.
 *
 * Usage:
 *   node scripts/repair-noteless-wrongprod-autoclear.js            # dry run
 *   node scripts/repair-noteless-wrongprod-autoclear.js --apply
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const APPLY = process.argv.includes('--apply');

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log('Usage: node scripts/repair-noteless-wrongprod-autoclear.js [--apply]');
  console.log('  Dry run by default. --apply writes the restored flags.');
  process.exit(0);
}

// realpath: the corpus is often a symlink into the private data repo, and BSD
// grep -r does not descend through a symlinked start path (silently 0 results).
const CORPUS = fs.existsSync(path.join(__dirname, '..', 'data', 'review-texts'))
  ? fs.realpathSync(path.join(__dirname, '..', 'data', 'review-texts'))
  : path.join(__dirname, '..', 'data', 'review-texts');
if (!fs.existsSync(CORPUS)) {
  console.error(`FATAL: corpus not found at ${CORPUS} — refusing to report a vacuous "0 files repaired".`);
  process.exit(1);
}

const git = (args) => execSync(`git -C "${CORPUS}" ${args}`, { maxBuffer: 1e9 }).toString();

/**
 * The FIXED predicate, mirroring review-normalization.js mergeReviews.
 * Returns true when the auto-clear was legitimate.
 */
function fixedClearIsLegitimate(pre) {
  if (pre.wrongProductionManualClear) return true;
  if (pre.contentVerification && pre.contentVerification.wrongProduction === true) return false;
  return !!pre.wrongProductionNote && pre.wrongProductionNote.startsWith('Same URL');
}

// Candidates: files carrying the boolean breadcrumb this code path writes.
// (Every rebuild path writes a STRING; only mergeReviews writes boolean true.)
let candidates;
try {
  candidates = execSync(
    `grep -rl '"wrongProductionAutoCleared": true' "${CORPUS}" --include='*.json'`,
    { maxBuffer: 1e9 }
  ).toString().trim().split('\n').filter(Boolean);
} catch {
  candidates = [];
}

if (candidates.length === 0) {
  console.error('FATAL: zero candidates found. Expected at least the known corrupted set — '
    + 'a genuinely clean corpus should be confirmed manually, not inferred from an empty grep.');
  process.exit(1);
}

console.log(`Scanning ${candidates.length} file(s) carrying a boolean wrongProductionAutoCleared breadcrumb\n`);

const restore = [];
const leave = [];
const unresolved = [];

for (const abs of candidates) {
  const rel = path.relative(CORPUS, abs);
  let cur;
  try { cur = JSON.parse(fs.readFileSync(abs, 'utf8')); } catch { continue; }

  // Find the commit that FIRST introduced the boolean breadcrumb, then read the
  // file as it stood in that commit's parent — the true pre-clear state.
  let preBlob = null;
  let clearCommit = null;
  try {
    const shas = git(`log --format=%H -- "${rel}"`).trim().split('\n').filter(Boolean);
    // walk oldest -> newest, find first commit where the boolean is present
    for (let i = shas.length - 1; i >= 0; i--) {
      let blob;
      try { blob = JSON.parse(git(`show ${shas[i]}:"${rel}"`)); } catch { continue; }
      if (blob.wrongProductionAutoCleared === true) {
        clearCommit = shas[i];
        try { preBlob = JSON.parse(git(`show ${shas[i]}^:"${rel}"`)); } catch { preBlob = null; }
        break;
      }
    }
  } catch { /* fall through */ }

  if (!preBlob || preBlob.wrongProduction !== true) {
    unresolved.push({ rel, why: preBlob ? 'pre-state had no wrongProduction flag' : 'no recoverable pre-clear blob' });
    continue;
  }

  if (fixedClearIsLegitimate(preBlob)) {
    leave.push({ rel, note: preBlob.wrongProductionNote });
  } else {
    restore.push({
      rel,
      abs,
      cur,
      clearCommit: clearCommit && clearCommit.slice(0, 9),
      note: preBlob.wrongProductionNote || null,
      reason: preBlob.wrongProductionReason || null,
      cvWrong: !!(preBlob.contentVerification && preBlob.contentVerification.wrongProduction === true),
    });
  }
}

console.log(`RESTORE (fixed predicate would NOT have cleared): ${restore.length}`);
for (const r of restore) {
  console.log(`  ${r.rel}`);
  console.log(`      note=${JSON.stringify(r.note)} reason=${JSON.stringify(r.reason)} cv.wrongProduction=${r.cvWrong}`);
}
console.log(`\nLEAVE AS-IS (legitimate URL-based self-heal): ${leave.length}`);
for (const l of leave) console.log(`  ${l.rel}  (${JSON.stringify(l.note)})`);
if (unresolved.length) {
  console.log(`\nUNRESOLVED (left untouched, inspect manually): ${unresolved.length}`);
  for (const u of unresolved) console.log(`  ${u.rel} — ${u.why}`);
}

if (!APPLY) {
  console.log('\nDry run. Re-run with --apply to write.');
  process.exit(0);
}

let written = 0;
for (const r of restore) {
  const d = r.cur;
  d.wrongProduction = true;
  delete d.wrongProductionAutoCleared;
  delete d.wrongProductionAutoClearedAt;
  d.wrongProductionRestoredBy = 'repair-noteless-wrongprod-autoclear';
  d.wrongProductionRestoredAt = new Date().toISOString().slice(0, 10);
  if (!d.wrongProductionNote && r.note) d.wrongProductionNote = r.note;
  if (!d.wrongProductionReason && r.reason) d.wrongProductionReason = r.reason;
  fs.writeFileSync(r.abs, JSON.stringify(d, null, 2) + '\n');
  written++;
}
console.log(`\nApplied: restored wrongProduction on ${written} file(s).`);
