#!/usr/bin/env node
/**
 * Hand-adjudicated clear for the 13 records surfaced by
 * scripts/audit-contradicted-flag-basis.js (card #1589). Each carries a
 * wrongProduction:true whose ONLY stated basis is a date-guard claim citing a
 * date the record no longer has, while the record's current publishDate sits
 * inside the show's own run window. All 13 were hand-verified 2026-08-14/16 —
 * each is a real review of the show it is filed under.
 *
 * Deliberately NOT a predicate-driven sweep: the target list below is a fixed,
 * explicit allowlist, not detectContradictedFlagBasis() run over the whole
 * corpus with an unattended --fix. Every entry was named on the card BEFORE
 * this script existed. See the #483 `--fix` drain self-revert
 * (memory/feedback_local_rebuild_stale_clone_hazard.md-adjacent incident,
 * documented in scripts/audit-contradicted-flag-basis.js's docblock) for why
 * bulk auto-clears on this population are refused by design.
 *
 * Each entry is re-verified against detectContradictedFlagBasis() before
 * clearing (skipped + reported if the flag is no longer contradicted, e.g.
 * already fixed by a prior run) — the script never clears a file whose flag
 * basis it cannot itself confirm is contradicted.
 *
 * TARGETS below is card #1589-specific and intentionally frozen — do not add
 * new entries to it for a future batch. Copy this file under a new name
 * (following the clear-stale-wrong-production-flags.js / clear-stale-*
 * convention) with the new card's own explicit allowlist instead.
 *
 * Usage:
 *   node scripts/clear-contradicted-flag-basis.js              # dry-run
 *   node scripts/clear-contradicted-flag-basis.js --apply      # write to disk
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { detectContradictedFlagBasis } = require('./lib/contradicted-flag-basis');
const { clearWrongProductionFlags } = require('./lib/wrong-production-clear');

const APPLY = process.argv.includes('--apply');
const REVIEW_TEXTS_DIR = path.join(__dirname, '..', 'data', 'review-texts');
const SHOWS_PATH = path.join(__dirname, '..', 'data', 'shows.json');

const TARGETS = [
  'birthday-candles-2022/nytg--diep-tran.json',
  'caroline-or-change-2021/nytg--naveen-kumar.json',
  'carousel-2018/vulture--sara-holdren.json',
  'cats-2016/huffpost--david-finkle.json',
  'children-of-a-lesser-god-2018/vulture--boris-kachka.json',
  'clydes-2021/nytg--joe-dziemianowicz.json',
  'dana-h-2021/nytg--juan-michael-porter-ii.json',
  'home-2024/nytimes--jesse-green.json',
  'miss-saigon-2017/deadline--jeremy-gerard.json',
  'sweat-2017/deadline--jeremy-gerard.json',
  'the-road-to-mecca-2012/variety--marilyn-stasio.json',
  "the-sign-in-sidney-brusteins-window-2023/variety--naveen-kumar.json",
  "the-sign-in-sidney-brusteins-window-2023/wsj--charles-isherwood.json",
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
  const verdict = detectContradictedFlagBasis({ review: data, show });
  if (!verdict.contradicted) {
    console.log(`SKIP ${rel} — no longer contradicted (already fixed or basis changed)`);
    skipped++;
    continue;
  }

  console.log(`CLEAR ${rel} — cited ${verdict.citedDates.join(',')}, record dated ${verdict.currentDate}, run window ${verdict.windowStart}..${verdict.windowEnd || 'open'}`);
  cleared++;

  if (!APPLY) continue;

  const orig = fs.readFileSync(filePath, 'utf8');
  const hadTrailingNewline = orig.endsWith('\n');
  const clearNote = `[2026-08-17 cleared contradicted wrongProduction — flag basis cited ${verdict.citedDates.join(',')} but record is dated ${verdict.currentDate}, inside run ${verdict.windowStart}..${verdict.windowEnd || 'open'} — card #1589]`;
  clearWrongProductionFlags(data, { source: 'clear-contradicted-flag-basis.js', reason: clearNote });
  data.wrongProductionManualClear = true;
  data.wrongProductionClearedNote = clearNote;
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + (hadTrailingNewline ? '\n' : ''));
}

console.log('');
console.log(`Targets: ${TARGETS.length}, cleared: ${cleared}, skipped: ${skipped}`);
if (!APPLY) console.log('DRY RUN — pass --apply to write changes.');
