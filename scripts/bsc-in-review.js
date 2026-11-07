#!/usr/bin/env node
/**
 * bsc-in-review — what is sitting finished-and-unread in Linear's `In Review`
 * state right now.
 *
 * The sibling of bsc-needs-you.js, and the gap that file did NOT cover:
 * bsc-needs-you reads cmux TAB state (a ❓ mark a session's Stop hook wrote),
 * so it dies with the tab and only ever sees decisions a session announced.
 * `In Review` is issue-scoped, survives the session, and is where every
 * correctly-behaved dispatched worker parks when it finishes — so it is where
 * finished work actually accumulates. On 2026-09-15 that was 120 real issues,
 * 100 of them idle 14+ days, 8 Urgent, with nothing reading the state at all.
 *
 * Read-only. Never closes, comments on, or dispatches anything.
 *
 *   bsc-in-review              print the backlog, urgent first then oldest
 *   bsc-in-review --all        print every row, not just the digest's top slice
 *   bsc-in-review --json       machine-readable
 *   bsc-in-review --help       usage only, no network call
 */
'use strict';

const { hasHelpFlag } = require('./lib/cli-help.js');
const { buildInReviewRows, buildInReviewSection, IDLE_AFTER_MS } = require('./lib/in-review-backlog.js');

const USAGE = `bsc-in-review — Linear issues parked in "In Review" (finished, nobody has looked).

Usage:
  bsc-in-review            the digest's view: count + the rows that earn a line
  bsc-in-review --all      every idle row, not just the top slice
  bsc-in-review --json     machine-readable
  bsc-in-review --help     show this message, make no network call

Read-only: never closes, comments on, or dispatches anything.
`;

async function main(argv = process.argv.slice(2)) {
  if (hasHelpFlag(argv)) { console.log(USAGE); return 0; }
  const asJson = argv.includes('--json');
  const all = argv.includes('--all');

  const linear = require('./lib/linear-client.js');
  let issues;
  try {
    issues = await linear.listOpenIssues();
  } catch (err) {
    // Same fail-soft posture as the digest section: a Linear outage is not a
    // reason for this to look like "nothing is parked".
    console.error(`bsc-in-review: could not reach Linear — ${String(err.message).slice(0, 160)}`);
    return 2;
  }

  const section = buildInReviewSection(issues, all ? { maxRows: Number.MAX_SAFE_INTEGER } : {});
  if (asJson) {
    console.log(JSON.stringify(section || { bannerText: null, items: [], moreCount: 0 }, null, 2));
    return 0;
  }
  if (!section) {
    const rows = buildInReviewRows(issues);
    console.log(
      rows.length
        ? `Nothing parked past ${Math.round(IDLE_AFTER_MS / 86400000)}d (${rows.length} in In Review, all recent).`
        : 'Nothing is parked in In Review.'
    );
    return 0;
  }
  console.log(`${section.bannerText}\n`);
  for (const item of section.items) {
    console.log(`  ${item.title}`);
    console.log(`      ${item.detail}  ${item.url}\n`);
  }
  if (section.moreCount > 0) console.log(`  +${section.moreCount} more — re-run with --all`);
  return 0;
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }).catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}

module.exports = { main, USAGE };
