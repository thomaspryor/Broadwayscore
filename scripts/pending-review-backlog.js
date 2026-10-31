#!/usr/bin/env node
/**
 * BRO-6336: print the commercial pending-review backlog (count + age of the oldest entry) and add it to the
 * job summary. Read-only; never fails the job (a number to look at, not a gate).
 *
 *   node scripts/pending-review-backlog.js [--file=PATH] [--warn-days=30]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { pendingBacklogStats, formatBacklogLine } = require('./lib/pending-review-backlog');

const args = process.argv.slice(2);
if (hasHelpFlag(args)) {
  console.log('pending-review-backlog.js [--file=PATH] [--warn-days=N]\nPrints how many commercial pending-review entries wait and how old the oldest is.');
  process.exit(0);
}
const opt = (name) => { const a = args.find((x) => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : null; };
const file = opt('file') || path.join(__dirname, '..', 'data', 'commercial-pending-review.json');
const warnDays = Number(opt('warn-days') || 30);

let stats;
try {
  stats = pendingBacklogStats(JSON.parse(fs.readFileSync(file, 'utf8')));
} catch (err) {
  console.log(`Pending-review backlog: could not read ${path.basename(file)} (${err.message}).`);
  process.exit(0);
}
let line = formatBacklogLine(stats);
if (stats.oldestAgeDays != null && stats.oldestAgeDays > warnDays) line += ` Oldest is past ${warnDays} days: review the queue.`;
console.log(line);
if (process.env.GITHUB_STEP_SUMMARY) {
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Commercial pending-review backlog\n\n${line}\n`);
}
