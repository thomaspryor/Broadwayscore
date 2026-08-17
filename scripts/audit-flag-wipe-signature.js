#!/usr/bin/env node

/**
 * Retroactive corpus scan for #1695's maybeUpgradeUrl flag-wipe signature (#1712).
 *
 * Before the #1695 fix (commit 16c834c9bf4, merged 2026-08-16),
 * maybeUpgradeUrl() (scripts/lib/review-normalization.js) had no guard against
 * "upgrading" the url of a file whose contentTier:'invalid' was flag-driven
 * (wrongProduction/wrongShow/duplicateOf on a T5-classified file always reads
 * as badContent, since invalid-tier files never carry usable fullText). Any
 * re-scrape that found a different url for such a file would silently clear
 * wrongProduction/wrongShow/duplicateOf as old-URL-derived state
 * (applyUrlChangeInvariant, force:true) and re-admit a deliberately-excluded
 * review into reviews.json scoring.
 *
 * This audit finds files bearing the breadcrumb that clear left behind:
 *   - urlCorrectedReason starts with 'Replaced with ' — maybeUpgradeUrl's own
 *     exclusive stamp (review-normalization.js line ~1910: `Replaced with
 *     ${source} URL — original had bad/missing content`). urlCorrectedFrom
 *     ALONE is not enough: applyUrlChangeInvariant (url-change-invariant.js)
 *     also stamps it as a fallback from the OTHER two write chokepoints
 *     (safeWriteReview's plain merges, gather-reviews.js's wrongShow/wrongProd
 *     URL-replacement branch) — those are a DIFFERENT, legitimate correction
 *     mechanism, not the #1695 bug, and calling maybeUpgradeUrl is the only
 *     code path that sets urlCorrectedReason to this exact prefix (confirmed:
 *     grep shows only two other producers, retry-wrong-urls.js and
 *     gather-reviews.js's SERP-retry branch, both wrongUrl-only flows that use
 *     distinct literal strings and never touch wrongProduction/wrongShow/
 *     duplicateOf). An initial unscoped pass (urlCorrectedFrom alone) hit 119
 *     files, the vast majority legitimate wrongShow/wrongProd recoveries via
 *     the other two chokepoints — this scoping is what cuts that down to the
 *     actual maybeUpgradeUrl-attributable set.
 *   - _urlChangedClear.cleared lists wrongProduction, wrongShow, duplicateOf,
 *     or duplicateTextOf — the invariant's own record of which flags it wiped
 *     at that write (the direct, mechanism-level signal; urlCorrectedFrom
 *     alone only proves a maybeUpgradeUrl swap happened, not that a flag rode
 *     along with it)
 *   - wrongProduction/wrongShow/duplicateOf are ALL absent NOW (never
 *     re-flagged since)
 *   - contentTier is NOT 'invalid' now (reclassified away, consistent with
 *     the flags having been cleared)
 *   - no override breadcrumb explains a LEGITIMATE clear:
 *     wrongProductionOverride / wrongShowOverride (wrong-production-clear.js)
 *     or duplicateClearReason (url-change-invariant.js's own intentional-clear
 *     signal, also stamped on legitimate dedup-pointer clears)
 *
 * A file with all of the above is a suspect: a flag-driven invalid file whose
 * exclusion evidence disappeared via exactly the pre-fix mechanism, with no
 * paper trail explaining why that was legitimate. NOT a proof of corruption —
 * some of these clears may still turn out fine (the new url could genuinely
 * be a corrected in-window article). Each hit needs a manual spot-check
 * against the outlet's current article before re-flagging.
 *
 * Usage:
 *   node scripts/audit-flag-wipe-signature.js
 *   node scripts/audit-flag-wipe-signature.js --json
 *   node scripts/audit-flag-wipe-signature.js --review-texts-dir=/path
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { listShowDirs } = require('./lib/list-show-dirs.js');
const { assertCorpusScanned, CorpusNotScannedError } = require('./lib/corpus-scan-guard.js');
const { normalizeUrl } = require('./lib/review-normalization.js');
const { isUrlSwapRegression } = require('./lib/url-downgrade-guard.js');

const USAGE = `audit-flag-wipe-signature.js — retroactive scan for #1695's maybeUpgradeUrl flag-wipe signature (#1712)

Finds review-texts files whose wrongProduction/wrongShow/duplicateOf flags
were cleared by a pre-#1695 maybeUpgradeUrl url swap, with no override
breadcrumb explaining a legitimate clear. Each hit is tagged:
  - cosmetic: old/new url normalize to the SAME article (tracking params,
    protocol, fragment) — the flag cleared but no different content could
    have snuck in under it. Lower priority, but the flag itself may need
    re-review independently (see script header discussion).
  - dateRegression: the new url is dated outside the show's current-run
    window (#1416's own regression signature) — HIGHEST priority, since this
    is the exact "prior-production content silently re-admitted" failure mode.
  - contentSwap: everything else — a genuinely different article replaced the
    flagged one; needs a real spot-check against the outlet's live page.

Usage:
  node scripts/audit-flag-wipe-signature.js [--json] [--review-texts-dir=PATH] [--shows-path=PATH]

  --json                machine-readable output
  --review-texts-dir=   override the corpus path (default data/review-texts)
  --shows-path=         override shows.json path (default data/shows.json)
`;

const ROOT = path.resolve(__dirname, '..');
const CLEARED_FLAG_FIELDS = new Set(['wrongProduction', 'wrongShow', 'duplicateOf', 'duplicateTextOf']);

function main() {
  const argv = process.argv.slice(2);
  if (hasHelpFlag(argv)) { console.log(USAGE); return; }
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
    assertCorpusScanned(showDirs.length, {});
  } catch (e) {
    if (!(e instanceof CorpusNotScannedError)) throw e;
    console.error(`\nFAIL: ${e.message}`);
    process.exit(1);
  }

  const hits = [];
  for (const showId of showDirs) {
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

      if (!data.urlCorrectedFrom) continue;
      if (typeof data.urlCorrectedReason !== 'string' || !data.urlCorrectedReason.startsWith('Replaced with ')) continue;

      const clearedFields = (data._urlChangedClear && Array.isArray(data._urlChangedClear.cleared))
        ? data._urlChangedClear.cleared.filter((f) => CLEARED_FLAG_FIELDS.has(f))
        : [];
      if (clearedFields.length === 0) continue;

      const flagsAbsentNow = !data.wrongProduction && !data.wrongShow && !data.duplicateOf && !data.duplicateTextOf;
      if (!flagsAbsentNow) continue;

      if (data.contentTier === 'invalid') continue;

      const hasOverride = !!(data.wrongProductionOverride || data.wrongShowOverride || data.duplicateClearReason);
      if (hasOverride) continue;

      let cosmetic = false;
      try {
        cosmetic = normalizeUrl(data.urlCorrectedFrom) === normalizeUrl(data.url);
      } catch {
        cosmetic = false;
      }

      let dateRegression = false;
      let regressionReason = null;
      const show = showsById[showId];
      if (show) {
        try {
          const verdict = isUrlSwapRegression({ newUrl: data.url, show, outletId: data.outletId });
          if (verdict.regression) {
            dateRegression = true;
            regressionReason = verdict.reason;
          }
        } catch {
          // unparseable date etc — leave dateRegression false
        }
      }

      const category = dateRegression ? 'dateRegression' : (cosmetic ? 'cosmetic' : 'contentSwap');

      hits.push({
        showId,
        file,
        url: data.url,
        urlCorrectedFrom: data.urlCorrectedFrom,
        urlCorrectedReason: data.urlCorrectedReason || null,
        clearedFields,
        clearedAt: (data._urlChangedClear && data._urlChangedClear.at) || null,
        contentTier: data.contentTier || null,
        category,
        regressionReason,
      });
    }
  }

  const dateRegression = hits.filter((h) => h.category === 'dateRegression');
  const contentSwap = hits.filter((h) => h.category === 'contentSwap');
  const cosmetic = hits.filter((h) => h.category === 'cosmetic');

  if (json) {
    console.log(JSON.stringify({
      scanned: showDirs.length,
      count: hits.length,
      dateRegression: dateRegression.length,
      contentSwap: contentSwap.length,
      cosmetic: cosmetic.length,
      hits,
    }, null, 2));
  } else {
    console.log(`Flag-wipe signature sweep (#1712): ${showDirs.length} shows scanned, ${hits.length} suspect file(s).`);
    console.log(`  ${dateRegression.length} dateRegression (highest priority — new url dated outside show's run window)`);
    console.log(`  ${contentSwap.length} contentSwap (different article — needs a live spot-check)`);
    console.log(`  ${cosmetic.length} cosmetic (old/new url normalize to the same article)`);
    for (const group of [['dateRegression', dateRegression], ['contentSwap', contentSwap], ['cosmetic', cosmetic]]) {
      const [label, list] = group;
      if (list.length === 0) continue;
      console.log(`\n-- ${label} --`);
      for (const h of list) {
        console.log(`  ${h.showId}/${h.file} — cleared [${h.clearedFields.join(', ')}] at ${h.clearedAt || 'unknown'}; url ${h.urlCorrectedFrom} -> ${h.url}${h.regressionReason ? ` (${h.regressionReason})` : ''}`);
      }
    }
    if (hits.length > 0) {
      console.log('\nEach hit needs a manual spot-check against the outlet\'s current article before re-flagging (see script header).');
    }
  }
}

main();
