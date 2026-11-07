'use strict';
// scripts/lib/digest-handoff.js — which machine sends the owner's morning email today (BRO-6764).
// One committed date, config/morning-digest-handoff.json. Before it the Mac's launchd job sends; on or
// after it the GitHub Action sends and the Mac runs autofix + canary only and sends nothing. Pure apart from the file read.
const fs = require('fs');
const path = require('path');
const { dayKeyET } = require('./scheduled-email-count-rules');

// DIGEST_HANDOFF_FILE is a test seam only.
const FILE = process.env.DIGEST_HANDOFF_FILE || path.join(__dirname, '..', '..', 'config', 'morning-digest-handoff.json');

function handoffDate(file = FILE) {
  const d = JSON.parse(fs.readFileSync(file, 'utf8')).handoffDate;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new Error(`bad handoffDate "${d}" in ${file}`);
  return d;
}

// True once the Action owns the owner email for this ET day. now: Date.
function actionOwnsToday(now = new Date(), file = FILE) {
  return dayKeyET(now.toISOString()) >= handoffDate(file);
}

module.exports = { FILE, handoffDate, actionOwnsToday };
