#!/usr/bin/env node
/**
 * audit-uncollected-live-reviews.js
 *
 * Invariant: a live show must not be sitting on a review URL we discovered and
 * never fetched.
 *
 * This is the backstop for the whole coverage family. Every other monitor keys
 * off a show's opening window, so every other monitor goes quiet when a date
 * field is null — which is exactly how The Winter's Tale and An American
 * Daughter reached opening night with 11 and 9 discovered review URLs and zero
 * collected text on 2026-08-12, while NYT, Vulture, Playbill Verdict and a BWW
 * roundup all had them covered. This check reads no date field of the show.
 *
 * Usage:
 *   node scripts/audit-uncollected-live-reviews.js                # report
 *   node scripts/audit-uncollected-live-reviews.js --fail-on-strand   # CI gate
 *   node scripts/audit-uncollected-live-reviews.js --max-age-hours=6
 *   node scripts/audit-uncollected-live-reviews.js --json
 *
 * Exit codes: 0 clean, 1 strands found (only with --fail-on-strand).
 */

'use strict';

const fs = require('fs');
const path = require('path');

const { assessShow, DEFAULT_MAX_AGE_HOURS } = require('./lib/uncollected-strand');
const { listShowDirs } = require('./lib/list-show-dirs');

const args = process.argv.slice(2);
const failOnStrand = args.includes('--fail-on-strand');
const asJson = args.includes('--json');
const maxAgeHours = parseFloat(
  args.find(a => a.startsWith('--max-age-hours='))?.split('=')[1] || String(DEFAULT_MAX_AGE_HOURS)
);
const REVIEW_TEXTS_DIR = path.join('data', 'review-texts');
const OUT_PATH = path.join('data', 'audit', 'uncollected-live-reviews.json');

function loadShows() {
  const raw = JSON.parse(fs.readFileSync(path.join('data', 'shows.json'), 'utf8'));
  return raw.shows || raw;
}

function readShowFiles(showId) {
  const dir = path.join(REVIEW_TEXTS_DIR, showId);
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.json')) continue;
    try {
      out.push({ file, review: JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) });
    } catch {
      // A corrupt file is a different problem, owned by the contamination audit.
    }
  }
  return out;
}

function main() {
  const shows = loadShows();
  // listShowDirs tolerates dangling symlinks / stray entries; a show with no
  // directory at all simply has nothing discovered, which is not a strand.
  const haveDirs = new Set(listShowDirs(REVIEW_TEXTS_DIR));
  const nowMs = Date.now();

  const findings = [];
  for (const show of shows) {
    if (!haveDirs.has(show.id)) continue;
    const result = assessShow(show, readShowFiles(show.id), { nowMs, maxAgeHours });
    if (!result) continue;
    if (result.stranded.length > 0 || result.totalBlackout) findings.push(result);
  }

  findings.sort((a, b) =>
    (b.totalBlackout - a.totalBlackout) || (b.stranded.length - a.stranded.length)
  );

  const strandedFiles = findings.reduce((n, f) => n + f.stranded.length, 0);
  const blackouts = findings.filter(f => f.totalBlackout);

  const report = {
    generatedAt: new Date(nowMs).toISOString(),
    maxAgeHours,
    showsAffected: findings.length,
    strandedFiles,
    blackoutShows: blackouts.map(f => f.showId),
    findings,
  };

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`Uncollected live reviews (discovered >${maxAgeHours}h ago, never fetched)`);
    console.log(`  shows affected: ${findings.length}   stranded files: ${strandedFiles}`);
    for (const f of findings) {
      const flag = f.totalBlackout ? ' 🚨 NO CRITIC REVIEWS ON SITE' : '';
      console.log(`\n  ${f.showId} (${f.status}) — ${f.usable} usable / ${f.discovered} discovered${flag}`);
      for (const s of f.stranded.slice(0, 10)) {
        const age = s.ageHours === null ? 'undated' : `${Math.round(s.ageHours)}h`;
        console.log(`      ${String(s.outlet || s.file).padEnd(28)} ${age.padStart(8)}  ${s.url}`);
      }
      if (f.stranded.length > 10) console.log(`      … ${f.stranded.length - 10} more`);
    }
    if (!findings.length) console.log('  ✅ none');
  }

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(report, null, 2));

  if (failOnStrand && (strandedFiles > 0 || blackouts.length > 0)) {
    console.error(
      `\n❌ ${strandedFiles} discovered review URL(s) across ${findings.length} live show(s) were never fetched` +
      (blackouts.length ? `; ${blackouts.length} show(s) have NO critic reviews on the site at all` : '')
    );
    console.error('   Recover:  gh workflow run opening-night-express.yml -f show_id=<id> -f market=<market>');
    process.exit(1);
  }
}

main();
