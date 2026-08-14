#!/usr/bin/env node

/**
 * Standing CI sweep for the #483 corpus signature: flag=true (wrongProduction
 * /wrongShow) + `_urlChangedClear` breadcrumb present + empty fullText + no
 * manual clear. 112 corpus files matched this shape on 2026-07-26, traced to a
 * maybeUpgradeUrl escape (fixed in scripts/lib/review-normalization.js
 * maybeUpgradeUrl + scripts/lib/url-change-invariant.js's force option).
 *
 * A MATCH IS NOT PROOF THE FLAG IS STALE (corrected 2026-08-14 — the previous
 * header said it was). A URL "correction" can replace a correct URL with a
 * different production's, leaving a CORRECT exclusion flag on a bodyless
 * record; 8/8 files examined in an independent review were correctly flagged.
 * Read the signature as "a writer produced this state", not "this flag is
 * wrong": because the live producer sites consult
 * shouldWithholdStaleExclusionFlag, a NEW match points at a writer that did
 * not. There is deliberately no --fix; see the detector module's docblock.
 *
 * Detector: scripts/lib/stale-flag-after-url-correction.js
 * (detectStaleFlagAfterUrlCorrection) — chokepoint-agnostic, so it also
 * catches any FUTURE write path that reintroduces the same escape.
 *
 * Usage:
 *   node scripts/audit-stale-flag-after-url-correction.js                    # report
 *   node scripts/audit-stale-flag-after-url-correction.js --gate             # exit 1 on any match
 *   node scripts/audit-stale-flag-after-url-correction.js --json
 *   node scripts/audit-stale-flag-after-url-correction.js --review-texts-dir=/path  # override corpus location
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { listShowDirs } = require('./lib/list-show-dirs.js');
const { detectStaleFlagAfterUrlCorrection } = require('./lib/stale-flag-after-url-correction.js');
const { assertCorpusScanned, CorpusNotScannedError } = require('./lib/corpus-scan-guard.js');

const USAGE = `audit-stale-flag-after-url-correction.js — stale flag + URL-correction breadcrumb sweep (#483)

Usage:
  node scripts/audit-stale-flag-after-url-correction.js [--gate] [--json] [--review-texts-dir=PATH]

  --gate               exit 1 when the match count exceeds --max (CI gate mode)
  --max=N              gate ceiling (default 0). CI uses headroom so one new
                        file from an unguarded producer cannot block every
                        session's merge — same ratchet as
                        audit-self-contradictory-clears.js
  --json               machine-readable output
  --review-texts-dir=  override the corpus path (default data/review-texts)
`;

const ROOT = path.resolve(__dirname, '..');

function main() {
  const argv = process.argv.slice(2);
  if (hasHelpFlag(argv)) { console.log(USAGE); return; }
  const gate = argv.includes('--gate');
  const json = argv.includes('--json');
  // --max=N ratchet, matching audit-self-contradictory-clears.js:62-67. That
  // sibling gate learned this the hard way: a hard-equality baseline "flaps
  // main red for non-code reasons" because the rebuild bots mutate this corpus
  // every ~30 min (memory/feedback_test_yml_data_gates_flap_and_shortcircuit.md).
  // This gate shipped with hard-zero semantics instead, so a SINGLE new file
  // from any of the 19 still-unguarded producers blocks every parallel
  // session's merge — which is how one data record came to gate all code
  // delivery for two days. Default stays 0 so local `--gate` is unchanged;
  // CI passes a ceiling with headroom.
  const maxArg = argv.find((a) => a.startsWith('--max='));
  const max = maxArg ? parseInt(maxArg.split('=')[1], 10) : 0;
  const dirArg = argv.find((a) => a.startsWith('--review-texts-dir='));
  const REVIEW_TEXTS_DIR = dirArg ? dirArg.split('=')[1] : path.join(ROOT, 'data', 'review-texts');

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
      const flags = detectStaleFlagAfterUrlCorrection(data);
      if (!flags.length) continue;
      hits.push({ showId, file, flags });
    }
  }

  if (json) {
    console.log(JSON.stringify({ scanned: showDirs.length, count: hits.length, hits }, null, 2));
  } else {
    console.log(`Stale-flag-after-URL-correction sweep: ${showDirs.length} shows scanned, ${hits.length} match(es).`);
    for (const h of hits) {
      console.log(`  [${h.flags.join('+')}] ${h.showId}/${h.file}`);
    }
  }

  // A match is NOT evidence that a flag is stale. Two independent 2026-08-14
  // adjudications agree: a stratified random sample of 20 matching files came
  // back 20/20 CORRECT / 0 stale, and a separate review of the 8 files matching
  // the narrowest candidate predicate came back 8/8 CORRECT. The detector's
  // original premise ("empty fullText => pending refetch => stale flag") is
  // contradicted by the corpus: most matches already had publishDate cleared,
  // were already refetched, or were flagged by guards that never read
  // publishDate at all — and a URL "correction" can swap a correct article for
  // a different production's, which makes the flag right rather than stale.
  //
  // The `--fix` drain that used to sit here was DELETED for that reason, not
  // merely warned about: clearing these flags re-admits wrong-production
  // reviews into live Critic Scores (17 current matches carry aggregatorStars
  // and score without fullText). Draining the backlog on 2026-08-14 did exactly
  // that and was self-reverted. Do not reintroduce it — a colocated test in
  // scripts/lib/stale-flag-after-url-correction.test.mjs now fails if any bulk
  // flag-clearing helper reappears.
  // Printed on ANY match under --gate, not just above the ceiling. The step is
  // report-only in CI, so a sub-ceiling run would otherwise say nothing at all
  // and the next reader would have no warning attached to the finding. (This
  // banner came from origin/main 405979b5a3c; keep it gated on > 0.)
  if (gate && hits.length > 0) {
    console.error('\n' + '='.repeat(72));
    console.error('WARNING: a match here is NOT evidence that a flag is stale.');
    console.error('='.repeat(72));
    console.error('Two independent hand adjudications on 2026-08-14 found 20/20 and 8/8');
    console.error('matching files CORRECTLY flagged, and 0 stale. A URL "correction" can');
    console.error('replace a correct article with a different production\'s, which makes the');
    console.error('exclusion flag right rather than stale.');
    console.error('');
    console.error('There is deliberately NO --fix on this script any more: clearing these');
    console.error('flags re-admits wrong-production reviews into live Critic Scores (17');
    console.error('matches carry aggregatorStars and score without fullText). Draining the');
    console.error('backlog on 2026-08-14 did exactly that and was self-reverted.');
    console.error('');
    console.error('The remedy for a record is a REFETCH, never a flag-clear. For attribution');
    console.error('of which code path wrote a flag, use scripts/audit-stale-flag-producers.js.');
    console.error('='.repeat(72));
  }

  if (gate && hits.length > max) {
    console.error(`\nFAIL: ${hits.length} file(s) match the #483 stale-flag-after-URL-correction signature (> max ${max}).`);
    console.error('DO NOT clear these flags to make this pass — sampling says they are usually');
    console.error('CORRECT (20/20 and 8/8 in two independent adjudications). Clearing them');
    console.error('re-admits wrong-production reviews into live Critic Scores.');
    console.error('Use scripts/audit-stale-flag-producers.js to find the writer that produced');
    console.error('the state; the remedy for the record itself is a refetch, never a flag-clear.');
    process.exit(1);
  }
}

main();
