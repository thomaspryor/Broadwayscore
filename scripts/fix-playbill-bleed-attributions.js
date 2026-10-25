#!/usr/bin/env node
/**
 * fix-playbill-bleed-attributions.js — triage groups surfaced by
 * `audit-cross-outlet-attributions.js --playbill-bleed` (task #1008, card
 * 3b2637c5-416f-81da, 2026-08-04).
 *
 * Generalizes the playbill-verdict byline-bleed fix from task #991
 * (fix-cross-outlet-attributions-fulltext.js's Matt Windman batch): that fix
 * only found the bug via the base scanner's registry-mismatch gate, which a
 * repeat instance of the exact same scraper bug slips past when the critic's
 * registry defaultCritic happens to resolve correctly at one outlet in the
 * bleed group (making that one file look legitimate) and the group's total
 * appearance count (a legit-freelancer signal elsewhere in this corpus)
 * hides the rest. --playbill-bleed groups by (showId, criticName) instead
 * and flags any group spanning 3+ outlets regardless of registry status.
 *
 * Confirmed instance: the-price-2017/Chris Jones across 7 outlets — content,
 * URL, and assignedScore per file are all genuinely distinct (WebFetch/
 * WebSearch corroborated real, separate 2017 Broadway reviews at each), only
 * the byline was wrong. chicagotribune is Chris Jones's own real outlet
 * (Chicago Tribune's chief theater critic — already established in task
 * #991's manifest) and is left untouched (action: verify); the other 6 carry
 * his amNY-review byline pattern bled across the roundup, same bug class as
 * task #991's Matt Windman batch. Each rename target was confirmed via
 * WebSearch against contemporaneous (2017) coverage of the specific outlet's
 * review of this production — AND, discovered when the first --apply dry-run
 * hit review-write-guard's duplicateOf-cycle warnings, independently
 * corroborated by a pre-existing sibling file at each outlet
 * (outlet--realcritic.json, sourced via show-score/bww-reviews/web-search,
 * same URL) whose duplicateOf pointer back at the chris-jones file had been
 * auto-cleared as "different critics" by the 2026-04-12 cycle-breaker —
 * i.e. a separate discovery pipeline had already surfaced the correct byline
 * for 5 of these 6 outlets and been silently ignored because the mismatch
 * looked like two distinct reviews rather than one mis-attributed one. The
 * Stage (thestage.co.uk) has the same pre-existing sibling
 * (thestage--nicole-serratore.json, identical URL) confirming Nicole
 * Serratore as the real critic, not a WebSearch guess.
 *
 * Idempotent. Dry-run by default; pass --apply to write.
 * Run from the repo root that owns the canonical data/review-texts store.
 */

const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help');

if (hasHelpFlag(process.argv)) {
  console.log(`fix-playbill-bleed-attributions.js — triage playbill-verdict byline-bleed groups (task #1008).

Usage:
  node scripts/fix-playbill-bleed-attributions.js           dry run (report only)
  node scripts/fix-playbill-bleed-attributions.js --apply   write corrections

Run from the repo root that owns the canonical data/review-texts store.`);
  process.exit(0);
}

const { safeWriteReview } = require('./lib/review-write-guard');

const APPLY = process.argv.includes('--apply');
const ROOT = process.cwd();
const REVIEW_TEXTS = path.join(ROOT, 'data', 'review-texts');

if (!fs.existsSync(REVIEW_TEXTS)) {
  console.error(`No data/review-texts under ${ROOT} — run from the main checkout.`);
  process.exit(1);
}

