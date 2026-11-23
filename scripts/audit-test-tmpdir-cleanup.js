#!/usr/bin/env node
'use strict';
/**
 * BRO-8179: flag test files that create temp dirs (mkdtemp / mktemp -d) and
 * never remove anything. Those leaked ~200k dirs/day into /private/tmp.
 *
 *   node scripts/audit-test-tmpdir-cleanup.js            report (exit 0)
 *   node scripts/audit-test-tmpdir-cleanup.js --strict   exit 1 on a flagged
 *        file NOT in scripts/lib/test-tmpdir-cleanup-baseline.json
 *   node scripts/audit-test-tmpdir-cleanup.js --write-baseline
 *   node scripts/audit-test-tmpdir-cleanup.js --files a.test.mjs,b.test.js
 *
 * Fix a flagged file with makeTmpDir(t, prefix) from scripts/lib/test-tmpdir.js
 * (registers t.after rm -rf) or an explicit fs.rmSync in an after() hook.
 * Advisory in CI first (CLAUDE.md section 19).
 */
require('./lib/cli-help').exitOnHelp(module);
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { mkdtempWithoutCleanup } = require('./lib/test-tmpdir.js');

const ROOT = path.join(__dirname, '..');
const BASELINE = path.join(__dirname, 'lib', 'test-tmpdir-cleanup-baseline.json');
const TEST_RE = /\.test\.(?:m|c)?[jt]sx?$/;

function listTestFiles() {
  const out = execFileSync('git', ['-C', ROOT, 'ls-files'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return out.split('\n').filter((f) => TEST_RE.test(f) && !f.startsWith('node_modules/'));
}

function flagged(files) {
  return files.filter((f) => {
    let src;
    try { src = fs.readFileSync(path.resolve(ROOT, f), "utf8"); } catch { return false; }
    return mkdtempWithoutCleanup(src);
  }).sort();
}

function main(argv) {
  const filesArg = argv.includes('--files') ? argv[argv.indexOf('--files') + 1] : null;
  const files = filesArg ? filesArg.split(',').filter(Boolean) : listTestFiles();
  const hits = flagged(files);
  if (argv.includes('--write-baseline')) {
    fs.writeFileSync(BASELINE, `${JSON.stringify(hits, null, 2)}\n`);
    console.log(`wrote ${hits.length} entries to ${path.relative(ROOT, BASELINE)}`);
    return 0;
  }
  let baseline = [];
  try { baseline = JSON.parse(fs.readFileSync(BASELINE, 'utf8')); } catch { /* none */ }
  const known = new Set(baseline);
  const fresh = hits.filter((f) => !known.has(f));
  console.log(`test-tmpdir-cleanup: ${hits.length} test file(s) mkdtemp with no cleanup (${hits.length - fresh.length} baselined, ${fresh.length} new)`);
  for (const f of fresh) console.log(`  NEW ${f} — use makeTmpDir(t, prefix) from scripts/lib/test-tmpdir.js or rmSync in an after() hook`);
  return argv.includes('--strict') && fresh.length ? 1 : 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { flagged, main };
