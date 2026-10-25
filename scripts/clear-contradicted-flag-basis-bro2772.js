#!/usr/bin/env node
/**
 * Hand-adjudicated clear for the single record surfaced by
 * scripts/audit-contradicted-flag-basis.js on 2026-09-04 (BRO-2772). It carries
 * a wrongProduction:true whose ONLY stated basis is a date-guard claim citing a
 * date the record no longer has, while the record's current publishDate sits
 * inside the show's own run window:
 *
 *   [wrongProduction] la-bete-2010/vulture--scott-brown.json
 *     basis cites 2018-08-19 but record is dated 2010-10-14,
 *     inside run 2010-09-23..2011-01-16
 *
 * Hand-verified 2026-09-04 — a real Scott Brown review of the 2010 Broadway
 * La Bete, on four independent signals:
 *   1. publishDate 2010-10-14T22:30:39-04:00, inside the run window.
 *   2. URL is a 2010-dated nymag path (/daily/entertainment/2010/10/...).
 *   3. source bww-roundup, from broadwayworld.com's Review-Roundup-LA-BETE-20101014
 *      — this production's own opening roundup.
 *   4. bwwExcerpt names David Hyde Pierce, Joanna Lumley and Rylance: the 2010
 *      Broadway cast.
 * The stale 2018-08-19 basis most likely came from the archive.org capture
 * (archiveOrgTimestamp 20190606065921) or a vulture.com republication. It became
 * newly contradicted when the file was URL-corrected earlier the same day
 * (urlUpdatedAt 2026-09-04T09:21:07.967Z), restoring the true 2010 publishDate.
 *
 * Why this file exists rather than an entry appended to
 * scripts/clear-contradicted-flag-basis.js: that script's TARGETS list is
 * explicitly frozen to card #1589 and its docblock says to copy it under a new
 * name with the new card's own allowlist instead. Same reason it is not a
 * predicate-driven sweep — bulk auto-clears on this population are refused by
 * design (see audit-contradicted-flag-basis.js's docblock for the #483 `--fix`
 * drain self-revert).
 *
 * Why the existing bulk sweep does not cover it:
 * `clear-stale-wrong-production-flags.js --show=la-bete-2010` reports
 * "Predicate matches: 0" — isLikelyStaleWrongProduction() wants substantial
 * fullText and this record has textLen 0 / wordCount 0 / needsRefetch true.
 * That missing text is a SEPARATE issue and is deliberately not addressed here:
 * clearing the flag does not by itself make the review scoreable.
 *
 * TARGETS below is BRO-2772-specific and intentionally frozen — do not add new
 * entries for a future batch. Copy this file under a new name with that card's
 * own explicit allowlist instead.
 *
 * Usage:
 *   node scripts/clear-contradicted-flag-basis-bro2772.js              # dry-run
 *   node scripts/clear-contradicted-flag-basis-bro2772.js --apply      # write to disk
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { detectContradictedFlagBasis } = require('./lib/contradicted-flag-basis');
const { clearWrongProductionFlags } = require('./lib/wrong-production-clear');
const { safeWriteReview } = require('./lib/review-write-guard');
const { hasHelpFlag } = require('./lib/cli-help.js');

const USAGE = `clear-contradicted-flag-basis-bro2772.js — hand-adjudicated clear for BRO-2772's single record

Usage:
  node scripts/clear-contradicted-flag-basis-bro2772.js                    # dry-run
  node scripts/clear-contradicted-flag-basis-bro2772.js --apply            # write to disk
  node scripts/clear-contradicted-flag-basis-bro2772.js --review-texts-dir=P --shows-path=P
`;

if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); process.exit(0); }

const APPLY = process.argv.includes('--apply');
// Corpus-path overrides exist because core data is gitignored and absent from a
// fresh worktree — without them this script cannot be run, and therefore cannot
// be verified, before it is merged. Flag NAMES deliberately match
// audit-contradicted-flag-basis.js (--review-texts-dir / --shows-path), the gate
// this exists to unblock and the closest relative. NOT the --dir/--shows pair
// from clear-stale-wrong-production-flags.js: its --dir is the review-texts
// directory rather than a data root, so reusing that name here would mean two
// different things by the same flag.
const argOf = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`${name}=`));
  const value = hit ? hit.slice(name.length + 1) : '';
  return value || fallback;
};
const REVIEW_TEXTS_DIR = argOf('--review-texts-dir', path.join(__dirname, '..', 'data', 'review-texts'));
const SHOWS_PATH = argOf('--shows-path', path.join(__dirname, '..', 'data', 'shows.json'));

const TARGETS = [
  'la-bete-2010/vulture--scott-brown.json',
];

const showsRaw = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
const showsArr = Array.isArray(showsRaw) ? showsRaw : (showsRaw.shows || []);
const showById = Object.create(null);
for (const s of showsArr) if (s && s.id) showById[s.id] = s;

let cleared = 0;
let skipped = 0;

for (const rel of TARGETS) {
  const [showId, file] = rel.split('/');
  const filePath = path.join(REVIEW_TEXTS_DIR, showId, file);
  const show = showById[showId];
  if (!show) {
    console.log(`SKIP ${rel} — show ${showId} not found in shows.json`);
    skipped++;
    continue;
  }
  let data;
  try {
    data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    console.log(`SKIP ${rel} — could not read/parse: ${e.message}`);
    skipped++;
    continue;
  }
  // Never clear a file whose flag basis this script cannot itself confirm is
  // contradicted — a prior run, or a later re-flag on fresh evidence, must not
  // be silently overridden.
  const verdict = detectContradictedFlagBasis({ review: data, show });
  if (!verdict.contradicted) {
    console.log(`SKIP ${rel} — no longer contradicted (already fixed or basis changed)`);
    skipped++;
    continue;
  }

  console.log(`CLEAR ${rel} — cited ${verdict.citedDates.join(',')}, record dated ${verdict.currentDate}, run window ${verdict.windowStart}..${verdict.windowEnd || 'open'}`);
  cleared++;

  if (!APPLY) continue;

  const clearNote = `[2026-09-04 cleared contradicted wrongProduction — flag basis cited ${verdict.citedDates.join(',')} but record is dated ${verdict.currentDate}, inside run ${verdict.windowStart}..${verdict.windowEnd || 'open'} — BRO-2772]`;
  clearWrongProductionFlags(data, { source: 'clear-contradicted-flag-basis-bro2772.js', reason: clearNote });
  data.wrongProductionManualClear = true;
  data.wrongProductionClearedNote = clearNote;
  safeWriteReview(filePath, data);
}

console.log('');
console.log(`Targets: ${TARGETS.length}, cleared: ${cleared}, skipped: ${skipped}`);
if (!APPLY) console.log('DRY RUN — pass --apply to write changes.');
