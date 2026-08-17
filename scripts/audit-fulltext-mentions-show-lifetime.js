#!/usr/bin/env node

'use strict';

const { runLifetimeSweep } = require('./lib/opening-night-checks/lifetime-sweep-runner.js');
const fulltextMentionsShow = require('./lib/opening-night-checks/fulltext-mentions-show.check.js');

process.exit(runLifetimeSweep({
  checkModule: fulltextMentionsShow,
  scriptName: 'audit-fulltext-mentions-show-lifetime.js',
  taskRef: '#1746, extending #1731\'s pattern',
  snapshotBasename: 'fulltext-mentions-show-lifetime.json',
  extraUsage: 'Catches the EBT-content-as-Schmig class: a shipped review-text file whose\nfullText never mentions the show it\'s attributed to.\n',
  argv: process.argv.slice(2),
}));
