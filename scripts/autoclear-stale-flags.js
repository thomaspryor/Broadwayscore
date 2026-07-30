#!/usr/bin/env node
/**
 * autoclear-stale-flags.js — S3-T5 batch auto-clearer, hard-gated.
 *
 * Applies stale-flag clears in a batch, but ONLY when BOTH gates pass
 * (scripts/lib/autoclear-batch-gate.js):
 *   1. the S3-T4 shadow report says the evidence is clean (autoClearEnableAllowed)
 *   2. scoring-delta.js shows no T1 flip and ≤5 total flips
 *
 * CURRENT STATE (S3-T5 conclusion): the shadow evidence is INSUFFICIENT — the
 * corpus is clean (0 live would-clear candidates), so gate 1 fails and this
 * command is a NO-OP that reports "staying escalate-only". The escalate-only
 * contradiction alert (S3-T3) remains the only action. When a real 48h shadow
 * window later accrues ≥3 human-agreed candidates, this path turns on
 * automatically (no code change) — gate 1 flips, and gate 2 runs scoring-delta
 * before any write.
 *
 * Usage:
 *   node scripts/autoclear-stale-flags.js                 # report gate status (no writes)
 *   node scripts/autoclear-stale-flags.js --dry-run       # + run scoring-delta, preview the batch
 *   node scripts/autoclear-stale-flags.js --confirm       # apply (only if BOTH gates pass)
 *   --skip-delta   # skip the scoring-delta run in --dry-run (fast gate-1 preview only)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { wouldAutoClear } = require('./lib/autoclear-shadow');
const { assessBatchClearGate } = require('./lib/autoclear-batch-gate');
const { clearWrongProductionFlags } = require('./lib/wrong-production-clear');

const { hasHelpFlag } = require('./lib/cli-help.js');

const USAGE = `autoclear-stale-flags.js — S3-T5 batch auto-clearer, hard-gated.

Usage:
  node scripts/autoclear-stale-flags.js [options]
  node scripts/autoclear-stale-flags.js --help, -h    print this usage and exit
`;
const ROOT = process.env.BSC_DATA_ROOT || path.join(__dirname, '..');
const AUDIT_DIR = path.join(ROOT, 'data', 'audit');
const REVIEW_TEXTS_DIR = path.join(ROOT, 'data', 'review-texts');
const SHADOW_REPORT_PATH = path.join(AUDIT_DIR, 'autoclear-shadow-report.json');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const CONFIRM = args.includes('--confirm');
const SKIP_DELTA = args.includes('--skip-delta');

function loadJson(p, dflt) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return dflt; }
}

// Collect the current would-auto-clear batch across the corpus (same predicate
// the shadow logs). Returns [{showId, file, flag}].
function collectBatch() {
  const batch = [];
  let dirs;
  try { dirs = fs.readdirSync(REVIEW_TEXTS_DIR); } catch { return batch; }
  for (const showId of dirs) {
    const dir = path.join(REVIEW_TEXTS_DIR, showId);
    let files;
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { continue; }
    for (const f of files) {
      const d = loadJson(path.join(dir, f), null);
      if (!d) continue;
      const dec = wouldAutoClear(d);
      if (dec.clear) batch.push({ showId, file: f, flag: dec.flag });
    }
  }
  return batch;
}

// Run scoring-delta.js --json and parse the flip counts. Returns null on any
// failure (the gate treats a missing delta as "not run" → blocks).
function runScoringDelta() {
  try {
    const out = execFileSync('node', [path.join(ROOT, 'scripts', 'scoring-delta.js'), '--json'],
      { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], timeout: 600000 });
    console.log('[autoclear] scoring-delta --json:', out.trim());
    const line = out.trim().split('\n').filter(Boolean).pop();
    return JSON.parse(line);
  } catch (e) {
    // exit 2 = significant flips; still parse its JSON if present on stdout.
    if (e.stdout) {
      try {
        const line = String(e.stdout).trim().split('\n').filter(Boolean).pop();
        const parsed = JSON.parse(line);
        console.log('[autoclear] scoring-delta reported flips:', JSON.stringify(parsed));
        return parsed;
      } catch { /* fall through */ }
    }
    console.warn('[autoclear] scoring-delta did not produce parseable JSON — treating as not-run.');
    return null;
  }
}

function main() {
  // --help/-h checked before any real work (cousin of #260/#263/#264/#266 — see scripts/lib/cli-help.js).
  if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); return; }
  const report = loadJson(SHADOW_REPORT_PATH, null);
  const enableAllowed = !!(report && report.autoClearEnableAllowed);
  const batch = collectBatch();

  console.log('=== Auto-clear batch gate (S3-T5) ===');
  console.log(`Shadow report: ${report ? report.evidence.verdict : 'MISSING'} — enableAllowed=${enableAllowed}`);
  console.log(`Would-clear candidates in corpus: ${batch.length}`);

  // Gate 1 fails ⇒ short-circuit. This is the current, expected state: no
  // scoring-delta needed because we are staying escalate-only.
  if (!enableAllowed) {
    console.log('\n⛔ AUTO-CLEAR DISABLED — shadow evidence insufficient. Staying ESCALATE-ONLY.');
    console.log('   (Contradictions are surfaced as ACTION alerts by audit-t1-silent-gaps.js.)');
    process.exit(0);
  }

  // Gate 1 passed: run scoring-delta (gate 2) unless explicitly skipped in a
  // fast preview. A batch clear MUST show scoring-delta output before any write.
  const scoringDelta = SKIP_DELTA ? null : runScoringDelta();
  const gate = assessBatchClearGate({ enableAllowed, scoringDelta });
  console.log(`\nGate decision: ${gate.proceed ? 'PROCEED' : 'ABORT'} (${gate.reason})`);
  console.log(`  checks: ${JSON.stringify(gate.checks)}`);

  if (!gate.proceed) {
    console.log('\n⛔ Batch aborted by the gate — no flags cleared.');
    process.exit(gate.reason.startsWith('scoring-delta') ? 2 : 0);
  }

  if (!CONFIRM || DRY_RUN) {
    console.log('\n(dry-run) both gates pass; pass --confirm to apply the clears.');
    process.exit(0);
  }

  // Apply — only reached when both gates pass AND --confirm. Kept behind
  // safeWriteReview routing (write-guard). Intentionally not exercised while the
  // shadow verdict is insufficient; wired for when evidence graduates.
  const { safeWriteReview } = require('./lib/review-write-guard');
  let cleared = 0;
  for (const { showId, file, flag } of batch) {
    const fp = path.join(REVIEW_TEXTS_DIR, showId, file);
    const d = loadJson(fp, null);
    if (!d) continue;
    clearWrongProductionFlags(d, {
      source: 'autoclear-stale-flags.js',
      reason: 'shadow-gated-contradiction',
      wrongShowOnly: flag === 'wrongShow',
    });
    if (flag === 'wrongProduction') { d.wrongProductionManualClear = true; }
    else if (flag === 'wrongShow') { d.wrongShowManualClear = true; }
    d.autoClearedAt = new Date().toISOString();
    d.autoClearReason = 'shadow-gated-contradiction';
    safeWriteReview(fp, d);
    cleared++;
  }
  console.log(`\n✅ Cleared ${cleared} stale flag(s) behind the double gate.`);
}

main();
