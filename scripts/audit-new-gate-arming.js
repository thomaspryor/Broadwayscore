#!/usr/bin/env node
/**
 * audit-new-gate-arming.js (BRO-2123) — fails when a change to test.yml adds a
 * NEW blocking `--strict`/`--gate` step with no advisory mode, baseline file or
 * `# gate-arm-ok:` proof. Decision logic: scripts/lib/new-gate-arming.js.
 *
 * Usage: node scripts/audit-new-gate-arming.js [--base=<ref>]
 *   base defaults to $GATE_ARM_BASE, else origin/main (or HEAD~1 when HEAD is
 *   origin/main). Unresolvable base => loud warning, exit 0 (infra gap, not a
 *   gate failure).
 */
'use strict';
const { execFileSync } = require('child_process');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { findUnprovenNewGates } = require('./lib/new-gate-arming.js');

const USAGE = `audit-new-gate-arming.js — new --strict/--gate test.yml steps must land advisory or baselined.

Usage:
  node scripts/audit-new-gate-arming.js [--base=<ref>]
  node scripts/audit-new-gate-arming.js --help, -h    print this usage and exit
`;
if (hasHelpFlag(process.argv.slice(2))) { process.stdout.write(USAGE); process.exit(0); }

const WF = '.github/workflows/test.yml';
const git = (...a) => execFileSync('git', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
const tryGit = (...a) => { try { return git(...a); } catch { return null; } };

const arg = process.argv.slice(2).find(a => a.startsWith('--base='));
let base = (arg && arg.slice(7)) || process.env.GATE_ARM_BASE || '';
if (!base || /^0+$/.test(base)) {
  const head = tryGit('rev-parse', 'HEAD');
  const om = tryGit('rev-parse', 'origin/main');
  base = om && head && om.trim() !== head.trim() ? 'origin/main' : 'HEAD~1';
}
if (tryGit('rev-parse', '--verify', `${base}^{commit}`) === null) {
  console.log(`::warning::new-gate-arming: base '${base}' not resolvable (shallow clone?) — check SKIPPED`);
  process.exit(0);
}
const baseText = tryGit('show', `${base}:${WF}`);
if (baseText === null) {
  console.log(`::warning::new-gate-arming: ${WF} missing at base '${base}' — check SKIPPED`);
  process.exit(0);
}
const headText = tryGit('show', `HEAD:${WF}`) || '';
const changed = (tryGit('diff', '--name-only', base, 'HEAD') || '').split('\n').filter(Boolean);
const { violations } = findUnprovenNewGates({ baseText, headText, changedFiles: changed });
if (!violations.length) {
  console.log(`new-gate-arming: OK (no unproven new blocking gate in ${base}..HEAD)`);
  process.exit(0);
}
for (const v of violations) {
  console.log(`::error file=${WF}::New blocking gate "${v.name}" has no advisory mode or baseline.`);
}
console.log('Fix (BRO-2123): land the step with `continue-on-error: true` (promote to blocking in a later commit');
console.log('after one green run on main), OR include its baseline file in the same change, OR annotate the step');
console.log('`# gate-arm-ok: <run/command proving it passes on the live tree>`.');
process.exit(1);
