#!/usr/bin/env node
'use strict';

/**
 * BRO-4154: list review-text files nulled by the pre-fix (punctuation-
 * literal) show-mention matcher, so they can be targeted for recollection.
 * READ-ONLY: never writes to the review-texts checkout. Prints one
 * "showId/file  url" line per candidate (stdout) and a count (stderr).
 *
 * Usage:
 *   node scripts/find-punctuation-nulled-reviews.js [--dir=DIR] [--shows-json=FILE] [--out=PATH]
 *
 *   --dir=DIR         review-texts checkout (alias --review-texts-dir; default
 *                     $REVIEW_TEXTS_DIR, else data/review-texts)
 *   --shows-json=FILE shows.json (default data/shows.json)
 *   --out=PATH        also write the candidate list as JSON to PATH
 */

const fs = require('fs');
const path = require('path');
const { findPunctuationNulledFiles } = require('./lib/punctuation-nulled-recollect');
const { hasHelpFlag } = require('./lib/cli-help');

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    const m = a.match(/^--([^=]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

const USAGE = 'Usage: node scripts/find-punctuation-nulled-reviews.js [--dir=DIR] [--shows-json=FILE] [--out=PATH]';

function main() {
  if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); return; }
  const args = parseArgs(process.argv.slice(2));
  const reviewTextsDir = path.resolve(args.dir || args['review-texts-dir'] || process.env.REVIEW_TEXTS_DIR
    || path.join(__dirname, '..', 'data', 'review-texts'));
  if (!fs.existsSync(reviewTextsDir)) {
    console.error(`review-texts dir not found: ${reviewTextsDir}`);
    console.error('Usage: node scripts/find-punctuation-nulled-reviews.js [--dir=DIR] [--shows-json=FILE] [--out=PATH]');
    process.exit(2);
  }
  const showsJsonPath = args['shows-json'] || path.join(__dirname, '..', 'data', 'shows.json');
  const raw = JSON.parse(fs.readFileSync(showsJsonPath, 'utf8'));
  const shows = Array.isArray(raw) ? raw : (raw.shows || []);
  const titlesById = {};
  for (const s of shows) {
    if (s && s.id && s.title) titlesById[s.id] = s.title;
  }

  const found = findPunctuationNulledFiles(reviewTextsDir, titlesById);
  const toRow = (f) => ({
    showId: f.showId,
    file: f.file,
    path: `${f.showId}/${f.file}`,
    url: f.url,
    reason: f.reason,
  });
  const list = found.filter((f) => !f.triage).map(toRow);
  const triage = found.filter((f) => f.triage).map(toRow);
  for (const c of list) console.log(`${c.path}\t${c.url || ''}`);
  const stale = list.filter((c) => /showNotMentioned/.test(c.reason));
  if (stale.length) {
    console.error(`\nNOTE: ${stale.length} candidate(s) carry showNotMentioned; collect-review-texts.js skips those unless SERP finds a different URL. Clear that flag before re-collecting.`);
  }
  if (triage.length) {
    console.log(`\n# TRIAGE (not re-collection targets; check by hand): ${triage.length}`);
    for (const c of triage) console.log(`# ${c.path}\t${c.url || ''}\t${c.reason}`);
  }
  console.error(`\n${list.length} candidate file(s), ${triage.length} for triage, in ${reviewTextsDir}.`);

  if (args.out) {
    const outPath = path.resolve(args.out);
    if (outPath.startsWith(reviewTextsDir + path.sep)) {
      console.error('--out must not point inside the review-texts checkout (this script is read-only).');
      process.exit(2);
    }
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify({
      generatedAt: new Date().toISOString(),
      reviewTextsDir,
      count: list.length,
      candidates: list,
      triage,
    }, null, 2) + '\n');
    console.error(`Wrote ${outPath}`);
  }
}

main();
