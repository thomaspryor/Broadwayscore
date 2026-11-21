#!/usr/bin/env node
/**
 * audit-launchd-plist-path.js — fail when a scripts/launchd/*.plist runs a bare
 * `node`/`npx`/`gh`/... with no PATH and no login shell (exit 127 under launchd,
 * which is how the WSJ monthly cookie refresh silently never ran). The rule and
 * its waiver live in scripts/lib/launchd-plist-lint.js.
 *
 * Advisory in test.yml first (CLAUDE.md rule 19): `continue-on-error: true`.
 *
 * Usage: node scripts/audit-launchd-plist-path.js [--dir=<plist dir>]
 * Exit:  0 clean, 1 offenders listed.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { findBareCommandsWithoutPath } = require('./lib/launchd-plist-lint.js');

function main() {
  const dirArg = process.argv.find((a) => a.startsWith('--dir='));
  const dir = dirArg ? dirArg.slice('--dir='.length) : path.join(__dirname, 'launchd');
  const files = fs.readdirSync(dir).filter((n) => n.endsWith('.plist')).sort();

  const offenders = [];
  for (const name of files) {
    const text = fs.readFileSync(path.join(dir, name), 'utf8');
    for (const f of findBareCommandsWithoutPath(text)) offenders.push({ file: name, ...f });
  }

  if (offenders.length) {
    console.error('::error::launchd-plist-path: plist runs a bare command with no PATH (launchd PATH is /usr/bin:/bin:/usr/sbin:/sbin, so it exits 127). Add EnvironmentVariables.PATH with /opt/homebrew/bin, use `bash -lc`, or an absolute path:');
    for (const o of offenders) console.error(`  ${o.file}: runs bare \`${o.command}\`: ${o.text.slice(0, 160)}`);
    process.exit(1);
  }
  console.log(`launchd-plist-path: clean, ${files.length} plist(s) scanned in ${dir}`);
}

main();
