#!/usr/bin/env node
// scripts/test-data-write-guard.js — CLI wrapper for
// scripts/lib/test-data-write-guard.js. Scans tests/**/*.{mjs,ts,js} plus
// colocated scripts/**/*.test.{mjs,ts,js} (CLAUDE.md rule 15's convention —
// the same anti-pattern can land in a scripts/lib/*.test.mjs colocated test,
// not just under tests/) for writeFileSync/renameSync/copyFileSync calls
// that target a real tracked data/*.json path instead of a tmp()/mkdtemp()
// fixture, and exits non-zero with file:line on a match. See task #1662.

'use strict';

// glob (not node:fs's globSync) — globSync was added in Node 22 and this
// repo's CI pins Node 20 for the jobs that run this script (test.yml's
// "Lint Workflows" and "Unit Tests" jobs). Every other script in this repo
// that needs globbing already uses the `glob` package for the same reason
// (scripts/reconcile-scores.js, scripts/flag-bw-v6-decompression.js).
const glob = require('glob');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { findUnsafeDataWrites } = require('./lib/test-data-write-guard.js');

const ROOT = join(__dirname, '..');

// This guard's own acceptance test embeds synthetic bad-fixture source text
// (as JS string literals) that reproduces the exact patterns being detected
// — scanning it as if it were real test code would self-flag. Exempt by
// exact path, same as infra-review-scope.js exempting its own gate/test.
const SELF_EXEMPT_RE = /(?:^|\/)scripts\/tests\/test-data-write-guard\.test\.mjs$/;

function main() {
  // nodir: true — Playwright snapshot dirs (e.g.
  // tests/e2e/__screenshots__/.../foo.spec.ts/) are directories that share a
  // test file's basename and would otherwise match the glob.
  const patterns = ['tests/**/*.{mjs,ts,js}', 'scripts/**/*.test.{mjs,ts,js}'];
  const files = [...new Set(patterns.flatMap((p) => glob.sync(p, { cwd: ROOT, nodir: true })))]
    .map((f) => join(ROOT, f))
    .filter((f) => !SELF_EXEMPT_RE.test(f.slice(ROOT.length + 1)));

  const allFindings = [];
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    const findings = findUnsafeDataWrites(source);
    for (const finding of findings) {
      allFindings.push({ file: file.slice(ROOT.length + 1), ...finding });
    }
  }

  if (allFindings.length === 0) {
    console.log(`test-data-write-guard: clean (${files.length} test files scanned)`);
    return 0;
  }

  console.error(`test-data-write-guard: ${allFindings.length} unsafe write(s) found\n`);
  for (const f of allFindings) {
    console.error(`  ${f.file}:${f.line}  ${f.fn}(...) targets real tracked path: ${f.target}`);
    console.error(`    ${f.snippet}\n`);
  }
  console.error(
    'A test wrote to a real tracked data/*.json path instead of a tmp()/mkdtemp() fixture.\n' +
    'This races ~20 parallel sessions + CI that write these files on their own cadence\n' +
    '(see task #1649 / #1662). Use mkdtempSync() + a throwaway copy instead — see\n' +
    'tests/unit/validate-data-push-refusal-sentinel.test.mjs for the pattern.'
  );
  return 1;
}

if (require.main === module) {
  process.exit(main());
}

module.exports = { main };
