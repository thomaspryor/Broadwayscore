#!/usr/bin/env node

'use strict';

const { runLifetimeSweep } = require('./lib/opening-night-checks/lifetime-sweep-runner.js');
const revivalUnverified = require('./lib/opening-night-checks/revival-unverified.check.js');

process.exit(runLifetimeSweep({
  checkModule: revivalUnverified,
  scriptName: 'audit-revival-unverified-lifetime.js',
  taskRef: '#1746, extending #1731\'s pattern',
  snapshotBasename: 'revival-unverified-lifetime.json',
  extraUsage: 'Catches isRevival flag correctness: a show shares a canonical title with an\nearlier production, or its review text repeatedly says "revival", but\nisRevival is not set. This check\'s own severity is always \'warning\' (never\n\'error\') — isRevival affects scoring, so a heuristic must not auto-flip it;\nthat warning IS the actionable signal here, unlike the other 3 lifetime\nsweeps in this family which only count \'error\'. NOTE: revival-unverified.check.js\nitself unconditionally skips status===\'closed\' shows (SKIP_STATUSES) — that\nskip is the check\'s own design, not a "lifetime" limitation added here, but it\nmeans a closed show\'s isRevival flag is never re-verified by this sweep either\n(ship-check finding, task #1746).\n',
  countSeverities: ['warning'],
  needsShows: true,
  argv: process.argv.slice(2),
}));
