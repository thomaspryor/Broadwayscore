#!/usr/bin/env node
/**
 * BRO-6336: archive reviewed commercial pending-review entries with an outcome and a reason.
 *
 *   node scripts/review-pending-commercial.js --decisions=<file.json> [--dry-run]
 *
 * <file.json> is { "<pending key>": { "outcome": "applied|rejected|duplicate|unverifiable", "reason": "..." } }.
 * Writes data/commercial-pending-review.json and data/commercial-pending-archive.json only.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { applyDecisions, decisionProblems } = require('./lib/pending-review-decisions');
const { buildShowKeyIndex, resolveCommercialSlug } = require('./lib/commercial-slug-key');

const args = process.argv.slice(2);
if (hasHelpFlag(args)) {
  console.log('review-pending-commercial.js --decisions=<file.json> [--dry-run]\nMoves reviewed pending-review entries to the archive with an outcome and reason.');
  process.exit(0);
}
const opt = (name) => { const a = args.find((x) => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : null; };
const decisionsPath = opt('decisions');
if (!decisionsPath) { console.error('--decisions=<file.json> is required'); process.exit(2); }
const dryRun = args.includes('--dry-run');

const DATA = path.join(__dirname, '..', 'data');
const PENDING = path.join(DATA, 'commercial-pending-review.json');
const ARCHIVE = path.join(DATA, 'commercial-pending-archive.json');
const pending = JSON.parse(fs.readFileSync(PENDING, 'utf8'));
const archive = JSON.parse(fs.readFileSync(ARCHIVE, 'utf8'));
const decisions = JSON.parse(fs.readFileSync(path.resolve(decisionsPath), 'utf8'));

const problems = decisionProblems(pending, decisions);
if (problems.length) { console.error(problems.join('\n')); process.exit(1); }

const shows = JSON.parse(fs.readFileSync(path.join(DATA, 'shows.json'), 'utf8')).shows;
const index = buildShowKeyIndex(shows);
const { moved, counts } = applyDecisions({
  pending, archive, decisions,
  slugFor: (key, entry) => resolveCommercialSlug(key, entry, index).slug,
  reviewedBy: 'BRO-6336',
});
console.log(`${dryRun ? '[dry run] would move' : 'moved'} ${moved} entries to the archive:`, JSON.stringify(counts), `(${Object.keys(pending.shows).length} left pending)`);
if (!dryRun && moved) {
  for (const [file, data] of [[ARCHIVE, archive], [PENDING, pending]]) {
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(data, null, 2) + '\n');
    fs.renameSync(`${file}.tmp`, file);
  }
}
