#!/usr/bin/env node

/**
 * Standing CI sweep for the #483 corpus signature: flag=true (wrongProduction
 * /wrongShow) + `_urlChangedClear` breadcrumb present + empty fullText + no
 * manual clear. 112 corpus files matched this exact shape on 2026-07-26 —
 * a stale maybeUpgradeUrl escape (fixed in scripts/lib/review-normalization.js
 * maybeUpgradeUrl + scripts/lib/url-change-invariant.js's force option) left
 * the OLD article's exclusion flag attached to a file that had already
 * started a URL correction and was waiting on refetch, permanently blocking
 * rebuild of the corrected URL.
 *
 * Detector: scripts/lib/stale-flag-after-url-correction.js
 * (detectStaleFlagAfterUrlCorrection) — chokepoint-agnostic, so it also
 * catches any FUTURE write path that reintroduces the same escape.
 *
 * Usage:
 *   node scripts/audit-stale-flag-after-url-correction.js                    # report
 *   node scripts/audit-stale-flag-after-url-correction.js --gate             # exit 1 on any match
 *   node scripts/audit-stale-flag-after-url-correction.js --fix              # remediate backlog matches
 *   node scripts/audit-stale-flag-after-url-correction.js --json
 *   node scripts/audit-stale-flag-after-url-correction.js --review-texts-dir=/path  # override corpus location
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { listShowDirs } = require('./lib/list-show-dirs.js');
const { detectStaleFlagAfterUrlCorrection, remediateStaleFlagAfterUrlCorrection } = require('./lib/stale-flag-after-url-correction.js');
const { assertCorpusScanned, CorpusNotScannedError } = require('./lib/corpus-scan-guard.js');

const USAGE = `audit-stale-flag-after-url-correction.js — stale flag + URL-correction breadcrumb sweep (#483)

Usage:
  node scripts/audit-stale-flag-after-url-correction.js [--gate] [--fix] [--json] [--review-texts-dir=PATH]

  --gate               exit 1 when the match count exceeds --max (CI gate mode)
  --max=N              gate ceiling (default 0). CI uses headroom so one new
                        file from an unguarded producer cannot block every
                        session's merge — same ratchet as
                        audit-self-contradictory-clears.js
  --fix                remediate matches in place (clears the stale flag + contentVerification,
                        extends the existing _urlChangedClear breadcrumb, sets needsRefetch)
  --json               machine-readable output
  --review-texts-dir=  override the corpus path (default data/review-texts)
`;

const ROOT = path.resolve(__dirname, '..');

function main() {
  const argv = process.argv.slice(2);
  if (hasHelpFlag(argv)) { console.log(USAGE); return; }
  const gate = argv.includes('--gate');
  const json = argv.includes('--json');
  const fix = argv.includes('--fix');
  // --max=N ratchet, matching audit-self-contradictory-clears.js:62-67. That
  // sibling gate learned this the hard way: a hard-equality baseline "flaps
  // main red for non-code reasons" because the rebuild bots mutate this corpus
  // every ~30 min (memory/feedback_test_yml_data_gates_flap_and_shortcircuit.md).
  // This gate shipped with hard-zero semantics instead, so a SINGLE new file
  // from any of the 19 still-unguarded producers blocks every parallel
  // session's merge — which is how one data record came to gate all code
  // delivery for two days. Default stays 0 so local `--gate` is unchanged;
  // CI passes a ceiling with headroom.
  //
  // DO NOT ratchet this to 0 by draining with --fix until the conflict below
  // is resolved. As of 2026-08-14 this gate and validate-data.js CHECK 0
  // [wrong-production-by-date] disagree about ~121 records, and the
  // date guard is the one that is RIGHT: on every sampled record the
  // `_urlChangedClear.to` equals the CURRENT url and `publishDate` was
  // re-derived FOR that url (dateSource `manual-live-page-…`, `url-compact`
  // parsed from the new slug), so the flag is a correct verdict about the
  // corrected URL, not a leftover from the old one. `publishDate` appearing in
  // `_urlChangedClear.cleared` only records that it was cleared at
  // URL-change time; it was repopulated afterwards. Draining these therefore
  // un-suppresses genuinely wrong-production reviews — measured: 8 entered
  // reviews.json, including a 2019 Trafalgar Studios Equus review scoring 97
  // on equus-west-end-2026 and a 2017 Playhouse Glengarry on the 2026 revival.
  // These records have no fullText but DO carry aggregatorStars, so "no body"
  // does not mean "not scoreable". The real fix is to narrow the DETECTOR so it
  // stops matching records whose publishDate independently corroborates the
  // flag — not to weaken the date guard.
  const maxArg = argv.find((a) => a.startsWith('--max='));
  // Reject a non-integer instead of letting parseInt hand back NaN. `--max=abc`
  // and `--max=` both yielded NaN, and `hits.length > NaN` is ALWAYS false — so
  // a typo in the workflow silently disabled the gate entirely while still
  // printing a pass. Fail loud (exit 2, distinct from the exit-1 gate failure)
  // so a malformed ceiling can never be mistaken for a clean corpus.
  let max = 0;
  if (maxArg) {
    const raw = maxArg.slice('--max='.length);
    if (!/^\d+$/.test(raw)) {
      console.error(`FAIL: --max must be a non-negative integer, got "${raw}".`);
      process.exit(2);
    }
    max = Number(raw);
  }
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
      if (fix) {
        remediateStaleFlagAfterUrlCorrection(data);
        // Deliberately a plain write, not safeWriteReview(): the disk record
        // IS the stale bug state this remediation exists to fix, and
        // isIntentionalClear()'s "same-era committed value is never
        // suppressed" rule (review-write-guard.js _urlChangeCleared) treats
        // that stale committed value as authoritative and restores it —
        // verified empirically, routing through the guard silently undid the
        // clear. Listed in .review-write-guard-exempt.txt so the
        // write-routing lint records this as a reviewed exemption rather
        // than a pass-by-accident (the lint's import check is textual and
        // "safeWriteReview" appears in this very comment).
        fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`);
      }
    }
  }

  if (json) {
    console.log(JSON.stringify({ scanned: showDirs.length, count: hits.length, fixed: fix, hits }, null, 2));
  } else {
    console.log(`Stale-flag-after-URL-correction sweep: ${showDirs.length} shows scanned, ${hits.length} match(es)${fix ? ' (remediated)' : ''}.`);
    for (const h of hits) {
      console.log(`  [${h.flags.join('+')}] ${h.showId}/${h.file}`);
    }
  }

  if (gate && !fix && hits.length > max) {
    console.error(`\nFAIL: ${hits.length} file(s) match the #483 stale-flag-after-URL-correction signature (> max ${max}).`);
    console.error('Drain with --fix, then check scripts/audit-stale-flag-producers.js for which code re-created it.');
    process.exit(1);
  }
}

main();
