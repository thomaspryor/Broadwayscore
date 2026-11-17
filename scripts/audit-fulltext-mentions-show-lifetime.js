#!/usr/bin/env node

'use strict';

const { runLifetimeSweep } = require('./lib/opening-night-checks/lifetime-sweep-runner.js');
const fulltextMentionsShow = require('./lib/opening-night-checks/fulltext-mentions-show.check.js');
const { summarizeFulltextHits, isContaminationEvidence } = require('./lib/opening-night-checks/fulltext-mention-triage.js');

process.exit(runLifetimeSweep({
  checkModule: fulltextMentionsShow,
  scriptName: 'audit-fulltext-mentions-show-lifetime.js',
  taskRef: '#1746, extending #1731\'s pattern',
  snapshotBasename: 'fulltext-mentions-show-lifetime.json',
  summarizeHits: summarizeFulltextHits,
  // BRO-7666: only wrong-production-flagged hits trip the digest row.
  isActionable: isContaminationEvidence,
  extraUsage: 'Catches the EBT-content-as-Schmig class: a shipped review-text file whose\nfullText never mentions the show it\'s attributed to.\n',
  argv: process.argv.slice(2),
}));
