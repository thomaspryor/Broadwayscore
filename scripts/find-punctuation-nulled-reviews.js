#!/usr/bin/env node
'use strict';

/**
 * BRO-4154: list review-text files nulled by the pre-fix (punctuation-
 * literal) show-mention matcher, so they can be targeted for recollection.
 * Prints one JSON object per line: {showId, file, url, incompleteReason}.
 *
 * Usage:
 *   node scripts/find-punctuation-nulled-reviews.js --review-texts-dir=DIR [--shows-json=FILE]
 */

const fs = require('fs');
const path = require('path');
const { findPunctuationNulledFiles } = require('./lib/punctuation-nulled-recollect');

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    const m = a.match(/^--([^=]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const reviewTextsDir = args['review-texts-dir'];
  if (!reviewTextsDir) {
    console.error('Usage: node scripts/find-punctuation-nulled-reviews.js --review-texts-dir=DIR [--shows-json=FILE]');
    process.exit(2);
  }
  const showsJsonPath = args['shows-json'] || path.join(__dirname, '..', 'data', 'shows.json');
  const raw = JSON.parse(fs.readFileSync(showsJsonPath, 'utf8'));
  const shows = Array.isArray(raw) ? raw : (raw.shows || []);
  const titlesById = new Map(shows.map((s) => [s.id, s.title]));

  const found = findPunctuationNulledFiles(reviewTextsDir, titlesById);
  for (const f of found) {
    console.log(JSON.stringify({ showId: f.showId, file: f.file, url: f.url, incompleteReason: f.incompleteReason }));
  }
  console.error(`\n${found.length} candidate file(s) found.`);
}

main();
