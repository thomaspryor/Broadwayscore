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
  argv: process.argv.slice(2),
}));