// action: 'verify' | 'rename' | 'flag'
const MANIFEST = [
  // --- the-price-2017 / Chris Jones playbill-verdict byline-bleed (7 files) ---
  { file: 'the-price-2017/chicagotribune--chris-jones.json', action: 'verify',
    note: 'Chris Jones is Chicago Tribune\'s real chief theater critic (already established, task #991 manifest) — this is his own genuine byline, not part of the bleed.' },
  { file: 'the-price-2017/deadline--chris-jones.json', action: 'rename', criticName: 'Jeremy Gerard',
    note: 'WebSearch confirms Deadline\'s March 16, 2017 "The Price" Broadway review byline is Jeremy Gerard, Deadline\'s theater critic, not Chris Jones.' },
  { file: 'the-price-2017/hollywood-reporter--chris-jones.json', action: 'rename', criticName: 'David Rooney',
    note: 'WebSearch confirms The Hollywood Reporter\'s March 16, 2017 "The Price" review byline is David Rooney, THR\'s chief theater critic, not Chris Jones.' },
  { file: 'the-price-2017/nbcny--chris-jones.json', action: 'rename', criticName: 'Robert Kahn',
    note: 'WebSearch confirms NBC New York\'s March 16, 2017 "The Price" review ("Danny DeVito Goes Big and Blustery in Broadway Debut") byline is Robert Kahn, not Chris Jones.' },
  { file: 'the-price-2017/nydailynews--chris-jones.json', action: 'rename', criticName: 'Joe Dziemianowicz',
    note: 'WebSearch confirms New York Daily News\'s "The Price" review byline is Joe Dziemianowicz, NYDN\'s theater critic throughout this era, not Chris Jones.' },
  { file: 'the-price-2017/nytimes--chris-jones.json', action: 'rename', criticName: 'Alexis Soloski',
    note: 'WebSearch confirms The New York Times\'s March 16, 2017 "The Price" review byline is Alexis Soloski; stored fullText\'s opening line ("Sympathetically directed and ardently acted...") matches search-result quotes attributed to her review verbatim.' },
  { file: 'the-price-2017/thestage--chris-jones.json', action: 'rename', criticName: 'Nicole Serratore',
    note: 'Pre-existing sibling file thestage--nicole-serratore.json (source: bww-reviews) carries the identical thestage.co.uk URL and criticName "Nicole Serratore" — its duplicateOf pointer back at this file was auto-cleared as "different critics" (2026-04-12 cycle-breaker) rather than recognized as evidence this file\'s byline was wrong. Not part of the amNY/Matt-Windman-style bleed pattern seen at the other 5 outlets, but the same underlying byline error.' },
];

function main() {
  const results = { verify: [], rename: [], flag: [], missing: [] };
  for (const entry of MANIFEST) {
    const filePath = path.join(REVIEW_TEXTS, entry.file);
    if (!fs.existsSync(filePath)) {
      results.missing.push(entry.file);
      continue;
    }
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

    if (entry.action === 'verify') {
      data.crossOutletVerified = true;
      data.crossOutletVerifiedNote = entry.note;
      // wrongAttribution/wrongAttributionReason are PROTECTED_FIELDS
      // (review-write-guard.js) whose clear is only honored with this
      // breadcrumb — a plain delete here is silently reverted by
      // safeWriteReview's preserve loop when a pre-existing wrongAttribution:true
      // is on disk (thestage--chris-jones.json had one from a prior sweep;
      // ship-check adversarial finding, task #1008).
      data.wrongArticleManualClear = true;
      delete data.wrongAttribution;
      delete data.wrongAttributionReason;
    } else if (entry.action === 'rename') {
      if (!data.crossOutletOriginalCritic) data.crossOutletOriginalCritic = data.criticName;
      data.criticName = entry.criticName;
      data.crossOutletVerified = true;
      data.crossOutletVerifiedNote = entry.note;
      data.wrongArticleManualClear = true;
      delete data.wrongAttribution;
      delete data.wrongAttributionReason;
    } else if (entry.action === 'flag') {
      // Same fix as fix-cross-outlet-attributions(-fulltext).js (task
      // #1006): a prior 'verify' pass may have left crossOutletVerified:true
      // on disk, which is PROTECTED_FIELDS — a plain delete is silently
      // reverted without this retraction breadcrumb (task #1008/#1023).
      if (data.crossOutletVerified === true) {
        data.clearBreadcrumbRetractedFields = Array.from(new Set([
          ...(Array.isArray(data.clearBreadcrumbRetractedFields) ? data.clearBreadcrumbRetractedFields : []),
          'crossOutletVerified',
        ]));
        data.clearBreadcrumbRetracted = 'retracted stale crossOutletVerified: contradicted live wrongAttribution (#1023)';
        data.clearBreadcrumbRetractedAt = new Date().toISOString().slice(0, 10);
      }
      data.wrongAttribution = true;
      data.wrongAttributionReason = entry.note;
      delete data.crossOutletVerified;
      delete data.crossOutletVerifiedNote;
    }

    results[entry.action].push(entry.file);
    if (APPLY) safeWriteReview(filePath, data);
  }

  console.log(`${APPLY ? 'APPLIED' : 'DRY RUN'} — ${MANIFEST.length} suspects triaged:`);
  console.log(`  verify: ${results.verify.length}`);
  console.log(`  rename: ${results.rename.length}`);
  console.log(`  flag:   ${results.flag.length}`);
  if (results.missing.length) {
    console.log(`  MISSING (not found on disk): ${results.missing.length}`);
    for (const f of results.missing) console.log(`    ${f}`);
  }
}

main();
