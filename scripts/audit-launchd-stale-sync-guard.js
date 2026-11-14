#!/usr/bin/env node
/**
 * audit-launchd-stale-sync-guard.js — sweep for the swallowed-git-sync-
 * failure pattern (BRO-1794) across scripts actually invoked BY LAUNCHD on
 * a schedule: scripts/launchd/*.plist, every *.sh under scripts/local-
 * triggers/, and autonomous-nightly.sh. This is NOT a repo-wide sweep —
 * scripts with the same pattern that are manually/CLI-invoked (e.g.
 * scripts/newsletter/refresh-drafts.sh, a documented "LOCAL fast lane" a
 * human runs by hand, not launchd — confirmed by grepping its actual
 * launchd entrypoint, scripts/newsletter/sunday-review-launch.sh, which
 * never calls it) are a different risk class (a human notices a failed
 * run; an unattended chain doesn't) and are tracked separately (BRO-2254).
 * Widen the target list below if a script moves from manual to scheduled.
 *
 * Waiver: add a same-line trailing comment containing
 * `launchd-stale-sync-ok: <reason>` to mark a specific line reviewed-safe
 * (see scripts/lib/launchd-stale-sync-guard.js's WAIVER_RE).
 *
 * Exits 1 and lists offenders if any unsafe pattern remains in scope;
 * exits 0 if the scanned files are clean.
 *
 * Usage: node scripts/audit-launchd-stale-sync-guard.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { findUnsafeSyncPatterns, findUnsafeSyncPatternsInPlist } = require('./lib/launchd-stale-sync-guard.js');

const REPO_ROOT = path.join(__dirname, '..');

function listFiles(dir, ext) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names.filter((n) => n.endsWith(ext)).map((n) => path.join(dir, n));
}

function main() {
  const targets = [
    ...listFiles(path.join(REPO_ROOT, 'scripts/launchd'), '.plist'),
    ...listFiles(path.join(REPO_ROOT, 'scripts/local-triggers'), '.sh'),
    path.join(REPO_ROOT, 'scripts/autonomous-nightly.sh'),
  ].filter((f) => fs.existsSync(f));

  let offenders = [];
  for (const file of targets) {
    const text = fs.readFileSync(file, 'utf8');
    const rel = path.relative(REPO_ROOT, file);
    const findings = file.endsWith('.plist')
      ? findUnsafeSyncPatternsInPlist(text)
      : findUnsafeSyncPatterns(text);
    for (const f of findings) offenders.push({ file: rel, ...f });
  }

  if (offenders.length) {
    console.error('::error::launchd-stale-sync-guard: unsafe swallowed git-sync pattern found (BRO-1794 class — see scripts/lib/sync-audit-checkout.sh for the fix):');
    for (const o of offenders) {
      console.error(`  ${o.file}${o.line ? ':' + o.line : ''}: ${o.text}`);
    }
    process.exit(1);
  }

  console.log(`launchd-stale-sync-guard: clean — ${targets.length} launchd-scheduled file(s) scanned (scripts/launchd/, scripts/local-triggers/, autonomous-nightly.sh)`);
  process.exit(0);
}

main();
