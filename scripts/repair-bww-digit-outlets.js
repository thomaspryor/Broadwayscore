#!/usr/bin/env node
/**
 * BRO-4371: repair bwwExcerpt/fullText fields that the BWW roundup parser cut at a
 * digit-leading outlet name ("5 Boroughs ..."). Clean text comes from the private
 * aggregator archive, so the write has to run in CI (execute-approved-fix.yml run-script).
 *
 * Dry run unless --write. With --write, --expect=N is required and the script exits
 * nonzero unless exactly N files were repaired and none was skipped or refused by the
 * write guard, so a silent partial repair cannot be recorded as applied. Files written
 * before a failure are still pushed by the workflow, and the plan is then marked partial.
 * Output is paths and lengths only, never review text.
 */
const path = require('path');
const { makeArchiveShowChecker } = require('./lib/archive-cache-guard');
const { loadShows } = require('./lib/show-matching');
const { repairBwwDigitOutlets } = require('./lib/bww-digit-outlet-audit');
const { evaluateRepairReport } = require('./lib/bww-digit-outlet-repair-check');

function main(argv = process.argv.slice(2)) {
  const write = argv.includes('--write');
  const expectArg = argv.find(a => a.startsWith('--expect='));
  const expect = expectArg ? Number(expectArg.slice('--expect='.length)) : null;
  if (write && !(Number.isInteger(expect) && expect > 0)) throw new Error('--write requires --expect=N with N > 0');
  const report = repairBwwDigitOutlets({
    archiveDir: path.join(__dirname, '../data/aggregator-archive/bww-roundups'),
    reviewDir: path.join(__dirname, '../data/review-texts'),
    checkArchive: makeArchiveShowChecker(loadShows()),
    write,
  });
  console.log(JSON.stringify(report, null, 2));
  const problem = evaluateRepairReport(report, { write, expect });
  if (problem) {
    console.error(`FAIL: ${problem}`);
    process.exit(1);
  }
}

if (require.main === module) main();
