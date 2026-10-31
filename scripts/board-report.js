#!/usr/bin/env node
/**
 * board-report.js (BRO-6442): the standard board report. Every open card in
 * exactly one category, the same table sessions paste to the owner and the
 * morning email shows. A printer only: the rules live in
 * scripts/lib/board-categories.js.
 *
 *   node scripts/board-report.js --markdown            # the owner table (default)
 *   node scripts/board-report.js --json [--save=FILE]  # full report (cards included)
 *   node scripts/board-report.js --compare=FILE        # before/after vs a saved --json
 *
 * Exit 0 ok, 1 Linear failed or the categorizer invariant broke, 2 bad usage.
 */
'use strict';
const fs = require('fs');
const { hasHelpFlag } = require('./lib/cli-help.js');
const bc = require('./lib/board-categories.js');

const USAGE = 'Usage: node scripts/board-report.js [--markdown | --json | --compare=<saved.json>] [--save=<file>]';

async function main(argv = process.argv.slice(2), { graphql = null, now = new Date(), log = console.log } = {}) {
  if (hasHelpFlag(argv)) { log(USAGE); return 0; }
  const opts = bc.parseReportArgs(argv);
  if (opts.error) { console.error(`${opts.error}\n${USAGE}`); return 2; }
  let prev = null;
  if (opts.compare) {
    try { prev = JSON.parse(fs.readFileSync(opts.compare, 'utf8')); } catch (err) {
      console.error(`could not read ${opts.compare}: ${err.message}`);
      return 2;
    }
  }
  const gql = graphql || require('./lib/linear-client.js').graphql;
  let report;
  let flow = null;
  try {
    const [issues, f] = await Promise.all([
      bc.fetchOpenBoard({ graphql: gql }),
      bc.fetchFlow24h({ graphql: gql, now }).catch((err) => { console.error(`[board-report] WARN 24h flow unavailable: ${err.message}`); return null; }),
    ]);
    flow = f;
    report = bc.categorizeBoard(issues, { now, secret: process.env.APPROVAL_HMAC_SECRET || null });
  } catch (err) {
    console.error(`[board-report] FAILED: ${err.message}`);
    return 1;
  }
  // A card the categorizer could not read lands in Other; say so instead of hiding it in a normal table.
  const broken = report.cards.filter((c) => /^categorize-error/.test(c.reason || ''));
  if (broken.length) console.error(`[board-report] WARN ${broken.length} card(s) could not be categorized (counted under Other): ${broken.slice(0, 5).map((c) => `${c.identifier} ${c.reason}`).join('; ')}`);
  const full = { ...report, flow };
  if (opts.save) fs.writeFileSync(opts.save, `${JSON.stringify(full, null, 2)}\n`);
  if (opts.mode === 'json') log(JSON.stringify(full, null, 2));
  else if (opts.mode === 'compare') log(bc.formatCompareMarkdown(bc.compareReports(prev, report)));
  else log(bc.formatMarkdown(report, { flow }));
  return 0;
}

if (require.main === module) main().then((code) => { process.exitCode = code; });

module.exports = { main };
