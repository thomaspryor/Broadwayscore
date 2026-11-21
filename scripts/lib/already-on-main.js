#!/usr/bin/env node
'use strict';
/**
 * already-on-main.js — exit 0 when every commit being pushed is already on origin/main (BRO-7629).
 *
 * A resumed cloud session fast-forwards claude/<name> to origin/main, then a push of that branch diffed
 * `remote_oid..local_oid` (up to 120 commits of other people's files) and ran the repo audits on them, which
 * failed on a checkout with no node_modules. Nothing in such a push is new, and main's own CI already covered it.
 * Fail-open: any git error exits 1 (audits run as before).
 *   node scripts/lib/already-on-main.js <local-oid> [repo-dir]
 */
const { execFileSync } = require('child_process');

function alreadyOnMain(localOid, repoDir = process.cwd(), execFn = execFileSync) {
  try {
    if (!/^[0-9a-f]{7,40}$/i.test(localOid || '')) return false;
    const n = String(execFn('git', ['-C', repoDir, 'rev-list', '--count', `origin/main..${localOid}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })).trim();
    return n === '0';
  } catch { return false; }
}

if (require.main === module) process.exit(alreadyOnMain(process.argv[2], process.argv[3]) ? 0 : 1);
module.exports = { alreadyOnMain };
