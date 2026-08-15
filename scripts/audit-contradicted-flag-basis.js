#!/usr/bin/env node

/**
 * Standing CI sweep for GENUINELY STALE exclusion flags: a wrongProduction /
 * wrongShow flag whose only stated basis is a date-guard claim citing a date
 * the record no longer has, where the record's CURRENT publishDate sits inside
 * the show's own run window. The flag's premise is contradicted by the record.
 *
 * This gate REPLACES the #483 sweep (audit-stale-flag-after-url-correction.js),
 * which was demoted to report-only on 2026-08-14 and is no longer wired into
 * CI. That sweep keyed on "`_urlChangedClear` breadcrumb + no fullText" and was
 * measured at 0/120 precision AND 0/9 recall against the real stale class — the
 * two populations do not intersect. Full derivation and the hand-verification
 * of all 9 current matches: scripts/lib/contradicted-flag-basis.js docblock.
 *
 * There is deliberately NO --fix. Clearing an exclusion flag re-admits the
 * review into live Critic Scores, so every clear has to be hand-adjudicated and
 * written with the full PROTECTED_FIELDS set
 * (memory/feedback_manual_review_protection_fields.md). The #483 script's bulk
 * `--fix` drain did exactly this un-adjudicated and was self-reverted the same
 * day after it un-suppressed 8 wrong-production reviews.
 *
 * Usage:
 *   node scripts/audit-contradicted-flag-basis.js                     # report
 *   node scripts/audit-contradicted-flag-basis.js --gate --max=12     # CI gate
 *   node scripts/audit-contradicted-flag-basis.js --json
 *   node scripts/audit-contradicted-flag-basis.js --review-texts-dir=/path
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { listShowDirs } = require('./lib/list-show-dirs.js');
const { detectContradictedFlagBasis } = require('./lib/contradicted-flag-basis.js');
const { assertCorpusScanned, CorpusNotScannedError } = require('./lib/corpus-scan-guard.js');
const { parseMaxArgOrExit } = require('./lib/parse-max-arg.js');

const USAGE = `audit-contradicted-flag-basis.js — stale exclusion-flag sweep (replaces the #483 sweep)

Finds review-texts files whose wrongProduction/wrongShow flag rests ONLY on a
date-guard claim citing a date the record no longer carries, while the record's
current publishDate falls inside the show's own run window.

Usage:
  node scripts/audit-contradicted-flag-basis.js [--gate] [--max=N] [--json] [--review-texts-dir=PATH] [--shows-path=PATH]

  --gate                exit 1 when the match count exceeds --max
  --max=N               gate ceiling (default 0). CI passes a ceiling with
                        headroom: the rebuild bots rewrite this corpus every
                        ~30 min, so a hard-equality baseline flaps main red for
                        non-code reasons
                        (memory/feedback_test_yml_push_path_allowlist.md).
  --json                machine-readable output
  --review-texts-dir=   override the corpus path (default data/review-texts)
  --shows-path=         override shows.json path (default data/shows.json)
`;

const ROOT = path.resolve(__dirname, '..');

function main() {
  const argv = process.argv.slice(2);
  if (hasHelpFlag(argv)) { console.log(USAGE); return; }
  const gate = argv.includes('--gate');
  const json = argv.includes('--json');
  const max = parseMaxArgOrExit(argv, { scriptName: 'audit-contradicted-flag-basis' });
  const dirArg = argv.find((a) => a.startsWith('--review-texts-dir='));
  const REVIEW_TEXTS_DIR = dirArg ? dirArg.split('=')[1] : path.join(ROOT, 'data', 'review-texts');
  const showsArg = argv.find((a) => a.startsWith('--shows-path='));
  const SHOWS_PATH = showsArg ? showsArg.split('=')[1] : path.join(ROOT, 'data', 'shows.json');

  const showsById = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
    const shows = Array.isArray(parsed) ? parsed : parsed.shows;
    for (const s of shows || []) if (s && s.id) showsById[s.id] = s;
  } catch {
    // Left empty on purpose: with no show records every detection returns
    // false (the detector requires a show), so the sweep reports 0 rather
    // than throwing. assertCorpusScanned below is what catches "the data
    // never got checked out".
  }

  let showDirs = [];
  try {
    showDirs = listShowDirs(REVIEW_TEXTS_DIR, { silent: true });
  } catch {
    showDirs = [];
  }
  try {
    assertCorpusScanned(showDirs.length, { gate });
  } catch (e) {
    if (!(e instanceof CorpusNotScannedError)) throw e;
    console.error(`\nFAIL: ${e.message}`);
    process.exit(1);
  }

  const hits = [];
  for (const showId of showDirs) {
    const show = showsById[showId];
    if (!show) continue;
    const showDir = path.join(REVIEW_TEXTS_DIR, showId);
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
      const verdict = detectContradictedFlagBasis({ review: data, show });
      if (!verdict.contradicted) continue;
      hits.push({
        showId,
        file,
        flags: verdict.flags,
        citedDates: verdict.citedDates,
        currentDate: verdict.currentDate,
        window: [verdict.windowStart, verdict.windowEnd],
        url: data.url || null,
      });
    }
  }

  if (json) {
    console.log(JSON.stringify({ scanned: showDirs.length, count: hits.length, hits }, null, 2));
  } else {
    console.log(`Contradicted-flag-basis sweep: ${showDirs.length} shows scanned, ${hits.length} match(es).`);
    for (const h of hits) {
      console.log(`  [${h.flags.join('+')}] ${h.showId}/${h.file}`);
      console.log(`      basis cites ${h.citedDates.join(', ')} but record is dated ${h.currentDate}, inside run ${h.window[0]}..${h.window[1] || 'open'}`);
    }
  }

  if (gate && hits.length > max) {
    console.error(`\nFAIL: ${hits.length} review file(s) carry an exclusion flag whose date basis the record itself contradicts (> max ${max}).`);
    console.error('Each match is a real review suppressed from live Critic Scores on a date that is no longer on the record.');
    console.error('Adjudicate by hand and clear with the full PROTECTED_FIELDS set — there is no bulk drain, by design.');
    process.exit(1);
  }
}

main();
