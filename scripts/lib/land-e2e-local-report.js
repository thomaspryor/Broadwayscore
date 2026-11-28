#!/usr/bin/env node
'use strict';
// land-e2e-local-report.js (BRO-7106) — turns a Playwright JSON report into
// one `::error::e2e-local gate failed: <file> > <title path> (exit 1)` line
// per test whose final outcome is "unexpected". land-gate-delta.js keys
// e2e-local failures on exactly these lines (parseE2eLocalFailures), so the
// branch-vs-base diff compares tests, not exit codes. A test that passed on a
// retry is "flaky" and counts as a pass. Called by scripts/lib/land-e2e-local.sh.
//
// usage: node scripts/lib/land-e2e-local-report.js <report.json>
const fs = require('fs');

function failingTests(report) {
  const out = [];
  const walk = (suite, titles) => {
    const here = suite.title && !/\.(spec|test)\.[cm]?[jt]s$/.test(suite.title) ? [...titles, suite.title] : titles;
    for (const spec of suite.specs || []) {
      for (const t of spec.tests || []) {
        if (t.status === 'unexpected') {
          out.push({ file: spec.file || suite.file || '?', title: [...here, spec.title].join(' > ') });
        }
      }
    }
    for (const child of suite.suites || []) walk(child, here);
  };
  for (const s of (report && report.suites) || []) walk(s, []);
  return out;
}

function formatLines(fails) {
  // Sorted and de-duplicated so the same failures always print the same way.
  const lines = [...new Set(fails.map((f) => `::error::e2e-local gate failed: ${f.file} > ${f.title} (exit 1)`))];
  return lines.sort();
}

function main(argv = process.argv.slice(2)) {
  const file = argv[0];
  if (!file) { console.error('usage: land-e2e-local-report.js <report.json>'); return 2; }
  let report;
  try { report = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
    console.log(`e2e-local: no readable Playwright JSON report at ${file} (${e.code || e.message})`);
    return 1;
  }
  const lines = formatLines(failingTests(report));
  for (const l of lines) console.log(l);
  const st = report.stats || {};
  console.log(`e2e-local: expected=${st.expected ?? '?'} unexpected=${st.unexpected ?? '?'} flaky=${st.flaky ?? '?'} skipped=${st.skipped ?? '?'}`);
  return 0;
}

module.exports = { failingTests, formatLines };
if (require.main === module) process.exitCode = main();
