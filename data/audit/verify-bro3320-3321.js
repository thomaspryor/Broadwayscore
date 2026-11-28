#!/usr/bin/env node
'use strict';
/**
 * Acceptance evidence for BRO-3320 + BRO-3321, in one runnable command.
 *
 * Written as a script rather than a shell one-liner so the verification is
 * reproducible verbatim by anyone (including a future recheck) instead of
 * living only in a session transcript.
 *
 *   node data/audit/verify-bro3320-3321.js [--shallow-clone <path>]
 *
 * BRO-3320: proves the CI unshallow skip reaches the SAME verdict as the old
 * unshallow attempt, and how much time it saves, against a real depth-1 clone.
 * BRO-3321: proves the real reconcile-then-assess flow no longer reports the
 * "Auto-fix loop is DEAD" banner on the live ledgers.
 */
const path = require('path');
const fs = require('fs');

const REPO = path.join(__dirname, '..', '..');
const argIdx = process.argv.indexOf('--shallow-clone');
const CLONE = argIdx !== -1 ? process.argv[argIdx + 1] : null;

function readJsonl(p) {
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

// ── BRO-3320 ────────────────────────────────────────────────────────────────
function checkUnshallowSkip() {
  if (!CLONE || !fs.existsSync(CLONE)) {
    console.log('BRO-3320: SKIPPED — pass --shallow-clone <path to a depth-1 clone> to measure');
    return;
  }
  const { checkLanded } = require(path.join(REPO, 'scripts/lib/landing-verify.js'));
  const run = (env) => {
    const saved = { GITHUB_ACTIONS: process.env.GITHUB_ACTIONS, PUSH_SKIP_UNSHALLOW: process.env.PUSH_SKIP_UNSHALLOW };
    delete process.env.GITHUB_ACTIONS; delete process.env.PUSH_SKIP_UNSHALLOW;
    if (env) process.env[env] = env === 'GITHUB_ACTIONS' ? 'true' : '1';
    const t0 = Date.now();
    const r = checkLanded({ sha: 'HEAD', ref: 'HEAD', cwd: CLONE, log: () => {} });
    const ms = Date.now() - t0;
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    return { r, ms };
  };
  const withFix = run('GITHUB_ACTIONS');
  const without = run(null);
  console.log(`BRO-3320: with skip    -> ${JSON.stringify(withFix.r)}  ${withFix.ms}ms`);
  console.log(`BRO-3320: without skip -> ${JSON.stringify(without.r)}  ${without.ms}ms`);
  const sameVerdict = withFix.r.verdict === without.r.verdict && withFix.r.landed === without.r.landed;
  console.log(`BRO-3320: identical verdict? ${sameVerdict}   speedup: ${Math.round(without.ms / Math.max(withFix.ms, 1))}x`);
  if (!sameVerdict) { console.error('BRO-3320: FAIL — the skip changed the verdict'); process.exitCode = 1; }
}

// ── BRO-3321 ────────────────────────────────────────────────────────────────
function checkNoDeadBanner() {
  const da = require(path.join(REPO, 'scripts/lib/digest-autofix.js'));
  const { assessAutofixEffectiveness } = require(path.join(REPO, 'scripts/lib/autofix-effectiveness.js'));
  const ledger = path.join(REPO, 'data/audit/digest-autofix-ledger.jsonl');
  const dispatch = path.join(REPO, 'data/audit/dispatch-ledger.jsonl');
  if (!fs.existsSync(ledger) || !fs.existsSync(dispatch)) {
    console.log('BRO-3321: SKIPPED — per-machine ledgers absent here (expected in CI)');
    return;
  }
  const rows = readJsonl(ledger);
  const outcomes = da.reconcileDigestOutcomes(rows, new Map(), readJsonl(dispatch), new Date());
  const r = assessAutofixEffectiveness([...rows, ...outcomes.map((o) => ({ ts: new Date().toISOString(), ...o }))]);
  console.log(`BRO-3321: reconcile-then-assess -> ${r.status} | ${r.message}`);
  if (r.status === 'error') { console.error('BRO-3321: FAIL — the DEAD banner would still fire'); process.exitCode = 1; }
  else console.log('BRO-3321: PASS — no DEAD banner');
}

checkUnshallowSkip();
checkNoDeadBanner();
