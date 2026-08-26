#!/usr/bin/env node

/**
 * Audit exclusion flags for stale-data drift (BRO-57).
 *
 * Ticket scope: isNonReview essay-intro false positives — genuine reviews
 * that open with a long bio/personal-essay intro (house style at some
 * outlets) before ever mentioning the show, which trips the gemini classifier
 * in classify-non-reviews.js into stamping isNonReview:true with a soft type
 * ('preview'/'interview'/'profile'/'bio'/'news_article'). Two confirmed
 * instances (86-88 scored reviews, silently excluded) were manually cleared
 * 2026-07-19 — see scripts/lib/essay-intro-nonreview-fp.js for the exact
 * predicate their manual verification generalized into.
 *
 * wrongShow/wrongProduction/wrongAttribution already have dedicated audits
 * (audit-wrongshow-autoclear-conflicts.js, isStaleCvPromotedWrongProduction/
 * isStaleCvPromotedWrongShow in review-guards.js, audit-cross-outlet-
 * attributions.js) — this script is scoped to the isNonReview gap the ticket's
 * evidence section identifies as unaudited.
 *
 * Default mode is report-only (matches audit-nonreview-cv-conflict.js
 * convention) — clearing an exclusion flag is a one-way trust decision, so
 * writes require --apply. On --apply, a match is cleared exactly like the two
 * ground-truth files:
 *   isNonReview: false, nonReviewManualClear: true (lock — classify-non-
 *   reviews.js skips files with this flag on every future run), plus a
 *   contentVerification stamp recording why.
 *
 * Usage:
 *   node scripts/audit-exclusion-flags.js                  # report, exits 0
 *   node scripts/audit-exclusion-flags.js --apply           # clear matches
 *   node scripts/audit-exclusion-flags.js --show=ID
 *   node scripts/audit-exclusion-flags.js --gate --max=10
 *   node scripts/audit-exclusion-flags.js --json
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { detectEssayIntroFalsePositive } = require('./lib/essay-intro-nonreview-fp');
const { assertCorpusScanned, CorpusNotScannedError } = require('./lib/corpus-scan-guard');
const { parseMaxArgOrExit } = require('./lib/parse-max-arg.js');
const { safeWriteReview } = require('./lib/review-write-guard');

const USAGE = `audit-exclusion-flags.js — sweep isNonReview:true files for the essay-intro false-positive class (BRO-57)

Usage:
  node scripts/audit-exclusion-flags.js [--apply] [--show=ID] [--gate] [--max=10] [--json]

  --apply     write the clear (isNonReview=false, nonReviewManualClear=true) to matched files.
              Default is report-only.
  --show=ID   scope the sweep to one show directory
  --gate      exit 1 when the match count exceeds --max (informational — not wired into CI)
  --max=N     ceiling for --gate (default 10)
  --json      machine-readable output
`;

const ROOT = path.resolve(__dirname, '..');
const REVIEW_TEXTS_DIR = path.join(ROOT, 'data', 'review-texts');
const AUDIT_DIR = path.join(ROOT, 'data', 'audit');
const LOG_PATH = path.join(AUDIT_DIR, 'exclusion-flags-audit.json');

const SKIP_DIRS = new Set(['_pending', '_superseded-misattributed']);

function parseArgs(argv) {
  const args = {
    apply: argv.includes('--apply'),
    gate: argv.includes('--gate'),
    json: argv.includes('--json'),
    show: null,
    max: parseMaxArgOrExit(argv, { defaultMax: 10, scriptName: 'audit-exclusion-flags' }),
  };
  for (const a of argv) {
    if (a.startsWith('--show=')) args.show = a.split('=')[1];
  }
  return args;
}

function listShowDirs(showFilter) {
  let entries;
  try {
    entries = fs.readdirSync(REVIEW_TEXTS_DIR, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() || e.isSymbolicLink())
    .map((e) => e.name)
    .filter((name) => !SKIP_DIRS.has(name))
    .filter((name) => !showFilter || name === showFilter)
    .filter((name) => {
      try { return fs.statSync(path.join(REVIEW_TEXTS_DIR, name)).isDirectory(); }
      catch { return false; }
    });
}

function applyClear(data, match) {
  const now = new Date().toISOString();
  data.isNonReview = false;
  data.nonReviewManualClear = true;
  data.contentVerification = Object.assign({}, data.contentVerification, {
    isValid: true,
    confidence: 'high',
    verifiedBy: 'audit-exclusion-flags:essay-intro-fp',
    verifiedAt: now,
    truncated: (data.contentVerification && data.contentVerification.truncated) || false,
    wrongArticle: false,
    wrongProduction: (data.contentVerification && data.contentVerification.wrongProduction) || false,
    isFilmTv: (data.contentVerification && data.contentVerification.isFilmTv) || false,
    articleType: 'review',
    issues: (data.contentVerification && data.contentVerification.issues) || [],
    reasoning: `Essay/bio-style opening tripped the '${match.nonReviewType}' classifier; fullText names the show`
      + (match.venueChecked ? ' and venue' : '')
      + ` and closes with an explicit recommendation in the final ${Math.round(0.35 * 100)}% of the text. `
      + 'Auto-cleared by audit-exclusion-flags.js (BRO-57 essay-intro FP sweep).',
  });
  return data;
}

function main() {
  const argv = process.argv.slice(2);
  if (hasHelpFlag(argv)) { console.log(USAGE); return; }
  const args = parseArgs(argv);

  const hits = [];
  let scanned = 0;

  for (const showId of listShowDirs(args.show)) {
    const showDir = path.join(REVIEW_TEXTS_DIR, showId);
    let files;
    try { files = fs.readdirSync(showDir).filter((f) => f.endsWith('.json') && f !== 'failed-fetches.json'); }
    catch { continue; }

    for (const file of files) {
      const filePath = path.join(showDir, file);
      let data;
      try { data = JSON.parse(fs.readFileSync(filePath, 'utf8')); }
      catch { continue; }
      scanned++;

      const match = detectEssayIntroFalsePositive(data, showId);
      if (!match) continue;

      hits.push({
        showId,
        file,
        outlet: data.outlet || data.outletId || null,
        critic: data.criticName || null,
        nonReviewType: match.nonReviewType,
        nonReviewClassifiedBy: data.nonReviewClassifiedBy || null,
        classifiedAt: data.classifiedAt || null,
        wordCount: match.wordCount,
        venueChecked: match.venueChecked,
        score: (data.llmScore && data.llmScore.score) || data.assignedScore || null,
      });

      if (args.apply) {
        try {
          applyClear(data, match);
          // force:true — an intentional operator-equivalent override, same as
          // audit-wrongshow-autoclear-conflicts.js's clears. Routes through the
          // shared write guard (required by test.yml's safeWriteReview lint)
          // rather than a raw fs.writeFileSync.
          safeWriteReview(filePath, data, { force: true });
          const after = JSON.parse(fs.readFileSync(filePath, 'utf8'));
          if (after.isNonReview !== false || after.nonReviewManualClear !== true) {
            console.error(`  ERROR: write did not stick for ${showId}/${file} (isNonReview=${after.isNonReview}, nonReviewManualClear=${after.nonReviewManualClear})`);
          }
        } catch (e) {
          console.error(`  ERROR applying clear to ${showId}/${file}: ${e.message}`);
        }
      }
    }
  }

  if (args.json) {
    console.log(JSON.stringify({ scanned, count: hits.length, applied: args.apply, hits }, null, 2));
  } else {
    console.log(`Essay-intro isNonReview FP sweep: ${scanned} review file(s) scanned, ${hits.length} match(es) (${args.apply ? 'APPLIED' : 'report-only, pass --apply to clear'}).`);
    for (const h of hits) {
      console.log(`  ${h.showId}/${h.file}  type=${h.nonReviewType} words=${h.wordCount} score=${h.score} classifiedBy=${h.nonReviewClassifiedBy || 'unknown'}`);
    }
  }

  if (!fs.existsSync(AUDIT_DIR)) fs.mkdirSync(AUDIT_DIR, { recursive: true });
  fs.writeFileSync(LOG_PATH, JSON.stringify({
    _meta: { generatedAt: new Date().toISOString(), scanned, count: hits.length, applied: args.apply },
    hits,
  }, null, 2) + '\n');
  if (!args.json) console.log(`\nAudit log: ${LOG_PATH}`);

  try {
    assertCorpusScanned(scanned, { gate: args.gate });
  } catch (e) {
    if (!(e instanceof CorpusNotScannedError)) throw e;
    console.error(`\nFAIL: ${e.message}`);
    process.exit(1);
  }

  if (args.gate && hits.length > args.max) {
    console.error(`\nFAIL: ${hits.length} hit(s) > max ${args.max}.`);
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = { applyClear, main, REVIEW_TEXTS_DIR };
