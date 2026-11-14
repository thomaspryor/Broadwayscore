#!/usr/bin/env node

'use strict';

const { runLifetimeSweep } = require('./lib/opening-night-checks/lifetime-sweep-runner.js');
const roundupUrlMismatch = require('./lib/opening-night-checks/roundup-url-mismatch.check.js');

process.exit(runLifetimeSweep({
  checkModule: roundupUrlMismatch,
  scriptName: 'audit-roundup-url-mismatch-lifetime.js',
  taskRef: '#1746, extending #1731\'s pattern',
  snapshotBasename: 'roundup-url-mismatch-lifetime.json',
  extraUsage: 'Catches cross-show BWW roundup attribution: a shipped review-text file whose\nbwwRoundupUrl points to a different show\'s slug.\n',
  // roundup-url-mismatch.check.js's result shape uses details.mismatches, not
  // the details.violations shape fulltext-mentions-show uses — the runner's
  // default would silently collapse all of a show's mismatches into one
  // bogus violation, keyed only by showId (same bug caught and fixed in
  // audit-slug-mismatch-lifetime.js's wrapper; ship-check/Codex adversarial
  // review caught this one had been missed here).
  // Default violationKey already handles v.filename correctly (present on
  // every roundup mismatch object) — no override needed, unlike slug-mismatch
  // whose mismatch objects key on `url` instead.
  extractViolations: (result) => (result.details && result.details.mismatches) || [],
  argv: process.argv.slice(2),
}));
