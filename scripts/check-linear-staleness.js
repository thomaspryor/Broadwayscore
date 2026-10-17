#!/usr/bin/env node
/**
 * check-linear-staleness.js — re-fetch a Linear issue's CURRENT state before
 * proposing or executing a production-impacting action on it (BRO-3869).
 *
 * Run this — not a stale in-memory read of the issue from earlier in the
 * session — before: filing an incident card that proposes reverting
 * something, running a flag archive/restore, triggering a deploy, or
 * reporting a DECISION NEEDED that assumes the card's state hasn't moved
 * since you last looked at it. `linear-session.js report --since=` runs the
 * same check automatically at session close-out; this standalone CLI is for
 * the mid-session case — an action taken WHILE still working the card, not
 * only at the end.
 *
 * Usage:
 *   node scripts/check-linear-staleness.js --issue=BRO-3456 --since=<ISO8601>
 *
 * --since: when THIS session last knew the issue's state — its own claim
 * time or last read/comment on it. Not the issue's creation date.
 *
 * Exit codes:
 *   0 = clean — nothing changed since --since.
 *   2 = STALE — the issue moved without this session seeing it. Read the
 *       printed signals before acting; surface them to the owner rather
 *       than proceeding on the assumption nothing changed.
 *   1 = usage or network error.
 */

'use strict';

const linear = require('./lib/linear-client');
const { checkIssueStaleness } = require('./lib/linear-staleness-check');

const USAGE = 'Usage: node scripts/check-linear-staleness.js --issue=BRO-3456 --since=<ISO8601>';

function parseArgs(argv) {
  const args = {};
  for (const tok of argv) {
    if (!tok.startsWith('--')) continue;
    const eq = tok.indexOf('=');
    if (eq === -1) {
      args[tok.slice(2)] = true;
      continue;
    }
    args[tok.slice(2, eq)] = tok.slice(eq + 1);
  }
  return args;
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (!args.issue || !args.since) {
    console.error(USAGE);
    process.exit(1);
    return;
  }

  const issue = await linear.getIssue(args.issue);
  if (!issue) throw new Error(`No Linear issue found for "${args.issue}"`);

  const result = checkIssueStaleness(issue, args.since);
  console.log(
    JSON.stringify(
      { identifier: issue.identifier, stateName: issue.state && issue.state.name, ...result },
      null,
      2
    )
  );

  if (result.stale) {
    console.error(`\n⚠️  ${issue.identifier} changed since ${args.since} — do not act on stale context:`);
    for (const s of result.signals) console.error(`   - ${s.detail}`);
    process.exit(2);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { parseArgs, main };
