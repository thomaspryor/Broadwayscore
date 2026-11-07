#!/usr/bin/env node
'use strict';
//
// land-gauntlet-optimizer.js — decides how much of land.yml's gauntlet a
// land/** push has to pay for (BRO-4299: Land was ~50% of Actions minutes, the
// 3,000-min plan ran out 2026-09-28; each run is base + branch, ~10-16 min each).
//
// The base gauntlet is already cached (land-gate-delta.js --code-hash). What
// was still paid in full: a branch whose diff against the base touches ONLY
// bot-churn paths (data/audit/, data/pending-fixes/, show images, *.jsonl,
// *.log). Its verification-relevant tree is identical to the base's, so "new
// failures vs base" is empty by construction; running base + branch (npm ci,
// core data, tsc, lint, unit batches) measures nothing.
//
//   decideGauntletPlan({ changedFiles, strict }) →
//     { skipGauntlet, reason, inertOnly, changed }
//
// Safe defaults: an empty/unknown diff runs the gauntlet; LAND_STRICT_GATES=1
// (the rollback switch) and LAND_GAUNTLET_SKIP_INERT=0 both force a full run.
//
// CLI (land.yml "Plan the gauntlet" step):
//   node scripts/lib/land-gauntlet-optimizer.js --base <sha> --head <sha> [--github-output F]

const { execFileSync } = require('child_process');
const fs = require('fs');
// Narrower than land-branch.js's inert set: the gauntlet READS tracked
// data/*.json (outlet-registry.json via a unit test; awards.json etc. via tsc
// resolveJsonModule), *.txt exemption lists (audit-cron-health-coverage) and
// docs (byte caps, inventories; see HASH_ALWAYS_RELEVANT_RE in
// land-gate-delta.js), so only bot-churn paths are safe to skip verification for.
const SKIP_SAFE_RE = /^(data\/audit\/|data\/pending-fixes\/|public\/images\/shows\/)|^public\/opening-night-status\.json$|\.(jsonl|log)$/;
const { isCacheKeyRelevant } = require('./land-gate-delta.js');
const isSkipSafe = (f) => !isCacheKeyRelevant(f) && SKIP_SAFE_RE.test(f);

function decideGauntletPlan({ changedFiles, strict = false, disabled = false } = {}) {
  const files = (changedFiles || []).map(String).filter(Boolean);
  const base = { skipGauntlet: false, inertOnly: false, changed: files.length };
  if (strict) return { ...base, reason: 'LAND_STRICT_GATES=1 — full gauntlet (rollback switch)' };
  if (disabled) return { ...base, reason: 'LAND_GAUNTLET_SKIP_INERT=0 — full gauntlet' };
  if (!files.length) return { ...base, reason: 'no changed files known — full gauntlet' };
  const relevant = files.filter((f) => !isSkipSafe(f));
  if (relevant.length) {
    return { ...base, reason: `${relevant.length} verification-relevant file(s) changed (e.g. ${relevant[0]}) — full gauntlet` };
  }
  return { skipGauntlet: true, inertOnly: true, changed: files.length, reason: `all ${files.length} changed file(s) are inert for verification — gauntlet skipped` };
}

function main(argv = process.argv.slice(2)) {
  const arg = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : null; };
  const baseSha = arg('base');
  const head = arg('head') || 'HEAD';
  if (!baseSha) { console.error('usage: land-gauntlet-optimizer.js --base <sha> [--head <sha>] [--github-output F]'); return 2; }
  let changedFiles = [];
  try {
    changedFiles = execFileSync('git', ['diff', '--name-only', `${baseSha}...${head}`], { encoding: 'utf8' }).split('\n').filter(Boolean);
  } catch (e) {
    console.error(`could not diff ${baseSha}...${head}: ${e.message.split('\n')[0]} — full gauntlet`);
  }
  const plan = decideGauntletPlan({
    changedFiles,
    strict: process.env.LAND_STRICT_GATES === '1',
    disabled: process.env.LAND_GAUNTLET_SKIP_INERT === '0',
  });
  console.log(plan.reason);
  const out = arg('github-output');
  if (out) fs.appendFileSync(out, `skip_gauntlet=${plan.skipGauntlet}\n`);
  return 0;
}

if (require.main === module) process.exit(main());

module.exports = { decideGauntletPlan, isSkipSafe };
