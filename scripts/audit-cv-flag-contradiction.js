#!/usr/bin/env node

/**
 * Standing CI check for the flag-vs-CV contradiction signal (#651, Notion
 * 3ad637c5). Previously this detector was computed exactly once, by hand, to
 * produce the pipeline-health audit — nothing re-ran it and nothing gated on
 * it. Scans review-text files for shows that opened in the last 30 days and
 * counts detectCvFlagContradiction() hits (scripts/lib/flag-contradiction.js):
 * an exclusion flag (wrongProduction/wrongShow/isRoundupArticle) sitting on a
 * file whose own most recent full-text contentVerification pass affirms it
 * (isValid, confidence 'high') at >300 words.
 *
 * A hit is bait for a human look, not proof of a false positive — CV is not
 * authoritative over the flags. The acceptance bar from the audit is that
 * fixing the 3 known root causes (national-tour adjudicator CV bypass, CV
 * wrongArticle->wrongShow misrouting, stale roundup flags) drives the count
 * on the 30-day window from 10 down under 4; --gate fails CI above that.
 *
 * Usage:
 *   node scripts/audit-cv-flag-contradiction.js               # report only
 *   node scripts/audit-cv-flag-contradiction.js --gate         # exit 1 if count >= threshold
 *   node scripts/audit-cv-flag-contradiction.js --gate --threshold=4
 *   node scripts/audit-cv-flag-contradiction.js --window=30    # days
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { detectCvFlagContradiction } = require('./lib/flag-contradiction');

const USAGE = `audit-cv-flag-contradiction.js — flag-vs-CV contradiction detector (#651)

Usage:
  node scripts/audit-cv-flag-contradiction.js [--gate] [--threshold=4] [--window=30]

  --gate         exit 1 when the contradiction count meets/exceeds --threshold
  --threshold=N  gate threshold (default 4 — the #651 acceptance bar)
  --window=N     only consider shows opened in the last N days (default 30)
`;

const ROOT = path.resolve(__dirname, '..');
const SHOWS_FILE = path.join(ROOT, 'data', 'shows.json');
const REVIEW_TEXTS_DIR = path.join(ROOT, 'data', 'review-texts');

function parseArgs(argv) {
  const args = { gate: false, threshold: 4, window: 30 };
  for (const a of argv) {
    if (a === '--gate') args.gate = true;
    else if (a.startsWith('--threshold=')) args.threshold = parseInt(a.split('=')[1], 10);
    else if (a.startsWith('--window=')) args.window = parseInt(a.split('=')[1], 10);
  }
  return args;
}

function main() {
  if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); return; }
  const args = parseArgs(process.argv.slice(2));

  const showsFile = JSON.parse(fs.readFileSync(SHOWS_FILE, 'utf8'));
  const shows = Array.isArray(showsFile) ? showsFile : showsFile.shows;
  const cutoff = Date.now() - args.window * 86400000;
  const recentShows = shows.filter((s) => {
    if (!s.openingDate) return false;
    const t = Date.parse(s.openingDate);
    return !Number.isNaN(t) && t >= cutoff;
  });

  const hits = [];
  for (const show of recentShows) {
    const showDir = path.join(REVIEW_TEXTS_DIR, show.id);
    let files;
    try {
      files = fs.readdirSync(showDir).filter((f) => f.endsWith('.json'));
    } catch {
      continue;
    }
    for (const file of files) {
      let data;
      try {
        data = JSON.parse(fs.readFileSync(path.join(showDir, file), 'utf8'));
      } catch {
        continue;
      }
      const contradiction = detectCvFlagContradiction(data);
      if (contradiction) {
        hits.push({ showId: show.id, file, ...contradiction });
      }
    }
  }

  console.log(`Flag-vs-CV contradiction sweep: ${recentShows.length} shows opened in the last ${args.window}d, ${hits.length} contradiction(s) found.`);
  for (const h of hits) {
    console.log(`  [${h.flag}] ${h.showId}/${h.file} (${h.wordCount}w) — CV: ${h.cvReasoning.slice(0, 140)}`);
  }

  if (args.gate && hits.length >= args.threshold) {
    console.error(`\nFAIL: ${hits.length} contradictions >= threshold ${args.threshold}.`);
    process.exit(1);
  }
}

main();
