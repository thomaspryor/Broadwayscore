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
 * authoritative over the flags. The original acceptance bar (drive the count
 * under 4, then flip --gate on) never landed — the count sat at ~24-29 for
 * weeks. Task #1673 replaces that stalled manual-drain plan with
 * baseline-diff (mirrors #1665/#1666/#1668, which all removed their legacy
 * gate flag on cutover — none of them carries one today): the pre-existing
 * backlog is frozen in data/audit/cv-flag-contradiction-baseline.json and
 * never fails CI — only a NEW (showId, file) pair not in that baseline fails
 * the build under --strict. Identity is (showId, file), not the detected
 * `flag` or `cvReasoning` — see scripts/lib/cv-flag-contradiction-baseline.js
 * for why.
 *
 * UNLIKE the 3 precedents (which scan the full corpus every run), this
 * script windows to shows opened in the last --window days by design (the
 * signal is a pipeline-health check for recently-opened shows, not a
 * standing corpus property) — so a baselined hit whose show ages past the
 * window simply stops appearing in `hits`, on both --strict and
 * --update-baseline. That's harmless for --strict (an aged-out hit can never
 * cause a false failure), but --update-baseline's full-overwrite would
 * silently drop it from the baseline with no record of why — indistinguishable
 * from "someone fixed it" — so --update-baseline logs every dropped/added key
 * explicitly (second-opinion review, task #1673) instead of writing a silent
 * diff.
 *
 * Usage:
 *   node scripts/audit-cv-flag-contradiction.js                   # report only
 *   node scripts/audit-cv-flag-contradiction.js --strict           # exit 1 on NEW (non-baselined) hits
 *   node scripts/audit-cv-flag-contradiction.js --update-baseline  # regenerate baseline from current scan
 *   node scripts/audit-cv-flag-contradiction.js --window=30        # days (default 30)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { detectCvFlagContradiction } = require('./lib/flag-contradiction');
const { assertCorpusScanned, CorpusNotScannedError } = require('./lib/corpus-scan-guard');
const { baselineKeySet, computeNewViolators } = require('./lib/cv-flag-contradiction-baseline');

const USAGE = `audit-cv-flag-contradiction.js — flag-vs-CV contradiction detector (#651)

Usage:
  node scripts/audit-cv-flag-contradiction.js [--strict] [--update-baseline] [--window=30]

  --strict           exit 1 when a NEW (non-baselined) contradiction is found (task #1673)
  --update-baseline  regenerate data/audit/cv-flag-contradiction-baseline.json from the current scan
  --window=N         only consider shows opened in the last N days (default 30)
`;

const ROOT = path.resolve(__dirname, '..');
const SHOWS_FILE = path.join(ROOT, 'data', 'shows.json');
const REVIEW_TEXTS_DIR = path.join(ROOT, 'data', 'review-texts');
const BASELINE_PATH = path.join(ROOT, 'data', 'audit', 'cv-flag-contradiction-baseline.json');

function parseArgs(argv) {
  const args = { window: 30, strict: false, updateBaseline: false };
  for (const a of argv) {
    if (a === '--strict') args.strict = true;
    else if (a === '--update-baseline') args.updateBaseline = true;
    else if (a.startsWith('--window=')) args.window = parseInt(a.split('=')[1], 10);
  }
  return args;
}

function loadBaseline() {
  try {
    return JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
  } catch {
    return { hits: [] };
  }
}

function main() {
  if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); return; }
  const args = parseArgs(process.argv.slice(2));

  // Corpus presence, checked independent of the date window below (#1063
  // ship-check finding): gating on the window-filtered per-file `scanned`
  // count conflated "corpus missing" with "0 shows opened in this window" —
  // a real, if rare, false-FAIL on a quiet window. A raw top-level listing
  // of REVIEW_TEXTS_DIR answers "is the checkout here at all" without
  // depending on which shows happen to fall inside --window.
  let corpusEntries = 0;
  try { corpusEntries = fs.readdirSync(REVIEW_TEXTS_DIR).length; } catch { corpusEntries = 0; }
  try {
    assertCorpusScanned(corpusEntries, { gate: args.strict || args.updateBaseline });
  } catch (e) {
    if (!(e instanceof CorpusNotScannedError)) throw e;
    console.error(`\nFAIL: ${e.message}`);
    process.exit(1);
  }

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
    // No cvReasoning in stdout: this repo is public and CV reasoning often
    // embeds verbatim quotes from copyrighted review text (CLAUDE.md §3) —
    // this script runs in CI (public Actions logs), not just locally.
    console.log(`  [${h.flag}] ${h.showId}/${h.file} (${h.wordCount}w)`);
  }

  // --update-baseline: regenerate the baseline from the current scan and exit
  // (mirrors audit-critic-outlets.js / audit-outlet-registry.js). Logs every
  // added/dropped (showId, file) key explicitly — a --window-scoped rescan
  // can drop a baselined key simply because its show aged out of the window,
  // which looks identical to "someone fixed it" unless it's called out
  // (second-opinion review, task #1673).
  if (args.updateBaseline) {
    const oldHits = loadBaseline().hits || [];
    const oldSet = baselineKeySet(oldHits);
    const newEntries = hits
      .map(h => ({ showId: h.showId, file: h.file, flag: h.flag }))
      .sort((a, b) => (a.showId + a.file).localeCompare(b.showId + b.file));
    const newSet = baselineKeySet(newEntries);
    const added = computeNewViolators(newEntries, oldSet);
    const dropped = oldHits.filter(h => !newSet.has(`${h.showId}::${h.file}`));

    const baseline = { generatedAt: new Date().toISOString().slice(0, 10), hits: newEntries };
    fs.mkdirSync(path.dirname(BASELINE_PATH), { recursive: true });
    fs.writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2) + '\n');
    console.log(`\n✅ Baseline updated: ${baseline.hits.length} known contradiction(s) (${BASELINE_PATH})`);
    if (added.length) {
      console.log(`  +${added.length} added: ${added.map(a => `${a.showId}/${a.file}`).join(', ')}`);
    }
    if (dropped.length) {
      console.log(`  -${dropped.length} dropped (fixed, or aged out of --window=${args.window}d): ${dropped.map(d => `${d.showId}/${d.file}`).join(', ')}`);
    }
    process.exit(0);
  }

  const baselineSet = baselineKeySet(loadBaseline().hits);
  const newViolators = computeNewViolators(hits, baselineSet);

  if (hits.length > 0) {
    console.log(`\n(${hits.length - newViolators.length} baselined, ${newViolators.length} new)`);
  }

  if (args.strict) {
    if (newViolators.length > 0) {
      // No cvReasoning here either — same public-CI-log constraint as above.
      console.log(`\n⚠️  NEW flag-vs-CV contradiction(s), not in the baseline (${BASELINE_PATH}):`);
      for (const v of newViolators) {
        console.log(`  [${v.flag}] ${v.showId}/${v.file}`);
      }
      console.log(`\nInvestigate, or if this is deliberate progress, refresh the baseline:`);
      console.log(`  node scripts/audit-cv-flag-contradiction.js --update-baseline`);
      process.exit(1);
    }
    process.exit(0);
  }
}

main();
