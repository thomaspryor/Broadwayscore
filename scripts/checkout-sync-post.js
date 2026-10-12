#!/usr/bin/env node
'use strict';
// scripts/checkout-sync-post.js — what com.broadwayscore.checkout-sync does
// after a SUCCESSFUL sync (BRO-5085). Called from the EXIT trap of
// scripts/lib/sync-audit-checkout.sh only when SYNC_TAG=checkout-sync and the
// sync exited 0, after the push mutex is released, with cwd = the checkout.
//
//  1. Retire Mac launchd jobs listed in config/mac-retired.json
//     (scripts/lib/mac-retired-reconciler.js).
//  2. Post the applied-sha heartbeat (scripts/lib/mac-applied-heartbeat.js).
//
// Always exits 0: nothing here may turn a good sync into a refusal.
//
// Usage: node scripts/checkout-sync-post.js [--dry-run] [--no-heartbeat]

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const rec = require('./lib/mac-retired-reconciler.js');
const hb = require('./lib/mac-applied-heartbeat.js');

const REPO = 'thomaspryor/Broadwayscore';
const ROOT = path.resolve(__dirname, '..');
const args = new Set(process.argv.slice(2));
const DRY = args.has('--dry-run');

function log(msg) { console.log(msg); }

function reconcile() {
  const file = path.join(ROOT, 'config', 'mac-retired.json');
  if (!fs.existsSync(file)) return;
  const config = rec.readConfig(file);
  const dir = rec.launchAgentsDir();
  const listOut = execFileSync('launchctl', ['list'], { encoding: 'utf8', timeout: 30000 });
  const plan = rec.planReconcile({ config, loaded: listOut, presentPlists: rec.presentPlistLabels(config, dir), now: new Date() });
  if (DRY) {
    for (const r of plan.refused) log(`[mac-retired] (dry-run) REFUSED ${r.label}: ${r.reason}`);
    for (const w of plan.waiting) log(`[mac-retired] (dry-run) waiting ${w.label}: acts from ${w.actFrom}`);
    for (const a of plan.actions) log(`[mac-retired] (dry-run) would ${a.type} ${a.label}`);
    if (!plan.actions.length) log('[mac-retired] (dry-run) nothing to do');
    return;
  }
  rec.applyPlan(plan, { dir, log });
}

function heartbeat() {
  const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', timeout: 15000 }).trim();
  // origin/main, not HEAD: two success paths in sync-audit-checkout.sh leave
  // HEAD on a local-only ledger commit GitHub has never seen (a status POST
  // on it 422s). Applied = origin/main is contained in HEAD.
  const sha = git('rev-parse', 'origin/main');
  try { git('merge-base', '--is-ancestor', sha, 'HEAD'); } catch { log(`[mac-applied] HEAD does not contain origin/main ${sha.slice(0, 10)}; not posting`); return; }
  let commonDir = git('rev-parse', '--git-common-dir');
  if (!path.isAbsolute(commonDir)) commonDir = path.join(ROOT, commonDir);
  const stateFile = path.join(commonDir, 'mac-applied-heartbeat.json');
  let last = null;
  try { last = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { /* first run */ }
  const now = new Date();
  if (!hb.shouldPost({ sha, last, now })) return;
  if (DRY) { log(`[mac-applied] (dry-run) would post ${hb.STATUS_CONTEXT} on ${sha.slice(0, 10)}`); return; }
  try {
    execFileSync('gh', hb.statusArgs({ repo: REPO, sha, now }), { stdio: 'pipe', timeout: 20000 });
    fs.writeFileSync(stateFile, JSON.stringify({ sha, at: now.toISOString() }) + '\n');
    log(`[mac-applied] posted ${hb.STATUS_CONTEXT} on ${sha.slice(0, 10)}`);
  } catch (err) {
    log(`[mac-applied] post failed (non-fatal): ${String(err.stderr || err.message).trim().split('\n')[0]}`);
  }
}

for (const [name, fn] of [['reconcile', reconcile], ['heartbeat', heartbeat]]) {
  if (name === 'heartbeat' && args.has('--no-heartbeat')) continue;
  try { fn(); } catch (err) { log(`[checkout-sync-post] ${name} failed (non-fatal): ${err.message}`); }
}
process.exit(0);
