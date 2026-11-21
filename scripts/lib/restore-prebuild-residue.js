#!/usr/bin/env node
/**
 * restore-prebuild-residue.js <root>...: put tracked prebuild outputs (data/gold-lists-computed.json ...) back to HEAD in each
 * checkout/worktree, unless a land check or gauntlet is running. A land-local-check killed mid-run (container restart,
 * BRO-7628 session) never reaches its own restore, and the leftover tripped the "uncommitted changes" stop hook
 * every turn. Run at SessionStart (cloud). Only files matching PREBUILD_OUTPUTS are touched. Fail-open.
 */
'use strict';
const { execFileSync, spawnSync } = require('child_process');

function liveGauntlet() {
  const r = spawnSync('pgrep', ['-f', 'land-local-check|land-gauntlet|prebuild.sh|next build'], { encoding: 'utf8' });
  return r.status === 0 && r.stdout.split('\n').some((pid) => pid && Number(pid) !== process.pid);
}

function restoreAll(roots, { live = liveGauntlet, restore = require('./land-local-check.js').restorePrebuildResidue } = {}) {
  if (live()) return { skipped: 'a land check is running', restored: {} };
  const restored = {};
  for (const root of roots) {
    try { const r = restore(root); if (r.length) restored[root] = r; } catch { /* not a checkout */ }
  }
  return { restored };
}

if (require.main === module) {
  const out = restoreAll(process.argv.slice(2));
  const n = Object.values(out.restored).reduce((a, b) => a + b.length, 0);
  if (n) console.log(`restored ${n} leftover generated file(s): ${JSON.stringify(out.restored)}`);
}
module.exports = { restoreAll };
