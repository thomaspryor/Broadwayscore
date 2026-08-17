#!/usr/bin/env node

'use strict';

const { runLifetimeSweep } = require('./lib/opening-night-checks/lifetime-sweep-runner.js');
const slugMismatch = require('./lib/opening-night-checks/slug-mismatch.check.js');

process.exit(runLifetimeSweep({
  checkModule: slugMismatch,
  scriptName: 'audit-slug-mismatch-lifetime.js',
  taskRef: '#1746, extending #1731\'s pattern',
  snapshotBasename: 'slug-mismatch-lifetime.json',
  extraUsage: 'Catches cross-show URL contamination: a shipped review\'s URL never mentions\nthe show\'s slug or any known alias.\n',
  // slug-mismatch.check.js's result shape uses details.mismatches, not the
  // details.violations shape fulltext-mentions-show/roundup-url-mismatch use
  // — the runner's default would silently collapse all of a show's mismatches
  // into one bogus violation. Verified against real data (hamilton-2015 has
  // 3 distinct URL mismatches; the default handler reported 1 until fixed).
  extractViolations: (result) => (result.details && result.details.mismatches) || [],
  violationKey: (showId, v) => v.url ? `${showId}::${v.url}` : showId,
  argv: process.argv.slice(2),
}));
