#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help');
const { resolveReviewTextsDir } = require('./lib/review-texts-dir');
const { createRunBudget, parseTimeBudgetMin } = require('./lib/run-budget');
const { retryEmptyBodyReviews } = require('./lib/empty-body-retry');

async function main(args = process.argv.slice(2)) {
  if (hasHelpFlag(args)) {
    console.log('Usage: node scripts/retry-empty-body-reviews.js [--show=ID | --shows=ID1,ID2] [--dry-run] [--time-budget-min=N]\nRetries at most 10 empty-body stubs per run, with a 6-hour cooldown. Default budget: 2 minutes.');
    return;
  }
  const show = args.find(arg => arg.startsWith('--show='))?.slice(7);
  const ids = args.find(arg => arg.startsWith('--shows='))?.slice(8);
  const data = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/shows.json'), 'utf8'));
  const root = resolveReviewTextsDir();
  console.log(`Review texts: ${root}`);
  await retryEmptyBodyReviews({ root, shows: data.shows || data,
    showIds: show ? [show] : ids?.split(',').filter(Boolean),
    dryRun: args.includes('--dry-run'), budget: createRunBudget(parseTimeBudgetMin(args) || 2) });
}

module.exports = { main, retryEmptyBodyReviews };
if (require.main === module) {
  main().catch(() => {
    console.error('Empty-body retry failed; check the review-texts directory and shows.json.');
    process.exitCode = 1;
  }).finally(() => require('./lib/scraper').cleanup());
}
