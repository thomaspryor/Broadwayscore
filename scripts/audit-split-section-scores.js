#!/usr/bin/env node
/**
 * audit-split-section-scores.js — find multi-show split sections whose score may
 * rest on a misread back-reference (BRO-6000). Read-only.
 *
 * A section cut from a joint article can open on "I don't recommend that
 * approach for the other production", whose antecedent was removed with the
 * other show's section. Two of three ensemble models can read that as a pan and
 * the majority branch then publishes a Negative score the text does not support.
 *
 * USAGE (cloud: via scripts/cloud-run-script.js --review-texts):
 *   node scripts/audit-split-section-scores.js [--json] [--all] [--max=N]
 *     default lists suspects only; --all lists every scored split section.
 *
 * Output has the show, file, scores and the opening sentence; the opening
 * sentence is review text, so run it through the sealed cloud runner and never
 * paste the output into a plan, card or commit.
 */
const fs = require('fs');
const path = require('path');
const { scanReviewTexts } = require('./lib/split-section-audit');
const { hasHelpFlag } = require('./lib/cli-help.js');

const ROOT = process.env.REVIEW_TEXTS_DIR || path.join(__dirname, '..', 'data', 'review-texts');

function main(argv) {
  if (hasHelpFlag(argv)) {
    console.log('usage: node scripts/audit-split-section-scores.js [--json] [--all] [--max=N]');
    return 0;
  }
  const asJson = argv.includes('--json');
  const all = argv.includes('--all');
  const maxArg = argv.find((a) => a.startsWith('--max='));
  const max = maxArg ? parseInt(maxArg.slice(6), 10) : 200;
  if (!fs.existsSync(ROOT)) {
    console.error(`review-texts not found at ${ROOT}`);
    return 3;
  }
  const scan = scanReviewTexts(ROOT);
  const sections = scan.sections;
  const rows = scan.rows.filter((r) => all || r.suspect);
  rows.sort((a, b) => (b.suspect - a.suspect) || (a.score - b.score));
  if (asJson) {
    console.log(JSON.stringify({ sections, listed: rows.length, rows: rows.slice(0, max) }, null, 1));
    return 0;
  }
  console.log(`split sections with a score: ${sections}; listed: ${rows.length}${all ? ' (all)' : ' (suspects)'}`);
  for (const r of rows.slice(0, max)) {
    console.log(`${r.suspect ? 'SUSPECT' : 'ok     '} ${r.file} score=${r.score} claude=${r.claude} others=[${r.others.join(',')}] lead=${r.claudeLead} dangling=${r.danglingLead}`);
    if (r.why.length) console.log(`         why: ${r.why.join('; ')}`);
    console.log(`         opens: ${r.lead}`);
  }
  return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { main };
