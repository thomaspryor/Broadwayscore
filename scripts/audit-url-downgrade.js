#!/usr/bin/env node

/**
 * Historical URL-swap-regression sweep (#1416).
 *
 * scripts/lib/url-downgrade-guard.js now refuses maybeUpgradeUrl swaps whose
 * candidate URL is dated outside the show's current-run window going forward.
 * This audit finds the DAMAGE ALREADY ON DISK from before that guard existed:
 * files whose CURRENT url is itself the product of a URL swap (a
 * `_urlChangedClear` breadcrumb or the older `urlCorrectedFrom` stamp) and is
 * dated outside the show's window — the exact class verified 8/8 on the
 * corpus (Equus, Romeo and Juliet, Cats: The Jellicle Ball, NYSR, Mexodus:
 * all real-current-url -> prior-production-url swaps).
 *
 * Two severities:
 *   - LIVE: no wrongProduction/wrongShow flag on the file, so prior-production
 *     content can score under the current show's page (e.g.
 *     orlando-off-broadway-2026/guardian--unknown.json, which is scoreable
 *     via aggregatorStars with no fullText needed). This is the actual
 *     live-corruption exposure and is what --gate fails on.
 *   - protected: wrongProduction or wrongShow is already true — the swap
 *     corrupted the url, but the file is correctly excluded from scoring.
 *     The #483 drain (audit-stale-flag-after-url-correction.js --fix) must
 *     never clear these; that misreading is exactly what card #1416 exists
 *     to stop. Reported for scope, not gated.
 *
 * Usage:
 *   node scripts/audit-url-downgrade.js                        # report
 *   node scripts/audit-url-downgrade.js --gate                  # exit 1 on any LIVE match
 *   node scripts/audit-url-downgrade.js --json
 *   node scripts/audit-url-downgrade.js --review-texts-dir=/path
 *   node scripts/audit-url-downgrade.js --shows-path=/path
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { listShowDirs } = require('./lib/list-show-dirs.js');
const { isUrlSwapRegression } = require('./lib/url-downgrade-guard.js');
const { assertCorpusScanned, CorpusNotScannedError } = require('./lib/corpus-scan-guard.js');

const USAGE = `audit-url-downgrade.js — historical URL-swap-regression sweep (#1416)

Finds review-texts files whose CURRENT url is itself the product of a
maybeUpgradeUrl-style swap and is dated outside the show's current-production
window — a wrong-production URL adopted as if it were a content upgrade.

Usage:
  node scripts/audit-url-downgrade.js [--gate] [--json] [--review-texts-dir=PATH] [--shows-path=PATH]

  --gate                exit 1 when any LIVE (unprotected) match is found
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
  const dirArg = argv.find((a) => a.startsWith('--review-texts-dir='));
  const REVIEW_TEXTS_DIR = dirArg ? dirArg.split('=')[1] : path.join(ROOT, 'data', 'review-texts');
  const showsArg = argv.find((a) => a.startsWith('--shows-path='));
  const SHOWS_PATH = showsArg ? showsArg.split('=')[1] : path.join(ROOT, 'data', 'shows.json');

  let showsById = {};
  try {
    const shows = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8')).shows;
    for (const s of shows) if (s.id) showsById[s.id] = s;
  } catch {
    showsById = {};
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
      const filePath = path.join(showDir, file);
      let data;
      try {
        data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      } catch {
        continue;
      }
      // Scope to records that carry a URL-swap breadcrumb — a plain old
      // out-of-window review with no swap history is flag-wrong-production-
      // by-date.js's job, not this audit's. Two producers, two breadcrumb
      // shapes: maybeUpgradeUrl stamps _urlChangedClear/urlCorrectedFrom;
      // mergeReviews' own url-swap branch (review-normalization.js ~L735)
      // stamps urlUpdatedFrom instead — ship-check adversarial review
      // (2026-08-14) found this audit was blind to that second producer.
      const swapped = !!(data._urlChangedClear && data._urlChangedClear.to)
        || !!data.urlCorrectedFrom
        || !!data.urlUpdatedFrom;
      if (!swapped) continue;

      const verdict = isUrlSwapRegression({ newUrl: data.url, show, outletId: data.outletId });
      if (!verdict.regression) continue;

      hits.push({
        showId,
        file,
        url: data.url,
        urlDate: verdict.urlDate,
        issue: verdict.issue,
        diffDays: verdict.diffDays,
        wrongProduction: !!data.wrongProduction,
        wrongShow: !!data.wrongShow,
        protected: data.wrongProduction === true || data.wrongShow === true,
      });
    }
  }

  const live = hits.filter((h) => !h.protected);
  const protectedHits = hits.filter((h) => h.protected);

  if (json) {
    console.log(JSON.stringify({ scanned: showDirs.length, count: hits.length, live: live.length, protected: protectedHits.length, hits }, null, 2));
  } else {
    console.log(`URL-downgrade sweep (#1416): ${showDirs.length} shows scanned, ${hits.length} regressed url(s) — ${live.length} LIVE (unprotected), ${protectedHits.length} protected.`);
    for (const h of hits) {
      console.log(`  [${h.protected ? 'protected' : 'LIVE'}] ${h.showId}/${h.file} — url dated ${h.urlDate} (${h.issue}, ${h.diffDays}d)`);
    }
  }

  if (gate && live.length > 0) {
    console.error(`\nFAIL: ${live.length} file(s) carry a regressed (wrong-production) url with NO wrongProduction/wrongShow flag — live scoring exposure.`);
    console.error('Fix by hand (verify the correct current-run url and restore it, or flag wrongProduction).');
    process.exit(1);
  }
}

main();
