#!/usr/bin/env node
'use strict';

/**
 * Day-level merge of data/audit/exclusion-daily-totals.json for the autostash
 * restore (autostash=latest-wins, BRO-4688). The writer prints one day per
 * line, which json-three-way-merge.js refuses to rewrite, so this file takes
 * its own merge: the union of both sides' days, and for a day both sides hold,
 * ours (this run's fresh, uncommitted snapshot) wins, matching the writer's own
 * rule "latest run of a day wins". Old days fall off through the writer's
 * mergeDailyTotals keep-days prune.
 *
 * CLI: node merge-daily-totals.js <ours> <theirs> <out>
 *   Writes <out> and exits 0; exits 1 on any read/parse error.
 */

const fs = require('fs');
const { mergeDailyTotals, serializeDailyTotals } = require('./rebuild-exclusion-audit.js');

function readDays(p) {
  const doc = JSON.parse(fs.readFileSync(p, 'utf8'));
  if (!doc || typeof doc.days !== 'object' || !doc.days || Array.isArray(doc.days)) throw new Error('no days object');
  return doc;
}

// Pure: ours wins a shared day; every other day from either side is kept.
function mergeDays(ours, theirs) {
  let doc = { days: { ...theirs.days } };
  for (const day of Object.keys(ours.days).sort()) doc = mergeDailyTotals(doc, day, ours.days[day]);
  return doc;
}

function main(argv) {
  const [oursP, theirsP, outP] = argv;
  if (!outP) return 1;
  try {
    fs.writeFileSync(outP, serializeDailyTotals(mergeDays(readDays(oursP), readDays(theirsP))));
    return 0;
  } catch {
    return 1;
  }
}

module.exports = { mergeDays };

if (require.main === module) require('./exit-flushed.js').exitFlushed(main(process.argv.slice(2)));
