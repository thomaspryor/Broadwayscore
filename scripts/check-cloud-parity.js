#!/usr/bin/env node
/**
 * check-cloud-parity.js (BRO-4239): compare ~/.claude (Mac masters) with the
 * repo's cloud copies listed in .claude/cloud-parity.json.
 *
 *   node scripts/check-cloud-parity.js            report; on drift route an alert, when clean resolve it
 *   node scripts/check-cloud-parity.js --quiet    no alert or resolve, exit 1 on drift
 *   node scripts/check-cloud-parity.js --dry-run  same as --quiet
 *
 * Exit 0 clean or nothing to compare (no ~/.claude, as in cloud); 1 drift.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help');
const { parseManifest, compareManifest, buildAlert } = require('./lib/cloud-parity');

async function run({ repoRoot, claudeHome, manifestPath, alert, resolve, quiet = false, log = console.log }) {
  const manifest = parseManifest(fs.readFileSync(manifestPath, 'utf8'));
  const result = compareManifest(manifest, { repoRoot, claudeHome });
  if (!result.checkable) {
    log(`[cloud-parity] nothing to compare (no masters under ${claudeHome}); ${result.missingGlobal.length} repo files unverified`);
    return { ...result, exitCode: 0 };
  }
  log(`[cloud-parity] compared ${result.compared} files, ${result.drifted.length} drifted, ${result.missingGlobal.length} repo-only`);
  for (const d of result.drifted) log(`  DRIFT ${d}`);
  if (!quiet) {
    if (result.drifted.length && alert) await alert(buildAlert(result));
    else if (!result.drifted.length && resolve) await resolve('cloud-parity-drift', { reason: 'no drift on latest check' });
  }
  return { ...result, exitCode: result.drifted.length ? 1 : 0 };
}

module.exports = { run };

if (require.main === module) {
  const args = process.argv.slice(2);
  if (hasHelpFlag(args)) {
    console.log('check-cloud-parity.js [--quiet|--dry-run]  compare ~/.claude with .claude/cloud-parity.json copies');
    process.exit(0);
  }
  const repoRoot = path.join(__dirname, '..');
  const quiet = args.includes('--quiet') || args.includes('--dry-run');
  run({
    repoRoot,
    claudeHome: process.env.CLAUDE_HOME || path.join(os.homedir(), '.claude'),
    manifestPath: path.join(repoRoot, '.claude', 'cloud-parity.json'),
    quiet,
    alert: (a) => require('./lib/owner-alert-router').routeAlert(a),
    resolve: async (k, o) => require('./lib/owner-alert-router').resolveCondition(k, o),
  }).then((r) => process.exit(r.exitCode), (e) => { console.error(e.message); process.exit(2); });
}
